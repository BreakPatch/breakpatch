"""The visible controls of the current viewport, read through the DevTools protocol.

Ported from the System 1 experiment's harness (`scripts/harness/extract.py`, 11 tests, p50 39 ms
on a 400-control page). The keep, drop and dedup rules are the harness's, unchanged; what differs
is the transport: the engine's own Playwright CDP sessions (async), where the harness opened a
DevTools port and talked to it directly. The engine opens no port (any program on the Mac could
drive the browser through it), so every message goes through Playwright's driver.

Per renderer process (the page, and one per out-of-process cross-site iframe):
- `DOMSnapshot.captureSnapshot` gives every node of every document in that process, flattened,
  open AND closed shadow roots included (DevTools pierces both), with layout boxes, 7 computed
  styles, attributes, input values, Blink's `isClickable` bit and the content document of
  same-process iframes.
- The accessibility tree gives roles, names, descriptions and states: `getFullAXTree` for the
  document, or, when only a small part of a big document is on screen, `getPartialAXTree` for the
  visible elements and their ancestors (the landmarks), sent all at once. Both give the same
  objects for every node that can become a candidate (tested); partial is about 2.5x faster on a
  400-control page, full is faster on small ones.

Boxes are viewport pixels: a document's own bounds, minus its scroll, plus the origin of its
iframe's content box (border and padding) in the parent viewport, recursively. A node inside an
iframe must also sit inside that iframe's visible content rect. CSS transforms or zoom on an
<iframe> aren't handled.

A node is kept when its box meets the viewport (and every enclosing iframe's), it has a size, it is
`visibility: visible` with no opacity 0 on it or an ancestor, AND it is interactive and enabled or
it has a non-empty accessible name.

Interactive means one of
- strong: an AX role in STRONG_ROLES (cells and rows only when focusable), or a native control
  (a[href], button, input other than hidden, select, textarea, summary, contenteditable);
- weak (click-listener stand-ins, for div soup): tabindex >= 0; Blink's isClickable (not on
  html/body, nor on a box over half the viewport, which is a listener delegated to the root);
  cursor:pointer where the parent's cursor isn't (it inherits, so only the outermost counts).

Nested wrappers are merged:
- a weak-only interactive node inside an interactive one is dropped (the outer one wins);
- a named non-interactive node inside an interactive one is dropped (an <img alt> in a link);
- a named non-interactive node that contains a kept interactive one is dropped (cells, rows,
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

Nothing here is kept between steps: a node's index only means something in the list it came from.
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
          "padding-left", "padding-top"]
S_VIS, S_OP, S_CUR, S_BL, S_BT, S_PL, S_PT = range(7)

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
# aria-* attributes that hold element ids. Some pages make new ids on every load (the experiment's
# note (a)), so they never count towards a list's identity (list_hash).
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
    # Only with `track`: attribute value -> {index, mapped, box, visible} (tests and the benchmark)
    tracked: dict = field(default_factory=dict)

    @property
    def count(self) -> int:
        return len(self.candidates)

    @property
    def list_hash(self) -> str:
        return list_hash(self.viewport, self.candidates)


class _Proc:
    """One renderer process (the page or an out-of-process iframe): its CDP session and the
    <iframe> that owns it."""

    def __init__(self, session, frame_id=None, owner=None):
        self.s = session
        self.frame_id = frame_id      # None for the page itself
        self.owner = owner            # (proc index, backendNodeId) of the owning <iframe>


class Extractor:
    """CDP sessions for one page (one per renderer process), opened once and reused for every
    `extract()` until the page navigates or its frames change (`stale()`).

    `track`: an attribute name whose elements are followed even when they aren't candidates
    (their own box, and the candidate they map to). Only the tests and the benchmark use it
    (`data-gt-id` on the experiment's pages); the engine never does.
    """

    def __init__(self, page, viewport: tuple[int, int], track: str | None = None, ax_mode: str = "auto"):
        self.page = page
        self.viewport = (int(viewport[0]), int(viewport[1]))
        self.track = track
        self.ax_mode = ax_mode        # "auto", "full" or "partial" (the tests compare them)
        self.procs: list[_Proc] = []
        self._frames: tuple = ()

    async def open(self) -> "Extractor":
        ctx = self.page.context
        self.procs = [_Proc(await ctx.new_cdp_session(self.page))]
        self._frames = tuple(self.page.frames)
        for f in self._frames[1:]:
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
        """Whether the page's frames changed since the sessions were opened."""
        try:
            return self.page.is_closed() or tuple(self.page.frames) != self._frames
        except Exception:  # noqa: BLE001
            return True

    async def close(self) -> None:
        for p in self.procs:
            await _detach(p.s)
        self.procs = []

    # ------------------------------------------------------------------ extraction

    async def _ax(self, pi: int, snap: dict, doc: dict, ax: dict, want: list[int], n: int) -> None:
        """AX nodes for one document into `ax` (backendNodeId -> node): its visible elements and
        their ancestors (`want`, node indexes) and, in full mode, the rest."""
        s = self.procs[pi].s
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
        snaps = await asyncio.gather(*(p.s.send("DOMSnapshot.captureSnapshot", {"computedStyles": STYLES})
                                       for p in self.procs))
        axmaps: list[dict] = [{} for _ in self.procs]
        oopif_of = {p.owner: i for i, p in enumerate(self.procs) if p.owner}
        self._out, self._gt = [], {}
        self._flutter, self._canvas = False, 0.0
        vw, vh = self.viewport
        await self._walk(snaps, axmaps, oopif_of, 0, 0, 0.0, 0.0, (0.0, 0.0, float(vw), float(vh)), "")
        cands = self._out
        for k, c in enumerate(cands):
            c["index"] = k
        tracked = {}
        if self.track:
            node_to_idx = {c["_key"]: c["index"] for c in cands}
            for gid, g in self._gt.items():
                idx, mapped = None, None
                if g["key"] in node_to_idx:
                    idx, mapped = node_to_idx[g["key"]], "self"
                else:
                    for a in (g["anc"] if g["visible"] else []):   # a hidden node never maps to an ancestor
                        if a in node_to_idx:
                            idx, mapped = node_to_idx[a], "ancestor"
                            break
                tracked[gid] = {"index": idx, "mapped": mapped, "box": g["box"], "visible": g["visible"]}
        pub = [{k: c[k] for k in PUBLIC} for c in cands]
        ms = (time.perf_counter() - t0) * 1000
        return Extraction(self.viewport, pub, round(ms, 2), self._flutter, round(self._canvas, 4),
                          len(self.procs), sum(len(s["documents"]) for s in snaps), tracked)

    async def _walk(self, snaps, axmaps, oopif_of, pi, di, ox, oy, clip, parent_lm):
        snap, ax = snaps[pi], axmaps[pi]
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
        sx, sy = d.get("scrollOffsetX", 0) or 0, d.get("scrollOffsetY", 0) or 0
        vw, vh = self.viewport
        cx1, cy1, cx2, cy2 = clip
        track = self.track

        op0, ptr, inter, ianc = [False] * n, [False] * n, [False] * n, [False] * n
        lm, box, vis = [parent_lm] * n, [None] * n, [False] * n
        strong_l, tagn, attrd, role_l = [False] * n, [""] * n, [None] * n, [None] * n
        axn, ownptr = [None] * n, [False] * n
        # pass A: geometry and styles
        for i in range(n):
            p = parent[i]
            if p >= 0:
                op0[i] = op0[p]
                ptr[i] = ptr[p]
            if types[i] != 1:
                continue
            tagn[i] = st[names[i]]
            if tagn[i] in FLUTTER_TAGS:
                self._flutter = True
            a = attrs_l[i]
            attrd[i] = {st[a[k]]: st[a[k + 1]] for k in range(0, len(a), 2)} if a else {}
            li = lay.get(i)
            if li is None:
                continue
            s = styles[li]
            own_ptr = st[s[S_CUR]] == "pointer" if s else False
            ownptr[i] = own_ptr and not (ptr[p] if p >= 0 else False)
            ptr[i] = own_ptr
            if s and st[s[S_OP]] in ("0", "0.0"):
                op0[i] = True
            bx, by, bw, bh = bounds[li]
            x1 = bx - sx + ox
            y1 = by - sy + oy
            b = [round(x1, 1), round(y1, 1), round(x1 + bw, 1), round(y1 + bh, 1)]
            box[i] = b
            vis[i] = bool(bw > 0 and bh > 0 and b[0] < cx2 and b[2] > cx1 and b[1] < cy2 and b[3] > cy1
                          and s and st[s[S_VIS]] == "visible" and not op0[i])
            if vis[i] and tagn[i] == "CANVAS":
                seen = (max(0.0, min(b[2], cx2) - max(b[0], cx1)) * max(0.0, min(b[3], cy2) - max(b[1], cy1)))
                self._canvas = max(self._canvas, seen / (vw * vh))
        # AX for the visible elements and all their ancestors (landmarks)
        want: set[int] = set()
        for i in range(n):
            if vis[i]:
                j = i
                while j >= 0 and j not in want:
                    if types[j] == 1:
                        want.add(j)
                    j = parent[j]
        await self._ax(pi, snap, d, ax, sorted(want), n)
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

        # candidates, before named containers are merged
        is_int_c, named, nm_l, dis_l = [False] * n, [False] * n, [""] * n, [False] * n
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
                is_int_c[i] = True
            elif nm and role_l[i] not in NOT_NAMED_ROLES and not ianc[i]:
                named[i] = True
        # containers of kept interactive candidates lose their "named" status
        has_desc = [False] * n
        for i in range(n - 1, -1, -1):
            p = parent[i]
            if p >= 0 and (has_desc[i] or is_int_c[i]):
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

        for i in range(n):
            if track and types[i] == 1:
                gid = attrd[i].get(track) if attrd[i] else None
                if gid is not None:
                    anc, p = [], parent[i]
                    while p >= 0:
                        anc.append((pi, di, p))
                        p = parent[p]
                    self._gt[gid] = {"key": (pi, di, i), "anc": anc, "box": box[i], "visible": vis[i]}
            keep = False
            if is_int_c[i]:
                keep = (not dis_l[i]) or bool(nm_l[i])
            elif named[i] and not has_desc[i]:
                keep = True
            if keep:
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
                self._out.append({"_key": (pi, di, i), "role": role_l[i] or "generic", "name": nm_l[i],
                                  "label": label, "text": txt, "box": box[i], "landmark": lm[i],
                                  "disabled": dis_l[i], "attrs": dict(sorted(attrs.items()))})
            # a frame's contents come right after its <iframe> (document order)
            child = None
            if i in cdoc:
                child = (pi, cdoc[i])
            elif (pi, bids[i]) in oopif_of:
                child = (oopif_of[(pi, bids[i])], 0)
            if child and box[i] is not None:
                li = lay[i]
                s = styles[li]
                bx, by, bw, bh = bounds[li]
                blw, btw, plw, ptw = (_px(st[s[S_BL]]), _px(st[s[S_BT]]),
                                      _px(st[s[S_PL]]), _px(st[s[S_PT]]))
                cox, coy = box[i][0] + blw + plw, box[i][1] + btw + ptw
                cw, ch = bw - 2 * (blw + plw), bh - 2 * (btw + ptw)
                nclip = (max(cx1, cox), max(cy1, coy), min(cx2, cox + cw), min(cy2, coy + ch))
                if vis[i] and nclip[0] < nclip[2] and nclip[1] < nclip[3]:
                    await self._walk(snaps, axmaps, oopif_of, child[0], child[1], cox, coy, nclip, lm[i])
                elif track:   # a hidden frame: its tracked boxes are still measured, never candidates
                    save = self._out
                    self._out = []
                    await self._walk(snaps, axmaps, oopif_of, child[0], child[1], cox, coy, (0, 0, 0, 0), lm[i])
                    self._out = save


async def _detach(session) -> None:
    try:
        await asyncio.wait_for(session.detach(), 2)
    except Exception:  # noqa: BLE001
        pass


async def extract(page, viewport: tuple[int, int], track: str | None = None) -> Extraction:
    """One look, opening and closing its own sessions (Extractor reuses them)."""
    ex = await Extractor(page, viewport, track).open()
    try:
        return await ex.extract()
    finally:
        await ex.close()
