"""A test from a user story (roadmap #10). Breakpatch Team: the planner plugs in through plugins.py
(`register_planner`); Community has none, so `record.plan` answers `not_ready`.

What's open here is the contract only: what a planner is given, what it answers and the checks on
that answer, which are the safety rules. The planning itself is the Team engine's.

- `record.plan` (engine/PROTOCOL.md "A test from a story") hands the planner the person's story,
  the names of the saved secrets they picked, the page as it is now (its screenshot, and the
  controls and short texts on screen from the fast locator's extraction) and its address.
- The planner answers a list of proposed steps. Nothing is done to the page: the app finds each
  step's target on the live page (`record.locate`, the fast locator first), shows it for Confirm,
  Try again, Skip or Edit, and records it with `record.point` like a clicked step. The result is
  an ordinary test that replays without the AI assistant.
- `clean` checks every step here, whatever the planner said: only actions a step can do, at most
  MAX_STEPS, typed text only when the person wrote it in the story or it's made unique per run
  (`{timestamp}`…), a saved secret only when the person picked it, and nothing but a saved secret
  typed into a password. A step that looks like it deletes, pays or sends something is marked
  `careful`, so the app always asks about it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from PIL import Image

from .locator import Locator

ACTIONS = ("click", "doubleClick", "rightClick", "hover", "write", "navigate", "scroll", "waitFor", "checkpoint")
# Actions that act on something on the page: they need what to look for.
NEEDS_TARGET = ("click", "doubleClick", "rightClick", "hover", "checkpoint")
GENERATED = ("uniqueName", "timeNow", "today", "repeatNumber")    # actions.resolve_text
DIRECTIONS = ("up", "down", "left", "right")

MAX_STEPS = 30            # a plan never has more steps than this
MAX_STORY = 2000          # characters of the story the planner reads
MAX_SECRETS = 20
MAX_TARGET = 200
MAX_TEXT = 500
MAX_NOTE = 300
MAX_WAIT_S = 60
TIMEOUT_S = 90.0          # a plan that takes longer is given up on (the model may still be busy a while)
PAGE_READ_S = 0.75        # the page read before planning never takes longer than this

SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
# Typed text with one of these is made unique per run (actions.substitute): a made-up test value.
TOKENS = re.compile(r"\{(?:i|time|date|timestamp)\}")
# A field that takes a password: only a saved secret is typed into it.
PASSWORD = re.compile(r"\b(password|passcode|passphrase|pin|contraseña|clave)\b", re.I)
# Steps that look destructive or costly: always asked about, never done without a person.
CAREFUL = re.compile(
    r"\b(delete|remove|erase|destroy|discard|wipe|pay|payment|purchase|buy|checkout|check out|place (?:the |my )?order|"
    r"order now|send|transfer|withdraw|unsubscribe|deactivate|close (?:my |the )?account|"
    r"cancel (?:my |the )?(?:account|subscription|plan|order)|eliminar|borrar|pagar|comprar|enviar)\b", re.I)


@dataclass
class Story:
    """One `record.plan` request, as the planner gets it."""
    text: str                              # the story or acceptance criteria, as the person wrote it
    secrets: list[str] = field(default_factory=list)   # saved secret names the person picked
    url: str | None = None                 # the page's address now
    viewport: tuple[int, int] = (0, 0)
    image: Image.Image | None = None       # the page now
    page: dict | None = None               # explain.page_record shape: {controls: [...], texts: [...]}


class Planner(Protocol):
    """Registered by the Team engine. `plan` answers `{steps: [...], note?}` (checked by `clean`)
    or None (it couldn't make a plan); it raises EngineError("not_ready", …) when it may not plan
    (no licence feature) or can't (no AI assistant)."""

    def plan(self, story: Story, locator_fn: Callable[[], Locator]) -> Awaitable[dict | None]: ...


def _words(v: Any, n: int) -> str | None:
    return " ".join(v.split())[:n] if isinstance(v, str) and v.strip() else None


def _fold(s: str) -> str:
    return " ".join(s.lower().replace("’", "'").replace("“", '"').replace("”", '"').split())


def written_in(text: str, story: str) -> bool:
    """The person wrote this text in the story (case and spaces aside), or it's made unique per run."""
    if TOKENS.search(text):
        return True
    t = _fold(text).strip("\"'")
    return bool(t) and t in _fold(story)


def careful(step: dict) -> bool:
    return any(isinstance(step.get(k), str) and CAREFUL.search(step[k]) for k in ("target", "url"))


def clean_step(raw: Any, story: Story) -> dict | None:
    """One proposed step as the protocol carries it, with the safety rules applied, or None."""
    if not isinstance(raw, dict) or raw.get("action") not in ACTIONS:
        return None
    action = raw["action"]
    out: dict = {"action": action}
    target = _words(raw.get("target"), MAX_TARGET)
    if target:
        out["target"] = target
    if action in NEEDS_TARGET and not target:
        return None
    if action == "write":
        secret, gen, text = raw.get("secretRef"), raw.get("generated"), raw.get("text")
        password = bool(target and PASSWORD.search(target))
        if isinstance(secret, str) and secret in story.secrets:
            out["secretRef"] = secret
        elif password:
            out["needs"] = "secret"                     # never typed text, never a made-up value
        elif isinstance(gen, str) and gen in GENERATED:
            out["generated"] = gen
        elif isinstance(text, str) and text.strip() and len(text) <= MAX_TEXT and written_in(text, story.text):
            out["text"] = text.strip()
        else:
            out["needs"] = "text"                       # the person says what to type
    elif action == "navigate":
        url = raw.get("url")
        if not isinstance(url, str) or not re.match(r"^https?://[^\s/]+", url.strip()) or len(url) > 2000:
            return None
        out["url"] = url.strip()
        out.pop("target", None)
    elif action == "scroll":
        out["direction"] = raw.get("direction") if raw.get("direction") in DIRECTIONS else "down"
    elif action == "waitFor":
        s = raw.get("seconds")
        if not isinstance(s, (int, float)) or isinstance(s, bool) or s <= 0:
            return None
        out["seconds"] = min(MAX_WAIT_S, max(1, round(s)))
        out.pop("target", None)
    if careful(out):
        out["careful"] = True
    return out


def clean(value: Any, story: Story) -> dict | None:
    """A planner's answer as `record.plan` returns it: `{steps, note?, dropped?}`, or None when it
    holds no step at all. `dropped` counts what the planner proposed that no step can do."""
    if not isinstance(value, dict) or not isinstance(value.get("steps"), list):
        return None
    steps, dropped = [], 0
    for raw in value["steps"]:
        s = clean_step(raw, story)
        if s is None:
            dropped += 1
        elif len(steps) < MAX_STEPS:
            steps.append(s)
        else:
            dropped += 1
    if not steps:
        return None
    out: dict = {"steps": steps}
    note = _words(value.get("note"), MAX_NOTE)
    if note:
        out["note"] = note
    if dropped:
        out["dropped"] = dropped
    return out


def secret_names(v: Any) -> list[str]:
    """`record.plan`'s `secrets`: the saved secret names the person picked (never their values)."""
    if not isinstance(v, list):
        return []
    return list(dict.fromkeys(n for n in v if isinstance(n, str) and SECRET_NAME.match(n)))[:MAX_SECRETS]
