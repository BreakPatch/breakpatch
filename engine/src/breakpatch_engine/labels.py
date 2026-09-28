"""Plain-language step labels and target suggestions (mirrors app/src/engine/labels.ts)."""
from __future__ import annotations

from typing import Sequence

VERBS = {
    "click": "Click", "doubleClick": "Double click", "longClick": "Long click", "rightClick": "Right click",
    "hover": "Hover over", "swipe": "Swipe", "scroll": "Scroll", "drag": "Drag", "write": "Write",
    "waitUntil": "Wait until", "waitFor": "Wait", "navigate": "Go to", "switchTab": "Switch to",
    "upload": "Upload", "downloadCheck": "Check download", "checkpoint": "Check", "loop": "Repeat",
    "group": "Shared steps",
}
SAMPLES = {"docx": "Word document", "pdf": "PDF", "jpeg": "JPEG image", "mp4": "MP4 video",
           "xlsx": "Excel sheet", "csv": "CSV file"}
GENERATED = {"uniqueName": "a unique name", "timeNow": "the time now", "today": "today's date",
             "repeatNumber": "the repeat number"}


def default_label(action: str, p: dict, name: str | None = None) -> str:
    verb = VERBS.get(action, action)
    if action == "write":
        if p.get("secretRef"):
            return f"Write saved secret {p['secretRef']}"
        if p.get("generated"):
            return f"Write {GENERATED.get(p['generated'], p['generated'])}"
        return f'Write "{p.get("text") or ""}"'
    if action == "waitFor":
        return f"Wait {max(1, round((p.get('durationMs') or 1000) / 1000))} seconds"
    if action == "navigate":
        nav = p.get("nav") or "url"
        return {"reload": "Reload the page", "back": "Go back", "forward": "Go forward"}.get(
            nav, f"Go to {p.get('url') or 'address'}")
    if action == "upload":
        return f"Upload {SAMPLES.get(p.get('sample') or '', 'a file')}"
    if action == "loop":
        return f"Repeat {p.get('count') or 2} times"
    if action in ("scroll", "swipe"):
        return f"{verb} {p.get('direction') or 'down'}"
    if action == "switchTab":
        return "Switch to the new tab"
    if action == "downloadCheck":
        return f"Check a {p['fileType']} file was downloaded" if p.get("fileType") else "Check a file was downloaded"
    if action == "waitUntil":
        return "Wait until the area looks right"
    if action == "checkpoint":
        return "Check something is visible"
    if name:
        return f"{verb} {name}"
    # Nothing to name it by (no name in the page, the AI assistant unsure): say so plainly.
    return f"{verb} the spot you clicked" if action in ("click", "doubleClick", "longClick", "rightClick") else f"{verb} here"


def where(at: Sequence[float], width: int, height: int) -> str:
    """"top left", "middle", "bottom right"... of the page."""
    col = "left" if at[0] < width / 3 else "right" if at[0] > 2 * width / 3 else ""
    row = "top" if at[1] < height / 3 else "bottom" if at[1] > 2 * height / 3 else ""
    if not row and not col:
        return "the middle of the page"
    if not row:
        return f"the {col} side of the page"
    if not col:
        return f"the {row} of the page"
    return f"the {row} {col} of the page"


def spot_target(at: Sequence[float], width: int, height: int) -> str:
    return f"The spot you clicked, near {where(at, width, height)}"
