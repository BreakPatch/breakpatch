"""Describing a step (record.locate) with the fast locator in front of the AI assistant: the router,
S0's answers, the fallback, absence checks, and that S0's answers never touch the model."""
import logging

import pytest

import domsite
from conftest import needs_browser
from breakpatch_engine.config import Timings
from breakpatch_engine.dom import flow as flow_mod
from breakpatch_engine.dom.router import CANVAS_SHARE, FAST, MIN_CANDIDATES, VISUAL, route
from breakpatch_engine.dom.extract import Extraction
from breakpatch_engine.locator import MlxLocator, NoLocator
from breakpatch_engine.protocol import NULL, EngineError
from breakpatch_engine.service import Engine

pytestmark = needs_browser
V1_BOX = [700, 500, 760, 540]


@pytest.fixture(scope="module")
def site():
    base, stop = domsite.serve()
    yield base
    stop()


class FakeV1:
    """The AI assistant, answering `box` for everything."""

    def __init__(self, box=V1_BOX):
        self.box = box
        self.calls = []

    def available(self):
        return True

    async def locate(self, image, description):
        self.calls.append(description)
        return self.box

    async def describe(self, image, at):
        return None


class Harness:
    def __init__(self, locator):
        self.locator = locator
        self.fetched = 0

        def locator_fn():
            self.fetched += 1
            return self.locator
        self.engine = Engine(lambda e, d: None, timings=Timings.fast(), locator_fn=locator_fn, healer=None)
        self.h = self.engine.handlers()

    async def open(self, url):
        await self.h["browser.open"]({"url": url, "viewport": domsite.VIEWPORT})

    async def locate(self, description, **kw):
        return await self.h["record.locate"]({"description": description, **kw})

    async def close(self):
        await self.h["browser.close"]({})


def ex(count=10, flutter=False, canvas=0.0):
    return Extraction((1440, 900), [{}] * count, 1.0, flutter, canvas)


def test_the_router_rule():
    assert route(ex(10)).mode == FAST
    assert route(ex(10, flutter=True)).mode == VISUAL
    assert route(ex(10, canvas=CANVAS_SHARE)).mode == VISUAL
    assert route(ex(10, canvas=CANVAS_SHARE - 0.01)).mode == FAST
    assert route(ex(MIN_CANDIDATES - 1)).mode == VISUAL and route(ex(0)).mode == VISUAL
    assert route(ex(MIN_CANDIDATES)).mode == FAST


@pytest.mark.parametrize("page,mode,why", [
    ("fx01_plain/index.html", FAST, "24 candidates"),     # a plain form
    ("fx04_hover/index.html", FAST, "5 candidates"),      # a small canvas doesn't count
    ("router/flutter.html", VISUAL, "flutter"),           # Flutter's host, even with buttons listed
    ("router/canvas.html", VISUAL, "canvas"),             # a canvas over most of the page
    ("router/empty.html", VISUAL, "2 candidates"),        # too few controls
    ("router/blank.html", VISUAL, "0 candidates"),        # nothing listed at all
])
async def test_pages_are_routed_fast_or_visual(site, page, mode, why):
    hx = Harness(FakeV1())
    await hx.open(site + page)
    try:
        got = await hx.locate("the Sign in button")
        r = hx.engine.recorder.finder.route
        assert r.mode == mode and r.why.startswith(why), r
        assert (got["path"] if got is not NULL else None) in (("fast", "fast→visual") if mode == FAST else ("visual",))
    finally:
        await hx.close()


async def test_fast_answers_without_the_model(site, monkeypatch):
    """S0's answers never fetch the AI assistant, so its model can't load."""
    loads = []
    monkeypatch.setattr(MlxLocator, "available", lambda self: True)
    monkeypatch.setattr(MlxLocator, "_load", lambda self: loads.append(1) or (_ for _ in ()).throw(
        EngineError("not_ready", "the model was loaded")))
    hx = Harness(MlxLocator(domsite.DOM / "no-model"))
    await hx.open(site + "fx01_plain/index.html")
    try:
        for d in ("the Sign in button", "the second Edit button", "Save button in the Edit profile dialog",
                  "the emial field", "Remember me checkbox"):
            got = await hx.locate(d)
            assert got["path"] == "fast" and got["s0Score"] >= 0.65, (d, got)
        assert hx.fetched == 0 and loads == []
        box, at = got["box"], got["at"]
        assert box[0] <= at[0] <= box[2] and box[1] <= at[1] <= box[3]
        # The same locator does load when the AI assistant is needed: the check above is real.
        with pytest.raises(EngineError, match="the model was loaded"):
            await hx.locate("the purple elephant")
        assert hx.fetched == 1 and loads == [1]
    finally:
        await hx.close()


async def test_fast_answer_is_the_element_s_own_box_and_centre(site):
    hx = Harness(FakeV1())
    await hx.open(site + "fx01_plain/index.html")
    try:
        got = await hx.locate("the Sign in button")
        el = await hx.engine.browser.page.query_selector("[data-gt-id=signin]")
        bb = await el.bounding_box()
        assert got["box"] == [round(bb["x"]), round(bb["y"]), round(bb["x"] + bb["width"]), round(bb["y"] + bb["height"])]
        assert got["at"] == [round(bb["x"] + bb["width"] / 2, 1), round(bb["y"] + bb["height"] / 2, 1)]
        assert got["target"] == "the Sign in button" and isinstance(got["frame"], int)
        assert hx.locator.calls == []
    finally:
        await hx.close()


async def test_when_s0_is_unsure_the_ai_assistant_answers(site):
    hx = Harness(FakeV1())
    await hx.open(site + "fx01_plain/index.html")
    try:
        got = await hx.locate("whatever lets me leave this screen")    # a paraphrase
        assert got["path"] == "fast→visual" and got["s0Score"] < 0.65
        assert got["box"] == V1_BOX and got["at"] == [730.0, 520.0]
        assert hx.locator.calls == ["whatever lets me leave this screen"]
        hx.locator.box = None
        assert await hx.locate("the purple elephant") is NULL
        hx.locator = NoLocator()                                           # not downloaded
        with pytest.raises(EngineError) as e:
            await hx.locate("the purple elephant")
        assert e.value.code == "not_ready"
        assert (await hx.locate("the Sign in button"))["path"] == "fast"  # S0 still answers
    finally:
        await hx.close()


async def test_absence_checks_never_fall_back(site):
    hx = Harness(FakeV1())
    await hx.open(site + "fx01_plain/index.html")
    try:
        assert await hx.locate("the Create account button", absence=True) is NULL
        assert await hx.locate("the purple elephant", absence=True) is NULL
        assert hx.locator.calls == []
        found = await hx.locate("the Sign in button", absence=True)     # it's there: found
        assert found["path"] == "fast"
        # Without absence the same description goes on to the AI assistant, which always boxes something.
        assert (await hx.locate("the purple elephant"))["box"] == V1_BOX
        assert hx.locator.calls == ["the purple elephant"]
    finally:
        await hx.close()


async def test_visual_pages_use_the_ai_assistant_only(site):
    hx = Harness(FakeV1())
    await hx.open(site + "router/canvas.html")
    try:
        got = await hx.locate("the Save button")     # S0 would have found the toolbar's Save
        assert got["path"] == "visual" and "s0Score" not in got
        assert got["box"] == V1_BOX and hx.locator.calls == ["the Save button"]
        # An absence check on a Visual page has only the AI assistant to ask.
        assert (await hx.locate("the Save button", absence=True))["path"] == "visual"
    finally:
        await hx.close()


async def test_a_page_is_routed_once_and_again_after_it_changes(site, monkeypatch, caplog):
    decided = []
    real = flow_mod.route
    monkeypatch.setattr(flow_mod, "route", lambda e: decided.append(e.count) or real(e))
    hx = Harness(FakeV1())
    await hx.open(site + "fx01_plain/index.html")
    try:
        with caplog.at_level(logging.INFO, logger="breakpatch.locate"):
            for _ in range(3):
                await hx.locate("the Sign in button")
        assert decided == [24]
        line = [r.getMessage() for r in caplog.records if r.getMessage().startswith("locate:")][-1]
        assert "path=fast" in line and "s0=" in line and "candidates=24" in line
        assert "extract=" in line and "score=" in line and "total=" in line
        await hx.engine.browser.page.goto(site + "router/canvas.html")      # navigated: routed again
        assert (await hx.locate("the Save button"))["path"] == "visual"
        await hx.engine.browser.page.evaluate("document.querySelector('canvas').remove()")
        assert (await hx.locate("the Save button"))["path"] == "visual"     # same page, same route
        hx.engine.recorder.finder.invalidate()                              # most of the screen changed
        assert (await hx.locate("the Save button"))["path"] == "fast"
        assert len(decided) == 3
    finally:
        await hx.close()


async def test_a_fast_page_it_can_t_read_this_time_is_never_not_found(site, monkeypatch):
    hx = Harness(FakeV1())
    await hx.open(site + "fx01_plain/index.html")
    try:
        assert (await hx.locate("the Sign in button"))["path"] == "fast"

        async def unreadable():
            return None
        monkeypatch.setattr(hx.engine.recorder.finder, "_extract", unreadable)
        got = await hx.locate("the purple elephant", absence=True)
        assert got["path"] == "visual" and got["box"] == V1_BOX
    finally:
        await hx.close()
