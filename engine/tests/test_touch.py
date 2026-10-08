"""Phone and tablet tests (issue #11) against a page that only answers touch (site/touch.html), with
real headless Chromium: the device's screen, taps, double taps, long presses, swipes and scrolls, in
recording, replay and "Use the page"."""
import asyncio
import functools
import http.server
import threading

import pytest

from conftest import needs_browser
from test_e2e import Handler, Harness, SITE
from breakpatch_engine import labels
from breakpatch_engine.actions import Context, perform
from breakpatch_engine.config import Timings
from breakpatch_engine.protocol import EngineError

pytestmark = needs_browser

PHONE = {"width": 393, "height": 659, "dpr": 1, "device": "iphone-15"}
TAP, PRESS, SWIPE = [170, 60], [170, 160], [250, 260]      # the centres of the three boxes


@pytest.fixture(scope="module")
def site():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/touch.html"
    srv.shutdown()


async def _log(hx):
    return await hx.engine.browser.page.evaluate("window.log")


async def _open(hx, url, viewport=PHONE):
    await hx.call("browser.open", {"url": url, "viewport": viewport})
    return hx.engine.browser


async def test_a_phone_test_opens_as_the_phone_at_scale_1(site):
    hx = Harness()
    b = await _open(hx, site, {"width": 1440, "height": 900, "device": "iphone-15"})   # the preset's size wins
    try:
        assert b.touch and (b.width, b.height) == (393, 659)
        got = await b.page.evaluate("""() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent,
            coarse: matchMedia('(pointer: coarse)').matches, points: navigator.maxTouchPoints })""")
        assert (got["w"], got["h"], got["dpr"]) == (393, 659, 1)
        assert "iPhone" in got["ua"] and got["coarse"] and got["points"] > 0
        assert (await b.shoot()).shape == (659, 393, 3)                # screen checks: viewport px at DPR 1
        await asyncio.sleep(0.3)
        frame = hx.of("frame")[-1]
        assert (frame["width"], frame["height"]) == (393, 659)
    finally:
        await hx.call("browser.close")


async def test_a_desktop_test_has_no_touch_and_mouse_clicks_dont_tap(site):
    hx = Harness()
    b = await _open(hx, site, {"width": 800, "height": 600})
    try:
        assert not b.touch and b.device is None
        assert await b.page.evaluate("navigator.maxTouchPoints") == 0
        await perform(b, {"action": "click", "at": TAP}, Context(Timings.fast()))
        log = await _log(hx)
        assert log["taps"] == 0 and log["mouseOnly"] == 1             # the page ignores the mouse
    finally:
        await hx.call("browser.close")


async def test_a_device_this_engine_doesnt_know_is_refused(site):
    hx = Harness()
    with pytest.raises(EngineError) as e:
        await _open(hx, site, {"width": 400, "height": 800, "device": "phone-from-the-future"})
    assert e.value.code == "bad_request" and "Update Breakpatch" in e.value.message
    assert not hx.engine.browser.is_open


async def test_steps_are_touch_on_a_phone(site):
    hx = Harness()
    b = await _open(hx, site)
    ctx = Context(Timings.fast())
    try:
        await perform(b, {"action": "click", "at": TAP}, ctx)
        await asyncio.sleep(0.5)                                        # not a double tap with the next
        await perform(b, {"action": "doubleClick", "at": TAP}, ctx)
        await perform(b, {"action": "longClick", "at": PRESS}, ctx)
        await perform(b, {"action": "swipe", "from": SWIPE, "direction": "left", "distance": 200}, ctx)
        log = await _log(hx)
        assert log["taps"] == 3 and log["doubles"] == 1 and log["presses"] == 1
        assert log["swipes"] == ["left"]
        assert log["mouseOnly"] == 0 and set(log["pointers"]) == {"touch"}
        await perform(b, {"action": "scroll", "from": [200, 500], "direction": "down", "distance": 400}, ctx)
        y = await b.page.evaluate("scrollY")
        assert 300 <= y <= 450, y
        # Longer than the screen: several strokes, and no fling after them.
        await perform(b, {"action": "scroll", "from": [200, 300], "direction": "down", "distance": 1500}, ctx)
        await asyncio.sleep(0.4)
        y2 = await b.page.evaluate("scrollY")
        assert 1300 <= y2 - y <= 1550, (y, y2)
        await perform(b, {"action": "scroll", "from": [200, 300], "direction": "up", "distance": 300}, ctx)
        assert 200 <= y2 - await b.page.evaluate("scrollY") <= 320
    finally:
        await hx.call("browser.close")


async def test_a_recorded_tap_is_named_a_tap_and_replays(site):
    hx = Harness()
    await _open(hx, site)
    try:
        step = (await hx.call("record.point", {"action": "click", "at": TAP}))["step"]
        assert step["label"].startswith("Tap ") and "click" not in step["label"].lower()
        assert step["action"] == "click" and step["at"] == TAP
        named = (await hx.call("record.point", {"action": "longClick", "at": PRESS, "label": "Click and hold"}))["step"]
        assert named["label"] == "Click and hold"                    # the person's own words stay
        assert (await _log(hx))["presses"] == 1
    finally:
        await hx.call("browser.close")
    ended = await hx.run([step], site, viewport=PHONE)
    assert ended["result"] == "pass", ended
    # The same step on a desktop: the mouse click doesn't tap, so nothing changes and it fails.
    ended = await hx.run([step], site, viewport={"width": 393, "height": 659})
    assert ended["result"] == "fail"


async def test_using_a_phone_page_by_hand_is_touch(site):
    hx = Harness()
    b = await _open(hx, site)
    try:
        await hx.call("browser.hand", {"on": True})
        await hx.call("browser.input", {"kind": "click", "at": TAP})
        await hx.call("browser.input", {"kind": "down", "at": SWIPE})
        for x in (220, 180, 120, 60):
            await hx.call("browser.input", {"kind": "move", "at": [x, SWIPE[1]]})
        await hx.call("browser.input", {"kind": "up", "at": [60, SWIPE[1]]})
        await hx.call("browser.input", {"kind": "move", "at": [10, 10]})   # no finger down: nothing
        log = await _log(hx)
        assert log["taps"] == 1 and log["swipes"] == ["left"] and log["mouseOnly"] == 0
        assert hx.of("record.checking") == []
    finally:
        await hx.call("browser.close")


async def test_done_with_a_finger_still_down_lifts_it(site):
    """"Done" (Use the page off) while the person still holds the mouse button: the page gets a
    touchcancel, so it isn't left with a finger down (a long press that fires, a drag that sticks)."""
    hx = Harness()
    b = await _open(hx, site)
    try:
        await hx.call("browser.hand", {"on": True})
        await hx.call("browser.input", {"kind": "down", "at": PRESS})
        await hx.call("browser.hand", {"on": False})
        assert (await _log(hx))["cancels"] == 1          # the finger came up
        await b.tap(TAP)                               # the next touch starts clean
        assert (await _log(hx))["taps"] == 1
    finally:
        await hx.call("browser.close")


async def test_a_gesture_stopped_part_way_lifts_its_finger(site):
    """A long press or a drag that's stopped (the step's run stopped, the page went away) still
    lets go, so the next step doesn't start with a finger down."""
    hx = Harness()
    b = await _open(hx, site)
    try:
        press = asyncio.ensure_future(b.long_press(PRESS, 30.0))
        await asyncio.sleep(0.1)
        press.cancel()
        with pytest.raises(asyncio.CancelledError):
            await press
        assert (await _log(hx))["ends"] == 1                 # the finger came up

        drag = asyncio.ensure_future(b.touch_drag(SWIPE, [SWIPE[0] - 200, SWIPE[1]], steps=2000))
        await asyncio.sleep(0.3)
        drag.cancel()
        with pytest.raises(asyncio.CancelledError):
            await drag
        log = await _log(hx)
        assert log["ends"] == 2 and len(log["swipes"]) == 1  # it let go where it was
    finally:
        await hx.call("browser.close")


def test_a_finger_stroke_stays_on_the_screen():
    from breakpatch_engine.browser import _stroke_share
    assert _stroke_share([200, 500], [0, 400], (393, 659)) == 1          # moves up from 500 to 100
    assert _stroke_share([200, 300], [0, 580], (393, 659)) == 290 / 580   # reaches the top edge (10 px)
    assert _stroke_share([200, 300], [0, -400], (393, 659)) == (659 - 10 - 300) / 400
    assert _stroke_share([200, 300], [0, 0], (393, 659)) == 1


def test_touch_words():
    w = labels.touch_words
    assert w({"label": "Click Sign in", "target": "Sign in button"})["label"] == "Tap Sign in"
    assert w({"label": "Double click Row 3"})["label"] == "Double tap Row 3"
    assert w({"label": "Long click the spot you clicked", "target": "The spot you clicked, near the middle of the page"}) == {
        "label": "Long press the spot you tapped", "target": "The spot you tapped, near the middle of the page"}
    assert w({"label": "Swipe left"})["label"] == "Swipe left"
    assert w({"label": "Clicker game"})["label"] == "Clicker game"
