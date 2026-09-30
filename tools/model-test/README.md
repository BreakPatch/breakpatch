# Breakpatch · Model test

**Let Claude run the model test for you.**

One prompt in a local Claude Code session. It takes the screenshots, gets the exact target boxes from the page, runs all four models with mlx-vlm and hands you a report and a winner.

Open `index.html` in this folder for the same guide with a Copy prompt button.

| Key | Size | Repo | Role |
|---|---|---|---|
| `2b` | ~1.5 GB | `OscarShaitan/Qwen3-VL-2B-Instruct-4bit` | Smallest. Best case: new default. |
| `4b` | ~3 GB | `OscarShaitan/Qwen3-VL-4B-Instruct-4bit` | Current default. |
| `8b` | ~5 GB | `OscarShaitan/Qwen3-VL-8B-Instruct-4bit` | Larger, 32 GB+ Macs. |
| `q35-4b` | ~3 GB | `OscarShaitan/Qwen3.5-4B-MLX-4bit` | Newer family. Only if clearly better. |

## 1. Open Claude Code in an empty folder

On the Apple Silicon Mac you want to test on. Close heavy apps so the memory numbers are fair. The downloads are about 12 GB in total.

```sh
mkdir ~/breakpatch-model-test && cd ~/breakpatch-model-test
claude
```

## 2. Tell it which apps to screenshot

In the prompt, replace the two lines under "Apps to screenshot" with your real app addresses. If one needs a login, export a test account first so Claude can sign in.

```sh
export BP_TEST_EMAIL=qa@example.com
export BP_TEST_PASSWORD=…
```

## 3. Paste the prompt

Copy everything below the line in [`CLAUDE_PROMPT.md`](CLAUDE_PROMPT.md) and paste it into Claude Code. It sets up Python, takes 20 to 25 screenshots at 1440 × 900, reads the exact box of each target from the page, runs every model, then writes the report. Leave it running; it only asks if it gets stuck.

## 4. Send me the winner

Claude ends with a summary table, the winner, its repo, commit hash and size, and `results/index.html` with every screenshot and box. Send me those and I’ll pin the model in the spec, the manual and the setup screen.

## How the winner is picked

- ✅ **Good enough:** at least 90 % correct overall and 80 % on the hard cases (look-alikes, small icons, second items).
- ⏱️ **Fast enough:** median answer 3 seconds or less on this Mac.
- 🧠 **Fits:** peak memory 6 GB or less, so the browser and the app still have room.
- 🏆 **Winner:** the smallest model that passes all three. If only the 8B passes, it becomes the option for 32 GB Macs and the local runner.

## Running it by hand

`model_test.py` and `cases.csv` in this folder do the same run without Claude: put screenshots in `screenshots/`, fill in `cases.csv` (file, description, and optionally the expected box in pixels), then:

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -U mlx-vlm pillow
python model_test.py            # or: --models 2b 4b
open results/index.html
```

## Explanations ("Why did this fail?")

`explain_test.py` scores the Team engine's explanations of failed steps with the real model (roadmap #7). Put failure screenshots in `screenshots/`, one row each in `explain_cases.csv` (the step's reason, target and old position, and the cause you expect), then, with the Breakpatch Team engine installed and a licence token that includes explanations:

```sh
BP_LICENCE_TOKEN=… PYTHONPATH=../../engine/src python explain_test.py --model <the model folder>
open results/explain.html
```

It passes with at least 80 % right, nothing made up for a target that is visible where it was, and every answer within 10 seconds. Include at least one of each: moved, renamed, removed, covered by a dialog, and the page didn't change.
