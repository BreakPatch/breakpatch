"""Finding a described element: the fast locator in front of the AI assistant.

- Each page is routed once, the first time something is looked for on it (router.py), and again
  after it navigates or most of the screen changes (`invalidate`).
- Fast pages: S0 on the controls listed for THIS look (the list can differ from an earlier one:
  the experiment's note (b)). When S0 is unsure, the AI assistant looks at the screenshot, as
  before (path "fast→visual").
- Visual pages (Flutter, a big canvas, almost no controls): the AI assistant only.
- Absence checks ("not found" is the expected answer) take S0's answer on Fast pages and never
  ask the AI assistant: it always draws a box somewhere, so it would report things that aren't
  there. On a Visual page there is nothing else to ask.

S0's answers never touch the model: the locator isn't even fetched, so it can't load.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Callable

from .. import imaging
from ..protocol import EngineError
from . import s0
from .extract import Extraction, Extractor
from .router import FAST, VISUAL, Route, route

log = logging.getLogger("breakpatch.locate")

PATH_FAST, PATH_FALLBACK, PATH_VISUAL = "fast", "fast→visual", "visual"


@dataclass
class Found:
    box: list | None              # viewport px; None: not found
    path: str                     # PATH_FAST, PATH_FALLBACK or PATH_VISUAL
    s0_score: float | None = None
    candidates: int | None = None
    extract_ms: float | None = None
    score_ms: float | None = None
    v1_ms: float | None = None
    ms: float = 0.0               # the whole look, extraction included

    def log_line(self, absence: bool = False) -> str:
        """e.g. "path=fast s0=0.851 candidates=24 extract=25.0ms score=0.8ms total=29.9ms found"."""
        parts = [f"path={self.path}"]
        for name, v, unit in (("s0", self.s0_score, ""), ("candidates", self.candidates, ""),
                              ("extract", self.extract_ms, "ms"), ("score", self.score_ms, "ms"),
                              ("v1", self.v1_ms, "ms"), ("total", self.ms, "ms")):
            if v is not None:
                parts.append(f"{name}={v}{unit}")
        if absence:
            parts.append("absence")
        parts.append("found" if self.box else "not found")
        return " ".join(parts)

    @property
    def at(self) -> list[float] | None:
        return [round((self.box[0] + self.box[2]) / 2, 1), round((self.box[1] + self.box[3]) / 2, 1)] \
            if self.box else None


class LocateFlow:
    """One per browser session (the recorder owns it). `locator_fn` gives the AI assistant, only
    when it's needed. `track` is for tests and the benchmark (extract.Extractor)."""

    def __init__(self, browser, locator_fn: Callable, track: str | None = None):
        self.b = browser
        self.locator_fn = locator_fn
        self.track = track
        self._epoch = 0
        self._route: Route | None = None
        self._route_key = None
        self._ex: Extractor | None = None
        self._ex_key = None
        self.last: Found | None = None      # the last look's answer, path and timings

    def invalidate(self) -> None:
        """Most of the screen changed (a new screen in an app whose address stays the same):
        route the page again at the next look."""
        self._epoch += 1

    @property
    def route(self) -> Route | None:
        """The current page's route, when it has been decided."""
        return self._route if self._route_key == self._page_key() else None

    def _page_key(self):
        return (self.b.page, self.b.navigations, self._epoch)

    async def _extract(self) -> Extraction | None:
        """The controls on screen now, or None when the page's structure can't be read."""
        key = (self.b.page, self.b.navigations)
        for attempt in range(2):
            try:
                if self._ex is None or self._ex_key != key or self._ex.stale():
                    await self.close()
                    self._ex = await Extractor(self.b.page, (self.b.width, self.b.height), self.track).open()
                    self._ex_key = key
                return await self._ex.extract()
            except Exception as e:  # noqa: BLE001 - a frame went away mid-read: open again once
                log.info("couldn't read the page's structure: %s", e)
                await self.close()
        return None

    async def close(self) -> None:
        if self._ex is not None:
            ex, self._ex = self._ex, None
            await ex.close()

    async def locate(self, description: str, absence: bool = False) -> Found:
        t0 = time.perf_counter()
        viewport = (self.b.width, self.b.height)
        ex = None
        if self.route is None:
            ex = await self._extract()
            self._route = route(ex) if ex is not None else Route(VISUAL, "no page structure")
            self._route_key = self._page_key()
            log.info("router: %s page (%s)", self._route.mode, self._route.why)
        found = Found(None, PATH_VISUAL)
        if self._route.mode == FAST and ex is None:
            ex = await self._extract()
        # (A Fast page whose structure can't be read this time is looked at as a Visual one: an
        # empty list must never read as "not found".)
        if self._route.mode == FAST and ex is not None:
            ans = s0.locate(description, ex.candidates, viewport)
            found = Found(None, PATH_FAST, ans.score, ex.count, ex.extract_ms, ans.ms)
            if ans.found:
                found.box = s0.visible_box(ex.candidates[ans.choice]["box"], viewport)
            elif not absence:
                found.path = PATH_FALLBACK
        if found.path != PATH_FAST:
            loc = self.locator_fn()
            if not loc.available():
                raise EngineError("not_ready", "The AI assistant isn't downloaded yet. Finish setup to use it.")
            t1 = time.perf_counter()
            img = imaging.to_image(await self.b.shoot())
            found.box = await loc.locate(img, description)
            found.v1_ms = round((time.perf_counter() - t1) * 1000, 1)
        found.ms = round((time.perf_counter() - t0) * 1000, 1)
        log.info("locate: %s", found.log_line(absence))
        self.last = found
        return found
