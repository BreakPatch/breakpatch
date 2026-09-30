# Breakpatch engine

The Python sidecar behind the desktop app: it drives a pinned Chromium (Playwright) through
screenshots, mouse and keyboard, works out the automatic screen checks while you record, replays
tests from stored coordinates and hashes, and uses a local vision model (Qwen3-VL through
`mlx-vlm`) only to describe targets while recording and to find a moved target during replay.
Finding a described element reads the page's accessible names and roles first (`dom/`, no model,
never a CSS or XPath selector) and asks the model when that isn't enough; every step is still
checked on the screen.

The app talks to it over JSON Lines on stdio. **[PROTOCOL.md](PROTOCOL.md) is the contract.**

## Develop

Python 3.11+.

```sh
cd engine
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'           # add ,mlx on an Apple Silicon Mac for the AI assistant
.venv/bin/playwright install chromium --no-shell   # or let the app's setup do it
.venv/bin/python -m pytest -q               # about 2 minutes, most of it real headless Chromium
```

Tests use `PLAYWRIGHT_BROWSERS_PATH`, or `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
when it exists, or any binary in `BP_CHROMIUM`. Without a browser the browser tests are
skipped. They never touch the network: a fake Hugging Face Hub (`tests/fakehub.py`) serves the
model download tests.

```sh
.venv/bin/python -m breakpatch_engine serve            # the sidecar (what the app starts)
.venv/bin/python -m breakpatch_engine info             # this machine as JSON
```

Try the protocol by hand:

```sh
printf '%s\n' '{"id":1,"method":"system.info"}' | .venv/bin/python -m breakpatch_engine serve
```

## Editions

This engine is the Community edition (docs/editions.md). Two things are Breakpatch Team and live
in the private `breakpatch_team_engine` package: fallback healing of moved targets (spec §11.2)
and the headless CI command line (`breakpatch-ci run --test …`, or `--workspace … --suite …` to run
a Team workspace's suite, spec §15). When that package is
installed in the same venv, `plugins.py` imports it (the only place that does) and it registers
its healer with the runner, and the licence the app shell hands over (`licence.set`), which it
checks itself. Without it, or without a Team licence that includes `autoFix`, a failed pre-check
fails the step with `targetNotFound`, even with `autoFix` on. `record.locate` (describe a step and let the AI assistant find it) is
open and works either way.

## Sidecar build

```sh
engine/scripts/build_sidecar.sh              # → app/src-tauri/binaries/breakpatch-engine-<rustc host triple>
engine/scripts/build_sidecar.sh --out /tmp/x # somewhere else
```

One PyInstaller file (about 180 MB on Linux; the Playwright driver is most of it). Chromium is
not bundled: setup downloads it into `~/Library/Application Support/Breakpatch/browsers`. On a Mac
with `mlx-vlm` installed in the venv the build bundles it; without it the build has no AI
assistant (recording by pointing and replay still work). When `breakpatch_team_engine` is
installed in the venv it's bundled too (`--hidden-import`); otherwise the build is Community. The binary is
gitignored. For `tauri dev`, `app/scripts/dev-sidecar.sh` writes a small script that runs the
venv instead.

## Layout

```
src/breakpatch_engine/
  cli.py        serve / info, and the internal `_download` child process
  plugins.py    finds the Breakpatch Team engine when it's installed and takes its healer and licence
  protocol.py   JSON Lines server: one response per id, events, plain errors, stdout guarded
  service.py    request handlers (PROTOCOL.md) wired to the parts below
  browser.py    Playwright session: fixed viewport, DPR 1, tabs/popups, downloads, frame stream,
                web pages only, Chromium's sandbox on, typing a secret only on its own sites
  actions.py    performs one step's action (shared by recording and replay), {i}/{time}/{date},
                saved secrets with the sites they may be typed on
  sites.py      web origins (for secrets and calls)
  calls.py      set-up and clean-up calls and "Try it": https, the app's hosts, no private addresses
  imaging.py    region pHash with ignore zones blanked, Hamming distance, diffs, blast radius, noise
  checks.py     noise watch and settle detection over a stream of screenshots
  recorder.py   record.point / record.checkpoint / record.locate (spec §10)
  runner.py     replay, set-up/clean-up calls, secrets, loops/groups, the healer hook (spec §11)
  models.py     the AI assistant models allowed: repo, revision, files and their SHA-256
  locator.py    AI assistant interface; MlxLocator (lazy mlx-vlm), NoLocator; bbox parsing
  dom/          the fast locator for record.locate: extract.py (the controls on screen, DevTools
                DOMSnapshot + accessibility tree), s0.py (scoring a description, no model),
                router.py (Fast or Visual per page), flow.py (S0, then the AI assistant)
  install.py    system.info, Chromium install, resumable model download of the allowed files only
  config.py     paths (env overridable) and timings (BP_FAST=1 shortens them)
  labels.py     default step labels (mirrors app/src/engine/labels.ts)
  samples/      the bundled upload files (scripts/make_samples.py regenerates them)
tests/          pytest: imaging, protocol (subprocess), setup (fake Hub), record + replay e2e
```

## How the checks work

All regions are viewport pixels at DPR 1. Hashes are 64-bit pHash (16 hex characters) of a
region with ignore zones painted grey; distance is the Hamming distance.

- **Recording** (spec §10.3): watch the screen 2.5 s (`watching`) and turn anything that changed
  by itself into ignore zones; hash a 64 × 64 box around the target (`pre`, tolerance 6); do the
  action (`acting`); wait for 3 identical frames outside the ignore zones (`settling`); the padded
  box around what changed is the `post` region (tolerance 10, `expectChange`); then load the page
  twice in a hidden tab (`reloading`) and add what differs between loads to the ignore zones.
- **Replay** (spec §11.1): hash `pre` at the stored spot (retrying briefly while the page
  catches up); act at the stored coordinates; settle; compare `post`; first failure stops the run.
  With `autoFix`, the Team engine installed and a licence for it, a failed pre-check asks the model for the step's
  `target`, re-checks the stored hash at the new spot, and marks the step `healed`.

## Needs a Mac

Everything above is tested on Linux with headless Chromium, except:

- **The AI assistant**: `MlxLocator` (mlx-vlm on Apple Silicon). Tests use a fake locator
  behind the same interface. The prompt and the 0–1000 → pixel mapping match
  `tools/model-test/model_test.py`; check real replies with the model test.
- **The signed PyInstaller build** for `aarch64-apple-darwin` (with mlx bundled) and its
  hardened-runtime entitlements; `system.info` chip/memory via `sysctl`.
- **Real downloads**: the Chromium install (Playwright's CDN) and the model from Hugging Face.
  Resume and checksum logic is tested against a local fake Hub with `huggingface_hub` 2.0.0
  (pinned), whose own downloader no longer resumes across processes.
- **Hash stability** between Macs (fonts, GPU): record on one, replay on another.
