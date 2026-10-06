"""Linux: the system libraries Chromium needs, as a small surface other code can rely on.

breakpatch-ci (the Team engine's `ci.py`) uses exactly these two functions; anything else in
install.py may change without notice. An open engine without this module is too old to look, and
callers treat that as "couldn't tell".

    check() -> (checked, missing)
        checked: whether it could tell (Linux, the Chromium the engine starts is there, and ldd);
        missing: the library file names `ldd` says are "not found", sorted (empty when checked is
        False). Never raises.

    message(missing, python=None) -> str
        The plain words for a machine that lacks them, with the one command that adds them
        (`python -m playwright install-deps chromium`, with sudo unless this is root).
"""
from __future__ import annotations

import shutil
import sys

from . import install

__all__ = ["check", "message"]


def check() -> tuple[bool, list[str]]:
    if not sys.platform.startswith("linux"):
        return False, []
    try:
        if install.chromium_path() is None or not shutil.which("ldd"):
            return False, []
        return True, install.missing_libraries()
    except Exception:  # noqa: BLE001 (a check that can't tell isn't an error)
        return False, []


def message(missing: list[str], python: str | None = None) -> str:
    return install.libraries_message(list(missing), python)
