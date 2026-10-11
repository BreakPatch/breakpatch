"""The same element again, from the page's structure (dom/same.py, roadmap #41): what a recorded step
keeps of its element with the switch on (and nothing with it off), and `find` on real pages: one
control with that role and name only, never on another site or in another site's iframe, never on
a Flutter or canvas page. The healing itself is the Team engine's (its test_healing.py)."""
import asyncio
import functools
import http.server
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine import config
from breakpatch_engine.browser import BrowserSession
from breakpatch_engine.config import Timings
from breakpatch_engine.dom import same
from breakpatch_engine.locator import NoLocator
from breakpatch_engine.service import Engine

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}
SAVE_AT = [170, 222]                  # the centre of "Save"
MOVED_AT = [490, 222]                 # where it is once moved
ORIGIN = "http://127.0.0.1:8000"
SAVE = {"role": "button", "name": "Save", "origin": ORIGIN, "offset": [0, 0]}


def cand(role="button", name="Save", box=(420, 200, 560, 244), disabled=False):
    return {"index": 0, "role": role, "name": name, "label": "", "text": name, "box": list(box), "landmark": "",
            "disabled": disabled, "attrs": {}}


# ---------------------------------------------------------------- what a step keeps

def test_a_named_control_is_kept_with_where_the_step_acted_in_it():
    dom = {"role": "button", "name": "Save", "box": [100, 200, 240, 244]}
    assert same.element_of(dom, [150, 230], ORIGIN + "/settings?x=1") == {
        "role": "button", "name": "Save", "origin": ORIGIN, "offset": [-20.0, 8.0]}
    # Its name as element_name keeps it: spaces collapsed, 80 characters at most.
    long = same.element_of({**dom, "name": " Save   all " + "x" * 100}, [150, 230], ORIGIN)
    assert long["name"].startswith("Save all x") and len(long["name"]) == 80


@pytest.mark.parametrize("dom, at, url", [
    ({"role": "dialog", "name": "Edit profile", "box": [0, 0, 400, 400]}, [150, 230], ORIGIN),   # not a control
    ({"role": "button", "name": "  ", "box": [100, 200, 240, 244]}, [150, 230], ORIGIN),        # no name
    ({"role": "button", "name": "Save"}, [150, 230], ORIGIN),                                    # no box
    ({"role": "button", "name": "Save", "box": [100, 200, 240, 244]}, [300, 230], ORIGIN),      # not in it
    ({"role": "button", "name": "Save", "box": [100, 200, 240, 244]}, [150, 230], "about:blank"),
    (None, [150, 230], ORIGIN),
    ({"role": "button", "name": "Save", "box": [100, 200, 240, 244]}, None, ORIGIN),
])
def test_anything_else_keeps_nothing(dom, at, url):
    assert same.element_of(dom, at, url) is None


@pytest.mark.parametrize("element, ok", [
    (SAVE, True),
    ({**SAVE, "role": "dialog"}, False), ({**SAVE, "name": " "}, False), ({**SAVE, "name": 3}, False),
    ({**SAVE, "origin": "https://a.example/path"}, False), ({**SAVE, "origin": "file:///x"}, False),
    ({**SAVE, "offset": [1]}, False), ({**SAVE, "offset": ["1", 2]}, False), ({**SAVE, "offset": [True, 0]}, False),
    ({**SAVE, "offset": [1e9, 0]}, False), ({k: v for k, v in SAVE.items() if k != "origin"}, False),
    ("Save", False), (None, False),
])
def test_a_saved_element_is_checked_before_it_is_used(element, ok):
    assert same.usable(element) is ok


# ---------------------------------------------------------------- matching

def test_one_control_with_that_role_and_name_is_the_one():
    c, why = same.match(SAVE, [cand(name="Cancel"), cand(), cand(role="link")], [ORIGIN] * 3)
    assert why == "found" and c["name"] == "Save" and c["role"] == "button"
    # Case and runs of spaces aside, nothing more: "Save " is Save, "Save all" isn't.
    assert same.match(SAVE, [cand(name=" SAVE ")], [ORIGIN])[1] == "found"
    assert same.match(SAVE, [cand(name="Save all"), cand(name="Sav")], [ORIGIN] * 2)[0] is None


def test_two_with_that_role_and_name_is_never_a_guess():
    c, why = same.match(SAVE, [cand(), cand(box=(420, 120, 560, 164))], [ORIGIN] * 2)
    assert c is None and why == "2 controls with that role and name"
    # Even when the other one is in another site's frame.
    assert same.match(SAVE, [cand(), cand()], [ORIGIN, "http://localhost:8000"])[0] is None


def test_never_one_in_another_sites_frame():
    assert same.match(SAVE, [cand()], ["http://localhost:8000"]) == (None, "it's in another site's frame")
    assert same.match(SAVE, [cand()], [None])[0] is None and same.match(SAVE, [cand()], None)[0] is None


def test_never_a_disabled_one_and_never_another_role():
    assert same.match(SAVE, [cand(disabled=True)], [ORIGIN]) == (None, "it's disabled")
    assert same.match(SAVE, [cand(role="link")], [ORIGIN]) == (None, "no control with that role and name")


# ---------------------------------------------------------------- on real pages

@pytest.fixture(scope="module")
def site():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def find(url, element):
    async def go():
        b = BrowserSession(Timings.fast())
        try:
            await b.open(url, VIEWPORT)
            await asyncio.sleep(0.3)          # the other site's iframe
            return await same.find(b, element)
        finally:
            await b.close()
    return asyncio.run(go())


def save(site, offset=(0, 0)):
    return {**SAVE, "origin": site, "offset": list(offset)}


@needs_browser
def test_a_moved_button_is_found_where_the_step_acted_in_it(site):
    got = find(site + "/heal.html?moved=1", save(site, (-30, 5)))
    assert got.why == "found" and got.box == [420, 200, 560, 244]
    assert got.at == [MOVED_AT[0] - 30, MOVED_AT[1] + 5]
    # Kept inside the control, whatever the offset says.
    assert find(site + "/heal.html?moved=1", save(site, (500, -500))).at == [559, 201]


@needs_browser
@pytest.mark.parametrize("query, why", [
    ("twice=1", "2 controls with that role and name"),
    ("elsewhere=1", "it's in another site's frame"),
    ("renamed=1", "no control with that role and name"),
    ("gone=1", "no control with that role and name"),
    ("off=1", "it's disabled"),
    ("moved=1&flutter=1", "not a page to trust its structure (flutter)"),
    ("moved=1&canvas=1", "not a page to trust its structure (canvas 0.50)"),
])
def test_nothing_is_found_when_it_isnt_certain(site, query, why):
    got = find(site + "/heal.html?" + query, save(site))
    assert (got.at, got.box, got.why) == (None, None, why)


@needs_browser
def test_never_on_another_site(site):
    other = site.replace("127.0.0.1", "localhost")
    got = find(other + "/heal.html?moved=1", save(site))
    assert got.at is None and got.why == "the page is on another site"
    assert find(site + "/heal.html?moved=1", {"name": "Save"}).why == "the step has no element to look for"


# ---------------------------------------------------------------- recording, with the switch on and off

class Recorder:
    def __init__(self):
        self.engine = Engine(lambda e, d: None, timings=Timings.fast(), locator_fn=lambda: NoLocator(), healer=None)
        self.h = self.engine.handlers()

    async def record(self, url, **p):
        await self.h["browser.open"]({"url": url, "viewport": VIEWPORT})
        try:
            return (await self.h["record.point"](p))["step"]
        finally:
            await self.h["browser.close"]({})


def record(url, **p):
    return asyncio.run(Recorder().record(url, **p))


@needs_browser
def test_with_the_switch_off_a_step_keeps_no_element(site, monkeypatch):
    monkeypatch.setattr(config, "HEAL_FROM_STRUCTURE", False)
    step = record(site + "/heal.html", action="click", at=SAVE_AT)
    assert "element" not in step and step["label"] == "Click Save button"


@needs_browser
def test_with_the_switch_on_a_step_keeps_its_element(site, monkeypatch):
    monkeypatch.setattr(config, "HEAL_FROM_STRUCTURE", True)
    step = record(site + "/heal.html", action="click", at=[150, 230])
    assert step["element"] == {"role": "button", "name": "Save", "origin": site, "offset": [-20.0, 8.0]}
    assert step["label"] == "Click Save button"
    # A label the app gives doesn't change what's kept.
    step = record(site + "/heal.html", action="click", at=SAVE_AT, label="Save the settings")
    assert step["label"] == "Save the settings" and step["element"]["name"] == "Save"
    # Not a control (the heading): nothing kept, and the step is as before.
    step = record(site + "/heal.html", action="click", at=[300, 72])
    assert "element" not in step and "pre" in step
