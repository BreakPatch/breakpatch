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

1. **Environment.** Create a Python 3.11+ venv. Install `mlx-vlm`, `pillow`, `playwright`, then `playwright install chromium`. Print the versions.

2. **Screenshots (20–25).** With Playwright (Chromium, headless, viewport **1440 × 900**, deviceScaleFactor 1), visit the apps above and capture real screens: login, main lists, a create dialog, a form, settings, a page with a row of icons. Save as `screenshots/<name>.png`. Don't capture real customer data; use test accounts only.

3. **Cases with ground truth.** For every screenshot, pick 1–3 targets a person would describe (buttons, fields, icons, tabs, links). Include hard ones on purpose: look-alike buttons (two "Save"), small icons, the *second* item of a row, fields inside dialogs. For each target, get its **exact bounding box from the DOM** at capture time (`locator.bounding_box()`), and write `cases.csv` with columns `file,description,x1,y1,x2,y2` (pixels). Aim for 40–60 cases. Descriptions must be plain words, as a non-technical user would type them ("the Done button", "the search box", "the second tag"), never selectors.

4. **Check each model reads images.** Run one `python -m mlx_vlm.generate` call per model on one screenshot with "Where is the <target>?". If a model errors or clearly ignores the image, drop it and say why.

5. **Run the test.** Write `model_test.py` that, for each model in turn:
   - loads it with `mlx_vlm.load(repo)`, times the load,
   - for each case builds the prompt with `mlx_vlm.prompt_utils.apply_chat_template(processor, model.config, PROMPT, num_images=1)` where
     `PROMPT = 'Find "{desc}" in this screenshot of a web app. Reply with JSON only, no other text: {"bbox_2d": [x1, y1, x2, y2]}'`,
   - calls `mlx_vlm.generate(..., temperature=0.0, max_tokens=96)` and times it,
   - parses the first `bbox_2d` (or first 4-number list). Qwen3-VL answers in **0–1000 units relative to the image**; convert to pixels. If boxes are clearly off for a model, try reading them as pixels instead and keep whichever matches the ground truth better — report which,
   - scores a **hit** when the centre of the predicted box is inside the ground-truth box; also record IoU,
   - records peak memory (`mx.get_peak_memory()` or `mx.metal.get_peak_memory()`), resets it and frees the model before the next one.
   Run all models. Close nothing of mine; just note what else was using memory.

6. **Report.** Create `results/index.html` (dark background is fine) with:
   - a summary table per model: hits / total, hit rate, median and p90 answer time, load time, peak memory, answers with no box,
   - the same split for **hard cases only**,
   - a grid: one row per case, one column per model, each cell the screenshot with the ground-truth box (white) and the model's box (colour), hit/miss and time.
   Also save `results/results.json`.

7. **Recommend.** Apply these rules and state the winner:
   - Good enough: ≥ 90 % hits overall **and** ≥ 80 % on hard cases.
   - Fast enough: median answer ≤ 3 s on this Mac.
   - Fits: peak memory ≤ 6 GB.
   - Winner = smallest model that passes all three. If only 8B passes, say so: it becomes the option for 32 GB+ Macs and the local runner, and we need a plan for 16 GB Macs.
   Then print, for the winner, the exact **commit hash** of the repo revision you used (`huggingface_hub.HfApi().model_info(repo).sha`) and the download size.

## When you're done

Reply with: the summary table, the winner, its repo + commit hash + size, anything surprising (e.g. a model that answers in pixels, systematic offsets, failures on a type of element), and the path to `results/index.html`. Keep it short.
