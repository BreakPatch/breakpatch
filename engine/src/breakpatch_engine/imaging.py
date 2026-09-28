"""Pixel maths for the automatic checks (spec §10.3, §11.1). Pure functions on RGB numpy arrays."""
from __future__ import annotations

import io
from typing import Iterable, Sequence

import cv2
import imagehash
import numpy as np
from PIL import Image

from .config import BOX_PAD, DIFF_THRESHOLD

Box = list[int]  # [x1, y1, x2, y2], x2/y2 exclusive, viewport px at DPR 1
BLANK = 128      # ignore zones are painted this grey before hashing or diffing


def to_array(data: bytes | Image.Image | np.ndarray) -> np.ndarray:
    if isinstance(data, np.ndarray):
        return data
    img = data if isinstance(data, Image.Image) else Image.open(io.BytesIO(data))
    return np.asarray(img.convert("RGB"))


def to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(arr)


def clamp_box(box: Sequence[float], width: int, height: int) -> Box:
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    return [max(0, min(width, x1)), max(0, min(height, y1)), max(0, min(width, x2)), max(0, min(height, y2))]


def box_around(point: Sequence[float], radius: int, width: int, height: int) -> Box:
    x, y = point
    return clamp_box([x - radius, y - radius, x + radius, y + radius], width, height)


def box_area(b: Sequence[int]) -> int:
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def blank(arr: np.ndarray, ignore: Iterable[Sequence[float]] | None) -> np.ndarray:
    if not ignore:
        return arr
    out = arr.copy()
    h, w = arr.shape[:2]
    for b in ignore:
        x1, y1, x2, y2 = clamp_box(b, w, h)
        out[y1:y2, x1:x2] = BLANK
    return out


def region_hash(arr: np.ndarray, box: Sequence[float], ignore: Iterable[Sequence[float]] | None = None) -> str:
    """64-bit perceptual hash (16 hex chars) of a region with ignore zones blanked."""
    h, w = arr.shape[:2]
    x1, y1, x2, y2 = clamp_box(box, w, h)
    if x2 <= x1 or y2 <= y1:
        return "0" * 16
    crop = blank(arr, ignore)[y1:y2, x1:x2]
    return str(imagehash.phash(Image.fromarray(crop)))


def distance(a: str, b: str) -> int:
    """Hamming distance between two hex hashes."""
    return int(imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b))


def change_mask(a: np.ndarray, b: np.ndarray, ignore: Iterable[Sequence[float]] | None = None,
                threshold: int = DIFF_THRESHOLD) -> np.ndarray:
    """Boolean HxW mask of pixels that differ noticeably, ignore zones excluded."""
    if a.shape != b.shape:
        return np.ones(a.shape[:2], dtype=bool)
    diff = cv2.absdiff(a, b).max(axis=2) > threshold
    if ignore:
        h, w = diff.shape
        for box in ignore:
            x1, y1, x2, y2 = clamp_box(box, w, h)
            diff[y1:y2, x1:x2] = False
    return diff


def frames_equal(a: np.ndarray, b: np.ndarray, ignore: Iterable[Sequence[float]] | None = None,
                 max_pixels: int = 0) -> bool:
    return int(change_mask(a, b, ignore).sum()) <= max_pixels


def region_changed(a: np.ndarray, b: np.ndarray, box: Sequence[float],
                   ignore: Iterable[Sequence[float]] | None = None, min_pixels: int = 4) -> bool:
    mask = change_mask(a, b, ignore)
    h, w = mask.shape
    x1, y1, x2, y2 = clamp_box(box, w, h)
    return int(mask[y1:y2, x1:x2].sum()) >= min_pixels


def looks_different(seen: np.ndarray, now: np.ndarray, box: Sequence[float], level: int = 40,
                    min_cells: int = 3) -> bool:
    """Whether a region changed between a live view frame (JPEG) and a screenshot (PNG). Both are
    shrunk 4 times first so JPEG noise on text edges doesn't count; a change needs `min_cells`
    4 x 4 cells that differ by more than `level` in some channel."""
    if seen.shape != now.shape:
        return True
    h, w = now.shape[:2]
    x1, y1, x2, y2 = clamp_box(box, w, h)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return False
    size = ((x2 - x1) // 4, (y2 - y1) // 4)
    a = cv2.resize(seen[y1:y2, x1:x2], size, interpolation=cv2.INTER_AREA).astype(np.int16)
    b = cv2.resize(now[y1:y2, x1:x2], size, interpolation=cv2.INTER_AREA).astype(np.int16)
    return int((np.abs(a - b).max(axis=2) > level).sum()) >= min_cells


def overlaps(a: Sequence[int], b: Sequence[int], gap: int = 0) -> bool:
    return not (a[2] + gap <= b[0] or b[2] + gap <= a[0] or a[3] + gap <= b[1] or b[3] + gap <= a[1])


def merge_boxes(boxes: Iterable[Sequence[int]], gap: int = 0) -> list[Box]:
    """Merge boxes that overlap (or come within `gap` px) until none do."""
    out = [list(map(int, b)) for b in boxes]
    changed = True
    while changed:
        changed = False
        merged: list[Box] = []
        for b in out:
            for m in merged:
                if overlaps(m, b, gap):
                    m[0], m[1], m[2], m[3] = min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3])
                    changed = True
                    break
            else:
                merged.append(list(b))
        out = merged
    return sorted(out, key=lambda b: (b[1], b[0]))


def union_box(boxes: Sequence[Sequence[int]]) -> Box | None:
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def mask_boxes(mask: np.ndarray, pad: int = BOX_PAD, min_pixels: int = 4, join: int = 8) -> list[Box]:
    """Changed areas as padded, merged boxes. Specks below `min_pixels` are dropped."""
    if int(mask.sum()) < min_pixels:
        return []
    h, w = mask.shape
    m = mask.astype(np.uint8)
    if join > 0:
        m = cv2.dilate(m, np.ones((join, join), np.uint8))
    count, lab = cv2.connectedComponents(m, connectivity=8)
    boxes = []
    for i in range(1, count):
        ys, xs = np.nonzero((lab == i) & mask)   # bounds of the real changes, not the dilation
        if len(xs) < min_pixels:
            continue
        boxes.append(clamp_box([xs.min() - pad, ys.min() - pad, xs.max() + 1 + pad, ys.max() + 1 + pad], w, h))
    return merge_boxes(boxes)


def blast_radius(before: np.ndarray, after: np.ndarray, ignore: Iterable[Sequence[float]] | None = None,
                 pad: int = BOX_PAD) -> Box | None:
    """Region that changed between two screens, excluding noise (spec §10.3.4)."""
    return union_box(mask_boxes(change_mask(before, after, ignore), pad=pad))


def changed_share(before: np.ndarray, after: np.ndarray, box: Sequence[float],
                  ignore: Iterable[Sequence[float]] | None = None) -> float:
    """Share (0-1) of a region's pixels that changed, ignore zones excluded."""
    mask = change_mask(before, after, ignore)
    h, w = mask.shape
    x1, y1, x2, y2 = clamp_box(box, w, h)
    area = (x2 - x1) * (y2 - y1)
    return float(mask[y1:y2, x1:x2].sum()) / area if area > 0 else 0.0


def noise_boxes(frames: Sequence[np.ndarray], pad: int = BOX_PAD) -> list[Box]:
    """Areas that changed by themselves across a series of frames (spec §10.3.1)."""
    if len(frames) < 2:
        return []
    acc = np.zeros(frames[0].shape[:2], dtype=bool)
    for a, b in zip(frames, frames[1:]):
        acc |= change_mask(a, b)
    return mask_boxes(acc, pad=pad, min_pixels=1)


def encode_jpeg(arr_or_img: np.ndarray | Image.Image, quality: int = 70) -> bytes:
    img = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(arr_or_img)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return buf.getvalue()
