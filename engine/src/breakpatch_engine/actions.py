"""Performs one step's action in the browser. Shared by recording and replay.

On a phone or tablet test (BrowserSession.touch) the same steps are touch input: a click is a tap,
a double click two taps, a long click a long press, and swipe, scroll and drag move a finger."""
from __future__ import annotations

import asyncio
import re
import datetime as dt
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

from . import imaging
from .browser import BrowserSession
from .config import Timings, check_tolerance
from .sites import origin_of, site_name

SAMPLES_DIR = Path(__file__).parent / "samples"
SAMPLE_KINDS = ("docx", "pdf", "jpeg", "mp4", "xlsx", "csv")
POINTER_ACTIONS = {"click", "doubleClick", "longClick", "rightClick", "hover", "swipe", "scroll", "drag"}
DIRECTIONS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


class ActionFailed(Exception):
    """The action itself couldn't happen. `reason` is a FailReason from app/src/data/types.ts."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


class SecretMissing(ActionFailed):
    def __init__(self, name: str, message: str | None = None):
        super().__init__("secretMissing", message or f"The saved secret {name} isn't on this Mac.")
        self.name = name


# ---------------------------------------------------------------- saved secrets and their sites

@dataclass(frozen=True)
class Secret:
    """A saved secret for one run or step: the value and the sites (origins) it may be typed on.
    The shell fills `origins` and `runner_can_use` from its Keychain index (engine/PROTOCOL.md)."""
    value: str
    origins: tuple[str, ...]
    runner_can_use: bool = False
    # Why the shell refused it for this request, in plain words (it then carries no value): a secret
    # on this Mac kept for other workspaces (engine/PROTOCOL.md "Saved secrets").
    refused: str | None = None

    def allows(self, origin: str | None) -> bool:
        return self.refused is None and origin is not None and origin in self.origins


def parse_secrets(raw, default_origin: str | None = None) -> dict[str, Secret]:
    """`{NAME: {value, origins, runnerCanUse?}}`, or a bare `{NAME: value}` from an older client,
    which counts as allowed on `default_origin` only (the test's start page). `{NAME: {refused}}`:
    the shell refused it for this request and says why; using it fails with that reason. Unreadable
    entries and null values are left out (the step then fails as a missing secret)."""
    out: dict[str, Secret] = {}
    if not isinstance(raw, Mapping):
        return out
    for name, v in raw.items():
        if isinstance(v, Secret):
            out[str(name)] = v
        elif isinstance(v, Mapping):
            if isinstance(v.get("refused"), str) and v["refused"].strip():
                out[str(name)] = Secret("", (), False, v["refused"].strip()[:300])
                continue
            if v.get("value") is None:
                continue
            origins = tuple(o for o in (origin_of(x) for x in (v.get("origins") or []) if isinstance(x, str)) if o)
            out[str(name)] = Secret(str(v["value"]), origins, bool(v.get("runnerCanUse")))
        elif v is not None and not isinstance(v, (list, dict)):
            out[str(name)] = Secret(str(v), (default_origin,) if default_origin else ())
    return out


def not_allowed(name: str, origin: str | None) -> SecretMissing:
    return SecretMissing(name, f"{name} isn't allowed on {site_name(origin)}.")


def secret_for(name: str, ctx: "Context") -> Secret:
    s = ctx.secrets.get(name)
    if not isinstance(s, Secret):
        raise SecretMissing(name)
    if s.refused:
        raise SecretMissing(name, s.refused)
    return s


@dataclass
class Context:
    timings: Timings
    secrets: dict[str, Secret] = field(default_factory=dict)
    i: int = 1                                  # 1-based repeat number of the innermost loop
    stop: asyncio.Event | None = None
    download_mark: int = 0                      # downloads before this index are already accounted for
    relaxed: bool = False                       # screen checks allow for another system (systems.py)
    files_dir: str | None = None                # <tests folder>/files, for uploads of the user's own files
    # Values Call steps kept from their replies (`keep`), by name: (value, the call's origin). Typed
    # by a Write step's `valueRef`, only on the app's pages; never logged or sent to the app.
    values: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    app_url: str | None = None                  # the app's base address: where a kept value may be typed

    def __post_init__(self):
        # Bare values (in-process callers) become Secrets allowed nowhere: typing them fails plainly.
        if any(not isinstance(v, Secret) for v in self.secrets.values()):
            self.secrets = parse_secrets(self.secrets)


FILE_REF = re.compile(r"^files/[^/\\]+$")


def upload_path(step: dict, ctx: "Context") -> Path:
    """The file an upload step chooses: one of the user's own (`file: "files/<name>"`, in the tests
    folder), else a bundled sample. Only a plain name inside files/ is accepted."""
    ref = step.get("file")
    if not ref:
        return sample_path(step.get("sample") or "pdf")
    name = str(ref)
    if not FILE_REF.match(name) or name.endswith(("/..", "/.")) or "/../" in name:
        raise ActionFailed("fileMissing", f"{name} isn't a file in the tests folder.")
    path = Path(ctx.files_dir or "") / name.split("/", 1)[1] if ctx.files_dir else None
    if path is None or not path.is_file():
        raise ActionFailed("fileMissing", f"{name} isn't in the tests folder.")
    return path


def sample_path(kind: str) -> Path:
    if kind not in SAMPLE_KINDS:
        raise ActionFailed("targetNotFound", f"There's no sample file of type {kind}.")
    return SAMPLES_DIR / f"sample.{kind}"


def substitute(text: str, i: int, now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now()
    return (text.replace("{i}", str(i)).replace("{time}", now.strftime("%H:%M"))
            .replace("{date}", now.strftime("%Y-%m-%d")).replace("{timestamp}", now.strftime("%Y%m%d%H%M%S")))


def resolve_text(step: dict, ctx: Context, now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now()
    if step.get("secretRef"):
        return secret_for(step["secretRef"], ctx).value
    gen = step.get("generated")
    if gen == "uniqueName":
        return f"BP {now.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}"
    if gen == "timeNow":
        return now.strftime("%H:%M")
    if gen == "today":
        return now.strftime("%Y-%m-%d")
    if gen == "repeatNumber":
        return str(ctx.i)
    return substitute(step.get("text") or "", ctx.i, now)


def secret_refs(steps: Sequence[dict]) -> list[tuple[dict, str]]:
    """Every saved secret the steps use, with its step: a Write step's, and a Call step's headers'."""
    out = []
    for s in steps:
        if s.get("action") == "write" and s.get("secretRef"):
            out.append((s, s["secretRef"]))
        if s.get("action") == "call" and isinstance(s.get("call"), dict):
            out.extend((s, str(h["secretRef"])) for h in (s["call"].get("headers") or [])
                       if isinstance(h, dict) and h.get("secretRef"))
        out.extend(secret_refs(s.get("steps") or []))
    return out


def swipe_end(frm: Sequence[float], direction: str, distance: float) -> tuple[float, float]:
    dx, dy = DIRECTIONS.get(direction or "down", (0, 1))
    return frm[0] + dx * distance, frm[1] + dy * distance


async def interruptible_sleep(seconds: float, stop: asyncio.Event | None) -> bool:
    """Sleep; returns False if stopped early."""
    if stop is None:
        await asyncio.sleep(seconds)
        return True
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
        return False
    except asyncio.TimeoutError:
        return True


async def perform(b: BrowserSession, step: dict, ctx: Context, at: Sequence[float] | None = None,
                  frm: Sequence[float] | None = None) -> None:
    """Do the step's action. `at`/`frm` override the stored points (used by healing)."""
    a = step.get("action")
    at = at if at is not None else step.get("at")
    frm = frm if frm is not None else (step.get("from") or at)
    t = ctx.timings
    if a in POINTER_ACTIONS and a not in ("drag", "swipe", "scroll") and at is None:
        raise ActionFailed("targetNotFound", "This step has no position to act on.")

    if a == "click":
        await b.click(at)
    elif a == "doubleClick":
        await b.click(at, count=2)
    elif a == "rightClick":
        await b.click(at, button="right")
    elif a == "longClick":
        await b.click(at, hold=t.long_click)
    elif a == "hover":
        await b.move(at)
    elif a == "drag":
        to = step.get("to")
        if frm is None or to is None:
            raise ActionFailed("targetNotFound", "This drag has no start or end point.")
        await b.drag(frm, to)
    elif a == "swipe":
        if frm is None:
            raise ActionFailed("targetNotFound", "This swipe has no start point.")
        await b.drag(frm, swipe_end(frm, step.get("direction") or "left", float(step.get("distance") or 300)))
    elif a == "scroll":
        dx, dy = DIRECTIONS.get(step.get("direction") or "down", (0, 1))
        dist = float(step.get("distance") or 300)
        await b.scroll(frm, dx * dist, dy * dist)
    elif a == "write" and step.get("secretRef"):
        await write_secret(b, step["secretRef"], ctx, at)
    elif a == "write" and step.get("valueRef"):
        await write_value(b, str(step["valueRef"]), ctx, at)
    elif a == "write":
        text = resolve_text(step, ctx)
        if at is not None:
            await b.click(at)
        await b.type_text(text)
    elif a == "waitFor":
        if not await interruptible_sleep((step.get("durationMs") or 1000) / 1000, ctx.stop):
            raise ActionFailed("stopped", "The run was stopped.")
    elif a == "waitUntil":
        await wait_until(b, step, ctx)
    elif a == "navigate":
        nav = step.get("nav") or ("url" if step.get("url") else "reload")
        url = substitute(step["url"], ctx.i) if step.get("url") else None
        try:
            await b.navigate(nav, url)
        except Exception as e:  # noqa: BLE001
            raise ActionFailed("timeout", getattr(e, "message", None) or "The page didn't load.") from e
    elif a == "switchTab":
        if not await b.switch_tab(t.popup_timeout):
            raise ActionFailed("timeout", "No new tab or popup opened.")
    elif a == "upload":
        if at is None:
            raise ActionFailed("targetNotFound", "This upload has no position to click.")
        if not await b.upload(at, upload_path(step, ctx)):
            raise ActionFailed("timeout", "Clicking there didn't open a file picker.")
    elif a == "downloadCheck":
        await download_check(b, step, ctx, at)
    elif a in ("checkpoint", "loop", "group", "call"):
        pass  # handled by the caller
    else:
        raise ActionFailed("unexpectedScreen", f"The engine doesn't know the action {a!r}.")


async def write_secret(b: BrowserSession, name: str, ctx: Context, at: Sequence[float] | None) -> None:
    """Types a saved secret, only into a page (and frame) on one of its sites. The site is checked
    after the click, just before typing, and again before every key: a redirect, a popup or a frame
    from another site never gets it."""
    secret = secret_for(name, ctx)
    if not secret.origins:
        raise not_allowed(name, origin_of(b.url))
    if at is not None:
        await b.click(at)
    blocked = await b.type_guarded(secret.value, secret.allows)
    if blocked is not None:
        raise not_allowed(name, blocked or None)


def value_allowed(origin: str | None, ctx: Context, call_origin: str | None) -> bool:
    """Where a kept value may be typed: a page of the app (its host, or one under the same domain,
    as calls may reach), or the site of the call it came from."""
    from .calls import host_allowed
    from urllib.parse import urlsplit
    if origin is None:
        return False
    if call_origin is not None and origin == call_origin:
        return True
    app = origin_of(ctx.app_url)
    if app is None:
        return False
    a, o = urlsplit(app), urlsplit(origin)
    if a.scheme != o.scheme and not (a.scheme == "http" and o.scheme == "https"):
        return False
    return host_allowed(o.hostname or "", a.hostname or "")


async def write_value(b: BrowserSession, name: str, ctx: Context, at: Sequence[float] | None) -> None:
    """Types a value a Call step kept from its reply, only into the app's pages (checked like a
    saved secret: after the click and before every key)."""
    got = ctx.values.get(name)
    if got is None:
        raise ActionFailed("callFailed", f"No Call step before this one kept a value named {name}.")
    value, call_origin = got
    if at is not None:
        await b.click(at)
    blocked = await b.type_guarded(value, lambda o: value_allowed(o, ctx, call_origin))
    if blocked is not None:
        raise ActionFailed("callFailed", f"The value {name} is only typed into the app's own pages, "
                                         f"not {site_name(blocked or None)}.")


async def wait_until(b: BrowserSession, step: dict, ctx: Context) -> None:
    region, want = step.get("region"), step.get("hash")
    if not region or not want:
        raise ActionFailed("unexpectedScreen", "This wait has no area to watch.")
    tol = check_tolerance(step.get("tolerance") if step.get("tolerance") is not None else 8, ctx.relaxed)
    end = time.monotonic() + (step.get("timeoutMs") or 10000) / 1000
    ignore = step.get("ignore") or []
    while True:
        arr = await b.shoot()
        if imaging.region_distance(arr, region, want, ignore, ctx.relaxed) <= tol:
            return
        if time.monotonic() >= end:
            raise ActionFailed("timeout", "The area didn't appear in time.")
        if not await interruptible_sleep(ctx.timings.pre_interval, ctx.stop):
            raise ActionFailed("stopped", "The run was stopped.")


async def download_check(b: BrowserSession, step: dict, ctx: Context, at: Sequence[float] | None) -> None:
    if at is not None:
        await b.click(at)
    timeout = (step.get("timeoutMs") or ctx.timings.download_timeout * 1000) / 1000
    d = await b.wait_download(ctx.download_mark, timeout)
    if d is None:
        raise ActionFailed("timeout", "No file was downloaded.")
    ctx.download_mark = len(b.downloads)
    want = (step.get("fileType") or "").lower().lstrip(".")
    if want:
        ext = Path(d.filename).suffix.lower().lstrip(".")
        aliases = {"jpg": "jpeg", "jpeg": "jpeg", "htm": "html"}
        if aliases.get(ext, ext) != aliases.get(want, want) and not want.endswith("/" + ext):
            raise ActionFailed("unexpectedScreen", f"The downloaded file is a .{ext or '?'} file, not .{want}.")
    if step.get("minBytes") and d.size < int(step["minBytes"]):
        raise ActionFailed("unexpectedScreen", f"The downloaded file is smaller than expected ({d.size} bytes).")
