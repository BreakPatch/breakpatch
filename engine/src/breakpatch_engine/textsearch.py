"""A regular expression the engine didn't write, searched with a time limit (the Team engine's Wait
for an email: the code pattern a test gives).

Python's `re` holds the interpreter while it matches and can't be interrupted, so a pattern that
backtracks without end (`(a|a)*b`, `\\w*\\w*\\w*x`) would freeze the whole engine, from a thread too:
Stop, every other request and a CI run would hang with it. So such a search runs in a child process
of the engine (`_search`, cli.py), which is killed when the search takes longer than its limit. The
child's own start (a packaged sidecar unpacks itself first) doesn't count towards the limit: it says
`ready` before it reads the pattern and the text (JSON on stdin) and writes what matched.

Neither the pattern nor the text is logged.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading

SEARCH_S = 1.5        # the search itself, at most
START_S = 60.0        # the child starting, at most
TEXT_MAX = 1_000_000  # characters a search takes; callers keep it far smaller


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
    except re.error as e:
        raise SearchFailed("not a regular expression") from e
    from .install import self_command
    try:
        # No console window for it on Windows (the sidecar has none of its own to share).
        proc = subprocess.Popen(self_command() + ["_search"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as e:
        raise SearchFailed("the search couldn't start") from e
    try:
        timer = threading.Timer(START_S, proc.kill)
        timer.start()
        try:
            ready = proc.stdout.readline()
        finally:
            timer.cancel()
        if ready.strip() != b"ready":
            raise SearchFailed("the search didn't start")
        data = json.dumps({"pattern": pattern, "text": text[:TEXT_MAX]}).encode()
        try:
            out, _ = proc.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TooSlow() from None
        try:
            got = json.loads(out.decode("utf-8"))["match"]
        except (UnicodeDecodeError, ValueError, KeyError, TypeError):
            raise SearchFailed("the search didn't answer") from None
    finally:
        if proc.poll() is None:
            proc.kill()
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


def child_main() -> int:
    """`breakpatch-engine _search`: one search, for search() above."""
    out = sys.stdout
    out.write("ready\n")
    out.flush()
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        pattern = re.compile(str(req["pattern"]))
        m = pattern.search(str(req["text"]))
    except (UnicodeDecodeError, ValueError, KeyError, TypeError, re.error):
        return 2
    match = None if m is None else [m.group(0), m.group(1) if pattern.groups else None]
    out.write(json.dumps({"match": match}))
    out.flush()
    return 0
