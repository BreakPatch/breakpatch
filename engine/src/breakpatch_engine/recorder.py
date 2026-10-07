"""Recording: performs an action in the live browser and works out its checks (spec §10.2-§10.4)."""
from __future__ import annotations

import asyncio
import logging
import secrets as pysecrets
import time
from typing import Callable

from pathlib import Path

from . import checks, config, imaging, labels
from .actions import FILE_REF, POINTER_ACTIONS, ActionFailed, Context, parse_secrets, perform, sample_path
from .browser import BrowserSession
from .dom.flow import LocateFlow
from .locator import Locator
from .protocol import NULL, EngineError

log = logging.getLogger("breakpatch.recorder")

ACTIONS = POINTER_ACTIONS | {"write", "waitUntil", "waitFor", "navigate", "switchTab", "upload", "downloadCheck",
                             "checkpoint", "loop", "group"}
# Fields copied from the request into the step as they are.
PASS_THROUGH = ("from", "to", "direction", "distance", "text", "secretRef", "generated", "durationMs", "url", "nav",
                "sample", "fileType", "minBytes", "timeoutMs", "count", "groupId", "groupVersion", "steps")
Phase = Callable[[str], None]
ROLE_WORDS = {"button": "button", "link": "link", "textbox": "field", "searchbox": "field", "checkbox": "checkbox",
              "radio": "option", "combobox": "list", "menuitem": "menu item", "tab": "tab", "switch": "switch",
              "img": "image", "heading": "heading"}
CLICKY = {"click", "doubleClick", "longClick", "rightClick"}   # what can open a page's file picker


def varies_each_run(step: dict) -> bool:
    """Typed text that differs on every run (generated values, {i}/{time}/{date}) can't have a
    screen check on what it wrote, so such steps get no post-check."""
    if step.get("action") != "write":
        return False
    text = step.get("text") or ""
    return bool(step.get("generated")) or any(k in text for k in ("{i}", "{time}", "{date}", "{timestamp}"))


def suggest_expect(before, after, blast, ignore, url_before: str, url_after: str) -> str:
    """ "What should happen", guessed from the screen before and after the step: nothing changed; a
    new page (the address changed); something closed (the area lost most of its edges: a dialog, a
    menu); something appeared (it gained them); else something changed. The user can change it."""
    if blast is None:
        return "noChange"
    if (url_before or "").split("#")[0] != (url_after or "").split("#")[0]:
        return "newPage"
    was, now = imaging.edge_density(before, blast, ignore), imaging.edge_density(after, blast, ignore)
    if now < 0.6 * was:
        return "closes"
    if now > 1.6 * was + 0.002:
        return "appears"
    return "changes"


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
    def __init__(self, browser: BrowserSession, locator_fn: Callable[[], Locator], timings: config.Timings,
                 emit: Callable[[str, dict], None] | None = None):
        self.b = browser
        self.emit = emit or (lambda event, data: None)
        self._choice: asyncio.Future | None = None
        self.locator_fn = locator_fn
        # Describing a step: the fast locator (page structure) in front of the AI assistant.
        self.finder = LocateFlow(browser, locator_fn)
        self.t = timings
        self._download_mark = 0
        self._noise: dict[str, list] = {}
        self._last_watch: list = []

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
        if action == "waitFor":
            # Wait N seconds only waits: no checks of its own (the next step's check guards the page).
            await asyncio.sleep(max(0, float(p.get("durationMs") or 1000)) / 1000)
            step["label"] = p.get("label") or labels.default_label(action, p)
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
        noise_now = list(self._last_watch)

        target = p.get("target")
        if anchor is not None and not target:
            target = labels.spot_target(anchor, w, h)
        step["label"] = p.get("label") or labels.default_label(action, p)
        if target:
            step["target"] = target

        # Straight after the last look at the page: the click lands on what that look (and the
        # user) saw. Naming what was clicked only needs that look, so it runs while the page reacts.
        # What the page calls the element, read before the action changes it (DESK-03).
        dom_name = await self.b.element_name(anchor) if anchor is not None and not p.get("label") else None
        phase("acting")
        url_before = self.b.url
        if len(self.b.downloads) < self._download_mark:
            self._download_mark = 0          # the browser was reopened
        # A download check without a position looks at downloads since the last check, so a
        # "click the link" step followed by "check the download" works as it does in replay.
        ctx = Context(self.t, secrets=parse_secrets(p.get("secrets"), self.b.start_origin),
                      download_mark=self._download_mark, files_dir=p.get("filesDir"))
        # A click that opens the page's file picker: the app asks which file to use (no system
        # dialog can show), and the step becomes an upload of that file.
        choosers: list = []

        def on_chooser(chooser) -> None:
            choosers.append(chooser)
        watching = action in CLICKY and self.b.page is not None
        page = self.b.page
        if watching:
            page.on("filechooser", on_chooser)
            try:
                await asyncio.sleep(0.05)             # interception is turned on in the background
                await page.evaluate("0")
            except Exception:  # noqa: BLE001
                pass
        try:
            clicked = time.monotonic()
            await perform(self.b, step, ctx)
            if watching and not choosers:
                await asyncio.sleep(0.2)              # most pickers open with the click itself
        except ActionFailed as e:
            if watching:
                page.remove_listener("filechooser", on_chooser)
            raise EngineError("not_found" if e.reason in ("secretMissing", "targetNotFound", "fileMissing")
                              else "bad_request", e.message)
        answered = bool(choosers)

        def unwatch() -> None:
            if watching:
                try:
                    page.remove_listener("filechooser", on_chooser)
                except Exception:  # noqa: BLE001
                    pass
        if choosers:
            try:
                await self._choose_file(choosers[0], step, phase)
            except BaseException:
                unwatch()
                raise

        def late_chooser() -> bool:
            """Whether the page opened its file picker while this step settled (it's then answered
            here, before the step is returned)."""
            return bool(choosers) and not answered
        if action == "downloadCheck":
            self._download_mark = ctx.download_mark
        naming = asyncio.ensure_future(self._name(before, anchor, dom_name or {})) if anchor is not None and not p.get("label") else None
        field_box = None
        if action == "write":
            # A field that hides what's typed (a password): the step says so, and its checks, and
            # those of later steps on this page, leave the inside of the field out, so another
            # value (a generated one, a changed secret) of another length still passes.
            field = await self.b.focused_field()
            if field and field[1]:
                field_box = field[0]
                inside = imaging.shrink_box(field[0], 2)
                step["masked"] = True
                noise = imaging.merge_boxes(list(noise) + [inside])
                self.remember_noise([inside])
                if step.get("text") and not step.get("secretRef") and not p.get("label"):
                    step["label"] = 'Write "' + "\u2022" * 8 + '"'


        try:
            phase("settling")
            after, _settled = await self._settle(self.b.shoot, noise)
            if late_chooser():
                answered = True
                await self._choose_file(choosers[0], step, phase)
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
                    ignore = imaging.merge_boxes(ignore + imaging.cap_noise(imaging.noise_boxes(list(shots)), w, h,
                                                                             config.NOISE_MAX_SHARE))
                    ignore = imaging.cap_noise(ignore, w, h, config.NOISE_MAX_SHARE)
                    self.remember_noise(ignore)
            # A step that changed most of the screen (a dialog closed, a new screen in an app whose
            # address never changes): what earlier steps saw moving belongs to the old screen.
            if blast is not None and imaging.box_area(blast) > 0.5 * w * h:
                self._noise = {}
                self.finder.invalidate()          # and it may not be the same kind of page
                self.remember_noise(imaging.cap_noise(noise_now, w, h, config.NOISE_MAX_SHARE))

            if anchor is not None:
                pre_region = imaging.box_around(anchor, config.PRE_RADIUS, w, h)
                step["pre"] = {"region": pre_region, "hash": imaging.region_hash(before, pre_region, ignore),
                               "tolerance": config.PRE_TOLERANCE}
            if blast is not None:
                post_region, expect = blast, True
            else:
                post_region = (step["pre"]["region"] if "pre" in step
                               # around a masked field: what's next to it, its inside left out
                               else imaging.clamp_box([field_box[0] - 40, field_box[1] - 40, field_box[2] + 40,
                                                       field_box[3] + 40], w, h) if field_box
                               else [0, 0, w, h])
                expect = False
            step["expect"] = suggest_expect(before, after, blast, ignore, url_before, self.b.url)
            if not varies_each_run(step):
                step["post"] = {"region": post_region, "hash": imaging.region_hash(after, post_region, ignore),
                                "tolerance": config.POST_TOLERANCE, "expectChange": expect}
                if expect:
                    # How much of the area changed: a replay whose click only lit up the button
                    # (a miss) changes far less than one that moved to the next screen.
                    step["post"]["change"] = round(imaging.changed_share(before, after, post_region, ignore), 4)
            step["ignore"] = ignore
            self._refuse_unchecked(step, w, h)
        except BaseException:
            unwatch()
            if naming is not None:
                naming.cancel()
            raise

        if naming is not None:
            if not naming.done():
                phase("naming")
            got = await naming
            if got and step["action"] == action:          # (an upload keeps its "Upload …" name)
                step["label"] = labels.default_label(action, p, got["name"])
                if not p.get("target"):
                    step["target"] = got["target"]
        if watching and not answered:
            # A page can open its file picker a while after the click (after an async step, as
            # Flutter does). The step is answered now; the listener stays on in the background for
            # `chooser_window` after the click, and a late picker turns the step into an upload
            # (`record.stepChanged`), even if the user has started the next step (DESK-07).
            asyncio.ensure_future(self._late_chooser(page, choosers, on_chooser, clicked, dict(step)))
        else:
            unwatch()
        return step

    async def _late_chooser(self, page, choosers: list, listener, clicked: float, step: dict) -> None:
        try:
            while not choosers and time.monotonic() - clicked < self.t.chooser_window:
                await asyncio.sleep(0.05)
        finally:
            try:
                page.remove_listener("filechooser", listener)
            except Exception:  # noqa: BLE001
                pass
        if not choosers:
            return
        try:
            await self._choose_file(choosers[0], step, lambda _phase: None, step_id=step.get("id"))
        except Exception as e:  # noqa: BLE001
            log.info("late file picker: %s", e)
            return
        if step.get("action") == "upload":
            self.emit("record.stepChanged", {"step": step})

    async def _choose_file(self, chooser, step: dict, phase: Phase, step_id: str | None = None) -> None:
        try:
            accept = await chooser.element.get_attribute("accept") or ""
        except Exception:  # noqa: BLE001
            accept = ""
        loop = asyncio.get_running_loop()
        self._choice = loop.create_future()
        phase("choosing")
        self.emit("record.fileChooser", {"accept": accept, "multiple": bool(chooser.is_multiple()),
                                         **({"stepId": step_id} if step_id else {})})
        try:
            choice = await asyncio.wait_for(self._choice, config.CHOOSE_FILE_TIMEOUT)
        except asyncio.TimeoutError:
            choice = {"cancel": True}
        finally:
            self._choice = None
        if choice.get("cancel"):
            return                                    # a plain click: nothing chosen
        if choice.get("sample"):
            await chooser.set_files(str(sample_path(choice["sample"])))
            step.update(action="upload", sample=choice["sample"])
        else:
            ref = str(choice.get("file") or "")
            path = Path(str(choice.get("path") or ""))
            if not FILE_REF.match(ref) or not path.is_file() or path.name != ref.split("/", 1)[1]:
                try:
                    await chooser.set_files([])           # close the page's picker, nothing chosen
                except Exception:  # noqa: BLE001
                    pass
                raise EngineError("bad_request", "That file can't be used. Pick it again.", ref[:120])
            await chooser.set_files(str(path))
            step.update(action="upload", file=ref)
            step.pop("sample", None)
        step["label"] = labels.default_label("upload", {**step, "sample": step.get("sample")}) if not step.get("file") \
            else f"Upload {ref.split('/', 1)[1]}"

    def choose_file(self, p: dict) -> dict:
        """The app's answer to `record.fileChooser`: `{sample}`, `{file, path}` or `{cancel: true}`."""
        if self._choice is None or self._choice.done():
            raise EngineError("bad_request", "No file picker is waiting.")
        self._choice.set_result(p if isinstance(p, dict) else {"cancel": True})
        return {}

    async def _name(self, before, anchor, dom: dict | None = None) -> dict | None:
        """The name for what is at `anchor`: what the page itself calls it (its accessible name),
        else the AI assistant's, else None ("the spot you clicked"). When both exist and differ,
        the page's own name wins (DESK-03)."""
        if dom is None:                                  # {} = already looked, nothing there
            try:
                dom = await self.b.element_name(anchor)
            except Exception:  # noqa: BLE001
                dom = None
        if dom:
            word = ROLE_WORDS.get(dom["role"], "")
            name = dom["name"] if not word or dom["name"].lower().endswith(word) else f"{dom['name']} {word}"
            return {"name": name, "target": f"{name}, {labels.where(anchor, self.b.width, self.b.height)}"}
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
            # Too old to be kept (the page kept changing since) or from before the browser reopened:
            # the page may be anywhere by now, so it counts as changed (DESK-18).
            if p.get("action") in ("checkpoint", "waitUntil"):
                raise EngineError("stale", "The page changed after you drew the box, so nothing was added. "
                                           "Draw it again on the page as it is now.")
            raise EngineError("stale", "The page changed before your click reached it, so nothing was clicked. "
                                       "Look at the page again, then click.")
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
        w, h = self.b.width, self.b.height
        noise = imaging.cap_noise(noise, w, h, config.NOISE_MAX_SHARE)
        self._last_watch = noise
        known = self._noise.get(page, []) if page else []
        merged = imaging.cap_noise(imaging.merge_boxes(known + noise), w, h, config.NOISE_MAX_SHARE)
        if page:
            self._noise = {page: merged}     # only the current page; other pages start fresh
        return merged, last

    @staticmethod
    def _unchecked(region, ignore, w: int, h: int) -> bool:
        return imaging.uncovered_share(region, ignore, w, h) < config.MIN_CHECKED

    def _refuse_unchecked(self, step: dict, w: int, h: int) -> None:
        """Never save a check that has nothing left to compare (its ignore zones cover it)."""
        ignore = step.get("ignore") or []
        for key in ("pre", "post"):
            c = step.get(key)
            if c and self._unchecked(c["region"], ignore, w, h):
                raise EngineError("unchecked", "This step can't be checked: the whole screen moves. "
                                               "Wait until it's still, then try again.", key)

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
        if self._unchecked(region, noise, self.b.width, self.b.height):
            raise EngineError("unchecked", "This can't be checked: everything in the box keeps moving. "
                                           "Draw it around something that stays still.")
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
        # A box far bigger than a control (the whole dialog around a small button) is worse than
        # none: the app then shows the spot instead (DESK-09).
        if box is not None and imaging.box_area(box) <= config.PROPOSE_MAX_SHARE * self.b.width * self.b.height:
            out["box"] = box
        if p.get("name") is not False:
            got = await self._name(await self.b.shoot(), at)
            if got:
                out.update(name=got["name"], target=got["target"])
        return out

    async def intent(self, sentence: str):
        """The AI assistant's reading of a described step (locator.parse_intent), or null when it
        isn't downloaded or can't tell. Looks at the page as it is, so "add 2 people" can be read
        against what's on screen."""
        loc = self.locator_fn()
        if not loc.available() or not hasattr(loc, "intent"):
            return NULL
        self.b.require()
        got = await loc.intent(imaging.to_image(await self.b.shoot()), sentence)
        return got or NULL

    async def locate(self, description: str, absence: bool = False, near: dict | None = None, shows: bool = False):
        """Finds a described element (dom/flow.py): from the page's structure on pages that have
        one, else with the AI assistant. `absence`: "not found" is the expected answer, so the AI
        assistant is never asked after the page's structure didn't find it."""
        if not description or not description.strip():
            raise EngineError("bad_request", "Describe what to look for.")
        self.b.require()
        seq = self.b.last_seq               # the frame the live view shows as the page is looked at
        found = await self.finder.locate(description.strip(), absence=absence, near=near, shows=shows)
        if found.box is None:
            return NULL
        out = {"box": found.box, "at": found.at, "target": description.strip(), "frame": seq, "path": found.path}
        if found.s0_score is not None:
            out["s0Score"] = found.s0_score
        return out
