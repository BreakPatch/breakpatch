"""Fast or Visual, per page: whether the page's own structure can find things on it.

The rule the System 1 experiment recommends (its report, section 5.4): Visual when the page is a
Flutter web app (it draws everything itself and exposes no controls), when a <canvas> covers at
least a quarter of the viewport, or when fewer than 3 controls are listed; Fast otherwise. Judged
on locate tasks, it picked the better mode on 85.5% of the 132 test pages, against 80.9% for
always Fast. It misses canvas charts and maps drawn without one big <canvas> element.

On Flutter and canvas pages every DOM system found 0% of targets, and putting S0 in front of the
AI assistant there made it worse (38% against 62% on canvas pages), so Visual pages use the AI
assistant alone.
"""
from __future__ import annotations

from dataclasses import dataclass

from .extract import Extraction

FAST, VISUAL = "fast", "visual"
CANVAS_SHARE = 0.25       # a canvas over this share of the viewport makes the page Visual
MIN_CANDIDATES = 3        # fewer listed controls than this: Visual (an empty list isn't "not found")


@dataclass(frozen=True)
class Route:
    mode: str                 # FAST or VISUAL
    why: str                  # for the log: "flutter", "canvas 0.62", "2 candidates", "37 candidates"


def route(ex: Extraction) -> Route:
    if ex.flutter:
        return Route(VISUAL, "flutter")
    if ex.canvas_share >= CANVAS_SHARE:
        return Route(VISUAL, f"canvas {ex.canvas_share:.2f}")
    if ex.count < MIN_CANDIDATES:
        return Route(VISUAL, f"{ex.count} candidates")
    return Route(FAST, f"{ex.count} candidates")
