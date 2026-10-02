"""The test browser only shows web pages, with Chromium's sandbox on (security review A5)."""
import asyncio
import functools
import http.server
import sys
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine import browser as br
from breakpatch_engine import config
from breakpatch_engine.config import Timings
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.service import Engine

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}

BLOCKED = ["file:///etc/passwd", "chrome://version", "chrome-extension://abc/page.html",
           "view-source:https://example.com", "devtools://devtools/bundled/inspector.html",
           "about:version", "about:settings", "data:text/html,<h1>hi</h1>", "javascript:alert(1)",
           "ftp://example.com/file", "blob:https://example.com/1234", "example.com", ""]
ALLOWED = ["https://example.com", "http://127.0.0.1:8080/x?y=1", "HTTPS://Example.com/", "about:blank",
           "  https://example.com/path  "]


@pytest.mark.parametrize("url", BLOCKED)
def test_non_web_addresses_are_refused(url):
    assert not br.is_web_address(url)
    with pytest.raises(EngineError) as e:
        br.check_address(url)
    assert e.value.code == "bad_request"
    assert "only opens web addresses" in e.value.message


@pytest.mark.parametrize("url", ALLOWED)
def test_web_addresses_and_the_empty_page_are_fine(url):
    assert br.check_address(url) == url.strip()


def test_the_route_matcher_catches_exactly_the_non_web_addresses():
    for url in BLOCKED:
        if url:
            assert br.NOT_WEB.match(url), url
    for url in ("https://example.com/", "http://localhost:1/a", "about:blank"):
        assert not br.NOT_WEB.match(url), url


def test_chromium_runs_with_its_sandbox(monkeypatch):
    monkeypatch.delenv("BP_NO_SANDBOX", raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    opts = br.launch_options(True)
    assert opts["chromium_sandbox"] is True
    assert "--no-sandbox" not in opts["args"]


def test_the_sandbox_switches_are_for_development_only(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("BP_NO_SANDBOX", "1")
    assert br.launch_options(True)["chromium_sandbox"] is False
    monkeypatch.delenv("BP_NO_SANDBOX")
    monkeypatch.setattr(sys, "platform", "linux")                # development and CI only
    assert br.launch_options(True)["chromium_sandbox"] is False
    monkeypatch.setenv("BP_SANDBOX", "1")
    assert br.launch_options(True)["chromium_sandbox"] is True
    monkeypatch.delenv("BP_SANDBOX")
    monkeypatch.setenv("BP_NO_SANDBOX", "1")
    monkeypatch.setattr(sys, "frozen", True, raising=False)      # a packaged (release) sidecar
    assert config.is_release()
    assert br.launch_options(True)["chromium_sandbox"] is True


class FakeRequest:
    def __init__(self, url, navigation=True, top=True):
        self.url = url
        self._nav = navigation
        self.frame = type("F", (), {"parent_frame": None if top else object()})()

    def is_navigation_request(self):
        return self._nav


class FakeRoute:
    def __init__(self, req):
        self.request = req
        self.done = None

    async def abort(self, code):
        self.done = ("abort", code)

    async def fallback(self):
        self.done = ("fallback",)


async def test_route_interception_aborts_top_level_navigations_only():
    s = br.BrowserSession(Timings.fast())
    top = FakeRoute(FakeRequest("file:///etc/passwd"))
    await s._guard_route(top)
    assert top.done == ("abort", "blockedbyclient")
    image = FakeRoute(FakeRequest("data:image/png;base64,AAAA", navigation=False))
    await s._guard_route(image)
    assert image.done == ("fallback",)
    frame = FakeRoute(FakeRequest("data:text/html,x", top=False))
    await s._guard_route(frame)
    assert frame.done == ("fallback",)


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@needs_browser
async def test_goto_and_navigate_refuse_local_and_browser_pages(site):
    events = []
    eng = Engine(lambda e, d: events.append((e, d)), timings=Timings.fast())
    h = eng.handlers()
    await h["browser.open"]({"url": "about:blank", "viewport": VIEWPORT})
    try:
        for url in ("file:///etc/passwd", "chrome://version", "view-source:" + site, "about:version",
                    "data:text/html,<p>x</p>", "javascript:document.title='x'"):
            with pytest.raises(EngineError) as e:
                await h["browser.navigate"]({"nav": "url", "url": url})
            assert e.value.code == "bad_request", url
            assert eng.browser.url == "about:blank"
        await h["browser.navigate"]({"nav": "url", "url": site + "/popup.html"})
        assert eng.browser.url.endswith("/popup.html")
    finally:
        await h["browser.close"]({})


@needs_browser
async def test_a_page_that_ends_up_on_a_local_page_goes_back_to_blank(site):
    s = br.BrowserSession(Timings.fast())
    await s.open(site + "/popup.html", VIEWPORT)
    try:
        page = s.page
        # Only the app itself (CDP) can do this; web content can't. The guard still catches it.
        cdp = await s.context.new_cdp_session(page)
        await cdp.send("Page.navigate", {"url": "chrome://version"})
        for _ in range(50):
            if page.url == "about:blank":
                break
            await asyncio.sleep(0.1)
        assert page.url == "about:blank"
    finally:
        await s.close()


@needs_browser
async def test_a_run_with_a_local_start_page_or_navigate_step_fails_plainly(site):
    events = []
    ended = asyncio.Event()

    def emit(e, d):
        events.append((e, d))
        if e == "run.ended":
            ended.set()

    eng = Engine(emit, timings=Timings.fast())
    steps = [{"id": "w", "action": "waitFor", "durationMs": 10}]
    await eng.handlers()["run.start"]({"runId": "r", "startUrl": "file:///etc/passwd", "viewport": VIEWPORT,
                                       "steps": steps, "settings": {}, "secrets": {}})
    await asyncio.wait_for(ended.wait(), 30)
    out = [d for e, d in events if e == "run.ended"][-1]
    assert out["result"] == "fail" and "only opens web addresses" in out["message"]

    ended.clear()
    nav = [{"id": "n", "action": "navigate", "nav": "url", "url": "chrome://settings"}]
    await eng.handlers()["run.start"]({"runId": "r2", "startUrl": site + "/popup.html", "viewport": VIEWPORT,
                                       "steps": nav, "settings": {}, "secrets": {}})
    await asyncio.wait_for(ended.wait(), 30)
    out = [d for e, d in events if e == "run.ended"][-1]
    assert out["result"] == "fail" and "only opens web addresses" in out["message"]


class _MovingPage:
    """A page whose first screenshot hangs while a redirect moves it to another site."""
    def __init__(self, moves: bool):
        self.url, self.moves, self.calls = "http://127.0.0.1/a", moves, 0

    def is_closed(self):
        return False

    async def screenshot(self, **_):
        self.calls += 1
        if self.calls == 1:
            if self.moves:
                self.url = "http://localhost/b"
            raise TimeoutError("Page.screenshot: Timeout 15000ms exceeded.")
        return b"png"


@pytest.mark.parametrize("moves", [True, False])
async def test_a_screenshot_caught_in_a_redirect_is_taken_again(monkeypatch, moves):
    session = br.BrowserSession(Timings.fast())
    session.page = page = _MovingPage(moves)
    monkeypatch.setattr(br.imaging, "to_array", lambda data: data)
    if moves:
        assert await session.shoot() == b"png" and page.calls == 2
    else:   # a page that stayed put and still timed out is a real failure
        with pytest.raises(TimeoutError):
            await session.shoot()
