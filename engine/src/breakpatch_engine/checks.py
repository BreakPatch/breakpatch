"""Time-based checks built on imaging: noise watch and settle detection.

`shoot` is any async callable returning an RGB numpy array, so these run against the live
browser or against synthetic frames in tests.
"""
from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Sequence

import numpy as np

from . import config, imaging

Shoot = Callable[[], Awaitable[np.ndarray]]


async def watch_noise(shoot: Shoot, duration: float, interval: float) -> tuple[list[imaging.Box], np.ndarray]:
    """Watch the screen for `duration` seconds. Returns (ignore zones, last frame)."""
    frames = [await shoot()]
    end = time.monotonic() + duration
    while time.monotonic() < end:
        await asyncio.sleep(interval)
        frames.append(await shoot())
    return imaging.noise_boxes(frames), frames[-1]


async def settle(shoot: Shoot, ignore: Sequence[Sequence[float]] | None, interval: float,
                 frames: int, timeout: float) -> tuple[np.ndarray, bool]:
    """Wait until `frames` consecutive frames are identical outside the ignore zones.

    Returns (last frame, settled). On timeout the last frame is returned with settled=False.
    """
    need = max(2, frames)
    last = await shoot()
    # Each new frame is compared with the first frame of the still run, not only the one before
    # it: a slow fade or crossfade changes each 150 ms by less than the "changed" threshold, so
    # frame-to-frame it looked settled half way through, and the next step paid for the rest.
    anchor = last
    same = 1
    end = time.monotonic() + timeout
    # A small area that keeps changing in the same place (a caret a canvas app draws itself, which
    # caret-color can't hide; a spinner) never lets a page look still. Once it has changed on its
    # own a few times in a row it's left out of this wait (DESK-06). Only for settling: the checks
    # themselves still compare it, and a one-off change anywhere still restarts the wait.
    blinker: list[int] | None = None
    spot: list[int] | None = None
    runs = 0
    while True:
        if same >= need:
            return last, True
        if time.monotonic() >= end:
            return last, False
        await asyncio.sleep(interval)
        cur = await shoot()
        zones = list(ignore or []) + ([blinker] if blinker else [])
        if imaging.frames_equal(anchor, cur, zones, threshold=config.SETTLE_THRESHOLD):
            same += 1
        else:
            boxes = imaging.mask_boxes(imaging.change_mask(anchor, cur, zones, config.SETTLE_THRESHOLD), pad=4, min_pixels=1)
            box = imaging.union_box(boxes)
            small = box is not None and imaging.box_area(box) <= config.BLINK_MAX_AREA
            if small and (spot is None or imaging.overlaps(spot, box, 8)):
                spot = box if spot is None else imaging.union_box([spot, box])
                runs += 1
                if runs >= 3 and imaging.box_area(spot) <= config.BLINK_MAX_AREA:
                    blinker, spot, runs = spot, None, 0
            else:
                spot, runs = None, 0
            anchor, same = cur, 1
        last = cur
