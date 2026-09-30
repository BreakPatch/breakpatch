"""A described step's meaning and its target: record.intent (the AI assistant's reading, when the
app's own can't decide) and record.locate's `near` (the "+" or "−" next to something, for "add 2
people")."""
import pytest

import domsite
from conftest import needs_browser
from breakpatch_engine.config import Timings
from breakpatch_engine.dom import near
from breakpatch_engine.locator import INTENT_PROMPT, NoLocator, parse_intent
from breakpatch_engine.protocol import NULL
from breakpatch_engine.service import Engine, near_param

V1_BOX = [700, 500, 760, 540]


# ---------------------------------------------------------------- record.intent's reply


def test_the_ai_assistant_s_reading_of_a_step():
    assert parse_intent('{"action": "click", "target": "the + next to People", "times": 2, "text": null}') == {
        "action": "click", "repeat": 2, "target": "the + next to People"}
    assert parse_intent('Sure: {"action": "type", "target": "Search", "times": 1, "text": "hello"}') == {
        "action": "write", "repeat": 1, "target": "Search", "text": "hello"}
    assert parse_intent('{"action": "Double-click", "target": "Row 3"}') == {"action": "doubleClick", "repeat": 1, "target": "Row 3"}
    assert parse_intent('{"action": "scroll", "target": null, "direction": "down"}') == {"action": "scroll", "repeat": 1, "direction": "down"}
    assert parse_intent('{"action": "wait", "seconds": 3}') == {"action": "waitFor", "repeat": 1, "seconds": 3}


def test_replies_that_are_not_an_answer_are_none():
    assert parse_intent("") is None
    assert parse_intent("I can't tell") is None
    assert parse_intent('{"action": "dance", "target": "x"}') is None          # not an action the recorder has
    assert parse_intent('{"action": "click", "target": "..."}') is None        # the prompt's own placeholder
    assert parse_intent('{"action": "type", "target": "Search"}') is None      # nothing to type
    assert parse_intent('{"action": "wait", "seconds": 9999}') is None
    got = parse_intent('{"action": "click", "target": "Next", "times": 500}')
    assert got == {"action": "click", "repeat": 1, "target": "Next"}           # an unlikely count is ignored
    assert '"{sentence}"' in INTENT_PROMPT


def test_near_is_read_strictly():
    assert near_param({"control": "increase", "of": "  People "}) == {"control": "increase", "of": "People"}
    assert near_param({"control": "sideways", "of": "People"}) is None
    assert near_param({"control": "decrease", "of": ""}) is None
    assert near_param("People") is None and near_param(None) is None


async def test_without_the_ai_assistant_intent_is_null_not_an_error():
    e = Engine(lambda *_: None, timings=Timings.fast(), locator_fn=NoLocator, healer=None)
    assert await e.handlers()["record.intent"]({"sentence": "log out"}) is NULL


# ---------------------------------------------------------------- near.py without a page


def c(i, box, name="", text="", role="button", **kw):
    return {"index": i, "role": role, "name": name, "label": kw.get("label", ""), "text": text, "box": box,
            "landmark": "", "disabled": kw.get("disabled", False), "attrs": kw.get("attrs", {})}


def test_what_counts_as_a_plus_or_a_minus():
    assert near.kind_of(c(0, [0, 0, 1, 1], text="+")) == "increase"
    assert near.kind_of(c(0, [0, 0, 1, 1], text="−")) == "decrease"
    assert near.kind_of(c(0, [0, 0, 1, 1], text="-")) == "decrease"
    assert near.kind_of(c(0, [0, 0, 1, 1], name="Increase adults", text="+")) == "increase"
    assert near.kind_of(c(0, [0, 0, 1, 1], name="Remove a person")) is None          # only for people
    assert near.kind_of(c(0, [0, 0, 1, 1], name="Add to cart")) is None
    assert near.kind_of(c(0, [0, 0, 1, 1], name="More")) == "increase"
    assert near.kind_of(c(0, [0, 0, 1, 1], name="More options")) is None           # a menu
    assert near.kind_of(c(0, [0, 0, 1, 1], name="Add this item to my shopping cart now")) is None
    assert near.kind_of(c(0, [0, 0, 1, 1], name="Sign up")) is None
    assert near.kind_of(c(0, [0, 0, 1, 1], text="+", disabled=True)) is None


def test_the_plus_next_to_the_thing_not_the_minus_or_another_row():
    cands = [c(0, [200, 100, 236, 136], text="−"), c(1, [290, 100, 326, 136], text="+"),
             c(2, [200, 200, 236, 236], text="−"), c(3, [290, 200, 326, 236], text="+")]
    texts = [{"text": "Adults", "box": [40, 108, 120, 128]}, {"text": "People", "box": [40, 208, 120, 228]}]
    assert near.stepper("increase", "people", cands, texts)["index"] == 3
    assert near.stepper("decrease", "People", cands, texts)["index"] == 2
    assert near.stepper("increase", "adults", cands, texts)["index"] == 1
    assert near.stepper("increase", "Children", cands, texts) is None          # nothing called that
    far = [{"text": "People", "box": [1000, 800, 1080, 820]}]
    assert near.stepper("increase", "People", cands, far) is None              # too far away to be its own
    assert near.stepper("sideways", "People", cands, texts) is None
    # A control that names the thing ("Add adult") is its "+" wherever it is; "Add to cart" never is.
    named = [c(4, [900, 600, 1000, 640], name="Add adult"), c(5, [40, 240, 140, 270], name="Add to cart")] + cands
    assert near.stepper("increase", "adults", named, texts)["index"] == 4
    assert near.stepper("increase", "people", named, texts)["index"] == 3


# ---------------------------------------------------------------- on a page


class FakeV1:
    def __init__(self, box=V1_BOX):
        self.box, self.calls = box, []

    def available(self):
        return True

    async def locate(self, image, description):
        self.calls.append(description)
        return self.box

    async def describe(self, image, at):
        return None

    async def intent(self, image, sentence):
        self.calls.append(("intent", sentence, image.size))
        return {"action": "click", "repeat": 1, "target": "the Log out button"}


@pytest.fixture(scope="module")
def site():
    base, stop = domsite.serve()
    yield base
    stop()


@needs_browser
async def test_add_2_people_finds_the_plus_by_people_from_the_page_structure(site):
    v1 = FakeV1()
    e = Engine(lambda *_: None, timings=Timings.fast(), locator_fn=lambda: v1, healer=None)
    h = e.handlers()
    await h["browser.open"]({"url": site + "near/stepper.html", "viewport": domsite.VIEWPORT})
    try:
        page = e.browser.page

        async def centre(sel):
            bb = await (await page.query_selector(sel)).bounding_box()
            return [round(bb["x"] + bb["width"] / 2, 1), round(bb["y"] + bb["height"] / 2, 1)]

        desc = 'the "+" button next to "People"'
        got = await h["record.locate"]({"description": desc, "near": {"control": "increase", "of": "People"}})
        assert got["path"] == "fast" and got["target"] == desc
        assert got["at"] == await centre('[data-for=people][data-d="1"]')
        got = await h["record.locate"]({"description": "x", "near": {"control": "decrease", "of": "people"}})
        assert got["at"] == await centre('[data-for=people][data-d="-1"]')
        got = await h["record.locate"]({"description": "x", "near": {"control": "increase", "of": "Adults"}})
        assert got["at"] == await centre('[aria-label="Increase adults"]')
        got = await h["record.locate"]({"description": "x", "near": {"control": "increase", "of": "Rooms"}})
        assert got["at"] == await centre('[data-for=rooms][data-d="1"]')       # a div with role=button
        assert v1.calls == []                                                     # never the model
        # Nothing called that: the AI assistant looks for the description instead.
        got = await h["record.locate"]({"description": 'the "+" button next to "Children"', "near": {"control": "increase", "of": "Children"}})
        assert got["path"] == "fast-visual" and got["box"] == V1_BOX
        assert v1.calls == ['the "+" button next to "Children"']
        # Without `near` S0 answers as before.
        assert (await h["record.locate"]({"description": "the Sign up button"}))["path"] == "fast"
        # record.intent asks the AI assistant with the screen.
        assert await h["record.intent"]({"sentence": "log out"}) == {"action": "click", "repeat": 1, "target": "the Log out button"}
        assert v1.calls[-1] == ("intent", "log out", (1440, 900))
    finally:
        await h["browser.close"]({})
