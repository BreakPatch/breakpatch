"""Golden tests for the AI assistant's MLX path (plan P2.1): the exact prompts, the exact mlx-vlm
calls and the parsing of the replies, written down before the shared `VisionLocator` base existed.
The prompts below are literals on purpose, not the module's constants: if a prompt or a call
changes, the Mac's AI assistant changes, and this file has to be changed with it.

mlx-vlm is replaced by a fake that records every call (it only exists on Apple Silicon)."""
import hashlib
import json
import sys
import types

import pytest
from PIL import Image

from breakpatch_engine import locator, models
from breakpatch_engine.locator import MlxLocator, parse_bbox, parse_describe, parse_intent, parse_judge

LOCATE = ('Find "the \'Next\' button" in this screenshot of a web app. Reply with JSON only, no other text: '
          '{"bbox_2d": [x1, y1, x2, y2]}. If it isn\'t in the screenshot, reply {"bbox_2d": null}.')
JUDGE = ('This is a screenshot of a web app just after a test step. The step should have done this: '
         '"closes the \'What\'s new\' dialog". Did it happen? Reply with JSON only, no other text: '
         '{"happened": true, "why": "the dialog is gone"}')
DESCRIBE = ('In this screenshot of a web app, look at the element at point [500, 250] '
            '(coordinates from 0 to 1000). Name it the way a tester would, from what it says or shows, '
            'and say where it is. If there is nothing there you can name, reply {"name": null}. '
            'Reply with JSON only, no other text: {"name": "<its name>", "target": "<its name>, <where it is>"}')
INTENT = ('A tester typed this step for the web app in the screenshot: "add 2 \'adults\'". Say what it asks for. '
          'action is one of: click, double click, right click, long click, hover, type, scroll, wait, check. '
          'target is what to act on, the way the screen names it, or null. times is how many times to do it. '
          'text is what to type, or null. direction is up, down, left or right, or null. '
          'seconds is how long to wait, or null. Reply with JSON only, no other text: '
          '{"action": ..., "target": ..., "times": ..., "text": ..., "direction": ..., "seconds": ...}')


class FakeMlx:
    """mlx_vlm, mlx_vlm.utils and mlx_vlm.prompt_utils, recording what the locator asks."""

    def __init__(self):
        self.loads, self.templates, self.generates, self.replies = [], [], [], []
        self.model, self.processor, self.config = object(), object(), {"model_type": "qwen3_vl"}

    def install(self, monkeypatch):
        top = types.ModuleType("mlx_vlm")
        top.load = lambda path, **kw: (self.loads.append((path, kw)), (self.model, self.processor))[1]
        top.generate = self.generate
        utils = types.ModuleType("mlx_vlm.utils")
        utils.load_config = lambda path: self.config
        pu = types.ModuleType("mlx_vlm.prompt_utils")
        pu.apply_chat_template = self.apply_chat_template
        for name, mod in (("mlx_vlm", top), ("mlx_vlm.utils", utils), ("mlx_vlm.prompt_utils", pu)):
            monkeypatch.setitem(sys.modules, name, mod)

    def apply_chat_template(self, processor, config, prompt, **kw):
        self.templates.append((processor, config, prompt, kw))
        return f"<formatted>{prompt}</formatted>"

    def generate(self, model, processor, formatted, images, **kw):
        assert model is self.model and processor is self.processor
        assert isinstance(images, list) and len(images) == 1 and images[0].endswith(".png")
        with Image.open(images[0]) as im:           # the screenshot, as an RGB PNG on disk
            self.generates.append((formatted, im.size, im.mode, im.format, kw))
        return self.replies.pop(0)


@pytest.fixture
def mlx(tmp_path, monkeypatch):
    files = {"config.json": b'{"model_type": "qwen3_vl"}', "model.safetensors": b"weights"}
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "main", "files": {
        n: hashlib.sha256(b).hexdigest() for n, b in files.items()}}})
    d = tmp_path / "model"
    d.mkdir()
    for n, b in files.items():
        (d / n).write_bytes(b)
    (d / models.MARKER).write_text(json.dumps({"repo": "Org/M", "revision": "main"}))
    fake = FakeMlx()
    fake.install(monkeypatch)
    return fake, MlxLocator(d)


def shot(mode="RGBA"):
    return Image.new(mode, (1280, 800), (255, 255, 255, 255) if mode == "RGBA" else (255, 255, 255))


GEN_KW = {"max_tokens": 96, "temperature": 0.0, "verbose": False}


async def test_locate_sends_the_golden_prompt_and_maps_the_box(mlx):
    fake, loc = mlx
    fake.replies = ['```json\n{"bbox_2d": [100, 500, 300, 560]}\n```']
    assert await loc.locate(shot(), ' the "Next" button ') == [128, 400, 384, 448]
    assert fake.loads == [(str(loc.model_path), {"trust_remote_code": False})]
    assert fake.templates == [(fake.processor, fake.config, LOCATE, {"num_images": 1})]
    assert fake.generates == [(f"<formatted>{LOCATE}</formatted>", (1280, 800), "RGB", "PNG", GEN_KW)]


async def test_judge_describe_and_intent_send_their_golden_prompts(mlx):
    fake, loc = mlx
    fake.replies = ['{"happened": false, "why": "  it is still open  "}',
                    '{"name": "Sign in", "target": "Sign in button, top right"}',
                    '{"action": "Click", "target": "+ next to Adults", "times": 2, "text": null}']
    assert await loc.judge(shot(), 'closes the "What\'s new" dialog') == {"happened": False, "why": "it is still open"}
    assert await loc.describe(shot("RGB"), (640.0, 200.0)) == {"name": "Sign in", "target": "Sign in button, top right"}
    assert await loc.intent(shot(), 'add 2 "adults"') == {"action": "click", "repeat": 2, "target": "+ next to Adults"}
    assert [t[2] for t in fake.templates] == [JUDGE, DESCRIBE, INTENT]
    assert [g[0] for g in fake.generates] == [f"<formatted>{p}</formatted>" for p in (JUDGE, DESCRIBE, INTENT)]
    assert all(g[1:] == ((1280, 800), "RGB", "PNG", GEN_KW) for g in fake.generates)
    assert len(fake.loads) == 1                     # loaded once, kept in memory


async def test_garbled_replies_are_none(mlx):
    fake, loc = mlx
    fake.replies = ["I think it's the blue one", "", '{"name": "<its name>", "target": "x"}', "{oops"]
    assert await loc.locate(shot(), "x") is None
    assert await loc.judge(shot(), "x") is None
    assert await loc.describe(shot(), (1, 1)) is None
    assert await loc.intent(shot(), "x") is None


async def test_a_reply_object_with_text_is_read(mlx):
    fake, loc = mlx
    fake.replies = [types.SimpleNamespace(text='{"bbox_2d": [0, 0, 1000, 1000]}')]
    assert await loc.locate(shot(), "page") == [0, 0, 1280, 800]


# The parsers, on replies the small model has really given: what each comes out as.
GOLDEN_BBOX = [
    ('{"bbox_2d": [100, 200, 300, 400]}', [128, 160, 384, 320]),
    ('```json\n[{"bbox_2d": [300, 400, 100, 200], "label": "Next"}]\n```', [128, 160, 384, 320]),
    ('[100, 200, 300, 400]', [128, 160, 384, 320]),
    ('bbox_2d": [100.5, 200, 300, 400', [129, 160, 384, 320]),
    ('{"bbox_2d": null}', None),
    ('{"bbox_2d": [1100, 200, 1300, 400]}', None),
    ('{"bbox_2d": [100, 200, 100, 400]}', None),
    ('', None),
]


@pytest.mark.parametrize("text,want", GOLDEN_BBOX)
def test_parse_bbox_golden(text, want):
    assert parse_bbox(text, 1280, 800) == want


def test_parse_describe_judge_and_intent_golden():
    assert parse_describe('{"name": "  Save  ", "target": "Save, bottom"}') == {"name": "Save", "target": "Save, bottom"}
    assert parse_describe('{"name": "Save"}') == {"name": "Save", "target": "Save"}
    assert parse_describe('{"name": null}') is None
    assert parse_describe('{"name": "Done button, bottom right of the Create Project dialog"}') is None
    assert parse_judge('{"happened": true}') == {"happened": True, "why": ""}
    assert parse_judge('{"happened": "yes"}') is None
    assert parse_intent('{"action": "wait", "seconds": 3}') == {"action": "waitFor", "repeat": 1, "seconds": 3}
    assert parse_intent('{"action": "type", "text": "hello  world", "target": "..."}') == {
        "action": "write", "repeat": 1, "text": "hello world"}
    assert parse_intent('{"action": "scroll", "direction": "down", "times": 50}') == {
        "action": "scroll", "repeat": 1, "direction": "down"}
    assert parse_intent('{"action": "fly", "target": "x"}') is None
    assert parse_intent('{"action": "click"}') is None


def test_the_prompts_are_unchanged():
    assert locator.LOCATE_PROMPT.format(desc="the 'Next' button") == LOCATE
    assert locator.DESCRIBE_PROMPT.format(x=500, y=250) == DESCRIBE
