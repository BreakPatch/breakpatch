"""The fast locator's fixture pages (tests/site/dom), served on two origins like the experiment's
harness (scripts/harness/serve.py): http://localhost:P/ and http://127.0.0.1:P+1/ for the
cross-origin iframe (fx03 builds its address from `location.port + 1`). Also their states
(`states.csv`: address plus scroll, hover or click set-up) and trials (`trials.jsonl`)."""
from __future__ import annotations

import csv
import functools
import http.server
import json
import socket
import threading
from pathlib import Path

DOM = Path(__file__).parent / "site" / "dom"
VIEWPORT = {"width": 1440, "height": 900}


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def _pair() -> int:
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


def serve(root: Path = DOM / "pages"):
    """Starts both origins; returns (base url, stop)."""
    port = _pair()
    handler = functools.partial(_Quiet, directory=str(root))
    servers = [http.server.ThreadingHTTPServer(("127.0.0.1", port), handler),
               http.server.ThreadingHTTPServer(("127.0.0.1", port + 1), handler)]
    try:   # "localhost" can resolve to ::1 first in Chromium
        class V6(http.server.ThreadingHTTPServer):
            address_family = socket.AF_INET6
        servers.append(V6(("::1", port), handler))
    except OSError:
        pass
    for s in servers:
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()

    def stop():
        for s in servers:
            s.shutdown()
            s.server_close()
    return f"http://localhost:{port}/", stop


def states() -> dict:
    with open(DOM / "states.csv", newline="") as f:
        return {r["state_id"]: r for r in csv.DictReader(f)}


def trials() -> list[dict]:
    with open(DOM / "trials.jsonl") as f:
        return [json.loads(line) for line in f if line.strip()]


async def load_state(page, base: str, state: dict) -> None:
    """Go to the state's page and apply its set-up (scroll, then click to open, then hover last so
    the pointer stays on it), as the harness's browserenv.load_state does."""
    await page.goto(base + state["url"], wait_until="load")
    setup = json.loads(state.get("setup") or "{}")
    try:
        await page.wait_for_load_state("networkidle", timeout=3000)
    except Exception:  # noqa: BLE001
        pass
    if setup.get("scroll_y"):
        await page.evaluate(f"window.scrollTo(0, {int(setup['scroll_y'])})")
    if setup.get("click_open"):
        await page.click(setup["click_open"], timeout=5000)
    if setup.get("hover"):
        await page.hover(setup["hover"], timeout=5000)
    if setup.get("wait_ms"):
        await page.wait_for_timeout(int(setup["wait_ms"]))
    await page.wait_for_timeout(100)
