# Breakpatch model test — prompt for a local Claude Code session

Paste everything below the line into Claude Code, opened in an empty folder on your Apple Silicon Mac. Replace the two lines under **Apps to screenshot** first. Claude will take the screenshots, write the cases, run the four models and give you the report.

---

You're running a model evaluation for Breakpatch, a macOS app that finds UI elements in screenshots of web apps using a local vision model. Pick the smallest model that reliably finds the right element. Work in this folder. Don't ask me questions unless you're blocked; make sensible choices and tell me what you chose at the end.

## Models (my Hugging Face copies, all MLX 4-bit)

| key | repo |
|---|---|
| 2b | `OscarShaitan/Qwen3-VL-2B-Instruct-4bit` |
| 4b | `OscarShaitan/Qwen3-VL-4B-Instruct-4bit` |
| 8b | `OscarShaitan/Qwen3-VL-8B-Instruct-4bit` |
| q35-4b | `OscarShaitan/Qwen3.5-4B-MLX-4bit` |

## Apps to screenshot

- `https://app.example.com` — log in with the env vars `BP_TEST_EMAIL` / `BP_TEST_PASSWORD` (ask me to export them if missing)
- `https://www.example.com` — public, no login

## Steps

1. **Environment.** Create a Python 3.11 venv. Install `mlx-vlm`, `pillow`, `playwright`, then `playwright install chromium`. Print the versions. Get Breakpatch's harness, so the prompt and the reading of the answers are exactly the app's: `git clone --depth 1 https://github.com/BreakPatch/breakpatch` (its `tools/model-test/model_test.py` imports them from `engine/src`). If the clone needs access you don't have, ask me for a copy of the repository.

2. **Screenshots (20–25).** With Playwright (Chromium, headless, viewport **1280 × 800**, the app's own, deviceScaleFactor 1), visit the apps above and capture real screens: login, main lists, a create dialog, a form, settings, a page with a row of icons. Save as `screenshots/1280x800/<name>.png`. Don't capture real customer data; use test accounts only.

3. **Cases with ground truth.** For every screenshot, pick 1–3 targets a person would describe (buttons, fields, icons, tabs, links). Include hard ones on purpose: look-alike buttons (two "Save"), small icons, the *second* item of a row, fields inside dialogs. For each target, get its **exact bounding box from the DOM** at capture time (`locator.bounding_box()`), and write `cases.csv` with columns `file,description,x1,y1,x2,y2,hard` (pixels; `hard` is 1 for the hard ones, empty otherwise). Aim for 40–60 cases. Descriptions must be plain words, as a non-technical user would type them ("the Done button", "the search box", "the second tag"), never selectors.

4. **Check each model reads images.** Run one `python -m mlx_vlm.generate` call per model on one screenshot with "Where is the <target>?". If a model errors or clearly ignores the image, drop it and say why.

5. **Run the test.** `python breakpatch/tools/model-test/model_test.py --cases cases.csv --shots screenshots/1280x800 --out results` (add `--models 2b 4b` to leave some out). For each model in turn it loads it and times the load, makes one warm-up call that isn't counted, then asks each case with the app's prompt at temperature 0, reads the box as the app does (Qwen3-VL answers in **0–1000 units relative to the image**), scores a **hit** when the centre of the box is inside the ground-truth box, records IoU and MLX's peak memory, and frees the model before the next one. Don't write your own prompt or parser: the point is to measure what the app does. If a model's boxes are clearly off (for example it answers in pixels), say so in the report. Close nothing of mine; just note what else was using memory.

6. **Report.** The harness writes `results/index.html` (a summary per model with hits, hard-case hits, median and p90 answer time, load time and peak memory, then a grid of every case with the ground-truth box in white and the model's in colour) and `results/results.json`. Open it and check it looks right.

7. **Recommend.** Apply these rules and state the winner:
   - Good enough: ≥ 90 % hits overall **and** ≥ 80 % on hard cases.
   - Fast enough: median answer ≤ 3 s on this Mac (the harness reports the median and p90, never the mean).
   - Fits: peak memory ≤ 6 GB.
   - Winner = smallest model that passes all three. If only 8B passes, say so: it becomes the option for 32 GB+ Macs and the local runner, and we need a plan for 16 GB Macs.
   Then print, for the winner, the exact **commit hash** of the repo revision you used (`huggingface_hub.HfApi().model_info(repo).sha`) and the download size.

## When you're done

Reply with: the summary table, the winner, its repo + commit hash + size, anything surprising (e.g. a model that answers in pixels, systematic offsets, failures on a type of element), and the path to `results/index.html`. Keep it short.
