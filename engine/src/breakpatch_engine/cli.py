"""Command line: `serve` (the sidecar) and `info`.

The headless CI runner (spec §15) is part of Breakpatch Team: `breakpatch-ci run --test …`
from the `breakpatch_team_engine` package (docs/editions.md).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys

from . import __version__

EXIT_USAGE = 2


def _logging() -> None:
    logging.basicConfig(stream=sys.stderr, level=os.environ.get("BP_LOG", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="breakpatch-engine", description="Breakpatch engine")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("serve", help="JSON Lines over stdio for the desktop app (engine/PROTOCOL.md)")
    sub.add_parser("info", help="print this machine's details as JSON")

    d = sub.add_parser("_download")  # internal: the pausable model download child process
    d.add_argument("--repo", required=True)
    d.add_argument("--revision", default="main")
    d.add_argument("--dir", required=True)
    d.add_argument("--files", default="{}")     # the allowlist from models.py: name -> SHA-256

    raw = sys.argv[1:] if argv is None else argv
    if raw[:1] == ["run"]:
        print("The CI command line is part of Breakpatch Team: install breakpatch-team-engine and use "
              "`breakpatch-ci run --test FILE`.", file=sys.stderr)
        return EXIT_USAGE
    args = ap.parse_args(argv)
    if args.cmd in (None, "serve"):
        return serve()
    _logging()
    if args.cmd == "info":
        from .install import system_info
        print(json.dumps(system_info(), indent=2))
        return 0
    if args.cmd == "_download":
        from .install import download_main
        return download_main(args.repo, args.revision, args.dir, args.files)
    ap.print_help()
    return EXIT_USAGE


def serve() -> int:
    from .protocol import Server, Writer, claim_stdout
    from .service import Engine

    out = claim_stdout()
    _logging()
    logging.getLogger("breakpatch").info("engine %s ready", __version__)
    writer = Writer(out)
    holder: dict = {}
    engine = Engine(lambda ev, data: holder["server"].emit(ev, data))
    server = Server(engine.handlers(), writer)
    holder["server"] = server

    async def go():
        # SIGTERM (and SIGINT) from the shell: stop serving, close Chromium, exit 0.
        loop = asyncio.get_running_loop()
        main_task = asyncio.current_task()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, main_task.cancel)
            except (NotImplementedError, RuntimeError):
                pass
        try:
            await server.serve()
        except asyncio.CancelledError:
            logging.getLogger("breakpatch").info("stopping")
        finally:
            await asyncio.shield(engine.shutdown())

    try:
        asyncio.run(go())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    return 0
