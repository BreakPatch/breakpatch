"""Phone and tablet presets (issue #11): what a test made for a device opens the browser as.

Each preset is a copy of Playwright's device descriptor (playwright.devices[<playwright name>],
Playwright 1.63), pinned here so that a Playwright update can't change the page a test was recorded
on: its viewport, user agent, `is_mobile` and `has_touch`. tests/test_devices.py checks the copies
still match Playwright's own, and match the app's list (app/src/data/devices.ts).

Two things differ from Playwright's descriptors, on purpose:
- The page is always drawn at device scale factor 1. Coordinates and screen checks stay in viewport
  pixels at DPR 1 (PROTOCOL.md), at the device's size. `scale` is the real device's, kept for
  reference only.
- It's Chromium, whatever browser the real device has. An iPhone preset gives the page an iPhone's
  size, user agent and touch screen, drawn by Chromium, not Safari.

A test names its preset in `viewport.device`. Tests without one are desktop tests, as before.
"""
from __future__ import annotations

from dataclasses import dataclass

from .protocol import EngineError


@dataclass(frozen=True)
class Device:
    id: str
    name: str                 # what the app shows: "iPhone 15"
    kind: str                 # "phone" | "tablet"
    playwright: str           # its name in playwright.devices
    width: int
    height: int
    user_agent: str
    scale: float              # the real device's scale factor; the browser uses 1
    mobile: bool = True
    touch: bool = True

    def context_options(self) -> dict:
        """Options for Browser.new_context: Playwright's descriptor, at device scale factor 1."""
        return {"viewport": {"width": self.width, "height": self.height}, "device_scale_factor": 1,
                "user_agent": self.user_agent, "is_mobile": self.mobile, "has_touch": self.touch}


_IOS17 = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
          "Version/26.6 Mobile/15E148 Safari/604.1")
_IPAD = ("Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
         "Version/26.6 Mobile/15E148 Safari/604.1")

# Phones first, then tablets: the order the app lists them in.
DEVICES: dict[str, Device] = {d.id: d for d in (
    Device("iphone-15", "iPhone 15", "phone", "iPhone 15", 393, 659, _IOS17, 3),
    Device("iphone-se", "iPhone SE", "phone", "iPhone SE (3rd gen)", 375, 667,
           "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) "
           "Version/26.6 Mobile/19E241 Safari/602.1", 2),
    Device("pixel-8", "Pixel 8", "phone", "Pixel 8", 412, 839,
           "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/153.0.8010.12 Mobile Safari/537.36", 2.625),
    Device("galaxy-s24", "Galaxy S24", "phone", "Galaxy S24", 360, 780,
           "Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/153.0.8010.12 Mobile Safari/537.36", 3),
    Device("ipad", "iPad", "tablet", "iPad (gen 7)", 810, 1080, _IPAD, 2),
    Device("ipad-pro-11", "iPad Pro 11", "tablet", "iPad Pro 11", 834, 1194, _IPAD, 2),
    Device("galaxy-tab-s9", "Galaxy Tab S9", "tablet", "Galaxy Tab S9", 640, 1024,
           "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/153.0.8010.12 Safari/537.36", 2.5),
)}


def device_for(viewport) -> Device | None:
    """The preset a test's viewport names (`device`), or None for a desktop test (no `device`).
    A name this engine doesn't know is a test from a newer Breakpatch: refused plainly, never run as
    a desktop test by mistake."""
    if not isinstance(viewport, dict):
        return None
    name = viewport.get("device")
    if name is None or name == "":
        return None
    dev = DEVICES.get(name) if isinstance(name, str) else None
    if dev is None:
        raise EngineError("bad_request", "This test is for a phone or tablet this version of Breakpatch doesn't know. "
                                         "Update Breakpatch to run it.", str(name)[:60])
    return dev
