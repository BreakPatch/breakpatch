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

Copy everything below the line in [`CLAUDE_PROMPT.md`](CLAUDE_PROMPT.md) and paste it into Claude Code. It sets up Python, takes 20 to 25 screenshots at 1280 × 800 (the engine's viewport), reads the exact box of each target from the page, runs every model, then writes the report. Leave it running; it only asks if it gets stuck.

## 4. Send me the winner

Claude ends with a summary table, the winner, its repo, commit hash and size, and `results/index.html` with every screenshot and box. Send me those and I’ll pin the model in the spec, the manual and the setup screen.

## How the winner is picked

- ✅ **Good enough:** at least 90 % correct overall and 80 % on the hard cases (look-alikes, small icons, second items).
- ⏱️ **Fast enough:** median answer 3 seconds or less on this Mac (and, for the other runtimes: 2 seconds or less on a GPU, 15 seconds or less on a CPU).
- 🧠 **Fits:** peak memory 6 GB or less, so the browser and the app still have room.
- 🏆 **Winner:** the smallest model that passes all three. If only the 8B passes, it becomes the option for 32 GB Macs and the local runner.

## Running it by hand

`model_test.py` and `cases.csv` in this folder do the same run without Claude. Put 1280 × 800 screenshots in `screenshots/1280x800/` and fill in `cases.csv` (file, description, optionally the expected box in pixels, and `hard` set to 1 for the hard cases). Then:

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -U mlx-vlm pillow
python model_test.py            # or: --models 2b 4b
open results/index.html
```

It asks exactly what the app asks and reads the answer the same way: the prompt and the parsing come from the engine (`breakpatch_engine.locator`: `LOCATE_PROMPT`, `parse_bbox`, `map_box`), found next to this folder in `engine/src`. There's no copy here to drift.

**What it measures**

- **Correct:** a hit is the centre of the model's box inside the expected box, overall and on the hard cases.
- **Speed:** one warm-up call first (not counted) and the load time on its own, then the **median** and the **90th percentile** of the answers. With llama.cpp, the server's timings split each answer into prefill (reading the image and prompt) and decode (writing the answer).
- **Memory:** MLX's peak allocation on a Mac; the peak resident size of the `llama-server` process elsewhere (`VmHWM` on Linux, `PeakWorkingSetSize` on Windows); the GPU's used memory from `nvidia-smi` when there is one. These are different measures, labelled as such in the results.
- **Per case:** the screenshot's size, the size it was sent at, and about how many image tokens that is (1280 × 800 is about 1,000).

**Other runtimes** (for the Windows and Linux plan, `docs/linux-windows-plan.md` in the Team repo):

```sh
# llama.cpp: starts llama-server on a free local port with a random API key, and stops it at the end
python model_test.py --runtime llamacpp --llama-server ~/llama/llama-server \
  --gguf Qwen3-VL-4B-Instruct-Q4_K_M.gguf --mmproj mmproj-Qwen3-VL-4B-Instruct-F16.gguf \
  --ngl 99 --out results/cuda-4b          # --ngl 0 (the default) for CPU only
# a server that's already running (llama-server, Ollama, LM Studio)
python model_test.py --runtime openai --url http://127.0.0.1:8080 --server-pid 12345
# half-size screenshots, or llama-server's own limit
python model_test.py --runtime llamacpp … --scale 0.5
python model_test.py --runtime llamacpp … --image-max-tokens 256
```

`results.json` records the runtime, backend and device, the llama.cpp build, both quantisations, `imageMaxTokens`, the threads, and this machine's CPU, memory and OS.

**Comparing two runs**

```sh
python compare.py results/mlx/results.json results/cuda-4b/results.json
python compare.py results/mlx/results.json:4b results/cpu/results.json   # a file with several runs: name one
```

It prints both accuracies (overall and hard cases) and the difference in points, the speed ratios, and **every case where the two disagree**, and says whether the second run is within 5 points of the first (`--points`). The exit code is 0 when it is.

**The second set.** Screenshots at 1440 × 900 go in `screenshots/1440x900/`, with their boxes in `cases-1440x900.csv`: `python model_test.py --set 1440x900`. The pass bar is measured on the 1280 × 800 set.

The engine's tests run this tool against a stand-in `llama-server` (`engine/tests/test_model_tool.py`), so the harness itself is checked on every change without a model.

## Explanations ("Why did this fail?")

`explain_test.py` scores the Team engine's explanations of failed steps with the real model (roadmap #7). Put failure screenshots in `screenshots/`, one row each in `explain_cases.csv` (the step's reason, target and old position, and the cause you expect), then, with the Breakpatch Team engine installed and a licence token that includes explanations:

```sh
BP_LICENCE_TOKEN=… PYTHONPATH=../../engine/src python explain_test.py --model <the model folder>
open results/explain.html
```

It passes with at least 80 % right, nothing made up for a target that is visible where it was, and every answer within 10 seconds. Include at least one of each: moved, renamed, removed, covered by a dialog, and the page didn't change.
