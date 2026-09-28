"""Setup: this Mac's details, the pinned Chromium and the AI model (spec §7, §16)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from . import __version__, config, models
from .protocol import EngineError

log = logging.getLogger("breakpatch.setup")

Progress = Callable[[dict], None]
MARKER = ".breakpatch-model.json"


# ---------------------------------------------------------------- this Mac

def memory_gb() -> float:
    try:
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        total = 0
    if sys.platform == "darwin":
        try:
            total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout)
        except Exception:  # noqa: BLE001
            pass
    return round(total / 2**30)


def chip() -> str:
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5)
            if out.stdout.strip():
                return out.stdout.strip()
        except Exception:  # noqa: BLE001
            pass
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def os_name() -> str:
    if sys.platform == "darwin":
        return f"macOS {platform.mac_ver()[0]}".strip()
    return f"{platform.system()} {platform.release()}"


# ---------------------------------------------------------------- browser

def _driver() -> tuple[list[str], dict]:
    from playwright._impl._driver import compute_driver_executable, get_driver_env

    exe = compute_driver_executable()
    cmd = list(exe) if isinstance(exe, (tuple, list)) else [str(exe)]
    env = get_driver_env()
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(config.browsers_dir())
    return cmd, env


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
        self.tasks = {"browser": Task(), "model": Task()}

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
                raise EngineError("network", "The browser couldn't be installed. Check your internet connection and try again.",
                                  "\n".join(tail))
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
            write_marker(dest, repo, m.revision, result.get("commit"), size)
            self.emit({"task": "model", "state": "done", "doneBytes": size, "totalBytes": size, "etaSeconds": 0})
            return {"path": str(dest), "sizeBytes": size}
        finally:
            t.running, t.proc = False, None

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


def write_marker(dest: Path, repo: str, revision: str, commit: str | None, size: int) -> None:
    (dest / MARKER).write_text(json.dumps({"repo": repo, "revision": revision, "commit": commit,
                                           "sizeBytes": size, "installedAt": time.time()}))


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
            "sizeBytes": info.get("sizeBytes"), "path": str(d)}


def system_info() -> dict:
    from . import plugins, systems
    return {"memoryGb": memory_gb(), "chip": chip(), "os": os_name(), "engineVersion": __version__,
            "edition": plugins.edition(), "licence": plugins.licence_status(), "browser": browser_status(),
            "model": installed_model(), "system": systems.current()}


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
        from huggingface_hub import HfApi, hf_hub_url
        from huggingface_hub.utils import (HfHubHTTPError, RepositoryNotFoundError, RevisionNotFoundError,
                                           build_hf_headers, hf_raise_for_status, http_stream_backoff)
    except Exception as e:  # noqa: BLE001
        say({"error": "The downloader is missing from this build.", "details": str(e), "kind": "internal"})
        return 1

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
        say({"total": total, "commit": commit})
        for name, size, sha in wanted:
            fetch(name, size, sha, commit)
        say({"verifying": True})
        if allow:
            for name, sha in allow.items():
                if models.sha256_of(root / name) != sha:
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
        say({"error": "The download stopped. Check your internet connection and try again.", "details": str(e)})
    except RuntimeError as e:
        say({"error": "The download didn't check out. Try again to fetch the damaged part.", "details": str(e)})
    except Exception as e:  # noqa: BLE001
        say({"error": "The download stopped. Check your internet connection and try again.",
             "details": f"{type(e).__name__}: {e}"})
    return 1
