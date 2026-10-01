"""Where a test was recorded, and whether this run is on the same kind of system.

Screen checks compare how an area looks now with how it looked when the step was recorded. The
same page draws its text a little differently on another operating system (other fonts, other
antialiasing) or in another Chromium, so a test recorded on a Mac can fail its checks on Linux
although nothing changed. The app saves `recordedOn` with each recording (engine/PROTOCOL.md
"Where a test was recorded"); a run compares it with `current()`:

- a different OS family (macOS, Linux, Windows), or
- a different Chromium major version

is a mismatch. With "Allow for small differences between systems" on (the default), the run's
screen checks are then relaxed (imaging.region_distance) and the result explains the mismatch.
Tests without `recordedOn` (recorded before it existed) never mismatch.
"""
from __future__ import annotations

import platform
import sys
from pathlib import Path

OS_NAMES = {"darwin": "macOS", "linux": "Linux", "win32": "Windows", "cygwin": "Windows"}
ARCHES = {"aarch64": "arm64", "arm64": "arm64", "amd64": "x86_64", "x86_64": "x86_64", "x64": "x86_64"}
FIELDS = ("os", "osVersion", "arch", "chromium")
MAX_LEN = 40


def os_family() -> str:
    for prefix, name in OS_NAMES.items():
        if sys.platform.startswith(prefix):
            return name
    return platform.system() or "Unknown"


WINDOWS_11_BUILD = 22000


def windows_release() -> tuple[str, int]:
    """("11", 22631) or ("10", 19045). Python 3.11's platform.release() says "10" on Windows 11
    too (both are version 10.0), so the build number decides: 22000 and later is Windows 11."""
    build = 0
    get = getattr(sys, "getwindowsversion", None)
    if get is not None:
        try:
            build = int(get().build)
        except Exception:  # noqa: BLE001
            build = 0
    if not build:
        parts = platform.version().split(".")
        if len(parts) >= 3 and parts[2].isdigit():
            build = int(parts[2])
    release = platform.release() or ""
    if release == "10" and build >= WINDOWS_11_BUILD:
        release = "11"
    return release, build


def os_version() -> str:
    """macOS 15.3 → "15.3"; Linux → the distribution's VERSION_ID ("24.04"), else the kernel;
    Windows → "11" or "10"."""
    if sys.platform == "darwin":
        return platform.mac_ver()[0] or ""
    if sys.platform == "win32":
        return windows_release()[0]
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/etc/os-release").read_text().splitlines():
                if line.startswith("VERSION_ID="):
                    return line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    return platform.release()


def arch() -> str:
    m = platform.machine().lower()
    return ARCHES.get(m, m)


def pinned_chromium() -> str:
    """The Chromium version this engine's Playwright uses ("140.0.7339.16"), or ""."""
    from .install import pinned_browser
    return str(pinned_browser().get("version") or "")


def current(chromium: str | None = None) -> dict:
    """This system, in the shape of a test's `recordedOn`. `chromium` is the running browser's
    version when there is one (BrowserSession.chromium_version), else the pinned one."""
    return {"os": os_family(), "osVersion": os_version(), "arch": arch(),
            "chromium": clean_version(chromium) or pinned_chromium()}


def clean_version(v) -> str:
    """"Chromium 140.0.7339.16" or "HeadlessChrome/140.0…" → "140.0.7339.16"."""
    s = str(v or "").strip()
    for sep in ("/", " "):
        if sep in s:
            s = s.rsplit(sep, 1)[1]
    return s[:MAX_LEN]


def parse(raw) -> dict | None:
    """A test file's `recordedOn`, keeping only the known fields as short strings. None when it's
    missing or unreadable (an older test): such a test never mismatches."""
    if not isinstance(raw, dict):
        return None
    out = {k: str(raw[k])[:MAX_LEN] for k in FIELDS if isinstance(raw.get(k), (str, int, float)) and str(raw[k]).strip()}
    return out if out.get("os") else None


def major(version: str | None) -> str:
    return str(version or "").split(".", 1)[0].strip()


def differences(recorded: dict | None, ran: dict) -> list[str]:
    """What differs in a way that changes how pages look: "os" and/or "chromium"."""
    if not recorded:
        return []
    out = []
    if recorded.get("os", "").lower() != ran.get("os", "").lower():
        out.append("os")
    a, b = major(recorded.get("chromium")), major(ran.get("chromium"))
    if a and b and a != b:
        out.append("chromium")
    return out


def describe(s: dict) -> str:
    """"macOS 15" (the major version only), or "Linux"."""
    name = s.get("os") or "another system"
    if name == "macOS" and major(s.get("osVersion")):
        return f"macOS {major(s.get('osVersion'))}"
    return name


def run_it_on(s: dict) -> str:
    return "a Mac" if s.get("os") == "macOS" else (s.get("os") or "the system it was recorded on")


def explain(recorded: dict, ran: dict, diff: list[str]) -> str:
    """The plain explanation shown with a failed check on a mismatched system."""
    if "os" in diff:
        return (f"This test was recorded on {describe(recorded)} and ran on {describe(ran)}. Text can look slightly "
                "different on another system, which can fail screen checks. Re-record it on this system, or run it "
                f"on {run_it_on(recorded)}.")
    return (f"This test was recorded with Chromium {major(recorded.get('chromium'))} and ran with Chromium "
            f"{major(ran.get('chromium'))}. Pages can look slightly different in another version of the browser, "
            "which can fail screen checks. Re-record it on this system, or run it with the Breakpatch version it "
            "was recorded with.")


def mismatch(recorded_raw, ran: dict, relaxed: bool) -> dict | None:
    """`systemMismatch` for run.ended, or None when the systems match (or the test predates
    `recordedOn`). `relaxed` says whether the screen checks allowed for small differences."""
    recorded = parse(recorded_raw)
    diff = differences(recorded, ran)
    if not diff:
        return None
    return {"recordedOn": recorded, "ranOn": ran, "differences": diff, "relaxed": relaxed,
            "message": explain(recorded, ran, diff)}

