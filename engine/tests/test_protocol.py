"""The sidecar's JSON Lines framing, tested through a real `python -m breakpatch_engine serve` process."""
import functools
import http.server
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from conftest import needs_browser

SITE = Path(__file__).parent / "site"


@pytest.fixture(scope="module")
def site():
    """The test pages over http (the test browser doesn't open file: addresses)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


class Sidecar:
    def __init__(self, home: Path):
        env = dict(os.environ, BP_FAST="1", BP_HOME=str(home), PYTHONUNBUFFERED="1")
        self.p = subprocess.Popen([sys.executable, "-m", "breakpatch_engine", "serve"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.lines: queue.Queue = queue.Queue()
        self.raw: list[bytes] = []
        self.err: list[str] = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: self.err.extend(l.decode() for l in self.p.stderr), daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.raw.append(line)
            self.lines.put((time.monotonic(), json.loads(line)))

    def send(self, obj) -> float:
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.p.stdin.write(data + b"\n")
        self.p.stdin.flush()
        return time.monotonic()

    def until(self, pred, timeout=30.0):
        """Collect messages until `pred(msg)` is true; returns (all collected, the matching one, when)."""
        got = []
        end = time.monotonic() + timeout
        while True:
            t, msg = self.lines.get(timeout=max(0.01, end - time.monotonic()))
            got.append(msg)
            if pred(msg):
                return got, msg, t

    def close(self):
        self.p.stdin.close()
        return self.p.wait(timeout=20)


@pytest.fixture
def sidecar(tmp_path):
    s = Sidecar(tmp_path / "home")
    yield s
    if s.p.poll() is None:
        s.p.kill()


def test_one_response_per_id_errors_are_plain_and_logs_go_to_stderr(sidecar):
    sidecar.send({"id": 1, "method": "system.info"})
    sidecar.send(b"this is not json")
    sidecar.send({"id": 3, "method": "no.such.method"})
    sidecar.send({"id": 4, "method": "browser.pointer", "params": [1, 2]})
    sidecar.send({"id": 5, "method": "browser.pointer", "params": {"kind": "move", "at": [1, 2]}})
    sidecar.send({"id": 6, "method": "record.locate", "params": {"description": "Done"}})
    sidecar.send({"id": 7, "method": "setup.pause", "params": {"task": "model"}})
    sidecar.send(b"")                      # blank lines are ignored
    by_id = {}
    sidecar.until(lambda m: by_id.setdefault(m.get("id", "event"), m) and {1, None, 3, 4, 5, 6, 7} <= set(by_id))

    info = by_id[1]["result"]
    assert info["engineVersion"] and isinstance(info["memoryGb"], (int, float))
    from breakpatch_engine import plugins
    assert info["edition"] == plugins.edition()             # "community" unless the Team engine is installed
    assert info["model"] == {"installed": False}

    assert by_id[None]["error"]["code"] == "bad_request"
    assert by_id[3]["error"] == {"code": "bad_request", "message": "The engine doesn't know how to do that.",
                                 "details": "Unknown method: 'no.such.method'"}
    assert by_id[4]["error"]["code"] == "bad_request"
    assert by_id[5]["error"] == {"code": "not_ready", "message": "The browser isn't open."}
    assert by_id[6]["error"]["code"] == "not_ready"
    assert by_id[7] == {"id": 7, "result": {}}

    assert sidecar.close() == 0
    assert all(json.loads(l) for l in sidecar.raw)           # stdout carries protocol lines only
    ids = [json.loads(l).get("id") for l in sidecar.raw if b'"id"' in l]
    assert sorted(ids, key=str) == sorted([1, None, 3, 4, 5, 6, 7], key=str)   # exactly one response each
    assert any("ready" in l for l in sidecar.err)


@needs_browser
def test_run_stop_answers_while_a_run_is_busy(sidecar, site):
    steps = [{"id": f"w{i}", "action": "waitFor", "label": "Wait", "durationMs": 1500} for i in range(4)]
    sidecar.send({"id": 1, "method": "run.start", "params": {
        "runId": "r1", "startUrl": site + "/index.html", "viewport": {"width": 800, "height": 600},
        "steps": steps, "settings": {"autoFix": False, "failOnFix": False}, "secrets": {}}})
    got, _, _ = sidecar.until(lambda m: m.get("event") == "run.step" and m["data"]["state"] == "running")
    assert {"id": 1, "result": {}} in got                       # run.start returns at once
    sent = sidecar.send({"id": 2, "method": "run.stop", "params": {"runId": "r1"}})
    got, reply, at = sidecar.until(lambda m: m.get("id") == 2)
    assert reply == {"id": 2, "result": {}}
    assert at - sent < 1.0                                      # not stuck behind the running step
    got, ended, _ = sidecar.until(lambda m: m.get("event") == "run.ended")
    data = ended["data"]
    assert data["runId"] == "r1" and data["result"] == "fail"
    assert [s["result"] for s in data["steps"]][-1] == "notRun"
    assert "stopped" in [s.get("reason") for s in data["steps"]]
    frames = [m for m in got if m.get("event") == "frame"]
    assert all(set(f["data"]) == {"jpeg", "width", "height", "seq"} for f in frames)
    assert sidecar.close() == 0


@needs_browser
def test_sigterm_closes_the_browser_and_exits_0(sidecar, site):
    import signal as sig
    sidecar.send({"id": 1, "method": "browser.open", "params": {
        "url": site + "/index.html", "viewport": {"width": 800, "height": 600}}})
    _, reply, _ = sidecar.until(lambda m: m.get("id") == 1)
    assert reply == {"id": 1, "result": {}}
    _, frame, _ = sidecar.until(lambda m: m.get("event") == "frame")
    assert frame["data"]["width"] == 800
    chrome = subprocess.run(["pgrep", "-f", "-P", str(sidecar.p.pid)], capture_output=True, text=True).stdout.split()
    sidecar.p.send_signal(sig.SIGTERM)
    assert sidecar.p.wait(timeout=20) == 0
    time.sleep(0.5)
    alive = [pid for pid in chrome if Path(f"/proc/{pid}").exists()]
    assert not alive, alive
