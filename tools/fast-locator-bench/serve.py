"""Serves the corpus pages offline on two origins, as the experiment did (its scripts/harness/serve.py):

    http://localhost:8801/     the pages
    http://127.0.0.1:8802/     the same files, a different origin (for cross-origin iframes)

Threaded, `Cache-Control: no-store`, no ETag or Last-Modified, so nothing is served from a cache.
Run on its own to browse the corpus:  python serve.py --root <corpus>/data/pages
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socket
import threading
import time
from pathlib import Path

PORT_MAIN, PORT_OTHER = 8801, 8802


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

    def log_message(self, fmt, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def start_servers(root, port_main: int = PORT_MAIN, port_other: int = PORT_OTHER, wait_s: float = 30):
    """Both origins in background threads; returns stop(). Waits up to `wait_s` for busy ports."""
    root = Path(root).resolve()
    handler = functools.partial(Handler, directory=str(root))
    end = time.time() + wait_s
    while True:
        try:
            servers = [Server(("127.0.0.1", port_main), handler), Server(("127.0.0.1", port_other), handler)]
            break
        except OSError:
            if time.time() > end:
                raise
            time.sleep(1)
    try:   # "localhost" can resolve to ::1 first in Chromium
        servers.append(Server6(("::1", port_main), handler))
    except OSError:
        pass
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()

    def stop():
        for s in servers:
            s.shutdown()
            s.server_close()
    return stop


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True)
    ap.add_argument("--port-main", type=int, default=PORT_MAIN)
    ap.add_argument("--port-other", type=int, default=PORT_OTHER)
    a = ap.parse_args()
    stop = start_servers(a.root, a.port_main, a.port_other)
    print(f"serving {a.root} on http://localhost:{a.port_main}/ and http://127.0.0.1:{a.port_other}/", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        stop()


if __name__ == "__main__":
    main()
