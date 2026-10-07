"""Phone and tablet presets (devices.py): pinned copies of Playwright's device descriptors, the same
list as the app's (app/src/data/devices.ts), and how a test's viewport picks one."""
import re
from pathlib import Path

import pytest

from breakpatch_engine.devices import DEVICES, device_for
from breakpatch_engine.protocol import EngineError

APP_DEVICES = Path(__file__).resolve().parents[2] / "app" / "src" / "data" / "devices.ts"


def test_presets_match_playwright_s_descriptors():
    """A Playwright update that changes a device fails here, so the change is made on purpose (a
    test recorded on the old size or user agent would no longer match its screen checks)."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        known = p.devices
    for d in DEVICES.values():
        pw = known[d.playwright]
        assert pw["viewport"] == {"width": d.width, "height": d.height}, d.id
        assert pw["user_agent"] == d.user_agent, d.id
        assert (pw["is_mobile"], pw["has_touch"], pw["device_scale_factor"]) == (d.mobile, d.touch, d.scale), d.id


def test_presets_are_drawn_at_scale_1():
    for d in DEVICES.values():
        opts = d.context_options()
        assert opts["device_scale_factor"] == 1 and opts["has_touch"] and opts["is_mobile"]
        assert opts["viewport"] == {"width": d.width, "height": d.height}


def test_phones_come_first_and_ids_are_plain():
    kinds = [d.kind for d in DEVICES.values()]
    assert kinds == sorted(kinds, key=["phone", "tablet"].index) and "phone" in kinds and "tablet" in kinds
    assert all(re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", k) for k in DEVICES)


@pytest.mark.skipif(not APP_DEVICES.exists(), reason="the app isn't next to the engine")
def test_the_app_lists_the_same_presets():
    text = APP_DEVICES.read_text(encoding="utf-8")
    rows = re.findall(r"\{ id: '([^']+)', name: '([^']+)', kind: '(phone|tablet)', width: (\d+), height: (\d+) \}", text)
    assert [(i, n, k, int(w), int(h)) for i, n, k, w, h in rows] == [
        (d.id, d.name, d.kind, d.width, d.height) for d in DEVICES.values()]


def test_a_viewport_picks_its_device():
    assert device_for({"width": 1440, "height": 900}) is None            # every test made before presets
    assert device_for({"width": 1440, "height": 900, "dpr": 1, "device": None}) is None
    assert device_for(None) is None
    assert device_for({"device": "pixel-8"}).name == "Pixel 8"
    for bad in ("nokia-3310", 7, {"id": "ipad"}):
        with pytest.raises(EngineError) as e:
            device_for({"device": bad})
        assert e.value.code == "bad_request"
