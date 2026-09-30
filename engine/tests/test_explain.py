""""Why did this fail?" (explain.py, roadmap #7): the open side of the contract. The explaining is
Breakpatch Team's (its tests are in the Team engine); Community answers not_ready and reads nothing."""
import sys
import types

import pytest
from PIL import Image

from breakpatch_engine import config, explain, plugins
from breakpatch_engine.config import Timings
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.service import Engine


def shot(name="r1/001-s1.png"):
    p = config.screenshots_dir() / name
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (80, 60), "white").save(p)
    return p


STEP = {"id": "s1", "action": "click", "target": "Save button", "at": [10, 10]}


def params(path, reason="targetNotFound"):
    return {"step": STEP, "stepRun": {"stepId": "s1", "result": "failed", "reason": reason, "screenshotPath": str(path)}}


def test_clean_keeps_only_explanations():
    ok = {"summary": "  The Save button\\n moved. ", "cause": "moved", "suggestion": "rerecord", "extra": 1}
    assert explain.clean(ok) == {"summary": "The Save button\\n moved.", "cause": "moved", "suggestion": "rerecord"}
    assert explain.clean({**ok, "cause": "aliens"}) is None
    assert explain.clean({**ok, "suggestion": "panic"}) is None
    assert explain.clean({**ok, "summary": " "}) is None
    assert explain.clean("The Save button moved.") is None
    assert len(explain.clean({**ok, "summary": "x" * 900})["summary"]) == explain.MAX_SUMMARY


def test_only_pngs_in_the_screenshots_folder(tmp_path):
    p = shot()
    assert explain.in_screenshots(p) == p.resolve()
    other = tmp_path / "x.png"
    Image.new("RGB", (4, 4)).save(other)
    assert explain.in_screenshots(other) is None
    assert explain.in_screenshots(str(config.screenshots_dir() / ".." / ".." / "x.png")) is None
    txt = config.screenshots_dir() / "r1" / "notes.txt"
    txt.write_text("x")
    assert explain.in_screenshots(txt) is None
    assert explain.in_screenshots(config.screenshots_dir() / "r1" / "missing.png") is None


def test_a_page_read_keeps_names_and_boxes_only():
    rec = explain.page_record(
        [{"index": 0, "role": "button", "name": "Save", "box": [1, 2, 3, 4], "attrs": {"data-testid": "save"}, "disabled": False},
         {"role": "link", "name": "no box"}],
        [{"text": "Hello", "box": [0, 0, 5, 5]}, {"text": "", "box": [0, 0, 1, 1]}])
    assert rec == {"v": 1, "controls": [{"role": "button", "name": "Save", "box": [1.0, 2.0, 3.0, 4.0]}],
                   "texts": [{"text": "Hello", "box": [0.0, 0.0, 5.0, 5.0]}]}
    p = shot()
    explain.save_page(p, rec)
    assert explain.read_page(p) == rec
    explain.page_path(p).write_text("not json")
    assert explain.read_page(p) is None


async def test_community_answers_not_ready():
    engine = Engine(lambda *a: None, timings=Timings.fast(), explainer=None)
    with pytest.raises(EngineError) as err:
        await engine.handlers()["run.explain"](params(shot()))
    assert err.value.code == "not_ready"


def test_the_team_engine_registers_an_explainer(monkeypatch):
    monkeypatch.setattr(plugins, "_loaded", False)
    monkeypatch.setattr(plugins, "_healer", None)
    monkeypatch.setattr(plugins, "_team_version", None)
    monkeypatch.setattr(plugins, "_licence", None)
    monkeypatch.setattr(plugins, "_explainer", None)
    marker = object()
    fake = types.ModuleType(plugins.TEAM_MODULE)
    fake.register = lambda p: p.register_explainer(marker)
    monkeypatch.setitem(sys.modules, plugins.TEAM_MODULE, fake)
    assert plugins.explainer() is marker
    assert Engine(lambda *a: None).explainer is marker


class Explainer:
    def __init__(self, answer=None, wants=True):
        self.answer, self.wants, self.asked = answer, wants, 0

    def wants_page(self):
        return self.wants

    async def explain(self, failure, locator_fn):
        self.asked += 1
        assert failure.image is not None and failure.reason == "targetNotFound" and failure.step["id"] == "s1"
        return self.answer


async def test_an_explainers_answer_is_checked_and_cached():
    e = Explainer({"summary": "The Save button moved.", "cause": "moved", "suggestion": "rerecord"})
    engine = Engine(lambda *a: None, timings=Timings.fast(), explainer=e)
    p = shot()
    want = {"explanation": {"summary": "The Save button moved.", "cause": "moved", "suggestion": "rerecord"}}
    assert await engine.handlers()["run.explain"](params(p)) == want
    assert await engine.handlers()["run.explain"](params(p)) == want
    assert e.asked == 1
    with pytest.raises(EngineError) as err:
        await engine.handlers()["run.explain"](params(p, reason="setUpFailed"))
    assert err.value.code == "bad_request"
