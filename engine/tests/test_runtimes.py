"""The llama.cpp runtime download (plan P2.3): pause and resume, the SHA-256 check, unpacking into
the app's home, and what counts as installed. Served by a local file server, not the real builds."""
import asyncio
import hashlib
import http.server
import io
import random
import json
import tarfile
import threading
import time
import zipfile
from pathlib import Path

import pytest

from breakpatch_engine import config, install, runtimes
from breakpatch_engine.protocol import EngineError

PLATFORM = "linux-x86_64"


def tar_gz(members: dict[str, bytes], links: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, body in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(body), 0o755 if name.endswith("llama-server") else 0o644
            t.addfile(info, io.BytesIO(body))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(name)
            info.type, info.linkname = tarfile.SYMTYPE, target
            t.addfile(info)
    return buf.getvalue()


def build_archive(big=3 * 2**20) -> bytes:
    # Random-ish bytes so gzip can't shrink the "library" to nothing: the download must take a while.
    noise = random.Random(1).randbytes(big)
    return tar_gz({"llama-b9999/bin/llama-server": b"#!/bin/sh\necho fake\n",
                   "llama-b9999/bin/libggml-cpu.so": noise}, {"llama-b9999/bin/libggml.so": "libggml-cpu.so"})


class Files:
    """Serves bytes by path, slowly, with Range support; records the Range headers."""

    def __init__(self, chunk=32 * 1024, delay=0.02):
        self.blobs: dict[str, bytes] = {}
        self.ranges: list[str] = []
        self.chunk, self.delay = chunk, delay
        files = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                body = files.blobs.get(self.path)
                if body is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = 0
                rng = self.headers.get("Range")
                if rng:
                    files.ranges.append(rng)
                    start = int(rng.split("=")[1].split("-")[0])
                part = body[start:]
                self.send_response(206 if rng else 200)
                if rng:
                    self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
                self.send_header("Content-Length", str(len(part)))
                self.end_headers()
                try:
                    for i in range(0, len(part), files.chunk):
                        self.wfile.write(part[i:i + files.chunk])
                        time.sleep(files.delay)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


@pytest.fixture
def served(monkeypatch):
    f = Files()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setattr(runtimes, "platform_id", lambda: PLATFORM)
    yield f
    f.close()


def pin(monkeypatch, served, body: bytes, backend="cpu", sha=None, size=None, exe="llama-b9999/bin/llama-server",
        build="b9999", archive="tar.gz"):
    path = f"/llama-{build}-{backend}.{archive}"
    served.blobs[path] = body
    e = {"build": build, "url": served.url + path, "sha256": sha if sha is not None else hashlib.sha256(body).hexdigest(),
         "size": len(body) if size is None else size, "exe": exe, "archive": archive}
    monkeypatch.setitem(runtimes.RUNTIMES, (PLATFORM, backend), e)
    return e


async def test_install_pause_resume_and_installed(served, monkeypatch):
    body = build_archive()
    pin(monkeypatch, served, body)
    assert runtimes.installed_runtime() == {"installed": False}
    events = []
    setup = install.Setup(events.append)
    task = asyncio.create_task(setup.install_runtime("cpu"))
    for _ in range(200):
        busy = [e for e in events if e["task"] == "runtime" and e["state"] == "busy" and (e.get("doneBytes") or 0) > 128 * 1024]
        if busy:
            break
        await asyncio.sleep(0.05)
    assert busy, events
    assert busy[-1]["totalBytes"] == len(body)
    await setup.pause("runtime")
    with pytest.raises(EngineError) as e:
        await task
    assert e.value.code == "stopped" and events[-1]["state"] == "paused"
    parts = list((config.runtimes_dir() / runtimes.PARTIAL_DIR).glob("*.part"))
    assert parts and 0 < parts[0].stat().st_size < len(body)
    assert runtimes.installed_runtime() == {"installed": False}

    got = await setup.install_runtime("cpu")                    # resumes with a Range request
    assert served.ranges and served.ranges[-1] != "bytes=0-"
    assert events[-1] == {"task": "runtime", "state": "done", "doneBytes": len(body), "totalBytes": len(body),
                          "etaSeconds": 0}
    folder = config.runtimes_dir() / "llamacpp-b9999-cpu"
    assert got == {"path": str(folder), "build": "b9999", "backend": "cpu"}
    exe = folder / "llama-b9999" / "bin" / "llama-server"
    assert exe.read_bytes().startswith(b"#!/bin/sh") and exe.stat().st_mode & 0o100
    assert (folder / "llama-b9999" / "bin" / "libggml.so").is_symlink()     # a link inside the folder is kept
    assert runtimes.installed_runtime() == {"installed": True, "build": "b9999", "backend": "cpu",
                                            "path": str(folder), "exe": str(exe)}
    assert not parts[0].exists()                                 # the archive is gone once unpacked
    assert install.system_info()["llamacpp"]["installed"] is True


async def test_a_damaged_download_is_refused_and_nothing_is_unpacked(served, monkeypatch):
    body = build_archive(big=64 * 1024)
    pin(monkeypatch, served, body, sha=hashlib.sha256(b"something else").hexdigest())
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).install_runtime("cpu")
    assert "didn't check out" in e.value.message
    assert not (config.runtimes_dir() / "llamacpp-b9999-cpu").exists()
    assert not list((config.runtimes_dir() / runtimes.PARTIAL_DIR).glob("*.part"))   # fetched afresh next time


async def test_another_build_isnt_installed_and_is_removed(served, monkeypatch):
    pin(monkeypatch, served, build_archive(big=1024), build="b9998")
    await install.Setup(lambda e: None).install_runtime("cpu")
    old = config.runtimes_dir() / "llamacpp-b9998-cpu"
    assert old.is_dir()
    pin(monkeypatch, served, build_archive(big=1024), build="b9999")
    assert runtimes.installed_runtime() == {"installed": False}           # only the pinned build counts
    await install.Setup(lambda e: None).install_runtime("cpu")
    assert runtimes.installed_runtime()["build"] == "b9999" and not old.exists()


@pytest.mark.parametrize("members,links,why", [
    ({"../evil": b"x", "bin/llama-server": b"x"}, None, "outside"),
    ({"/etc/evil": b"x", "bin/llama-server": b"x"}, None, "outside"),
    ({"bin/llama-server": b"x"}, {"bin/escape": "../../../../etc/passwd"}, ""),
    ({"bin/other": b"x"}, None, "isn't in the archive"),
])
async def test_unsafe_or_wrong_archives_are_refused(served, monkeypatch, members, links, why):
    pin(monkeypatch, served, tar_gz(members, links), exe="bin/llama-server")
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).install_runtime("cpu")
    assert e.value.code == "bad_request" and why in (e.value.details or "")
    assert runtimes.installed_runtime() == {"installed": False}
    assert not any(p.name == "evil" for p in config.app_home().parent.rglob("evil"))


async def test_a_zip_runtime_unpacks_too(served, monkeypatch):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("llama-server.exe", b"MZ")
        z.writestr("ggml.dll", b"MZ")
    pin(monkeypatch, served, buf.getvalue(), exe="llama-server.exe", archive="zip")
    await install.Setup(lambda e: None).install_runtime("cpu")
    assert runtimes.installed_runtime()["exe"].endswith("llama-server.exe")


async def test_what_cant_be_installed_says_so(served, monkeypatch):
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).install_runtime("vulkan")             # a later variant
    assert e.value.code == "not_ready"
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).install_runtime("cuda")
    assert e.value.code == "bad_request"
    monkeypatch.setitem(runtimes.RUNTIMES, (PLATFORM, "cpu"), {**runtimes.RUNTIMES[(PLATFORM, "cpu")], "sha256": ""})
    with pytest.raises(EngineError) as e:                                     # never without a SHA-256
        await install.Setup(lambda e: None).install_runtime("cpu")
    assert e.value.code == "not_ready" and "doesn't have the AI runtime" in e.value.message
    monkeypatch.setattr(runtimes, "platform_id", lambda: "linux-riscv64")
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).install_runtime("cpu")
    assert e.value.code == "not_ready" and "can't run on this computer" in e.value.message


async def test_a_missing_build_is_not_found(served, monkeypatch):
    e = pin(monkeypatch, served, b"x" * 10)
    served.blobs.clear()
    with pytest.raises(EngineError) as err:
        await install.Setup(lambda e: None).install_runtime("cpu")
    assert err.value.code == "not_found" and e["url"]


def test_plain_http_only_to_this_machine_and_never_in_a_release(monkeypatch):
    base = {"build": "b1", "sha256": "a" * 64, "size": 1, "exe": "x", "archive": "tar.gz"}
    monkeypatch.setitem(runtimes.RUNTIMES, (PLATFORM, "cpu"), {**base, "url": "http://example.com/x.tar.gz"})
    with pytest.raises(EngineError) as e:
        runtimes.entry("cpu", PLATFORM)
    assert e.value.code == "bad_request"
    monkeypatch.setitem(runtimes.RUNTIMES, (PLATFORM, "cpu"), {**base, "url": "http://127.0.0.1:1/x.tar.gz"})
    assert runtimes.entry("cpu", PLATFORM)["backend"] == "cpu"
    import sys
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(EngineError):
        runtimes.entry("cpu", PLATFORM)


def test_the_shipped_table_is_marked_todo_until_the_owner_pins_it():
    # TODO(owner): once the builds are mirrored this becomes `release_problems() == []`.
    problems = runtimes.release_problems()
    assert not problems or all("TODO" in p or "build number" in p for p in problems)
    assert runtimes.main(["--check-release"]) == (1 if problems else 0)
    for (platform, backend), e in runtimes.RUNTIMES.items():
        assert platform in ("linux-x86_64", "linux-arm64") and backend in runtimes.BACKENDS
        assert e["exe"] and e["archive"] in ("tar.gz", "zip")


def test_runtime_name_and_platform():
    assert runtimes.runtime_name() in ("mlx", "llamacpp")
    assert runtimes.platform_id().split("-")[0] in ("linux", "macos", "windows")
