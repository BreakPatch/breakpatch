"""The fast locator's pages, served on two origins as the System 1 experiment served its corpus:
http://localhost:P/ and http://127.0.0.1:P+1/ (the cross-origin iframe on fx03 is built from
`location.port + 1`). Threaded, never cached (`Cache-Control: no-store`, no ETag or
Last-Modified). Also each state's set-up (`states.csv`) and the trials (`trials.jsonl`).

The engine's tests use it on tests/site/dom, and tools/fast-locator-bench on the corpus.

    python engine/tests/domsite.py --root <pages> [--port 8801]     # to browse them
"""
from __future__ import annotations

import argparse
import csv
import functools
import http.server
import json
import socket
import threading
import time
from pathlib import Path

DOM = Path(__file__).parent / "site" / "dom"
VIEWPORT = {"width": 1440, "height": 900}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                      ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2",
                      ".woff": "font/woff", ".ttf": "font/ttf", ".mhtml": "multipart/related"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def send_header(self, k, v):
        if k in ("Last-Modified", "ETag"):
            return
        super().send_header(k, v)

    def log_message(self, *a):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def _free_pair() -> int:
    """A port P with P+1 also free."""
    for _ in range(50):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
        try:
            with socket.socket() as a, socket.socket() as b:
                a.bind(("127.0.0.1", p))
                b.bind(("127.0.0.1", p + 1))
            return p
        except OSError:
            continue
    raise RuntimeError("no two free ports in a row")


def serve(root: Path = DOM / "pages", port: int | None = None, wait_s: float = 30):
    """Starts both origins (on `port` and `port + 1`, else on two free ones); returns
    (base url, stop). A busy fixed port is retried for up to `wait_s` seconds."""
    handler = functools.partial(Handler, directory=str(Path(root).resolve()))
    end = time.time() + wait_s
    while True:
        p = port or _free_pair()
        servers = []
        try:
            servers.append(Server(("127.0.0.1", p), handler))
            servers.append(Server(("127.0.0.1", p + 1), handler))
            break
        except OSError:
            for s in servers:
                s.server_close()
            if port is not None and time.time() > end:
                raise
            if port is not None:
                time.sleep(1)
    try:   # "localhost" can resolve to ::1 first in Chromium
        servers.append(Server6(("::1", p), handler))
    except OSError:
        pass
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()

    def stop():
        for s in servers:
            s.shutdown()
            s.server_close()
    return f"http://localhost:{p}/", stop


def states(data: Path = DOM) -> dict:
    with open(data / "states.csv", newline="") as f:
        return {r["state_id"]: r for r in csv.DictReader(f)}


def trials(data: Path = DOM) -> list[dict]:
    with open(data / "trials.jsonl") as f:
        return [json.loads(line) for line in f if line.strip()]


async def settle(page, extra_ms: int, idle_ms: int = 10000) -> None:
    try:
        await page.wait_for_load_state("networkidle", timeout=idle_ms)
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
    except Exception:  # noqa: BLE001
        pass
    await page.wait_for_timeout(extra_ms)


async def load_state(page, base: str, state: dict, extra_ms: int = 100, idle_ms: int = 3000) -> list[str]:
    """Go to the state's page and apply its set-up, as the experiment did: scroll, then click to
    open, then hover (last, so the pointer stays on it), then wait. Returns set-up errors."""
    errors = []
    await page.goto(base + state["url"].lstrip("/"), wait_until="load", timeout=30000)
    setup = json.loads(state.get("setup") or "{}")
    await settle(page, 200, idle_ms)
    if setup.get("scroll_y"):
        await page.evaluate(f"window.scrollTo(0, {int(setup['scroll_y'])})")
    for what in ("click_open", "hover"):
        if setup.get(what):
            try:
                await (page.click if what == "click_open" else page.hover)(setup[what], timeout=5000)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{what}: {e}"[:200])
    if setup.get("wait_ms"):
        await page.wait_for_timeout(int(setup["wait_ms"]))
    await settle(page, extra_ms, idle_ms)
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(DOM / "pages"))
    ap.add_argument("--port", type=int, default=8801)
    a = ap.parse_args()
    base, stop = serve(Path(a.root), a.port)
    print(f"serving {a.root} on {base} and http://127.0.0.1:{a.port + 1}/", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        stop()


if __name__ == "__main__":
    main()
