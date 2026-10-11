"""A regular expression the engine didn't write, searched with a time limit (the Team engine's Wait
for an email: the code pattern a test gives).

Python's `re` holds the interpreter while it matches and can't be interrupted, so a pattern that
backtracks without end (`(a|a)*b`, `\\w*\\w*\\w*x`) would freeze the whole engine, from a thread too:
Stop, every other request and a CI run would hang with it. So such a search runs in a child process
of the engine (`_search`, cli.py), which is killed when the search takes longer than its limit. The
child's own start (a packaged sidecar unpacks itself first) doesn't count towards the limit: it says
`ready` before it reads the pattern and the text (JSON on stdin) and writes what matched.

Killed means the child and everything it started: a onefile launcher runs the real program as its
own child, and killing only the launcher would leave that one searching. So the child starts in a
process group of its own (a new session on macOS and Linux, a new process group on Windows) and
the whole group is killed (`killpg`; `taskkill /T` on Windows). And in case the engine itself dies
mid-search, so that nobody is left to kill it, the child also stops itself on macOS and Linux: a
timer (SIGALRM) a little after the limit raises in the search, as `re` checks for signals while it
matches.

Neither the pattern nor the text is logged.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading

SEARCH_S = 1.5        # the search itself, at most
START_S = 60.0        # the child starting, at most
TEXT_MAX = 1_000_000  # characters a search takes; callers keep it far smaller
SELF_STOP_S = 1.0     # the child stops itself this long after the limit, if it's still searching


class TooSlow(Exception):
    """The search took longer than its limit and was stopped."""


class SearchFailed(Exception):
    """The search couldn't be made: the pattern isn't one, or the child didn't start or answer."""


def search(pattern: str, text: str, timeout: float = SEARCH_S) -> tuple[str, str | None] | None:
    """The first match of `pattern` in `text`: (the whole match, its first group or None), or None.
    Raises TooSlow after `timeout` seconds of searching, SearchFailed otherwise. Blocking: call it
    from a thread (asyncio.to_thread), never on the event loop."""
    try:
        re.compile(pattern)
    except (re.error, ValueError, OverflowError, RecursionError) as e:    # (?a)(?u) is a ValueError
        raise SearchFailed("not a regular expression") from e
    from .install import self_command
    try:
        # A group of its own, to kill it with whatever it started (_stop). No console window for it
        # on Windows (the sidecar has none of its own to share).
        proc = subprocess.Popen(self_command() + ["_search"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=os.name == "posix",
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    except OSError as e:
        raise SearchFailed("the search couldn't start") from e
    answered = False
    try:
        timer = threading.Timer(START_S, _stop, (proc,))
        timer.start()
        try:
            ready = proc.stdout.readline()
        finally:
            timer.cancel()
        if ready.strip() != b"ready":
            raise SearchFailed("the search didn't start")
        data = json.dumps({"pattern": pattern, "text": text[:TEXT_MAX], "limit": timeout + SELF_STOP_S}).encode()
        try:
            out, _ = proc.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TooSlow() from None
        answered = proc.returncode == 0
        try:
            got = json.loads(out.decode("utf-8"))["match"]
        except (UnicodeDecodeError, ValueError, KeyError, TypeError):
            raise SearchFailed("the search didn't answer") from None
    finally:
        if not answered or proc.poll() is None:
            _stop(proc)
            try:
                proc.communicate(timeout=5)
            except (subprocess.TimeoutExpired, ValueError, OSError):
                pass
        for pipe in (proc.stdin, proc.stdout):
            try:
                pipe.close()
            except (ValueError, OSError):
                pass
    if got is None:
        return None
    if not (isinstance(got, list) and len(got) == 2 and isinstance(got[0], str) and (got[1] is None or isinstance(got[1], str))):
        raise SearchFailed("the search didn't answer")
    return got[0], got[1]


def _stop(proc: subprocess.Popen) -> None:
    """Kills the search child and everything it started (its process group)."""
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)    # its own session: the group's id is its pid
        except (ProcessLookupError, PermissionError):
            pass                                   # the group is gone already
    elif proc.poll() is None:
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        proc.kill()                                # in case the group kill couldn't reach it
    except OSError:
        pass


class _SelfStop(Exception):
    """The child's own time limit ran out (child_main)."""


def _self_stop(signum, frame):
    raise _SelfStop()


def child_main() -> int:
    """`breakpatch-engine _search`: one search, for search() above. Stops itself (exit status 3)
    once the request's `limit` has passed, where the system has interval timers (not on Windows):
    the engine that should have killed it may be gone."""
    out = sys.stdout
    out.write("ready\n")
    out.flush()
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        limit = min(max(float(req.get("limit", SEARCH_S + SELF_STOP_S)), 0.1), START_S)
        pattern = re.compile(str(req["pattern"]))
    except (UnicodeDecodeError, ValueError, KeyError, TypeError, AttributeError, OverflowError, RecursionError,
            re.error):
        return 2
    timed = hasattr(signal, "setitimer")
    if timed:
        signal.signal(signal.SIGALRM, _self_stop)
        signal.setitimer(signal.ITIMER_REAL, limit)
    try:
        m = pattern.search(str(req["text"]))
    except _SelfStop:
        return 3
    except (KeyError, TypeError):
        return 2
    finally:
        if timed:
            signal.setitimer(signal.ITIMER_REAL, 0)
    match = None if m is None else [m.group(0), m.group(1) if pattern.groups else None]
    out.write(json.dumps({"match": match}))
    out.flush()
    return 0
