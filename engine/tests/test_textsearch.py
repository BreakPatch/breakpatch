"""A pattern the engine didn't write is searched in a child process with a time limit (textsearch.py):
one that backtracks without end is stopped, and the engine's event loop keeps going meanwhile."""
import asyncio
import os
import sys
import time

import pytest

from breakpatch_engine import install, textsearch


def test_a_match_and_its_first_group():
    assert textsearch.search(r"\b\d{6}\b", "Your code is 482913.") == ("482913", None)
    assert textsearch.search(r"code: ([A-Z0-9-]+)", "Your code: AB-12CD.") == ("code: AB-12CD", "AB-12CD")
    assert textsearch.search(r"(x)?y", "y") == ("y", None)
    assert textsearch.search(r"\d{6}", "no code here") is None
    assert textsearch.search(r"(\d+) €", "Total — 12 € à payer") == ("12 €", "12")
    with pytest.raises(textsearch.SearchFailed):
        textsearch.search("([", "text")


async def test_a_pattern_that_never_ends_is_stopped_and_the_loop_keeps_ticking():
    ticks = 0

    async def tick():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.05)
            ticks += 1

    ticker = asyncio.ensure_future(tick())
    t0 = time.monotonic()
    try:
        with pytest.raises(textsearch.TooSlow):
            await asyncio.to_thread(textsearch.search, r"(a|a)*b", "a" * 40 + "c", 0.5)
    finally:
        ticker.cancel()
    took = time.monotonic() - t0
    assert took < 5, took
    assert ticks >= int(0.5 / 0.05) // 2, ticks          # the loop ran all along


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in program is a shell script")
def test_a_search_runs_in_a_nuitka_build_where_sys_executable_isnt_there(monkeypatch, tmp_path):
    # As a Nuitka --onefile sidecar runs: `__compiled__`, no sys.frozen, sys.executable a `python`
    # that isn't there, and the program itself as sys.argv[0] (here a stand-in that runs the engine).
    program = tmp_path / "breakpatch-engine"
    program.write_text(f'#!/bin/sh\nexec "{sys.executable}" -m breakpatch_engine "$@"\n')
    program.chmod(0o755)
    monkeypatch.setitem(vars(install), "__compiled__", object())
    monkeypatch.setattr(sys, "executable", str(tmp_path / "unpacked" / "python"))
    monkeypatch.setattr(sys, "argv", [str(program), "serve"])
    assert not os.path.exists(sys.executable)
    assert textsearch.search(r"code: (\w+)", "Your code: AB12.") == ("code: AB12", "AB12")
