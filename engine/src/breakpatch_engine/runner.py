"""Replay (spec §11). Deterministic and model-free.

Fallback healing of moved targets (spec §11.2, the AI assistant finds the step's target) is a
Breakpatch Team feature: it plugs in as `healer` (see plugins.py). Without one, a failed
pre-check fails the step with `targetNotFound`, whatever `autoFix` says. So does the explainer
(explain.py): when one is registered and wants it, a failed step's page is read once, briefly,
for `run.explain` to use later; nothing is explained during the run.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Awaitable, Callable, Iterator, Protocol

import numpy as np

from . import calls, checks, config, explain, imaging, systems
from .actions import ActionFailed, Context, Secret, parse_secrets, perform, secret_refs
from .sites import origin_of
from .browser import BrowserSession
from .locator import Locator

log = logging.getLogger("breakpatch.runner")

Emit = Callable[[str, dict], None]


class Healer(Protocol):
    """Finds a moved target during a run (spec §11.2). Provided by the Team engine.

    Called when a step's pre-check fails and `autoFix` is on. Returns `(at, from, preDistance)`
    at the new spot (`at`/`from` as the step uses them, else None), or raises StepFailed with
    `targetNotFound`, `healFailed` or `healingUnavailable`. It may use `runner.locator_fn`,
    `runner.locator` (cached per run), `runner.b` (the browser) and `runner._event`.
    """

    def __call__(self, runner: "Runner", step: dict, pre: dict, ignore, iteration: int | None,
                 old_dist: int) -> Awaitable[tuple[list | None, list | None, int]]: ...

MESSAGES = {
    "targetNotFound": "The thing this step acts on isn't where it was.",
    "unexpectedScreen": "The screen didn't look as expected after this step.",
    "noChange": "The step was done, but nothing changed on the page the way it did when it was recorded.",
    "timeout": "The screen didn't settle in time.",
    "healFailed": "The AI assistant found something, but it didn't match the recorded target.",
    "healingUnavailable": "The target moved and the AI assistant isn't available to find it.",
    "secretMissing": "A saved secret this test needs isn't on this Mac.",
    "setUpFailed": "The set-up call didn't succeed, so the test didn't start.",
    "stopped": "The run was stopped.",
    "fileMissing": "The file this upload chooses isn't in the tests folder.",
}


def walk(steps: list[dict]) -> Iterator[dict]:
    """Pre-order: a loop or group comes before its children. This order defines `index`."""
    for s in steps:
        yield s
        yield from walk(s.get("steps") or [])


def shift(box, dx: float, dy: float) -> list[int]:
    return [int(round(box[0] + dx)), int(round(box[1] + dy)), int(round(box[2] + dx)), int(round(box[3] + dy))]


class _Reached(Exception):
    """The step a play in the recorder goes up to has passed: stop there, successfully."""


class StepFailed(Exception):
    def __init__(self, reason: str, message: str | None = None, **extra):
        super().__init__(reason)
        self.reason = reason
        self.message = message or MESSAGES.get(reason, reason)
        self.extra = extra


class Runner:
    def __init__(self, browser: BrowserSession, locator_fn: Callable[[], Locator], timings: config.Timings,
                 emit: Emit, screenshots: Path | None = None, healer: Healer | None = None,
                 explainer: "explain.Explainer | None" = None):
        self.b = browser
        self.locator_fn = locator_fn
        self.t = timings
        self.emit = emit
        self.screenshots = screenshots or config.screenshots_dir()
        self.healer = healer                  # None: no healing (Community), see plugins.py
        self.explainer = explainer            # None: no page read after a failure (Community)
        self.locator: Locator | None = None   # for the healer: loaded lazily on the first failed pre-check
        self._passed_by: str | None = None
        self._tries = 0
        self._post_message: str | None = None
        self.keep_open = False
        self.from_id: str | None = None
        self._started = True
        self.files_dir: str | None = None
        self.up_to: str | None = None
        self._steps: list[dict] = []
        self.relaxed = False                  # screen checks allow for another system (systems.py)
        self.ran_on: dict | None = None
        self.mismatch: dict | None = None

    async def run(self, req: dict, stop: asyncio.Event) -> dict:
        run_id = str(req.get("runId") or "run")
        steps = req.get("steps") or []
        settings = req.get("settings") or {}
        auto_fix = bool(settings.get("autoFix"))
        fail_on_fix = bool(settings.get("failOnFix"))
        # "Allow for small differences between systems": on unless the client turns it off.
        self.allow_differences = settings.get("allowSystemDifferences") is not False
        self.relaxed, self.ran_on, self.mismatch = False, None, None
        # Older clients send bare values: those count as allowed on the start page's site only.
        secrets = parse_secrets(req.get("secrets"), origin_of(req.get("startUrl")))
        self.secrets = secrets
        self.as_runner = bool(req.get("runner"))
        # Set-up and clean-up calls may only reach the app's own hosts (calls.py).
        self.app_url = str(req.get("appUrl") or req.get("startUrl") or "")
        self._steps = steps
        order = list(walk(steps))
        self.index = {id(s): i for i, s in enumerate(order)}
        self.results = [{"stepId": s.get("id", f"#{i}"), "result": "notRun"} for i, s in enumerate(order)]
        self.run_id = run_id
        self.auto_fix = auto_fix
        # The recorder's Run and Play to here: the browser stays open at the end so recording goes
        # on from there, and there is no clean-up call (it would undo what the next steps build on).
        self.keep_open = bool(req.get("keepOpen"))
        self.files_dir = str(req["filesDir"]) if req.get("filesDir") else None
        self.up_to = req.get("upToStepId") or None
        # Play this step: start at that step, on the page as it is (the recorder's open browser).
        self.from_id = req.get("fromStepId") or None
        self._started = self.from_id is None
        self.message: str | None = None
        self.details: str | None = None
        self.clean_up_failed = False
        self.reached_set_up = False   # clean-up never runs for a run that stopped before set-up
        t0 = time.monotonic()
        ok = False
        try:
            try:
                ok = await self._execute(req, steps, order, secrets, stop)
            except _Reached:
                ok = True
        finally:
            clean_up = None if self.keep_open else req.get("cleanUp")
            if clean_up and self.reached_set_up and (ok or clean_up.get("alsoOnFailure")):
                reply = await calls.make(clean_up, self.app_url, self.secrets, self.t.http_timeout)
                log.info("clean-up call: %s", reply.info)
                if not reply.ok:
                    self.clean_up_failed = True
            if not self.keep_open:
                try:
                    await self.b.close()
                except Exception:  # noqa: BLE001
                    pass
        return self._ended(t0, ok, fail_on_fix)

    async def _execute(self, req: dict, steps: list[dict], order: list[dict], secrets: dict[str, Secret],
                       stop: asyncio.Event) -> bool:
        """True when every step passed (or healed)."""
        refs = secret_refs(steps)
        first = order[0] if order else None
        refs += [(first, n) for n in calls.call_secret_refs(req.get("setUp")) + calls.call_secret_refs(req.get("cleanUp"))]
        for s, name in refs:
            problem = secret_problem(name, secrets.get(name), self.as_runner)
            if problem:
                if s is not None:
                    self._fail(s, StepFailed("secretMissing", problem))
                else:
                    self.message = problem
                return False
        self.reached_set_up = True
        if self.from_id is not None:
            # On the page as it is: no set-up call, no fresh browser.
            if not self.b.is_open:
                self.message = "The browser isn't open."
                return False
            ctx = Context(self.t, secrets=secrets, stop=stop, relaxed=self.relaxed, files_dir=self.files_dir)
            return await self._run_list(steps, ctx, stop, iteration=None)
        if req.get("setUp"):
            reply = await calls.make(req["setUp"], self.app_url, secrets, self.t.http_timeout)
            log.info("set-up call: %s", reply.info)
            if not reply.ok:
                msg = MESSAGES["setUpFailed"] + (f" {reply.message}" if reply.message else "")
                if order:
                    self._fail(order[0], StepFailed("setUpFailed", msg, details=reply.info))
                else:
                    self.message = msg
                return False
        try:
            await self.b.open(req.get("startUrl") or "", req.get("viewport") or {})
        except Exception as e:  # noqa: BLE001
            msg = getattr(e, "message", None) or "The start page didn't load."
            if order:
                self._fail(order[0], StepFailed("timeout", msg))
            else:
                self.message = msg
            return False
        self._compare_systems(req.get("recordedOn"))
        # Let the start page settle, ignoring what the first step knows changes by itself (clocks...).
        first = next((s for s in order if s.get("action") not in ("loop", "group")), {})
        await checks.settle(self.b.shoot, first.get("ignore"), self.t.settle_interval, self.t.settle_frames,
                            self.t.settle_timeout)
        ctx = Context(self.t, secrets=secrets, stop=stop, relaxed=self.relaxed, files_dir=self.files_dir)
        return await self._run_list(steps, ctx, stop, iteration=None)

    def _compare_systems(self, recorded_on) -> None:
        """Where the test was recorded against where it runs (systems.py). A mismatch relaxes the
        screen checks when the client allows for small differences, and goes in run.ended."""
        self.ran_on = systems.current(self.b.chromium_version)
        self.mismatch = systems.mismatch(recorded_on, self.ran_on, relaxed=self.allow_differences)
        self.relaxed = self.mismatch is not None and self.allow_differences
        if self.mismatch:
            log.info("recorded on %s, running on %s (%s): screen checks %s", self.mismatch["recordedOn"], self.ran_on,
                     ", ".join(self.mismatch["differences"]), "relaxed" if self.relaxed else "strict")

    # ------------------------------------------------------------------

    def _ended(self, t0: float, ok: bool, fail_on_fix: bool) -> dict:
        healed = any(r["result"] == "healed" for r in self.results)
        result = "pass" if ok and not (healed and fail_on_fix) else "fail"
        out = {"runId": self.run_id, "result": result, "durationMs": int((time.monotonic() - t0) * 1000),
               "steps": self.results}
        if self.clean_up_failed:
            out["cleanUpFailed"] = True
        if self.ran_on:
            out["ranOn"] = self.ran_on
        if self.mismatch:
            out["systemMismatch"] = self.mismatch
        if result == "fail":
            out["message"] = self.message or ("A step was fixed by the AI assistant and this run fails on fixes."
                                              if ok else "The test failed.")
            if self.details:
                out["details"] = self.details
        return out

    def _event(self, step: dict, state: str, iteration: int | None, **fields) -> None:
        data = {"runId": self.run_id, "index": self.index[id(step)], "stepId": step.get("id"), "state": state}
        if iteration is not None:
            data["iteration"] = iteration
        data.update({k: v for k, v in fields.items() if v is not None})
        self.emit("run.step", data)

    def _fail(self, step: dict, err: StepFailed, iteration: int | None = None) -> None:
        i = self.index[id(step)]
        rec = {"stepId": step.get("id"), "result": "failed", "reason": err.reason}
        for k in ("preDistance", "postDistance", "oldAt", "newAt", "screenshotPath", "timings"):
            if err.extra.get(k) is not None:
                rec[k] = err.extra[k]
        self.results[i] = rec
        self.message = self.message or err.message
        self.details = self.details or err.extra.get("details")
        self._event(step, "failed", iteration, reason=err.reason, message=err.message, details=err.extra.get("details"),
                    preDistance=rec.get("preDistance"), postDistance=rec.get("postDistance"),
                    oldAt=rec.get("oldAt"), newAt=rec.get("newAt"), screenshot=rec.get("screenshotPath"),
                    timings=rec.get("timings"))

    async def _run_list(self, steps: list[dict], ctx: Context, stop: asyncio.Event, iteration: int | None) -> bool:
        for step in steps:
            if not self._started:
                # Play this step: skip what comes before it (a loop or card around it still runs,
                # so its children get their repeat number, and skips them the same way).
                if step.get("id") == self.from_id:
                    self._started = True
                elif not any(s.get("id") == self.from_id for s in walk(step.get("steps") or [])):
                    continue
            if stop.is_set():
                self._fail(step, StepFailed("stopped"), iteration)
                return False
            self._event(step, "running", iteration)
            kind = step.get("action")
            if kind in ("loop", "group"):
                ok = await self._run_container(step, ctx, stop, iteration)
                if not ok:
                    return False
                self._stop_if_reached(step)
                continue
            try:
                rec = await self._run_step(step, ctx, iteration)
            except (StepFailed, Exception) as e:  # noqa: BLE001 - a crash still fails just this step
                if not isinstance(e, StepFailed):
                    log.exception("step %s crashed", step.get("id"))
                    e = StepFailed("unexpectedScreen", "Something went wrong in the engine during this step.",
                                   details=f"{type(e).__name__}: {e}")
                if e.reason not in ("stopped", "secretMissing"):
                    e.extra.setdefault("screenshotPath", await self._keep_screenshot(step))
                    await self._keep_page(e)
                self._fail(step, e, iteration)
                return False
            rec = {k: v for k, v in rec.items() if v is not None}
            prev = self.results[self.index[id(step)]]
            if prev.get("result") == "healed" and rec["result"] == "passed":
                rec = prev   # a heal in an earlier repeat stays visible
            self.results[self.index[id(step)]] = rec
            self._event(step, rec["result"], iteration, preDistance=rec.get("preDistance"),
                        postDistance=rec.get("postDistance"), oldAt=rec.get("oldAt"), newAt=rec.get("newAt"),
                        screenshot=rec.get("screenshotPath"), passedBy=rec.get("passedBy"), why=rec.get("why"),
                        timings=rec.get("timings"), unchecked=rec.get("unchecked"))
            self._stop_if_reached(step)
        return True

    def _stop_if_reached(self, step: dict) -> None:
        """Play to here: the loops and cards around the step count as passed so far."""
        if self.up_to is None or step.get("id") != self.up_to:
            return
        for s in self._parents(step):
            i = self.index[id(s)]
            if self.results[i]["result"] == "notRun":
                self.results[i] = {"stepId": s.get("id"), "result": "passed"}
        raise _Reached()

    def _parents(self, step: dict) -> list[dict]:
        def find(steps, path):
            for s in steps:
                if s is step:
                    return path
                got = find(s.get("steps") or [], path + [s])
                if got is not None:
                    return got
            return None
        return find(self._steps, []) or []

    async def _run_container(self, step: dict, ctx: Context, stop: asyncio.Event, iteration: int | None) -> bool:
        children = step.get("steps") or []
        idx = self.index[id(step)]
        if step.get("action") == "loop":
            count = max(0, int(step.get("count") or 1))
            for n in range(1, count + 1):
                saved, ctx.i = ctx.i, n
                try:
                    ok = await self._run_list(children, ctx, stop, iteration=n)
                finally:
                    ctx.i = saved
                if not ok:
                    return self._container_failed(step, children, iteration)
        else:
            if not await self._run_list(children, ctx, stop, iteration):
                return self._container_failed(step, children, iteration)
        healed = any(self.results[self.index[id(c)]]["result"] == "healed" for c in walk(children))
        self.results[idx] = {"stepId": step.get("id"), "result": "healed" if healed else "passed"}
        self._event(step, self.results[idx]["result"], iteration)
        return True

    def _container_failed(self, step: dict, children: list[dict], iteration: int | None) -> bool:
        reason = next((self.results[self.index[id(c)]].get("reason") for c in walk(children)
                       if self.results[self.index[id(c)]]["result"] == "failed"), "unexpectedScreen")
        idx = self.index[id(step)]
        self.results[idx] = {"stepId": step.get("id"), "result": "failed", "reason": reason}
        self._event(step, "failed", iteration, reason=reason)
        return False

    async def _read_note(self, note: str) -> dict | None:
        """The AI assistant's reading of the screen against "What should happen"'s note, or None."""
        try:
            loc = self.locator_fn()
            if not loc.available() or not hasattr(loc, "judge"):
                return None
            return await loc.judge(imaging.to_image(await self.b.shoot()), str(note)[:300])
        except Exception as e:  # noqa: BLE001
            log.info("couldn't read the note: %s", e)
            return None

    async def _keep_screenshot(self, step: dict) -> str | None:
        """On failure (or heal) keep the current screen locally for the report (spec §11.6)."""
        if not self.b.is_open:
            return None
        try:
            folder = Path(self.screenshots) / safe_name(self.run_id, "run")
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"{self.index[id(step)] + 1:03d}-{safe_name(step.get('id'), 'step')}.png"
            await (await self.b.live()).screenshot(path=str(path), type="png")
            return str(path)
        except Exception as e:  # noqa: BLE001
            log.info("couldn't keep screenshot: %s", e)
            return None

    async def _keep_page(self, err: StepFailed) -> None:
        """For `run.explain` later: the controls and short texts on screen at a failure, kept next
        to its screenshot. Only when an explainer is registered and wants it (Team, with the
        licence feature), for the reasons it explains, and never longer than PAGE_READ_S."""
        shot = err.extra.get("screenshotPath")
        if not shot or err.reason not in explain.EXPLAINED or self.explainer is None or not self.b.is_open:
            return
        try:
            if not self.explainer.wants_page():
                return
            from .dom.extract import extract
            ex = await asyncio.wait_for(
                extract(await self.b.live(), (self.b.width, self.b.height), texts=True), explain.PAGE_READ_S)
            await asyncio.to_thread(explain.save_page, shot, explain.page_record(ex.candidates, ex.texts))
        except Exception as e:  # noqa: BLE001 - a page that can't be read is explained from the screenshot
            log.info("couldn't read the page for an explanation: %s", e)

    # ------------------------------------------------------------------ one step (spec §11.1)

    async def _run_step(self, step: dict, ctx: Context, iteration: int | None) -> dict:
        kind = step.get("action")
        ignore = step.get("ignore") or []
        rec: dict = {"stepId": step.get("id"), "result": "passed"}
        clock = time.monotonic()
        timings: dict = {}
        rec["timings"] = timings

        def lap(name: str) -> None:
            nonlocal clock
            now = time.monotonic()
            timings[name] = int((now - clock) * 1000)
            clock = now

        if kind == "waitFor":
            # Wait N seconds only waits: any pre, post or expect a file has on it (recorded before
            # this rule) is ignored. The next step's pre-check still guards the page.
            try:
                await perform(self.b, {"id": step.get("id"), "action": "waitFor", "durationMs": step.get("durationMs")}, ctx)
            except ActionFailed as e:
                raise StepFailed(e.reason, e.message)
            lap("actionMs")
            return rec

        # A check whose ignore zones cover its whole area compares nothing (a blank area always
        # hashes the same): it is skipped and the step is flagged "unchecked", never passed silently.
        unchecked: list[str] = []

        def usable(region, what: str) -> bool:
            if imaging.uncovered_share(region, ignore, self.b.width, self.b.height) >= config.MIN_CHECKED:
                return True
            unchecked.append(what)
            rec["unchecked"] = unchecked
            return False

        if kind in ("checkpoint", "waitUntil") and step.get("region") and not usable(step["region"], kind):
            return rec

        if kind == "checkpoint":
            tol = config.check_tolerance(step.get("tolerance", config.CHECKPOINT_TOLERANCE), self.relaxed)
            dist = await self._wait_region(step["region"], step["hash"], tol, ignore)
            rec["postDistance"] = dist
            if dist > tol:
                raise StepFailed("unexpectedScreen", "What this check looks for isn't visible.", postDistance=dist)
            return rec

        at = step.get("at")
        frm = step.get("from")
        pre = step.get("pre")
        if pre and not usable(pre["region"], "pre"):
            pre = None
        if pre:
            tol = config.check_tolerance(pre.get("tolerance", config.PRE_TOLERANCE), self.relaxed)
            dist = await self._wait_region(pre["region"], pre["hash"], tol, ignore)
            rec["preDistance"] = dist
            timings["preTries"] = self._tries
            if dist > tol:
                if not self.auto_fix or self.healer is None:
                    raise StepFailed("targetNotFound", preDistance=dist)
                at, frm, new_dist = await self.healer(self, step, pre, ignore, iteration, dist)
                rec.update({"result": "healed", "oldAt": step.get("at") or step.get("from"),
                            "newAt": at or frm, "preDistance": new_dist})

        url_before = self.b.url
        own = None
        if step.get("expect") in ("changes", "noChange") and at is not None and kind in CLICK_LIKE:
            # The clicked control itself (read through the DevTools protocol, before the click).
            box = await self.b.element_box(at)
            own = [box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4] if box else None
        lap("preMs")
        before = await self.b.shoot()
        try:
            await perform(self.b, step, ctx, at=at, frm=frm)
        except ActionFailed as e:
            raise StepFailed(e.reason, e.message, **_keep(rec))
        lap("actionMs")

        post = step.get("post")
        if post and not usable(post["region"], "post"):
            post = None
        settle_ignore = ignore
        after, settled = await checks.settle(self.b.shoot, settle_ignore, self.t.settle_interval,
                                             self.t.settle_frames, self.t.settle_timeout)
        lap("settleMs")
        timings["settled"] = settled
        if post:
            self._passed_by = None
            reason, dist = await self._post_check(post, before, after, ignore, settled, step.get("expect"), url_before,
                                                  own)
            lap("postMs")
            timings["postTries"] = self._tries
            rec["postDistance"] = dist
            message = self._post_message
            if reason and step.get("expectNote"):
                # Only now, on a failure: the AI assistant reads the step's note to judge it.
                verdict = await self._read_note(step["expectNote"])
                if verdict and verdict.get("happened"):
                    reason, self._passed_by = None, "note"
                    rec["why"] = f"The note says this {_note(step['expectNote'])}; it did, so this passed."
                elif verdict:
                    message = f"The note says this {_note(step['expectNote'])}; {verdict.get('why') or 'it did not happen'}."
            if not reason and self._passed_by:
                rec["passedBy"] = self._passed_by
            if reason:
                if reason == "unexpectedScreen" and not settled:
                    reason = "timeout"
                raise StepFailed(reason, message, **_keep(rec))
        if rec["result"] == "healed":
            rec["screenshotPath"] = await self._keep_screenshot(step)
        return rec

    async def _wait_region(self, region, want: str, tol: int, ignore) -> int:
        """Distance between the region now and its stored hash, retried briefly while the page catches up."""
        end = time.monotonic() + self.t.pre_wait
        best = 64
        self._tries = 0
        while True:
            self._tries += 1
            arr = await self.b.shoot()
            best = min(best, imaging.region_distance(arr, region, want, ignore, self.relaxed))
            if best <= tol or time.monotonic() >= end:
                return best
            await asyncio.sleep(self.t.pre_interval)

    def _judge(self, post: dict, before: np.ndarray, after: np.ndarray, ignore, settled: bool, expect: str | None,
               moved_page: bool, tol: int, dist_before: int, own=None) -> tuple[str | None, int]:
        """One look at the screen after the step: (fail reason or None, distance to the recorded
        result). `expect` is the step's "What should happen" (absent: the checks as before it existed)."""
        region = post["region"]
        dist = imaging.region_distance(after, region, post["hash"], ignore, self.relaxed)
        changed = imaging.region_changed(before, after, region, ignore)
        share = imaging.changed_share(before, after, region, ignore) if changed else 0.0
        recorded = float(post["change"]) if isinstance(post.get("change"), (int, float)) else None
        comparable = recorded is None or share >= config.POST_CHANGE_SHARE * recorded
        closer = dist_before - dist >= config.POST_CLOSER
        away = imaging.distance(imaging.region_hash(before, region, ignore), imaging.region_hash(after, region, ignore))
        self._post_message = None

        if expect == "noChange":
            # Nothing visible should change: a change is the failure.
            outside = list(ignore) + ([own] if own else [])
            if imaging.region_changed(before, after, region, outside):
                self._post_message = "Something changed on the page, but this step expects nothing to change."
                return "unexpectedScreen", dist
            return (None if dist <= tol else "unexpectedScreen"), dist
        if expect == "changes":
            # Text or a value changes: it must differ from before, somewhere other than the control
            # itself (a button looks pressed or focused after any click); what it changes to may
            # differ from the recording.
            outside = list(ignore) + ([own] if own else [])
            if imaging.region_changed(before, after, region, outside):
                return None, dist
            return "noChange", dist
        if expect == "newPage":
            if (moved_page or (changed and comparable)) and (dist <= tol or away >= config.GONE_DISTANCE):
                return None, dist
            return ("noChange" if not changed and not moved_page else "unexpectedScreen"), dist

        # "appears", "closes", or no choice: the recorded result, reached by this step.
        ok_change = changed and (recorded is None or dist > tol or closer or comparable)
        if post.get("expectChange") and not ok_change:
            return "noChange", dist
        if dist > tol:
            if expect == "closes" and self._gone(post, before, after, ignore, settled):
                self._passed_by = "gone"
                return None, dist
            return "unexpectedScreen", dist
        return None, dist

    def _gone(self, post: dict, before: np.ndarray, after: np.ndarray, ignore, settled: bool) -> bool:
        """What the step removed is clearly gone (a dialog it closed), though the page behind it
        differs from the recording: the area is now far from how it looked just before the action,
        and about as much of it changed as when recorded. Judged only on a settled screen, so a
        half-faded dialog isn't taken as gone; a dialog that stayed, or only partly went, fails."""
        if not settled:
            return False
        region = post["region"]
        away = imaging.distance(imaging.region_hash(before, region, ignore), imaging.region_hash(after, region, ignore))
        share = imaging.changed_share(before, after, region, ignore)
        recorded = float(post["change"]) if isinstance(post.get("change"), (int, float)) else 0.0
        return away >= config.GONE_DISTANCE and share >= config.GONE_SHARE * recorded

    async def _post_check(self, post: dict, before: np.ndarray, after: np.ndarray, ignore,
                          settled: bool = True, expect: str | None = None,
                          url_before: str | None = None, own=None) -> tuple[str | None, int]:
        tol = config.check_tolerance(post.get("tolerance", config.POST_TOLERANCE), self.relaxed)
        end = time.monotonic() + self.t.settle_timeout
        # How close the screen was to the recorded result just before the action: a step that
        # really did something gets closer to it, a miss (a button that only lit up) doesn't.
        dist_before = imaging.region_distance(before, post["region"], post["hash"], ignore, self.relaxed)
        if expect not in EXPECTS:
            expect = None
        self._tries = 0
        while True:
            self._tries += 1
            moved = url_before is not None and self.b.url.split("#")[0] != url_before.split("#")[0]
            reason, dist = self._judge(post, before, after, ignore, settled, expect, moved, tol, dist_before, own)
            if reason is None or time.monotonic() >= end:
                return reason, dist
            # A slow server (or a fade-out) can leave the old screen "settled" for a moment: give it
            # until the timeout, judging only settled screens.
            await asyncio.sleep(self.t.settle_interval)
            after, settled = await checks.settle(self.b.shoot, ignore, self.t.settle_interval, self.t.settle_frames,
                                                 max(0.0, end - time.monotonic()))


CLICK_LIKE = ("click", "doubleClick", "longClick", "rightClick", "hover")   # the control's own look isn't the effect
EXPECTS = ("newPage", "closes", "appears", "changes", "noChange")


_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


def safe_name(value, fallback: str) -> str:
    """A run or step id as a file name: letters, digits, _ and - only, at most 64 characters, so an
    id from a test file can't point outside the screenshots folder (`../../x`, `/etc/x`)."""
    s = _UNSAFE.sub("_", str(value or "")).strip("_")[:64]
    return s or fallback


def secret_problem(name: str, secret: Secret | None, as_runner: bool) -> str | None:
    """Why a secret can't be used in this run at all, checked before any call or action."""
    if secret is None:
        return f"The saved secret {name} isn't on this Mac."
    if not secret.origins:
        return f"{name} isn't allowed on any site yet. Add the sites it's for in Settings, Saved secrets."
    if as_runner and not secret.runner_can_use:
        return (f"{name} can't be used by the runner. Turn on Runner can use for it in Settings, "
                "Saved secrets, on this Mac.")
    return None


def _note(note: str) -> str:
    """ "closes the What's new dialog" as it reads after "The note says this"."""
    n = str(note).strip().rstrip(".")
    return n[0].lower() + n[1:] if n else n


def _keep(rec: dict) -> dict:
    return {k: rec[k] for k in ("preDistance", "postDistance", "oldAt", "newAt", "timings") if k in rec}
