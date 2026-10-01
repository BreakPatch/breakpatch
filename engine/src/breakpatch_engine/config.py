"""Paths and timings. Every path can be overridden with an environment variable (tests do)."""
from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, fields, replace
from pathlib import Path


def is_release() -> bool:
    """True in a packaged sidecar (PyInstaller sets `sys.frozen`, Nuitka `__compiled__`): the
    development switches below (`BP_NO_SANDBOX`, `HF_ENDPOINT`, `HF_TOKEN`) are ignored there."""
    return bool(getattr(sys, "frozen", False)) or "__compiled__" in globals()


def dev_env(name: str) -> str | None:
    """An environment variable that only development runs may use; None in a release build."""
    if is_release():
        return None
    return os.environ.get(name) or None


def app_home() -> Path:
    """Base folder for everything the engine keeps on disk."""
    env = os.environ.get("BP_HOME")
    if env:
        return Path(env).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Breakpatch"
    if sys.platform == "win32":
        # Local, not Roaming, AppData: the browser and the model are big and belong to this PC
        # (the shell's `$LOCALDATA` / local_data_dir() is the same folder).
        local = os.environ.get("LOCALAPPDATA")
        return (Path(local) if local else Path.home() / "AppData" / "Local") / "Breakpatch"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "Breakpatch"


def models_dir() -> Path:
    env = os.environ.get("BP_MODELS_DIR")
    return Path(env).expanduser() if env else app_home() / "models"


def browsers_dir() -> Path:
    """Where Playwright's Chromium lives. An existing PLAYWRIGHT_BROWSERS_PATH wins (developer machines, CI)."""
    env = os.environ.get("BP_BROWSERS_PATH") or os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    return Path(env).expanduser() if env else app_home() / "browsers"


def screenshots_dir() -> Path:
    """Failure and heal screenshots, kept locally for the report (spec §11.6)."""
    env = os.environ.get("BP_SCREENSHOTS_DIR")
    return Path(env).expanduser() if env else app_home() / "screenshots"


def chromium_executable() -> str | None:
    """Explicit Chromium binary (development only). Normally Playwright finds its pinned build."""
    return os.environ.get("BP_CHROMIUM") or None


def chromium_sandbox() -> bool:
    """Chromium's own sandbox: always on in a release build and on macOS. Development runs can turn
    it off with `BP_NO_SANDBOX=1`. On Linux, which is only for development and CI (the app ships for
    macOS), it's off unless `BP_SANDBOX=1`: containers and CI runners can't start it (no user
    namespaces, or running as root)."""
    if is_release():
        return True
    if os.environ.get("BP_NO_SANDBOX") == "1":
        return False
    if sys.platform.startswith("linux"):
        return os.environ.get("BP_SANDBOX") == "1"
    return True


def apply_browser_env() -> None:
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(browsers_dir())


# BP_TIMINGS_SCALE (a Raspberry Pi or another slow machine, docs/manual.md "Raspberry Pi runner"):
# these waits are multiplied by it. They're the ones a slow machine runs out of: a page that takes
# longer to settle, a pre-check that needs more tries, a slower start page. The noise watch and
# the frame spacing aren't: they're sample counts and intervals, and stretching them only makes
# every step slower without making a check more likely to pass.
SCALED_TIMINGS = ("settle_timeout", "pre_wait", "navigate_timeout", "start_timeout")
MAX_TIMINGS_SCALE = 10.0


def timings_scale(env=None) -> float:
    """BP_TIMINGS_SCALE as a number from 1 to 10 (default 1). Anything else is ignored, with a warning."""
    raw = (os.environ if env is None else env).get("BP_TIMINGS_SCALE", "").strip()
    if not raw:
        return 1.0
    try:
        value = float(raw)
    except ValueError:
        value = float("nan")
    if not 1.0 <= value <= MAX_TIMINGS_SCALE:     # also false for nan
        logging.getLogger("breakpatch.config").warning(
            "BP_TIMINGS_SCALE=%r ignored: it's a number from 1 to %g", raw, MAX_TIMINGS_SCALE)
        return 1.0
    return value


@dataclass(frozen=True)
class Timings:
    """All waits in seconds. The app chooses them (spec §5.7); tests shrink them."""
    noise_watch: float = 2.5          # §10.3.1 watch before an action
    noise_interval: float = 0.25
    settle_interval: float = 0.15     # §11.1.3 frame spacing while settling
    settle_frames: int = 3            # identical consecutive frames needed
    settle_timeout: float = 8.0
    late_change: float = 1.5         # recording: how long to wait for a delayed result when nothing changed
    pre_wait: float = 3.0             # how long replay keeps retrying a pre-check before giving up
    pre_interval: float = 0.2
    long_click: float = 0.8
    popup_timeout: float = 10.0
    chooser_timeout: float = 5.0
    download_timeout: float = 15.0
    navigate_timeout: float = 30.0
    start_timeout: float = 15.0       # the start page (browser.open, a run's startUrl)
    chooser_window: float = 3.0       # recording: how long after a click a page's file picker may still open
    http_timeout: float = 30.0
    reload_diff: bool = True          # §10.3.5 background reload while recording
    frame_min_gap: float = 0.1        # at most ~10 frames per second

    @classmethod
    def from_env(cls) -> "Timings":
        t = cls.fast() if os.environ.get("BP_FAST") == "1" else cls()
        return t.scaled(timings_scale())

    def scaled(self, factor: float) -> "Timings":
        """The waits a slow machine needs longer for (SCALED_TIMINGS), times `factor`."""
        if factor == 1:
            return self
        return replace(self, **{k: getattr(self, k) * factor for k in SCALED_TIMINGS})

    @classmethod
    def fast(cls) -> "Timings":
        return cls(noise_watch=0.5, noise_interval=0.1, settle_interval=0.08, settle_timeout=3.0,
                   late_change=0.6, pre_wait=0.6, pre_interval=0.1, long_click=0.3, popup_timeout=3.0, chooser_timeout=2.0,
                   download_timeout=3.0, navigate_timeout=10.0, start_timeout=3.0, chooser_window=1.5, http_timeout=5.0)

    def with_(self, **kw) -> "Timings":
        names = {f.name for f in fields(self)}
        return replace(self, **{k: v for k, v in kw.items() if k in names})


# Check sizes and tolerances (spec §12.1 example values).
PRE_RADIUS = 32         # pre-check region is a 64 x 64 box around the target
FRAMES_KEPT = 200       # live view frames kept for that check (20 s of a page that changes all the time)
CHOOSE_FILE_TIMEOUT = 600.0   # recording: how long a page's file picker waits for the user's choice
NOISE_MAX_SHARE = 0.25   # a noise zone bigger than this share of the screen isn't noise (DESK-01)
MIN_CHECKED = 0.1        # a check must leave at least this share of its region to compare
LOCATE_MAX_SHARE = 0.6   # record.locate: a box over more of the page than this is "not found"
PROPOSE_MAX_SHARE = 0.12 # record.propose: a box bigger than this share isn't the control's
SEEN_RADIUS = 48        # recording: the 96 x 96 box around a click that must still look as the user saw it
PRE_TOLERANCE = 6
POST_TOLERANCE = 10
POST_CLOSER = 4           # replay: or it must come this much closer (hash bits) to the recorded result
GONE_DISTANCE = 20          # replay: "clearly gone" means this far (hash bits) from the screen before the step
GONE_SHARE = 0.5            # ... with at least this share of the change seen when recorded
POST_CHANGE_SHARE = 0.25   # replay: a step must change at least this share of what it changed when recorded
CHECKPOINT_TOLERANCE = 8
BOX_PAD = 16            # padding around changed areas
BLINK_MAX_AREA = 2500   # settle: a spot this small (50 x 50 px) that keeps changing is a caret or spinner
SETTLE_THRESHOLD = 8    # settle: screenshots of a still page are identical, so a small, slow change still counts
DIFF_THRESHOLD = 24     # per-channel difference that counts as "changed"

# A test recorded on another kind of system (systems.py: another OS family or Chromium major) with
# "Allow for small differences between systems" on: each screen check compares the area at the
# recorded spot and one pixel around it, sharp and lightly blurred, and takes the closest
# (imaging.region_distance), then allows RELAXED_EXTRA more bits on top of the step's tolerance.
# That absorbs text drawn a pixel off or with other antialiasing; a missing button or other
# words still differ by far more (tests/test_imaging.py).
RELAXED_SHIFT = 1       # px
RELAXED_EXTRA = 2       # bits


def check_tolerance(tolerance: int, relaxed: bool) -> int:
    """The Hamming distance a screen check allows: the step's own, plus RELAXED_EXTRA when relaxed."""
    return int(tolerance) + (RELAXED_EXTRA if relaxed else 0)
