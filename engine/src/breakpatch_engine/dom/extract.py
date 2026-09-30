"""The visible controls of the current viewport, read through the DevTools protocol.

Ported from the System 1 experiment's harness extractor. In that experiment (a pre-registered
comparison of DOM-based locators with the vision model on 188 real pages) this list was what S0
chose from, and it was tested on the fixture pages in tests/site/dom. The keep, drop and merge
rules are the harness's. What differs:
- The transport: the engine's own Playwright CDP sessions (async). The harness opened a DevTools
  port and talked to it directly; the engine opens none (any program on the Mac could drive the
  browser through it), so every message goes through Playwright's driver. Measured on a 4-core
  Linux machine: 5 to 25 ms for the small fixture pages, about 0.5 s for the 400-control one (the
  harness took 39 ms for it on an M-series Mac).
- What counts as visible: a node must also lie inside every scrolling or overflow-clipping box
  around it (a carousel's other slides, rows scrolled out of an inner list), and a control whose
  centre is under a later-painted, bigger positioned box that takes clicks (a modal's backdrop, a
  cookie banner) is left out. The harness only clipped against iframes.
- A named container is only dropped for the controls inside it that are actually listed.

Per renderer process (the page, and one per out-of-process cross-site iframe):
- `DOMSnapshot.captureSnapshot` gives every node of every document in that process, flattened,
  open AND closed shadow roots included (DevTools pierces both), with layout boxes, paint order,
  computed styles (STYLES), attributes, input values, Blink's `isClickable` bit and the content
  document of same-process iframes.
- The accessibility tree gives roles, names, descriptions and states: `getFullAXTree` for the
  document or, when only a small part of a big document is on screen, `getPartialAXTree` for the
  visible elements and their ancestors (the landmarks), sent all at once. Both give the same
  objects for every node that can become a candidate (tested); partial is about twice as fast on
  the 400-control page, full is faster on small ones. Accessibility is switched off again after
  each read, so the page isn't slowed by it between looks.

Boxes are viewport pixels: a document's own bounds, minus its scroll, plus the origin of its
iframe's content box (inside border and padding) in the parent viewport, recursively. CSS
transforms or zoom on an <iframe> aren't handled.

A node is kept when its box meets the viewport (and every box clipping it), it has a size, it is
`visibility: visible` with no opacity 0 on it or an ancestor, it isn't covered as above, AND it is
interactive and enabled or it has a non-empty accessible name.

Interactive means one of
- strong: an AX role in STRONG_ROLES (cells and rows only when focusable), or a native control
  (a[href], button, input other than hidden, select, textarea, summary, contenteditable);
- weak (click-listener stand-ins, for div soup): tabindex >= 0; Blink's isClickable (not on
  html/body, nor on a box over half the viewport, which is a listener delegated to the root);
  cursor:pointer where the parent's cursor isn't (it inherits, so only the outermost counts).

Nested wrappers are merged:
- a weak-only interactive node inside an interactive one is dropped (the outer one wins);
- a named non-interactive node inside an interactive one is dropped (an <img alt> in a link);
- a named non-interactive node that contains a listed interactive one is dropped (cells, rows,
  groups, dialogs, landmarks: their name is only their controls' names);
- text, label and legend roles never count as named by themselves (their text names a control),
  and <label> never gets the weak stand-ins (its click only forwards to its control).

Each candidate, in document order: `{index, role, name, label, text, box, landmark, disabled,
attrs}`. role is the AX role ("generic" when the node is ignored); name the AX name; label the
first of placeholder, title, AX description, aria-label that differs from the name; text the
rendered text inside it, or a field's value (never for passwords, checkboxes, radios, files,
colours), at most 80 characters; landmark the nearest landmark or dialog around it, as
"role: name", through iframe owners; disabled from the AX tree or aria-disabled; attrs only
data-testid and aria-*. Boxes are [x1, y1, x2, y2] rounded to 0.1 px.

Nothing here is kept between looks: a node's index only means something in the list it came from.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger("breakpatch.dom")

STYLES = ["visibility", "opacity", "cursor", "border-left-width", "border-top-width",
          "padding-left", "padding-top", "border-right-width", "border-bottom-width",
          "padding-right", "padding-bottom", "overflow-x", "overflow-y", "position", "pointer-events"]
(S_VIS, S_OP, S_CUR, S_BL, S_BT, S_PL, S_PT, S_BR, S_BB, S_PR, S_PB,
 S_OX, S_OY, S_POS, S_PE) = range(len(STYLES))
CLIPS = {"hidden", "scroll", "auto", "clip", "overlay"}    # overflow values that clip descendants
COVERS = {"absolute", "fixed", "sticky"}                     # positions that can sit over other content

STRONG_ROLES = {
    "button", "link", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "listbox",
    "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton",
    "treeitem", "scrollbar", "textField", "TextField", "PopUpButton", "ToggleButton",
    "DisclosureTriangle", "disclosureTriangle", "ListBoxOption", "MenuListOption", "MenuListPopup",
    "colorwell", "ColorWell", "date", "Date", "DateTime", "InputTime", "SearchBox", "CheckBox",
    "RadioButton", "Switch", "SpinButton", "Slider", "MenuItem", "Tab", "TreeItem", "Link", "Button",
}
FOCUS_ONLY_ROLES = {"gridcell", "cell", "row", "columnheader", "rowheader"}
NATIVE_TAGS = {"BUTTON", "SELECT", "TEXTAREA", "SUMMARY"}
NOT_NAMED_ROLES = {"StaticText", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "Iframe",
                   "IframePresentational", "label", "LabelText", "legend", "Legend", "none",
                   "presentation", "Canvas"}
NO_VALUE_TYPES = {"checkbox", "radio", "password", "hidden", "file", "color"}
LANDMARK_ROLES = {"banner", "navigation", "main", "contentinfo", "complementary", "region", "search",
                  "form", "dialog", "alertdialog"}
# What the router looks for (router.py): a Flutter web app's host elements, and canvases.
FLUTTER_TAGS = {"FLT-GLASS-PANE", "FLUTTER-VIEW", "FLT-SCENE-HOST"}
# "auto" reads a document's AX tree partially when fewer than 1 in PARTIAL_BELOW of its nodes
# (visible elements and their ancestors) are wanted, else fully (measured on the fixtures).
PARTIAL_BELOW = 3
# aria-* attributes that hold element ids. Some pages make new ids on every load (the experiment
# saw one regenerate aria-labelledby on each visit), so they never count towards a list's identity.
ID_REF_ATTRS = {"aria-labelledby", "aria-describedby", "aria-controls", "aria-owns",
                "aria-activedescendant", "aria-flowto", "aria-details", "aria-errormessage"}
PUBLIC = ("index", "role", "name", "label", "text", "box", "landmark", "disabled", "attrs")


def _px(s: str) -> float:
    try:
        return float(s[:-2]) if s.endswith("px") else float(s)
    except (ValueError, AttributeError):
        return 0.0


def _rare_bool(d: dict | None) -> set:
    return set(d["index"]) if d else set()


def _rare_map(d: dict | None) -> dict:
    return dict(zip(d["index"], d["value"])) if d else {}


def _meet(a, b):
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def list_hash(viewport, candidates: list[dict]) -> str:
    """The list's identity: the same page state gives the same hash (id references left out)."""
    stable = [{**c, "attrs": {k: v for k, v in (c.get("attrs") or {}).items() if k not in ID_REF_ATTRS}}
              for c in candidates]
    s = json.dumps({"viewport": list(viewport), "candidates": stable}, sort_keys=True,
                   separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(s.encode()).hexdigest()


@dataclass
class Extraction:
    """One look at the page's structure."""
    viewport: tuple[int, int]
    candidates: list[dict]
    extract_ms: float
    flutter: bool = False           # a Flutter host element is on the page
    canvas_share: float = 0.0       # the largest visible <canvas>, as a share of the viewport
    n_procs: int = 1
    n_documents: int = 1
    extra: dict = field(default_factory=dict)   # what a subclass's hooks collected

    @property
    def count(self) -> int:
        return len(self.candidates)

    @property
    def list_hash(self) -> str:
        return list_hash(self.viewport, self.candidates)


class Look:
    """The state of one extract() call, so overlapping calls never share any."""

    def __init__(self, snaps, axmaps, oopif_of):
        self.snaps, self.axmaps, self.oopif_of = snaps, axmaps, oopif_of
        self.out: list[dict] = []
        self.flutter = False
        self.canvas = 0.0
        self.extra: dict = {}


class _Proc:
    """One renderer process (the page or an out-of-process iframe): its CDP session and the
    <iframe> that owns it."""

    def __init__(self, session, frame_id=None, owner=None):
        self.s = session
        self.frame_id = frame_id      # None for the page itself
        self.owner = owner            # (proc index, backendNodeId) of the owning <iframe>


class Extractor:
    """CDP sessions for one page (one per renderer process), opened once and reused for every
    `extract()` until the page's frames change or navigate (`stale()`: an iframe that loads a
    cross-site page later gets a process of its own, and a session).

    Subclasses can watch the walk (`_element`, `_finish`); the tests and the benchmark follow
    their marked target elements that way.
    """

    walk_hidden_frames = False      # a subclass that follows elements in hidden iframes sets it

    def __init__(self, page, viewport: tuple[int, int], ax_mode: str = "auto"):
        self.page = page
        self.viewport = (int(viewport[0]), int(viewport[1]))
        self.ax_mode = ax_mode        # "auto", "full" or "partial" (the tests compare them)
        self.procs: list[_Proc] = []
        self._frames: tuple = ()

    def _frame_key(self) -> tuple:
        return tuple((f, f.url) for f in self.page.frames)

    async def open(self) -> "Extractor":
        ctx = self.page.context
        self.procs = [_Proc(await ctx.new_cdp_session(self.page))]
        self._frames = self._frame_key()
        for f in self.page.frames[1:]:
            try:
                s = await ctx.new_cdp_session(f)
            except Exception:  # noqa: BLE001 - a same-process frame: the parent's snapshot has it
                continue
            try:
                fid = (await s.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
            except Exception:  # noqa: BLE001 - it went away meanwhile
                await _detach(s)
                continue
            owner = None
            for pi, p in enumerate(self.procs):
                try:
                    o = await p.s.send("DOM.getFrameOwner", {"frameId": fid})
                    owner = (pi, o["backendNodeId"])
                    break
                except Exception:  # noqa: BLE001
                    continue
            self.procs.append(_Proc(s, fid, owner))
        return self

    def stale(self) -> bool:
        """Whether the page's frames, or their addresses, changed since the sessions were opened."""
        try:
            return self.page.is_closed() or self._frame_key() != self._frames
        except Exception:  # noqa: BLE001
            return True

    async def close(self) -> None:
        procs, self.procs = self.procs, []
        for p in procs:
            await _detach(p.s)

    # ------------------------------------------------------------------ hooks

    def _element(self, look: Look, key: tuple, attrs: dict, box, visible: bool, ancestors) -> None:
        """Every element of every walked document, in document order. `key` is (process,
        document, node); `ancestors()` gives the keys of its ancestors in that document."""

    def _finish(self, look: Look, candidates: list[dict]) -> None:
        """After the walk; candidates still carry their internal `_key`."""

    # ------------------------------------------------------------------ extraction

    async def _ax(self, s, snap: dict, doc: dict, ax: dict, want: list[int], n: int) -> None:
        """AX nodes for one document into `ax` (backendNodeId -> node), through session `s`: its
        visible elements and their ancestors (`want`, node indexes) and, in full mode, the rest."""
        bids = doc["nodes"]["backendNodeId"]
        todo = [j for j in want if bids[j] not in ax]
        if not todo:
            return
        partial = self.ax_mode == "partial" or (self.ax_mode == "auto" and len(want) * PARTIAL_BELOW < n)
        if not partial:
            try:
                nodes = (await s.send("Accessibility.getFullAXTree", {"frameId": snap["strings"][doc["frameId"]]}))["nodes"]
            except Exception:  # noqa: BLE001 - a document without a frame id, or gone
                nodes = []
            for nd in nodes:
                b = nd.get("backendDOMNodeId")
                if b is not None:
                    ax[b] = nd
            return
        res = await asyncio.gather(*(s.send("Accessibility.getPartialAXTree",
                                            {"backendNodeId": bids[j], "fetchRelatives": False}) for j in todo),
                                   return_exceptions=True)
        for j, r in zip(todo, res):
            if isinstance(r, dict):
                for nd in r.get("nodes", []):
                    if nd.get("backendDOMNodeId") == bids[j]:
                        ax[bids[j]] = nd
                        break

    async def extract(self) -> Extraction:
        t0 = time.perf_counter()
        procs = list(self.procs)
        snaps = await asyncio.gather(*(p.s.send("DOMSnapshot.captureSnapshot",
                                                {"computedStyles": STYLES, "includePaintOrder": True})
                                       for p in procs))
        look = Look(snaps, [{} for _ in procs], {p.owner: i for i, p in enumerate(procs) if p.owner})
        vw, vh = self.viewport
        try:
            await self._walk(look, procs, 0, 0, 0.0, 0.0, (0.0, 0.0, float(vw), float(vh)), "")
        finally:
            # Reading the tree keeps the page's accessibility cache alive while the session is
            # attached; switching it off keeps the page as fast between looks as without us.
            await asyncio.gather(*(p.s.send("Accessibility.disable") for p in procs), return_exceptions=True)
        cands = look.out
        for k, c in enumerate(cands):
            c["index"] = k
        self._finish(look, cands)
        pub = [{k: c[k] for k in PUBLIC} for c in cands]
        ms = (time.perf_counter() - t0) * 1000
        return Extraction(self.viewport, pub, round(ms, 2), look.flutter, round(look.canvas, 4),
                          len(procs), sum(len(s["documents"]) for s in snaps), look.extra)

    async def _walk(self, look: Look, procs, pi, di, ox, oy, clip, parent_lm):
        snap, ax = look.snaps[pi], look.axmaps[pi]
        st = snap["strings"]
        d = snap["documents"][di]
        N, L = d["nodes"], d["layout"]
        names, types, parent = N["nodeName"], N["nodeType"], N["parentIndex"]
        attrs_l, bids = N["attributes"], N["backendNodeId"]
        n = len(names)
        click = _rare_bool(N.get("isClickable"))
        cdoc = _rare_map(N.get("contentDocumentIndex"))
        ival = _rare_map(N.get("inputValue"))
        lay = {ni: li for li, ni in enumerate(L["nodeIndex"])}
        bounds, styles = L["bounds"], L["styles"]
        paint = L.get("paintOrders") or []
        sx, sy = d.get("scrollOffsetX", 0) or 0, d.get("scrollOffsetY", 0) or 0
        vw, vh = self.viewport

        op0, ptr, inter, ianc = [False] * n, [False] * n, [False] * n, [False] * n
        lm, box, vis = [parent_lm] * n, [None] * n, [False] * n
        strong_l, tagn, attrd, role_l = [False] * n, [""] * n, [None] * n, [None] * n
        axn, ownptr, pos_l = [None] * n, [False] * n, [""] * n
        # Clip rects: `eff` is what clips the node itself; `ncl` what clips its in-flow children;
        # `acl` what clips its absolutely positioned descendants (they escape the overflow of
        # static boxes between them and their containing block). Fixed ones only have the frame's.
        eff, ncl, acl = [clip] * n, [clip] * n, [clip] * n
        # pass A: geometry, styles and clipping
        for i in range(n):
            p = parent[i]
            base_n, base_a = (ncl[p], acl[p]) if p >= 0 else (clip, clip)
            if p >= 0:
                op0[i] = op0[p]
                ptr[i] = ptr[p]
            eff[i], ncl[i], acl[i] = base_n, base_n, base_a
            if types[i] != 1:
                continue
            tagn[i] = st[names[i]]
            if tagn[i] in FLUTTER_TAGS:
                look.flutter = True
            a = attrs_l[i]
            attrd[i] = {st[a[k]]: st[a[k + 1]] for k in range(0, len(a), 2)} if a else {}
            li = lay.get(i)
            if li is None:
                continue
            s = styles[li]
            if not s:
                continue
            pos = st[s[S_POS]]
            pos_l[i] = pos
            e = clip if pos == "fixed" else base_a if pos == "absolute" else base_n
            own_ptr = st[s[S_CUR]] == "pointer"
            ownptr[i] = own_ptr and not (ptr[p] if p >= 0 else False)
            ptr[i] = own_ptr
            if st[s[S_OP]] in ("0", "0.0"):
                op0[i] = True
            bx, by, bw, bh = bounds[li]
            x1 = bx - sx + ox
            y1 = by - sy + oy
            b = [round(x1, 1), round(y1, 1), round(x1 + bw, 1), round(y1 + bh, 1)]
            box[i] = b
            eff[i] = e
            vis[i] = bool(bw > 0 and bh > 0 and b[0] < e[2] and b[2] > e[0] and b[1] < e[3] and b[3] > e[1]
                          and st[s[S_VIS]] == "visible" and not op0[i])
            inner = e       # overflow clips to the padding box: inside the borders
            if st[s[S_OX]] in CLIPS:
                inner = (max(inner[0], b[0] + _px(st[s[S_BL]])), inner[1],
                         min(inner[2], b[2] - _px(st[s[S_BR]])), inner[3])
            if st[s[S_OY]] in CLIPS:
                inner = (inner[0], max(inner[1], b[1] + _px(st[s[S_BT]])),
                         inner[2], min(inner[3], b[3] - _px(st[s[S_BB]])))
            ncl[i] = inner
            acl[i] = inner if pos not in ("", "static") else base_a
            if vis[i] and tagn[i] == "CANVAS":
                c = _meet(b, e)
                look.canvas = max(look.canvas, max(0.0, c[2] - c[0]) * max(0.0, c[3] - c[1]) / (vw * vh))
        # AX for the visible elements and all their ancestors (landmarks)
        want: set[int] = set()
        for i in range(n):
            if vis[i]:
                j = i
                while j >= 0 and j not in want:
                    if types[j] == 1:
                        want.add(j)
                    j = parent[j]
        await self._ax(procs[pi].s, snap, d, ax, sorted(want), n)
        # pass B: roles, landmarks, interactivity
        for i in range(n):
            p = parent[i]
            if p >= 0:
                lm[i] = lm[p]
                ianc[i] = ianc[p] or inter[p]
            if types[i] != 1:
                continue
            tag = tagn[i]
            ad = attrd[i]
            node = ax.get(bids[i])
            axn[i] = node
            role = None
            if node is not None and not node.get("ignored"):
                role = node.get("role", {}).get("value")
            role_l[i] = role
            if role in LANDMARK_ROLES:
                nm = (node.get("name") or {}).get("value") or ""
                lm[i] = f"{role}: {nm}" if nm else role
            if box[i] is None:
                continue
            strong = role in STRONG_ROLES
            if not strong and role in FOCUS_ONLY_ROLES:
                strong = any(pp.get("name") == "focusable" and pp["value"].get("value")
                             for pp in node.get("properties", []))
            if not strong:
                if tag in NATIVE_TAGS or (tag == "A" and "href" in ad) or \
                        (tag == "INPUT" and ad.get("type", "").lower() != "hidden") or \
                        ad.get("contenteditable", "false").lower() in ("", "true", "plaintext-only"):
                    strong = True
            weak = False
            if not strong:
                ti = ad.get("tabindex")
                if ti is not None:
                    try:
                        weak = int(ti) >= 0
                    except ValueError:
                        pass
                if not weak and i in click and tag not in ("HTML", "BODY", "LABEL"):
                    b = box[i]
                    weak = (b[2] - b[0]) * (b[3] - b[1]) < 0.5 * vw * vh
                if not weak and ownptr[i] and tag != "LABEL":
                    weak = True
            strong_l[i] = strong
            inter[i] = strong or weak

        # Covered: a later-painted, bigger positioned box that takes clicks, over the centre.
        covers = [j for j in range(n) if vis[j] and pos_l[j] in COVERS and paint
                  and st[styles[lay[j]][S_PE]] != "none"]

        def ancestor(a, of):
            j = parent[of]
            while j >= 0:
                if j == a:
                    return True
                j = parent[j]
            return False

        def covered(i):
            if not covers:
                return False
            b = box[i]
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            area = (b[2] - b[0]) * (b[3] - b[1])
            po = paint[lay[i]]
            for j in covers:
                if j == i or paint[lay[j]] <= po:
                    continue
                c = _meet(box[j], eff[j])
                if not (c[0] <= cx <= c[2] and c[1] <= cy <= c[3]):
                    continue
                if (box[j][2] - box[j][0]) * (box[j][3] - box[j][1]) <= area:
                    continue
                if ancestor(j, i) or ancestor(i, j):
                    continue
                return True
            return False

        # candidates: interactive ones first, as listed (enabled or named, not covered), then named
        # non-interactive ones, which are dropped when they hold a listed control
        keep_int, named, nm_l, dis_l = [False] * n, [False] * n, [""] * n, [False] * n
        for i in range(n):
            if not vis[i]:
                continue
            node = axn[i]
            nm = ((node.get("name") or {}).get("value") or "").strip() if node else ""
            nm_l[i] = nm
            ad = attrd[i]
            dis = ad.get("aria-disabled", "").lower() == "true"
            if node and not dis:
                for pp in node.get("properties", []):
                    if pp.get("name") == "disabled" and pp["value"].get("value"):
                        dis = True
                        break
            dis_l[i] = dis
            if inter[i] and (strong_l[i] or not ianc[i]):
                keep_int[i] = ((not dis) or bool(nm)) and not covered(i)
            elif nm and role_l[i] not in NOT_NAMED_ROLES and not ianc[i]:
                named[i] = not covered(i)
        has_desc = [False] * n
        for i in range(n - 1, -1, -1):
            p = parent[i]
            if p >= 0 and (has_desc[i] or keep_int[i]):
                has_desc[p] = True
        kids: dict[int, list[int]] = {}
        for i in range(n):
            p = parent[i]
            if p >= 0:
                kids.setdefault(p, []).append(i)
        nval = N["nodeValue"]

        def text_of(i):
            out, total, stack = [], 0, [i]
            while stack and total < 200:
                j = stack.pop()
                if types[j] == 3:
                    if j in lay:
                        v = st[nval[j]] if nval[j] >= 0 else ""
                        if v.strip():
                            out.append(v)
                            total += len(v)
                    continue
                if tagn[j] in ("STYLE", "SCRIPT"):
                    continue
                stack.extend(reversed(kids.get(j, [])))
            return " ".join(" ".join(out).split())[:80]

        def ancestors_of(i):
            def get():
                out, p = [], parent[i]
                while p >= 0:
                    out.append((pi, di, p))
                    p = parent[p]
                return out
            return get

        for i in range(n):
            if types[i] == 1:
                self._element(look, (pi, di, i), attrd[i] or {}, box[i], vis[i], ancestors_of(i))
            if keep_int[i] or (named[i] and not has_desc[i]):
                ad = attrd[i]
                node = axn[i]
                if tagn[i] in ("INPUT", "TEXTAREA"):
                    vi = ival.get(i, -1)
                    txt = "" if vi < 0 or ad.get("type", "").lower() in NO_VALUE_TYPES \
                        else " ".join(st[vi].split())[:80]
                else:
                    txt = text_of(i)
                desc = ((node.get("description") or {}).get("value") or "") if node else ""
                label = ""
                for cand_l in (ad.get("placeholder"), ad.get("title"), desc, ad.get("aria-label")):
                    if cand_l and cand_l.strip() and cand_l.strip() != nm_l[i]:
                        label = " ".join(cand_l.split())
                        break
                attrs = {k: v for k, v in ad.items() if k == "data-testid" or k.startswith("aria-")}
                look.out.append({"_key": (pi, di, i), "role": role_l[i] or "generic", "name": nm_l[i],
                                 "label": label, "text": txt, "box": box[i], "landmark": lm[i],
                                 "disabled": dis_l[i], "attrs": dict(sorted(attrs.items()))})
            # a frame's contents come right after its <iframe> (document order)
            child = None
            if i in cdoc:
                child = (pi, cdoc[i])
            elif (pi, bids[i]) in look.oopif_of:
                child = (look.oopif_of[(pi, bids[i])], 0)
            if not child or box[i] is None:
                continue
            s = styles[lay[i]]
            if not s:
                continue
            bx, by, bw, bh = bounds[lay[i]]
            bl, bt, br, bb = (_px(st[s[S_BL]]), _px(st[s[S_BT]]), _px(st[s[S_BR]]), _px(st[s[S_BB]]))
            pl, pt, pr, pb = (_px(st[s[S_PL]]), _px(st[s[S_PT]]), _px(st[s[S_PR]]), _px(st[s[S_PB]]))
            cox, coy = box[i][0] + bl + pl, box[i][1] + bt + pt
            cw, ch = bw - (bl + pl + br + pr), bh - (bt + pt + bb + pb)
            nclip = _meet(eff[i], (cox, coy, cox + cw, coy + ch))
            if vis[i] and nclip[0] < nclip[2] and nclip[1] < nclip[3]:
                await self._walk(look, procs, child[0], child[1], cox, coy, nclip, lm[i])
            elif self.walk_hidden_frames:   # a hidden frame: walked for the hooks, never candidates
                save = look.out
                look.out = []
                await self._walk(look, procs, child[0], child[1], cox, coy, (0, 0, 0, 0), lm[i])
                look.out = save


async def _detach(session) -> None:
    try:
        await asyncio.wait_for(session.detach(), 2)
    except Exception:  # noqa: BLE001
        pass


async def extract(page, viewport: tuple[int, int]) -> Extraction:
    """One look, opening and closing its own sessions (Extractor reuses them)."""
    ex = await Extractor(page, viewport).open()
    try:
        return await ex.extract()
    finally:
        await ex.close()
