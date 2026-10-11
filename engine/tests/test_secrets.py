"""Saved secrets are only typed on their own sites (security review A1)."""
import asyncio
import functools
import http.server
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine.actions import Secret, parse_secrets
from breakpatch_engine.config import Timings
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.runner import secret_problem
from breakpatch_engine.service import Engine
from breakpatch_engine.sites import origin_of, site_name

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}


# ---------------------------------------------------------------- origins and the wire shape

@pytest.mark.parametrize("url,want", [
    ("https://App.Example.com/login?x=1#y", "https://app.example.com"),
    ("https://app.example.com:443/", "https://app.example.com"),
    ("http://127.0.0.1:8080/a", "http://127.0.0.1:8080"),
    ("http://localhost:80", "http://localhost"),
    ("https://[::1]:8443/", "https://[::1]:8443"),
    ("https://app.example.com.", "https://app.example.com"),
    ("file:///etc/passwd", None), ("data:text/html,x", None), ("about:blank", None), ("", None), (None, None),
    ("https://", None), ("https://x:99999", None),
])
def test_origin_of(url, want):
    assert origin_of(url) == want


def test_site_names_read_plainly():
    assert site_name("https://evil.example") == "evil.example"
    assert site_name("http://127.0.0.1:8080") == "127.0.0.1:8080"
    assert site_name(None) == "this page"


def test_secrets_arrive_with_their_sites():
    got = parse_secrets({
        "PW": {"value": "hunter2", "origins": ["https://App.example.com/", "nonsense", 7], "runnerCanUse": True},
        "OLD": "legacy",
        "GONE": {"value": None, "origins": ["https://x.dev"]},
        "NULL": None,
    }, default_origin="https://start.example")
    assert got["PW"] == Secret("hunter2", ("https://app.example.com",), True)
    assert got["OLD"] == Secret("legacy", ("https://start.example",), False)   # a bare value: the start page's site
    assert "GONE" not in got and "NULL" not in got
    assert parse_secrets({"OLD": "legacy"}) == {"OLD": Secret("legacy", ())}
    assert parse_secrets(None) == {} and parse_secrets(["x"]) == {}


def test_what_stops_a_secret_before_the_run():
    ok = Secret("v", ("https://a.example",), False)
    assert secret_problem("PW", ok, as_runner=False) is None
    assert secret_problem("PW", None, False) == "The saved secret PW isn't on this Mac."
    assert "isn't allowed on any site yet" in secret_problem("PW", Secret("v", ()), False)
    assert "can't be used by the runner" in secret_problem("PW", ok, as_runner=True)
    assert secret_problem("PW", Secret("v", ("https://a.example",), True), as_runner=True) is None


def test_a_secret_the_shell_refused_carries_only_its_reason():
    """The shell sends `{refused}` for a secret on this Mac kept for other workspaces (issue #33)."""
    why = "PW is kept for other workspaces on this Mac, so it isn't used here."
    got = parse_secrets({"PW": {"refused": why, "value": "leaked?"}, "BLANK": {"refused": "  "}})
    assert got["PW"] == Secret("", (), False, why)
    assert not got["PW"].allows("https://a.example")
    assert "BLANK" not in got                                         # no reason and no value: as if missing
    assert secret_problem("PW", got["PW"], as_runner=False) == why
    assert secret_problem("PW", got["PW"], as_runner=True) == why
    with pytest.raises(Exception) as e:
        from breakpatch_engine.actions import Context, secret_for
        secret_for("PW", Context(Timings.fast(), secrets=got))
    assert getattr(e.value, "reason", None) == "secretMissing" and str(why) in str(e.value)


# ---------------------------------------------------------------- in the browser

class Quiet(http.server.SimpleHTTPRequestHandler):
    calls: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        Quiet.calls.append(self.path)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


@pytest.fixture(scope="module")
def sites():
    """The same pages on two sites: 127.0.0.1 (the app) and localhost (someone else)."""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    yield f"http://127.0.0.1:{port}", f"http://localhost:{port}"
    srv.shutdown()


class Harness:
    def __init__(self):
        self.events = []
        self.ended = asyncio.Event()
        self.engine = Engine(self.emit, timings=Timings.fast(), healer=None)

    def emit(self, event, data):
        self.events.append((event, data))
        if event == "run.ended":
            self.ended.set()

    async def run(self, url, steps, secrets, **kw):
        self.ended.clear()
        await self.engine.handlers()["run.start"]({"runId": "r", "startUrl": url, "viewport": VIEWPORT, "steps": steps,
                                                   "settings": {}, "secrets": secrets, **kw})
        await asyncio.wait_for(self.ended.wait(), 60)
        return [d for e, d in self.events if e == "run.ended"][-1]


WRITE = {"id": "pw", "action": "write", "secretRef": "PW", "label": "Write PW"}


def pw(*origins, runner=False):
    return {"PW": {"value": "hunter2", "origins": list(origins), "runnerCanUse": runner}}


@needs_browser
async def test_a_secret_is_typed_on_its_own_site(sites):
    app, _ = sites
    hx = Harness()
    await hx.engine.handlers()["browser.open"]({"url": app + "/field.html", "viewport": VIEWPORT})
    try:
        step = (await hx.engine.handlers()["record.point"]({"action": "write", "secretRef": "PW",
                                                             "secrets": pw(app + "/")}))["step"]
        assert step["secretRef"] == "PW" and "hunter2" not in str(step)
        assert await hx.engine.browser.page.input_value("#f") == "hunter2"
    finally:
        await hx.engine.handlers()["browser.close"]({})
    ended = await hx.run(app + "/field.html", [WRITE], pw(app))
    assert ended["result"] == "pass", ended


@needs_browser
async def test_another_site_gets_nothing(sites):
    app, other = sites
    hx = Harness()
    ended = await hx.run(other + "/field.html", [WRITE], pw(app))
    assert ended["result"] == "fail"
    assert ended["steps"][0]["reason"] == "secretMissing"
    host = other.split("://")[1]
    assert ended["message"] == f"PW isn't allowed on {host}."
    # Recording refuses the same way, and nothing reaches the field.
    await hx.engine.handlers()["browser.open"]({"url": other + "/field.html", "viewport": VIEWPORT})
    try:
        with pytest.raises(EngineError) as e:
            await hx.engine.handlers()["record.point"]({"action": "write", "secretRef": "PW", "secrets": pw(app)})
        assert e.value.code == "not_found" and e.value.message == f"PW isn't allowed on {host}."
        assert await hx.engine.browser.page.input_value("#f") == ""
    finally:
        await hx.engine.handlers()["browser.close"]({})


@needs_browser
async def test_a_refused_secret_stops_the_run_and_the_recorder_with_its_reason(sites):
    app, _ = sites
    hx = Harness()
    why = "PW is kept for other workspaces on this Mac, so it isn't used here."
    ended = await hx.run(app + "/field.html", [WRITE], {"PW": {"refused": why}})
    assert ended["result"] == "fail" and ended["steps"][0]["reason"] == "secretMissing", ended
    assert ended["message"] == why
    await hx.engine.handlers()["browser.open"]({"url": app + "/field.html", "viewport": VIEWPORT})
    try:
        with pytest.raises(EngineError) as e:
            await hx.engine.handlers()["record.point"]({"action": "write", "secretRef": "PW", "secrets": {"PW": {"refused": why}}})
        assert e.value.message == why
        assert await hx.engine.browser.page.input_value("#f") == ""
    finally:
        await hx.engine.handlers()["browser.close"]({})


@needs_browser
async def test_a_redirect_to_another_site_gets_nothing(sites):
    app, other = sites
    hx = Harness()
    wait = {"id": "w", "action": "waitFor", "durationMs": 400}
    ended = await hx.run(f"{app}/field.html?go={other}/field.html", [wait, WRITE], pw(app))
    assert ended["result"] == "fail" and ended["steps"][1]["reason"] == "secretMissing", ended
    assert "isn't allowed on localhost" in ended["message"]


@needs_browser
async def test_a_popup_on_another_site_gets_nothing(sites):
    app, other = sites
    hx = Harness()
    steps = [{"id": "o", "action": "click", "at": [100, 120]},
             {"id": "t", "action": "switchTab"}, WRITE]
    ended = await hx.run(f"{app}/field.html?popup={other}/field.html", steps, pw(app))
    assert ended["result"] == "fail" and ended["steps"][2]["reason"] == "secretMissing", ended
    assert "isn't allowed on localhost" in ended["message"]
    # The same popup on the secret's own site is fine.
    ended = await hx.run(f"{app}/field.html?popup={app}/field.html", steps, pw(app))
    assert ended["result"] == "pass", ended


@needs_browser
async def test_a_frame_from_another_site_gets_nothing(sites):
    app, other = sites
    hx = Harness()
    wait = {"id": "w", "action": "waitFor", "durationMs": 400}
    ended = await hx.run(f"{app}/framed.html?src={other}/field.html", [wait, WRITE], pw(app))
    assert ended["result"] == "fail" and ended["steps"][1]["reason"] == "secretMissing", ended
    assert "isn't allowed on localhost" in ended["message"]
    # The page's own scripts can't hide where the focus is.
    ended = await hx.run(f"{app}/framed.html?lie=1&src={other}/field.html", [wait, WRITE], pw(app))
    assert ended["result"] == "fail" and ended["steps"][1]["reason"] == "secretMissing", ended
    ended = await hx.run(f"{app}/framed.html?src={app}/field.html", [wait, WRITE], pw(app))
    assert ended["result"] == "pass", ended


@needs_browser
async def test_no_sites_and_runner_only_secrets_stop_before_anything(sites):
    app, _ = sites
    hx = Harness()
    Quiet.calls.clear()
    seed = {"method": "POST", "url": app + "/api/seed"}
    ended = await hx.run(app + "/field.html", [WRITE], pw(), setUp=seed)
    assert ended["steps"][0]["reason"] == "secretMissing" and "any site" in ended["message"]
    ended = await hx.run(app + "/field.html", [WRITE], pw(app), setUp=seed, runner=True)
    assert ended["steps"][0]["reason"] == "secretMissing" and "runner" in ended["message"]
    assert Quiet.calls == []                  # not even the set-up call ran
    ended = await hx.run(app + "/field.html", [WRITE], pw(app, runner=True), setUp=seed, runner=True)
    assert ended["result"] == "pass", ended
    assert Quiet.calls == ["/api/seed"]
