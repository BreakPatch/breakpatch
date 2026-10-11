"""Text that shows on the screen: what a checkpoint looks for ("Account created"), found from the
page's structure when it isn't a control.

S0 (s0.py) scores controls only, and a message such as "Account created" or "Saved" is usually
plain text, not a control: on a Fast page S0 is then unsure and the AI assistant is asked. For a
`record.locate` with `shows` (a checkpoint or a Wait until), this looks at the short text runs on
screen first (extract.py `texts`):

- what to look for is the description without quotes, a leading "the", "a" or "an", and trailing
  words that only say it shows ("Account created message shows" reads "Account created");
- a text that reads exactly that (case, accents and punctuation aside) wins; else the shortest
  text that has it as whole words and isn't much longer (a sentence around it, not a paragraph);
- ties go to the first in reading order (top to bottom, then left to right).

Nothing reads like it: None, and the caller goes on as before (the AI assistant). S0's frozen
thresholds aren't touched: this only answers where S0 was unsure.
"""
from __future__ import annotations

import re

from . import s0

MIN_CHARS = 2             # shorter queries ("OK" is two) would match too much
MAX_EXTRA = 40            # characters a matching text may have beyond what's looked for

_LEAD = re.compile(r"^(?:check(?:\s+that)?|see|verify(?:\s+that)?|the|a|an)\s+", re.I)
_TAIL = re.compile(r"\s+(?:message|text|label|notice|banner|toast)?\s*"
                   r"(?:shows|is\s+shown|is\s+showing|appears|is\s+visible|is\s+displayed|is\s+there|shows\s+up)$", re.I)
_TAIL_NOUN = re.compile(r"\s+(?:message|text|label|notice|banner|toast)$", re.I)


def query(description: str) -> str:
    """What to look for, folded: "the “Account created” message shows" reads "account created"."""
    d = " ".join(description.split())
    for _ in range(3):
        d = _LEAD.sub("", d)
    d = _TAIL.sub("", d)
    d = _TAIL_NOUN.sub("", d)
    return s0.norm(d.strip().strip("\"'“”‘’"))


def find(description: str, texts: list[dict]) -> dict | None:
    """The text run on screen that reads like `description`, or None."""
    q = query(description)
    if len(q) < MIN_CHARS:
        return None
    exact, contains = [], []
    pattern = re.compile(r"(?:^| )" + re.escape(q) + r"(?: |$)")
    for t in texts:
        box = t.get("box")
        if not (isinstance(box, (list, tuple)) and len(box) == 4) or box[2] <= box[0] or box[3] <= box[1]:
            continue
        n = s0.norm(t.get("text"))
        if n == q:
            exact.append(t)
        elif pattern.search(n) and len(n) - len(q) <= MAX_EXTRA:
            contains.append(t)
    order = lambda t: (len(s0.norm(t.get("text"))), s0.reading_order(t))  # noqa: E731
    if exact:
        return min(exact, key=lambda t: s0.reading_order(t))
    if contains:
        return min(contains, key=order)
    return None
