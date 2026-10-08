"""Set-up and clean-up calls only reach the app's own hosts (security review A4)."""
import asyncio
import http.server
import logging
import threading

import pytest

from conftest import needs_browser
from breakpatch_engine import calls
from breakpatch_engine.actions import Secret
from breakpatch_engine.calls import CallRefused, plan, redact
from breakpatch_engine.config import Timings
from breakpatch_engine.runner import safe_name
from breakpatch_engine.service import Engine


def dns(table: dict[str, list[str]]):
    def resolver(host, port):
        if host not in table:
            raise OSError("no such host")
        return table[host]
    return resolver


PUBLIC = dns({"app.acme.com": ["93.184.216.34"], "api.acme.com": ["93.184.216.35"], "acme.com": ["93.184.216.36"],
              "evil.example": ["203.0.113.9"], "rebind.acme.com": ["10.0.0.5"], "meta.acme.com": ["169.254.169.254"],
              "v6.acme.com": ["2606:4700::1111"], "lo6.acme.com": ["::1"], "ll6.acme.com": ["fe80::1"],
              "ula.acme.com": ["fd12:3456::1"], "mapped.acme.com": ["::ffff:127.0.0.1"], "cgnat.acme.com": ["100.64.1.1"],
              "mixed.acme.com": ["93.184.216.40", "192.168.1.10"], "alibaba.acme.com": ["100.100.100.200"],
              "a.github.io": ["185.199.108.153"], "b.github.io": ["185.199.108.153"],
              "intranet.corp": ["10.1.1.1"], "api.intranet.corp": ["10.1.1.2"], "localhost": ["127.0.0.1"]})
APP = "https://app.acme.com/login"


def refused(call, app=APP, secrets=None):
    with pytest.raises(CallRefused) as e:
        plan(call, app, secrets or {}, PUBLIC)
    return e.value


def test_calls_to_the_app_and_its_sibling_hosts_are_fine():
    p = plan({"method": "post", "url": "https://api.acme.com/test/seed?k=1"}, APP, {}, PUBLIC)
    assert (p.method, p.host, p.port, p.target, p.address) == ("POST", "api.acme.com", 443, "/test/seed?k=1", "93.184.216.35")
    assert plan({"method": "GET", "url": "https://acme.com/x"}, APP, {}, PUBLIC).host == "acme.com"
    assert plan({"method": "DELETE", "url": "https://app.acme.com:8443/x"}, APP, {}, PUBLIC).port == 8443
    assert plan({"method": "GET", "url": "https://v6.acme.com/"}, APP, {}, PUBLIC).address == "2606:4700::1111"


def test_other_hosts_need_the_opt_in():
    e = refused({"method": "POST", "url": "https://evil.example/steal"})
    assert "isn't part of app.acme.com" in e.message and "Allow other hosts" in e.message
    assert plan({"method": "POST", "url": "https://evil.example/x", "allowOtherHosts": True}, APP, {}, PUBLIC).host == "evil.example"
    # A shared hosting domain counts as the app's own host only.
    assert "Allow other hosts" in refused({"method": "GET", "url": "https://b.github.io/"}, "https://a.github.io/").message


def test_https_only_and_plain_http_just_for_a_local_app():
    assert "https://" in refused({"method": "GET", "url": "http://api.acme.com/"}).message
    assert plan({"method": "GET", "url": "http://localhost:3000/seed"}, "http://localhost:3000/", {}, PUBLIC).port == 3000
    assert plan({"method": "GET", "url": "http://127.0.0.1:8080/"}, "http://127.0.0.1:8080/", {}, PUBLIC).host == "127.0.0.1"
    assert "https://" in refused({"method": "GET", "url": "http://localhost/"}, APP).message


@pytest.mark.parametrize("url", ["ftp://app.acme.com/x", "file:///etc/passwd", "data:text/plain,x", "gopher://app.acme.com",
                                 "app.acme.com/x", "", "https://"])
def test_only_web_addresses(url):
    assert refused({"method": "GET", "url": url}).kind == "invalid"


@pytest.mark.parametrize("method", ["TRACE", "CONNECT", "OPTIONS", "HEAD", "get x"])
def test_only_the_five_methods(method):
    assert "GET, POST, PUT, PATCH or DELETE" in refused({"method": method, "url": "https://app.acme.com/"}).message


@pytest.mark.parametrize("host", ["rebind", "lo6", "ll6", "ula", "mapped", "cgnat", "mixed"])
def test_private_and_local_addresses_are_blocked_after_dns(host):
    e = refused({"method": "GET", "url": f"https://{host}.acme.com/"})
    assert "private or local address" in e.message
    assert plan({"method": "GET", "url": f"https://{host}.acme.com/", "allowOtherHosts": True}, APP, {}, PUBLIC)


@pytest.mark.parametrize("host", ["meta", "alibaba"])
def test_cloud_metadata_is_never_reached(host):
    for others in (False, True):
        assert "metadata" in refused({"method": "GET", "url": f"https://{host}.acme.com/latest", "allowOtherHosts": others}).message


def test_an_intranet_app_may_call_its_own_local_hosts():
    p = plan({"method": "POST", "url": "https://api.intranet.corp/seed"}, "https://intranet.corp/", {}, PUBLIC)
    assert p.address == "10.1.1.2"


def test_unknown_hosts_fail_plainly():
    assert refused({"method": "GET", "url": "https://nope.acme.com/"}).kind == "unreachable"


def test_headers_can_use_a_saved_secret_on_its_own_site():
    ok = {"TOKEN": Secret("s3cret", ("https://api.acme.com",))}
    call = {"method": "POST", "url": "https://api.acme.com/seed",
            "headers": [{"name": "Authorization", "secretRef": "TOKEN"}, {"name": "X-Env", "value": "test"}, {"name": ""}]}
    assert plan(call, APP, ok, PUBLIC).headers == {"Authorization": "s3cret", "X-Env": "test"}
    wrong = {"TOKEN": Secret("s3cret", ("https://app.acme.com",))}
    e = refused(call, secrets=wrong)
    assert e.kind == "secret" and e.message == "TOKEN isn't allowed on api.acme.com."
    assert refused(call).message == "The saved secret TOKEN isn't on this Mac."
    assert refused({**call, "headers": [{"name": "X", "value": "a\r\nHost: evil"}]}).kind == "invalid"
    assert refused({**call, "headers": [{"name": "Bad Name", "value": "a"}]}).kind == "invalid"
    assert refused({**call, "headers": [{"name": "Host", "value": "evil.example"}]}).kind == "invalid"
    assert calls.call_secret_refs(call) == ["TOKEN"]


def test_a_secret_the_shell_refused_is_never_sent():
    """A secret on this Mac kept for other workspaces reaches the engine as its reason only."""
    call = {"method": "POST", "url": "https://api.acme.com/seed", "headers": [{"name": "Authorization", "secretRef": "TOKEN"}]}
    why = "TOKEN is kept for other workspaces on this Mac."
    e = refused(call, secrets={"TOKEN": Secret("", (), False, why)})
    assert e.kind == "secret" and e.message == why


def test_logs_leave_out_queries_user_info_and_secrets():
    assert redact("https://user:pw@api.acme.com:8443/seed/abc123?token=xyz#f", ["abc123"]) == "https://api.acme.com:8443/seed/•••?…"
    assert redact("https://api.acme.com/seed") == "https://api.acme.com/seed"


def test_ids_become_safe_file_names():
    assert safe_name("s1a2b3", "step") == "s1a2b3"
    assert safe_name("../../etc/passwd", "step") == "etc_passwd"
    assert safe_name("/abs/path", "run") == "abs_path"
    assert safe_name("..", "run") == "run" and safe_name(None, "step") == "step"
    assert len(safe_name("x" * 500, "s")) == 64


# ---------------------------------------------------------------- against a real local server

class Api(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *a):
        pass

    def _reply(self):
        Api.seen.append((self.command, self.path, self.headers.get("Authorization")))
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
        else:
            self.send_response(204 if self.path.startswith("/ok") else 500)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _reply


@pytest.fixture(scope="module")
def api():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


async def test_a_call_to_a_local_app_is_made_and_timed(api, caplog):
    Api.seen.clear()
    secrets = {"TOKEN": Secret("tok-123", (api,))}
    call = {"method": "PUT", "url": api + "/ok?key=abc", "headers": [{"name": "Authorization", "secretRef": "TOKEN"}]}
    r = await calls.make(call, api + "/", secrets, 5)
    assert r.ok and r.status == 204 and r.ms is not None
    assert Api.seen == [("PUT", "/ok?key=abc", "tok-123")]
    assert "?key" not in r.info and "tok-123" not in r.info


async def test_redirects_are_not_followed(api):
    Api.seen.clear()
    r = await calls.make({"method": "GET", "url": api + "/redirect"}, api, {}, 5)
    assert not r.ok and r.error == "redirect" and r.status == 302
    assert [p for _, p, _ in Api.seen] == ["/redirect"]


async def test_try_it_goes_through_the_engine_with_the_same_rules(api):
    eng = Engine(lambda *a: None, timings=Timings.fast(), healer=None)
    try_it = eng.handlers()["call.try"]
    got = await try_it({"call": {"method": "POST", "url": api + "/ok"}, "appUrl": api})
    assert got["ok"] is True and got["status"] == 204
    got = await try_it({"call": {"method": "POST", "url": api + "/fail"}, "appUrl": api})
    assert got["ok"] is False and got["status"] == 500
    got = await try_it({"call": {"method": "POST", "url": api + "/ok"}, "appUrl": "https://app.acme.com"})
    assert got["ok"] is False and got["error"] == "refused" and "https://" in got["message"]
    got = await try_it({"call": {"method": "GET", "url": "file:///etc/passwd"}, "appUrl": api})
    assert got == {"ok": False, "error": "invalid", "message": "Enter a full address, starting with https://"}


@needs_browser
async def test_a_refused_set_up_call_stops_the_run_and_says_why(api, caplog):
    Api.seen.clear()
    ended = asyncio.Event()
    out = []
    eng = Engine(lambda e, d: (out.append(d), ended.set()) if e == "run.ended" else None, timings=Timings.fast(), healer=None)
    caplog.set_level(logging.INFO)
    await eng.handlers()["run.start"]({
        "runId": "r", "startUrl": api + "/ok", "appUrl": "https://app.acme.com", "viewport": {"width": 800, "height": 600},
        "steps": [{"id": "w", "action": "waitFor", "durationMs": 10}], "settings": {}, "secrets": {},
        "setUp": {"method": "POST", "url": "http://169.254.169.254/latest/meta-data?secret=1"}})
    await asyncio.wait_for(ended.wait(), 30)
    assert out[-1]["steps"][0]["reason"] == "setUpFailed"
    assert "The set-up call didn't succeed" in out[-1]["message"] and "https://" in out[-1]["message"]
    assert Api.seen == []
    assert "secret=1" not in caplog.text


def test_a_call_tries_each_checked_address_in_turn():
    """localhost is ::1 first on macOS and Ubuntu; a dev server on 127.0.0.1 only must still answer."""
    import socket, threading
    from breakpatch_engine.calls import Plan, _send
    srv = socket.create_server(("127.0.0.1", 0))
    port = srv.getsockname()[1]

    def serve():
        conn, _ = srv.accept()
        with conn:
            conn.recv(1024)
            conn.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
    t = threading.Thread(target=serve, daemon=True)
    t.start()
    # ::1 refuses (nothing listens there on this port), then 127.0.0.1 answers.
    p = Plan("GET", f"http://localhost:{port}/", "http", "localhost", port, "/", "::1", addresses=["::1", "127.0.0.1"])
    try:
        assert _send(p, 5) == 204
    finally:
        srv.close()
