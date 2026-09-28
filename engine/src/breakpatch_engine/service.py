"""The engine's request handlers (engine/PROTOCOL.md), wired to the browser, recorder, runner and setup."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Callable

from . import calls, config, install, plugins
from .actions import parse_secrets
from .browser import BrowserSession
from .locator import Locator, MlxLocator, NoLocator
from .protocol import EngineError
from .recorder import Recorder
from .runner import Healer, Runner, walk as _walk

log = logging.getLogger("breakpatch.service")

Emit = Callable[[str, dict], None]

TRY_TIMEOUT = 15.0        # seconds; the UI says "No reply after 15 s"
_TEAM_HEALER = object()   # default: whatever plugins.py found (the Team engine's healer, or none)


def default_locator_factory() -> Callable[[], Locator]:
    """The installed model, or NoLocator. The model itself only loads on first use."""
    cache: dict[str, Locator] = {}

    def get() -> Locator:
        info = install.installed_model()
        if not info.get("installed") or not MlxLocator.importable():
            return NoLocator()
        path = info["path"]
        if path not in cache:
            cache.clear()   # a different model was installed: drop the old one from memory
            cache[path] = MlxLocator(Path(path))
        return cache[path]

    return get


class Engine:
    def __init__(self, emit: Emit, timings: config.Timings | None = None,
                 locator_fn: Callable[[], Locator] | None = None, headless: bool | None = None,
                 healer: Healer | None | object = _TEAM_HEALER):
        self.emit = emit
        # Fallback healing is Team-only (plugins.py); None runs moved targets as targetNotFound.
        self.healer: Healer | None = plugins.healer() if healer is _TEAM_HEALER else healer  # type: ignore[assignment]
        self.timings = timings or config.Timings.from_env()
        self.locator_fn = locator_fn or default_locator_factory()
        self.browser = BrowserSession(self.timings, on_frame=lambda d: emit("frame", d), headless=headless)
        self.recorder = Recorder(self.browser, self.locator_fn, self.timings, emit)
        self.setup = install.Setup(lambda d: emit("setup.progress", d))
        self._activity: str | None = None      # "recording" | "run"
        self._run: tuple[str, asyncio.Task, asyncio.Event] | None = None
        self._browser_lock = asyncio.Lock()

    def handlers(self) -> dict:
        return {
            "system.info": self.system_info,
            "licence.set": self.licence_set,
            "setup.installBrowser": lambda p: self.setup.install_browser(),
            "setup.downloadModel": lambda p: self.setup.download_model(p.get("repo"), p.get("revision")),
            "setup.pause": lambda p: self.setup.pause(p.get("task")),
            "setup.removeModel": self.remove_model,
            "browser.open": self.browser_open,
            "browser.close": self.browser_close,
            "browser.navigate": self.browser_navigate,
            "browser.pointer": self.browser_pointer,
            "record.point": self.record_point,
            "record.locate": self.record_locate,
            "record.checkpoint": self.record_checkpoint,
            "record.propose": self.record_propose,
            "record.chooseFile": lambda p: self._sync(self.recorder.choose_file(p)),
            "run.start": self.run_start,
            "run.stop": self.run_stop,
            "call.try": self.call_try,
        }

    # ---------------------------------------------------------------- system

    async def system_info(self, p: dict) -> dict:
        return await asyncio.to_thread(install.system_info)

    async def licence_set(self, p: dict) -> dict:
        """The app shell hands over its licence token (or null). The Team engine checks it itself;
        a run in progress keeps going and picks up the new state at its next failed pre-check."""
        token = p.get("token")
        if token is not None and not isinstance(token, str):
            raise EngineError("bad_request", "The engine received a licence it couldn't read.", type(token).__name__)
        lic = plugins.licence()
        if lic is None:
            return dict(plugins.UNAVAILABLE)
        return await asyncio.to_thread(lic.set, token)

    async def remove_model(self, p: dict) -> dict:
        if self._activity == "run":
            raise EngineError("busy", "Wait for the run to finish before removing the AI assistant.")
        await self.setup.remove_model()
        return {}

    # ---------------------------------------------------------------- browser

    def _not_during_run(self) -> None:
        if self._activity == "run":
            raise EngineError("busy", "A test is running. Wait for it to finish or stop it.")

    async def browser_open(self, p: dict) -> dict:
        self._not_during_run()
        async with self._browser_lock:
            await self.browser.open(p.get("url") or "", p.get("viewport") or {})
        return {}

    async def browser_close(self, p: dict) -> dict:
        self._not_during_run()
        async with self._browser_lock:
            await self.browser.close()
        return {}

    async def browser_navigate(self, p: dict) -> dict:
        self._not_during_run()
        self.browser.require()
        await self.browser.navigate(p.get("nav") or "url", p.get("url"))
        return {}

    async def browser_pointer(self, p: dict) -> dict:
        self._not_during_run()
        if self._activity == "recording":
            # Scrolling now would move the page between the user's click and the engine's.
            raise EngineError("busy", "Wait for the step to finish before scrolling the page.")
        self.browser.require()
        at = p.get("at")
        if not (isinstance(at, list) and len(at) == 2):
            raise EngineError("bad_request", "The engine received a position it couldn't read.", repr(at))
        if p.get("kind") == "scroll":
            await self.browser.wheel(at, float(p.get("dx") or 0), float(p.get("dy") or 0))
        else:
            await self.browser.move(at)
        return {}

    # ---------------------------------------------------------------- recording

    async def _recording(self, fn):
        self._not_during_run()
        if self._activity == "recording":
            raise EngineError("busy", "The engine is still checking the last step.")
        self._activity = "recording"
        try:
            return await fn()
        finally:
            self._activity = None

    async def record_point(self, p: dict) -> dict:
        phase = lambda ph: self.emit("record.checking", {"phase": ph})  # noqa: E731
        return {"step": await self._recording(lambda: self.recorder.point(p, phase))}

    async def record_checkpoint(self, p: dict) -> dict:
        phase = lambda ph: self.emit("record.checking", {"phase": ph})  # noqa: E731
        region = p.get("region")
        if not (isinstance(region, list) and len(region) == 4):
            raise EngineError("bad_request", "Draw a box around what should be visible.")
        return {"step": await self._recording(
            lambda: self.recorder.checkpoint([int(v) for v in region], phase, p.get("frame")))}

    @staticmethod
    async def _sync(value):
        return value

    async def record_propose(self, p: dict):
        self._not_during_run()
        if self._activity == "recording":
            raise EngineError("busy", "The engine is still checking the last step.")
        return await self.recorder.propose(p)

    async def record_locate(self, p: dict):
        self._not_during_run()
        self.browser.require()
        return await self.recorder.locate(p.get("description") or "")

    # ---------------------------------------------------------------- replay

    async def run_start(self, p: dict) -> dict:
        if self._activity is not None:
            raise EngineError("busy", "Another test is running or a step is being recorded.")
        if not isinstance(p.get("steps"), list):
            raise EngineError("bad_request", "This test has no steps to run.")
        if not install.browser_status().get("installed"):
            raise EngineError("not_ready", "The browser isn't installed yet. Finish setup to install it.")
        run_id = str(p.get("runId") or "run")
        up_to = p.get("upToStepId")
        if up_to is not None and not any(s.get("id") == up_to for s in _walk(p["steps"])):
            raise EngineError("bad_request", "That step isn't in this test.", str(up_to)[:80])
        stop = asyncio.Event()
        self._activity = "run"
        runner = Runner(self.browser, self.locator_fn, self.timings, self.emit, healer=self.healer)

        async def go():
            try:
                ended = await runner.run(p, stop)
            except Exception as e:  # noqa: BLE001
                log.exception("run crashed")
                ended = {"runId": run_id, "result": "fail", "durationMs": 0,
                         "steps": getattr(runner, "results", []),
                         "message": "Something went wrong in the engine.", "details": f"{type(e).__name__}: {e}"}
            finally:
                self._activity = None
                self._run = None
            self.emit("run.ended", ended)

        self._run = (run_id, asyncio.create_task(go()), stop)
        return {}

    async def run_stop(self, p: dict) -> dict:
        if self._run and (not p.get("runId") or str(p["runId"]) == self._run[0]):
            self._run[2].set()
        return {}

    # ---------------------------------------------------------------- set-up and clean-up calls

    async def call_try(self, p: dict) -> dict:
        """"Try it" for a set-up or clean-up call: the same rules as a run (calls.py), one request."""
        call = p.get("call")
        if not isinstance(call, dict):
            raise EngineError("bad_request", "There's no call to try.")
        reply = await calls.make(call, p.get("appUrl"), parse_secrets(p.get("secrets")), TRY_TIMEOUT)
        log.info("tried a call: %s", reply.info)
        return reply.to_json()

    async def shutdown(self) -> None:
        if self._run:
            self._run[2].set()
        for t in self.setup.tasks.values():
            if t.proc is not None:
                try:
                    t.proc.terminate()
                except ProcessLookupError:
                    pass
        await self.browser.close()
