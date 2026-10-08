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
- `clean` checks every step here, whatever the planner said: only actions a step can do (on a
  phone or tablet, no hover or right click), at most MAX_STEPS, typed text only when the person
  wrote it in the story (a run-time value like `{i}` may only end it, or be in a short made-up name
  or a made-up email address at a test domain), a saved secret only when the person picked it,
  nothing but a saved secret typed into a password, and "Go to" only to the page's own site or an
  address the story names. A step that looks like it deletes, pays or sends something is marked
  `careful`, so the app always asks about it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol
from urllib.parse import urlsplit

from PIL import Image

from .locator import Locator

ACTIONS = ("click", "doubleClick", "rightClick", "hover", "write", "navigate", "scroll", "waitFor", "checkpoint")
# Actions that act on something on the page: they need what to look for.
NEEDS_TARGET = ("click", "doubleClick", "rightClick", "hover", "checkpoint")
# Need a mouse: never proposed for a phone or tablet test (the app's TOUCH_HIDDEN).
MOUSE_ONLY = ("hover", "rightClick")
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
# Filled in at run time (actions.substitute): {timestamp} to the second, {i} the repeat number,
# {time} HH:MM, {date} YYYY-MM-DD. Only {timestamp} differs on every run.
TOKENS = re.compile(r"\{(?:i|time|date|timestamp)\}")
# Text that ends in those (with separators): "Ada Lovelace {i}", "Test project {time}".
TOKEN_SUFFIX = re.compile(r"(?P<base>.*?)(?P<tokens>(?:[\s_.:#/-]*\{(?:i|time|date|timestamp)\})+)", re.S)
# A made-up name for a test value: one to three words of letters, nothing else.
NAME_SHAPE = re.compile(r"[^\W\d_]{1,20}(?:[ '-][^\W\d_]{1,20}){0,2}")
EMAIL_LOCAL = re.compile(r"[a-z0-9][a-z0-9._%+-]{0,63}", re.I)
EMAIL_DOMAIN = re.compile(r"(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}", re.I)
# Domains that never reach a real mailbox (RFC 2606), for a made-up email address.
TEST_DOMAIN = re.compile(r"(?:.+\.)?(?:example\.(?:com|net|org)|[^.]+\.(?:example|test|invalid|localhost))", re.I)
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
    device: str | None = None              # a phone or tablet test's preset (devices.py), None on a desktop
    touch: bool = False                    # the page has a touch screen: no hover, no right click


class Planner(Protocol):
    """Registered by the Team engine. `plan` answers `{steps: [...], note?}` (checked by `clean`)
    or None (it couldn't make a plan); it raises EngineError("not_ready", …) when it may not plan
    (no licence feature) or can't (no AI assistant)."""

    def plan(self, story: Story, locator_fn: Callable[[], Locator]) -> Awaitable[dict | None]: ...


def _words(v: Any, n: int) -> str | None:
    return " ".join(v.split())[:n] if isinstance(v, str) and v.strip() else None


def _fold(s: str) -> str:
    return " ".join(s.lower().replace("’", "'").replace("“", '"').replace("”", '"').split())


def _in_story(text: str, story: str) -> bool:
    t = _fold(text).strip("\"'")
    return bool(t) and t in _fold(story)


def _test_email(text: str, story: str) -> bool:
    """A made-up email address with a run-time value in its name: `ada+{timestamp}@example.com`.
    Its domain never reaches a real mailbox, or is one the story names."""
    local, at, domain = text.strip().rpartition("@")
    if not at or not TOKENS.search(local) or TOKENS.search(domain) or not EMAIL_DOMAIN.fullmatch(domain):
        return False
    if not EMAIL_LOCAL.fullmatch(TOKENS.sub("1", local)):
        return False
    return bool(TEST_DOMAIN.fullmatch(domain)) or re.search(r"(?<![\w.-])" + re.escape(domain.lower()) + r"(?![\w-])", _fold(story)) is not None


def written_in(text: str, story: str) -> bool:
    """The person wrote this text in the story (case and spaces aside). A run-time value
    ({timestamp}, {i}, {time}, {date}) may only end what the story says ("Ada Lovelace {i}") or a
    short made-up name ("Test project {time}"), or be in the name of a made-up email address
    (`ada+{timestamp}@example.com`). Anything else that has one, like words read off the page, isn't
    the person's."""
    if not TOKENS.search(text):
        return _in_story(text, story)
    if _test_email(text, story):
        return True
    m = TOKEN_SUFFIX.fullmatch(text.strip())
    if m is None:
        return False                    # a value in the middle of the text
    base = m.group("base").strip()
    return not base or _in_story(base, story) or bool(NAME_SHAPE.fullmatch(base))


def same_origin(url: str, page_url: str | None) -> bool:
    if not page_url:
        return False
    try:
        a, b = urlsplit(url), urlsplit(page_url)
        return (a.scheme.lower(), a.hostname, a.port) == (b.scheme.lower(), b.hostname, b.port) and bool(a.hostname)
    except ValueError:
        return False


def url_allowed(url: str, story: Story) -> bool:
    """A planned "Go to" opens only an address on the page's own site, or one the story names."""
    try:
        u = urlsplit(url)
        host = u.hostname
    except ValueError:
        return False
    if not host or "@" in u.netloc:
        return False                    # no user:pass@ that hides the real host
    if same_origin(url, story.url):
        return True
    s = _fold(story.text)
    bare = _fold(url.split("://", 1)[1]).rstrip("/")
    if bare and bare in s:
        return True
    return re.search(r"(?<![\w.-])" + re.escape(host) + r"(?![\w-]|\.\w)", s) is not None


def careful(step: dict) -> bool:
    return any(isinstance(step.get(k), str) and CAREFUL.search(step[k]) for k in ("target", "url"))


def clean_step(raw: Any, story: Story) -> dict | None:
    """One proposed step as the protocol carries it, with the safety rules applied, or None."""
    if not isinstance(raw, dict) or raw.get("action") not in ACTIONS:
        return None
    action = raw["action"]
    if story.touch and action in MOUSE_ONLY:
        return None                                     # a phone or tablet has no pointer to hover or right click with
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
        if not url_allowed(url.strip(), story):
            return None                                 # another site the story never named
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
    """A planner's answer as `record.plan` returns it: `{steps, note?, dropped?, overLimit?}`, or
    None when it holds no step at all. `dropped` counts what the planner proposed that no step can
    do; `overLimit` the steps it could have been, left out past MAX_STEPS."""
    if not isinstance(value, dict) or not isinstance(value.get("steps"), list):
        return None
    steps, dropped, over = [], 0, 0
    for raw in value["steps"]:
        s = clean_step(raw, story)
        if s is None:
            dropped += 1
        elif len(steps) < MAX_STEPS:
            steps.append(s)
        else:
            over += 1
    if not steps:
        return None
    out: dict = {"steps": steps}
    note = _words(value.get("note"), MAX_NOTE)
    if note:
        out["note"] = note
    if dropped:
        out["dropped"] = dropped
    if over:
        out["overLimit"] = over
    return out


def secret_names(v: Any) -> list[str]:
    """`record.plan`'s `secrets`: the saved secret names the person picked (never their values)."""
    if not isinstance(v, list):
        return []
    return list(dict.fromkeys(n for n in v if isinstance(n, str) and SECRET_NAME.match(n)))[:MAX_SECRETS]
