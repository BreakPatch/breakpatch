"""Fast locator benchmark: runs a sample of the System 1 experiment's corpus through the engine's
new `record.locate` path (router, then S0, then the AI assistant when S0 is unsure) and scores it
click-only. See README.md.

    engine/.venv/bin/python tools/fast-locator-bench/bench.py --corpus ~/breakpatch-corpus \\
        --excluded ~/breakpatch-fast-locator-handoff/reference_code/results/excluded_trials.json
    engine/.venv/bin/python tools/fast-locator-bench/bench.py --fixtures --no-model   # no corpus
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import platform
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "engine" / "tests"))   # the shared page server and target tracking
try:
    import breakpatch_engine  # noqa: F401
except ImportError:            # not installed in this Python: use the checkout's
    sys.path.insert(0, str(REPO / "engine" / "src"))

import domsite  # noqa: E402
import domtrack  # noqa: E402
import scoring  # noqa: E402

PORT_MAIN = 8801               # and 8802 for the other origin, as the experiment served its corpus

LOCATE_TASKS = ("T1", "T2", "T4")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
TARGETS = {"dom_rich_t1": (0.88, 0.93), "fast_p50_ms": 12.0}
# What the experiment measured (M5 Pro, click-only, test pages), for the table.
EXPERIMENT = {"good": (0.79, 0.90, 0.93), "medium": (0.90, 0.81, 0.91), "poor": (0.94, 0.70, 0.94),
              "flutter": (0.80, 0.0, 0.78), "canvas": (0.62, 0.0, 0.38)}


# ---------------------------------------------------------------- corpus

def data_dir(corpus: Path) -> Path:
    return corpus / "data" if (corpus / "data" / "trials.jsonl").exists() else corpus


def read_csv(p: Path) -> dict:
    if not p.exists():
        return {}
    with open(p, newline="") as f:
        rows = list(csv.DictReader(f))
    key = "state_id" if rows and "state_id" in rows[0] else "page_id"
    return {r[key]: r for r in rows}


def read_trials(p: Path) -> list[dict]:
    with open(p) as f:
        return [json.loads(line) for line in f if line.strip()]


def kind(page: dict) -> str:
    """The report's page types: Flutter, canvas, else the page's DOM quality."""
    r = (page.get("rendering") or "").lower()
    if "flutter" in r:
        return "flutter"
    if "canvas" in r:
        return "canvas"
    return (page.get("dom_quality") or "unknown").lower()


def dom_rich(page: dict) -> bool:
    return (page.get("dom_quality") or "").lower() in ("good", "medium") and str(page.get("is_control", "0")) != "1"


def sample(trials: list[dict], pages: dict, frac: float, seed: int) -> list[dict]:
    """`frac` of the trials of every (DOM quality, rendering, page type) cell, at least one each."""
    cells = defaultdict(list)
    for t in trials:
        p = pages.get(t["page_id"], {})
        cells[(p.get("dom_quality"), p.get("rendering"), p.get("page_type"))].append(t)
    rng = random.Random(seed)
    out = []
    for key in sorted(cells, key=str):
        group = sorted(cells[key], key=lambda t: t["trial_id"])
        rng.shuffle(group)
        out += group[:max(1, math.ceil(frac * len(group)))] if frac < 1 else group
    return sorted(out, key=lambda t: (t["state_id"], t["trial_id"]))


# ---------------------------------------------------------------- browser

class NoModel:
    """--no-model: the AI assistant is 'there' but never finds anything (fallbacks count as not found)."""

    def available(self):
        return True

    async def locate(self, image, description):
        return None

    async def describe(self, image, at):
        return None


def the_model(path: str | None):
    from breakpatch_engine import install
    from breakpatch_engine.locator import MlxLocator
    if path is None:
        info = install.installed_model()
        if not info.get("installed"):
            raise SystemExit("bench: no AI assistant installed (Settings, AI assistant); pass --model PATH or --no-model")
        path = info["path"]
    loc = MlxLocator(Path(path))
    if not loc.available():
        raise SystemExit(f"bench: can't run the AI assistant from {path} (is mlx-vlm installed in this venv?)")
    return loc, str(path)


# ---------------------------------------------------------------- run

async def run(a) -> dict:
    from breakpatch_engine.browser import BrowserSession
    from breakpatch_engine.config import Timings
    from breakpatch_engine.protocol import NULL
    from breakpatch_engine.recorder import Recorder

    data = data_dir(Path(a.corpus))
    pages, states = read_csv(data / "pages.csv"), read_csv(data / "states.csv")
    trials = [t for t in read_trials(data / "trials.jsonl") if t["task"] in LOCATE_TASKS]
    if a.split != "all":
        trials = [t for t in trials if t.get("split") == a.split]
    excluded, twins = set(), {}
    if a.excluded:
        ex = json.loads(Path(a.excluded).read_text())
        excluded, twins = set(ex.get("trial_ids", [])), ex.get("twin_alternatives", {})
    n_all = len(trials)
    trials = [t for t in trials if t["trial_id"] not in excluded]
    chosen = sample(trials, pages, a.sample, a.seed)
    print(f"bench: {len(chosen)} of {len(trials)} trials ({n_all - len(trials)} excluded), "
          f"{len({t['state_id'] for t in chosen})} states, split {a.split}", flush=True)

    if a.no_model:
        v1, v1_name = NoModel(), "none (--no-model)"
    else:
        v1, v1_name = the_model(a.model)
    base, stop = domsite.serve(data / "pages", a.port)
    b = BrowserSession(Timings.from_env(), on_frame=None, headless=True)
    rows = []
    try:
        await b.open("about:blank", {"width": 1440, "height": 900})

        async def offline(route):
            await route.abort()
        # Offline, as the experiment ran: nothing but the two local origins loads.
        await b.context.route(lambda url: urlparse(url).scheme in ("http", "https")
                              and (urlparse(url).hostname or "") not in LOCAL_HOSTS, offline)
        rec = Recorder(b, lambda: v1, Timings.from_env())
        by_state = defaultdict(list)
        for t in chosen:
            by_state[t["state_id"]].append(t)
        warm = a.warmup
        for k, (sid, group) in enumerate(sorted(by_state.items())):
            st = states.get(sid)
            if st is None:
                print(f"bench: {sid} isn't in states.csv; skipped", flush=True)
                continue
            errors = await domsite.load_state(b.page, base, st, a.settle_ms, idle_ms=10000)
            render = data / "render" / sid / "hidden.json"
            render_boxes = json.loads(render.read_text()).get("boxes") if render.exists() else None
            while warm > 0:                     # not counted: imports, first sessions, the model's load
                await rec.locate(group[0]["description"] or "x")
                warm -= 1
            for t in group:
                absence = t["task"] == "T2" and not a.t2_without_absence
                times, answer, found = [], None, None
                for rep in range(a.repeats):
                    t0 = time.perf_counter()
                    got = await rec.locate(t["description"] or "", absence=absence)
                    times.append((time.perf_counter() - t0) * 1000)
                    if rep == 0:
                        answer, found = got, rec.finder.last
                gt = await domtrack.extract_tracked(b.page)       # the page as it is now, not timed
                at = answer["at"] if answer is not NULL else None
                boxes = scoring.target_boxes(t, domtrack.tracked(gt), [c["box"] for c in gt.candidates],
                                             twins.get(t["trial_id"]), render_boxes)
                page = pages.get(t["page_id"], {})
                rows.append({"trial_id": t["trial_id"], "state_id": sid, "page_id": t["page_id"], "task": t["task"],
                             "desc_kind": t.get("desc_kind"), "kind": kind(page), "dom_rich": dom_rich(page),
                             "absence": absence, "at": at, "correct": scoring.score(t, at, boxes),
                             "path": found.path, "s0": found.s0_score, "candidates": found.candidates,
                             "extract_ms": found.extract_ms, "score_ms": found.score_ms, "v1_ms": found.v1_ms,
                             "ms": [round(x, 2) for x in times], "setup_errors": errors})
            done = len(rows)
            print(f"  {k + 1}/{len(by_state)} {sid}: {len(group)} trials, "
                  f"{sum(r['correct'] for r in rows[-len(group):])} right; {done} done", flush=True)
    finally:
        await b.close()
        stop()
    return {"rows": rows, "v1": v1_name, "n_trials": len(trials), "n_all": n_all}


# ---------------------------------------------------------------- report

def pct(x):
    return f"{100 * x:5.1f}%" if x is not None else "    -"


def q(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, math.ceil(p * len(xs)) - 1))]


def summarise(rows: list[dict]) -> dict:
    def acc(rs):
        return sum(r["correct"] for r in rs) / len(rs) if rs else None
    t1 = [r for r in rows if r["task"] == "T1"]
    kinds = {}
    for k in sorted({r["kind"] for r in rows}):
        rs = [r for r in t1 if r["kind"] == k]
        kinds[k] = {"n": len(rs), "t1": acc(rs), "paths": dict(Counter(r["path"] for r in rs))}
    fast = [x for r in rows if r["path"] == "fast" for x in r["ms"]]
    return {
        "n": len(rows), "t1_by_kind": kinds,
        "t1_dom_rich": {"n": len([r for r in t1 if r["dom_rich"]]), "acc": acc([r for r in t1 if r["dom_rich"]])},
        "t1_all": acc(t1), "t4": acc([r for r in rows if r["task"] == "T4"]),
        "t2": acc([r for r in rows if r["task"] == "T2"]),
        "not_found": scoring.not_found_f1(rows),
        "fast_ms": {"n": len(fast), "p50": q(fast, 0.5), "p95": q(fast, 0.95),
                    "extract_p50": q([r["extract_ms"] for r in rows if r["path"] == "fast" and r["extract_ms"]], 0.5),
                    "score_p50": q([r["score_ms"] for r in rows if r["path"] == "fast" and r["score_ms"]], 0.5)},
        "v1_ms_p50": q([r["v1_ms"] for r in rows if r["v1_ms"]], 0.5),
        "paths": dict(Counter(r["path"] for r in rows)),
    }


def report(s: dict, meta: dict) -> str:
    lo, hi = TARGETS["dom_rich_t1"]
    lines = [f"Fast locator benchmark: {s['n']} trials, AI assistant {meta['v1']}, {meta['machine']}", "",
             "Finds the target (T1, click-only), by page type:",
             "  page type      n    new path   paths (fast / fast-visual / visual)    experiment: V1 / S0 / S0→V1"]
    for k, v in s["t1_by_kind"].items():
        p = v["paths"]
        mix = f"{p.get('fast', 0):4d} / {p.get('fast-visual', 0):4d} / {p.get('visual', 0):4d}"
        e = EXPERIMENT.get(k)
        exp = " / ".join(f"{100 * x:.0f}%" for x in e) if e else ""
        lines.append(f"  {k:<10} {v['n']:5d}    {pct(v['t1'])}     {mix:<30}         {exp}")
    d = s["t1_dom_rich"]
    lines += ["", f"  DOM-rich pages (good or medium DOM, not a control): {pct(d['acc'])} of {d['n']}"
                  f"    target about {100 * lo:.0f}-{100 * hi:.0f}%",
              f"  All pages: {pct(s['t1_all'])}. T4 (after a layout change): {pct(s['t4'])}.", ""]
    nf = s["not_found"]
    lines += [f'"Not found" F1: {nf["f1"]:.3f} (precision {nf["precision"]:.3f}, recall {nf["recall"]:.3f}; '
              f'T2 right {pct(s["t2"])})    experiment: S0 0.757, S0→V1 without absence 0.051', ""]
    f = s["fast_ms"]
    fmt = (lambda x: f"{x:.1f} ms" if x is not None else "-")
    lines += [f"Fast steps ({f['n']} timings, page load excluded, extraction included): "
              f"p50 {fmt(f['p50'])}, p95 {fmt(f['p95'])}    target about {TARGETS['fast_p50_ms']:.0f} ms p50",
              f"  extraction p50 {fmt(f['extract_p50'])}, scoring p50 {fmt(f['score_p50'])}; "
              f"AI assistant answers p50 {fmt(s['v1_ms_p50'])}", "",
              "Path mix, all trials: " + ", ".join(f"{k} {v}" for k, v in sorted(s["paths"].items()))]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", help="the unpacked breakpatch-corpus.tar.gz (the folder with data/, or data/ itself)")
    ap.add_argument("--fixtures", action="store_true", help="the engine's fixture pages instead of the corpus")
    ap.add_argument("--excluded", help="excluded_trials.json (the experiment's exclusions and twin candidates)")
    ap.add_argument("--sample", type=float, default=0.3, help="share of trials per cell (default 0.3; 1 = all)")
    ap.add_argument("--split", default=None, choices=("test", "dev", "all"), help="default test (fixtures: all)")
    ap.add_argument("--seed", type=int, default=20260930)
    ap.add_argument("--model", help="the AI assistant's folder (default: the one Breakpatch installed)")
    ap.add_argument("--no-model", action="store_true", help="no AI assistant: when S0 is unsure, not found")
    ap.add_argument("--repeats", type=int, default=1, help="timings per trial (accuracy from the first)")
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--settle-ms", type=int, default=1000, help="wait after a page loads (the experiment: 1000)")
    ap.add_argument("--t2-without-absence", action="store_true",
                    help="run T2 trials without the absence flag (S0's unsure answers then go to the AI assistant)")
    ap.add_argument("--port", type=int, default=PORT_MAIN, help=f"main origin port; the other is +1 ({PORT_MAIN + 1})")
    ap.add_argument("--out", help="results folder (default results/<date-time> next to this file)")
    a = ap.parse_args()
    if a.fixtures:
        a.corpus = str(REPO / "engine" / "tests" / "site" / "dom")
        a.split = a.split or "all"
    if not a.corpus:
        ap.error("pass --corpus or --fixtures")
    a.split = a.split or "test"
    got = asyncio.run(run(a))
    s = summarise(got["rows"])
    meta = {"v1": got["v1"], "machine": f"{platform.machine()} {platform.system()} {platform.release()}",
            "args": vars(a), "when": time.strftime("%Y-%m-%dT%H:%M:%S")}
    text = report(s, meta)
    out = Path(a.out) if a.out else HERE / "results" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "rows.jsonl", "w") as f:
        for r in got["rows"]:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    (out / "summary.json").write_text(json.dumps({"meta": meta, "summary": s}, indent=1, ensure_ascii=False))
    (out / "report.txt").write_text(text + "\n")
    print("\n" + text + f"\n\nWrote {out}/report.txt, summary.json and rows.jsonl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
