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
    while True:
        if same >= need:
            return last, True
        if time.monotonic() >= end:
            return last, False
        await asyncio.sleep(interval)
        cur = await shoot()
        if imaging.frames_equal(anchor, cur, ignore, threshold=config.SETTLE_THRESHOLD):
            same += 1
        else:
            anchor, same = cur, 1
        last = cur
