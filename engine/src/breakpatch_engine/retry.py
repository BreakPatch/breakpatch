"""Retrying a failed test (roadmap #14): which failures may pass on another try, and how many tries.

A retry runs the whole test again from the start, in a new browser, with its set-up and clean-up
calls, exactly as the first try did. A single step is never done again on its own: its action may
already have changed the page (a click that toggles something), so only a fresh start is safe.

Only failures that look like timing are retried, and a retry never hides a failure: the run says
which try passed, and every earlier try's failure stays on its step (`retried`, engine/PROTOCOL.md
"Retries"). Retried:

- `timeout`: the screen didn't settle, the start page didn't load, a popup, file picker or
  download didn't come in time (a slow server, a network blip);
- `noChange`: the step was done but nothing happened (often a click before the page was ready);
- `targetNotFound` and `unexpectedScreen`, only when the screen check was close: at most NEAR
  bits past the check's tolerance. Far off means the page really is different, which another try
  won't change.

Never retried: a missing or refused saved secret, a set-up call that didn't succeed, a run that was
stopped, the AI assistant missing or finding the wrong thing, a file that isn't in the tests folder,
and anything that went wrong inside the engine.

Bounded twice: at most MAX_RETRIES retries (the run's `settings.retries`, 0 to 2), and no retry
starts once the run has taken `Timings.retry_budget` seconds (5 minutes, longer on a slow machine:
it's one of config.SCALED_TIMINGS).
"""
from __future__ import annotations

from . import config

MAX_RETRIES = 2
# How far past its tolerance (hash bits) a failed screen check may be and still count as close: a
# page caught a moment early (a late image, a fade, a caret) differs by a few bits; another page,
# other words or a missing button differ by far more (tests/test_imaging.py).
NEAR = 4

# Failures another try can't fix, whatever their numbers.
NEVER = frozenset({"secretMissing", "setUpFailed", "stopped", "healingUnavailable", "healFailed", "fileMissing"})
# Failures that may be timing, some only when their check was close (why_retry).
RETRIED = frozenset({"timeout", "noChange", "targetNotFound", "unexpectedScreen"})

WHY = {
    "timeout": "the page was slow",
    "noChange": "nothing happened, maybe the page wasn't ready yet",
    "targetNotFound": "what it acts on was almost where it was recorded",
    "unexpectedScreen": "the screen almost matched",
}


def retries_setting(value) -> int:
    """`settings.retries` as a whole number from 0 to MAX_RETRIES; anything else is 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if value != value:          # nan
        return 0
    return max(0, min(MAX_RETRIES, int(value)))


def tolerance(step: dict | None, check: str, relaxed: bool = False) -> int:
    """The tolerance a step's `pre` or `post` check (or a checkpoint's own) was judged with."""
    step = step or {}
    if check == "pre":
        own = (step.get("pre") or {}).get("tolerance", config.PRE_TOLERANCE)
    elif step.get("action") == "checkpoint":
        own = step.get("tolerance", config.CHECKPOINT_TOLERANCE)
    else:
        own = (step.get("post") or {}).get("tolerance", config.POST_TOLERANCE)
    if isinstance(own, bool) or not isinstance(own, (int, float)):
        own = config.PRE_TOLERANCE if check == "pre" else config.POST_TOLERANCE
    return config.check_tolerance(int(own), relaxed)


def _close(distance, tol: int) -> bool:
    return isinstance(distance, (int, float)) and not isinstance(distance, bool) and distance <= tol + NEAR


def why_retry(rec: dict | None, step: dict | None = None, relaxed: bool = False) -> str | None:
    """Why a failed step's failure may pass on another try (a short phrase for logs), or None when
    it isn't retried. `rec` is the step's StepRun (`reason`, `preDistance`, `postDistance`, `details`)."""
    if not isinstance(rec, dict) or rec.get("result") != "failed":
        return None
    reason = rec.get("reason")
    if reason not in RETRIED:
        return None
    if reason == "targetNotFound":
        return WHY[reason] if _close(rec.get("preDistance"), tolerance(step, "pre", relaxed)) else None
    if reason == "unexpectedScreen":
        return WHY[reason] if _close(rec.get("postDistance"), tolerance(step, "post", relaxed)) else None
    return WHY[reason]

