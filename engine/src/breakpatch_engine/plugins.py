"""Optional add-ons, found once at start-up (docs/editions.md).

The open engine is the Community edition. When the private Breakpatch Team engine
(`breakpatch_team_engine`) is installed next to it, it's imported here, in this one place,
and registers what it adds: fallback healing of moved targets (spec §11.2) and the licence
that decides whether healing is on. The app shell hands the engine its licence token with
`licence.set` (engine/PROTOCOL.md); this engine only passes it on to what the Team engine
registered, which checks it. Its CI command line is its own console script (`breakpatch-ci`)
and doesn't go through here.
"""
from __future__ import annotations

import importlib
import logging

from typing import Protocol

from .runner import Healer

log = logging.getLogger("breakpatch.plugins")

TEAM_MODULE = "breakpatch_team_engine"

_healer: Healer | None = None
_loaded = False
_team_version: str | None = None     # set once the Team engine loaded and registered
_licence: "Licence | None" = None

UNAVAILABLE = {"state": "unavailable"}   # Community: no licence to check


class Licence(Protocol):
    """What the Team engine registers to receive the licence token."""

    def set(self, token: str | None) -> dict: ...   # returns the state as the engine sees it
    def to_json(self) -> dict: ...


def register_healer(healer: Healer | None) -> None:
    """Called by the Team engine's `register(plugins)`."""
    global _healer
    _healer = healer


def register_licence(licence: Licence | None) -> None:
    """Called by the Team engine's `register(plugins)`."""
    global _licence
    _licence = licence


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
        return
    _team_version = str(getattr(team, "__version__", "?"))
    log.info("Breakpatch Team engine %s loaded", _team_version)


def healer() -> Healer | None:
    """The registered healer, or None (Community: moved targets fail with targetNotFound)."""
    load()
    return _healer


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
