"""Setup: this machine's details, the pinned Chromium, the AI model (spec §7, §16) and, off the Mac,
the llama.cpp runtime that runs it (runtimes.py)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from . import __version__, config, models, net
from .protocol import EngineError

log = logging.getLogger("breakpatch.setup")

Progress = Callable[[dict], None]
MARKER = ".breakpatch-model.json"


# ---------------------------------------------------------------- this machine

# Everything that says what this machine is lives in systems.py; these names stay here for the
# code and tests that read them from install.
from .systems import (  # noqa: E402,F401
    CPUINFO, DEVICE_TREE_MODEL, WINDOWS_CPU_KEY, chip, linux_cpu_name, memory_gb, os_name,
    windows_cpu_name, windows_memory_bytes,
)


# ---------------------------------------------------------------- browser

def _driver() -> tuple[list[str], dict]:
    from playwright._impl._driver import compute_driver_executable, get_driver_env

    exe = compute_driver_executable()
    cmd = list(exe) if isinstance(exe, (tuple, list)) else [str(exe)]
    env = get_driver_env()
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(config.browsers_dir())
    return cmd, env


# Where Playwright fetches Chromium from (its first download host): the proxy is worked out for it.
BROWSER_DOWNLOAD = "https://cdn.playwright.dev/"


def download_env(cmd: list[str], env: dict) -> dict:
    """The browser install's environment: Playwright's downloader (Node) reads HTTPS_PROXY but not
    the Mac's proxy settings, and trusts Node's own certificates unless told --use-system-ca."""
    node = cmd[0] if cmd else ""
    return net.child_env(env, BROWSER_DOWNLOAD, system_ca=bool(node) and net.node_has_system_ca(node))


# What the browser install prints when the network got in the way (Node's error codes).
_INSTALL_CERT = ("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
                 "CERT_UNTRUSTED", "DEPTH_ZERO_SELF_SIGNED_CERT", "unable to get local issuer certificate")


def install_failure(tail: list[str], env: dict) -> str:
    text = "\n".join(tail)
    if any(c in text for c in _INSTALL_CERT):
        return net.TLS_INTERCEPTED
    proxy = env.get("HTTPS_PROXY") or env.get("https_proxy")
    if "407" in text or "Proxy Authentication Required" in text:
        return net.proxy_auth(proxy)
    msg = "The browser couldn't be installed. Check your internet connection and try again."
    if not proxy and net.auto_proxy():
        msg += net.PAC_HINT
    return msg


def pinned_browser() -> dict:
    """Revision and version of the Chromium this Playwright build expects."""
    try:
        import playwright
        data = json.loads((Path(playwright.__file__).parent / "driver" / "package" / "browsers.json").read_text())
        for b in data.get("browsers", []):
            if b.get("name") == "chromium":
                return {"revision": b.get("revision"), "version": b.get("browserVersion")}
    except Exception:  # noqa: BLE001
        pass
    return {}


def browser_status() -> dict:
    exe = config.chromium_executable()
    if exe:
        return {"installed": Path(exe).exists(), "version": "custom"}
    pin = pinned_browser()
    rev = pin.get("revision")
    installed = bool(rev) and (config.browsers_dir() / f"chromium-{rev}" / "INSTALLATION_COMPLETE").exists()
    out = {"installed": installed}
    if pin.get("version"):
        out["version"] = f"Chromium {pin['version']}"
    return out


# Where the pinned Chromium keeps its program, by Playwright's folder names (Chrome for Testing on
# x64, Playwright's own build on arm64, and older builds).
CHROMIUM_FOLDERS = ("chrome-linux64", "chrome-linux-arm64", "chrome-linux")


def chromium_path() -> Path | None:
    """The Chromium program the engine starts on Linux: BP_CHROMIUM's, else the pinned one in
    config.browsers_dir(). None when it isn't there."""
    exe = config.chromium_executable()
    if exe:
        return Path(exe) if Path(exe).is_file() else None
    rev = pinned_browser().get("revision")
    if not rev:
        return None
    base = config.browsers_dir() / f"chromium-{rev}"
    for sub in CHROMIUM_FOLDERS:
        if (base / sub / "chrome").is_file():
            return base / sub / "chrome"
    return None


_NOT_FOUND = re.compile(r"^\s*(\S+)\s+=>\s+not found\s*$")


def missing_libraries(exe: Path | None = None, run=subprocess.run) -> list[str]:
    """Linux only: the system libraries Chromium needs that this machine hasn't got (what `ldd`
    says is "not found"), sorted. Empty elsewhere, when everything is there, or when it can't tell
    (no Chromium, no ldd). Libraries in Chromium's own folder count as there, as when it starts."""
    if not sys.platform.startswith("linux"):
        return []
    exe = exe or chromium_path()
    if exe is None or not Path(exe).is_file():
        return []
    ldd = shutil.which("ldd")
    if not ldd:
        return []
    folder = str(Path(exe).parent)
    env = dict(os.environ, LD_LIBRARY_PATH=":".join(p for p in (os.environ.get("LD_LIBRARY_PATH"), folder) if p))
    try:
        out = run([ldd, str(exe)], capture_output=True, text=True, env=env, timeout=30).stdout or ""
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({m.group(1) for line in out.splitlines() if (m := _NOT_FOUND.match(line))})


# What Chromium (or Playwright, before it starts it) says when the system lacks a library.
_LIBRARY_ERRORS = ("error while loading shared libraries", "missing dependencies to run browsers",
                   "Host system is missing dependencies")


def is_library_error(text: str) -> bool:
    return any(s in text for s in _LIBRARY_ERRORS)


def libraries_message(missing: list[str], python: str | None = None) -> str:
    """The plain words for a Linux machine that lacks Chromium's libraries, with the one command
    that adds them (Playwright's install-deps, for Ubuntu and Debian)."""
    names = ", ".join(missing[:5]) + (f" and {len(missing) - 5} more" if len(missing) > 5 else "")
    lacks = "this machine is missing system libraries it needs" + (f" ({names})" if missing else "")
    sudo = "" if hasattr(os, "geteuid") and os.geteuid() == 0 else "sudo "
    return (f"The browser can't start: {lacks}. Install them once, as an administrator: "
            f"{sudo}{python or sys.executable} -m playwright install-deps chromium. "
            "That works on Ubuntu and Debian. On another Linux, install the packages that have those libraries.")


_SIZE = re.compile(r"(\d+)%\s+of\s+([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)", re.I)
_UNITS = {"b": 1, "kib": 2**10, "mib": 2**20, "gib": 2**30, "kb": 1e3, "mb": 1e6, "gb": 1e9}


def parse_install_line(line: str) -> tuple[int, int] | None:
    """`|■■■■      |  40% of 162.3 MiB` -> (done bytes, total bytes)."""
    m = _SIZE.search(line)
    if not m:
        return None
    total = int(float(m.group(2)) * _UNITS[m.group(3).lower()])
    return int(total * int(m.group(1)) / 100), total


class Task:
    """One pausable setup job running in a child process."""

    def __init__(self):
        self.proc: asyncio.subprocess.Process | None = None
        self.paused = False
        self.running = False


class Setup:
    def __init__(self, emit: Progress):
        self.emit = emit
        self.tasks = {"browser": Task(), "model": Task(), "runtime": Task()}

    async def pause(self, task: str) -> None:
        t = self.tasks.get(task)
        if t is None:
            raise EngineError("bad_request", "There's nothing to pause.", f"unknown task {task!r}")
        if t.running and t.proc is not None:
            t.paused = True
            try:
                t.proc.terminate()
            except ProcessLookupError:
                pass

    # ------------------------------------------------------------ browser

    async def install_browser(self) -> dict:
        t = self.tasks["browser"]
        if t.running:
            raise EngineError("busy", "The browser is already being installed.")
        t.running, t.paused = True, False
        cmd, env = _driver()
        self.emit({"task": "browser", "state": "busy", "message": "Installing the browser"})
        try:
            env = await asyncio.to_thread(download_env, cmd, env)
            t.proc = await asyncio.create_subprocess_exec(
                *cmd, "install", "chromium", "--no-shell", env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            tail: list[str] = []
            buf = b""
            last = 0.0
            start = time.monotonic()
            while True:
                chunk = await t.proc.stdout.read(4096)
                if not chunk:
                    break
                buf += chunk
                parts = re.split(rb"[\r\n]", buf)
                buf = parts.pop()
                for raw in parts:
                    line = raw.decode(errors="replace").strip()
                    if not line:
                        continue
                    tail = (tail + [line])[-20:]
                    got = parse_install_line(line)
                    if got and time.monotonic() - last > 0.25:
                        last = time.monotonic()
                        done, total = got
                        rate = done / max(0.1, last - start)
                        self.emit({"task": "browser", "state": "busy", "doneBytes": done, "totalBytes": total,
                                   "etaSeconds": round((total - done) / rate) if rate > 0 else None})
            code = await t.proc.wait()
            if t.paused:
                self.emit({"task": "browser", "state": "paused"})
                raise EngineError("stopped", "The browser install is paused.")
            if code != 0:
                self.emit({"task": "browser", "state": "failed", "message": "The browser couldn't be installed."})
                raise EngineError("network", install_failure(tail, env), "\n".join(tail))
            status = browser_status()
            self.emit({"task": "browser", "state": "done"})
            return {"version": status.get("version", "Chromium")}
        finally:
            t.running, t.proc = False, None

    # ------------------------------------------------------------ model

    async def download_model(self, repo: str, revision: str | None) -> dict:
        if not repo:
            raise EngineError("bad_request", "Choose which AI assistant to download.")
        m = models.entry(repo, revision)          # only the models in models.ALLOWED, at their revision
        t = self.tasks["model"]
        if t.running:
            raise EngineError("busy", "The AI assistant is already downloading.")
        t.running, t.paused = True, False
        if not m.pinned:
            log.warning("%s isn't pinned to a commit with file hashes yet (models.py TODO): development "
                        "download, checked against the Hub's own hashes only", repo)
        dest = model_path(repo)
        dest.mkdir(parents=True, exist_ok=True)
        cmd = self_command() + ["_download", "--repo", repo, "--revision", m.revision, "--dir", str(dest),
                                "--files", json.dumps(m.files)]
        env = hub_env(os.environ)
        total = 0
        result: dict | None = None
        error: dict | None = None
        try:
            t.proc = await asyncio.create_subprocess_exec(*cmd, env=env, stdout=asyncio.subprocess.PIPE,
                                                          stderr=asyncio.subprocess.PIPE)

            async def read_stdout():
                nonlocal total, result, error
                async for raw in t.proc.stdout:
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if "total" in msg:
                        total = int(msg["total"])
                    elif "verifying" in msg:
                        self.emit({"task": "model", "state": "busy", "doneBytes": total, "totalBytes": total,
                                   "etaSeconds": 0, "message": "Checking the download"})
                    elif "done" in msg:
                        result = msg
                    elif "error" in msg:
                        error = msg
                    elif "warning" in msg:
                        log.warning("download: %s", msg["warning"])

            async def drain_stderr():
                async for raw in t.proc.stderr:
                    log.info("download: %s", raw.decode(errors="replace").rstrip())

            async def ticker():
                samples: list[tuple[float, int]] = []
                while True:
                    await asyncio.sleep(0.5)
                    done = dir_bytes(dest)
                    now = time.monotonic()
                    samples = [s for s in samples if now - s[0] < 10] + [(now, done)]
                    eta = None
                    if total and len(samples) > 1 and samples[-1][1] > samples[0][1]:
                        rate = (samples[-1][1] - samples[0][1]) / (samples[-1][0] - samples[0][0])
                        eta = max(0, round((total - done) / rate))
                    self.emit({"task": "model", "state": "busy", "doneBytes": min(done, total) if total else done,
                               "totalBytes": total or None, "etaSeconds": eta})

            tick = asyncio.create_task(ticker())
            try:
                await asyncio.gather(read_stdout(), drain_stderr())
                code = await t.proc.wait()
            finally:
                tick.cancel()
            if t.paused:
                self.emit({"task": "model", "state": "paused", "doneBytes": dir_bytes(dest), "totalBytes": total or None})
                raise EngineError("stopped", "The download is paused.")
            if code != 0 or result is None:
                msg = (error or {}).get("error", "The download stopped.")
                kind = (error or {}).get("kind", "network")
                self.emit({"task": "model", "state": "failed", "message": msg})
                raise EngineError(kind if kind in ("network", "not_found", "bad_request") else "network",
                                  msg, (error or {}).get("details"))
            size = int(result.get("sizeBytes", 0))
            write_marker(dest, repo, m.revision, result.get("commit"), size, m.format)
            self.emit({"task": "model", "state": "done", "doneBytes": size, "totalBytes": size, "etaSeconds": 0})
            return {"path": str(dest), "sizeBytes": size}
        finally:
            t.running, t.proc = False, None

    # ------------------------------------------------------------ llama.cpp runtime (off the Mac)

    async def install_runtime(self, backend: str | None = None) -> dict:
        """Downloads, checks and unpacks this platform's pinned llama.cpp runtime (runtimes.py).
        Pausable and resumable like the model; progress events have `task: "runtime"`."""
        from . import runtimes
        e = runtimes.entry(backend or "cpu")         # only a pinned build for this platform
        t = self.tasks["runtime"]
        if t.running:
            raise EngineError("busy", "The AI runtime is already downloading.")
        t.running, t.paused = True, False
        total = int(e.get("size") or 0) or None
        part_dir = config.runtimes_dir() / runtimes.PARTIAL_DIR
        cmd = self_command() + ["_runtime_download", "--spec", json.dumps(e)]
        result: dict | None = None
        error: dict | None = None
        try:
            t.proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                          stderr=asyncio.subprocess.PIPE)

            async def read_stdout():
                nonlocal total, result, error
                async for raw in t.proc.stdout:
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if "total" in msg:
                        total = msg["total"] or total
                    elif "verifying" in msg:
                        self.emit({"task": "runtime", "state": "busy", "doneBytes": total, "totalBytes": total,
                                   "etaSeconds": 0, "message": "Checking the download"})
                    elif "done" in msg:
                        result = msg
                    elif "error" in msg:
                        error = msg

            async def drain_stderr():
                async for raw in t.proc.stderr:
                    log.info("runtime download: %s", raw.decode(errors="replace").rstrip())

            tick = asyncio.create_task(self._ticker("runtime", lambda: dir_bytes(part_dir), lambda: total))
            try:
                await asyncio.gather(read_stdout(), drain_stderr())
                code = await t.proc.wait()
            finally:
                tick.cancel()
            if t.paused:
                self.emit({"task": "runtime", "state": "paused", "doneBytes": dir_bytes(part_dir), "totalBytes": total})
                raise EngineError("stopped", "The download is paused.")
            if code != 0 or result is None:
                msg = (error or {}).get("error", "The download stopped.")
                kind = (error or {}).get("kind", "network")
                self.emit({"task": "runtime", "state": "failed", "message": msg})
                raise EngineError(kind if kind in ("network", "not_found", "bad_request") else "network",
                                  msg, (error or {}).get("details"))
            self.emit({"task": "runtime", "state": "done", "doneBytes": total, "totalBytes": total, "etaSeconds": 0})
            return {"path": result["done"], "build": e["build"], "backend": e["backend"]}
        finally:
            t.running, t.proc = False, None

    async def _ticker(self, task: str, measure: Callable[[], int], total: Callable[[], int | None]) -> None:
        """setup.progress every half second while a download child runs: bytes so far and an ETA
        from the last 10 seconds."""
        samples: list[tuple[float, int]] = []
        while True:
            await asyncio.sleep(0.5)
            done, whole = measure(), total()
            now = time.monotonic()
            samples = [x for x in samples if now - x[0] < 10] + [(now, done)]
            eta = None
            if whole and len(samples) > 1 and samples[-1][1] > samples[0][1]:
                rate = (samples[-1][1] - samples[0][1]) / (samples[-1][0] - samples[0][0])
                eta = max(0, round((whole - done) / rate))
            self.emit({"task": task, "state": "busy", "doneBytes": min(done, whole) if whole else done,
                       "totalBytes": whole or None, "etaSeconds": eta})

    async def remove_model(self) -> None:
        if self.tasks["model"].running:
            await self.pause("model")
            for _ in range(50):
                if not self.tasks["model"].running:
                    break
                await asyncio.sleep(0.1)
        root = config.models_dir()
        if root.exists():
            await asyncio.to_thread(shutil.rmtree, root, True)


# Hugging Face settings only development runs may change: where the Hub is and whose token to send.
HUB_DEV_ONLY = ("HF_ENDPOINT", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_TOKEN_PATH", "HF_HUB_ENDPOINT")


def hub_env(base) -> dict:
    """The download child's environment. A release build ignores HF_ENDPOINT and HF_TOKEN (and the
    like): it always talks to huggingface.co, without anyone's token."""
    env = dict(base)
    if config.is_release():
        for k in HUB_DEV_ONLY:
            env.pop(k, None)
        env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    env["HF_HOME"] = str(config.models_dir() / ".hf")    # never the user's own Hub cache or token
    env["HF_HUB_DISABLE_XET"] = "1"   # the engine fetches files itself over plain HTTP (resumable)
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    return env


def self_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-m", "breakpatch_engine"]


def model_path(repo: str) -> Path:
    return config.models_dir() / repo.replace("/", "__")


def dir_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def write_marker(dest: Path, repo: str, revision: str, commit: str | None, size: int, fmt: str = "mlx") -> None:
    """The install record. `format` is "mlx" or "gguf"; a record without it (an older engine's) is MLX."""
    (dest / MARKER).write_text(json.dumps({"repo": repo, "revision": revision, "commit": commit,
                                           "sizeBytes": size, "installedAt": time.time(), "format": fmt}))


def installed_model() -> dict:
    """The most recently completed model download, if any."""
    root = config.models_dir()
    best = None
    if root.exists():
        for d in root.iterdir():
            m = d / MARKER
            if m.is_file():
                try:
                    info = json.loads(m.read_text())
                except ValueError:
                    continue
                if best is None or info.get("installedAt", 0) > best[0].get("installedAt", 0):
                    best = (info, d)
    if best is None:
        return {"installed": False}
    info, d = best
    return {"installed": True, "repo": info.get("repo"), "revision": info.get("revision"),
            "sizeBytes": info.get("sizeBytes"), "path": str(d), "format": info.get("format") or "mlx"}


def system_info() -> dict:
    """`runtime` says what runs the AI assistant here: "mlx" on Apple Silicon, "llamacpp" elsewhere,
    where `llamacpp` says whether its runtime is installed (runtimes.installed_runtime)."""
    from . import plugins, runtimes, systems
    out = {"memoryGb": memory_gb(), "chip": chip(), "os": os_name(), "engineVersion": __version__,
           "edition": plugins.edition(), "licence": plugins.licence_status(), "browser": browser_status(),
           "model": installed_model(), "system": systems.current(), "runtime": runtimes.runtime_name()}
    if out["runtime"] == "llamacpp":
        out["llamacpp"] = runtimes.installed_runtime()
    return out


# ---------------------------------------------------------------- download child process

PARTIAL_DIR = ".partial"


def download_main(repo: str, revision: str, dest: str, files: str | None = None) -> int:
    """Runs in a child process so a pause can simply stop it.

    huggingface_hub 2.x no longer resumes a partial file across processes (each attempt writes a
    process-unique temp file and deletes it on failure), so the engine downloads each file itself:
    bytes go to `dest/.partial/<file>.part` and a later call continues with an HTTP Range request.

    `files` is the model's allowlist from models.py (JSON: name -> SHA-256), passed by the engine:
    only those files are fetched, each checked against its shipped SHA-256 before it's moved into
    place, and all of them again at the end. With an empty list (a development placeholder) every
    file except code is fetched, checked against the Hub's LFS hashes. Either way file names must
    stay inside the folder, and a config naming `model_file` or `auto_map` fails the download.
    """
    def say(obj: dict) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    if config.is_release():
        for k in HUB_DEV_ONLY:
            os.environ.pop(k, None)
    try:
        allow: dict[str, str] = json.loads(files or "{}")
        if not isinstance(allow, dict):
            raise ValueError("not a map")
    except ValueError as e:
        say({"error": "The engine couldn't read the AI assistant's file list.", "details": str(e), "kind": "internal"})
        return 1

    try:
        from huggingface_hub import HfApi, constants, hf_hub_url
        from huggingface_hub.utils import (HfHubHTTPError, RepositoryNotFoundError, RevisionNotFoundError,
                                           build_hf_headers, hf_raise_for_status, http_stream_backoff)
    except Exception as e:  # noqa: BLE001
        say({"error": "The downloader is missing from this build.", "details": str(e), "kind": "internal"})
        return 1
    endpoint = constants.ENDPOINT
    proxy = net.proxy_for(endpoint)
    try:
        net.use_for_hub(endpoint)       # the system trust store and proxy, not certifi's bundle alone
    except Exception as e:  # noqa: BLE001 - huggingface_hub's own client still works, with certifi
        say({"warning": f"the system certificate store couldn't be used for the download: {e}"})

    root = Path(dest)
    partial_dir = root / PARTIAL_DIR

    def fetch(name: str, size: int | None, sha: str | None, commit: str) -> None:
        final = root / name
        if final.is_file() and (size is None or final.stat().st_size == size):
            return                                              # finished on an earlier call (checked again below)
        part = partial_dir / (name + ".part")
        part.parent.mkdir(parents=True, exist_ok=True)
        have = part.stat().st_size if part.is_file() else 0
        if size is not None and have > size:
            part.unlink()
            have = 0
        if size is None or have < size:
            headers = build_hf_headers(library_name="breakpatch-engine")
            if have:
                headers["Range"] = f"bytes={have}-"
            with http_stream_backoff("GET", hf_hub_url(repo, name, revision=commit), headers=headers) as r:
                hf_raise_for_status(r)
                mode = "ab"
                if have and r.status_code != 206:
                    mode = "wb"                                 # the server ignored the Range: start over
                with open(part, mode) as f:
                    for chunk in r.iter_bytes(256 * 1024):
                        f.write(chunk)
        actual = part.stat().st_size
        if size is not None and actual != size:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"size mismatch for {name}: {actual} != {size}")
        if sha and models.sha256_of(part) != sha:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"checksum mismatch for {name}")
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(part, final)

    try:
        for name in allow:
            models.check_name(name)
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        commit = info.sha or revision
        if models.COMMIT.match(revision) and commit != revision:
            raise RuntimeError(f"the Hub answered with commit {commit}, not {revision}")
        hub = {s.rfilename: s for s in (info.siblings or [])}
        wanted: list[tuple[str, int | None, str | None]] = []
        if allow:
            missing = [n for n in allow if n not in hub]
            if missing:
                say({"error": "That AI assistant version couldn't be found.", "details": f"missing: {missing}",
                     "kind": "not_found"})
                return 1
            wanted = [(n, int(hub[n].size) if hub[n].size is not None else None, allow[n]) for n in allow]
        else:
            say({"warning": f"{repo} has no file list with hashes yet (models.py): development download"})
            for name, s in hub.items():
                try:
                    models.check_name(name)
                except models.Refused as e:
                    if isinstance(name, str) and name.lower().endswith(models.CODE_SUFFIXES) and ".." not in name \
                            and not name.startswith("/"):
                        say({"warning": f"skipped {name}: {e}"})
                        continue
                    raise
                lfs = getattr(s, "lfs", None)
                sha = (lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)) if lfs else None
                wanted.append((name, s.size, sha))
        wanted.sort(key=lambda w: int(w[1] or 0))                    # small files first
        total = sum(int(w[1] or 0) for w in wanted)
        unhashed = [w[0] for w in wanted if not w[2]]
        if allow and unhashed:
            say({"warning": f"{repo}: no SHA-256 in models.py for {unhashed} yet: development download"})
        say({"total": total, "commit": commit})
        for name, size, sha in wanted:
            fetch(name, size, sha, commit)
        say({"verifying": True})
        if allow:
            for name, sha in allow.items():
                if sha and models.sha256_of(root / name) != sha:
                    (root / name).unlink(missing_ok=True)
                    raise RuntimeError(f"checksum mismatch for {name}")
        models.check_configs(root)
        size = sum((root / w[0]).stat().st_size for w in wanted)
        shutil.rmtree(partial_dir, ignore_errors=True)
        say({"done": str(root), "sizeBytes": size, "commit": commit})
        return 0
    except models.Refused as e:
        shutil.rmtree(root, ignore_errors=True)
        say({"error": "This AI assistant has files Breakpatch won't use, so it wasn't installed.", "details": str(e),
             "kind": "bad_request"})
    except (RepositoryNotFoundError, RevisionNotFoundError) as e:
        say({"error": "That AI assistant version couldn't be found.", "details": str(e), "kind": "not_found"})
    except HfHubHTTPError as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        msg = "The download stopped. Check your internet connection and try again."
        if status in (403, 451) and not getattr(getattr(e, "response", None), "headers", {}).get("x-error-code"):
            msg = ("huggingface.co refused the download. On a company network, a web filter may be blocking "
                   "huggingface.co: ask IT to allow it.")
        say({"error": net.explain(e, "huggingface.co", proxy) or msg, "details": str(e)})
    except RuntimeError as e:
        say({"error": "The download didn't check out. Try again to fetch the damaged part.", "details": str(e)})
    except Exception as e:  # noqa: BLE001
        msg = net.explain(e, "huggingface.co", proxy)
        if msg is None:
            msg = "The download stopped. Check your internet connection and try again."
            if not proxy and net.auto_proxy():
                msg += net.PAC_HINT
        say({"error": msg, "details": f"{type(e).__name__}: {e}"})
    return 1
