"""S0: finds a described element in the candidate list (extract.py) by scoring text, role and
position words. No model.

Ported from the System 1 experiment's S0 (a pre-registered comparison of DOM-based locators with
the vision model: 188 real pages, 6,604 trials). There, on the 132 held-out pages with a usable
DOM, S0 found 88.7% of targets against 80% for the vision model alone (click-only), answered
"not found" correctly far more often (F1 0.76 against 0.06) and took 12 ms at the median on an
M5 Pro, against about 1 s. It is weak on paraphrased descriptions (38%) and on icon-only
controls, where the vision model is better; on Flutter and canvas pages it finds nothing.

The scoring is the experiment's, with two changes: ordinals count in visual reading order (top to
bottom, then left to right) rather than document order, because its ground truth did (56 test
trials disagreed with the document-order count); and candidates with the same top score are
ordered by reading order too, not document order, and counted (`Answer.ties`).

    score = 0.6 * text + 0.2 * role + 0.2 * position        (each part from 0 to 1)

- text: the best, over the candidate's name, label, text, aria-* values and data-testid (dashes
  and underscores as spaces), of 0.7 * max(token_set_ratio, 0.95 * partial_ratio) +
  0.3 * token_sort_ratio, over 100. Case, accents and punctuation are folded away, and the edit
  distance ratios forgive typos. The query is the description without its role, position and
  ordinal words, its "in the <region>" part and stop words (or the whole description if that
  leaves nothing). partial_ratio only counts when both strings have 3 characters or more.
- role: 1 when the description names a role (ROLE_WORDS, English and Spanish) the candidate has,
  else 0; 0.5 for everyone when it names none.
- position: the mean of the parts the description has; 0.5 for everyone when it has none.
  top/bottom/left/right (and Spanish): linear in the box centre (top = 1 - y / height).
  An ordinal (first ... tenth, 1st ..., last, nth N, Spanish primero ... ultimo): among the text
  matches (text >= 0.85 x the best, and a compatible role), in visual reading order, the k-th
  gets 1 and the others 0. "in / inside / within / on / under the X" (Spanish "en el / la X"):
  token_set_ratio(X, landmark) / 100.

S0 answers with the top candidate only when its score is at least ACCEPT_SCORE and it leads the
second by at least ACCEPT_LEAD; otherwise it is unsure (`choice` None). With a lead of 0 allowed,
a tie still answers: the first of the tied candidates in reading order, and `ties` says how many
there were, so a caller can say it was ambiguous. The click point is the centre of the chosen
element's box.
"""
from __future__ import annotations

import re
import time
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz

W_TEXT, W_ROLE, W_POS = 0.6, 0.2, 0.2
# Frozen thresholds from the pre-registered System 1 experiment (29 Sep 2026): chosen by a grid
# search on the 56 development pages (1,234 trials; T from 0.30 to 0.90, M from 0 to 0.20), where
# T 0.65 with no margin scored best, and frozen before the 132 test pages were run. On those S0
# found 88.7% of targets on DOM-rich pages, with 0.76 F1 on "not found". Don't change them without
# re-running that experiment.
ACCEPT_SCORE = 0.65      # T
ACCEPT_LEAD = 0.00       # M: the top score's lead over the second

ROLE_WORDS = {
    # English
    "button": {"button"}, "btn": {"button"}, "link": {"link"}, "hyperlink": {"link"},
    "checkbox": {"checkbox", "switch", "menuitemcheckbox"}, "check": {"checkbox"}, "tick": {"checkbox"},
    "radio": {"radio", "menuitemradio"}, "toggle": {"switch", "checkbox", "button"},
    "switch": {"switch", "checkbox"}, "tab": {"tab"}, "field": {"textbox", "searchbox", "combobox", "spinbutton"},
    "input": {"textbox", "searchbox", "combobox", "spinbutton"}, "textbox": {"textbox", "searchbox"},
    "box": {"textbox", "searchbox", "combobox", "checkbox"}, "search": {"searchbox", "textbox", "combobox"},
    "searchbox": {"searchbox", "textbox"}, "dropdown": {"combobox", "listbox", "button"},
    "select": {"combobox", "listbox"}, "combobox": {"combobox"}, "menu": {"menu", "menuitem", "button", "menubar"},
    "item": {"menuitem", "option", "treeitem", "listitem", "menuitemcheckbox", "menuitemradio"},
    "option": {"option", "menuitem", "radio"}, "slider": {"slider"}, "icon": {"button", "link", "img", "image"},
    "image": {"img", "image"}, "picture": {"img", "image"}, "logo": {"img", "image", "link"},
    "heading": {"heading"}, "title": {"heading"}, "header": {"heading"}, "cell": {"cell", "gridcell"},
    "row": {"row"}, "spinner": {"spinbutton"}, "stepper": {"spinbutton"},
    # Spanish (accents are folded before lookup: botón -> boton, pestaña -> pestana)
    "boton": {"button"}, "enlace": {"link"}, "vinculo": {"link"}, "casilla": {"checkbox"},
    "interruptor": {"switch", "checkbox"}, "pestana": {"tab"}, "campo": {"textbox", "searchbox", "combobox", "spinbutton"},
    "entrada": {"textbox", "searchbox"}, "buscador": {"searchbox", "textbox"}, "desplegable": {"combobox", "listbox"},
    "opcion": {"option", "menuitem", "radio"}, "icono": {"button", "link", "img", "image"}, "imagen": {"img", "image"},
    "titulo": {"heading"}, "elemento": {"menuitem", "option", "treeitem"},
    "control": set(), "deslizador": {"slider"},
}
POS_WORDS = {"top": ("y", 0), "upper": ("y", 0), "bottom": ("y", 1), "lower": ("y", 1),
             "left": ("x", 0), "right": ("x", 1), "arriba": ("y", 0), "superior": ("y", 0),
             "abajo": ("y", 1), "inferior": ("y", 1), "izquierda": ("x", 0), "derecha": ("x", 1)}
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7,
            "eighth": 8, "ninth": 9, "tenth": 10, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5,
            "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10, "last": -1,
            "primer": 1, "primero": 1, "primera": 1, "segundo": 2, "segunda": 2, "tercer": 3, "tercero": 3,
            "tercera": 3, "cuarto": 4, "cuarta": 4, "quinto": 5, "quinta": 5, "ultimo": -1, "ultima": -1}
STOP = {"the", "a", "an", "of", "to", "for", "on", "in", "at", "with", "that", "this", "which", "is",
        "el", "la", "los", "las", "un", "una", "de", "del", "para", "con", "que", "en", "al", "y", "and",
        "labelled", "labeled", "called", "named", "says", "saying", "text", "one", "etiquetado", "llamado",
        "corner", "side", "esquina", "lado", "page", "screen", "pagina", "pantalla"}
REGION_RE = re.compile(r"\b(?:in|inside|within|on|under|en|dentro de)\s+(?:the|el|la|los|las)\s+")


def norm(s: str | None) -> str:
    """Case-folded, accents and punctuation removed, whitespace collapsed."""
    s = unicodedata.normalize("NFKD", (s or "").casefold())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^\w\s]", " ", s).replace("_", " ")
    return " ".join(s.split())


def parse(description: str) -> dict:
    """The description's parts: query text, role sets, position words, ordinal, region."""
    d = norm(description)
    # "in the X" phrases: the region is the last one that names something ("the Save button in the
    # Edit profile dialog on the right": the dialog). Phrases of position words only ("on the
    # right") give their words to `pos`; other earlier phrases stay in the query.
    region, extra_pos = None, []
    marks = list(REGION_RE.finditer(d))
    d_main = d[:marks[0].start()].strip() if marks else d
    parts = [d[m.end():(marks[k + 1].start() if k + 1 < len(marks) else len(d))].strip()
             for k, m in enumerate(marks)]
    named = [k for k, t in enumerate(parts) if any(w not in POS_WORDS and w not in STOP for w in t.split())]
    for k, t in enumerate(parts):
        if named and k == named[-1]:
            region = t
        elif k in named:
            d_main = f"{d_main} {t}".strip()
        else:
            extra_pos += [POS_WORDS[w] for w in t.split() if w in POS_WORDS]
    toks = d_main.split()
    roles, pos, ordinal, content = set(), list(extra_pos), None, []
    skip = False
    for i, t in enumerate(toks):
        if skip:
            skip = False
            continue
        if t in ORDINALS:
            ordinal = ORDINALS[t]
            continue
        if t == "nth" and i + 1 < len(toks) and toks[i + 1].isdigit():
            ordinal = int(toks[i + 1])
            skip = True           # the number is the ordinal, not text to look for
            continue
        if t in POS_WORDS:
            pos.append(POS_WORDS[t])
            continue
        if t in ROLE_WORDS:
            roles |= ROLE_WORDS[t]
            continue
        if t in STOP:
            continue
        content.append(t)
    if region:   # position words can sit in the region part too ("in the top bar")
        for t in region.split():
            if t in POS_WORDS:
                pos.append(POS_WORDS[t])
    q = " ".join(content) or d_main or d
    return {"q": q, "roles": roles, "pos": pos, "ordinal": ordinal, "region": region}


def _fields(c: dict) -> list[str]:
    f = [c.get("name"), c.get("label"), c.get("text")]
    for k, v in (c.get("attrs") or {}).items():
        if k == "data-testid":
            f.append(re.sub(r"[-_.]+", " ", v or ""))
        elif k.startswith("aria-") and v and v not in ("true", "false"):
            f.append(v)
    return [x for x in (norm(s) for s in f) if x]


def text_score(q: str, c: dict) -> float:
    best = 0.0
    for f in _fields(c):
        tsr = fuzz.token_set_ratio(q, f)
        pr = fuzz.partial_ratio(q, f) if len(q) >= 3 and len(f) >= 3 else 0.0
        s = 0.7 * max(tsr, 0.95 * pr) + 0.3 * fuzz.token_sort_ratio(q, f)
        if s > best:
            best = s
    return best / 100.0


def reading_order(c: dict) -> tuple[float, float]:
    """Top to bottom, then left to right (the box's top left corner)."""
    return (c["box"][1], c["box"][0])


def components(description: str, candidates: list[dict], viewport=(1440, 900)):
    """(parsed description, text, role, position) scores, one per candidate, in list order."""
    p = parse(description)
    vw, vh = viewport
    txt = [text_score(p["q"], c) for c in candidates]
    if p["roles"]:
        role = [1.0 if (c.get("role") or "") in p["roles"] else 0.0 for c in candidates]
    else:
        role = [0.5] * len(candidates)
    pos_parts = []
    if p["pos"]:
        sub = []
        for c in candidates:
            cx = (c["box"][0] + c["box"][2]) / 2 / vw
            cy = (c["box"][1] + c["box"][3]) / 2 / vh
            v = [(1 - (cy if ax == "y" else cx)) if end == 0 else (cy if ax == "y" else cx) for ax, end in p["pos"]]
            sub.append(min(1.0, max(0.0, sum(v) / len(v))))
        pos_parts.append(sub)
    if p["ordinal"] is not None and candidates:
        bt = max(txt)
        match = [i for i, c in enumerate(candidates) if txt[i] >= 0.85 * bt and role[i] > 0]
        match.sort(key=lambda i: (reading_order(candidates[i]), i))     # visual order, not document order
        k = p["ordinal"]
        sel = match[k - 1] if 0 < k <= len(match) else (match[-1] if k == -1 and match else None)
        pos_parts.append([1.0 if i == sel else 0.0 for i in range(len(candidates))])
    if p["region"]:
        pos_parts.append([fuzz.token_set_ratio(p["region"], norm(c.get("landmark"))) / 100.0
                          if c.get("landmark") else 0.0 for c in candidates])
    if pos_parts:
        pos = [sum(col) / len(col) for col in zip(*pos_parts)]
    else:
        pos = [0.5] * len(candidates)
    return p, txt, role, pos


def scores(description: str, candidates: list[dict], viewport=(1440, 900)) -> list[float]:
    """S0's score for every candidate, in list order."""
    if not candidates:
        return []
    _, txt, role, pos = components(description or "", candidates, viewport)
    return [W_TEXT * t + W_ROLE * r + W_POS * q for t, r, q in zip(txt, role, pos)]


def accepts(top: float, second: float) -> bool:
    return top >= ACCEPT_SCORE and (top - second) >= ACCEPT_LEAD


@dataclass
class Answer:
    choice: int | None          # the chosen candidate's `index` field; None when S0 is unsure
    score: float                # the top candidate's score (0 for an empty list)
    lead: float                 # its lead over the second
    top: int | None             # the top candidate's `index` field, chosen or not
    ms: float                   # time spent scoring
    ties: int = 0               # how many candidates share the top score (1: no tie)

    @property
    def found(self) -> bool:
        return self.choice is not None


def locate(description: str, candidates: list[dict], viewport=(1440, 900)) -> Answer:
    """The candidate S0 picks for `description`, or an unsure answer. An empty list is unsure too
    (the router sends such pages to the AI assistant: Flutter pages list nothing, and that
    doesn't mean the target isn't there)."""
    t0 = time.perf_counter()
    if not candidates:
        return Answer(None, 0.0, 0.0, None, 0.0)
    sc = scores(description, candidates, viewport)
    # Exact ties go to the first in reading order (the experiment broke them by document order).
    order = sorted(range(len(candidates)), key=lambda i: (-round(sc[i], 9), reading_order(candidates[i]), i))
    top = sc[order[0]]
    second = sc[order[1]] if len(order) > 1 else 0.0
    ties = sum(1 for x in sc if round(x, 9) == round(top, 9))
    best = candidates[order[0]]["index"]
    choice = best if accepts(top, second) else None
    return Answer(choice, round(top, 4), round(top - second, 4), best,
                  round((time.perf_counter() - t0) * 1000, 2), ties)


def visible_box(box, viewport=(1440, 900)) -> list[float]:
    """The part of `box` inside the viewport: the box itself when it's all on screen, as it nearly
    always is (candidates must meet the viewport). Its centre is the click point, on the page."""
    vw, vh = viewport
    clipped = [max(0.0, box[0]), max(0.0, box[1]), min(float(vw), box[2]), min(float(vh), box[3])]
    return clipped if clipped[2] > clipped[0] and clipped[3] > clipped[1] else list(box)
