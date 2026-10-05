"""The AI assistant on llama.cpp, off the Mac (plan §2.3, P2.2).

`LlamaServer` runs `llama-server` (llama.cpp's own HTTP server, from the runtime runtimes.py
installs) as a child process, and `LlamaCppLocator` asks it through its OpenAI-compatible
`POST /v1/chat/completions`, with the screenshot as a base64 `data:` URL. No Python bindings and
no new dependency: the stdlib's `http.client`, as the Team engine uses.

The server:

- starts on first use, on 127.0.0.1 and a free port, with the flags in `LlamaServer.command`
  (pinned with the runtime's build: check them against `llama-server --help` when the build moves);
- needs an API key, new at every start, because loopback isn't private on a shared machine: any
  local user could otherwise use it. The key goes in a 0600 file in a 0700 folder
  (`--api-key-file`), never on the command line, which every user can read (`ps`), and the file is
  deleted as soon as the server is ready (it reads it once, at start);
- is ready when `GET /health` says 200 (it says 503 while the model loads);
- gets only the environment it needs (`ENV_KEEP`): never the engine's secrets (`BP_SECRET_*`);
- dies with the engine: stopped on engine shutdown, at exit, and on Linux by the kernel when the
  engine goes (`PR_SET_PDEATHSIG`); on Windows the shell's Job Object takes it;
- stops after `idle_stop_s` without a request (10 minutes), which frees 3–5 GB, and starts again
  when it's next needed;
- is started again once when it stops by itself (a crash), and the request is asked again; if it
  stops again, the request fails with `not_ready`. After `MAX_CRASHES` crashes within
  `CRASH_WINDOW_S` it isn't started again until the engine restarts.

A reply that can't be read (not JSON, no `choices`, an HTTP error) is an empty answer, so the
locator's parsers return None, as for a garbled model reply on the Mac. A reply that takes longer
than the timeout (30 s on a GPU, 180 s on a CPU) fails with `not_ready`.
"""
from __future__ import annotations

import atexit
import base64
import http.client
import io
import json
import logging
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable, Sequence

from PIL import Image

from .locator import VisionLocator
from .protocol import EngineError

log = logging.getLogger("breakpatch.llamacpp")

CONTEXT = 4096              # tokens: a 1280 x 800 screenshot is about 1,000 of them (plan §2.1)
MAX_TOKENS = 96             # as MlxLocator and tools/model-test
SEED = 7                    # tools/model-test's SEED, so its runs and the engine's ask the same
IDLE_STOP_S = 600.0         # stop the server after this long without a request
START_TIMEOUT_S = 300.0     # loading 3 GB from a slow disk; a Raspberry Pi takes a while
TIMEOUT_GPU_S = 30.0        # per answer (plan §2.3, est.)
TIMEOUT_CPU_S = 180.0
HEALTH_POLL_S = 0.2
MAX_CRASHES = 3
CRASH_WINDOW_S = 600.0
LOG_LINES = 40              # the end of the server's output kept for the error's details

# The only variables llama-server is given (by name or prefix). Not the engine's secrets, licence
# key or proxy settings: it talks to nobody but the engine.
ENV_KEEP = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
            "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "LOCALAPPDATA", "APPDATA",
            "PROGRAMDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "XDG_RUNTIME_DIR",
            "DISPLAY", "WAYLAND_DISPLAY", "CUDA_VISIBLE_DEVICES")
ENV_KEEP_PREFIXES = ("VK_", "GGML_", "LLAMA_ARG_")


def physical_cores() -> int | None:
    """Physical cores this process may use (llama.cpp runs best with one thread per core), or None
    to let llama-server choose. Linux: the distinct (physical id, core id) pairs in /proc/cpuinfo,
    at most the CPUs this process is allowed (a container's limit)."""
    try:
        allowed = len(os.sched_getaffinity(0))      # type: ignore[attr-defined]
    except (AttributeError, OSError):
        allowed = os.cpu_count() or 0
    cores = 0
    if sys.platform.startswith("linux"):
        try:
            pairs, phys, core = set(), None, None
            for line in Path("/proc/cpuinfo").read_text(errors="replace").splitlines():
                k, _, v = line.partition(":")
                k = k.strip()
                if k == "physical id":
                    phys = v.strip()
                elif k == "core id":
                    core = v.strip()
                elif not line.strip():
                    if core is not None:
                        pairs.add((phys, core))
                    phys = core = None
            if core is not None:
                pairs.add((phys, core))
            cores = len(pairs)
        except OSError:
            cores = 0
    if not cores:                                   # no core ids (most arm64 kernels): one per CPU
        cores = allowed
    if allowed:
        cores = min(cores, allowed)
    return cores or None


def child_env(exe_dir: Path | None, base=None) -> dict:
    """llama-server's environment: the variables in ENV_KEEP, and its own folder on the library
    path (the build's shared libraries sit next to it)."""
    base = os.environ if base is None else base
    env = {k: v for k, v in base.items() if k in ENV_KEEP or k.startswith(ENV_KEEP_PREFIXES)}
    if exe_dir is not None:
        var = {"win32": "PATH", "darwin": "DYLD_LIBRARY_PATH"}.get(sys.platform, "LD_LIBRARY_PATH")
        old = base.get(var)
        env[var] = os.pathsep.join([str(exe_dir)] + ([old] if old else []))
    return env


def _die_with_parent() -> Callable[[], None] | None:
    """Linux: a preexec_fn that makes the kernel send llama-server SIGTERM when the engine dies."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes
        prctl = ctypes.CDLL(None, use_errno=True).prctl     # looked up before the fork
    except (OSError, AttributeError):
        return None
    pr_set_pdeathsig = 1

    def run() -> None:
        prctl(pr_set_pdeathsig, int(signal.SIGTERM), 0, 0, 0)
    return run


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaServer:
    """One `llama-server` child process for one model (see the module's docstring)."""

    def __init__(self, exe: str | Path | Sequence[str], model: Path, mmproj: Path, *, gpu_layers: int = 0,
                 threads: int | None = None, context: int = CONTEXT, image_max_tokens: int | None = None,
                 idle_stop_s: float = IDLE_STOP_S, start_timeout_s: float = START_TIMEOUT_S,
                 before_start: Callable[[], None] | None = None, clock: Callable[[], float] = time.monotonic):
        # `exe` may be a command prefix ([python, fake_server.py] in tests).
        self.launcher = [str(exe)] if isinstance(exe, (str, Path)) else [str(x) for x in exe]
        self.model, self.mmproj = Path(model), Path(mmproj)
        self.gpu_layers, self.threads, self.context = int(gpu_layers), threads, int(context)
        self.image_max_tokens = image_max_tokens
        self.idle_stop_s, self.start_timeout_s = float(idle_stop_s), float(start_timeout_s)
        self.before_start = before_start
        self.clock = clock
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.api_key: str | None = None
        self._key_dir: Path | None = None
        self._tail: deque[str] = deque(maxlen=LOG_LINES)
        self._drainer: threading.Thread | None = None
        self._lock = threading.RLock()
        self._busy = 0
        self._last_used = clock()
        self._crashes: list[float] = []
        self._idle_stop = threading.Event()
        self._idle_thread: threading.Thread | None = None
        self.starts = 0
        self.load_seconds: float | None = None
        self._atexit = False

    # ------------------------------------------------------------ the process

    def command(self, port: int, key_file: Path) -> list[str]:
        """The pinned command line (plan §2.3). `--api-key-file` rather than `--api-key`: the key
        mustn't show in `ps`."""
        cmd = self.launcher + [
            "-m", str(self.model), "--mmproj", str(self.mmproj),
            "--host", "127.0.0.1", "--port", str(port), "--api-key-file", str(key_file),
            "-c", str(self.context), "--parallel", "1", "-ngl", str(self.gpu_layers),
            "--jinja", "--no-webui"]
        if self.threads:
            cmd += ["--threads", str(self.threads)]
        if self.image_max_tokens:
            cmd += ["--image-max-tokens", str(self.image_max_tokens)]
        return cmd

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def exe_dir(self) -> Path | None:
        parent = Path(self.launcher[0]).parent
        return parent if str(parent) not in ("", ".") else None

    def ensure(self) -> None:
        """Starts the server unless it's running. A server that stopped by itself counts as a crash."""
        with self._lock:
            if self.running:
                return
            if self.proc is not None:
                self._crashed(f"llama-server stopped by itself (exit {self.proc.returncode})")
            self.start()

    def _crashed(self, why: str) -> None:
        log.warning("%s; last output:\n%s", why, self.tail())
        self._cleanup()
        now = self.clock()
        self._crashes = [t for t in self._crashes if now - t < CRASH_WINDOW_S] + [now]

    def start(self) -> None:
        with self._lock:
            if self.running:
                return
            if len([t for t in self._crashes if self.clock() - t < CRASH_WINDOW_S]) >= MAX_CRASHES:
                raise EngineError("not_ready", "The AI assistant keeps stopping on this computer. Restart Breakpatch "
                                  "to try again.", self.tail())
            if self.before_start is not None:
                self.before_start()                   # the model's files are checked at every start
            for attempt in range(2):                  # once more on another port if this one was taken
                try:
                    self._start_once()
                    return
                except _PortTaken:
                    if attempt:
                        raise EngineError("not_ready", "The AI assistant couldn't start on this computer.",
                                          self.tail()) from None

    def _start_once(self) -> None:
        self._cleanup()
        self._key_dir = Path(tempfile.mkdtemp(prefix="bp-llama-"))
        os.chmod(self._key_dir, 0o700)
        key_file = self._key_dir / "key"
        self.api_key = secrets.token_urlsafe(32)
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(self.api_key)
        self.port = free_port()
        cmd = self.command(self.port, key_file)
        self._tail.clear()
        log.info("starting llama-server: %s", " ".join(cmd))
        kwargs: dict = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["preexec_fn"] = _die_with_parent()
        started = self.clock()
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, env=child_env(self.exe_dir), **kwargs)
        self.starts += 1
        self._drainer = threading.Thread(target=self._drain, args=(self.proc,), name="llama-server-log", daemon=True)
        self._drainer.start()
        if not self._atexit:
            atexit.register(self.stop)
            self._atexit = True
        while True:
            code = self.proc.poll()
            if code is not None:
                self._drainer.join(2)               # its last words, for the details
                tail = self.tail()
                self._cleanup()
                if "address already in use" in tail.lower() or "couldn't bind" in tail.lower():
                    raise _PortTaken()
                raise EngineError("not_ready", "The AI assistant couldn't start on this computer.",
                                  f"llama-server exited with {code}:\n{tail}")
            status, _ = self._get("/health", 5.0)
            if status == 200:
                break
            if self.clock() - started > self.start_timeout_s:
                tail = self.tail()
                self.stop()
                raise EngineError("not_ready", "The AI assistant took too long to start on this computer.",
                                  f"no answer from /health within {self.start_timeout_s:.0f} s:\n{tail}")
            time.sleep(HEALTH_POLL_S)
        self._remove_key_file()
        self.load_seconds = round(self.clock() - started, 2)
        self._last_used = self.clock()
        log.info("llama-server ready on port %s after %.1f s", self.port, self.load_seconds)
        self._watch_idle()

    def _drain(self, proc: subprocess.Popen) -> None:
        try:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode(errors="replace").rstrip()
                if line:
                    self._tail.append(line)
                    log.debug("llama-server: %s", line)
        except (OSError, ValueError):            # closed by stop()
            pass

    def tail(self) -> str:
        return "\n".join(self._tail)

    def _remove_key_file(self) -> None:
        if self._key_dir is not None:
            shutil.rmtree(self._key_dir, ignore_errors=True)
            self._key_dir = None

    def _cleanup(self) -> None:
        """Forgets a process that has exited (and its key file)."""
        self._remove_key_file()
        if self.proc is not None and self.proc.poll() is not None:
            if self.proc.stdout is not None:
                try:
                    self.proc.stdout.close()
                except OSError:
                    pass
            self.proc = None

    def stop(self, why: str = "") -> None:
        with self._lock:
            proc, self.proc = self.proc, None
            self._idle_stop.set()
            if proc is not None and proc.poll() is None:
                log.info("stopping llama-server%s", f" ({why})" if why else "")
                try:
                    proc.terminate()
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    try:
                        proc.wait(5)
                    except subprocess.TimeoutExpired:
                        pass
                except OSError:
                    pass
            if proc is not None and proc.stdout is not None:
                try:
                    proc.stdout.close()
                except OSError:
                    pass
            self._cleanup()

    # ------------------------------------------------------------ idle stop

    def _watch_idle(self) -> None:
        if self.idle_stop_s <= 0:
            return
        self._idle_stop = threading.Event()
        stop_event, proc = self._idle_stop, self.proc

        def watch() -> None:
            step = max(0.05, min(30.0, self.idle_stop_s / 4))
            while not stop_event.wait(step):
                with self._lock:
                    if self.proc is not proc:
                        return
                    if self._busy == 0 and self.clock() - self._last_used >= self.idle_stop_s:
                        self.stop(f"idle for {self.idle_stop_s:.0f} s")
                        return
        self._idle_thread = threading.Thread(target=watch, name="llama-server-idle", daemon=True)
        self._idle_thread.start()

    # ------------------------------------------------------------ HTTP

    def _connection(self, timeout: float) -> http.client.HTTPConnection:
        # Loopback, straight to the server: http.client never goes through a proxy.
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)

    def _get(self, path: str, timeout: float) -> tuple[int | None, bytes]:
        try:
            c = self._connection(timeout)
            try:
                c.request("GET", path, headers={"Authorization": f"Bearer {self.api_key}"})
                r = c.getresponse()
                return r.status, r.read()
            finally:
                c.close()
        except (OSError, http.client.HTTPException):
            return None, b""

    def _post(self, path: str, body: dict, timeout: float) -> tuple[int, bytes]:
        c = self._connection(timeout)
        try:
            c.request("POST", path, body=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            c.close()

    def chat(self, body: dict, timeout: float) -> dict:
        """`POST /v1/chat/completions`: the reply as JSON, or {} when it can't be read. Starts the
        server if needed; a server that stops during the request is started again once."""
        with self._lock:
            self._busy += 1
        try:
            for attempt in range(2):
                self.ensure()
                try:
                    status, raw = self._post("/v1/chat/completions", body, timeout)
                except (socket.timeout, TimeoutError):
                    if self._get("/health", 5.0)[0] != 200:      # stuck, not just slow: start afresh next time
                        self.stop("no answer")
                    raise EngineError("not_ready", f"The AI assistant didn't answer within {timeout:.0f} seconds.",
                                      f"llama-server: no reply to /v1/chat/completions in {timeout:.0f} s") from None
                except (OSError, http.client.HTTPException) as e:
                    proc = self.proc
                    if proc is not None:
                        try:
                            proc.wait(2)                 # a crash: the process is going, or gone
                        except subprocess.TimeoutExpired:
                            pass
                    if self.running:
                        raise EngineError("not_ready", "The AI assistant couldn't be reached.",
                                          f"{type(e).__name__}: {e}") from None
                    with self._lock:
                        self._crashed(f"llama-server stopped during a request ({type(e).__name__})")
                    if attempt:
                        raise EngineError("not_ready", "The AI assistant stopped working. Try again, or restart "
                                          "Breakpatch.", self.tail()) from None
                    continue
                finally:
                    self._last_used = self.clock()
                if status != 200:
                    log.warning("llama-server answered %s: %s", status, raw[:300].decode(errors="replace"))
                    return {}
                try:
                    doc = json.loads(raw)
                except ValueError:
                    log.warning("llama-server's reply isn't JSON: %r", raw[:200])
                    return {}
                return doc if isinstance(doc, dict) else {}
            return {}
        finally:
            with self._lock:
                self._busy -= 1
                self._last_used = self.clock()


class _PortTaken(Exception):
    pass


# ---------------------------------------------------------------- the request

def image_data_url(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def request_body(image: Image.Image, prompt: str, max_tokens: int = MAX_TOKENS) -> dict:
    """The chat request: the screenshot, then the prompt, at temperature 0 and a fixed seed, the
    same as tools/model-test's OpenAIRuntime sends (a test checks)."""
    return {"messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_data_url(image)}},
                {"type": "text", "text": prompt}]}],
            "temperature": 0, "max_tokens": max_tokens, "seed": SEED, "stream": False}


def reply_text(doc: dict) -> tuple[str, dict]:
    """The answer's text ("" when there's none) and the server's `timings`."""
    try:
        text = doc["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        text = ""
    if not isinstance(text, str):
        text = ""
    t = doc.get("timings") if isinstance(doc.get("timings"), dict) else {}
    keep = {k: t[k] for k in ("prompt_n", "prompt_ms", "predicted_n", "predicted_ms")
            if isinstance(t.get(k), (int, float))}
    return text, keep


# ---------------------------------------------------------------- the locator

class LlamaCppLocator(VisionLocator):
    """Qwen3-VL GGUF through llama-server. `runtime` is runtimes.installed_runtime()'s answer
    (`exe`, `backend`); the model folder holds the two files models.gguf_files names."""

    def __init__(self, model_path: Path, runtime: dict, *, repo: str | None = None, max_tokens: int = MAX_TOKENS,
                 timeout_s: float | None = None, server: LlamaServer | None = None, **server_kw):
        from . import models
        self.model_path = Path(model_path)
        self.runtime = dict(runtime)
        self.max_tokens = max_tokens
        self.backend = str(runtime.get("backend") or "cpu")
        self.timeout_s = timeout_s if timeout_s is not None else (TIMEOUT_CPU_S if self.backend == "cpu" else TIMEOUT_GPU_S)
        self.repo = repo
        names = models.gguf_files(repo) if repo else None
        self.model_file, self.mmproj_file = names or (None, None)
        self.last_timings: dict = {}
        self._lock = threading.Lock()
        if server is None and self.model_file and runtime.get("exe"):
            server_kw.setdefault("gpu_layers", 0 if self.backend == "cpu" else 99)
            server_kw.setdefault("threads", physical_cores())
            server = LlamaServer(runtime["exe"], self.model_path / self.model_file, self.model_path / self.mmproj_file,
                                 before_start=self._check, **server_kw)
        self.server = server

    def available(self) -> bool:
        exe = self.runtime.get("exe")
        return (self.server is not None and bool(exe) and Path(exe).is_file() and self.model_file is not None
                and (self.model_path / self.model_file).is_file() and (self.model_path / self.mmproj_file).is_file())

    def _check(self) -> None:
        from . import models
        try:
            models.check_model_dir(self.model_path)       # again at every start, as MlxLocator._load
        except models.Refused as e:
            raise EngineError("not_ready", "The AI assistant's files didn't check out. Remove it in Settings, "
                              "AI assistant, and download it again.", str(e)) from None

    def _need_server(self) -> LlamaServer:
        if self.server is None:
            raise EngineError("not_ready", "The AI assistant isn't set up on this computer yet. Finish setup to use it.")
        return self.server

    def warm(self) -> float | None:
        """Starts the server (loads the model) now; the seconds it took, or None if it was running."""
        server = self._need_server()
        if server.running:
            return None
        server.ensure()
        return server.load_seconds

    def _generate(self, image: Image.Image, prompt: str) -> str:
        server = self._need_server()
        with self._lock:
            doc = server.chat(request_body(image, prompt, self.max_tokens), self.timeout_s)
        text, timings = reply_text(doc)
        self.last_timings = timings
        log.info("model reply (prompt %s tokens in %s ms, %s tokens in %s ms): %s", timings.get("prompt_n"),
                 timings.get("prompt_ms"), timings.get("predicted_n"), timings.get("predicted_ms"), text[:300])
        return text

    def close(self) -> None:
        if self.server is not None:
            self.server.stop("engine shutdown")
