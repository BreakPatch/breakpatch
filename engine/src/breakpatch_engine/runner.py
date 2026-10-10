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

from . import calls, checks, config, explain, imaging, retry, systems
from .actions import (TEAM_ACTIONS, ActionFailed, Context, EmailSession, Secret, email_address, fill_email, parse_secrets,
                      perform, secret_refs)
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
    "callFailed": "The call to your API didn't work.",
    "actionUnavailable": "This step needs Breakpatch Team.",
    "emailFailed": "The test inbox couldn't be read.",
}
# What a step the Team engine performs (plugins.register_action) may add to its StepRun.
ACTION_FIELDS = ("email",)


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
        # Values Call steps kept (actions.Context.values): those of the recorder's session for Play
        # this step, and after the run, those the run kept (the recorder carries on with them).
        self.values: dict[str, tuple[str, str | None]] = {}
        # `{email}` for this try (actions.EmailSession): for Play this step, the recorder's; after the
        # run, the last try's (the recorder carries on with it). Every try of a run shares `used`.
        self.email: EmailSession | None = None

    async def run(self, req: dict, stop: asyncio.Event) -> dict:
        """The whole run: one try, and with `settings.retries` up to that many more when a try
        fails in a way that may be timing (retry.py). Each try starts again from the start, in a
        new browser, with the set-up and clean-up calls. run.ended is the last try's, with
        `attempts` and each earlier try's failure on its step (`retried`)."""
        settings = req.get("settings") or {}
        fail_on_fix = bool(settings.get("failOnFix"))
        # The recorder's Run, Play to here and Play this step leave the page for recording: never retried.
        retries = 0 if (req.get("keepOpen") or req.get("fromStepId")) else retry.retries_setting(settings.get("retries"))
        t0 = time.monotonic()
        earlier: list[dict] = []
        clean_up_failed = False
        self.attempt = 1
        self._email_used: set = self.email.used if self.email is not None else set()
        while True:
            started = time.monotonic()
            ok = await self._attempt(req, stop)
            clean_up_failed = clean_up_failed or self.clean_up_failed
            if ok or self.attempt > retries or stop.is_set():
                break
            failed = self._failed_step()
            why = retry.why_retry(failed[1], failed[0], self.relaxed) if failed else None
            if failed is None or why is None:
                break
            if time.monotonic() - t0 >= self.t.retry_budget:
                log.info("not retried: the run has taken %.0f s already (at most %.0f s)", time.monotonic() - t0,
                         self.t.retry_budget)
                break
            step, rec = failed
            entry = {"attempt": self.attempt, "reason": rec.get("reason"), "message": self.message,
                     "durationMs": int((time.monotonic() - started) * 1000)}
            entry.update({k: rec[k] for k in ("preDistance", "postDistance", "screenshotPath") if rec.get(k) is not None})
            earlier.append({"stepId": step.get("id"), **entry})
            log.info("try %d of %d failed at %s (%s): %s, so it runs again", self.attempt, retries + 1, step.get("id"),
                     rec.get("reason"), why)
            self.emit("run.retry", {"runId": self.run_id, "attempt": self.attempt + 1, "of": retries + 1,
                                    "stepId": step.get("id"), "reason": rec.get("reason"), "why": why,
                                    "message": self.message})
            try:
                await asyncio.wait_for(stop.wait(), self.t.retry_pause)
            except asyncio.TimeoutError:
                pass
            if stop.is_set():
                break
            # The next try starts clean: the clean-up call this try left out (it runs after a failure
            # only with alsoOnFailure) runs now, so a set-up that adds things doesn't meet its own.
            if self.clean_up_skipped and not await self._clean_up(req["cleanUp"]):
                clean_up_failed = True
            self.attempt += 1
        self.clean_up_failed = clean_up_failed
        return self._ended(t0, ok, fail_on_fix, earlier)

    def _failed_step(self) -> tuple[dict, dict] | None:
        """The step that failed this try (not the loop or shared-steps card around it, unless the
        failure is its own: a start page that didn't load fails the first step, whatever it is),
        and its StepRun."""
        failed = [(s, self.results[self.index[id(s)]]) for s in walk(self._steps)]
        failed = [(s, r) for s, r in failed if r.get("result") == "failed"]
        leaves = [(s, r) for s, r in failed if not (s.get("action") in ("loop", "group") and s.get("steps"))]
        return (leaves or failed or [None])[-1]

    async def _attempt(self, req: dict, stop: asyncio.Event) -> bool:
        """One try: secrets, set-up call, a new browser at the start page, the steps, the clean-up call."""
        run_id = str(req.get("runId") or "run")
        steps = req.get("steps") or []
        settings = req.get("settings") or {}
        auto_fix = bool(settings.get("autoFix"))
        # "Allow for small differences between systems": on unless the client turns it off.
        self.allow_differences = settings.get("allowSystemDifferences") is not False
        self.relaxed, self.ran_on, self.mismatch = False, None, None
        # Older clients send bare values: those count as allowed on the start page's site only.
        secrets = parse_secrets(req.get("secrets"), origin_of(req.get("startUrl")))
        self.secrets = secrets
        self.as_runner = bool(req.get("runner"))
        # Set-up and clean-up calls may only reach the app's own hosts (calls.py).
        self.app_url = str(req.get("appUrl") or req.get("startUrl") or "")
        # The test inbox a Wait for an email step reads and `{email}` builds on (Breakpatch Team).
        self.inbox = req.get("inbox") if isinstance(req.get("inbox"), dict) else None
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
        self.clean_up_skipped = False
        self.reached_set_up = False   # clean-up never runs for a run that stopped before set-up
        ok = False
        try:
            try:
                ok = await self._execute(req, steps, order, secrets, stop)
            except _Reached:
                ok = True
        finally:
            clean_up = None if self.keep_open else req.get("cleanUp")
            if clean_up and self.reached_set_up:
                if ok or clean_up.get("alsoOnFailure"):
                    self.clean_up_failed = not await self._clean_up(clean_up)
                else:
                    self.clean_up_skipped = True   # run() makes it before another try
            if not self.keep_open:
                try:
                    await self.b.close()
                except Exception:  # noqa: BLE001
                    pass
        return ok

    async def _clean_up(self, clean_up: dict) -> bool:
        """The clean-up call: True when it went through."""
        reply = await calls.make(clean_up, self.app_url, self.secrets, self.t.http_timeout)
        log.info("clean-up call: %s", reply.info)
        return reply.ok

    async def _execute(self, req: dict, steps: list[dict], order: list[dict], secrets: dict[str, Secret],
                       stop: asyncio.Event) -> bool:
        """True when every step passed (or healed)."""
        refs = secret_refs(steps)
        first = order[0] if order else None
        # The test inbox's password, for its first Wait for an email step (the step says so if it's missing).
        waits = [s for s in order if s.get("action") == "emailWait"]
        if waits and self.inbox and self.inbox.get("passwordRef"):
            refs.append((waits[0], str(self.inbox["passwordRef"])))
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
            if self.email is None:
                self.email = EmailSession(used=self._email_used)
            ctx = self._context(secrets, stop)
            return await self._run_list(steps, ctx, stop, iteration=None)
        self.values = {}
        # Every try its own `{email}` address, and only emails from now on count for it.
        self.email = EmailSession(used=self._email_used)
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
        ctx = self._context(secrets, stop)
        return await self._run_list(steps, ctx, stop, iteration=None)

    def _context(self, secrets: dict[str, Secret], stop: asyncio.Event) -> Context:
        from . import plugins
        email = self.email or EmailSession(used=self._email_used)
        # `{email}` only when a test inbox was sent and something can read it (the Team engine).
        address = (email_address(self.inbox.get("address"), email.tag)
                   if self.inbox and plugins.action("emailWait") is not None else None)
        ctx = Context(self.t, secrets=secrets, stop=stop, relaxed=self.relaxed, files_dir=self.files_dir,
                      values=self.values, app_url=self.app_url, inbox=self.inbox, email=address,
                      email_since=email.since, email_used=email.used)
        self.values = ctx.values
        return ctx

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

    def _ended(self, t0: float, ok: bool, fail_on_fix: bool, earlier: list[dict] | None = None) -> dict:
        healed = any(r["result"] == "healed" for r in self.results)
        result = "pass" if ok and not (healed and fail_on_fix) else "fail"
        steps = self.results
        if earlier:
            # Each earlier try's failure stays on the step it failed at, whatever the last try did there.
            where = {str(r.get("stepId")): i for i, r in enumerate(steps)}
            steps = [dict(r) for r in steps]
            for e in earlier:
                i = where.get(str(e["stepId"]))
                if i is not None:
                    steps[i].setdefault("retried", []).append({k: v for k, v in e.items() if k != "stepId" and v is not None})
        out = {"runId": self.run_id, "result": result, "durationMs": int((time.monotonic() - t0) * 1000),
               "steps": steps}
        if earlier:
            out["attempts"] = len(earlier) + 1
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
        for k in ("preDistance", "postDistance", "oldAt", "newAt", "screenshotPath", "timings", "reply", *ACTION_FIELDS):
            if err.extra.get(k) is not None:
                rec[k] = err.extra[k]
        self.results[i] = rec
        self.message = self.message or err.message
        self.details = self.details or err.extra.get("details")
        self._event(step, "failed", iteration, reason=err.reason, message=err.message, details=err.extra.get("details"),
                    preDistance=rec.get("preDistance"), postDistance=rec.get("postDistance"),
                    oldAt=rec.get("oldAt"), newAt=rec.get("newAt"), screenshot=rec.get("screenshotPath"),
                    timings=rec.get("timings"), reply=rec.get("reply"), email=rec.get("email"))

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
                # A Call step's failure is about its reply, not the page: no screenshot. The same for
                # a Wait for an email step's (the inbox's).
                if e.reason not in ("stopped", "secretMissing") and kind != "call" and kind not in TEAM_ACTIONS:
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
                        timings=rec.get("timings"), unchecked=rec.get("unchecked"), reply=rec.get("reply"),
                        email=rec.get("email"))
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
            again = f"-try{self.attempt}" if getattr(self, "attempt", 1) > 1 else ""     # an earlier try's stays
            path = folder / f"{self.index[id(step)] + 1:03d}-{safe_name(step.get('id'), 'step')}{again}.png"
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

        if kind == "call":
            return await self._call_step(step, ctx, rec, lap)
        if kind in TEAM_ACTIONS or (kind and _registered(kind)):
            return await self._action_step(step, ctx, rec, lap)

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

    async def _call_step(self, step: dict, ctx: Context, rec: dict, lap) -> dict:
        """A Call step (issue #44): one request to the app's API under the set-up call's rules
        (calls.py), judged by its status. Nothing on the page is checked. The report gets the status
        and the time, never the reply; a value it keeps (`keep`) goes to later Write steps only."""
        call = step.get("call")
        if not isinstance(call, dict):
            raise StepFailed("callFailed", "This step has no call to make.")
        keep = step.get("keep") if isinstance(step.get("keep"), dict) else None
        name = str(keep.get("name") or "") if keep else ""
        if keep and not calls.VALUE_NAME.match(name):
            raise StepFailed("callFailed", "The name this step keeps the value as uses letters, numbers and _ only.")
        call = calls.with_run_values(call, ctx.i)
        try:
            call = {k: (fill_email(v, ctx) if k in ("url", "body") and isinstance(v, str) else v) for k, v in call.items()}
        except ActionFailed as e:
            raise StepFailed(e.reason, e.message)
        made = asyncio.ensure_future(calls.make(
            call, self.app_url, ctx.secrets, calls.step_timeout(step.get("timeoutMs"), self.t.http_timeout),
            pass_status=step.get("passStatus"), keep=str(keep.get("path") or "") if keep else None))
        if ctx.stop is not None:
            # Stop doesn't wait for the reply (up to the step's timeout): the call is left to finish
            # on its own and its reply is dropped.
            stopped = asyncio.ensure_future(ctx.stop.wait())
            try:
                await asyncio.wait({made, stopped}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                stopped.cancel()
                let_go = not made.done()       # stopped, or the run itself was cancelled
                if let_go:
                    made.cancel()
            if let_go:
                raise StepFailed("stopped")
        reply = await made
        lap("actionMs")
        log.info("call step %s: %s", step.get("id"), reply.info)
        rec["reply"] = reply.shown()
        if not reply.ok:
            reason = "secretMissing" if reply.error == "secret" else "callFailed"
            raise StepFailed(reason, f"{MESSAGES['callFailed']} {reply.message or ''}".strip(), details=reply.info,
                             reply=rec["reply"] or None, timings=rec.get("timings"))
        if keep and reply.kept is not None:
            ctx.values[name] = (reply.kept, origin_of(call.get("url")))
        return rec

    async def _action_step(self, step: dict, ctx: Context, rec: dict, lap) -> dict:
        """A step the Team engine performs (plugins.register_action): Wait for an email (issue #12).
        Nothing on the page is checked. Without the Team engine it fails with `actionUnavailable`,
        never passes; what it adds to the StepRun is only ACTION_FIELDS (never a value it kept)."""
        from . import plugins
        kind = step.get("action")
        do = plugins.action(kind)
        if do is None:
            what = TEAM_ACTIONS.get(kind, "This step")
            raise StepFailed("actionUnavailable", f"{what} needs Breakpatch Team.", timings=rec.get("timings"))
        try:
            extra = await do(step, ctx)
        except ActionFailed as e:
            raise StepFailed(e.reason, e.message, timings=rec.get("timings"))
        lap("actionMs")
        if isinstance(extra, dict):
            rec.update({k: extra[k] for k in ACTION_FIELDS if isinstance(extra.get(k), dict)})
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


def _registered(kind: str) -> bool:
    from . import plugins
    return plugins.action(kind) is not None


def safe_name(value, fallback: str) -> str:
    """A run or step id as a file name: letters, digits, _ and - only, at most 64 characters, so an
    id from a test file can't point outside the screenshots folder (`../../x`, `/etc/x`)."""
    s = _UNSAFE.sub("_", str(value or "")).strip("_")[:64]
    return s or fallback


def secret_problem(name: str, secret: Secret | None, as_runner: bool) -> str | None:
    """Why a secret can't be used in this run at all, checked before any call or action."""
    if secret is None:
        return f"The saved secret {name} isn't on this Mac."
    if secret.refused:
        return secret.refused
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
