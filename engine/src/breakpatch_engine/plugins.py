"""Optional add-ons, found once at start-up (docs/editions.md).

The open engine is the Community edition. When the private Breakpatch Team engine
(`breakpatch_team_engine`) is installed next to it, it's imported here, in this one place,
and registers what it adds: fallback healing of moved targets (spec §11.2), the explainer that
says why a step failed in plain words (explain.py, roadmap #7), the planner that turns a user
story into proposed steps (plan.py, roadmap #10), step actions the open engine doesn't perform itself
(`register_action`: "Wait for an email", issue #12), and the licence that decides whether they're on. The app shell hands the engine its licence token with
`licence.set` (engine/PROTOCOL.md); this engine only passes it on to what the Team engine
registered, which checks it. Its CI command line is its own console script (`breakpatch-ci`)
and doesn't go through here.
"""
from __future__ import annotations

import importlib
import logging

from typing import Awaitable, Protocol

from .explain import Explainer
from .plan import Planner
from .runner import Healer

log = logging.getLogger("breakpatch.plugins")

TEAM_MODULE = "breakpatch_team_engine"

_healer: Healer | None = None
_loaded = False
_team_version: str | None = None     # set once the Team engine loaded and registered
_licence: "Licence | None" = None
_explainer: Explainer | None = None
_planner: Planner | None = None
_actions: dict[str, "StepAction"] = {}

UNAVAILABLE = {"state": "unavailable"}   # Community: no licence to check


class Licence(Protocol):
    """What the Team engine registers to receive the licence token."""

    def set(self, token: str | None) -> dict: ...   # returns the state as the engine sees it
    def to_json(self) -> dict: ...


class StepAction(Protocol):
    """A step action the Team engine performs (`register_action`): the step, and the run's or the
    recording's actions.Context. Returns what the step's StepRun adds (e.g. `{"email": {...}}`), or
    None; raises actions.ActionFailed with a FailReason and a plain sentence. It may also have
    `check(params) -> dict`, which a method of its own answers with (`email.check`)."""

    def __call__(self, step: dict, ctx) -> Awaitable[dict | None]: ...


def register_action(name: str, perform: "StepAction | None") -> None:
    """Called by the Team engine's `register(plugins)`: performs steps whose `action` is `name`
    (an older one never calls it: those steps fail with `actionUnavailable`). None removes it."""
    from .actions import BUILT_IN_ACTIONS
    if str(name) in BUILT_IN_ACTIONS:
        log.warning("the Team engine can't take over the %s action; ignored", name)
        return
    if perform is None:
        _actions.pop(str(name), None)
    else:
        _actions[str(name)] = perform


def register_healer(healer: Healer | None) -> None:
    """Called by the Team engine's `register(plugins)`."""
    global _healer
    _healer = healer


def register_licence(licence: Licence | None) -> None:
    """Called by the Team engine's `register(plugins)`."""
    global _licence
    _licence = licence


def register_explainer(explainer: Explainer | None) -> None:
    """Called by the Team engine's `register(plugins)` (an older one never calls it: no explainer)."""
    global _explainer
    _explainer = explainer


def register_planner(planner: Planner | None) -> None:
    """Called by the Team engine's `register(plugins)` (an older one never calls it: no planner)."""
    global _planner
    _planner = planner


def load() -> None:
    """Imports the Team engine if it's installed. Safe to call many times."""
    global _loaded, _team_version
    if _loaded:
        return
    _loaded = True
    try:
        team = importlib.import_module(TEAM_MODULE)
    except ModuleNotFoundError as e:
        if e.name != TEAM_MODULE:   # installed but broken: say so, carry on as Community
            log.warning("Breakpatch Team engine couldn't load: %s", e)
        return
    except Exception as e:  # noqa: BLE001
        log.warning("Breakpatch Team engine couldn't load: %s", e)
        return
    register = getattr(team, "register", None)
    if not callable(register):
        log.warning("Breakpatch Team engine has no register(); carrying on as Community")
        return
    try:
        register(__import__(__name__, fromlist=["register_healer"]))
    except Exception as e:  # noqa: BLE001
        log.warning("Breakpatch Team engine couldn't register: %s", e)
        register_healer(None)      # all or nothing: a half-registered Team engine is Community
        register_licence(None)
        register_explainer(None)
        register_planner(None)
        _actions.clear()
        return
    _team_version = str(getattr(team, "__version__", "?"))
    log.info("Breakpatch Team engine %s loaded", _team_version)


def healer() -> Healer | None:
    """The registered healer, or None (Community: moved targets fail with targetNotFound)."""
    load()
    return _healer


def explainer() -> Explainer | None:
    """The registered explainer, or None (Community: `run.explain` answers `not_ready`)."""
    load()
    return _explainer


def planner() -> Planner | None:
    """The registered planner, or None (Community: `record.plan` answers `not_ready`)."""
    load()
    return _planner


def action(name: str) -> "StepAction | None":
    """The registered performer of `name` steps, or None (Community: they fail with `actionUnavailable`)."""
    load()
    return _actions.get(str(name))


def licence() -> Licence | None:
    """The Team engine's licence, or None (Community)."""
    load()
    return _licence


def licence_status() -> dict:
    """`system.info`'s `licence`: the state as the Team engine sees it, or `unavailable`."""
    lic = licence()
    if lic is None:
        return dict(UNAVAILABLE)
    try:
        return lic.to_json()
    except Exception as e:  # noqa: BLE001
        log.warning("the Team engine couldn't report its licence: %s", e)
        return dict(UNAVAILABLE)


def edition() -> str:
    """"team" when the Team engine loaded and registered, otherwise "community"."""
    load()
    return "team" if _team_version is not None else "community"
