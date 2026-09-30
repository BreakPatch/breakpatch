#!/usr/bin/env python3
"""
Breakpatch model test.

Runs the same screenshots and descriptions through one or more vision models and compares where
each one points, how fast it answers and how much memory it uses. The prompt and the reading of
the answer are the engine's own (breakpatch_engine.locator: LOCATE_PROMPT, parse_bbox, map_box),
so what this measures is what the app does.

  python model_test.py                                   # MLX (Apple Silicon), every model below
  python model_test.py --models 2b 4b                    # only some
  python model_test.py --runtime llamacpp --llama-server ~/llama/llama-server \\
      --gguf Qwen3-VL-4B-Instruct-Q4_K_M.gguf --mmproj mmproj-Qwen3-VL-4B-Instruct-F16.gguf
  python model_test.py --runtime openai --url http://127.0.0.1:8080   # a server that's already running
  python model_test.py --set 1440x900                    # the second screenshot set
  python model_test.py --scale 0.5                       # send each screenshot at half size
  python compare.py results/mlx/results.json results/llamacpp/results.json

Screenshots: screenshots/<set>/ (default 1280x800, the engine's viewport), cases in cases.csv
(cases-<set>.csv for another set). Results: <out>/results.json and <out>/index.html.

Times: one warm-up call first (not counted), then the median and the 90th percentile of the
answers, never the mean. With llama.cpp the server's own timings split each answer into prefill
(reading the image and prompt) and decode (writing the answer). Memory: MLX's peak allocation on a
Mac, the peak resident size of the llama-server process elsewhere (VmHWM on Linux,
PeakWorkingSetSize on Windows), and the GPU's memory from nvidia-smi when there is one. They are
different measures and are labelled as such.
"""
from __future__ import annotations

import argparse
import base64
import csv
import gc
import html
import io
import json
import math
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
try:
    import breakpatch_engine  # noqa: F401
except ImportError:
    sys.path.insert(0, str(REPO / "engine" / "src"))
# One source of prompts and parsing: the engine's (plan §2.4). No copies here. parse_bbox maps the
# model's 0-1000 units to pixels with map_box, as MlxLocator.locate does.
from breakpatch_engine.locator import LOCATE_PROMPT, map_box, parse_bbox  # noqa: E402,F401

RESULTS_VERSION = 2
MODELS = {
    "2b":     "OscarShaitan/Qwen3-VL-2B-Instruct-4bit",
    "4b":     "OscarShaitan/Qwen3-VL-4B-Instruct-4bit",
    "8b":     "OscarShaitan/Qwen3-VL-8B-Instruct-4bit",
    "q35-4b": "OscarShaitan/Qwen3.5-4B-MLX-4bit",
}
COLOURS = ["#E0714A", "#6CB8D6", "#8CC56B", "#E9B949", "#B48EE0", "#F2667A"]
KEY_COLOURS = {"2b": "#6CB8D6", "4b": "#E0714A", "8b": "#8CC56B", "q35-4b": "#E9B949"}
SETS = {"1280x800": (1280, 800), "1440x900": (1440, 900)}
DEFAULT_SET = "1280x800"
PATCH = 32          # Qwen3-VL: 16 px patches merged 2 x 2, so one image token per 32 x 32 px
MAX_TOKENS = 96
SEED = 7


def locate_prompt(desc: str) -> str:
    """The engine's prompt for a description, quoted as MlxLocator.locate quotes it."""
    return LOCATE_PROMPT.format(desc=desc.replace('"', "'").strip())


# ---------------------------------------------------------------- cases

def load_cases(path: Path):
    """cases.csv: file, description, the expected box in pixels (optional), hard (optional: 1,
    yes or true for look-alikes, small icons, second items and fields in dialogs)."""
    cases = []
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if not row.get("file") or row["file"].startswith("#"):
                continue
            exp = None
            if all((row.get(k) or "").strip() for k in ("x1", "y1", "x2", "y2")):
                exp = [float(row[k]) for k in ("x1", "y1", "x2", "y2")]
            hard = (row.get("hard") or "").strip().lower() in ("1", "yes", "y", "true", "hard")
            cases.append({"file": row["file"].strip(), "desc": row["description"].strip(), "expected": exp, "hard": hard})
    return cases


def hit(pred, exp):
    if not pred or not exp:
        return None
    cx, cy = (pred[0] + pred[2]) / 2, (pred[1] + pred[3]) / 2
    return exp[0] <= cx <= exp[2] and exp[1] <= cy <= exp[3]


def iou(a, b):
    if not a or not b:
        return None
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return round(inter / union, 3) if union > 0 else None


def image_tokens(w: int, h: int) -> int:
    """About how many image tokens Qwen3-VL makes of a w x h image: its resize rounds each side
    to a multiple of 32 px with Python's round(), so 1280 x 800 is 1,000 and 640 x 400 is 240."""
    return max(1, round(w / PATCH)) * max(1, round(h / PATCH))


def effective(img: Image.Image, scale: float) -> Image.Image:
    """The screenshot as sent: scaled when --scale says so. Boxes come back in 0-1000 units of
    the image, so they map onto the full-size screenshot either way."""
    if scale == 1:
        return img
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    return img.resize((w, h), Image.LANCZOS)


# ---------------------------------------------------------------- statistics

def percentile(values, q: float):
    """The q-th percentile (0-100), linear between the nearest ranks; None for no values."""
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return None
    if len(vs) == 1:
        return vs[0]
    k = (len(vs) - 1) * q / 100
    lo, hi = math.floor(k), math.ceil(k)
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def median(values):
    return percentile(values, 50)


def _r(v, n=3):
    return None if v is None else round(v, n)


def summarise(results: list[dict]) -> dict:
    def acc(rs):
        judged = [r for r in rs if r["hit"] is not None]
        hits = sum(1 for r in judged if r["hit"])
        return hits, len(judged), (round(100 * hits / len(judged), 1) if judged else None)

    hits, judged, accuracy = acc(results)
    hhits, hjudged, haccuracy = acc([r for r in results if r.get("hard")])
    secs = [r["secs"] for r in results]
    out = {"cases": len(results), "hits": hits, "judged": judged, "accuracy": accuracy,
           "hardHits": hhits, "hardJudged": hjudged, "hardAccuracy": haccuracy,
           "found": sum(1 for r in results if r["box"]),
           "medianS": _r(median(secs)), "p90S": _r(percentile(secs, 90))}
    pre = [r.get("prefillS") for r in results]
    dec = [r.get("decodeS") for r in results]
    if any(v is not None for v in pre):
        out["medianPrefillS"] = _r(median(pre))
    if any(v is not None for v in dec):
        out["medianDecodeS"] = _r(median(dec))
    return out


# ---------------------------------------------------------------- this machine

def machine() -> dict:
    """cpu, ramGb and os the way the engine reports them (system.info), plus the architecture."""
    from breakpatch_engine import install, systems
    return {"cpu": install.chip(), "ramGb": install.memory_gb(), "os": install.os_name(),
            "arch": systems.arch(), "python": platform.python_version()}


def peak_rss_bytes(pid: int | None = None) -> int | None:
    """The peak resident size of a process: VmHWM on Linux, PeakWorkingSetSize on Windows,
    ru_maxrss for this process elsewhere (macOS). None when it can't be read."""
    pid = os.getpid() if pid is None else pid
    if sys.platform.startswith("linux"):
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            return None
        return None
    if sys.platform == "win32":
        return _windows_peak_working_set(pid)
    if pid == os.getpid():
        try:
            import resource
            return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)   # bytes on macOS
        except Exception:  # noqa: BLE001
            return None
    return None


def _windows_peak_working_set(pid: int) -> int | None:
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        k32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi   # type: ignore[attr-defined]
        handle = k32.OpenProcess(0x1000 | 0x0010, False, pid)   # QUERY_LIMITED_INFORMATION | VM_READ
        if not handle:
            return None
        try:
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
                return None
            return int(pmc.PeakWorkingSetSize)
        finally:
            k32.CloseHandle(handle)
    except Exception:  # noqa: BLE001
        return None


def nvidia_vram_gb() -> float | None:
    """The GPU's used memory now (the whole GPU, not only our process), from nvidia-smi."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        mib = sum(float(x) for x in out.split() if re.fullmatch(r"\d+(\.\d+)?", x))
        return round(mib / 1024, 2)
    except Exception:  # noqa: BLE001
        return None


def gb(n: int | float | None):
    return None if n is None else round(n / 1e9, 2)


# ---------------------------------------------------------------- runtimes

class Reply:
    def __init__(self, text: str, prefill_s=None, decode_s=None, prompt_tokens=None, output_tokens=None):
        self.text = text
        self.prefill_s, self.decode_s = prefill_s, decode_s
        self.prompt_tokens, self.output_tokens = prompt_tokens, output_tokens


class MlxRuntime:
    """mlx-vlm on Apple Silicon, called as the engine's MlxLocator calls it."""
    name, backend, device = "mlx", "mlx", "metal"

    def __init__(self, key: str, repo: str, max_tokens: int):
        self.key, self.repo, self.max_tokens = key, repo, max_tokens
        self.meta = {"repo": repo}

    def start(self) -> None:
        from mlx_vlm import load
        _reset_mlx_memory()
        self.model, self.processor = load(self.repo)
        self.config = getattr(self.model, "config", None)

    def ask(self, img: Image.Image, prompt: str) -> Reply:
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template
        formatted = apply_chat_template(self.processor, self.config, prompt, num_images=1)
        # Not NamedTemporaryFile(delete=True) reopened by name: that fails on Windows (plan §1.3).
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            img.convert("RGB").save(path)
            out = generate(self.model, self.processor, formatted, [path], max_tokens=self.max_tokens,
                           temperature=0.0, verbose=False)
        finally:
            os.unlink(path)
        text = out if isinstance(out, str) else getattr(out, "text", str(out))
        pt, gt = getattr(out, "prompt_tokens", None), getattr(out, "generation_tokens", None)
        ptps, gtps = getattr(out, "prompt_tps", None), getattr(out, "generation_tps", None)
        pre = pt / ptps if pt and ptps else None
        dec = gt / gtps if gt and gtps else None
        return Reply(text, pre, dec, pt, gt)

    def memory(self) -> dict:
        return {"mlxPeakGb": gb(_mlx_peak_memory()), "processPeakRssGb": gb(peak_rss_bytes()),
                "measures": "mlxPeakGb: MLX's peak allocation; processPeakRssGb: this Python process's peak resident size"}

    def stop(self) -> None:
        self.model = self.processor = None
        gc.collect()
        _reset_mlx_memory()


def _mlx_peak_memory():
    try:
        import mlx.core as mx
        fn = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
        return fn()
    except Exception:  # noqa: BLE001
        return None


def _reset_mlx_memory():
    try:
        import mlx.core as mx
        (getattr(mx, "reset_peak_memory", None) or mx.metal.reset_peak_memory)()
        (getattr(mx, "clear_cache", None) or mx.metal.clear_cache)()
    except Exception:  # noqa: BLE001
        pass


def _no_proxy_opener():
    # The server is on this machine or the LAN: never through an HTTP(S)_PROXY.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class OpenAIRuntime:
    """An OpenAI-compatible server that's already running (llama-server, Ollama, LM Studio):
    POST /v1/chat/completions with the screenshot as a data: URL, temperature 0 and a fixed seed,
    as the engine's llama.cpp backend will send it (plan §2.3). llama-server's `timings` give
    prefill and decode times."""
    name, backend = "openai", "openai"

    def __init__(self, key: str, url: str, model: str | None, max_tokens: int, api_key: str | None = None,
                 timeout: float = 300, server_pid: int | None = None):
        self.key, self.url, self.model, self.max_tokens = key, url.rstrip("/"), model, max_tokens
        self.api_key, self.timeout, self.server_pid = api_key, timeout, server_pid
        self.device = "server"
        self.meta = {"url": self.url, "model": model}

    def start(self) -> None:
        pass

    def _post(self, path: str, body: dict) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), method="POST", headers=headers)
        with _no_proxy_opener().open(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def ask(self, img: Image.Image, prompt: str) -> Reply:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="PNG")
        data = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        body = {"messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": data}},
                    {"type": "text", "text": prompt}]}],
                "temperature": 0, "max_tokens": self.max_tokens, "seed": SEED, "stream": False}
        if self.model:
            body["model"] = self.model
        doc = self._post("/v1/chat/completions", body)
        try:
            text = doc["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            text = ""
        t = doc.get("timings") or {}
        usage = doc.get("usage") or {}
        pre = t["prompt_ms"] / 1000 if isinstance(t.get("prompt_ms"), (int, float)) else None
        dec = t["predicted_ms"] / 1000 if isinstance(t.get("predicted_ms"), (int, float)) else None
        return Reply(text, pre, dec, t.get("prompt_n", usage.get("prompt_tokens")),
                     t.get("predicted_n", usage.get("completion_tokens")))

    def memory(self) -> dict:
        rss = peak_rss_bytes(self.server_pid) if self.server_pid else None
        return {"processPeakRssGb": gb(rss), "vramUsedGb": nvidia_vram_gb(),
                "measures": "processPeakRssGb: the server process's peak resident size (VmHWM / PeakWorkingSetSize); "
                            "vramUsedGb: the whole GPU's used memory after the run (nvidia-smi)"}

    def stop(self) -> None:
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaCppRuntime(OpenAIRuntime):
    """Starts llama-server with a GGUF model and its mmproj on a free local port, with a random API
    key (loopback isn't private on a shared machine), waits for /health, asks it as OpenAIRuntime
    does, and stops it at the end. The flags are the engine's plan (§2.3); until the engine has its
    own LlamaServer (Phase 2, P2.2) this is a small launcher of the same shape."""
    name, backend = "llamacpp", "llamacpp"

    def __init__(self, key: str, exe: str, gguf: Path, mmproj: Path, max_tokens: int, ngl: int, threads: int | None,
                 ctx: int, image_max_tokens: int | None, quant: str | None, mmproj_quant: str | None,
                 timeout: float, start_timeout: float = 600):
        super().__init__(key, "", None, max_tokens, api_key=secrets.token_urlsafe(24), timeout=timeout)
        self.exe, self.gguf, self.mmproj = exe, Path(gguf), Path(mmproj)
        self.ngl, self.threads, self.ctx, self.image_max_tokens = ngl, threads, ctx, image_max_tokens
        self.start_timeout = start_timeout
        self.device = "gpu" if ngl > 0 else "cpu"
        self.proc: subprocess.Popen | None = None
        self.log_path: Path | None = None
        self.meta = {"gguf": self.gguf.name, "mmproj": self.mmproj.name,
                     "llamacppBuild": llamacpp_build(exe), "quant": quant or guess_quant(self.gguf.name),
                     "mmprojQuant": mmproj_quant or guess_quant(self.mmproj.name),
                     "imageMaxTokens": image_max_tokens, "threads": threads, "ngl": ngl, "ctx": ctx}

    def command(self, port: int) -> list[str]:
        cmd = [self.exe, "-m", str(self.gguf), "--mmproj", str(self.mmproj), "--host", "127.0.0.1",
               "--port", str(port), "--api-key", self.api_key, "-c", str(self.ctx), "--parallel", "1",
               "-ngl", str(self.ngl), "--jinja", "--no-webui"]
        if self.threads:
            cmd += ["--threads", str(self.threads)]
        if self.image_max_tokens:
            cmd += ["--image-max-tokens", str(self.image_max_tokens)]
        return cmd

    def start(self) -> None:
        port = free_port()
        self.url = f"http://127.0.0.1:{port}"
        fd, log = tempfile.mkstemp(prefix="llama-server-", suffix=".log")
        self.log_path = Path(log)
        self.proc = subprocess.Popen(self.command(port), stdin=subprocess.DEVNULL, stdout=fd, stderr=subprocess.STDOUT)
        os.close(fd)
        self.server_pid = self.proc.pid
        end = time.monotonic() + self.start_timeout
        while time.monotonic() < end:
            if self.proc.poll() is not None:
                raise SystemExit(f"llama-server stopped (exit {self.proc.returncode}):\n{self._log_tail()}")
            try:
                with _no_proxy_opener().open(self.url + "/health", timeout=5) as r:
                    if r.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.2)
        self.stop()
        raise SystemExit(f"llama-server didn't answer /health within {self.start_timeout:.0f} s:\n{self._log_tail()}")

    def _log_tail(self) -> str:
        try:
            return "\n".join(self.log_path.read_text(errors="replace").splitlines()[-20:])
        except (OSError, AttributeError):
            return ""

    def memory(self) -> dict:
        m = super().memory()
        m["measures"] = m["measures"].replace("the server process's", "llama-server's")
        return m

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        if self.log_path:
            self.log_path.unlink(missing_ok=True)


def llamacpp_build(exe: str) -> str | None:
    """`llama-server --version` → "b6000 (1a2b3c4)"; None when it doesn't say."""
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
        text = out.stdout + out.stderr
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"version:\s*(\d+)\s*\(([0-9a-f]+)\)", text)
    if m:
        return f"b{m[1]} ({m[2]})"
    lines = text.strip().splitlines()
    return lines[0] if lines else None


def guess_quant(name: str) -> str | None:
    m = re.search(r"(IQ\d_[A-Z0-9_]+|Q\d_K_[SML]|Q\d_K|Q\d_\d|BF16|F16|F32)", name.upper())
    return m[1] if m else None


# ---------------------------------------------------------------- a run

def run_one(rt, cases, shots: Path, scale: float, warmup: bool = True) -> dict:
    print(f"\n== {rt.key} ({rt.name})")
    t0 = time.time()
    rt.start()
    load_s = time.time() - t0
    print(f"   ready in {load_s:.1f}s")
    results = []
    try:
        if warmup and cases:
            first = effective(Image.open(shots / cases[0]["file"]), scale)
            t = time.time()
            rt.ask(first, locate_prompt(cases[0]["desc"]))
            print(f"   warm-up {time.time() - t:5.2f}s (not counted)")
        for i, c in enumerate(cases, 1):
            full = Image.open(shots / c["file"])
            w, h = full.size
            img = effective(full, scale)
            t = time.time()
            reply = rt.ask(img, locate_prompt(c["desc"]))
            secs = time.time() - t
            # parse_bbox maps 0-1000 units onto the full-size screenshot, as the engine does.
            box = parse_bbox(reply.text, w, h)
            ok = hit(box, c["expected"])
            mark = "?" if ok is None else ("hit" if ok else "miss")
            print(f"   {i:>2}/{len(cases)} {secs:6.2f}s {mark:<4}{' hard' if c['hard'] else '     '} {c['desc']}")
            results.append({"file": c["file"], "desc": c["desc"], "hard": c["hard"], "expected": c["expected"],
                            "box": box, "hit": ok, "iou": iou(box, c["expected"]), "secs": round(secs, 3),
                            "prefillS": _r(reply.prefill_s), "decodeS": _r(reply.decode_s),
                            "promptTokens": reply.prompt_tokens, "outputTokens": reply.output_tokens,
                            "size": [w, h], "effectiveSize": list(img.size),
                            "imageTokensEst": image_tokens(*img.size), "raw": (reply.text or "").strip()[:300]})
        memory = rt.memory()
    finally:
        rt.stop()
    run = {"key": rt.key, "runtime": rt.name, "backend": rt.backend, "device": rt.device, **rt.meta,
           "scale": scale, "loadS": round(load_s, 2), "memory": memory, "summary": summarise(results),
           "results": results}
    s = run["summary"]
    print(f"   {s['hits']}/{s['judged']} correct, hard {s['hardHits']}/{s['hardJudged']}, "
          f"median {s['medianS']}s, p90 {s['p90S']}s")
    return run


# ---------------------------------------------------------------- report

def colour(run, n):
    return KEY_COLOURS.get(run["key"], COLOURS[n % len(COLOURS)])


def safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", key)


def draw(shots, out_dir, cases, runs):
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for idx, c in enumerate(cases):
        for n, run in enumerate(runs):
            r = run["results"][idx]
            im = Image.open(shots / c["file"]).convert("RGB")
            d = ImageDraw.Draw(im)
            if c["expected"]:
                d.rectangle(c["expected"], outline="#FFFFFF", width=2)
            if r["box"]:
                d.rectangle(r["box"], outline=colour(run, n), width=4)
            im.save(img_dir / f"{idx:02d}-{safe(run['key'])}.jpg", quality=80)


def fmt_s(v):
    return "n/a" if v is None else f"{v:.2f}s"


def fmt_gb(v):
    return "n/a" if v is None else f"{v:.1f} GB"


def report(out_dir, cases, runs, doc):
    rows = []
    for run in runs:
        s, m = run["summary"], run["memory"]
        acc = f"{s['hits']}/{s['judged']}" if s["judged"] else "not judged"
        hard = f"{s['hardHits']}/{s['hardJudged']}" if s["hardJudged"] else "n/a"
        mem = " · ".join(f"{k} {fmt_gb(v)}" for k, v in m.items() if k != "measures" and v is not None) or "n/a"
        split = ""
        if s.get("medianPrefillS") is not None:
            split = f"<br><small>prefill {fmt_s(s['medianPrefillS'])} · decode {fmt_s(s.get('medianDecodeS'))}</small>"
        what = html.escape(run.get("repo") or run.get("gguf") or run.get("url") or "")
        rows.append(f"<tr><td><b>{html.escape(run['key'])}</b> <small>{html.escape(run['runtime'])} · "
                    f"{html.escape(str(run.get('device')))}</small><br><small>{what}</small></td><td>{acc}</td><td>{hard}</td>"
                    f"<td>{s['found']}/{s['cases']}</td><td>{fmt_s(s['medianS'])}{split}</td><td>{fmt_s(s['p90S'])}</td>"
                    f"<td>{run['loadS']:.1f}s</td><td>{mem}<br><small>{html.escape(m.get('measures', ''))}</small></td></tr>")

    head = "".join(f"<th>{html.escape(r['key'])}</th>" for r in runs)
    body = []
    for idx, c in enumerate(cases):
        cells = []
        for run in runs:
            r = run["results"][idx]
            tag = "" if r["hit"] is None else ("<span class=ok>hit</span>" if r["hit"] else "<span class=no>miss</span>")
            img = f"images/{idx:02d}-{safe(run['key'])}.jpg"
            cells.append(f"<td><a href='{img}'><img src='{img}'></a><div>{tag} {r['secs']:.2f}s</div>"
                         f"<details><summary>answer</summary><code>{html.escape(r['raw'])}</code></details></td>")
        hard = " <small>(hard)</small>" if c["hard"] else ""
        body.append(f"<tr><th class=case>{html.escape(c['desc'])}{hard}<br><small>{html.escape(c['file'])}</small></th>{''.join(cells)}</tr>")

    mc = doc["machine"]
    page = f"""<!doctype html><meta charset=utf-8><title>Breakpatch model test</title>
<style>body{{font-family:-apple-system,system-ui,sans-serif;background:#171412;color:#F6EFE9;margin:32px}}
h1{{font-size:28px}}table{{border-collapse:collapse;margin:16px 0}}td,th{{border:1px solid #3A322C;padding:8px;vertical-align:top;text-align:left}}
th{{background:#211C19}}img{{width:320px;display:block;border-radius:6px}}small{{color:#A3978C}}.ok{{color:#8CC56B;font-weight:700}}.no{{color:#F2667A;font-weight:700}}
code{{white-space:pre-wrap;font-size:11px;color:#CFC4BA}}.case{{width:200px}}</style>
<h1>Breakpatch model test</h1>
<p>{html.escape(str(mc['cpu']))} · {mc['ramGb']} GB · {html.escape(str(mc['os']))} · screenshots {html.escape(doc['set'])}.
White box: expected. Coloured box: the model's answer. Times: median and 90th percentile, after one warm-up call.</p>
<table><tr><th>Model</th><th>Correct</th><th>Hard cases</th><th>Gave a box</th><th>Median answer</th><th>p90</th><th>Load</th><th>Memory</th></tr>{''.join(rows)}</table>
<table><tr><th>Case</th>{head}</tr>{''.join(body)}</table>"""
    (out_dir / "index.html").write_text(page)


# ---------------------------------------------------------------- main

def check_shots(shots: Path, cases, size) -> None:
    missing = [c["file"] for c in cases if not (shots / c["file"]).exists()]
    if missing:
        raise SystemExit(f"Missing screenshots in {shots}/: {', '.join(missing)}")
    if size:
        wrong = []
        for f in sorted({c["file"] for c in cases}):
            got = Image.open(shots / f).size
            if got != size:
                wrong.append(f"{f} ({got[0]} x {got[1]})")
        if wrong:
            raise SystemExit(f"These screenshots aren't {size[0]} x {size[1]}: {', '.join(wrong)}. "
                             "Take them at that viewport (deviceScaleFactor 1), or pass --set any.")


def runtimes(a) -> list:
    if a.runtime == "mlx":
        unknown = [k for k in a.models if k not in MODELS]
        if unknown:
            raise SystemExit(f"Unknown model {', '.join(unknown)}; the MLX models are {', '.join(MODELS)}")
        return [MlxRuntime(k, MODELS[k], a.max_tokens) for k in a.models]
    if a.runtime == "openai":
        if not a.url:
            raise SystemExit("--runtime openai needs --url, e.g. http://127.0.0.1:8080")
        key = os.environ.get(a.api_key_env) if a.api_key_env else None
        return [OpenAIRuntime(a.name or "openai", a.url, a.model, a.max_tokens, api_key=key,
                              timeout=a.timeout, server_pid=a.server_pid)]
    if not (a.gguf and a.mmproj):
        raise SystemExit("--runtime llamacpp needs --gguf and --mmproj")
    exe = a.llama_server or shutil.which("llama-server")
    if not exe:
        raise SystemExit("llama-server not found: pass --llama-server PATH")
    name = a.name or Path(a.gguf).stem
    return [LlamaCppRuntime(name, exe, Path(a.gguf), Path(a.mmproj), a.max_tokens, a.ngl, a.threads, a.ctx,
                            a.image_max_tokens, a.quant, a.mmproj_quant, a.timeout)]


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Breakpatch model test")
    ap.add_argument("--runtime", choices=["mlx", "llamacpp", "openai"], default="mlx")
    ap.add_argument("--set", default=DEFAULT_SET, help=f"screenshot set: {', '.join(SETS)} or any (default {DEFAULT_SET})")
    ap.add_argument("--cases", help="default cases.csv (1280x800), cases-<set>.csv for another set")
    ap.add_argument("--shots", help="default screenshots/<set>")
    ap.add_argument("--out", default="results")
    ap.add_argument("--models", nargs="*", default=list(MODELS), help="MLX models (--runtime mlx)")
    ap.add_argument("--scale", type=float, default=1.0, help="send each screenshot at this scale (0.5: half size)")
    ap.add_argument("--max-tokens", type=int, default=MAX_TOKENS)
    ap.add_argument("--no-warmup", action="store_true", help="count the first call too")
    ap.add_argument("--name", help="this run's name in the results (llamacpp, openai)")
    ap.add_argument("--timeout", type=float, default=300, help="seconds per answer (llamacpp, openai)")
    g = ap.add_argument_group("llamacpp")
    g.add_argument("--llama-server", help="the llama-server binary (default: on PATH)")
    g.add_argument("--gguf", help="the model's .gguf")
    g.add_argument("--mmproj", help="its vision encoder's mmproj .gguf")
    g.add_argument("--ngl", type=int, default=0, help="layers on the GPU: 0 for CPU only, 99 for all")
    g.add_argument("--threads", type=int, help="CPU threads (default llama-server's)")
    g.add_argument("--ctx", type=int, default=4096)
    g.add_argument("--image-max-tokens", type=int, help="llama-server's --image-max-tokens")
    g.add_argument("--quant", help="the model's quantisation, when the file name doesn't say")
    g.add_argument("--mmproj-quant", help="the mmproj's quantisation, when the file name doesn't say")
    g = ap.add_argument_group("openai")
    g.add_argument("--url", help="the server's base address, e.g. http://127.0.0.1:8080")
    g.add_argument("--model", help="the model name the server wants, if any")
    g.add_argument("--api-key-env", help="an environment variable holding the server's API key")
    g.add_argument("--server-pid", type=int, help="the server's process id, to read its peak memory")
    a = ap.parse_args(argv)
    if not 0.1 <= a.scale <= 1:
        ap.error("--scale is from 0.1 to 1")
    return a


def main(argv=None) -> int:
    a = parse_args(argv)
    size = None if a.set == "any" else SETS.get(a.set)
    if a.set != "any" and size is None:
        raise SystemExit(f"--set is {', '.join(SETS)} or any, not {a.set}")
    cases_path = Path(a.cases) if a.cases else HERE / ("cases.csv" if a.set in (DEFAULT_SET, "any") else f"cases-{a.set}.csv")
    shots = Path(a.shots) if a.shots else HERE / "screenshots" / a.set
    out_dir = Path(a.out)
    cases = load_cases(cases_path)
    if not cases:
        raise SystemExit(f"No cases in {cases_path}")
    check_shots(shots, cases, size)
    rts = runtimes(a)
    print(f"{len(cases)} cases ({sum(c['hard'] for c in cases)} hard), set {a.set}, runtime {a.runtime}: "
          f"{', '.join(r.key for r in rts)}")

    runs = [run_one(rt, cases, shots, a.scale, warmup=not a.no_warmup) for rt in rts]
    doc = {"tool": "breakpatch model-test", "resultsVersion": RESULTS_VERSION, "set": a.set,
           "cases": cases_path.name, "machine": machine(), "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "runs": runs}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(doc, indent=2))
    draw(shots, out_dir, cases, runs)
    report(out_dir, cases, runs, doc)
    print(f"\nDone. Open {out_dir / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
