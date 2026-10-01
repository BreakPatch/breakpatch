"""JSON Lines over stdio (see engine/PROTOCOL.md).

Requests run as independent tasks, so a long download or run never blocks `run.stop` or
`setup.pause`. Exactly one response is written per request id; events can be written at any
time. Only protocol lines go to stdout; logs and stray prints go to stderr.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import traceback
from typing import Any, Awaitable, BinaryIO, Callable

log = logging.getLogger("breakpatch.protocol")

ERROR_CODES = {"bad_request", "not_ready", "not_found", "busy", "stale", "unchecked", "network", "stopped", "internal"}


class EngineError(Exception):
    """An error the UI can show: `message` is a plain sentence, `details` goes behind "Copy details"."""

    def __init__(self, code: str, message: str, details: str | None = None):
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "internal"
        self.message = message
        self.details = details

    def to_json(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.details:
            out["details"] = self.details
        return out


Handler = Callable[[dict], Awaitable[Any]]

NULL = object()  # return this from a handler for a `"result": null` response (None means `{}`)


class Writer:
    """Thread-safe line writer. Keeps its own handle on the real stdout."""

    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()

    def write(self, obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
        with self._lock:
            try:
                self._stream.write(line)
                self._stream.flush()
            except (BrokenPipeError, ValueError):
                pass


def claim_stdout() -> BinaryIO:
    """Take stdout for the protocol and point fd 1 at stderr, so nothing else can corrupt the stream
    (child processes such as the Playwright driver inherit fd 1)."""
    out = os.fdopen(os.dup(1), "wb", buffering=0)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return out


LIMIT = 64 * 1024 * 1024   # a line can hold a screenshot


async def open_reader(stream: BinaryIO) -> asyncio.StreamReader:
    """An asyncio reader over stdin. On Windows the shell's stdin is an anonymous pipe, which the
    Proactor loop can't read without overlapped I/O, so a thread reads it there (and anywhere
    `connect_read_pipe` refuses the stream)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=LIMIT)
    if sys.platform != "win32":
        try:
            await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), stream)
            return reader
        except (NotImplementedError, OSError, ValueError) as e:
            log.info("stdin can't be read asynchronously (%s); reading it in a thread", e)

    def pump() -> None:
        try:
            while True:
                chunk = stream.readline()
                if not chunk:
                    break
                loop.call_soon_threadsafe(reader.feed_data, chunk)
        except (OSError, ValueError):
            pass
        finally:
            try:
                loop.call_soon_threadsafe(reader.feed_eof)
            except RuntimeError:        # the loop is closed: nobody is reading any more
                pass

    threading.Thread(target=pump, name="stdin", daemon=True).start()
    return reader


class Server:
    def __init__(self, handlers: dict[str, Handler], writer: Writer, grace: float = 3.0):
        # `engine.quit` (the shell's way to stop the engine where it can't send a signal or close
        # stdin, i.e. Windows): answers {}, then stops as when stdin closes.
        self.handlers = {"engine.quit": self._quit_handler, **handlers}
        self.grace = grace
        self.writer = writer
        self._tasks: set[asyncio.Task] = set()
        self._quit: asyncio.Event | None = None

    async def _quit_handler(self, params: dict) -> None:
        self.quit()
        return None

    def quit(self) -> None:
        """Stop reading requests; in-flight ones get the same grace as when stdin closes."""
        if self._quit is None:
            self._quit = asyncio.Event()
        self._quit.set()

    def emit(self, event: str, data: dict) -> None:
        self.writer.write({"event": event, "data": data})

    async def handle_line(self, raw: bytes) -> None:
        raw = raw.strip()
        if not raw:
            return
        try:
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                raise ValueError("not an object")
        except ValueError as e:
            self.writer.write({"id": None, "error": EngineError(
                "bad_request", "The engine received a message it couldn't read.", f"{e}: {raw[:200]!r}").to_json()})
            return
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        handler = self.handlers.get(method) if isinstance(method, str) else None
        if handler is None:
            self.writer.write({"id": rid, "error": EngineError(
                "bad_request", "The engine doesn't know how to do that.", f"Unknown method: {method!r}").to_json()})
            return
        if not isinstance(params, dict):
            self.writer.write({"id": rid, "error": EngineError(
                "bad_request", "The engine received a request it couldn't read.", "params must be an object").to_json()})
            return
        task = asyncio.create_task(self._run(rid, method, handler, params))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, rid: Any, method: str, handler: Handler, params: dict) -> None:
        try:
            result = await handler(params)
            self.writer.write({"id": rid, "result": None if result is NULL else {} if result is None else result})
        except EngineError as e:
            log.info("%s failed: %s (%s)", method, e.message, e.details or "")
            self.writer.write({"id": rid, "error": e.to_json()})
        except asyncio.CancelledError:
            self.writer.write({"id": rid, "error": EngineError("stopped", "The engine is shutting down.").to_json()})
            raise
        except Exception as e:  # noqa: BLE001 - every failure must still produce a response
            log.exception("%s crashed", method)
            self.writer.write({"id": rid, "error": EngineError(
                "internal", "Something went wrong in the engine.",
                f"{type(e).__name__}: {e}\n{traceback.format_exc()}").to_json()})

    async def serve(self, stdin: BinaryIO | None = None) -> None:
        reader = await open_reader(stdin or sys.stdin.buffer)
        if self._quit is None:
            self._quit = asyncio.Event()
        quitting = asyncio.ensure_future(self._quit.wait())
        try:
            while not self._quit.is_set():
                read = asyncio.ensure_future(reader.readline())
                await asyncio.wait({read, quitting}, return_when=asyncio.FIRST_COMPLETED)
                if not read.done():
                    read.cancel()
                    break
                line = read.result()
                if not line:
                    break
                await self.handle_line(line)
        finally:
            quitting.cancel()
        # stdin closed: the shell went away. Give quick in-flight requests a moment to answer, then
        # cancel the rest (long runs and downloads) so the process can exit.
        if self._tasks:
            await asyncio.wait(list(self._tasks), timeout=self.grace)
        for t in list(self._tasks):
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
