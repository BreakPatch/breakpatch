"""A tiny stand-in for the Hugging Face Hub (HF_ENDPOINT), enough for model_info + snapshot_download.

Serves one repo with a small config file and a larger "weights" file that streams slowly, so a
download can be paused half way. Records Range headers to prove a resume happened.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import threading
import time
from urllib.parse import unquote, urlparse

COMMIT = "0123456789abcdef0123456789abcdef01234567"


class FakeHub:
    def __init__(self, repo: str = "Org/Tiny-VL", big_bytes: int = 3 * 2**20, chunk: int = 32 * 1024,
                 delay: float = 0.01):
        self.repo = repo
        self.files = {"config.json": b'{"model_type": "fake"}\n',
                      "model.safetensors": bytes((i * 7) % 251 for i in range(big_bytes))}
        self.chunk, self.delay = chunk, delay
        self.ranges: list[tuple[str, str]] = []
        self.gets: list[str] = []
        self.served_override: dict[str, bytes] = {}   # bytes sent instead of the real file (corruption tests)
        hub = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_HEAD(self):
                hub.serve(self, head=True)

            def do_GET(self):
                hub.serve(self, head=False)

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()

    def siblings(self):
        out = []
        for name, body in self.files.items():
            s = {"rfilename": name, "size": len(body), "blobId": hashlib.sha1(body).hexdigest()}
            if name.endswith(".safetensors"):
                s["lfs"] = {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body), "pointerSize": 134}
            out.append(s)
        return out

    def serve(self, h, head: bool):
        path = unquote(urlparse(h.path).path)
        if path.startswith(f"/api/models/{self.repo}/tree/"):
            tree = [{"type": "file", "path": x["rfilename"], "size": x["size"], "oid": x["blobId"],
                     **({"lfs": {"oid": x["lfs"]["sha256"], "size": x["size"], "pointerSize": 134}} if "lfs" in x else {})}
                    for x in self.siblings()]
            return self.reply(h, 200, json.dumps(tree).encode(), {"Content-Type": "application/json"}, head)
        if path.startswith(f"/api/models/{self.repo}"):
            body = json.dumps({"id": self.repo, "modelId": self.repo, "sha": COMMIT, "private": False,
                               "siblings": self.siblings(), "tags": [], "downloads": 0, "likes": 0}).encode()
            return self.reply(h, 200, body, {"Content-Type": "application/json"}, head)
        prefix = f"/{self.repo}/resolve/"
        if path.startswith(prefix):
            _rev, _, name = path[len(prefix):].partition("/")
            body = self.files.get(name)
            if body is None:
                return self.reply(h, 404, b"not found", {"X-Error-Code": "EntryNotFound"}, head)
            etag = hashlib.sha256(body).hexdigest() if name.endswith(".safetensors") else hashlib.sha1(body).hexdigest()
            headers = {"ETag": f'"{etag}"', "X-Repo-Commit": COMMIT, "Accept-Ranges": "bytes"}
            if head:
                return self.reply(h, 200, body, headers, True)
            self.gets.append(name)
            body = self.served_override.get(name, body)
            start = 0
            rng = h.headers.get("Range")
            if rng:
                self.ranges.append((name, rng))
                start = int(rng.split("=")[1].split("-")[0])
            part = body[start:]
            code = 206 if rng else 200
            if rng:
                headers["Content-Range"] = f"bytes {start}-{len(body) - 1}/{len(body)}"
            h.send_response(code)
            for k, v in headers.items():
                h.send_header(k, v)
            h.send_header("Content-Length", str(len(part)))
            h.end_headers()
            try:
                for i in range(0, len(part), self.chunk):
                    h.wfile.write(part[i:i + self.chunk])
                    h.wfile.flush()
                    if len(part) > self.chunk * 4:
                        time.sleep(self.delay)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return None
        return self.reply(h, 404, b"{}", {"X-Error-Code": "RepoNotFound"}, head)

    @staticmethod
    def reply(h, code: int, body: bytes, headers: dict, head: bool):
        h.send_response(code)
        for k, v in headers.items():
            h.send_header(k, v)
        h.send_header("Content-Length", str(len(body)))
        h.end_headers()
        if not head:
            h.wfile.write(body)
