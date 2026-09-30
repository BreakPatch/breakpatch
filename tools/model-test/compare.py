#!/usr/bin/env python3
"""
Compares two model-test runs: accuracy, hard-case accuracy, speed, and every case where they
disagree. This is how "within 5 points of MLX 4B" (plan §2.4) is checked.

  python compare.py results/mlx/results.json results/llamacpp/results.json
  python compare.py A.json:4b B.json:Qwen3-VL-4B-Instruct-Q4_K_M     # pick a run from a file with several
  python compare.py A.json B.json --points 5 --json                   # also print the comparison as JSON

The first file is the reference (A). Exit code 0 when B's overall and hard-case accuracy are
within --points of A's, 1 when they aren't, 2 when the files can't be compared.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from model_test import percentile, summarise  # noqa: E402


def load_run(spec: str) -> tuple[dict, dict]:
    """"file.json" or "file.json:key" → (the run, the file's document). Reads results version 2
    and the older list of runs."""
    path, _, key = spec.partition(".json:")
    path = path + ".json" if key else spec
    try:
        doc = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise SystemExit(f"compare: can't read {path}: {e}")
    runs = doc if isinstance(doc, list) else doc.get("runs", [])
    if isinstance(doc, list):
        doc = {"runs": runs, "machine": {}, "set": "?"}
    if not runs:
        raise SystemExit(f"compare: {path} has no runs")
    if key:
        found = [r for r in runs if r.get("key") == key]
        if not found:
            raise SystemExit(f"compare: {path} has no run {key!r}; it has {', '.join(r.get('key', '?') for r in runs)}")
        run = found[0]
    elif len(runs) == 1:
        run = runs[0]
    else:
        raise SystemExit(f"compare: {path} has {len(runs)} runs ({', '.join(r.get('key', '?') for r in runs)}): "
                         f"name one as {path}:KEY")
    for r in run["results"]:
        r.setdefault("hard", False)
    if "summary" not in run:          # results version 1
        run["summary"] = summarise(run["results"])
    run.setdefault("runtime", "mlx")
    return run, doc


def label(run: dict) -> str:
    return f"{run.get('key')} ({run.get('runtime')}{', ' + str(run['device']) if run.get('device') else ''})"


def outcome(r: dict | None) -> str:
    if r is None:
        return "not run"
    if r["hit"] is None:
        return "box" if r["box"] else "no box"
    return "hit" if r["hit"] else ("miss" if r["box"] else "no box")


def ratio(b, a):
    return None if not a or b is None else b / a


def compare(a: dict, b: dict, points: float) -> dict:
    ra = {(r["file"], r["desc"]): r for r in a["results"]}
    rb = {(r["file"], r["desc"]): r for r in b["results"]}
    both = [k for k in ra if k in rb]
    only_a = [k for k in ra if k not in rb]
    only_b = [k for k in rb if k not in ra]
    # Accuracy on the cases both ran, so a shorter run isn't flattered.
    sa = summarise([ra[k] for k in both])
    sb = summarise([rb[k] for k in both])

    def diff(x, y):
        return None if x is None or y is None else round(y - x, 1)

    disagree = []
    for k in both:
        x, y = ra[k], rb[k]
        if outcome(x) != outcome(y):
            disagree.append({"file": k[0], "desc": k[1], "hard": bool(x.get("hard") or y.get("hard")),
                             "a": outcome(x), "b": outcome(y), "aBox": x["box"], "bBox": y["box"],
                             "aRaw": x.get("raw", ""), "bRaw": y.get("raw", "")})
    acc_d, hard_d = diff(sa["accuracy"], sb["accuracy"]), diff(sa["hardAccuracy"], sb["hardAccuracy"])
    within = (acc_d is not None and acc_d >= -points) and (hard_d is None or hard_d >= -points)
    return {
        "a": label(a), "b": label(b), "cases": len(both), "onlyA": len(only_a), "onlyB": len(only_b),
        "accuracy": {"a": sa["accuracy"], "b": sb["accuracy"], "points": acc_d},
        "hardAccuracy": {"a": sa["hardAccuracy"], "b": sb["hardAccuracy"], "points": hard_d},
        "medianS": {"a": sa["medianS"], "b": sb["medianS"], "ratio": ratio(sb["medianS"], sa["medianS"])},
        "p90S": {"a": sa["p90S"], "b": sb["p90S"],
                 "ratio": ratio(percentile([rb[k]["secs"] for k in both], 90), percentile([ra[k]["secs"] for k in both], 90))},
        "prefillS": {"a": sa.get("medianPrefillS"), "b": sb.get("medianPrefillS")},
        "decodeS": {"a": sa.get("medianDecodeS"), "b": sb.get("medianDecodeS")},
        "points": points, "within": within, "disagree": disagree,
    }


def pct(v):
    return "n/a" if v is None else f"{v:.1f} %"


def secs(v):
    return "n/a" if v is None else f"{v:.2f} s"


def times(v):
    return "n/a" if v is None else f"{v:.2f}x"


def signed(v):
    return "n/a" if v is None else f"{v:+.1f} points"


def print_report(c: dict, ma: dict, mb: dict) -> None:
    print(f"A: {c['a']}  on {ma.get('cpu', '?')}, {ma.get('os', '?')}")
    print(f"B: {c['b']}  on {mb.get('cpu', '?')}, {mb.get('os', '?')}")
    print(f"{c['cases']} cases in both" + (f" ({c['onlyA']} only in A, {c['onlyB']} only in B)" if c["onlyA"] or c["onlyB"] else ""))
    print()
    print(f"{'':16}{'A':>12}{'B':>12}   B against A")
    print(f"{'correct':16}{pct(c['accuracy']['a']):>12}{pct(c['accuracy']['b']):>12}   {signed(c['accuracy']['points'])}")
    print(f"{'hard cases':16}{pct(c['hardAccuracy']['a']):>12}{pct(c['hardAccuracy']['b']):>12}   {signed(c['hardAccuracy']['points'])}")
    print(f"{'median answer':16}{secs(c['medianS']['a']):>12}{secs(c['medianS']['b']):>12}   {times(c['medianS']['ratio'])} the time")
    print(f"{'p90 answer':16}{secs(c['p90S']['a']):>12}{secs(c['p90S']['b']):>12}   {times(c['p90S']['ratio'])} the time")
    if c["prefillS"]["a"] is not None or c["prefillS"]["b"] is not None:
        print(f"{'median prefill':16}{secs(c['prefillS']['a']):>12}{secs(c['prefillS']['b']):>12}")
        print(f"{'median decode':16}{secs(c['decodeS']['a']):>12}{secs(c['decodeS']['b']):>12}")
    print()
    verdict = "yes" if c["within"] else "no"
    print(f"B within {c['points']:g} points of A (overall and hard cases): {verdict}")
    print()
    if not c["disagree"]:
        print("They agree on every case.")
        return
    print(f"{len(c['disagree'])} cases where they disagree:")
    for d in c["disagree"]:
        hard = " (hard)" if d["hard"] else ""
        print(f"  {d['file']}: {d['desc']}{hard}")
        print(f"      A {d['a']:<7} {d['aBox']}   {d['aRaw'][:80]!r}")
        print(f"      B {d['b']:<7} {d['bBox']}   {d['bRaw'][:80]!r}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Compare two model-test runs")
    ap.add_argument("a", help="the reference run: results.json or results.json:KEY")
    ap.add_argument("b", help="the run to compare with it")
    ap.add_argument("--points", type=float, default=5.0, help="how far below A's accuracy B may be (default 5)")
    ap.add_argument("--json", action="store_true", help="print the comparison as JSON too")
    args = ap.parse_args(argv)
    try:
        a, da = load_run(args.a)
        b, db = load_run(args.b)
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 2
    c = compare(a, b, args.points)
    if not c["cases"]:
        print("compare: the two runs have no case in common", file=sys.stderr)
        return 2
    print_report(c, da.get("machine") or {}, db.get("machine") or {})
    if args.json:
        print(json.dumps(c, indent=2))
    return 0 if c["within"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
