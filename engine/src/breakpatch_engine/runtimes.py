"""The llama.cpp runtime: the `llama-server` build the engine downloads off the Mac (plan §2.3
item 3, P2.3).

A runtime is native code, so it gets the same care as a model and more: the engine only installs a
build that's in `RUNTIMES`, for this platform, from its URL, checked against the SHA-256 shipped
here. There's no development exception: an entry without a SHA-256 can't be installed at all.

- Unpacked into `<app home>/runtimes/llamacpp-<build>-<backend>/` (`config.runtimes_dir()`), with
  a marker file. Only the pinned build counts as installed: another build's folder (an older
  release's) is ignored, and removed once the pinned one is in.
- The download is resumable and pausable like the model's: a child process (`_runtime_download`)
  writes `<runtimes>/.partial/<archive>.part` and continues it with an HTTP Range request; a pause
  stops the child. The archive is checked against its SHA-256 before anything is unpacked.
- Archives are `.tar.gz` (Linux) or `.zip` (Windows, later). Members must stay inside the folder:
  no absolute paths, no `..`, no links that point outside, no device files (tarfile's `data`
  filter); set-uid bits are dropped.

`python -m breakpatch_engine.runtimes --check-release` exits 1 while an available entry has a
placeholder URL or no SHA-256. TODO(owner): build or mirror the binaries (plan §2.3: our own Linux
builds in the manylinux_2_28 container with GGML_BACKEND_DL=ON GGML_CPU_ALL_VARIANTS=ON) and fill
in BUILD, each `url`, `sha256` and `size`, then check `LlamaServer.command`'s flags against that
build's `llama-server --help`.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import sys
import tarfile
import time
import zipfile
from pathlib import Path, PurePosixPath

from . import config, net, systems
from .protocol import EngineError

log = logging.getLogger("breakpatch.runtimes")

# TODO(owner): the llama.cpp build to pin (after Qwen3-VL support landed, late 2025), as "b<number>".
BUILD = "b0000"
_TODO_URL = "https://runtimes.invalid/TODO-owner/llama.cpp/{build}/llama-{build}-bin-{platform}-{backend}.tar.gz"


def _todo(platform: str, backend: str) -> str:
    return _TODO_URL.format(build=BUILD, platform=platform, backend=backend)


# (platform, backend) -> where the archive is, its SHA-256 and size, and llama-server's path in it.
# `later: True` entries are listed so the shape is known, but can't be installed yet.
RUNTIMES: dict[tuple[str, str], dict] = {
    ("linux-x86_64", "cpu"): {
        "build": BUILD, "url": _todo("linux-x86_64", "cpu"),     # TODO(owner): the mirrored build
        "sha256": "", "size": 0,                                   # TODO(owner)
        "exe": "bin/llama-server", "archive": "tar.gz"},
    ("linux-arm64", "cpu"): {
        "build": BUILD, "url": _todo("linux-arm64", "cpu"),      # TODO(owner): the mirrored build
        "sha256": "", "size": 0,                                   # TODO(owner)
        "exe": "bin/llama-server", "archive": "tar.gz"},
    # Vulkan (AMD, Intel and, on Linux, NVIDIA GPUs): a later variant (plan §2.2, P2.5).
    ("linux-x86_64", "vulkan"): {
        "build": BUILD, "url": _todo("linux-x86_64", "vulkan"), "sha256": "", "size": 0,
        "exe": "bin/llama-server", "archive": "tar.gz", "later": True},
}
BACKENDS = ("cpu", "vulkan")
MARKER = ".breakpatch-runtime.json"
PARTIAL_DIR = ".partial"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def runtime_name() -> str:
    """Which AI runtime this machine uses: "mlx" on Apple Silicon, "llamacpp" everywhere else."""
    return "mlx" if sys.platform == "darwin" and systems.arch() == "arm64" else "llamacpp"


def platform_id() -> str:
    """"linux-x86_64", "linux-arm64", "windows-x86_64", "macos-arm64": the locks' names."""
    os_part = {"Linux": "linux", "Windows": "windows", "macOS": "macos"}.get(systems.os_family(), sys.platform)
    return f"{os_part}-{systems.arch()}"


def pinned(e: dict) -> bool:
    return bool(SHA256.match(e.get("sha256") or "")) and str(e.get("url") or "").startswith("https://") \
        and ".invalid/" not in str(e.get("url"))


def entry(backend: str = "cpu", platform: str | None = None) -> dict:
    """This platform's runtime for `backend`, or a plain error when there's none to install."""
    if backend not in BACKENDS:
        raise EngineError("bad_request", "The engine doesn't know that kind of AI runtime.", repr(backend)[:40])
    platform = platform or platform_id()
    e = RUNTIMES.get((platform, backend))
    if e is None or e.get("later"):
        raise EngineError("not_ready", "The AI assistant can't run on this computer yet.",
                          f"no llama.cpp {backend} runtime for {platform}")
    if not SHA256.match(e.get("sha256") or ""):
        raise EngineError("not_ready", "This build of Breakpatch doesn't have the AI runtime for this computer yet.",
                          f"runtimes.py: {platform} {backend} has no SHA-256 (TODO)")
    url = str(e.get("url") or "")
    if not url.startswith("https://") and not (not config.is_release() and _loopback_http(url)):
        raise EngineError("bad_request", "The AI runtime's address isn't one Breakpatch downloads from.", url[:120])
    return {**e, "platform": platform, "backend": backend}


def _loopback_http(url: str) -> bool:
    from urllib.parse import urlsplit
    u = urlsplit(url)
    return u.scheme == "http" and (u.hostname or "") in ("127.0.0.1", "localhost", "::1")


def runtime_dir(e: dict) -> Path:
    return config.runtimes_dir() / f"llamacpp-{e['build']}-{e['backend']}"


def installed_runtime(backend: str | None = None, platform: str | None = None) -> dict:
    """The pinned runtime, if it's installed: `{installed, build, backend, path, exe}`. With no
    `backend`, the GPU one when it's there, else the CPU one."""
    platform = platform or platform_id()
    for b in ((backend,) if backend else ("vulkan", "cpu")):
        e = RUNTIMES.get((platform, b))
        if e is None or e.get("later"):
            continue
        d = runtime_dir({**e, "backend": b})
        try:
            info = json.loads((d / MARKER).read_text())
        except (OSError, ValueError):
            continue
        if info.get("build") != e["build"] or info.get("sha256") != e.get("sha256") or info.get("backend") != b:
            continue
        exe = d / check_member(e["exe"])
        if exe.is_file():
            return {"installed": True, "build": e["build"], "backend": b, "path": str(d), "exe": str(exe)}
    return {"installed": False}


def release_problems() -> list[str]:
    out = []
    for (platform, backend), e in RUNTIMES.items():
        if e.get("later"):
            continue
        if not pinned(e):
            out.append(f"{platform} {backend}: no real URL and SHA-256 yet (TODO in runtimes.py)")
        if not re.fullmatch(r"b\d+", str(e.get("build"))) or e.get("build") == "b0000":
            out.append(f"{platform} {backend}: build {e.get('build')!r} isn't a llama.cpp build number")
    return out


# ---------------------------------------------------------------- unpacking

class Refused(Exception):
    """An archive member that would land outside the runtime's folder, or isn't a plain file."""


def check_member(name: str) -> str:
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        raise Refused(f"unusable name {name!r}")
    p = PurePosixPath(name)
    if p.is_absolute() or re.match(r"^[A-Za-z]:", name) or any(part == ".." for part in p.parts):
        raise Refused(f"outside the runtime folder: {name!r}")
    return name


def unpack(archive: Path, dest: Path, kind: str) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if kind == "tar.gz":
        with tarfile.open(archive, "r:gz") as t:
            for m in t.getmembers():
                check_member(m.name)
                if not (m.isfile() or m.isdir() or m.issym() or m.islnk()):
                    raise Refused(f"not a plain file: {m.name}")
            try:
                t.extractall(dest, filter="data")     # also refuses links that point outside
            except tarfile.FilterError as e:
                raise Refused(str(e)) from None
    elif kind == "zip":
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                check_member(info.filename)
                mode = (info.external_attr >> 16) & 0o170000
                if mode and mode not in (stat.S_IFREG, stat.S_IFDIR):
                    raise Refused(f"not a plain file: {info.filename}")
            z.extractall(dest)
    else:
        raise Refused(f"unknown archive kind {kind!r}")


# ---------------------------------------------------------------- download child process

def download_main(spec: str) -> int:
    """Runs in a child process (`_runtime_download`), so a pause can simply stop it. `spec` is the
    entry as JSON (url, sha256, size, exe, archive, build, backend, platform). Prints JSON lines:
    {"total"}, {"verifying"}, {"done", "path"} or {"error", "details", "kind"}."""
    import urllib.error
    import urllib.request

    from .models import sha256_of

    def say(obj: dict) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    try:
        e = json.loads(spec)
        url, want, size = str(e["url"]), str(e["sha256"]), int(e.get("size") or 0)
        if not SHA256.match(want):
            raise ValueError("no SHA-256")
    except (ValueError, KeyError, TypeError) as err:
        say({"error": "The engine couldn't read the AI runtime's details.", "details": str(err), "kind": "internal"})
        return 1
    root = config.runtimes_dir()
    final = runtime_dir(e)
    part = root / PARTIAL_DIR / f"llamacpp-{e['build']}-{e.get('platform')}-{e['backend']}.{e.get('archive') or 'tar.gz'}.part"
    proxy = net.proxy_for(url)
    try:
        part.parent.mkdir(parents=True, exist_ok=True)
        say({"total": size or None})
        have = part.stat().st_size if part.is_file() else 0
        if size and have > size:
            part.unlink()
            have = 0
        if not size or have < size:
            handlers = [urllib.request.ProxyHandler({"https": proxy, "http": proxy} if proxy else {})]
            if url.startswith("https://"):
                handlers.append(urllib.request.HTTPSHandler(context=net.ssl_context()))
            opener = urllib.request.build_opener(*handlers)
            req = urllib.request.Request(url, headers={"User-Agent": "Breakpatch",
                                                       **({"Range": f"bytes={have}-"} if have else {})})
            with opener.open(req, timeout=60) as r:
                mode = "ab" if have and r.status == 206 else "wb"     # the server ignored the Range: start over
                with open(part, mode) as f:
                    while True:
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
        say({"verifying": True})
        got = part.stat().st_size
        if size and got != size:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"size mismatch: {got} != {size}")
        if sha256_of(part) != want:
            part.unlink(missing_ok=True)
            raise RuntimeError("checksum mismatch")
        tmp = final.with_name(final.name + f".unpacking-{os.getpid()}")
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            unpack(part, tmp, str(e.get("archive") or "tar.gz"))
            exe = tmp / check_member(str(e["exe"]))
            if not exe.is_file():
                raise Refused(f"{e['exe']} isn't in the archive")
            exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
            (tmp / MARKER).write_text(json.dumps({
                "build": e["build"], "backend": e["backend"], "platform": e.get("platform"), "sha256": want,
                "url": url, "exe": e["exe"], "installedAt": time.time()}))
            shutil.rmtree(final, ignore_errors=True)
            os.replace(tmp, final)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        part.unlink(missing_ok=True)
        # Other builds of this backend (an older release's) are no longer used.
        for d in root.glob(f"llamacpp-*-{e['backend']}"):
            if d != final and (d / MARKER).is_file():
                shutil.rmtree(d, ignore_errors=True)
        say({"done": str(final)})
        return 0
    except Refused as err:
        say({"error": "The AI runtime's archive has files Breakpatch won't use, so it wasn't installed.",
             "details": str(err), "kind": "bad_request"})
    except RuntimeError as err:
        say({"error": "The download didn't check out. Try again to fetch it again.", "details": str(err)})
    except urllib.error.HTTPError as err:
        kind = "not_found" if err.code == 404 else "network"
        say({"error": "The AI runtime couldn't be found." if err.code == 404 else
             "The download stopped. Check your internet connection and try again.", "details": str(err), "kind": kind})
    except (tarfile.TarError, zipfile.BadZipFile, EOFError) as err:
        say({"error": "The AI runtime's archive couldn't be opened.", "details": str(err), "kind": "bad_request"})
    except Exception as err:  # noqa: BLE001
        from urllib.parse import urlsplit
        msg = net.explain(err, urlsplit(url).hostname, proxy) or \
            "The download stopped. Check your internet connection and try again."
        say({"error": msg, "details": f"{type(err).__name__}: {err}"})
    return 1


def main(argv: list[str]) -> int:
    if argv[:1] == ["--check-release"]:
        problems = release_problems()
        for p in problems:
            print(f"runtimes: {p}", file=sys.stderr)
        return 1 if problems else 0
    print("usage: python -m breakpatch_engine.runtimes --check-release", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
