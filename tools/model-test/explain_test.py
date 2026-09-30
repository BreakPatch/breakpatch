#!/usr/bin/env python3
"""
Breakpatch explanation test ("Why did this fail?", roadmap #7).

Scores the Team engine's explanations with the real model on failure screenshots: is the likely
cause right, is anything made up for a target that is visible where it was, and how long does it
take (the report asks for at most 10 s). Needs the Breakpatch Team engine installed next to the
open engine and a licence token that includes `explain` (BP_LICENCE_TOKEN, or --token-file, e.g.
breakpatch-ci's licence.json).

  pip install -U mlx-vlm pillow
  PYTHONPATH=../../engine/src python explain_test.py --model ~/Library/Application\\ Support/Breakpatch/models/<model>
  open results/explain.html

Pass: at least 80 % right and none made up.
"""
import argparse, asyncio, csv, html, json, os, statistics, sys, time
from pathlib import Path

from PIL import Image


def load_cases(path: Path):
    out = []
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if not row.get("file") or row["file"].startswith("#"):
                continue
            out.append({k: (v or "").strip() for k, v in row.items() if k})
    return out


def made_up(case, got) -> bool:
    if case.get("visible_where_it_was") != "yes" or not got:
        return False
    s = got["summary"].lower()
    says_gone = "isn't where it was" in s or "no longer" in s or "wasn't on the screen" in s
    return says_gone or got["cause"] == "moved" or (got["cause"] == "realBug" and case["reason"] != "noChange")


def token(a) -> str | None:
    if os.environ.get("BP_LICENCE_TOKEN"):
        return os.environ["BP_LICENCE_TOKEN"]
    if a.token_file:
        raw = Path(a.token_file).expanduser().read_text()
        try:
            return json.loads(raw).get("token")
        except ValueError:
            return raw.strip()
    return None


async def run(a):
    try:
        from breakpatch_team_engine.explain import licensed_explainer
        from breakpatch_team_engine.licence import ENGINE
    except ModuleNotFoundError:
        sys.exit("The Breakpatch Team engine isn't installed: explanations are a Team feature.")
    from breakpatch_engine import explain as ex
    from breakpatch_engine.locator import MlxLocator

    st = ENGINE.set(token(a))
    if "explain" not in st.get("features", []):
        sys.exit(f"The licence doesn't include explain ({st.get('state')}). Set BP_LICENCE_TOKEN or --token-file.")
    explainer = licensed_explainer(ENGINE)
    loc = MlxLocator(Path(a.model).expanduser())
    shots, rows = Path(a.shots), []
    for c in load_cases(Path(a.cases)):
        img = Image.open(shots / c["file"]).convert("RGB")
        page = ex.read_page(shots / c["file"]) if c.get("page") == "yes" else None
        step = {"id": "case", "action": "click", "target": c["target"], "at": [float(c["at_x"]), float(c["at_y"])]}
        f = ex.Failure(step=step, reason=c["reason"], viewport=img.size, image=img, page=page)
        t = time.time()
        try:
            got = ex.clean(await asyncio.wait_for(explainer.explain(f, lambda: loc), ex.TIMEOUT_S))
        except asyncio.TimeoutError:
            got = None
        secs = time.time() - t
        right = bool(got) and got["cause"] == c["expected_cause"]
        rows.append({**c, "got": got, "secs": secs, "right": right, "madeUp": made_up(c, got)})
        print(f"{secs:5.2f}s {'right' if right else 'WRONG'} {c['file']}: {got['summary'] if got else '(none)'}")
    return rows


def report(out: Path, rows):
    out.mkdir(parents=True, exist_ok=True)
    right = sum(r["right"] for r in rows)
    made = sum(r["madeUp"] for r in rows)
    secs = [r["secs"] for r in rows]
    share = right / max(1, len(rows))
    verdict = "PASS" if share >= 0.8 and made == 0 and max(secs, default=0) <= 10 else "FAIL"
    body = "".join(
        f"<tr><td>{html.escape(r['file'])}<br><small>{html.escape(r['reason'])}: {html.escape(r['target'])}</small></td>"
        f"<td>{html.escape(r['expected_cause'])}</td><td>{html.escape(r['got']['cause'] if r['got'] else '-')}</td>"
        f"<td>{html.escape(r['got']['summary'] if r['got'] else '(none)')}</td><td>{r['secs']:.2f}s</td>"
        f"<td>{'right' if r['right'] else 'wrong'}{' · made up' if r['madeUp'] else ''}</td></tr>" for r in rows)
    (out / "explain.html").write_text(
        f"<!doctype html><meta charset=utf-8><title>Explanation test</title><style>body{{font-family:system-ui;margin:32px}}"
        f"td,th{{border:1px solid #ccc;padding:6px;text-align:left;vertical-align:top}}table{{border-collapse:collapse}}</style>"
        f"<h1>Explanation test: {verdict}</h1><p>{right}/{len(rows)} right ({share:.0%}), {made} made up, "
        f"median {statistics.median(secs) if secs else 0:.2f}s, slowest {max(secs, default=0):.2f}s.</p>"
        f"<table><tr><th>Case</th><th>Expected</th><th>Got</th><th>Explanation</th><th>Time</th><th></th></tr>{body}</table>")
    (out / "explain.json").write_text(json.dumps(rows, indent=2, default=str))
    print(f"\n{verdict}: {right}/{len(rows)} right, {made} made up. Open {out / 'explain.html'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="explain_cases.csv")
    ap.add_argument("--shots", default="screenshots")
    ap.add_argument("--out", default="results")
    ap.add_argument("--model", required=True, help="the model folder the app downloaded")
    ap.add_argument("--token-file")
    a = ap.parse_args()
    report(Path(a.out), asyncio.run(run(a)))


if __name__ == "__main__":
    main()
