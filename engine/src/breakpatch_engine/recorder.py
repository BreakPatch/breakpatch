"""Recording: performs an action in the live browser and works out its checks (spec §10.2-§10.4)."""
from __future__ import annotations

import asyncio
import logging
import secrets as pysecrets
import time
from typing import Callable

from . import checks, config, imaging, labels
from .actions import POINTER_ACTIONS, ActionFailed, Context, parse_secrets, perform
from .browser import BrowserSession
from .locator import Locator
from .protocol import NULL, EngineError

log = logging.getLogger("breakpatch.recorder")

ACTIONS = POINTER_ACTIONS | {"write", "waitUntil", "waitFor", "navigate", "switchTab", "upload", "downloadCheck",
                             "checkpoint", "loop", "group"}
# Fields copied from the request into the step as they are.
PASS_THROUGH = ("from", "to", "direction", "distance", "text", "secretRef", "generated", "durationMs", "url", "nav",
                "sample", "fileType", "minBytes", "timeoutMs", "count", "groupId", "groupVersion", "steps")
Phase = Callable[[str], None]


def varies_each_run(step: dict) -> bool:
    """Typed text that differs on every run (generated values, {i}/{time}/{date}) can't have a
    screen check on what it wrote, so such steps get no post-check."""
    if step.get("action") != "write":
        return False
    text = step.get("text") or ""
    return bool(step.get("generated")) or any(k in text for k in ("{i}", "{time}", "{date}", "{timestamp}"))


def new_id() -> str:
    return "s" + pysecrets.token_hex(4)


def _point(v) -> list[float] | None:
    if v is None:
        return None
    if not (isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(n, (int, float)) for n in v)):
        raise EngineError("bad_request", "The engine received a position it couldn't read.", repr(v))
    return [round(float(v[0]), 1), round(float(v[1]), 1)]


def _box(v) -> list[int]:
    if not (isinstance(v, (list, tuple)) and len(v) == 4 and all(isinstance(n, (int, float)) for n in v)):
        raise EngineError("bad_request", "The engine received an area it couldn't read.", repr(v))
    return [int(round(n)) for n in v]


class Recorder:
    def __init__(self, browser: BrowserSession, locator_fn: Callable[[], Locator], timings: config.Timings):
        self.b = browser
        self.locator_fn = locator_fn
        self.t = timings
        self._download_mark = 0
        self._noise: dict[str, list] = {}

    async def _settle(self, shoot, ignore=None):
        return await checks.settle(shoot, ignore, self.t.settle_interval, self.t.settle_frames, self.t.settle_timeout)

    async def point(self, p: dict, phase: Phase) -> dict:
        action = p.get("action")
        if action not in ACTIONS:
            raise EngineError("bad_request", "The engine doesn't know that action.", repr(action))
        at = _point(p.get("at"))
        frm = _point(p.get("from"))
        step: dict = {"id": new_id(), "action": action}
        for k in PASS_THROUGH:
            if p.get(k) is not None:
                step[k] = p[k]
        if at is not None:
            step["at"] = at
        if frm is not None:
            step["from"] = frm
        if p.get("to") is not None:
            step["to"] = _point(p["to"])

        if action in ("loop", "group"):
            step["label"] = p.get("label") or labels.default_label(action, p)
            step.setdefault("steps", [])
            return step
        if action == "checkpoint":
            if not p.get("region"):
                raise EngineError("bad_request", "Draw a box around what should be visible.")
            return await self.checkpoint(_box(p["region"]), phase, p.get("frame"))
        if action == "waitUntil":
            # Nothing to perform: the area as it looks now is what replay waits for.
            if not p.get("region"):
                raise EngineError("bad_request", "Draw a box around what to wait for.")
            got = await self.checkpoint(_box(p["region"]), phase, p.get("frame"))
            step.update({k: got[k] for k in ("region", "hash", "tolerance", "ignore")})
            step["label"] = p.get("label") or labels.default_label(action, p)
            step["target"] = p.get("target") or "The area you picked"
            step.setdefault("timeoutMs", 10000)
            return step

        self.b.require()
        w, h = self.b.width, self.b.height
        anchor = at or frm
        seen = self._seen(p, anchor)
        phase("watching")
        noise, before = await self._watch(seen)

        target = p.get("target")
        if anchor is not None and not target:
            target = labels.spot_target(anchor, w, h)
        step["label"] = p.get("label") or labels.default_label(action, p)
        if target:
            step["target"] = target

        # Straight after the last look at the page: the click lands on what that look (and the
        # user) saw. Naming what was clicked only needs that look, so it runs while the page reacts.
        phase("acting")
        if len(self.b.downloads) < self._download_mark:
            self._download_mark = 0          # the browser was reopened
        # A download check without a position looks at downloads since the last check, so a
        # "click the link" step followed by "check the download" works as it does in replay.
        ctx = Context(self.t, secrets=parse_secrets(p.get("secrets"), self.b.start_origin),
                      download_mark=self._download_mark)
        try:
            await perform(self.b, step, ctx)
        except ActionFailed as e:
            raise EngineError("not_found" if e.reason in ("secretMissing", "targetNotFound") else "bad_request",
                              e.message)
        if action == "downloadCheck":
            self._download_mark = ctx.download_mark
        naming = asyncio.ensure_future(self._name(before, anchor)) if anchor is not None and not p.get("label") else None

        try:
            phase("settling")
            after, _settled = await self._settle(self.b.shoot, noise)
            blast = imaging.blast_radius(before, after, noise)
            if blast is None and action not in ("hover", "waitFor"):
                # A slow server can leave the screen still for a moment before the result shows up.
                after, blast = await self._late_change(before, after, noise)

            ignore = list(noise)
            # Not after typing: a reload loses what was typed, so it tells nothing about this step
            # and only makes "Waiting for the page…" long (noise already seen on the page is kept).
            if self.t.reload_diff and action not in ("waitFor", "write"):
                phase("reloading")
                shots = await self.b.background_reload_shots(lambda s: self._settle(s, noise))
                if shots is not None:
                    ignore = imaging.merge_boxes(ignore + imaging.noise_boxes(list(shots)))
                    self.remember_noise(ignore)

            if anchor is not None:
                pre_region = imaging.box_around(anchor, config.PRE_RADIUS, w, h)
                step["pre"] = {"region": pre_region, "hash": imaging.region_hash(before, pre_region, ignore),
                               "tolerance": config.PRE_TOLERANCE}
            if blast is not None:
                post_region, expect = blast, True
            else:
                post_region = step["pre"]["region"] if "pre" in step else [0, 0, w, h]
                expect = False
            if not varies_each_run(step):
                step["post"] = {"region": post_region, "hash": imaging.region_hash(after, post_region, ignore),
                                "tolerance": config.POST_TOLERANCE, "expectChange": expect}
                if expect:
                    # How much of the area changed: a replay whose click only lit up the button
                    # (a miss) changes far less than one that moved to the next screen.
                    step["post"]["change"] = round(imaging.changed_share(before, after, post_region, ignore), 4)
            step["ignore"] = ignore
        except BaseException:
            if naming is not None:
                naming.cancel()
            raise

        if naming is not None:
            if not naming.done():
                phase("naming")
            got = await naming
            if got:
                step["label"] = labels.default_label(action, p, got["name"])
                if not p.get("target"):
                    step["target"] = got["target"]
        return step

    async def _name(self, before, anchor) -> dict | None:
        """The AI assistant's name for what is at `anchor` on the screen before the action."""
        loc = self.locator_fn()
        if not loc.available():
            return None
        try:
            return await loc.describe(imaging.to_image(before), anchor)
        except Exception as e:  # noqa: BLE001
            log.info("describe failed: %s", e)
            return None

    def _seen(self, p: dict, anchor, region=None):
        """The live view frame the user acted on (`frame`, its seq) and the area of it that must
        still look the same when the engine acts: around the click, or the drawn box."""
        if "frame" not in p or p["frame"] is None:
            return None
        img = self.b.seen_frame(p["frame"])
        if img is None:
            log.info("frame %s is no longer kept; acting without the check", p["frame"])
            return None
        if region is None:
            if anchor is None:
                return None
            region = imaging.box_around(anchor, config.SEEN_RADIUS, self.b.width, self.b.height)
        return img, region, p.get("action")

    @staticmethod
    def _check_seen(seen, now) -> None:
        if seen is None:
            return
        img, region, action = seen
        if imaging.looks_different(img, now, region):
            if action in ("checkpoint", "waitUntil"):
                raise EngineError("stale", "The page changed after you drew the box, so nothing was added. "
                                           "Draw it again on the page as it is now.")
            raise EngineError("stale", "The page changed before your click reached it, so nothing was clicked. "
                                       "Look at the page again, then click.")

    async def _watch(self, seen=None):
        """Noise watch (spec §10.3.1), merged with what earlier steps on the same page saw change by
        itself: a clock that happened to sit still for one short watch is still a clock.

        The live view stream only sends a frame when the page changes, so a page it saw sit still
        for the whole watch needs no watch: one look is enough, and the click goes at once. With
        `seen`, the page must still look as the user saw it, at the first look and at the last
        one, just before the action (else `stale`, and nothing is done)."""
        page = self.b.url.split("#")[0]
        first = await self.b.shoot()
        self._check_seen(seen, first)
        if self.b.quiet_for() >= self.t.noise_watch:
            noise, last = [], first
        else:
            frames = [first]

            async def shoot():
                frames.append(await self.b.shoot())
                return frames[-1]

            end = time.monotonic() + self.t.noise_watch
            while time.monotonic() < end:
                await asyncio.sleep(self.t.noise_interval)
                await shoot()
            noise, last = imaging.noise_boxes(frames), frames[-1]
            self._check_seen(seen, last)
        known = self._noise.get(page, []) if page else []
        merged = imaging.merge_boxes(known + noise)
        if page:
            self._noise = {page: merged}     # only the current page; other pages start fresh
        return merged, last

    def remember_noise(self, boxes) -> None:
        page = self.b.url.split("#")[0]
        if page:
            self._noise[page] = imaging.merge_boxes(self._noise.get(page, []) + list(boxes))

    async def _late_change(self, before, after, noise):
        end = time.monotonic() + self.t.late_change
        while time.monotonic() < end:
            await asyncio.sleep(self.t.settle_interval)
            cur = await self.b.shoot()
            if imaging.blast_radius(before, cur, noise) is not None:
                after, _ = await self._settle(self.b.shoot, noise)
                return after, imaging.blast_radius(before, after, noise)
        return after, None

    async def checkpoint(self, region: list[int], phase: Phase, frame=None) -> dict:
        self.b.require()
        region = imaging.clamp_box(region, self.b.width, self.b.height)
        if imaging.box_area(region) == 0:
            raise EngineError("bad_request", "Draw a bigger box around what should be visible.")
        phase("watching")
        noise, last = await self._watch(self._seen({"frame": frame, "action": "checkpoint"}, None, region))
        return {"id": new_id(), "action": "checkpoint", "label": "Check something is visible",
                "target": "The area you picked", "region": region,
                "hash": imaging.region_hash(last, region, noise), "tolerance": config.CHECKPOINT_TOLERANCE,
                "ignore": noise}

    async def propose(self, p: dict) -> dict:
        """What a click on the live view would act on, without touching the page: the element's
        box and, with the AI assistant, its name. The app shows it as "Click Next button?" and
        records the step only when the user confirms."""
        self.b.require()
        at = _point(p.get("at"))
        if at is None:
            raise EngineError("bad_request", "The engine received a position it couldn't read.")
        out: dict = {"at": at, "frame": self.b.last_seq}
        box = await self.b.element_box(at)
        if box is not None:
            out["box"] = box
        if p.get("name") is not False:
            got = await self._name(await self.b.shoot(), at)
            if got:
                out.update(name=got["name"], target=got["target"])
        return out

    async def locate(self, description: str):
        if not description or not description.strip():
            raise EngineError("bad_request", "Describe what to look for.")
        loc = self.locator_fn()
        if not loc.available():
            raise EngineError("not_ready", "The AI assistant isn't downloaded yet. Finish setup to use it.")
        seq = self.b.last_seq               # the frame the live view shows as the screenshot is taken
        img = imaging.to_image(await self.b.shoot())
        box = await loc.locate(img, description.strip())
        if box is None:
            return NULL
        box = imaging.clamp_box(box, self.b.width, self.b.height)
        at = [round((box[0] + box[2]) / 2, 1), round((box[1] + box[3]) / 2, 1)]
        return {"box": box, "at": at, "target": description.strip(), "frame": seq}
