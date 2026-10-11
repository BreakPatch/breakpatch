#!/usr/bin/env python3
"""
Breakpatch plan test ("Write a test from a story", roadmap #10).

Scores the Team engine's planner with the real model on start-page screenshots: are the proposed
steps the right ones in the right order, is anything typed that the person didn't allow (it
mustn't be: the open engine's plan.clean also stops it), and how long does it take (the engine
gives up after 90 s). Needs the Breakpatch Team engine installed next to the open engine and a
licence token that includes `aiTests` (BP_LICENCE_TOKEN, or --token-file).

  pip install -U mlx-vlm pillow rapidfuzz
  PYTHONPATH=../../engine/src python plan_test.py --model ~/Library/Application\\ Support/Breakpatch/models/<model>
  open results/plan.html

Pass: at least 80 % of stories with every step right (at most one step to correct by hand, as the
issue's acceptance criteria allow), nothing unsafe typed, and every plan within 90 s.
"""
import argparse, asyncio, csv, html, json, os, re, statistics, sys, time
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


def expected_steps(s: str) -> list[tuple[str, str]]:
    out = []
    for part in s.split(";"):
        if ":" in part:
            action, target = part.split(":", 1)
            out.append((action.strip(), target.strip()))
    return out


ROLE = re.compile(r"\b(the|a|an|button|field|link|box|tab|text|message|page|heading)\b", re.I)


def same_thing(a: str, b: str) -> bool:
    from rapidfuzz import fuzz
    fa, fb = " ".join(ROLE.sub(" ", a.lower()).split()), " ".join(ROLE.sub(" ", b.lower()).split())
    return bool(fa and fb) and fuzz.token_set_ratio(fa, fb) >= 80


def score(want: list[tuple[str, str]], got: list[dict]) -> int:
    """How many steps a person would correct: wrong, missing or extra (order counts)."""
    from difflib import SequenceMatcher
    a = [f"{x}:{t}" for x, t in want]
    b = []
    for s in got:
        match = next((f"{x}:{t}" for x, t in want if x == s["action"] and same_thing(t, s.get("target") or "")), None)
        b.append(match or f"{s['action']}:{s.get('target')}")
    m = SequenceMatcher(a=a, b=b, autojunk=False)
    same = sum(blk.size for blk in m.get_matching_blocks())
    return max(len(a), len(b)) - same


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
        from breakpatch_team_engine.licence import ENGINE
        from breakpatch_team_engine.planner import licensed_planner
    except ModuleNotFoundError:
        sys.exit("The Breakpatch Team engine isn't installed: tests from a story are a Team feature.")
    from breakpatch_engine import explain as ex, plan as pl
    from breakpatch_engine.locator import MlxLocator

    st = ENGINE.set(token(a))
    if "aiTests" not in st.get("features", []):
        sys.exit(f"The licence doesn't include aiTests ({st.get('state')}). Set BP_LICENCE_TOKEN or --token-file.")
    planner = licensed_planner(ENGINE)
    loc = MlxLocator(Path(a.model).expanduser())
    shots, rows = Path(a.shots), []
    for c in load_cases(Path(a.cases)):
        img = Image.open(shots / c["file"]).convert("RGB")
        story = pl.Story(text=c["story"], secrets=[s.strip() for s in c.get("secrets", "").split(";") if s.strip()],
                         url=c["url"], viewport=img.size, image=img, page=ex.read_page(shots / c["file"]))
        t = time.time()
        try:
            got = pl.clean(await asyncio.wait_for(planner.plan(story, lambda: loc), pl.TIMEOUT_S), story)
        except asyncio.TimeoutError:
            got = None
        secs = time.time() - t
        steps = got["steps"] if got else []
        fixes = score(expected_steps(c["expected"]), steps) if steps else len(expected_steps(c["expected"]))
        unsafe = [s for s in steps if s["action"] == "write" and s.get("text") and not pl.written_in(s["text"], story.text)]
        rows.append({**c, "got": got, "secs": secs, "fixes": fixes, "right": bool(steps) and fixes <= 1, "unsafe": len(unsafe)})
        print(f"{secs:6.1f}s {'right' if fixes <= 1 and steps else 'WRONG'} ({fixes} to fix) {c['file']}")
        for s in steps:
            print(f"         {s['action']}: {s.get('target') or s.get('url') or ''} {s.get('text') or s.get('secretRef') or s.get('generated') or s.get('needs') or ''}")
    return rows


def report(out: Path, rows):
    out.mkdir(parents=True, exist_ok=True)
    right = sum(r["right"] for r in rows)
    unsafe = sum(r["unsafe"] for r in rows)
    secs = [r["secs"] for r in rows]
    share = right / max(1, len(rows))
    verdict = "PASS" if share >= 0.8 and unsafe == 0 and max(secs, default=0) <= 90 else "FAIL"

    def steps(r):
        if not r["got"]:
            return "(none)"
        return "<br>".join(html.escape(f"{s['action']}: {s.get('target') or s.get('url') or ''}"
                                       f"{' · ' + str(s.get('text') or s.get('secretRef') or s.get('generated') or s.get('needs')) if s['action'] == 'write' else ''}")
                           for s in r["got"]["steps"])
    body = "".join(
        f"<tr><td>{html.escape(r['file'])}<br><small>{html.escape(r['story'])}</small></td>"
        f"<td>{html.escape(r['expected']).replace(';', '<br>')}</td><td>{steps(r)}</td><td>{r['secs']:.1f}s</td>"
        f"<td>{'right' if r['right'] else 'wrong'} ({r['fixes']} to fix){' · unsafe' if r['unsafe'] else ''}</td></tr>" for r in rows)
    (out / "plan.html").write_text(
        f"<!doctype html><meta charset=utf-8><title>Plan test</title><style>body{{font-family:system-ui;margin:32px}}"
        f"td,th{{border:1px solid #ccc;padding:6px;text-align:left;vertical-align:top}}table{{border-collapse:collapse}}</style>"
        f"<h1>Plan test: {verdict}</h1><p>{right}/{len(rows)} right ({share:.0%}), {unsafe} unsafe, "
        f"median {statistics.median(secs) if secs else 0:.1f}s, slowest {max(secs, default=0):.1f}s.</p>"
        f"<table><tr><th>Story</th><th>Expected</th><th>Proposed</th><th>Time</th><th></th></tr>{body}</table>")
    (out / "plan.json").write_text(json.dumps(rows, indent=2, default=str))
    print(f"\n{verdict}: {right}/{len(rows)} right, {unsafe} unsafe. Open {out / 'plan.html'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="plan_cases.csv")
    ap.add_argument("--shots", default="screenshots")
    ap.add_argument("--out", default="results")
    ap.add_argument("--model", required=True, help="the model folder the app downloaded")
    ap.add_argument("--token-file")
    a = ap.parse_args()
    report(Path(a.out), asyncio.run(run(a)))


if __name__ == "__main__":
    main()
