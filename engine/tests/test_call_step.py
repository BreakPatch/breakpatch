"""A Call step (issue #44): a call to the app's API in the middle of a test, under the set-up call's
rules (calls.py), passing on the statuses it names, and keeping a value from a JSON reply for a
later Write step. The report gets the status and the time, never the reply."""
import asyncio
import functools
import http.server
import json
import logging
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine import calls, labels
from breakpatch_engine.actions import Context, Secret, secret_refs, value_allowed
from breakpatch_engine.calls import CallRefused, parse_path, parse_statuses, pick, plan
from breakpatch_engine.config import Timings
from breakpatch_engine.locator import NoLocator
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.recorder import varies_each_run
from breakpatch_engine.service import Engine

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}
FIELD_AT = [150, 314]            # the name field on index.html


def dns(table):
    def resolver(host, port):
        if host not in table:
            raise OSError("no such host")
        return table[host]
    return resolver


PUBLIC = dns({"app.acme.com": ["93.184.216.34"], "api.acme.com": ["93.184.216.35"], "evil.example": ["203.0.113.9"],
              "rebind.acme.com": ["10.0.0.5"]})
APP = "https://app.acme.com/"


# ---------------------------------------------------------------- the rules, without a network

def test_statuses_that_pass():
    assert parse_statuses(None) == [(200, 299)]
    assert parse_statuses("") == [(200, 299)]
    assert parse_statuses("200, 201 404") == [(200, 200), (201, 201), (404, 404)]
    assert parse_statuses("2xx,4XX") == [(200, 299), (400, 499)]
    assert parse_statuses("200-204") == [(200, 204)]
    for bad in ("abc", "2x", "199", "600", "204-200", "1xx", "200;201"):
        with pytest.raises(CallRefused) as e:
            parse_statuses(bad)
        assert e.value.kind == "invalid"
    # Redirects aren't followed, so one can never count as a pass.
    for redirect in ("302", "3xx", "200-399"):
        with pytest.raises(CallRefused) as e:
            parse_statuses(redirect)
        assert "redirect" in e.value.message


def test_where_a_value_is_in_the_reply():
    assert parse_path("$.code") == ["code"]
    assert parse_path("code") == ["code"]
    assert parse_path("$.data.items[0].id") == ["data", "items", 0, "id"]
    assert parse_path("$['one-time code']") == ["one-time code"]
    for bad in ("", "$", "$..x", "$.a[x]", "$.a b"):
        with pytest.raises(CallRefused):
            parse_path(bad)
    body = json.dumps({"code": "123456", "n": 7, "ok": True, "data": {"items": [{"id": "x1"}]}, "list": [1]}).encode()
    assert pick(body, "$.code") == "123456"
    assert pick(body, "$.n") == "7" and pick(body, "$.ok") == "true"
    assert pick(body, "$.data.items[0].id") == "x1"
    for path, says in (("$.missing", "nothing at $.missing"), ("$.data.items[3].id", "nothing at"),
                       ("$.list", "not one value"), ("$.data", "not one value")):
        with pytest.raises(CallRefused) as e:
            pick(body, path)
        assert says in e.value.message and e.value.kind == "keep"
    with pytest.raises(CallRefused) as e:
        pick(b"<html>secret-token</html>", "$.code")
    assert "isn't JSON" in e.value.message and "secret-token" not in e.value.message


def test_a_body_is_sent_with_a_content_type_and_never_with_get():
    p = plan({"method": "POST", "url": "https://api.acme.com/orders/1/pay", "body": '{"paid": true}'}, APP, {}, PUBLIC)
    assert p.body == b'{"paid": true}' and p.headers["Content-Type"] == "application/json"
    p = plan({"method": "PUT", "url": "https://api.acme.com/x", "body": "flag=on"}, APP, {}, PUBLIC)
    assert p.headers["Content-Type"] == "text/plain; charset=utf-8"
    p = plan({"method": "PATCH", "url": "https://api.acme.com/x", "body": "a=1",
              "headers": [{"name": "content-type", "value": "application/x-www-form-urlencoded"}]}, APP, {}, PUBLIC)
    assert p.headers == {"content-type": "application/x-www-form-urlencoded"}
    assert plan({"method": "GET", "url": "https://api.acme.com/x", "body": ""}, APP, {}, PUBLIC).body is None
    with pytest.raises(CallRefused) as e:
        plan({"method": "GET", "url": "https://api.acme.com/x", "body": "x"}, APP, {}, PUBLIC)
    assert "GET call can't have a body" in e.value.message
    with pytest.raises(CallRefused) as e:
        plan({"method": "POST", "url": "https://api.acme.com/x", "body": "x" * (calls.BODY_MAX + 1)}, APP, {}, PUBLIC)
    assert "too long" in e.value.message


def test_a_call_step_has_the_set_up_calls_rules():
    """The same plan() as set-up calls: other hosts, private addresses and secrets on other sites are refused."""
    for call, says in (({"method": "POST", "url": "https://evil.example/x", "body": "{}"}, "Allow other hosts"),
                       ({"method": "POST", "url": "https://rebind.acme.com/x"}, "private or local"),
                       ({"method": "POST", "url": "http://api.acme.com/x"}, "https://")):
        with pytest.raises(CallRefused) as e:
            plan(call, APP, {}, PUBLIC)
        assert says in e.value.message
    call = {"method": "POST", "url": "https://api.acme.com/x", "headers": [{"name": "Authorization", "secretRef": "TOKEN"}]}
    with pytest.raises(CallRefused) as e:
        plan(call, APP, {"TOKEN": Secret("t", ("https://app.acme.com",))}, PUBLIC)
    assert e.value.kind == "secret"
    # A secret kept for other workspaces (the shell's refusal) is never sent either.
    with pytest.raises(CallRefused) as e:
        plan(call, APP, {"TOKEN": Secret("", (), False, "TOKEN is kept for other workspaces on this Mac.")}, PUBLIC)
    assert e.value.message == "TOKEN is kept for other workspaces on this Mac."


def test_run_values_fill_the_address_and_body():
    import datetime as dt
    now = dt.datetime(2026, 10, 9, 8, 5, 3)
    got = calls.with_run_values({"method": "POST", "url": "https://api.acme.com/u/{i}", "body": '{"at": "{date} {time}"}'}, 3, now)
    assert got["url"] == "https://api.acme.com/u/3" and got["body"] == '{"at": "2026-10-09 08:05"}'


def test_the_secrets_a_call_step_sends_are_checked_before_the_run():
    step = {"id": "c", "action": "call", "call": {"method": "POST", "url": "https://api.acme.com/x",
                                                  "headers": [{"name": "Authorization", "secretRef": "TOKEN"}, {"name": "X", "value": "1"}]}}
    loop = {"id": "L", "action": "loop", "steps": [step]}
    assert secret_refs([loop]) == [(step, "TOKEN")]


def test_labels_name_the_call_without_its_query():
    assert labels.default_label("call", {"call": {"method": "post", "url": "https://api.acme.com/test/orders/42/pay?token=abc"}}) \
        == "Call POST api.acme.com/test/orders/42/pay"
    assert labels.default_label("call", {"call": {"method": "GET", "url": "https://api.acme.com/"}}) == "Call GET api.acme.com"
    assert labels.default_label("call", {}) == "Call your API"
    assert labels.default_label("write", {"valueRef": "CODE"}) == "Write the value CODE"
    assert varies_each_run({"action": "write", "valueRef": "CODE"})


def test_a_kept_value_is_typed_only_into_the_apps_pages():
    ctx = Context(Timings.fast(), app_url="https://app.acme.com/login")
    for origin in ("https://app.acme.com", "https://www.acme.com", "https://api.acme.com"):
        assert value_allowed(origin, ctx, None), origin
    for origin in ("https://evil.example", "http://app.acme.com", None, ""):
        assert not value_allowed(origin or None, ctx, None), origin
    # The call's own site, when it was another host (Allow other hosts).
    assert value_allowed("https://evil.example", ctx, "https://evil.example")


# ---------------------------------------------------------------- against a local API

class Api(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *a):
        pass

    def _reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        path = self.path.removeprefix("/api")
        Api.seen.append((self.command, path, self.headers.get("Authorization"), self.headers.get("Content-Type"), body))
        if path.startswith("/code"):
            out, status, kind = json.dumps({"code": "424242", "token": "do-not-log"}).encode(), 200, "application/json"
        elif path.startswith("/html"):
            out, status, kind = b"<p>hi</p>", 200, "text/html"
        elif path.startswith("/missing"):
            out, status, kind = b'{"error": "not found"}', 404, "application/json"
        elif path.startswith("/slow"):
            import time
            time.sleep(2)
            out, status, kind = b"{}", 200, "application/json"
        elif path.startswith("/fail"):
            out, status, kind = b'{"secret": "s3cret-in-reply"}', 500, "application/json"
        else:
            out, status, kind = b"{}", 200, "application/json"
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _reply


class SiteAndApi(Api):
    """The test site's pages, and the API under /api/."""

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._reply()
        page = SITE / self.path.lstrip("/").split("?")[0]
        data = page.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module")
def api():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SiteAndApi)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


async def test_a_call_with_a_body_and_statuses_that_pass(api, caplog):
    caplog.set_level(logging.INFO)
    Api.seen.clear()
    r = await calls.make({"method": "POST", "url": api + "/api/ok?key=k1", "body": '{"paid": true}'}, api, {}, 5)
    assert r.ok and r.status == 200 and r.shown() == {"status": 200, "ms": r.ms}
    assert Api.seen[-1][0:2] == ("POST", "/ok?key=k1") and Api.seen[-1][3] == "application/json"
    assert Api.seen[-1][4] == b'{"paid": true}'
    r = await calls.make({"method": "GET", "url": api + "/api/missing"}, api, {}, 5)
    assert not r.ok and r.error == "status" and r.message == "It replied 404."
    r = await calls.make({"method": "GET", "url": api + "/api/missing"}, api, {}, 5, pass_status="200, 404")
    assert r.ok and r.status == 404
    r = await calls.make({"method": "GET", "url": api + "/api/fail"}, api, {}, 5, pass_status="2xx, 404")
    assert r.message == "It replied 500. This step passes on 2xx, 404."
    r = await calls.make({"method": "GET", "url": api + "/api/ok"}, api, {}, 5, pass_status="nope")
    assert r.error == "invalid"


async def test_a_kept_value_comes_from_the_reply_and_nowhere_else(api, caplog):
    caplog.set_level(logging.INFO)
    r = await calls.make({"method": "POST", "url": api + "/api/code"}, api, {}, 5, keep="$.code")
    assert r.ok and r.kept == "424242"
    assert "424242" not in json.dumps(r.to_json()) and "424242" not in r.info and "kept" not in repr(r)
    r = await calls.make({"method": "POST", "url": api + "/api/html"}, api, {}, 5, keep="$.code")
    assert not r.ok and r.error == "keep" and "isn't JSON" in r.message
    r = await calls.make({"method": "POST", "url": api + "/api/code"}, api, {}, 5, keep="$.nope")
    assert not r.ok and r.message == "The reply has nothing at $.nope."
    assert "424242" not in caplog.text and "do-not-log" not in caplog.text


async def test_a_call_step_waits_only_its_own_timeout(api):
    r = await calls.make({"method": "GET", "url": api + "/api/slow"}, api, {}, calls.step_timeout(1000, 30))
    assert not r.ok and r.error == "timeout" and r.message == "No reply after 1 s."
    assert calls.step_timeout(None, 30) == 30 and calls.step_timeout(10 ** 9, 30) == calls.STEP_TIMEOUT_MAX
    assert calls.step_timeout(10, 30) == 1.0


async def test_try_it_checks_the_statuses_and_the_kept_value_without_returning_it(api):
    eng = Engine(lambda *a: None, timings=Timings.fast(), healer=None)
    try_it = eng.handlers()["call.try"]
    got = await try_it({"call": {"method": "POST", "url": api + "/api/code"}, "appUrl": api, "keep": {"path": "$.code", "name": "CODE"}})
    assert got["ok"] is True and got["kept"] is True and "424242" not in json.dumps(got)
    got = await try_it({"call": {"method": "GET", "url": api + "/api/missing"}, "appUrl": api, "passStatus": "404"})
    assert got["ok"] is True and got["status"] == 404
    got = await try_it({"call": {"method": "POST", "url": api + "/api/code"}, "appUrl": api, "keep": {"path": "$.x", "name": "CODE"}})
    assert got["ok"] is False and got["error"] == "keep"


# ---------------------------------------------------------------- in a run and while recording

class Harness:
    def __init__(self):
        self.events = []
        self.engine = Engine(self.emit, timings=Timings.fast(), locator_fn=lambda: NoLocator(), healer=None)
        self.h = self.engine.handlers()
        self.ended = asyncio.Event()

    def emit(self, event, data):
        self.events.append((event, data))
        if event == "run.ended":
            self.ended.set()

    def of(self, name):
        return [d for e, d in self.events if e == name]

    async def run(self, steps, url, **kw):
        self.ended.clear()
        await self.h["run.start"]({"runId": kw.pop("runId", "r1"), "startUrl": url, "viewport": VIEWPORT, "steps": steps,
                                   "settings": {}, "secrets": kw.pop("secrets", {}), **kw})
        await asyncio.wait_for(self.ended.wait(), 60)
        return self.of("run.ended")[-1]


def call_step(api, path, **kw):
    return {"id": kw.pop("id", "c1"), "action": "call", "label": "Call", "call": {"method": "POST", "url": api + "/api" + path}, **kw}


@needs_browser
async def test_a_run_makes_the_call_between_steps_and_reports_status_and_time(api, caplog):
    caplog.set_level(logging.INFO)
    hx = Harness()
    Api.seen.clear()
    wait = {"id": "w", "action": "waitFor", "label": "Wait", "durationMs": 10}
    secrets = {"TOKEN": {"value": "tok-777", "origins": [api]}}
    step = call_step(api, "/ok?x={i}", call={"method": "POST", "url": api + "/api/ok?x={i}", "body": '{"n": {i}}',
                                             "headers": [{"name": "Authorization", "secretRef": "TOKEN"}]})
    ended = await hx.run([wait, step, wait | {"id": "w2"}], api + "/index.html", secrets=secrets)
    assert ended["result"] == "pass", ended
    got = ended["steps"][1]
    assert got["result"] == "passed" and got["reply"]["status"] == 200 and isinstance(got["reply"]["ms"], int)
    assert Api.seen == [("POST", "/ok?x=1", "tok-777", "application/json", b'{"n": 1}')]
    passed = [d for d in hx.of("run.step") if d["stepId"] == "c1" and d["state"] == "passed"]
    assert passed[0]["reply"]["status"] == 200
    assert "x=1" not in caplog.text and "tok-777" not in caplog.text


@needs_browser
async def test_a_call_step_that_fails_stops_the_run_with_its_reason(api):
    hx = Harness()
    ended = await hx.run([call_step(api, "/fail"), {"id": "w", "action": "waitFor", "durationMs": 10}], api + "/index.html")
    assert ended["result"] == "fail"
    assert ended["steps"][0]["reason"] == "callFailed" and ended["steps"][0]["reply"]["status"] == 500
    assert ended["steps"][1]["result"] == "notRun"
    assert ended["message"] == "The call to your API didn't work. It replied 500."
    assert "s3cret-in-reply" not in json.dumps(ended) and "s3cret-in-reply" not in json.dumps(hx.events)
    # One the rules refuse fails the same way, before anything is sent.
    Api.seen.clear()
    ended = await hx.run([call_step(api, "/ok") | {"call": {"method": "POST", "url": "https://evil.example/x"}}], api + "/index.html")
    assert ended["steps"][0]["reason"] == "callFailed" and "Allow other hosts" in ended["message"]
    assert Api.seen == []


@needs_browser
async def test_a_missing_secret_for_a_call_step_fails_it_before_the_run_starts(api):
    hx = Harness()
    Api.seen.clear()
    step = call_step(api, "/ok", call={"method": "POST", "url": api + "/api/ok", "headers": [{"name": "Authorization", "secretRef": "TOKEN"}]})
    ended = await hx.run([{"id": "w", "action": "waitFor", "durationMs": 10}, step], api + "/index.html",
                         setUp={"method": "POST", "url": api + "/api/seed"})
    assert ended["steps"][1]["reason"] == "secretMissing" and ended["steps"][0]["result"] == "notRun"
    assert Api.seen == []
    # A secret allowed on another site only: refused by the call's own rule.
    ended = await hx.run([step], api + "/index.html", secrets={"TOKEN": {"value": "t", "origins": ["https://app.acme.com"]}})
    assert ended["steps"][0]["reason"] == "secretMissing" and "isn't allowed on" in ended["message"]


@needs_browser
async def test_a_kept_value_is_typed_by_a_later_write_step(api, caplog):
    caplog.set_level(logging.DEBUG)
    hx = Harness()
    keep = call_step(api, "/code", keep={"path": "$.code", "name": "CODE"})
    write = {"id": "w1", "action": "write", "label": "Write the value CODE", "at": FIELD_AT, "valueRef": "CODE"}
    await hx.h["browser.open"]({"url": api + "/index.html", "viewport": VIEWPORT})
    try:
        ended = await hx.run([keep, write], api + "/index.html", keepOpen=True)
        assert ended["result"] == "pass", ended
        assert await hx.engine.browser.page.input_value("#name") == "424242"
        assert "424242" not in json.dumps(hx.events) and "424242" not in caplog.text
        # The recorder carries on with what the run kept: a Write step recorded now types it too.
        await hx.engine.browser.page.fill("#name", "")
        step = (await hx.h["record.point"]({"action": "write", "at": FIELD_AT, "valueRef": "CODE", "appUrl": api}))["step"]
        assert step["valueRef"] == "CODE" and step["label"] == "Write the value CODE" and "text" not in step
        assert "post" not in step                             # what it types differs on every run
        assert await hx.engine.browser.page.input_value("#name") == "424242"
    finally:
        await hx.h["browser.close"]({})
    # Without a Call step before it that kept the value, the Write step fails plainly.
    ended = await hx.run([write], api + "/index.html")
    assert ended["steps"][0]["reason"] == "callFailed"
    assert ended["message"] == "No Call step before this one kept a value named CODE."


@needs_browser
async def test_a_kept_value_is_never_typed_into_another_site(api):
    hx = Harness()
    keep = call_step(api, "/code", keep={"path": "$.code", "name": "CODE"})
    write = {"id": "w1", "action": "write", "at": FIELD_AT, "valueRef": "CODE"}
    # The app is elsewhere (and the call may go there: Allow other hosts), so this page isn't the app's.
    keep["call"]["allowOtherHosts"] = True
    keep["call"]["url"] = "http://localhost:" + api.rsplit(":", 1)[1] + "/api/code"
    ended = await hx.run([keep, write], api + "/index.html", appUrl="http://localhost:" + api.rsplit(":", 1)[1])
    assert ended["steps"][1]["reason"] == "callFailed", ended
    assert "only typed into the app's own pages" in ended["message"]


@needs_browser
async def test_adding_a_call_step_makes_the_call_and_one_that_fails_is_not_added(api):
    hx = Harness()
    Api.seen.clear()
    await hx.h["browser.open"]({"url": api + "/index.html", "viewport": VIEWPORT})
    try:
        step = (await hx.h["record.point"]({"action": "call", "appUrl": api, "passStatus": "200",
                                             "call": {"method": "POST", "url": api + "/api/code?k=1", "body": "{}", "extra": "x"},
                                             "keep": {"path": "$.code", "name": "CODE"}, "timeoutMs": 5000}))["step"]
        assert step["action"] == "call" and step["label"] == "Call POST 127.0.0.1:" + api.rsplit(":", 1)[1] + "/api/code"
        assert step["call"] == {"method": "POST", "url": api + "/api/code?k=1", "body": "{}"}
        assert step["keep"] == {"path": "$.code", "name": "CODE"} and step["passStatus"] == "200" and step["timeoutMs"] == 5000
        assert "pre" not in step and "post" not in step and "at" not in step
        assert [s[1] for s in Api.seen] == ["/code?k=1"]
        assert hx.engine.recorder.values["CODE"][0] == "424242"
        with pytest.raises(EngineError) as e:
            await hx.h["record.point"]({"action": "call", "appUrl": api, "call": {"method": "POST", "url": api + "/api/fail"}})
        assert e.value.code == "network" and e.value.message == "The call didn't work. It replied 500."
        with pytest.raises(EngineError) as e:
            await hx.h["record.point"]({"action": "call", "appUrl": "https://app.acme.com", "call": {"method": "POST", "url": api + "/api/ok"}})
        assert e.value.code == "bad_request" and "https://" in e.value.message
        with pytest.raises(EngineError) as e:
            await hx.h["record.point"]({"action": "call", "appUrl": api, "call": {"method": "POST", "url": api + "/api/ok"},
                                        "keep": {"path": "$.code", "name": "1 bad"}})
        assert e.value.code == "bad_request"
    finally:
        await hx.h["browser.close"]({})


@needs_browser
async def test_a_call_step_inside_a_loop_uses_the_repeat_number(api):
    hx = Harness()
    Api.seen.clear()
    loop = {"id": "L", "action": "loop", "count": 2, "steps": [call_step(api, "/ok/{i}", call={"method": "PUT", "url": api + "/api/ok/{i}"})]}
    ended = await hx.run([loop], api + "/index.html")
    assert ended["result"] == "pass", ended
    assert [s[1] for s in Api.seen] == ["/ok/1", "/ok/2"]
