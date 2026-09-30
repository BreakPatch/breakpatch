"""The "+" or "−" next to something: a stepper's control, found from the page's structure.

"Add 2 people" on a pricing page means the "+" by "People". S0 can't be asked for that: it folds
punctuation away, so "+" and "−" are the same to it, and it would pick either one by the word
"People" (the minus comes first in reading order). This looks for it directly:

- The controls that increase (their name, label, text or aria-* value is "+", "plus", "add",
  "increase", "increment", "more", or an arrow up) or decrease ("−", "-", "minus", "remove",
  "decrease", "decrement", "less", "fewer", or an arrow down), English and Spanish. A control whose
  words are longer than a few (a "Add to cart" button) isn't one.
- What they sit next to: the candidates and the short text runs on screen (extract.py `texts`)
  whose text matches the thing (the same text score as S0's, at least NEAR_TEXT).
- The control whose own words name the thing ("Add a person", "Increase people") comes first;
  else the one nearest to a match, edge to edge, within NEAR_PX.

Nothing found (no such control, nothing matching the thing, or none near enough): None, and the
caller asks the AI assistant with the plain description instead.
"""
from __future__ import annotations

from . import s0

NEAR_TEXT = 0.8           # how well a text must match the thing to count as it
NEAR_PX = 320             # how far (edge to edge, viewport px) a control may be from the thing
MAX_WORDS = 4             # longer names are buttons of their own, not a stepper's "+"

INCREASE_SYMBOLS = {"+", "＋", "➕", "⊕", "▲", "▴", "↑", "⌃", "˄"}
DECREASE_SYMBOLS = {"-", "−", "–", "—", "➖", "⊖", "▼", "▾", "↓", "⌄", "˅"}
# Words that make a control a "+" or "−" at the start of a short name ("Add a person"), and words
# that only do on their own ("More": "More options" is a menu).
INCREASE_WORDS = {"plus", "add", "increase", "increment", "anadir", "agregar", "aumentar", "sumar", "incrementar"}
DECREASE_WORDS = {"minus", "remove", "decrease", "decrement", "subtract", "quitar", "restar", "disminuir", "reducir"}
INCREASE_ALONE = {"more", "up", "mas"}
DECREASE_ALONE = {"less", "fewer", "down", "menos"}
COUNT_WORDS = INCREASE_WORDS | DECREASE_WORDS | INCREASE_ALONE | DECREASE_ALONE


def _raw_fields(c: dict) -> list[str]:
    f = [c.get("name"), c.get("label"), c.get("text")]
    f += [v for k, v in (c.get("attrs") or {}).items() if k.startswith("aria-") and v and v not in ("true", "false")]
    return [" ".join(x.split()) for x in f if isinstance(x, str) and x.strip()]


def _symbol(f: str, symbols: set[str]) -> bool:
    """The symbol on its own ("+"), or before one word at most ("+ Add", "−1"): "+ New project"
    or "-20% off" are buttons and prices, not a stepper's."""
    return f in symbols or (f[:1] in symbols and len(f[1:].split()) <= 1)


def _kinds(c: dict) -> tuple[str | None, str | None]:
    """(what the control does to a count on any stepper, what it does only if its name is the
    thing's): "+", "plus" or "More" say it for any; "Add a person" only for people ("Add to cart"
    isn't a stepper's)."""
    if c.get("disabled"):
        return None, None
    generic, named = set(), set()
    for f in _raw_fields(c):
        words = s0.norm(f).split()
        if _symbol(f, INCREASE_SYMBOLS):
            generic.add("increase")
        elif _symbol(f, DECREASE_SYMBOLS):
            generic.add("decrease")
        elif not words or len(words) > MAX_WORDS:
            continue
        elif len(words) == 1 and words[0] in INCREASE_WORDS | INCREASE_ALONE:
            generic.add("increase")
        elif len(words) == 1 and words[0] in DECREASE_WORDS | DECREASE_ALONE:
            generic.add("decrease")
        elif words[0] in INCREASE_WORDS:
            named.add("increase")
        elif words[0] in DECREASE_WORDS:
            named.add("decrease")
    one = lambda k: k.pop() if len(k) == 1 else None      # noqa: E731 - both ways: neither
    return one(generic), one(named)


def kind_of(c: dict) -> str | None:
    """"increase", "decrease" or None: what a candidate does to any count, from its own words."""
    return _kinds(c)[0]


def _gap(a, b) -> float:
    """Edge-to-edge distance between two boxes (0 when they touch or overlap), a line apart
    counting twice: a stepper sits on its label's line, or right under it."""
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + 4 * dy * dy) ** 0.5


def _names(c: dict, q: str) -> bool:
    """The control's own words name the thing ("Add a person" for "people" too, by S0's score)."""
    rest = [s0.norm(f) for f in _raw_fields(c)]
    rest = [" ".join(w for w in f.split() if w not in COUNT_WORDS) for f in rest]
    return any(f and s0.text_score(q, {"text": f}) >= NEAR_TEXT for f in rest)


def stepper(control: str, of: str, candidates: list[dict], texts: list[dict]) -> dict | None:
    """The candidate that increases (control "increase") or decreases ("decrease") the count of
    `of`, or None."""
    q = s0.norm(of)
    if control not in ("increase", "decrease") or not q:
        return None
    kinds = [_kinds(c) for c in candidates]
    mine = [c for c, (g, n) in zip(candidates, kinds) if g == control or (n == control and _names(c, q))]
    if not mine:
        return None
    named = [c for c in mine if _names(c, q)]
    if len(named) == 1:
        return named[0]
    pool = named or mine
    anchors = [c["box"] for c, (g, n) in zip(candidates, kinds) if not g and not n and s0.text_score(q, c) >= NEAR_TEXT]
    anchors += [t["box"] for t in texts if s0.text_score(q, {"text": t["text"]}) >= NEAR_TEXT]
    if not anchors:
        return named[0] if named else None
    best = min(pool, key=lambda c: (min(_gap(c["box"], a) for a in anchors), s0.reading_order(c)))
    if min(_gap(best["box"], a) for a in anchors) > NEAR_PX:
        return None
    return best
