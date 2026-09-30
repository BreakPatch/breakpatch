"""Writes tests/site/dom/reference_lists.json: the control list of every fixture state (states.csv),
as the engine's extractor gives it, boxes left out (they depend on the fonts).

    cd engine && .venv/bin/python tests/make_reference_lists.py

test_dom_extract.py compares every run against this file. Run it after a deliberate change to what
the extractor lists, and read the diff before committing it: for the experiment's own states
(fx01 to fx05) the lists are, name for name, the ones its harness extractor gave on its Mac, and a
change there moves away from what S0 was tuned on.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "src"))

import conftest  # noqa: E402,F401  (the test Chromium, when there is one)
import domsite  # noqa: E402
from breakpatch_engine.browser import BrowserSession  # noqa: E402
from breakpatch_engine.config import Timings  # noqa: E402
from breakpatch_engine.dom.extract import extract  # noqa: E402

OUT = domsite.DOM / "reference_lists.json"
NOTE = ("The fixture states' control lists (tests/make_reference_lists.py writes this file), boxes left "
        "out. fx01 to fx05 are the System 1 experiment's harness lists, name for name.")


async def lists() -> dict:
    base, stop = domsite.serve()
    b = BrowserSession(Timings.fast())
    out = {}
    try:
        await b.open("about:blank", domsite.VIEWPORT)
        for sid, state in domsite.states().items():
            await domsite.load_state(b.page, base, state)
            ex = await extract(b.page, (1440, 900))
            out[sid] = [{k: v for k, v in c.items() if k != "box"} for c in ex.candidates]
    finally:
        await b.close()
        stop()
    return out


def main() -> int:
    got = asyncio.run(lists())
    OUT.write_text(json.dumps({"note": NOTE, "lists": got}, ensure_ascii=False, indent=0) + "\n")
    print(f"wrote {OUT} ({len(got)} states)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
