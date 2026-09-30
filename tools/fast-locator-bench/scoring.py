"""Click-only scoring, the experiment's rules (its scripts/harness/scoring.py, section 2c of the report)
for an answer that is a point on the screen:

- T1, T4 (find the target): correct when the click point lies inside the target element's own box,
  or inside the box of the candidate the extractor maps it to (the element itself, else its
  nearest listed ancestor), or inside a twin candidate's box (deviation D2: the target listed
  twice, a list item and its link). Boxes come from the page as it is when the step runs (the
  experiment's note (b)); twins from the ground-truth render when there is one.
- T2 (the target isn't on the page): correct when the answer is "not found".

"Not found" is the positive class for precision, recall and F1, over T1, T2 and T4 trials.
"""
from __future__ import annotations


def inside(pt, box) -> bool:
    return box is not None and box[0] <= pt[0] <= box[2] and box[1] <= pt[1] <= box[3]


def target_boxes(trial: dict, tracked: dict, live_boxes: list, twins: list, render_boxes: list | None) -> list:
    """Every box a click on the target may land in."""
    gid = trial.get("target_gt_id")
    tgt = tracked.get(gid) if gid else None
    out = []
    if tgt:
        out.append(tgt.get("box"))
        if tgt.get("index") is not None and tgt["index"] < len(live_boxes):
            out.append(live_boxes[tgt["index"]])
    for i in twins or []:
        src = render_boxes if render_boxes is not None else live_boxes
        if 0 <= i < len(src):
            out.append(src[i])
    return [b for b in out if b]


def score(trial: dict, at, boxes: list) -> bool:
    """`at` is the click point, or None for "not found"."""
    if trial["task"] == "T2":
        return at is None
    return at is not None and any(inside(at, b) for b in boxes)


def not_found_f1(rows: list[dict]) -> dict:
    """Precision, recall and F1 of "not found" (positive: the trial is T2; predicted: no answer)."""
    tp = sum(1 for r in rows if r["task"] == "T2" and r["at"] is None)
    fp = sum(1 for r in rows if r["task"] != "T2" and r["at"] is None)
    fn = sum(1 for r in rows if r["task"] == "T2" and r["at"] is not None)
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0, "tp": tp, "fp": fp, "fn": fn}
