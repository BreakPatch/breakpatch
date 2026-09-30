# Breakpatch · Fast locator benchmark

Checks the engine's new way of finding a described element (`record.locate`) against the System 1
experiment's corpus, on your Mac. Each step goes the way it goes in the app:

1. **Router**: the page is Fast, or Visual when it's a Flutter app, has a canvas over a quarter
   of the screen, or lists fewer than 3 controls.
2. **S0** on Fast pages: the page's own controls, scored against the description. No model.
3. **The AI assistant** (Qwen3-VL through MLX, the one the app downloaded) when S0 is unsure,
   and on Visual pages.

It scores the answers **click-only** (the click lands inside the target, section 2c of the
experiment's report), with the experiment's exclusions and twin candidates, and prints:

- how often the target is found, by page type (good, medium and poor DOM, Flutter, canvas), next
  to what the experiment measured;
- "not found" F1 (absence trials run with `absence: true`, so S0 alone answers them on Fast pages);
- p50 and p95 latency of Fast steps: from the question to the answer, the page load left out and
  reading the page's controls included;
- which path answered how many steps (`fast`, `fast-visual`, `visual`).

Targets: about **88-93%** found on DOM-rich pages, and about **12 ms** p50 on Fast steps.

## Run it

On the Apple Silicon Mac, from the repository, with the engine's venv (the AI assistant needs the
`mlx` extra) and Breakpatch's AI assistant downloaded (Settings, AI assistant):

```sh
# The engine's venv, from the lock (the same Playwright, so the same Chromium, as the app)
python3.11 -m venv engine/.venv
engine/.venv/bin/pip install --require-hashes -r engine/locks/build.txt
engine/.venv/bin/pip install --require-hashes --no-build-isolation -r engine/locks/macos-arm64.dev-mlx.txt
engine/.venv/bin/pip install --no-deps -e engine
# The engine always uses Breakpatch's browser folder; this does nothing if the app installed it
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Application Support/Breakpatch/browsers" \
  engine/.venv/bin/playwright install chromium --no-shell

mkdir -p ~/breakpatch-corpus && tar -xzf breakpatch-corpus.tar.gz -C ~/breakpatch-corpus
engine/.venv/bin/python tools/fast-locator-bench/bench.py \
  --corpus ~/breakpatch-corpus \
  --excluded ~/breakpatch-fast-locator-handoff/reference_code/results/excluded_trials.json
```

It serves the pages itself (with `engine/tests/domsite.py`), offline, on `http://localhost:8801/` and `http://127.0.0.1:8802/`
(the second origin is for cross-origin iframes), and blocks every other address. The default is
30% of the test trials, taken from every cell of DOM quality, rendering and page type (seed
20260930). With the AI assistant, expect about a second for each step it answers. Close other apps
for fair timings.

Results go to `tools/fast-locator-bench/results/<date-time>/`: `report.txt` (what's printed),
`summary.json` and `rows.jsonl` (one row per trial: path, S0 score, timings, right or wrong).

| Option | What it does |
|---|---|
| `--sample 1` | every trial, not 30% |
| `--split dev` / `all` | other trials (default `test`, the experiment's held-out pages) |
| `--repeats 5` | time each step 5 times (accuracy from the first), as the experiment's timing pass |
| `--model PATH` | another AI assistant folder than the one Breakpatch installed |
| `--no-model` | no AI assistant: when S0 is unsure, the step counts as not found |
| `--t2-without-absence` | run absence trials as plain steps, to see the fallback's false finds |
| `--fixtures` | the engine's fixture pages (`engine/tests/site/dom`) instead of the corpus |

## How it scores

- Target boxes come from the page as it is when the step runs: the corpus pages mark targets with
  `data-gt-id`, and the benchmark reads their boxes with the engine's extractor, after the timed
  look. A click is right inside the target's own box, the listed control it maps to, or a twin
  candidate (`twin_alternatives` in `excluded_trials.json`; their boxes come from
  `data/render/<state>/hidden.json` when the corpus has renders, else from the live list).
- `excluded_trials.json`'s `trial_ids` are left out (140 trials).
- Only the locate tasks run (T1, T2, T4); T3 (naming a point) isn't part of `record.locate`.

`scoring.py` is the experiment's click-only scoring rules. The pages are served, and the targets
followed, by the engine tests' own helpers (`engine/tests/domsite.py`, `engine/tests/domtrack.py`).

## Without the corpus

```sh
engine/.venv/bin/python tools/fast-locator-bench/bench.py --fixtures --no-model --sample 1 --repeats 10
```

A timing sanity check on the fixture pages; 25 trials are too few for the accuracy to mean much.

## Known differences from the experiment

- The experiment's extractor talked to Chromium on a DevTools port. The engine opens none (any
  program on the Mac could then drive the test browser), so every call goes through Playwright's
  driver: slower on big pages (a 400-control page takes several times longer to read).
- The engine's browser context, not the experiment's: same viewport, scale and locale, but no
  forced UTC time zone or reduced motion.
- Ordinals ("the second Edit button") count in reading order, top to bottom then left to right,
  as the experiment's notes asked; its frozen S0 counted in document order.
