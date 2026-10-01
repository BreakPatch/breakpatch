"""Screenshots for the exported report, as WebP data: URIs: the failed step's at full size (the
test's viewport width, at most FULL_WIDTH), every other one small (SMALL_WIDTH), so a 30-step run
stays around 5 MB at most. The app asks for them with `report.images` (engine/PROTOCOL.md "Export a
report"), breakpatch-ci calls `webp_data_uri` itself."""
from __future__ import annotations

import base64
import io
from pathlib import Path

FULL_WIDTH = 1600
SMALL_WIDTH = 480
QUALITY = {"full": 72, "small": 60}
MAX_ITEMS = 200


def webp_data_uri(path: str | Path, size: str = "full", viewport_width: int | None = None) -> dict:
    """`{ src, width, height, bytes }` for the picture at `path`. Raises OSError (or PIL's error)
    when it can't be read."""
    from PIL import Image

    with Image.open(path) as im:
        im.load()
        img = im.convert("RGB")
    limit = SMALL_WIDTH if size == "small" else min(FULL_WIDTH, viewport_width or FULL_WIDTH)
    if img.width > limit:
        img = img.resize((limit, max(1, round(img.height * limit / img.width))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=QUALITY.get(size, QUALITY["full"]), method=4)
    data = buf.getvalue()
    return {"src": "data:image/webp;base64," + base64.b64encode(data).decode("ascii"),
            "width": img.width, "height": img.height, "bytes": len(data)}


def size_for(step_run: dict) -> str:
    return "full" if step_run.get("result") == "failed" else "small"


def attach_images(test_input: dict, viewport_width: int | None = None) -> dict:
    """A copy of one test's report input with each screenshot of its run (`screenshotPath`) as `image`.
    A screenshot that can't be read is left out."""
    run = test_input.get("run")
    if not isinstance(run, dict):
        return test_input
    steps = []
    for r in run.get("steps") or []:
        path = r.get("screenshotPath") if isinstance(r, dict) else None
        if isinstance(path, str) and path:
            try:
                got = webp_data_uri(path, size_for(r), viewport_width)
                r = {**r, "image": {k: got[k] for k in ("src", "width", "height")}}
            except (OSError, ValueError):
                pass
        steps.append(r)
    return {**test_input, "run": {**run, "steps": steps}}
