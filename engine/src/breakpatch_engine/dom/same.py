"""The same element again, from the page's structure: "Fixed automatically" (Breakpatch Team,
roadmap #41) looks here first for a step's target that moved, before it asks the AI assistant.
Off until config.HEAL_FROM_STRUCTURE is on.

Recording keeps what the page called the element a step acts on (`element_of`, the step's
`element`): its accessible role and name, the origin (scheme, host and port) of the page it was
on, where in the element the step acted (`offset` from its centre) and whether it was the only
control with that role and name in the whole page then (`unique`, from `unique`). When a run's
pre-check fails, `find` reads the page's controls as the fast locator does (extract.py, router.py)
and looks for that role and name. It never guesses:

- Web pages only. A page the router doesn't trust (a Flutter app, a canvas over a quarter of the
  screen, fewer than 3 controls) or whose structure can't be read in READ_S answers nothing, and the
  AI assistant looks, as it does on such pages for a described step.
- Only a step whose element was the one control with that role and name when it was recorded
  (`unique` true). A step without `unique`, or with it false, answers nothing.
- Exactly one control with that role and name, wherever it is: on screen, and also counted over
  the whole page (`_count`: off screen, scrolled away in an inner box, in any frame). Two or more is
  ambiguous: nothing. The screen check after this can't tell identical controls apart (another
  table row's Delete), so the whole page is counted, not just the viewport.
- The page must be on the origin the step was recorded on, and that control in a document of the
  same origin: never one in another site's iframe.
- A disabled one isn't taken.
- Names are compared whole, case and runs of spaces aside (as element_name keeps them: 80
  characters at most). Nothing is fuzzy: a renamed button isn't found here.

It only finds a spot. The Team healer still checks the step's pre-check there, on the screen,
before the step acts, and the step's own checks run as usual.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

from ..sites import origin_of
from . import s0
from .extract import STRONG_ROLES, Extraction, Extractor
from .router import FAST, route

log = logging.getLogger("breakpatch.same")

ROLES = STRONG_ROLES - {"scrollbar"}   # controls a step acts on; a named dialog or region isn't one
READ_S = 2.0                           # at most this long to read the page; then the AI assistant looks


def key(name) -> str:
    """A name as it's compared: spaces collapsed, 80 characters at most, case folded."""
    return " ".join(str(name or "").split())[:80].casefold()


def _box(v) -> list[float] | None:
    if not isinstance(v, (list, tuple)) or len(v) != 4:
        return None
    try:
        b = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    return b if b[2] > b[0] and b[3] > b[1] else None


def _centre(b) -> tuple[float, float]:
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def element_of(dom: dict | None, anchor, url: str | None, unique: bool = False) -> dict | None:
    """What a step keeps of the element it acts on, from BrowserSession.element_name(anchor,
    box=True) read before the action, on the page at `url`: `{role, name, origin, offset, unique}`.
    `unique`: whether the whole page had no other control with that role and name (`unique()`, read
    before the action too). None when it isn't a named control on a web page, or `anchor` isn't
    inside it."""
    if not isinstance(dom, dict) or anchor is None:
        return None
    role, name, box = dom.get("role"), " ".join(str(dom.get("name") or "").split())[:80], _box(dom.get("box"))
    origin = origin_of(url)
    if role not in ROLES or not name or box is None or origin is None:
        return None
    x, y = float(anchor[0]), float(anchor[1])
    if not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
        return None
    cx, cy = _centre(box)
    return {"role": role, "name": name, "origin": origin, "offset": [round(x - cx, 1), round(y - cy, 1)],
            "unique": unique is True}


def usable(element) -> bool:
    """Whether a step's `element` (from a file: anything) has what `find` needs."""
    if not isinstance(element, dict):
        return False
    off = element.get("offset")
    return (element.get("role") in ROLES and isinstance(element.get("name"), str) and bool(key(element["name"]))
            and isinstance(element.get("origin"), str) and origin_of(element["origin"]) == element["origin"]
            and isinstance(off, (list, tuple)) and len(off) == 2
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 10_000 for v in off))


def match(element: dict, candidates: list[dict], origins: list | None) -> tuple[dict | None, str]:
    """The one candidate with the element's role and name, or None and why (for the log)."""
    role, want = element["role"], key(element["name"])
    same = [i for i, c in enumerate(candidates) if c.get("role") == role and key(c.get("name")) == want]
    if not same:
        return None, "no control with that role and name"
    if len(same) > 1:
        return None, f"{len(same)} controls with that role and name"
    i = same[0]
    if origins is None or i >= len(origins) or origins[i] != element["origin"]:
        return None, "it's in another site's frame"
    if candidates[i].get("disabled"):
        return None, "it's disabled"
    return candidates[i], "found"


@dataclass
class Same:
    at: list[float] | None        # where to act now (viewport px); None: not found here
    box: list[float] | None       # the control's part inside the viewport
    why: str                      # for the log
    ms: float = 0.0


class _Origins(Extractor):
    """The fast locator's extractor, also noting each candidate's document origin (`extra["origins"]`,
    in candidate order), so a control in another site's iframe is never taken, and counting a role
    and name over the whole page (`count`)."""

    def _finish(self, look, candidates: list[dict]) -> None:
        out = []
        for c in candidates:
            pi, di, _ = c["_key"]
            snap = look.snaps[pi]
            try:
                url = snap["strings"][snap["documents"][di]["documentURL"]]
            except (KeyError, IndexError, TypeError):
                url = None
            out.append(origin_of(url))
        look.extra["origins"] = out

    async def count(self, role: str, name) -> int:
        """How many controls in the whole page have this role and name (`key`), viewport or not:
        every document of every process the sessions reach (all frames, any origin), every node
        with a layout box (so not display:none) that the accessibility tree doesn't ignore (so not
        visibility:hidden or aria-hidden), disabled ones included. A document whose tree can't be
        read raises: an unknown count is never taken for one."""
        want = key(name)
        procs = list(self.procs)
        snaps = await asyncio.gather(*(p.s.send("DOMSnapshot.captureSnapshot", {"computedStyles": []})
                                       for p in procs))
        n = 0
        try:
            for p, snap in zip(procs, snaps):
                seen: set = set()
                for doc in snap["documents"]:
                    bids = doc["nodes"]["backendNodeId"]
                    laid = {bids[i] for i in doc["layout"]["nodeIndex"]}
                    got = await p.s.send("Accessibility.getFullAXTree", {"frameId": snap["strings"][doc["frameId"]]})
                    for nd in got["nodes"]:
                        b = nd.get("backendDOMNodeId")
                        if b is None or b in seen or b not in laid or nd.get("ignored"):
                            continue
                        seen.add(b)
                        if (nd.get("role") or {}).get("value") == role and key((nd.get("name") or {}).get("value")) == want:
                            n += 1
        finally:
            await asyncio.gather(*(p.s.send("Accessibility.disable") for p in procs), return_exceptions=True)
        return n


async def _read(page, viewport, role: str, name: str) -> tuple[Extraction, int]:
    """The page's controls on screen, and how many in the whole page have that role and name."""
    ex = _Origins(page, viewport)
    try:   # open() too: a timeout while it opens the sessions still closes the ones it has
        await ex.open()
        return await ex.extract(), await ex.count(role, name)
    finally:
        await ex.close()


async def _count_on(page, viewport, role: str, name: str) -> int:
    ex = _Origins(page, viewport)
    try:
        await ex.open()
        return await ex.count(role, name)
    finally:
        await ex.close()


async def unique(browser, dom: dict | None) -> bool:
    """Whether the page in `browser` (a BrowserSession) has exactly one control with the role and
    name of `dom` (BrowserSession.element_name's answer) in the whole of it, for a step's `unique`
    when it's recorded. False when it isn't a named control, or the page can't be read in READ_S."""
    if not isinstance(dom, dict) or dom.get("role") not in ROLES or not key(dom.get("name")):
        return False
    try:
        n = await asyncio.wait_for(_count_on(await browser.live(), (browser.width, browser.height),
                                             dom["role"], dom["name"]), READ_S)
    except Exception as e:  # noqa: BLE001 - too slow, or a frame went away mid-read
        log.info("couldn't count the element's role and name on the page: %s", type(e).__name__)
        return False
    return n == 1


async def find(browser, element) -> Same:
    """The step's element on the page as it is now (`browser`: a BrowserSession), or why not."""
    t0 = time.perf_counter()

    def done(why: str, at=None, box=None) -> Same:
        got = Same(at, box, why, round((time.perf_counter() - t0) * 1000, 1))
        log.info("same element: %s (%s ms)", why, got.ms)
        return got

    if not usable(element):
        return done("the step has no element to look for")
    if element.get("unique") is not True:
        return done("its name wasn't known to be the only one on the page when it was recorded")
    if origin_of(browser.url) != element["origin"]:
        return done("the page is on another site")
    w, h = browser.width, browser.height
    try:
        ex, n = await asyncio.wait_for(_read(await browser.live(), (w, h), element["role"], element["name"]),
                                       READ_S)
    except Exception as e:  # noqa: BLE001 - too slow, or a frame went away mid-read
        return done(f"the page's structure couldn't be read ({type(e).__name__})")
    r = route(ex)
    if r.mode != FAST:
        return done(f"not a page to trust its structure ({r.why})")
    c, why = match(element, ex.candidates, ex.extra.get("origins"))
    if c is None:
        return done(why)
    if n != 1:      # another one off screen, scrolled away or in a frame the viewport doesn't show
        return done(f"{n} controls with that role and name in the whole page")
    vis = s0.visible_box(c["box"], (w, h))
    cx, cy = _centre(c["box"])
    off = element["offset"]
    # Where in the control the step acted, kept inside the part of it that's on screen.
    x = min(max(cx + float(off[0]), vis[0] + 1), vis[2] - 1)
    y = min(max(cy + float(off[1]), vis[1] + 1), vis[3] - 1)
    return done("found", [round(x, 1), round(y, 1)], vis)
