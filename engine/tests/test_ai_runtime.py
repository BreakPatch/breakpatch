"""Which AI assistant the engine uses (service.default_locator_factory), `setup.warmUp` and
stopping llama-server at shutdown (plan P2.3–P2.5). The Mac's choice is unchanged: an MLX model
with mlx-vlm importable is an MlxLocator, as before llama.cpp existed."""
import json
import threading
import time

import pytest

from breakpatch_engine import config, install, llamacpp, locator, runtimes, service
from breakpatch_engine.locator import MlxLocator, NoLocator
from breakpatch_engine.protocol import EngineError


def marker(name: str, **info) -> str:
    d = config.models_dir() / name
    d.mkdir(parents=True)
    (d / install.MARKER).write_text(json.dumps({"installedAt": 1, **info}))
    return str(d)


def fake_runtime(monkeypatch, installed=True, backend="cpu"):
    rt = {"installed": True, "build": "b1", "backend": backend, "path": "/rt", "exe": "/rt/llama-server"}
    monkeypatch.setattr(runtimes, "installed_runtime", lambda *a, **k: rt if installed else {"installed": False})
    return rt


def test_no_model_is_no_locator(monkeypatch):
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    assert isinstance(service.default_locator_factory()(), NoLocator)


@pytest.fixture
def runtime(monkeypatch):
    """Sets which AI runtime this machine uses (runtimes.runtime_name, the one place that decides)."""
    def set_(name):
        monkeypatch.setattr(runtimes, "runtime_name", lambda: name)
    set_("llamacpp")
    return set_


def test_an_mlx_model_is_mlx_as_before(monkeypatch, runtime):
    runtime("mlx")
    path = marker("mlx", repo="Org/M", revision="main")                # an older marker: no format
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    get = service.default_locator_factory()
    loc = get()
    assert type(loc) is MlxLocator and str(loc.model_path) == path
    assert get() is loc                                                  # kept, so the model stays loaded
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: False))
    assert isinstance(get(), NoLocator)                                  # no mlx-vlm (not a Mac): nothing


def test_a_gguf_model_needs_the_runtime(monkeypatch, runtime):
    marker("gguf", repo="Org/G", revision="main", format="gguf")
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    fake_runtime(monkeypatch, installed=False)
    get = service.default_locator_factory()
    assert isinstance(get(), NoLocator)
    rt = fake_runtime(monkeypatch)
    loc = get()
    assert isinstance(loc, llamacpp.LlamaCppLocator) and loc.runtime == rt and loc.repo == "Org/G"
    assert get() is loc


def test_close_stops_the_server_and_a_new_model_replaces_the_old(monkeypatch, runtime):
    marker("gguf", repo="Org/G", revision="main", format="gguf")
    fake_runtime(monkeypatch)
    registered = []
    monkeypatch.setattr(service.atexit, "register", registered.append)
    get = service.default_locator_factory()
    first = get()
    closed, threads = [], []
    first.close = lambda: (threads.append(threading.current_thread()), time.sleep(0.3), closed.append(1))
    marker("gguf2", repo="Org/G2", revision="main", format="gguf", installedAt=2)
    t0 = time.monotonic()
    assert get() is not first
    assert time.monotonic() - t0 < 0.2                    # the old one is closed off this thread
    for _ in range(100):
        if closed:
            break
        time.sleep(0.02)
    assert closed == [1] and threads[0] is not threading.current_thread()
    second = get()
    second.close = lambda: closed.append(2)
    get.close()
    assert closed == [1, 2]
    assert registered == [get.close]                      # one atexit hook for the factory, not one per model


def test_an_unknown_format_is_no_locator(runtime):
    marker("x", repo="Org/X", revision="main", format="onnx")
    assert isinstance(service.default_locator_factory()(), NoLocator)


@pytest.mark.parametrize("name,fmt", [("llamacpp", "mlx"), ("mlx", "gguf")])
async def test_a_model_for_the_other_runtime_is_no_locator_and_says_why(monkeypatch, runtime, name, fmt):
    runtime(name)
    marker("m", repo="Org/M", revision="main", **({"format": fmt} if fmt == "gguf" else {}))
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    fake_runtime(monkeypatch)
    loc = service.default_locator_factory()()
    assert type(loc) is NoLocator and fmt in loc.reason and name in loc.reason
    with pytest.raises(EngineError) as e:
        await loc.locate(None, "x")
    assert e.value.code == "not_ready" and "doesn't run on this computer" in e.value.message
    with pytest.raises(EngineError) as e:
        await engine_with(loc).warm_up({})
    assert e.value.details == loc.reason


def test_an_intel_mac_uses_llamacpp_everywhere(monkeypatch):
    """runtime_name() decides for the engine, the model table and system.info (the app reads only that)."""
    from breakpatch_engine import models, systems
    monkeypatch.setattr(runtimes.sys, "platform", "darwin")
    monkeypatch.setattr(systems, "arch", lambda: "x86_64")
    assert runtimes.runtime_name() == "llamacpp" and models.default_format() == "gguf"
    assert install.system_info()["runtime"] == "llamacpp"
    monkeypatch.setattr(systems, "arch", lambda: "arm64")
    assert runtimes.runtime_name() == "mlx" and models.default_format() == "mlx"
    monkeypatch.setattr(runtimes.sys, "platform", "linux")
    assert runtimes.runtime_name() == "llamacpp" and models.default_format() == "gguf"


class FakeLocator(locator.VisionLocator):
    backend = "cpu"

    def __init__(self, box=True, ok=True):
        self.asked, self.box, self.ok, self.warmed = [], box, ok, 0

    def available(self):
        return self.ok

    def warm(self):
        self.warmed += 1
        return 4.2

    def _generate(self, image, prompt):
        self.asked.append((image.size, prompt))
        return '{"bbox_2d": [400, 590, 600, 640]}' if self.box else "no idea"


def engine_with(loc):
    return service.Engine(lambda e, d: None, locator_fn=lambda: loc, healer=None, explainer=None)


async def test_warm_up_takes_one_look_at_a_drawn_page():
    loc = FakeLocator()
    got = await engine_with(loc).warm_up({})
    assert got["loadSeconds"] == 4.2 and got["found"] is True and got["backend"] == "cpu"
    assert got["runtime"] == runtimes.runtime_name() and isinstance(got["seconds"], float)
    (size, prompt), = loc.asked
    assert size == (1280, 800) and '"the Sign in button"' in prompt
    assert (await engine_with(FakeLocator(box=False)).warm_up({}))["found"] is False


async def test_warm_up_without_a_model_or_during_a_run():
    with pytest.raises(EngineError) as e:
        await engine_with(NoLocator()).warm_up({})
    assert e.value.code == "not_ready"
    eng = engine_with(FakeLocator())
    eng._activity = "run"
    with pytest.raises(EngineError) as e:
        await eng.warm_up({})
    assert e.value.code == "busy"


def test_the_warm_up_page_has_a_sign_in_button():
    im = locator.warmup_image()
    assert im.size == (1280, 800) and im.getpixel((640, 480)) == (37, 99, 235)


async def test_shutdown_stops_the_ai_assistant():
    stopped = []

    def get():
        return NoLocator()
    get.close = lambda: stopped.append(True)
    eng = service.Engine(lambda e, d: None, locator_fn=get, healer=None, explainer=None)
    await eng.shutdown()
    assert stopped == [True]


def test_the_protocol_lists_the_new_requests():
    eng = engine_with(NoLocator())
    assert {"setup.installRuntime", "setup.warmUp"} <= set(eng.handlers())
