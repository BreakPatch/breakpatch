"""LlamaServer and LlamaCppLocator against a fake llama-server (tests/fake_llama_server.py): the
command line and request shape, timeouts, garbled replies, a crash and the restart after it, and
the idle stop (plan P2.2). No model and no llama.cpp build are needed."""
import base64
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

import pytest
from PIL import Image

from breakpatch_engine import llamacpp, models
from breakpatch_engine.llamacpp import LlamaCppLocator, LlamaServer
from breakpatch_engine.protocol import EngineError

FAKE = Path(__file__).with_name("fake_llama_server.py")
LOCATE = ('Find "the \'Next\' button" in this screenshot of a web app. Reply with JSON only, no other text: '
          '{"bbox_2d": [x1, y1, x2, y2]}. If it isn\'t in the screenshot, reply {"bbox_2d": null}.')


class Files:
    """The fake server's model file and the files it reads and writes next to it."""

    def __init__(self, folder: Path):
        self.model = folder / "model.gguf"
        self.mmproj = folder / "mmproj.gguf"
        for p in (self.model, self.mmproj):
            p.write_bytes(b"GGUF")

    def set(self, **conf):
        self.model.with_suffix(".fake.json").write_text(json.dumps(conf))

    def lines(self, suffix):
        try:
            return [json.loads(x) for x in self.model.with_suffix(suffix).read_text().splitlines()]
        except OSError:
            return []

    @property
    def starts(self):
        return self.lines(".starts.jsonl")

    @property
    def requests(self):
        return self.lines(".requests.jsonl")


@pytest.fixture
def files(tmp_path):
    return Files(tmp_path)


@pytest.fixture
def make(files):
    made = []

    def make(**kw):
        kw.setdefault("start_timeout_s", 20)
        s = LlamaServer([sys.executable, str(FAKE)], files.model, files.mmproj, **kw)
        made.append(s)
        return s
    yield make
    for s in made:
        s.stop()


def body(text="hi"):
    return llamacpp.request_body(Image.new("RGB", (64, 40), "white"), text)


def gone(pid, wait=5.0):
    end = time.monotonic() + wait
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except OSError:
            return True
        try:                                   # reaped already, or a zombie of ours
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                return True
        except ChildProcessError:
            return True
        time.sleep(0.05)
    return False


def test_the_pinned_command_line_and_a_private_key(make, files, monkeypatch):
    monkeypatch.setenv("BP_SECRET_PASSWORD", "hunter2")
    monkeypatch.setenv("BREAKPATCH_LICENCE_KEY", "key")
    s = make(threads=6, gpu_layers=0)
    s.ensure()
    start = files.starts[0]
    a = start["argv"]                          # the fake's own arguments, after its script
    assert a[:4] == ["-m", str(files.model), "--mmproj", str(files.mmproj)]

    def val(name):
        return a[a.index(name) + 1]
    assert val("--host") == "127.0.0.1" and int(val("--port")) == s.port
    assert val("-c") == "4096" and val("--parallel") == "1" and val("-ngl") == "0" and val("--threads") == "6"
    assert "--jinja" in a and "--no-webui" in a and "--image-max-tokens" not in a
    # The key is in a 0600 file, never on the command line.
    assert "--api-key" not in a and s.api_key not in " ".join(a)
    assert start["keyMode"] == 0o600
    assert start["key"] == s.api_key            # what the server read from the file at start
    assert not Path(val("--api-key-file")).exists()   # gone once the server was ready
    # Only the variables it needs: no secrets.
    assert not [k for k in start["env"] if k.startswith(("BP_SECRET", "BREAKPATCH_", "HTTPS_PROXY", "HTTP_PROXY"))]


def test_a_new_key_at_every_start(make, files):
    s = make()
    s.ensure()
    first = s.api_key
    s.stop()
    s.ensure()
    assert s.api_key != first and len(files.starts) == 2


def test_the_child_environment_keeps_only_what_it_needs(tmp_path):
    env = llamacpp.child_env(tmp_path, {"PATH": "/bin", "HOME": "/h", "BP_SECRET_PASSWORD": "x",
                                        "BREAKPATCH_LICENCE_KEY": "k", "HTTPS_PROXY": "http://p", "VK_ICD_FILENAMES": "v",
                                        "LD_LIBRARY_PATH": "/old"})
    assert set(env) <= {"PATH", "HOME", "VK_ICD_FILENAMES", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"}
    if sys.platform.startswith("linux"):
        assert env["LD_LIBRARY_PATH"] == f"{tmp_path}{os.pathsep}/old"


def test_a_chat_request_is_the_engines_request(make, files):
    s = make()
    image = Image.new("RGBA", (1280, 800), (10, 20, 30, 255))
    doc = s.chat(llamacpp.request_body(image, LOCATE), 10)
    assert doc["choices"][0]["message"]["content"] == '{"bbox_2d": [100, 500, 300, 560]}'
    (req,) = files.requests
    assert req["headers"]["Authorization"] == f"Bearer {s.api_key}"
    assert req["headers"]["Content-Type"] == "application/json"
    b = req["body"]
    assert set(b) == {"messages", "temperature", "max_tokens", "seed", "stream"}
    assert (b["temperature"], b["max_tokens"], b["seed"], b["stream"]) == (0, 96, 7, False)
    (msg,) = b["messages"]
    assert msg["role"] == "user"
    img, text = msg["content"]
    assert text == {"type": "text", "text": LOCATE}
    assert img["type"] == "image_url"
    url = img["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as im:
        assert (im.format, im.mode, im.size) == ("PNG", "RGB", (1280, 800))
        assert im.getpixel((5, 5)) == (10, 20, 30)


def test_it_waits_for_the_model_to_load(make, files):
    files.set(load_s=0.8)
    s = make()
    t = time.monotonic()
    s.ensure()
    assert time.monotonic() - t >= 0.7 and s.load_seconds >= 0.7


def test_a_server_that_wont_start_is_not_ready(make, files):
    files.set(exit_at_start=1)
    s = make()
    with pytest.raises(EngineError) as e:
        s.ensure()
    assert e.value.code == "not_ready" and "couldn't start" in e.value.message
    assert "failed to load model" in (e.value.details or "")


def test_a_server_that_never_gets_ready_is_stopped(make, files):
    files.set(load_s=60)
    s = make(start_timeout_s=0.6)
    with pytest.raises(EngineError) as e:
        s.ensure()
    assert e.value.code == "not_ready" and "too long to start" in e.value.message
    assert not s.running and gone(files.starts[0]["pid"])


def test_a_slow_answer_times_out(make, files):
    files.set(delay=3)
    s = make()
    t = time.monotonic()
    with pytest.raises(EngineError) as e:
        s.chat(body(), 0.5)
    assert time.monotonic() - t < 2.5
    assert e.value.code == "not_ready" and "didn't answer within" in e.value.message
    assert s.running                         # slow, not stuck: /health still answers, so it's kept
    files.set()
    assert s.chat(body(), 10)["choices"]
    assert len(files.starts) == 1


@pytest.mark.parametrize("conf", [{"raw": "<html>oops"}, {"raw": "[1, 2]"}, {"raw": '{"choices": []}'},
                                  {"status": 500, "raw": '{"error": "boom"}'}, {"reply": "no box here, sorry"}])
async def test_a_garbled_reply_is_no_answer(files, conf, tmp_path):
    files.set(**conf)
    loc = locator(files, tmp_path)
    try:
        assert await loc.locate(Image.new("RGB", (1280, 800)), "the Next button") is None
        assert await loc.describe(Image.new("RGB", (1280, 800)), (10, 10)) is None
    finally:
        loc.close()


def test_a_crash_restarts_the_server_once(make, files):
    files.set(crash_on_chat=True, crash_starts=[1])
    s = make()
    doc = s.chat(body(), 10)                    # the first server dies; the second answers
    assert doc["choices"]
    assert len(files.starts) == 2 and [r["start"] for r in files.requests] == [1, 2]
    assert gone(files.starts[0]["pid"])


def test_a_second_crash_is_not_ready(make, files):
    files.set(crash_on_chat=True)
    s = make()
    with pytest.raises(EngineError) as e:
        s.chat(body(), 10)
    assert e.value.code == "not_ready" and "stopped working" in e.value.message
    assert len(files.starts) == 2


def test_a_server_that_died_while_idle_is_started_again(make, files):
    s = make()
    s.ensure()
    s.proc.kill()
    s.proc.wait(5)
    assert s.chat(body(), 10)["choices"] and len(files.starts) == 2


def test_it_gives_up_after_crashing_again_and_again(make, files, monkeypatch):
    monkeypatch.setattr(llamacpp, "MAX_CRASHES", 2)
    files.set(crash_on_chat=True)
    s = make()
    with pytest.raises(EngineError):
        s.chat(body(), 10)                       # two crashes
    with pytest.raises(EngineError) as e:
        s.chat(body(), 10)
    assert "keeps stopping" in e.value.message and len(files.starts) == 2


def test_it_stops_when_idle_and_starts_again_when_needed(make, files):
    s = make(idle_stop_s=0.5)
    s.chat(body(), 10)
    pid = files.starts[0]["pid"]
    end = time.monotonic() + 5
    while s.running and time.monotonic() < end:
        time.sleep(0.05)
    assert not s.running and gone(pid)
    assert s.chat(body(), 10)["choices"] and len(files.starts) == 2


def test_it_isnt_stopped_while_a_request_is_going(make, files):
    files.set(delay=1.2)
    s = make(idle_stop_s=0.3)
    assert s.chat(body(), 10)["choices"]         # longer than the idle time: still answered
    assert len(files.starts) == 1


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="PR_SET_PDEATHSIG is Linux only")
def test_the_server_outlives_the_worker_thread_that_asked_for_it(make, files):
    """PR_SET_PDEATHSIG fires when the *thread* that forked the child ends. The engine asks from
    asyncio.to_thread workers, which can end at any time; the server must not go with them."""
    import threading
    s = make()
    t = threading.Thread(target=s.ensure)
    t.start()
    t.join()
    pid = files.starts[0]["pid"]
    time.sleep(0.5)                              # time for a parent-death signal to arrive
    assert s.running and not gone(pid, wait=0.1)
    assert s.chat(body(), 10)["choices"] and len(files.starts) == 1
    s.close()                                    # for good: the supervisor thread ends too
    assert gone(pid) and not any(t.name == "llama-server-supervisor" and t.is_alive()
                                 for t in threading.enumerate() if t is s._supervisor)


def test_the_parent_death_hook_does_only_prctl_and_the_parent_check(monkeypatch):
    if not sys.platform.startswith("linux"):
        assert llamacpp._die_with_parent() is None
        return
    calls = []
    import ctypes

    class Lib:
        def prctl(self, *a):
            calls.append(("prctl", a))
            return 0
    monkeypatch.setattr(ctypes, "CDLL", lambda *a, **k: Lib())
    monkeypatch.setattr(llamacpp.os, "getpid", lambda: 100)
    monkeypatch.setattr(llamacpp.os, "getppid", lambda: 100)
    monkeypatch.setattr(llamacpp.os, "_exit", lambda code: calls.append(("exit", code)))
    hook = llamacpp._die_with_parent()
    hook()
    assert calls == [("prctl", (1, 15, 0, 0, 0))]
    monkeypatch.setattr(llamacpp.os, "getppid", lambda: 1)            # the engine went before the prctl
    hook = llamacpp._die_with_parent()
    calls.clear()
    hook()
    assert calls == [("prctl", (1, 15, 0, 0, 0)), ("exit", 1)]


def test_physical_cores_is_a_sensible_number():
    n = llamacpp.physical_cores()
    assert n is None or 1 <= n <= (os.cpu_count() or n)


# ---------------------------------------------------------------- the locator

GGUF_REPO = "Org/VL-GGUF"


def gguf_bytes(arch: str) -> bytes:
    from test_models import gguf
    return gguf({"general.architecture": arch})


def locator(files, tmp_path, monkeypatch=None, **kw):
    """A LlamaCppLocator on an installed GGUF model folder, with the fake as its llama-server."""
    d = tmp_path / "gguf-model"
    if not d.exists():
        d.mkdir()
        blobs = {"m.gguf": gguf_bytes("qwen3vl"), "mm.gguf": gguf_bytes("clip")}
        for n, b in blobs.items():
            (d / n).write_bytes(b)
        models.ALLOWED[GGUF_REPO] = {"format": "gguf", "revision": "main",
                                     "files": {n: hashlib.sha256(b).hexdigest() for n, b in blobs.items()},
                                     "gguf": {"model": "m.gguf", "mmproj": "mm.gguf"}}
        (d / models.MARKER).write_text(json.dumps({"repo": GGUF_REPO, "revision": "main", "format": "gguf"}))
    exe = tmp_path / "bin" / "llama-server"
    exe.parent.mkdir(exist_ok=True)
    exe.write_text("")
    kw.setdefault("start_timeout_s", 20)
    loc = LlamaCppLocator(d, {"exe": str(exe), "backend": "cpu"}, repo=GGUF_REPO, **kw)
    # The fake stands in for the runtime's llama-server; the model files are the fake's.
    loc.server.launcher = [sys.executable, str(FAKE)]
    loc.server.model, loc.server.mmproj = files.model, files.mmproj
    return loc


@pytest.fixture(autouse=True)
def _forget_gguf_entry():
    yield
    models.ALLOWED.pop(GGUF_REPO, None)


async def test_the_locator_asks_the_server_and_parses_as_on_the_mac(files, tmp_path):
    loc = locator(files, tmp_path)
    try:
        assert loc.available() and loc.timeout_s == llamacpp.TIMEOUT_CPU_S
        assert loc.server.gpu_layers == 0
        assert await loc.locate(Image.new("RGB", (1280, 800)), ' the "Next" button ') == [128, 400, 384, 448]
        assert files.requests[-1]["body"]["messages"][0]["content"][1]["text"] == LOCATE
        assert loc.last_timings == {"prompt_n": 1081, "prompt_ms": 812.5, "predicted_n": 21, "predicted_ms": 230.1}
        files.set(reply='{"name": "Sign in", "target": "Sign in button, top right"}')
        assert await loc.describe(Image.new("RGB", (1280, 800)), (640, 200)) == {
            "name": "Sign in", "target": "Sign in button, top right"}
        files.set(reply='{"happened": true, "why": "gone"}')
        assert await loc.judge(Image.new("RGB", (1280, 800)), "closes") == {"happened": True, "why": "gone"}
        files.set(reply='{"action": "hover", "target": "Menu"}')
        assert await loc.intent(Image.new("RGB", (1280, 800)), "point at the menu") == {
            "action": "hover", "repeat": 1, "target": "Menu"}
        assert len(files.starts) == 1
    finally:
        loc.close()
    assert not loc.server.running


async def test_a_gpu_runtime_offloads_and_waits_less(files, tmp_path):
    d = tmp_path / "x"
    d.mkdir()
    loc = LlamaCppLocator(d, {"exe": str(tmp_path / "nope"), "backend": "vulkan"}, repo=None)
    assert loc.timeout_s == llamacpp.TIMEOUT_GPU_S and not loc.available()
    loc2 = locator(files, tmp_path)
    loc3 = LlamaCppLocator(loc2.model_path, {"exe": loc2.runtime["exe"], "backend": "vulkan"}, repo=GGUF_REPO)
    assert loc3.server.gpu_layers == 99


async def test_the_locator_checks_the_model_before_starting(files, tmp_path):
    loc = locator(files, tmp_path)
    (loc.model_path / "m.gguf").write_bytes(gguf_bytes("llama"))           # changed since the download
    with pytest.raises(EngineError) as e:
        await loc.locate(Image.new("RGB", (1280, 800)), "x")
    assert e.value.code == "not_ready" and "didn't check out" in e.value.message
    assert files.starts == []


async def test_warm_starts_the_server_and_says_how_long(files, tmp_path):
    files.set(load_s=0.3)
    loc = locator(files, tmp_path)
    try:
        assert loc.warm() >= 0.25 and loc.warm() is None
    finally:
        loc.close()


def test_the_model_test_sends_the_same_request():
    """tools/model-test's OpenAIRuntime (and so --runtime llamacpp) asks exactly as the engine
    does, so its results stand for the engine's (plan §2.4)."""
    root = Path(__file__).resolve().parents[2] / "tools" / "model-test"
    sys.path.insert(0, str(root))
    try:
        import model_test
    finally:
        sys.path.remove(str(root))
    rt = model_test.OpenAIRuntime("k", "http://127.0.0.1:1", None, llamacpp.MAX_TOKENS)
    sent = []
    rt._post = lambda path, b: sent.append((path, b)) or {"choices": [{"message": {"content": "x"}}]}
    image = Image.new("RGB", (1280, 800), "white")
    rt.ask(image, LOCATE)
    assert sent == [("/v1/chat/completions", llamacpp.request_body(image, LOCATE))]
    assert model_test.SEED == llamacpp.SEED and model_test.MAX_TOKENS == llamacpp.MAX_TOKENS
    lc = model_test.LlamaCppRuntime.__new__(model_test.LlamaCppRuntime)
    lc.exe, lc.gguf, lc.mmproj, lc.api_key, lc.ctx, lc.ngl, lc.threads, lc.image_max_tokens = (
        "llama-server", Path("m.gguf"), Path("mm.gguf"), "K", 4096, 0, None, None)
    engine = LlamaServer("llama-server", Path("m.gguf"), Path("mm.gguf")).command(1234, Path("keyfile"))
    theirs = lc.command(1234)
    # The same flags, but the engine passes its key in a file.
    strip = lambda c, flag: [x for i, x in enumerate(c) if x != flag and (i == 0 or c[i - 1] != flag)]  # noqa: E731
    assert strip(engine, "--api-key-file") == strip(theirs, "--api-key")
