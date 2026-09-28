"""AI assistant: finds a described element on a screenshot (spec §7, §10.2, §10.5, §11.2).

The model sits behind the `Locator` interface so tests can inject a fake one. `mlx-vlm` only
exists on Apple Silicon and is imported lazily on first use; nothing else in the engine needs it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import tempfile
import threading
from pathlib import Path
from typing import Protocol, Sequence

from PIL import Image

from .protocol import EngineError

log = logging.getLogger("breakpatch.locator")

LOCATE_PROMPT = ('Find "{desc}" in this screenshot of a web app. Reply with JSON only, no other text: '
                 '{{"bbox_2d": [x1, y1, x2, y2]}}. If it isn\'t in the screenshot, reply {{"bbox_2d": null}}.')
JUDGE_PROMPT = ('This is a screenshot of a web app just after a test step. The step should have done this: '
                '"{note}". Did it happen? Reply with JSON only, no other text: '
                '{{"happened": true, "why": "the dialog is gone"}}')
# No concrete example: the small model copied it ("Done button, bottom right of the Create Project
# dialog") for cards, photos and empty areas (DESK-02). Replies that still echo a template are unknown.
DESCRIBE_PROMPT = ('In this screenshot of a web app, look at the element at point [{x}, {y}] '
                   '(coordinates from 0 to 1000). Name it the way a tester would, from what it says or shows, '
                   'and say where it is. If there is nothing there you can name, reply {{"name": null}}. '
                   'Reply with JSON only, no other text: {{"name": "<its name>", "target": "<its name>, <where it is>"}}')
ECHOES = ("create project dialog", "<its name>", "<where it is>")


class Locator(Protocol):
    def available(self) -> bool: ...
    async def locate(self, image: Image.Image, description: str) -> list[int] | None: ...
    async def describe(self, image: Image.Image, at: Sequence[float]) -> dict | None: ...
    # Optional: reads a failed step's "What should happen" note against the screen after it.
    # {"happened": bool, "why": "it's still open"} or None. Only called when a check fails.
    async def judge(self, image: Image.Image, note: str) -> dict | None: ...


class NoLocator:
    """Used when no model is installed: locate is unavailable, describe returns nothing."""

    def available(self) -> bool:
        return False

    async def locate(self, image, description):
        raise EngineError("not_ready", "The AI assistant isn't downloaded yet. Finish setup to use it.")

    async def describe(self, image, at):
        return None

    async def judge(self, image, note):
        return None


def parse_bbox(text: str, width: int, height: int) -> list[int] | None:
    """Pull a `bbox_2d` out of the model's reply and map 0-1000 units to viewport pixels."""
    if not text:
        return None
    candidates = re.findall(r"\{[^{}]*\}|\[[^\[\]]*\]", text)
    for c in candidates:
        try:
            obj = json.loads(c)
        except ValueError:
            continue
        box = obj.get("bbox_2d") if isinstance(obj, dict) else obj
        if isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box):
            return map_box(box, width, height)
    m = re.search(r"bbox_2d\"?\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)", text)
    if m:
        return map_box([float(g) for g in m.groups()], width, height)
    return None


def map_box(box: Sequence[float], width: int, height: int) -> list[int] | None:
    x1, y1, x2, y2 = box
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    if x2 - x1 <= 0 or y2 - y1 <= 0 or x1 < 0 or y1 < 0 or x2 > 1000 or y2 > 1000:
        return None
    return [round(x1 * width / 1000), round(y1 * height / 1000), round(x2 * width / 1000), round(y2 * height / 1000)]


def parse_judge(text: str) -> dict | None:
    for c in re.findall(r"\{[^{}]*\}", text or ""):
        try:
            obj = json.loads(c)
        except ValueError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("happened"), bool):
            why = obj.get("why") if isinstance(obj.get("why"), str) else ""
            return {"happened": obj["happened"], "why": why.strip()[:200]}
    return None


def echoes(text: str) -> bool:
    """Whether a reply is the prompt's template, or the old prompt's example, and not a name."""
    t = " ".join(str(text).lower().replace("\u2019", "'").split())
    return any(e in t for e in ECHOES)


def parse_describe(text: str) -> dict | None:
    for c in re.findall(r"\{[^{}]*\}", text or ""):
        try:
            obj = json.loads(c)
        except ValueError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("name"), str) and obj["name"].strip():
            name = obj["name"].strip()[:80]
            target = obj.get("target") if isinstance(obj.get("target"), str) else name
            if echoes(name) or echoes(target):
                return None                              # the prompt's own words back: unknown
            return {"name": name, "target": target.strip()[:200] or name}
    return None


class MlxLocator:
    """Qwen3-VL through mlx-vlm, loaded on first use and kept in memory."""

    def __init__(self, model_path: Path, max_tokens: int = 96):
        self.model_path = Path(model_path)
        self.max_tokens = max_tokens
        self._model = None
        self._processor = None
        self._config = None
        self._lock = threading.Lock()

    @staticmethod
    def importable() -> bool:
        try:
            import importlib.util
            return importlib.util.find_spec("mlx_vlm") is not None
        except Exception:  # noqa: BLE001
            return False

    def available(self) -> bool:
        return self.model_path.exists() and self.importable()

    def _load(self) -> None:
        if self._model is not None:
            return
        try:
            from mlx_vlm import load  # type: ignore
            from mlx_vlm.utils import load_config  # type: ignore
        except Exception as e:  # noqa: BLE001
            raise EngineError("not_ready", "The AI assistant can't run on this Mac.", f"mlx_vlm import failed: {e}")
        from . import models
        try:
            # Again at every load: the folder could have changed since the download.
            models.check_model_dir(self.model_path)
        except models.Refused as e:
            raise EngineError("not_ready", "The AI assistant's files didn't check out. Remove it in Settings, "
                              "AI assistant, and download it again.", str(e)) from None
        log.info("loading model from %s", self.model_path)
        self._model, self._processor = load(str(self.model_path), trust_remote_code=False)
        try:
            self._config = load_config(str(self.model_path))
        except Exception:  # noqa: BLE001
            self._config = getattr(self._model, "config", None)

    def _generate(self, image: Image.Image, prompt: str) -> str:
        with self._lock:
            self._load()
            from mlx_vlm import generate  # type: ignore
            from mlx_vlm.prompt_utils import apply_chat_template  # type: ignore

            formatted = apply_chat_template(self._processor, self._config, prompt, num_images=1)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as f:
                image.convert("RGB").save(f.name)
                out = generate(self._model, self._processor, formatted, [f.name],
                               max_tokens=self.max_tokens, temperature=0.0, verbose=False)
            text = out if isinstance(out, str) else getattr(out, "text", str(out))
            log.info("model reply: %s", text[:300])
            return text

    async def locate(self, image: Image.Image, description: str) -> list[int] | None:
        desc = description.replace('"', "'").strip()
        text = await asyncio.to_thread(self._generate, image, LOCATE_PROMPT.format(desc=desc))
        return parse_bbox(text, image.width, image.height)

    async def judge(self, image: Image.Image, note: str) -> dict | None:
        text = await asyncio.to_thread(self._generate, image, JUDGE_PROMPT.format(note=note.replace('"', "'").strip()))
        return parse_judge(text)

    async def describe(self, image: Image.Image, at: Sequence[float]) -> dict | None:
        x = round(at[0] * 1000 / image.width)
        y = round(at[1] * 1000 / image.height)
        text = await asyncio.to_thread(self._generate, image, DESCRIBE_PROMPT.format(x=x, y=y))
        return parse_describe(text)
