#!/usr/bin/env python3
"""
Breakpatch model test.

Runs the same screenshots + descriptions through several MLX vision models and
compares where each one points, how fast it answers and how much memory it uses.

  pip install -U mlx-vlm pillow
  python model_test.py                 # uses cases.csv and ./screenshots
  python model_test.py --models 2b 4b  # only some models
  open results/index.html
"""
import argparse, csv, gc, html, json, os, re, sys, time
from pathlib import Path

from PIL import Image, ImageDraw

MODELS = {
    "2b":     "OscarShaitan/Qwen3-VL-2B-Instruct-4bit",
    "4b":     "OscarShaitan/Qwen3-VL-4B-Instruct-4bit",
    "8b":     "OscarShaitan/Qwen3-VL-8B-Instruct-4bit",
    "q35-4b": "OscarShaitan/Qwen3.5-4B-MLX-4bit",
}
COLOURS = {"2b": "#6CB8D6", "4b": "#E0714A", "8b": "#8CC56B", "q35-4b": "#E9B949"}

PROMPT = (
    'Find "{desc}" in this screenshot of a web app. '
    'Reply with JSON only, no other text: {{"bbox_2d": [x1, y1, x2, y2]}}'
)


def load_cases(path: Path):
    cases = []
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if not row.get("file") or row["file"].startswith("#"):
                continue
            exp = None
            if all(row.get(k, "").strip() for k in ("x1", "y1", "x2", "y2")):
                exp = [float(row[k]) for k in ("x1", "y1", "x2", "y2")]
            cases.append({"file": row["file"].strip(), "desc": row["description"].strip(), "expected": exp})
    return cases


def parse_box(text: str):
    m = re.search(r'"?bbox_2d"?\s*:\s*\[([^\]]+)\]', text) or re.search(r"\[\s*([\d.\s,]+)\]", text)
    if not m:
        return None
    nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", m.group(1))]
    return nums[:4] if len(nums) >= 4 else None


def to_pixels(box, w, h, coords):
    if box is None:
        return None
    if coords == "norm1000" or (coords == "auto" and max(box) <= 1000):
        return [box[0] / 1000 * w, box[1] / 1000 * h, box[2] / 1000 * w, box[3] / 1000 * h]
    return box


def hit(pred, exp):
    if not pred or not exp:
        return None
    cx, cy = (pred[0] + pred[2]) / 2, (pred[1] + pred[3]) / 2
    return exp[0] <= cx <= exp[2] and exp[1] <= cy <= exp[3]


def peak_memory_gb():
    try:
        import mlx.core as mx
        fn = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
        return fn() / 1e9
    except Exception:
        return None


def reset_memory():
    try:
        import mlx.core as mx
        (getattr(mx, "reset_peak_memory", None) or mx.metal.reset_peak_memory)()
        (getattr(mx, "clear_cache", None) or mx.metal.clear_cache)()
    except Exception:
        pass


def run_model(key, repo, cases, shots, out_dir, coords, max_tokens):
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template

    print(f"\n== {key}: {repo}")
    reset_memory()
    t0 = time.time()
    model, processor = load(repo)
    load_s = time.time() - t0
    config = getattr(model, "config", None)
    print(f"   loaded in {load_s:.1f}s")

    results = []
    for i, c in enumerate(cases, 1):
        img_path = shots / c["file"]
        w, h = Image.open(img_path).size
        prompt = apply_chat_template(processor, config, PROMPT.format(desc=c["desc"]), num_images=1)
        t = time.time()
        out = generate(model, processor, prompt, [str(img_path)], max_tokens=max_tokens, temperature=0.0, verbose=False)
        secs = time.time() - t
        text = getattr(out, "text", out)
        box = to_pixels(parse_box(text), w, h, coords)
        ok = hit(box, c["expected"])
        mark = "?" if ok is None else ("hit" if ok else "miss")
        print(f"   {i:>2}/{len(cases)} {secs:5.2f}s {mark:<4} {c['desc']}")
        results.append({"file": c["file"], "desc": c["desc"], "box": box, "hit": ok, "secs": secs, "raw": text.strip()[:300]})

    mem = peak_memory_gb()
    del model, processor
    gc.collect()
    reset_memory()
    return {"key": key, "repo": repo, "load_s": load_s, "peak_gb": mem, "results": results}


def draw(shots, out_dir, cases, runs):
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for idx, c in enumerate(cases):
        for run in runs:
            r = run["results"][idx]
            im = Image.open(shots / c["file"]).convert("RGB")
            d = ImageDraw.Draw(im)
            if c["expected"]:
                d.rectangle(c["expected"], outline="#FFFFFF", width=2)
            if r["box"]:
                d.rectangle(r["box"], outline=COLOURS.get(run["key"], "#E0714A"), width=4)
            im.save(img_dir / f"{idx:02d}-{run['key']}.jpg", quality=80)


def report(out_dir, cases, runs):
    def summary(run):
        rs = run["results"]
        judged = [r for r in rs if r["hit"] is not None]
        hits = sum(1 for r in judged if r["hit"])
        found = sum(1 for r in rs if r["box"])
        avg = sum(r["secs"] for r in rs) / max(len(rs), 1)
        return hits, len(judged), found, avg

    rows = []
    for run in runs:
        hits, judged, found, avg = summary(run)
        acc = f"{hits}/{judged}" if judged else "not judged"
        mem = f"{run['peak_gb']:.1f} GB" if run["peak_gb"] else "n/a"
        rows.append(f"<tr><td><b>{run['key']}</b><br><small>{html.escape(run['repo'])}</small></td><td>{acc}</td><td>{found}/{len(run['results'])}</td><td>{avg:.2f}s</td><td>{run['load_s']:.1f}s</td><td>{mem}</td></tr>")

    head = "".join(f"<th>{r['key']}</th>" for r in runs)
    body = []
    for idx, c in enumerate(cases):
        cells = []
        for run in runs:
            r = run["results"][idx]
            tag = "" if r["hit"] is None else ("<span class=ok>hit</span>" if r["hit"] else "<span class=no>miss</span>")
            cells.append(f"<td><a href='images/{idx:02d}-{run['key']}.jpg'><img src='images/{idx:02d}-{run['key']}.jpg'></a><div>{tag} {r['secs']:.2f}s</div><details><summary>answer</summary><code>{html.escape(r['raw'])}</code></details></td>")
        body.append(f"<tr><th class=case>{html.escape(c['desc'])}<br><small>{html.escape(c['file'])}</small></th>{''.join(cells)}</tr>")

    page = f"""<!doctype html><meta charset=utf-8><title>Breakpatch model test</title>
<style>body{{font-family:-apple-system,system-ui,sans-serif;background:#171412;color:#F6EFE9;margin:32px}}
h1{{font-size:28px}}table{{border-collapse:collapse;margin:16px 0}}td,th{{border:1px solid #3A322C;padding:8px;vertical-align:top;text-align:left}}
th{{background:#211C19}}img{{width:320px;display:block;border-radius:6px}}small{{color:#A3978C}}.ok{{color:#8CC56B;font-weight:700}}.no{{color:#F2667A;font-weight:700}}
code{{white-space:pre-wrap;font-size:11px;color:#CFC4BA}}.case{{width:200px}}</style>
<h1>Breakpatch model test</h1><p>White box: expected. Coloured box: the model's answer.</p>
<table><tr><th>Model</th><th>Correct</th><th>Gave a box</th><th>Avg answer</th><th>Load</th><th>Peak memory</th></tr>{''.join(rows)}</table>
<table><tr><th>Case</th>{head}</tr>{''.join(body)}</table>"""
    (out_dir / "index.html").write_text(page)
    (out_dir / "results.json").write_text(json.dumps(runs, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="cases.csv")
    ap.add_argument("--shots", default="screenshots")
    ap.add_argument("--out", default="results")
    ap.add_argument("--models", nargs="*", default=list(MODELS))
    ap.add_argument("--coords", choices=["auto", "norm1000", "pixels"], default="norm1000",
                    help="Qwen3-VL answers in 0-1000 units by default")
    ap.add_argument("--max-tokens", type=int, default=96)
    a = ap.parse_args()

    shots, out_dir = Path(a.shots), Path(a.out)
    cases = load_cases(Path(a.cases))
    missing = [c["file"] for c in cases if not (shots / c["file"]).exists()]
    if missing:
        sys.exit(f"Missing screenshots in {shots}/: {', '.join(missing)}")
    print(f"{len(cases)} cases, models: {', '.join(a.models)}")

    runs = [run_model(k, MODELS[k], cases, shots, out_dir, a.coords, a.max_tokens) for k in a.models]
    draw(shots, out_dir, cases, runs)
    report(out_dir, cases, runs)
    print(f"\nDone. Open {out_dir / 'index.html'}")


if __name__ == "__main__":
    main()
