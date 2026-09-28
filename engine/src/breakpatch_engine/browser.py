"""Controlled Chromium (Playwright, async API). Used only for screenshots, mouse and text input.

Fixed viewport, device_scale_factor=1, light colour scheme, en-US locale, so the same test renders
the same way on every Mac. The live view is a stream of JPEG frames sent only when the page changes
(Chrome's screencast, which only produces frames on change), at most ~10 per second.
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from . import config, imaging
from .protocol import EngineError
from .sites import origin_of

log = logging.getLogger("breakpatch.browser")

FrameSink = Callable[[dict], None]

# The only top-level pages the test browser shows: web addresses and the empty page. Everything
# else (file:, chrome:, chrome-extension:, view-source:, devtools:, other about: pages, data:,
# javascript:, ...) is refused in goto/navigate/the start page, and aborted by route interception
# when a page tries to go there itself (spec: A5 in the security review).
_WEB = re.compile(r"^https?://[^/?#]", re.I)
# For context.route: every URL that isn't http(s) or about:blank. Matched in the Playwright driver,
# so ordinary requests never come back to Python.
NOT_WEB = re.compile(r"^(?!https?://)(?!about:blank$)", re.I)
# Chromium's own error page when a load fails: shown, never navigated to by a page.
_ERROR_PAGE = "chrome-error://"


# A selector engine that runs in an isolated world (content_script): it sees the real DOM, never
# the page's own scripts, so a page can't fake where the keyboard focus is.
FOCUS_ENGINE = "bp-focused-frame"
FOCUS_SCRIPT = """({
  queryAll(root) {
    const doc = root.ownerDocument || root;
    const a = doc.activeElement;
    return a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME') ? [a] : [];
  }
})"""


# The blinking text cursor changes the screen twice a second by itself, so after typing the page
# never looked settled for long and every check around a field saw it come and go. It is hidden
# on every page and frame, in recording and in replay alike (a constructed style sheet, which a
# page's Content Security Policy doesn't block).
NO_CARET_SCRIPT = """(() => {
  const css = '*, *::before, *::after { caret-color: transparent !important; }';
  const add = () => {
    try {
      const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (e) {
      const s = document.createElement('style'); s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    }
  };
  if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
})();"""


def is_web_address(url: str) -> bool:
    u = (url or "").strip()
    return u == "about:blank" or bool(_WEB.match(u))


def check_address(url: str) -> str:
    """The address, stripped, if the test browser may open it; else a plain `bad_request`."""
    u = (url or "").strip()
    if is_web_address(u):
        return u
    scheme = u.split(":", 1)[0].lower() if ":" in u else ""
    what = f"{scheme}: addresses" if scheme and len(scheme) < 20 else "that address"
    raise EngineError("bad_request", f"Breakpatch only opens web addresses that start with https:// or http://, "
                                     f"not {what}.", u[:200])


@dataclass
class DownloadInfo:
    filename: str
    path: str | None
    size: int
    failure: str | None = None


class BrowserSession:
    def __init__(self, timings: config.Timings, on_frame: FrameSink | None = None, headless: bool | None = None):
        self.timings = timings
        self.on_frame = on_frame
        self.headless = headless if headless is not None else os.environ.get("BP_HEADED") != "1"
        self.width = 1280
        self.height = 800
        self._pw = None
        self._browser = None
        self.context = None
        self.pages: list = []
        self.page = None
        self.downloads: list[DownloadInfo] = []
        self._download_tasks: set[asyncio.Task] = set()
        self._stream = None
        self._seq = 0
        # The live view frames the app may still be showing, by seq: a recorded click names the
        # frame it was made on, so the recorder can check the page still looks like that.
        self._frames: OrderedDict[int, str] = OrderedDict()
        self._changed_at: float | None = None    # when the frame stream last saw the page change
        self.start_origin: str | None = None     # the site the browser was opened on

    # ---------- lifecycle ----------

    @property
    def is_open(self) -> bool:
        return self.page is not None

    @property
    def chromium_version(self) -> str | None:
        """The running Chromium's version ("140.0.7339.16"), or None before it's started."""
        try:
            return self._browser.version if self._browser is not None else None
        except Exception:  # noqa: BLE001
            return None

    async def open(self, url: str, viewport: dict) -> None:
        from playwright.async_api import async_playwright

        await self.close()
        self.start_origin = origin_of(url)
        self.width = int(viewport.get("width") or 1280)
        self.height = int(viewport.get("height") or 800)
        config.apply_browser_env()
        self._pw = await async_playwright().start()
        try:
            # Finds the focused frame element from Playwright's isolated world (focused_frame).
            await self._pw.selectors.register(FOCUS_ENGINE, FOCUS_SCRIPT, content_script=True)
        except Exception as e:  # noqa: BLE001 - already registered on this driver
            log.debug("focus engine: %s", e)
        try:
            exe = config.chromium_executable()
            opts = launch_options(self.headless, self.width, self.height)
            if exe:
                opts["executable_path"] = exe
            else:
                opts["channel"] = "chromium"   # full Chromium in new headless mode (installed with --no-shell)
            self._browser = await self._pw.chromium.launch(**opts)
        except Exception as e:  # noqa: BLE001
            await self.close()
            if "Executable doesn't exist" in str(e) or "executable" in str(e).lower():
                raise EngineError("not_ready", "The browser isn't installed yet. Finish setup to install it.", str(e))
            raise EngineError("internal", "The browser couldn't start.", str(e))
        self.context = await self._browser.new_context(
            viewport={"width": self.width, "height": self.height}, device_scale_factor=1,
            accept_downloads=True, locale="en-US", color_scheme="light")
        self.context.on("page", self._on_new_page)
        await self.context.add_init_script(NO_CARET_SCRIPT)
        await self.context.route(NOT_WEB, self._guard_route)
        page = await self.context.new_page()
        await self._switch_to(page)
        if url:
            await self.goto(url)

    async def close(self) -> None:
        await self._stop_stream()
        for t in list(self._download_tasks):
            t.cancel()
        for obj in (self.context, self._browser):
            if obj is not None:
                try:
                    await obj.close()
                except Exception:  # noqa: BLE001
                    pass
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception:  # noqa: BLE001
                pass
        self._pw = self._browser = self.context = self.page = None
        self.pages = []
        self.downloads = []
        self._frames.clear()

    def require(self):
        if self.page is None:
            raise EngineError("not_ready", "The browser isn't open.")
        return self.page

    async def live(self):
        """The current page, moving to the newest open one if it closed (e.g. an SSO popup that
        closed itself after the click that finished sign in)."""
        page = self.require()
        if page.is_closed():
            open_pages = [p for p in self.pages if not p.is_closed()]
            if not open_pages:
                raise EngineError("not_ready", "The browser window was closed.")
            await self._switch_to(open_pages[-1])
        return self.page

    # ---------- address guard ----------

    async def _guard_route(self, route) -> None:
        """Only non-web URLs get here (NOT_WEB). A top-level navigation to one is aborted;
        anything else (a data: image, a blob: worker) carries on as usual."""
        req = route.request
        try:
            top = req.is_navigation_request() and req.frame.parent_frame is None
        except Exception:  # noqa: BLE001 - no frame (a service worker): treat as top level
            top = True
        if top and not req.url.startswith(_ERROR_PAGE):
            log.warning("blocked a navigation to a %s: address", req.url.split(":", 1)[0])
            try:
                await route.abort("blockedbyclient")
            except Exception:  # noqa: BLE001
                pass
            return
        await route.fallback()

    def _on_frame_navigated(self, frame) -> None:
        """Belt and braces for what route interception can't see (Chromium serves file:, chrome:
        and about: pages itself): a main frame that ends up on one goes back to about:blank."""
        try:
            if frame.parent_frame is not None or is_web_address(frame.url) or frame.url.startswith(_ERROR_PAGE):
                return
        except Exception:  # noqa: BLE001
            return
        log.warning("left a %s: page; going back to about:blank", frame.url.split(":", 1)[0])
        asyncio.ensure_future(self._blank(frame))

    @staticmethod
    async def _blank(frame) -> None:
        try:
            await frame.goto("about:blank")
        except Exception:  # noqa: BLE001
            pass

    # ---------- tabs and popups ----------

    def _on_new_page(self, page) -> None:
        if page not in self.pages:
            self.pages.append(page)
        page.on("framenavigated", self._on_frame_navigated)
        page.on("download", self._on_download)
        page.on("close", lambda p=page: asyncio.ensure_future(self._on_page_closed(p)))

    async def _on_page_closed(self, page) -> None:
        if page in self.pages:
            self.pages.remove(page)
        if page is self.page:
            open_pages = [p for p in self.pages if not p.is_closed()]
            if open_pages:
                await self._switch_to(open_pages[-1])   # e.g. an SSO popup closed itself

    async def _switch_to(self, page) -> None:
        if page not in self.pages:
            self._on_new_page(page)
        self.page = page
        try:
            await page.bring_to_front()
        except Exception:  # noqa: BLE001
            pass
        await self._start_stream()

    async def switch_tab(self, timeout: float) -> bool:
        """Switch to the newest other tab or popup, waiting up to `timeout` for one to open."""
        end = time.monotonic() + timeout
        while True:
            others = [p for p in self.pages if p is not self.page and not p.is_closed()]
            if others:
                page = others[-1]
                try:
                    await page.wait_for_load_state("load", timeout=self.timings.navigate_timeout * 1000)
                except Exception:  # noqa: BLE001
                    pass
                await self._switch_to(page)
                return True
            if time.monotonic() >= end:
                return False
            await asyncio.sleep(0.1)

    # ---------- downloads ----------

    def _on_download(self, download) -> None:
        task = asyncio.ensure_future(self._track_download(download))
        self._download_tasks.add(task)
        task.add_done_callback(self._download_tasks.discard)

    async def _track_download(self, download) -> None:
        failure = None
        path = None
        size = 0
        try:
            path = str(await download.path())
            size = Path(path).stat().st_size
        except Exception as e:  # noqa: BLE001
            failure = str(e)
        try:
            failure = failure or await download.failure()
        except Exception:  # noqa: BLE001
            pass
        self.downloads.append(DownloadInfo(download.suggested_filename, path, size, failure))

    async def wait_download(self, since: int, timeout: float) -> DownloadInfo | None:
        end = time.monotonic() + timeout
        while True:
            done = [d for d in self.downloads[since:] if d.failure is None]
            if done:
                return done[-1]
            if time.monotonic() >= end:
                return None
            await asyncio.sleep(0.1)

    # ---------- screen ----------

    async def shoot(self) -> np.ndarray:
        for attempt in range(3):
            page = await self.live()
            try:
                return imaging.to_array(await page.screenshot(type="png", timeout=15000))
            except Exception:  # noqa: BLE001
                # The page closed between the check and the screenshot: go again on the next one.
                if attempt == 2 or not page.is_closed():
                    raise
                await asyncio.sleep(0.05)
        raise AssertionError("unreachable")

    async def _start_stream(self) -> None:
        await self._stop_stream()
        self._changed_at = None
        if self.on_frame is None or self.page is None:
            return
        self._stream = FrameStream(self, self.page, self.on_frame)
        await self._stream.start()

    async def _stop_stream(self) -> None:
        if self._stream is not None:
            await self._stream.stop()
            self._stream = None

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    @property
    def last_seq(self) -> int:
        return self._seq

    def remember_frame(self, seq: int, b64: str) -> None:
        self._frames[seq] = b64
        while len(self._frames) > config.FRAMES_KEPT:
            self._frames.popitem(last=False)

    def page_changed(self) -> None:
        self._changed_at = time.monotonic()

    def seen_frame(self, seq) -> np.ndarray | None:
        """The live view frame `seq` as an RGB array, or None when it's unknown or too old."""
        if not isinstance(seq, int) or isinstance(seq, bool) or seq not in self._frames:
            return None
        try:
            return imaging.to_array(base64.b64decode(self._frames[seq]))
        except Exception:  # noqa: BLE001
            return None

    def quiet_for(self) -> float:
        """Seconds since the frame stream last saw the page change (it only sends frames on a
        change), or 0 when there is no stream to go by."""
        if self._stream is None or self._changed_at is None:
            return 0.0
        return time.monotonic() - self._changed_at

    # ---------- navigation ----------

    async def goto(self, url: str) -> None:
        url = check_address(url)
        page = await self.live()
        try:
            await page.goto(url, wait_until="load", timeout=self.timings.navigate_timeout * 1000)
        except Exception as e:  # noqa: BLE001
            raise EngineError("network", f"The page at {url} didn't load.", str(e))

    async def navigate(self, nav: str, url: str | None = None) -> None:
        page = await self.live()
        t = self.timings.navigate_timeout * 1000
        try:
            if nav == "url":
                if not url:
                    raise EngineError("bad_request", "Add an address to go to.")
                await self.goto(url)
            elif nav == "reload":
                await page.reload(wait_until="load", timeout=t)
            elif nav == "back":
                await page.go_back(wait_until="load", timeout=t)
            elif nav == "forward":
                await page.go_forward(wait_until="load", timeout=t)
            else:
                raise EngineError("bad_request", "The engine doesn't know that kind of navigation.", nav)
        except EngineError:
            raise
        except Exception as e:  # noqa: BLE001
            raise EngineError("network", "The page didn't load.", str(e))

    @property
    def url(self) -> str:
        return self.page.url if self.page is not None else ""

    # ---------- mouse and keyboard ----------

    async def move(self, at: Sequence[float]) -> None:
        await (await self.live()).mouse.move(float(at[0]), float(at[1]))

    async def click(self, at: Sequence[float], button: str = "left", count: int = 1, hold: float = 0.0) -> None:
        page = await self.live()
        mouse = page.mouse
        x, y = float(at[0]), float(at[1])
        await mouse.move(x, y)
        try:
            if hold > 0:
                await mouse.down(button=button)
                await asyncio.sleep(hold)
                await mouse.up(button=button)
            else:
                await mouse.click(x, y, button=button, click_count=count)
        except Exception:
            # The click closed its own page (a popup's Close or Done button, an SSO window that
            # finishes sign in): Playwright reports the page gone before the click returns.
            if page.is_closed():
                return
            raise

    async def drag(self, frm: Sequence[float], to: Sequence[float], steps: int = 12) -> None:
        mouse = (await self.live()).mouse
        await mouse.move(float(frm[0]), float(frm[1]))
        await mouse.down()
        await mouse.move(float(to[0]), float(to[1]), steps=steps)
        await mouse.up()

    async def wheel(self, at: Sequence[float] | None, dx: float, dy: float) -> None:
        mouse = (await self.live()).mouse
        if at is not None:
            await mouse.move(float(at[0]), float(at[1]))
        await mouse.wheel(float(dx), float(dy))

    async def type_text(self, text: str) -> None:
        await (await self.live()).keyboard.type(text, delay=10)

    async def focused_frame(self):
        """The frame that has the keyboard focus: the page itself, or the (nested) frame inside it
        that holds the focused field. Found by FOCUS_ENGINE in Playwright's isolated world, so the
        page's own scripts can't make it look elsewhere."""
        page = await self.live()
        frame = page.main_frame
        for _ in range(8):
            try:
                inner = frame.locator(f"{FOCUS_ENGINE}=*")
                if not await inner.count():
                    break
                el = await inner.first.element_handle(timeout=1000)
                child = await el.content_frame() if el is not None else None
            except Exception:  # noqa: BLE001 - detached or navigating: judge the frame we have
                break
            if child is None:
                break
            frame = child
        return frame

    @staticmethod
    def frame_origin(frame) -> str | None:
        """A frame's origin. about:blank / about:srcdoc frames have their parent's."""
        f = frame
        while f is not None:
            url = f.url or ""
            if url not in ("", "about:blank", "about:srcdoc"):
                return origin_of(url)
            f = f.parent_frame
        return None

    async def type_guarded(self, text: str, allowed) -> str | None:
        """Types `text` key by key while the focused frame's origin passes `allowed`. Returns None
        when it was all typed, else the origin that was refused ("" when it has none, like a data:
        frame). Checked before the first key and before every other one, so a redirect or a new
        frame part way through gets nothing more."""
        page = await self.live()
        frame = await self.focused_frame()
        origin = self.frame_origin(frame)
        if not allowed(origin):
            return origin or ""
        for i, ch in enumerate(text):
            if i:
                if page.is_closed():
                    return ""
                frame = await self.focused_frame()
                now = self.frame_origin(frame)
                if now != origin or not allowed(now):
                    return now or ""
            await page.keyboard.type(ch)
            await asyncio.sleep(0.01)
        return None

    async def upload(self, at: Sequence[float], path: Path) -> bool:
        """Click where a file picker opens and choose `path`. False if no picker appeared."""
        page = await self.live()
        try:
            async with page.expect_file_chooser(timeout=self.timings.chooser_timeout * 1000) as info:
                await self.click(at)
            chooser = await info.value
        except Exception:  # noqa: BLE001
            return False
        await chooser.set_files(str(path))
        return True

    # ---------- background reload (spec §10.3.5) ----------

    async def background_reload_shots(self, settle_fn) -> tuple[np.ndarray, np.ndarray] | None:
        """Load the current address twice in a hidden tab and return both settled screens."""
        if self.context is None or not self.url.startswith(("http://", "https://")):
            return None
        url = self.url
        page = await self.context.new_page()
        if page in self.pages:
            self.pages.remove(page)
        try:
            async def shoot() -> np.ndarray:
                return imaging.to_array(await page.screenshot(type="png"))

            await page.goto(url, wait_until="load", timeout=self.timings.navigate_timeout * 1000)
            a, _ = await settle_fn(shoot)
            await page.reload(wait_until="load", timeout=self.timings.navigate_timeout * 1000)
            b, _ = await settle_fn(shoot)
            return a, b
        except Exception as e:  # noqa: BLE001
            log.info("background reload skipped: %s", e)
            return None
        finally:
            try:
                await page.close()
            except Exception:  # noqa: BLE001
                pass
            if self.page is not None:
                try:
                    await self.page.bring_to_front()
                except Exception:  # noqa: BLE001
                    pass


def launch_options(headless: bool, width: int = 1280, height: int = 800) -> dict:
    """Chromium's launch options. Its sandbox is on (config.chromium_sandbox): tested pages are
    third-party code, so a renderer bug mustn't mean code running as the user. The window is made
    the viewport's size (headless has no window frame), so Chrome paints the whole viewport."""
    return {"headless": headless, "chromium_sandbox": config.chromium_sandbox(),
            "args": ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text",
                     "--font-render-hinting=none", f"--window-size={int(width)},{int(height)}"]}


def frame_size(b64: str) -> tuple[int, int] | None:
    """A JPEG's width and height, from its header."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(b64))) as img:
            return img.size
    except Exception:  # noqa: BLE001
        return None


class FrameStream:
    """Live view frames for one page. Chrome's screencast only sends a frame when the page changes;
    we throttle to `frame_min_gap` and always deliver the latest frame. Falls back to polling."""

    def __init__(self, session: BrowserSession, page, sink: FrameSink):
        self.session = session
        self.page = page
        self.sink = sink
        self.cdp = None
        self.last_sent = 0.0
        self.pending: str | None = None
        self.last_offered: str | None = None
        self.flush_task: asyncio.Task | None = None
        self.poll_task: asyncio.Task | None = None
        self.stopped = False

    async def start(self) -> None:
        try:
            self.cdp = await self.session.context.new_cdp_session(self.page)
            self.cdp.on("Page.screencastFrame", self._on_frame)
            await self.cdp.send("Page.startScreencast", {
                "format": "jpeg", "quality": 70, "everyNthFrame": 1,
                "maxWidth": self.session.width, "maxHeight": self.session.height})
        except Exception as e:  # noqa: BLE001
            log.info("screencast unavailable (%s), polling screenshots instead", e)
            self.cdp = None
            self.poll_task = asyncio.ensure_future(self._poll())

    async def stop(self) -> None:
        self.stopped = True
        for t in (self.flush_task, self.poll_task):
            if t is not None:
                t.cancel()
        if self.cdp is not None:
            try:
                await self.cdp.send("Page.stopScreencast")
                await self.cdp.detach()
            except Exception:  # noqa: BLE001
                pass

    def _on_frame(self, params: dict) -> None:
        if self.cdp is not None:
            asyncio.ensure_future(self._ack(params.get("sessionId")))
        data = params.get("data", "")
        if data and self.poll_task is None and not self.fits(data, params.get("metadata") or {}):
            # Chrome paints only the part of the page its window has room for (a Mac screen shorter
            # than the test's viewport): such a frame is cropped, and showing it at the viewport's
            # size would stretch it and put every click in the wrong place. Screenshots always
            # cover the whole viewport, so the stream uses them from now on.
            log.warning("screencast frames don't cover the %dx%d viewport (%s); using screenshots",
                        self.session.width, self.session.height, frame_size(data))
            asyncio.ensure_future(self._fall_back())
            return
        self._offer(data)

    def fits(self, b64: str, meta: dict) -> bool:
        """Whether a screencast frame shows the whole viewport at 1:1."""
        w, h = self.session.width, self.session.height
        dw, dh = meta.get("deviceWidth"), meta.get("deviceHeight")
        if dw is not None and dh is not None and (round(dw) != w or round(dh) != h):
            return False
        return frame_size(b64) in ((w, h), None)

    async def _fall_back(self) -> None:
        if self.poll_task is not None or self.stopped:
            return
        self.poll_task = asyncio.ensure_future(self._poll())
        cdp, self.cdp = self.cdp, None
        if cdp is not None:
            try:
                await cdp.send("Page.stopScreencast")
                await cdp.detach()
            except Exception:  # noqa: BLE001
                pass

    async def _ack(self, sid) -> None:
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": sid})
        except Exception:  # noqa: BLE001
            pass

    def _offer(self, b64: str) -> None:
        if self.stopped or not b64:
            return
        if b64 == self.last_offered:
            return        # Chrome repainted, but the picture is the same (a hidden text cursor)
        self.last_offered = b64
        self.session.page_changed()
        gap = self.session.timings.frame_min_gap
        now = time.monotonic()
        if now - self.last_sent >= gap:
            self._send(b64)
        else:
            self.pending = b64
            if self.flush_task is None or self.flush_task.done():
                self.flush_task = asyncio.ensure_future(self._flush_later(gap - (now - self.last_sent)))

    async def _flush_later(self, delay: float) -> None:
        await asyncio.sleep(max(0.0, delay))
        if self.pending is not None and not self.stopped:
            b64, self.pending = self.pending, None
            self._send(b64)

    def _send(self, b64: str) -> None:
        # Always the size of the picture itself, so the app can tell a frame that isn't the viewport.
        self.last_sent = time.monotonic()
        self.pending = None
        seq = self.session.next_seq()
        self.session.remember_frame(seq, b64)
        w, h = frame_size(b64) or (self.session.width, self.session.height)
        self.sink({"jpeg": b64, "width": w, "height": h, "seq": seq})

    async def _poll(self) -> None:
        last = None
        while not self.stopped:
            try:
                jpg = await self.page.screenshot(type="jpeg", quality=70)
                if jpg != last:
                    last = jpg
                    self._offer(base64.b64encode(jpg).decode())
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(self.session.timings.frame_min_gap)
