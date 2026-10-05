"""Which AI assistant the engine uses (service.default_locator_factory), `setup.warmUp` and
stopping llama-server at shutdown (plan P2.3–P2.5). The Mac's choice is unchanged: an MLX model
with mlx-vlm importable is an MlxLocator, as before llama.cpp existed."""
import json

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


def test_an_mlx_model_is_mlx_as_before(monkeypatch):
    path = marker("mlx", repo="Org/M", revision="main")                # an older marker: no format
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    get = service.default_locator_factory()
    loc = get()
    assert type(loc) is MlxLocator and str(loc.model_path) == path
    assert get() is loc                                                  # kept, so the model stays loaded
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: False))
    assert isinstance(get(), NoLocator)                                  # no mlx-vlm (not a Mac): nothing


def test_a_gguf_model_needs_the_runtime(monkeypatch):
    marker("gguf", repo="Org/G", revision="main", format="gguf")
    monkeypatch.setattr(MlxLocator, "importable", staticmethod(lambda: True))
    fake_runtime(monkeypatch, installed=False)
    get = service.default_locator_factory()
    assert isinstance(get(), NoLocator)
    rt = fake_runtime(monkeypatch)
    loc = get()
    assert isinstance(loc, llamacpp.LlamaCppLocator) and loc.runtime == rt and loc.repo == "Org/G"
    assert get() is loc


def test_close_stops_the_server_and_a_new_model_replaces_the_old(monkeypatch):
    marker("gguf", repo="Org/G", revision="main", format="gguf")
    fake_runtime(monkeypatch)
    get = service.default_locator_factory()
    first = get()
    closed = []
    first.close = lambda: closed.append(1)
    marker("gguf2", repo="Org/G2", revision="main", format="gguf", installedAt=2)
    assert get() is not first and closed == [1]
    second = get()
    second.close = lambda: closed.append(2)
    get.close()
    assert closed == [1, 2]


def test_an_unknown_format_is_no_locator():
    marker("x", repo="Org/X", revision="main", format="onnx")
    assert isinstance(service.default_locator_factory()(), NoLocator)


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
