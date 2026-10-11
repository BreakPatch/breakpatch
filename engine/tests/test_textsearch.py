"""A pattern the engine didn't write is searched in a child process with a time limit (textsearch.py):
one that backtracks without end is stopped, and the engine's event loop keeps going meanwhile."""
import asyncio
import json
import os
import signal
import subprocess
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
    for bad in ("([", "(?a)(?u)x"):            # re.error, and the ValueError Python gives for that one
        with pytest.raises(textsearch.SearchFailed):
            textsearch.search(bad, "text")


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


def gone(pid: int, within: float = 3.0) -> bool:
    """Whether process `pid` has ended (a zombie waiting to be reaped counts as ended)."""
    end = time.monotonic() + within
    while True:
        try:
            with open(f"/proc/{pid}/stat") as f:
                if f.read().rsplit(")", 1)[1].split()[0] in ("Z", "X"):
                    return True
        except FileNotFoundError:
            return True
        except OSError:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
        if time.monotonic() > end:
            return False
        time.sleep(0.05)


WRAPPER = """
import subprocess, sys
# As a onefile launcher does: the real program runs as a child of this one, on the same pipes.
child = subprocess.Popen([sys.executable, "-m", "breakpatch_engine", "_search"])
open(sys.argv[1], "w").write(str(child.pid))
sys.exit(child.wait())
"""


@pytest.mark.skipif(sys.platform == "win32", reason="reads processes through os.kill and /proc")
def test_a_launchers_child_is_killed_with_it(monkeypatch, tmp_path):
    """The search runs in a grandchild (a onefile launcher's program): after TooSlow it's gone too,
    not left matching. The child's own timer is pushed out of the way, so only the kill can stop it."""
    wrapper, pid_file = tmp_path / "launcher.py", tmp_path / "pid"
    wrapper.write_text(WRAPPER)
    monkeypatch.setattr(install, "self_command", lambda: [sys.executable, str(wrapper), str(pid_file)])
    monkeypatch.setattr(textsearch, "SELF_STOP_S", 50.0)
    with pytest.raises(textsearch.TooSlow):
        textsearch.search(r"(a|a)*b", "a" * 40 + "c", 0.5)
    grandchild = int(pid_file.read_text())
    assert gone(grandchild, within=1.0)
    # A search through the launcher still answers.
    assert textsearch.search(r"code: (\w+)", "Your code: AB12.") == ("code: AB12", "AB12")


@pytest.mark.skipif(not hasattr(signal, "setitimer"), reason="no interval timers on Windows")
def test_the_child_stops_itself_when_nobody_kills_it():
    """As if the engine died mid-search: nobody kills the child, and it stops itself at the limit
    it was given (exit status 3, nothing written)."""
    proc = subprocess.Popen(install.self_command() + ["_search"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        assert proc.stdout.readline().strip() == b"ready"
        t0 = time.monotonic()
        out, _ = proc.communicate(json.dumps({"pattern": r"(a|a)*b", "text": "a" * 40 + "c", "limit": 0.5}).encode(),
                                  timeout=20)
        took = time.monotonic() - t0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert proc.returncode == 3 and out == b"" and took < 5, took
