"""Following marked elements through the extractor (tests and tools/fast-locator-bench only).

The experiment's pages mark their targets with `data-gt-id`. TrackingExtractor records, for each
marked element, its own box, whether it's visible, and which candidate it maps to: itself, else
its nearest listed ancestor (a hidden element never maps to an ancestor). The result is in
`extraction.tracked`: {marker: {index, mapped, box, visible}}.
"""
from __future__ import annotations

from breakpatch_engine.dom.extract import Extraction, Extractor, Look

TRACK = "data-gt-id"


class TrackingExtractor(Extractor):
    walk_hidden_frames = True       # marked elements in hidden iframes are still measured

    def __init__(self, page, viewport, ax_mode: str = "auto", attr: str = TRACK):
        super().__init__(page, viewport, ax_mode)
        self.attr = attr

    def _element(self, look: Look, key, attrs, box, visible, ancestors) -> None:
        gid = attrs.get(self.attr)
        if gid is not None:
            look.extra.setdefault("gt", {})[gid] = {"key": key, "anc": ancestors(), "box": box, "visible": visible}

    def _finish(self, look: Look, candidates: list[dict]) -> None:
        node_to_idx = {c["_key"]: c["index"] for c in candidates}
        tracked = {}
        for gid, g in look.extra.pop("gt", {}).items():
            idx, mapped = None, None
            if g["key"] in node_to_idx:
                idx, mapped = node_to_idx[g["key"]], "self"
            elif g["visible"]:
                for a in g["anc"]:
                    if a in node_to_idx:
                        idx, mapped = node_to_idx[a], "ancestor"
                        break
            tracked[gid] = {"index": idx, "mapped": mapped, "box": g["box"], "visible": g["visible"]}
        look.extra["tracked"] = tracked


def tracked(ex: Extraction) -> dict:
    return ex.extra.get("tracked", {})


async def extract_tracked(page, viewport=(1440, 900), ax_mode: str = "auto") -> Extraction:
    ex = await TrackingExtractor(page, viewport, ax_mode).open()
    try:
        return await ex.extract()
    finally:
        await ex.close()
