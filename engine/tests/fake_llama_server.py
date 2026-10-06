"""A stand-in for llama.cpp's `llama-server`, for the engine's LlamaServer tests (plan P2.2).

Takes the same command line the engine gives the real one, serves `/health` and
`/v1/chat/completions` on 127.0.0.1, and checks the API key from `--api-key-file`. Nothing is
loaded: what it does comes from `<model>.fake.json`, read again for every request, so a test can
change it while the server runs:

    {"reply": "text",          the answer's content (default: a box)
     "raw": "body",            send this body instead of a JSON reply (a garbled answer)
     "status": 200,            the chat reply's HTTP status
     "delay": 0,               seconds before answering a chat request
     "load_s": 0,              seconds of 503 "Loading model" on /health after starting
     "crash_on_chat": false,   exit at once, without answering, on a chat request
     "crash_starts": [1],      ... only in these starts (1-based); default: every start
     "exit_at_start": null}    exit with this code before listening (a model that won't load)

It appends one JSON line per start to `<model>.starts.jsonl` (argv, the key's file mode) and per
chat request to `<model>.requests.jsonl` (headers and body).
"""
import json
import os
import stat
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def arg(name, default=None):
    a = sys.argv[1:]
    return a[a.index(name) + 1] if name in a else default


MODEL = Path(arg("-m"))
PORT = int(arg("--port"))
KEY_FILE = Path(arg("--api-key-file"))
KEY = KEY_FILE.read_text().strip()
STARTED = time.monotonic()


def conf() -> dict:
    try:
        return json.loads(MODEL.with_suffix(".fake.json").read_text())
    except (OSError, ValueError):
        return {}


def append(suffix: str, obj: dict) -> None:
    with open(MODEL.with_suffix(suffix), "a") as f:
        f.write(json.dumps(obj) + "\n")


def start_number() -> int:
    try:
        return len(MODEL.with_suffix(".starts.jsonl").read_text().splitlines())
    except OSError:
        return 0


append(".starts.jsonl", {"argv": sys.argv[1:], "keyMode": stat.S_IMODE(os.stat(KEY_FILE).st_mode), "pid": os.getpid(), "key": KEY,
                         "env": sorted(os.environ)})
START = start_number()
print(f"fake llama-server start {START} on port {PORT}", flush=True)
if conf().get("exit_at_start") is not None:
    print("error: failed to load model", flush=True)
    sys.exit(int(conf()["exit_at_start"]))


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code: int, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            if time.monotonic() - STARTED < float(conf().get("load_s") or 0):
                return self.send(503, b'{"error": {"code": 503, "message": "Loading model"}}')
            return self.send(200, b'{"status": "ok"}')
        self.send(404, b"{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        if self.path != "/v1/chat/completions":
            return self.send(404, b"{}")
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self.send(401, b'{"error": {"code": 401, "message": "Invalid API Key"}}')
        c = conf()
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        append(".requests.jsonl", {"headers": dict(self.headers), "body": body, "start": START})
        if c.get("crash_on_chat") and START in c.get("crash_starts", [START]):
            os._exit(3)
        time.sleep(float(c.get("delay") or 0))
        if "raw" in c:
            return self.send(int(c.get("status") or 200), c["raw"].encode())
        reply = c.get("reply", '{"bbox_2d": [100, 500, 300, 560]}')
        doc = {"choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 1081, "completion_tokens": 21},
               "timings": {"prompt_n": 1081, "prompt_ms": 812.5, "predicted_n": 21, "predicted_ms": 230.1}}
        self.send(int(c.get("status") or 200), json.dumps(doc).encode())


srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
srv.daemon_threads = True
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
