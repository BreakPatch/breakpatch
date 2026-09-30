"""Why a step failed, in plain words (roadmap #7). Breakpatch Team: the explainer plugs in through
plugins.py (`register_explainer`); Community has none, so `run.explain` answers `not_ready`.

What's open here is the contract only: what an explainer is given and what it answers, where a
failure's page context is kept, and the checks on both. The explaining itself is the Team engine's.

- Nothing here runs during a run's steps. After a step fails, the runner (only when an explainer
  is registered and says it wants it) keeps a short read of the page's own structure, the
  controls and short texts on screen (the fast locator's extraction, capped at PAGE_READ_S), next
  to the failure screenshot as `<screenshot>.page.json`. Without an explainer nothing is read and
  nothing is written: the run is exactly as before.
- `run.explain` (engine/PROTOCOL.md "Why did this fail?") asks for an explanation when the report
  wants one, from the failure screenshot, that page read and the step as it was recorded. The
  answer is cached per failure, so asking again is instant.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from PIL import Image

from . import config
from .locator import Locator

log = logging.getLogger("breakpatch.explain")

# What an explanation can say is the likely cause, and what it suggests (engine/PROTOCOL.md).
CAUSES = ("moved", "textChanged", "pageChanged", "slowLoad", "errorPage", "realBug")
SUGGESTIONS = ("rerecord", "acceptChange", "raiseWait", "reportBug")
# The reasons an explanation can add something to. The others say it all already (a missing
# secret, a failed set-up call, a stop) or aren't about the page.
EXPLAINED = ("targetNotFound", "healFailed", "noChange", "unexpectedScreen", "timeout")

TIMEOUT_S = 10.0          # an explanation that takes longer is dropped (no explanation)
PAGE_READ_S = 0.75        # the page read after a failure never takes longer than this
MAX_SUMMARY = 300
MAX_PAGE_ITEMS = 400      # controls and texts kept in a page read, each
PAGE_SUFFIX = ".page.json"


@dataclass
class Failure:
    """One failed step, as `run.explain` received it."""
    step: dict                     # the step as recorded: target, at/from, action, label, pre, post…
    reason: str                    # its FailReason
    viewport: tuple[int, int]
    image: Image.Image | None      # the failure screenshot
    page: dict | None = None       # the page read: {controls: [...], texts: [...]} (fast locator shapes)
    message: str | None = None
    pre_distance: int | None = None
    post_distance: int | None = None
    timings: dict = field(default_factory=dict)
    old_at: list | None = None
    new_at: list | None = None


class Explainer(Protocol):
    """Registered by the Team engine. `explain` answers `{summary, cause, suggestion}` or None (it
    can't tell); it raises EngineError("not_ready", …) when it may not explain (no licence feature)
    or can't (no model). `wants_page` says whether the runner should read the page after a failure."""

    def wants_page(self) -> bool: ...
    def explain(self, failure: Failure, locator_fn: Callable[[], Locator]) -> Awaitable[dict | None]: ...


def clean(value: Any) -> dict | None:
    """An explainer's answer as the protocol carries it, or None when it isn't one."""
    if not isinstance(value, dict):
        return None
    summary, cause, suggestion = value.get("summary"), value.get("cause"), value.get("suggestion")
    if not isinstance(summary, str) or not summary.strip():
        return None
    if cause not in CAUSES or suggestion not in SUGGESTIONS:
        return None
    summary = " ".join(summary.split())
    if len(summary) > MAX_SUMMARY:
        summary = summary[:MAX_SUMMARY - 1].rstrip() + "…"
    return {"summary": summary, "cause": cause, "suggestion": suggestion}


def page_path(screenshot: str | Path) -> Path:
    return Path(str(screenshot) + PAGE_SUFFIX)


def in_screenshots(path: str | Path) -> Path | None:
    """The screenshot `run.explain` names, only when it's a PNG inside the engine's screenshots
    folder (the app hands the path back; it must not read anything else on the Mac)."""
    try:
        root = config.screenshots_dir().resolve()
        p = Path(str(path)).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if p.suffix.lower() != ".png" or not p.is_file():
        return None
    try:
        p.relative_to(root)
    except ValueError:
        return None
    return p


def _short(v: Any, n: int) -> str | None:
    return " ".join(v.split())[:n] if isinstance(v, str) and v.strip() else None


def _box(v: Any) -> list[float] | None:
    if isinstance(v, (list, tuple)) and len(v) == 4 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
        return [round(float(x), 1) for x in v]
    return None


def page_record(candidates: list[dict], texts: list[dict]) -> dict:
    """What a page read keeps: names, roles, short text and boxes. No attributes, no values of
    fields beyond what the extractor already shows (it never reads passwords)."""
    controls = []
    for c in candidates[:MAX_PAGE_ITEMS]:
        box = _box(c.get("box"))
        if box is None:
            continue
        controls.append({k: v for k, v in (
            ("role", _short(c.get("role"), 40)), ("name", _short(c.get("name"), 120)),
            ("label", _short(c.get("label"), 120)), ("text", _short(c.get("text"), 80)),
            ("landmark", _short(c.get("landmark"), 120)), ("box", box),
            ("disabled", True if c.get("disabled") is True else None)) if v is not None})
    runs = []
    for t in texts[:MAX_PAGE_ITEMS]:
        box, text = _box(t.get("box")), _short(t.get("text"), 80)
        if box is not None and text:
            runs.append({"text": text, "box": box})
    return {"v": 1, "controls": controls, "texts": runs}


def save_page(screenshot: str | Path, record: dict) -> None:
    path = page_path(screenshot)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def read_page(screenshot: str | Path) -> dict | None:
    """The page read kept with a failure screenshot, re-checked, or None."""
    try:
        raw = json.loads(page_path(screenshot).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    controls = raw.get("controls") if isinstance(raw.get("controls"), list) else []
    texts = raw.get("texts") if isinstance(raw.get("texts"), list) else []
    return page_record([c for c in controls if isinstance(c, dict)], [t for t in texts if isinstance(t, dict)])
