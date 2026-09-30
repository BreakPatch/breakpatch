"""Finding a described element: the fast locator in front of the AI assistant.

- A page is routed (router.py) the first time something is looked for on it, and again after it
  navigates or most of the screen changes (`invalidate`). A Visual verdict that may only mean the
  page wasn't ready (its structure couldn't be read, or it listed fewer than 3 controls) isn't
  kept: the next look routes again.
- Fast pages: S0 on the controls listed for THIS look (the list can differ from an earlier one:
  a page can add or move a control between loads). When S0 is unsure, the AI assistant looks at
  the screenshot, as before (path "fast-visual").
- Visual pages (Flutter, a big canvas, almost no controls): the AI assistant only.
- Absence checks ("not found" is the expected answer) take S0's answer on Fast pages and never
  ask the AI assistant: it always draws a box somewhere, so it would report things that aren't
  there (in the experiment, falling back cut "not found" F1 from 0.76 to 0.05). On a Visual page
  there is nothing else to ask.

S0's answers never touch the model: the locator isn't even fetched, so it can't load.
One look at a time: looks share the page's CDP sessions, so overlapping calls wait their turn.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Callable

from .. import config, imaging
from ..protocol import EngineError
from . import s0
from .extract import Extraction, Extractor
from .router import FAST, VISUAL, Route, route

log = logging.getLogger("breakpatch.locate")

PATH_FAST, PATH_FALLBACK, PATH_VISUAL = "fast", "fast-visual", "visual"


@dataclass
class Found:
    box: list | None              # viewport px, clamped to it; None: not found
    path: str                     # PATH_FAST, PATH_FALLBACK or PATH_VISUAL
    s0_score: float | None = None
    candidates: int | None = None
    extract_ms: float | None = None
    score_ms: float | None = None
    v1_ms: float | None = None
    ms: float = 0.0               # the whole look, extraction included
    at: list[float] | None = None  # the click point: the centre of the box found
    ties: int | None = None       # S0: candidates sharing the top score

    def log_line(self, absence: bool = False) -> str:
        """e.g. "path=fast s0=0.851 candidates=24 extract=25.0ms score=0.8ms total=29.9ms found"."""
        parts = [f"path={self.path}"]
        for name, v, unit in (("s0", self.s0_score, ""), ("candidates", self.candidates, ""),
                              ("extract", self.extract_ms, "ms"), ("score", self.score_ms, "ms"),
                              ("v1", self.v1_ms, "ms"), ("total", self.ms, "ms")):
            if v is not None:
                parts.append(f"{name}={v}{unit}")
        if self.ties and self.ties > 1:
            parts.append(f"ties={self.ties}")
        if absence:
            parts.append("absence")
        parts.append("found" if self.box else "not found")
        return " ".join(parts)


def _centre(box) -> list[float]:
    return [round((box[0] + box[2]) / 2, 1), round((box[1] + box[3]) / 2, 1)]


class LocateFlow:
    """One per browser session (the recorder owns it). `locator_fn` gives the AI assistant, only
    when it's needed."""

    def __init__(self, browser, locator_fn: Callable):
        self.b = browser
        self.locator_fn = locator_fn
        self._epoch = 0
        self._route: Route | None = None
        self._route_key = None
        self._ex: Extractor | None = None
        self._ex_key = None
        self._lock = asyncio.Lock()
        self.last: Found | None = None      # the last look's answer, path and timings
        self.last_route: Route | None = None     # and the route it took, kept or not
        watchers = getattr(browser, "page_watchers", None)
        if watchers is not None:
            watchers.append(self.close)     # the page changed or the browser closes: let go of it

    def invalidate(self) -> None:
        """Most of the screen changed (a new screen in an app whose address stays the same):
        route the page again at the next look."""
        self._epoch += 1

    def _page_key(self):
        return (self.b.page, self.b.navigations, self._epoch)

    @property
    def route(self) -> Route | None:
        """The current page's route, when it has been decided and kept."""
        return self._route if self._route_key == self._page_key() else None

    async def _extract(self) -> Extraction | None:
        """The controls on screen now, or None when the page's structure can't be read."""
        key = (self.b.page, self.b.navigations)
        for _ in range(2):
            try:
                if self._ex is None or self._ex_key != key or self._ex.stale():
                    await self.close()
                    self._ex = await Extractor(self.b.page, (self.b.width, self.b.height)).open()
                    self._ex_key = key
                return await self._ex.extract()
            except Exception as e:  # noqa: BLE001 - a frame went away mid-read: open again once
                log.info("couldn't read the page's structure: %s", e)
                await self.close()
        return None

    async def close(self) -> None:
        if self._ex is not None:
            ex, self._ex, self._ex_key = self._ex, None, None
            await ex.close()

    async def locate(self, description: str, absence: bool = False) -> Found:
        async with self._lock:
            return await self._locate(description, absence)

    async def _locate(self, description: str, absence: bool) -> Found:
        t0 = time.perf_counter()
        w, h = self.b.width, self.b.height
        ex = None
        r = self.route
        if r is None:
            key = self._page_key()          # before the read: a navigation meanwhile routes again
            ex = await self._extract()
            r = route(ex) if ex is not None else Route(VISUAL, "no page structure", final=False)
            if r.final:
                self._route, self._route_key = r, key
            log.info("router: %s page (%s)%s", r.mode, r.why, "" if r.final else ", asking again next time")
        self.last_route = r
        found = Found(None, PATH_VISUAL)
        if r.mode == FAST and ex is None:
            ex = await self._extract()
        # (A Fast page whose structure can't be read this time is looked at as a Visual one: an
        # empty list must never read as "not found".)
        if r.mode == FAST and ex is not None:
            ans = s0.locate(description, ex.candidates, (w, h))
            found = Found(None, PATH_FAST, ans.score, ex.count, ex.extract_ms, ans.ms, ties=ans.ties)
            if ans.found:
                c = next(c for c in ex.candidates if c["index"] == ans.choice)
                vis = s0.visible_box(c["box"], (w, h))
                found.box, found.at = imaging.clamp_box(vis, w, h), _centre(vis)
            elif not absence:
                found.path = PATH_FALLBACK
        if found.path != PATH_FAST:
            await self._ask_model(found, description, w, h)
        found.ms = round((time.perf_counter() - t0) * 1000, 1)
        log.info("locate: %s", found.log_line(absence))
        self.last = found
        return found

    async def _ask_model(self, found: Found, description: str, w: int, h: int) -> None:
        loc = self.locator_fn()
        if not loc.available():
            raise EngineError("not_ready", "The AI assistant isn't downloaded yet. Finish setup to use it.")
        t1 = time.perf_counter()
        box = await loc.locate(imaging.to_image(await self.b.shoot()), description)
        found.v1_ms = round((time.perf_counter() - t1) * 1000, 1)
        if box is None:
            return
        box = imaging.clamp_box(box, w, h)
        # A box over most of the page isn't an answer: the model boxes the whole screen when what
        # was described isn't there (DESK-04). Not found, so nothing is clicked.
        if imaging.box_area(box) > config.LOCATE_MAX_SHARE * w * h:
            return
        found.box, found.at = box, _centre(box)
