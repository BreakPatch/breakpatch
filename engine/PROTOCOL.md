# Engine protocol

The engine is a Python sidecar (`breakpatch-engine`) started by the Tauri shell. It talks
**JSON Lines over stdio**: one JSON object per line on stdin (requests) and stdout
(responses and events). Logs go to stderr. The UI never talks to it directly: the Tauri
shell forwards requests (`engine_request` command) and emits every event to the webview
as the Tauri event `engine://event`.

All coordinates are **viewport pixels at DPR 1**. Boxes are `[x1, y1, x2, y2]`.

## Messages

```jsonc
// request  (UI -> engine)
{"id": 7, "method": "record.point", "params": {...}}
// response (engine -> UI), exactly one per request
{"id": 7, "result": {...}}
{"id": 7, "error": {"code": "not_found", "message": "Plain sentence for the UI", "details": "traceback or context"}}
// event    (engine -> UI), any time
{"event": "frame", "data": {...}}
```

Error codes: `bad_request`, `not_ready` (browser or model missing), `not_found`, `busy`,
`stale` (the page changed after the frame the user acted on; nothing was done), `network`,
`stopped`, `internal`. `message` is plain language, safe to show; `details`
(optional) goes behind "Copy details".

- Requests run concurrently: a long call (a run, a download, recording) never blocks
  `run.stop`, `setup.pause` or `system.info`. Responses can therefore arrive out of order.
- A line that isn't JSON gets `{"id": null, "error": {"code": "bad_request", ...}}`. Blank lines are ignored.
- `params` must be an object (or omitted). A result of `{}` means "done, nothing to return";
  `record.locate` can return `null`.
- When stdin closes, requests still in flight get 3 s to answer, the rest are answered with
  `stopped`, Chromium is closed and the process exits 0. SIGTERM and SIGINT do the same.

## Methods

### System and setup
| Method | Params | Result |
|---|---|---|
| `system.info` | – | `{ memoryGb, chip, os, engineVersion, edition, licence: Licence, browser: {installed, version}, model: {installed, repo?, revision?, sizeBytes?, path?}, system: RecordedOn }` |
| `licence.set` | `{ token: string \| null }` | `Licence` — sent by the shell only (see Licence below) |
| `setup.installBrowser` | – | `{ version }` — emits `setup.progress` with `task: "browser"` |
| `setup.downloadModel` | `{ repo, revision }` | `{ path, sizeBytes }` — resumable; emits `setup.progress` with `task: "model"`. Only a model in the engine's table (below), at its revision; anything else is `bad_request` before anything is fetched |
| `setup.pause` | `{ task }` | `{}` — pauses a download; calling the start method again resumes |
| `setup.removeModel` | – | `{}` — `busy` while a run is going |

`setup.progress` data: `{ task, state: "busy"|"paused"|"done"|"failed", doneBytes?, totalBytes?, etaSeconds?, message? }`.

Pausing: `setup.pause` answers `{}` at once; the pending `setup.installBrowser` /
`setup.downloadModel` call then fails with code `stopped` (and a `paused` progress event is
sent). Calling it again continues. The model download keeps partial files in
`<model folder>/.partial/` and resumes them with HTTP Range requests. The browser install is
Playwright's own and restarts the current archive when resumed.

**Which models, and which files** (`engine/src/breakpatch_engine/models.py`). Loading a model can
run code its files name, so the engine has a table of allowed models: repo, revision (a commit
SHA) and the files to fetch, each with its SHA-256. The app's `MODELS` (app/src/engine/engine.ts)
names the same repos and revisions (a test checks they agree). A download:

- fetches only the listed files, and checks each against the SHA-256 shipped in the table, never
  the Hub's own answer, before it's moved into place and again at the end (a damaged file is
  deleted and the call fails with "The download didn't check out…"; calling again fetches it again);
- refuses file names with `..`, `\` or an absolute path, and never fetches code: `.py`, pickles
  (`.pkl`, `.bin`, `.pt`…), native libraries;
- fails with `bad_request` "This AI assistant has files Breakpatch won't use…" and removes the
  folder when any JSON config names `model_file` or `auto_map` (mlx-vlm and transformers would
  import code for those).

Loading checks the folder again (the table entry, no code files, no such config key, the hashes)
and fails with `not_ready` otherwise; the processor is loaded with `trust_remote_code=False`.
Until the owner pins the models (the `TODO(owner)` in models.py) the table holds placeholders at
`main` with no hashes: development builds download them with a warning, checked against the Hub's
LFS hashes, still without code files; `scripts/build-release.sh --release` refuses to build.

`edition` is `"team"` when the Breakpatch Team engine (`breakpatch_team_engine`) is installed and
registered itself through `plugins.py` (healing on), otherwise `"community"`. The app compares it
with its own edition and warns in Settings → About when they differ.

### Licence

Healing is Breakpatch Team and needs a licence, which the engine checks itself. The Tauri shell
(`app/src-tauri/src/licence.rs`) keeps the licence token in the Keychain and hands it to the engine
with `licence.set`: after every engine start or restart, and after each activation, refresh and
release. `engine_request` refuses `licence.*` from the UI (`bad_request`): only the shell sends it.
The Team engine (`breakpatch_team_engine`) verifies the token's Ed25519 signature with the public
keys built into it at build time (the same table as the shell, from `scripts/build-release.sh`),
so a hand-edited request or token unlocks nothing. Setting the licence never restarts anything: a
run in progress keeps going and uses the new state from its next failed pre-check. The state is
worked out from the token's times whenever it's needed, so a licence that runs out needs no
message.

`Licence`: `{ state, features, tier?, kind?, workspaceProjectId?, expiresAt?, offlineUntil?, licenceExpiresAt?, code?, message? }`
(times in Unix seconds). `state` is the same as the shell's:

| `state` | |
|---|---|
| `active` | the token's `exp` hasn't passed |
| `grace` | after `exp`, before `offlineUntil` (at most 30 days after it was issued); still unlocked, `code: "grace"` |
| `expired` | after that (`code: "offline_too_long"`), or past the licence's end date (`code: "expired"`) |
| `invalid` | bad signature, unknown key id or not one of ours (`code: "invalid_token"`) |
| `none` | no token |
| `unavailable` | Community (no Team engine), or a Team engine without keys built in (a source checkout) |

`features` is the token's list while `active` or `grace`, else `[]`. Healing needs `autoFix` in it.
The engine doesn't compare `workspaceProjectId` with the open workspace (it doesn't know it); the
app does that for its own screens.

`model.installed` is true once a download completed (a marker file in the model folder).
`browser.version` is the pinned Chromium (`"Chromium 153.0…"`) even before it's installed.

Model choice: the UI picks `repo`/`revision`: Standard = 4B, always the default; Larger = 8B, only when the user asks for it (32 GB+). From
the app config, or (Breakpatch Team) the workspace's model override.

### Browser (live view)
| Method | Params | Result |
|---|---|---|
| `browser.open` | `{ url, viewport: {width, height} }` | `{}` — starts streaming `frame` events |
| `browser.close` | – | `{}` |
| `browser.navigate` | `{ nav: "url"\|"reload"\|"back"\|"forward", url? }` | `{}` |
| `browser.pointer` | `{ kind: "move"\|"scroll", at, dx?, dy? }` | `{}` — lets the user scroll/hover the live view without recording; `busy` while a step records |

The test browser only shows web pages: `http://` and `https://` addresses, and `about:blank`.
`browser.open`, `browser.navigate` (`nav: "url"`), a run's `startUrl` and a `navigate` step refuse
anything else (`file:`, `chrome:`, `chrome-extension:`, `view-source:`, `devtools:`, other `about:`
pages, `data:`, `javascript:`…) with `bad_request` "Breakpatch only opens web addresses that start
with https:// or http://…" (in a run, the step fails with that message). A page that tries to go
to one itself is stopped by route interception (top-level navigations only; `data:` images and
the like still load), and a page that ends up on one anyway is sent back to `about:blank`.
Chromium runs with its sandbox on (`chromium_sandbox`); only development runs can turn it off
(see Environment).

`frame` data: `{ jpeg: <base64>, width, height, seq }`, sent when the page changes (at most ~10/s,
always ending on the latest picture). `width`/`height` are the picture's own size, which is always the viewport's: the
window is opened at the viewport's size, and if Chrome still paints less of the page than the
viewport (a screen smaller than the viewport), the stream switches to screenshots of the whole viewport. Every page and frame
has its text cursor hidden (`caret-color: transparent`), in recording and replay, so a focused field
doesn't change the screen by itself; a repaint with the same picture sends no frame. Frames follow the active tab: when `switchTab` moves to a
popup, or the popup closes itself, frames come from the page now in front.
The browser methods answer `busy` during a run.

### Recording
| Method | Params | Result |
|---|---|---|
| `record.point` | `{ action, at?, from?, to?, direction?, distance?, text?, secretRef?, generated?, sample?, durationMs?, region?, timeoutMs?, nav?, url?, fileType?, minBytes?, label?, target?, secrets?, frame? }` | `{ step: Step }` |
| `record.locate` | `{ description }` | `{ box, at, target, frame } \| null` — AI assistant; `null` means not found |
| `record.checkpoint` | `{ region, frame? }` | `{ step: Step }` |
| `record.propose` | `{ at, name? }` | `{ at, frame, box?, name?, target? }` — what a click at `at` would act on; nothing is done to the page |

Nothing the user does on the live view reaches the page by itself: the app turns a click, drag or
scroll into a proposed step ("Click Next button?"), using `record.propose` for the element's box
(read through the DevTools protocol, no page script) and the AI assistant's name for it (skipped
with `name: false`), and calls `record.point` only when the user confirms. The app no longer
sends `browser.pointer`.

`record.point` performs the action in the live browser and runs the automatic checks
(spec §10.3): noise watch, pre-check hash around the target, the action, settle, blast
radius post-check, reload diff for ignore zones. It emits `record.checking` `{ phase: "watching"|"acting"|"settling"|"reloading"|"naming" }`
while it works (`naming` only when the AI assistant is still naming the step after the rest is done). The returned `Step` follows spec §12.1 (`id`, `action`, `label`, `target`, `at`,
`pre`, `post`, `ignore`, plus action fields). `label` and `target` are plain-language
suggestions the UI shows and the user may edit; pass `label`/`target` to set them instead.
With a model installed, the engine asks it to name the clicked element (unless `label` is given;
a given `target` is kept); without one the target reads like "The spot you clicked, near the top
left of the page". The naming looks at the screen from before the action but runs after it, while
the page reacts, so it never delays the click.

`frame` is the `seq` of the live view frame the user clicked or drew on (`record.locate` returns
the one it found the box on). Right before acting, and at its first look, the engine checks that
the page still looks like that frame around the click (96 × 96 px) or inside the drawn box; if it
doesn't, the call fails with `stale` ("The page changed before your click reached it, so nothing
was clicked…") and nothing is sent to the page. Without `frame`, or for a frame too old to be kept
(the last 64), there is no check. The action follows the last look straight away. The noise watch
is skipped when the frame stream has seen the page sit still for the whole watch (it only sends
frames on a change), so a click on a still page goes at once.

Per action:
- Pointer actions (`click`, `doubleClick`, `longClick`, `rightClick`, `hover`, `upload`, `downloadCheck`
  with `at`): `pre` is a 64 × 64 box around `at`. `drag`/`swipe`/`scroll` use `from` for the pre-check.
- `post` is the blast radius (what changed, padded, noise excluded) with `expectChange: true`, or
  the pre region with `expectChange: false` when nothing changed. With `expectChange`, `post.change` is the
  share (0-1) of that area's pixels that changed; a replay must change at least a quarter as much
  (`POST_CHANGE_SHARE`), so a click that only lights up a button that should have moved the page on
  fails with `noChange`. Steps saved without `change` keep the hash check alone. A `write` whose text changes per
  run (`generated`, `{i}`, `{time}`, `{date}`) gets no `post`.
- `write` without `at` types into the focused field. With `secretRef`, pass the secret in
  `secrets` (see Saved secrets below; it is typed, never stored in the step); without it the call
  fails with `not_found` "The saved secret NAME isn't on this Mac.", and on a site the secret
  isn't allowed on with `not_found` "NAME isn't allowed on evil.example."
- `waitUntil` needs `region`; nothing is performed. The step stores `region`, `hash` (how the
  area looks now), `tolerance` and `timeoutMs` (default 10000). No `pre`/`post`.
- `downloadCheck` without `at` checks for a download since the previous download check (e.g. after
  a "Click Download" step). Without one it fails with `bad_request` "No file was downloaded."
- `upload` clicks `at`, expects a file picker and chooses the bundled `sample` (`docx`, `pdf`, `jpeg`, `mp4`, `xlsx`, `csv`).
- `loop` / `group` return at once with the given fields (`steps` default `[]`).
- `checkpoint` through `record.point` needs `region` and is the same as `record.checkpoint`.

Recording answers `busy` while a previous `record.point` is still checking, or during a run.

### Replay
| Method | Params | Result |
|---|---|---|
| `run.start` | `{ runId, startUrl, appUrl?, viewport, steps: Step[], setUp?: Call, cleanUp?: Call & {alsoOnFailure?}, settings: { autoFix, failOnFix, allowSystemDifferences? }, secrets: {NAME: Secret}, runner?, recordedOn?: RecordedOn }` | `{}` — returns at once, then events |
| `run.stop` | `{ runId }` | `{}` — stops after the current step |
| `call.try` | `{ call: Call, appUrl, secrets? }` | `{ ok, status?, ms?, error?, message? }` — "Try it": one request under the same rules as a run |

`run.start` also takes `keepOpen` and `upToStepId` for the recorder's own Run and Play to here.
With `keepOpen: true` the run is the same (a fresh browser at `startUrl`, set-up call, secrets,
shared steps and repeats as given) but the browser stays open at the end, frames keep coming, and
there is no clean-up call, so recording carries on from where the run left the page. With
`upToStepId` (any step id, also inside a repeat or shared steps) the run stops after that step
passes: its result is `pass`, the loops and cards around the step count as passed, and later steps
are `notRun`. An unknown `upToStepId` is `bad_request`.

`appUrl` is the app's base address (defaults to `startUrl`): set-up and clean-up calls may only
go to its hosts (see Set-up and clean-up calls). `runner: true` marks a run started by the local
runner (see Saved secrets).

`run.start` fails with `busy` when a run or recording is going, and `not_ready` when the browser
isn't installed. The run opens its own browser (closing the live view's) and closes it at the end.
A `waitFor`/`waitUntil` in progress is cut short by `run.stop`.

Events: `run.step` `{ runId, index, stepId, state: "running"|"looking"|"passed"|"healed"|"failed", reason?, preDistance?, postDistance?, oldAt?, newAt?, screenshot?, iteration?, message?, details? }`
(`looking` = AI assistant is finding a moved target; `screenshot` is a local file path, only on failure or heal;
`iteration` is the 1-based repeat number inside a loop; `message` is a plain sentence on failure)
and `run.ended` `{ runId, result: "pass"|"fail", durationMs, steps: StepRun[], message?, details?, cleanUpFailed?, ranOn?, systemMismatch? }`
(`ranOn` and `systemMismatch`: see Where a test was recorded).

`index` is the step's position in a **pre-order walk** of the nested steps (a loop or group comes
before its children; children count once, not once per repeat). `run.ended.steps` is in the same
order, one `StepRun` per step. It is **not** an index into the top-level `steps` array once a
test has loops or groups: match on `stepId`. A loop/group's own result is `passed`, `healed`
(a child healed) or `failed` (with the child's reason).

Order of a run (spec §11): secrets are checked first (a missing one, one with no sites, or, when
`runner` is set, one without `runnerCanUse` fails its step with `secretMissing` before any call or
action; a secret a call's header uses fails the first step); then the set-up call (not 2xx → the first step fails
with `setUpFailed`); then the start page opens and settles; then the steps, stopping at the first
failure; then the clean-up call (after a pass, or also after a failure when `alsoOnFailure`; a
failed clean-up sets `cleanUpFailed: true` but doesn't change the result). Set-up and clean-up
wait up to 30 s for a reply.

`FailReason` values: `targetNotFound` (pre-check off and no healing, or the AI assistant found
nothing), `unexpectedScreen` (post-check or checkpoint mismatch, wrong download type or size),
`noChange` (`expectChange` but nothing changed), `timeout` (the screen never settled, the page
didn't load, no popup/file picker/download), `healFailed` (the AI assistant's spot doesn't match
the stored hash), `healingUnavailable` (`autoFix` on, healing installed, but no model), `secretMissing`,
`setUpFailed`, `stopped`. `failOnFix` makes a run with a healed step end with `result: "fail"`
(the step stays `healed`).

Healing (spec §11.2, only with `autoFix`) is Breakpatch Team: it runs only when the Team engine
(`breakpatch_team_engine`) is installed next to this one (`plugins.py`) **and** its licence (see
Licence above) is `active` or `grace` with the `autoFix` feature. Then the model loads on
the first failed pre-check of a run, finds the step's `target`, the pre-check is repeated at the
new spot, and the action and the post-check run as usual. Healed steps report `oldAt`/`newAt`;
nothing is written back. Without the Team engine (Community), or without such a licence, `autoFix`
is ignored: a failed pre-check fails with `targetNotFound`, and `looking`, `healed`, `healFailed`
and `healingUnavailable` never occur.

Loops and shared steps are nested, as stored (spec §12.1): a `loop` step carries its
`count` and child `steps`; a `group` step carries `groupId`, `groupVersion` and the child
`steps` the UI resolved from that version before starting. The engine runs children in order.
`{i}` in `text` (and `url`) is the 1-based repeat number; `{time}` is HH:MM and `{date}` is YYYY-MM-DD at run time.

### Where a test was recorded

Screen checks compare an area with how it looked when the step was recorded. Another operating
system draws the same page's text a little differently (other fonts, other antialiasing), and so
can another Chromium, so a test recorded on a Mac can fail its checks on Linux with nothing
changed. `RecordedOn` says where a test's steps were recorded
(engine/src/breakpatch_engine/systems.py):

```jsonc
{ "os": "macOS", "osVersion": "15.3", "arch": "arm64", "chromium": "140.0.7339.16" }
```

- **Recording.** `system.info` answers this system as `system` (the Chromium is the one this
  engine's Playwright runs). The app writes it into the test when a save has steps recorded or
  re-recorded: a version's `recordedOn` (the local tests folder keeps it next to `steps` in the
  test file, the Team workspace in the version document). Edits without recording keep the one
  before's. It's optional: tests recorded before it existed have none and are never a mismatch.
- **Run time.** `run.start` passes the test's `recordedOn`. Once the browser is open the engine
  compares it with this system (`ranOn`, with the running Chromium's version): **a different OS
  family** (macOS, Linux, Windows) **or a different Chromium major version** is a mismatch.
  Another macOS version or another architecture isn't.
- **Allow for small differences between systems.** `settings.allowSystemDifferences` (the app's
  setting of that name, on by default; the engine treats a missing value as on). On a mismatch it
  relaxes every screen check of the run: the pre-check, the post-check, checkpoints, `waitUntil`
  and the pre-check a heal repeats. A relaxed check takes the smallest distance of the area as it
  is and moved by up to 1 px each way, sharp and lightly blurred (`imaging.region_distance`), and
  allows 2 more bits on top of the step's tolerance (`config.RELAXED_SHIFT`, `RELAXED_EXTRA`).
  Only the current screen varies, so a missing button or other words still fail. Pixel
  comparisons within the run (settling, `expectChange`) compare this system with itself and are
  never relaxed.
- **The result.** `run.ended` has `ranOn`, and on a mismatch `systemMismatch`:
  `{ recordedOn, ranOn, differences: ("os"|"chromium")[], relaxed, message }`. `message` is the
  plain explanation to show with a failed screen check, for example "This test was recorded on
  macOS 15 and ran on Linux. Text can look slightly different on another system, which can fail
  screen checks. Re-record it on this system, or run it on a Mac." `breakpatch-ci` does the same,
  with `--strict-systems` to turn the relaxing off (see CLI (CI)).

### Saved secrets

A secret travels as `{ value, origins, runnerCanUse }`: `origins` are the sites it may be typed
on (`https://app.example.com`, scheme, host and port), and `runnerCanUse` whether the local runner
may use it (off by default). The Tauri shell fills `origins` and `runnerCanUse` itself, from the
Keychain index (app/src-tauri/src/secrets.rs), for every `run.start`, `record.point` and `call.try`
that goes through `engine_request`: whatever the UI put there is replaced, so the UI (or the Team
runner) can keep sending `{NAME: value}`. A bare value from any other client (`breakpatch-ci`, the
tests) counts as allowed on the start page's site only (`startUrl`, or the page `browser.open`
opened for `record.point`).

The engine checks the site of the frame that has the keyboard focus just before typing (after the
step's click) and again before every key, so a redirect, a popup (`switchTab`) or a frame from
another site gets nothing. The focused frame is found from Playwright's isolated world, so the
page's own scripts can't fake it. On a mismatch the step fails with `secretMissing` and the message
"NAME isn't allowed on evil.example.". A secret with no sites at all fails before the run starts
("NAME isn't allowed on any site yet…"): the app asks once to allow the app's site for secrets saved
before sites existed.

**The local runner** (Breakpatch Team) sends `runner: true` in `run.start`. Then a secret without
`runnerCanUse` fails its step before anything runs ("NAME can't be used by the runner…"). The UI
reads the flag with `secrets.info()` (app/src/platform.ts; shell command `secrets_info`), so the
runner can also refuse a request before it starts it.

### Set-up and clean-up calls

`Call`: `{ method, url, headers?: [{ name, value? } | { name, secretRef }], allowOtherHosts? }`
(engine/src/breakpatch_engine/calls.py):

- `https://` only; `http://` only to a loopback address, and only when `appUrl` is one too.
- No redirects: a 3xx reply fails the call. Methods: GET, POST, PUT, PATCH, DELETE.
- The host must be `appUrl`'s host, or another host under its parent domain (`api.acme.com` for
  `app.acme.com`); on shared hosting domains (`github.io`, `vercel.app`, `co.uk`…) the host alone.
- After DNS, every address must be public (no loopback, private, link-local, CGNAT, unique local,
  multicast or reserved address, IPv4 or IPv6), unless `appUrl` itself resolves to such addresses
  (a local or intranet app). The request goes to the address that was checked (no proxy).
- `allowOtherHosts: true` (the test's "Allow other hosts") lifts the host and address rules. Cloud
  metadata addresses (169.254.169.254, fd00:ec2::254, 100.100.100.200…) stay blocked regardless.
- A header can take a saved secret's value (`secretRef`), only if the secret is allowed on the
  call's site; the secret goes in `secrets` like a typed one.
- The log shows the address without its query string, and never a header value or a secret.

A refused or failed set-up call fails the first step with `setUpFailed` and a message that says
why. `call.try` answers `{ ok: true, status, ms }`, or `{ ok: false, status?, ms?, error, message }`
with `error` one of `invalid`, `refused`, `redirect`, `secret`, `unreachable`, `timeout`, `status`.

## Environment

| Variable | Default | Use |
|---|---|---|
| `BP_HOME` | `~/Library/Application Support/Breakpatch` (Linux: `~/.local/share/Breakpatch`) | base folder |
| `BP_MODELS_DIR` | `$BP_HOME/models` | model downloads |
| `BP_BROWSERS_PATH` | `$PLAYWRIGHT_BROWSERS_PATH`, else `$BP_HOME/browsers` | Chromium |
| `BP_SCREENSHOTS_DIR` | `$BP_HOME/screenshots` | failure/heal screenshots (`<runId>/<n>-<stepId>.png`) |
| `BP_CHROMIUM` | – | explicit Chromium binary (development, CI images) |
| `BP_HEADED` | – | `1` shows the browser window |
| `BP_FAST` | – | `1` shortens every wait (tests) |
| `BP_LOG` | `INFO` | log level (stderr) |
| `HF_ENDPOINT`, `HF_TOKEN` | Hugging Face defaults | model download; development only, ignored by a release build (a packaged sidecar) |
| `BP_NO_SANDBOX` | – | `1` turns Chromium's sandbox off; development only |
| `BP_SANDBOX` | – | Linux (development and CI only): `1` turns Chromium's sandbox on; it's off there by default because containers and CI runners can't start it |

## CLI (CI)

The headless CI command line is Breakpatch Team: `breakpatch-ci run --test FILE`, from the
`breakpatch_team_engine` package (`--secret NAME` allows a saved secret, see below). It runs a test with the same `Runner` and prints the `run.ended`
object (plus `name`, `source: "ci"`) as JSON; exit 0 = pass, 1 = fail, 2 = the file couldn't be
read or its shared steps can't be found, 3 = no usable licence. Like the app, it fills in each
`group` step's children before the run (the pinned version or the latest, nested groups too), from
`apps/<appId>/shared/` next to the test's `tests/` folder. This engine's own command line is `serve` (the sidecar) and `info`;
`breakpatch-engine run` exits 2 and points at `breakpatch-ci`.

**Another system.** A test file's `recordedOn` is compared with the CI machine as in Where a
test was recorded. On a mismatch `breakpatch-ci` prints one line on stderr before the run
("breakpatch-ci: this test was recorded on macOS 15 (Chromium 140), running on Linux
(Chromium 140): screen checks allow for small differences…"), relaxes the screen checks unless
`--strict-systems` is given, and the JSON result carries `ranOn` and `systemMismatch`.

**Chromium.** `breakpatch-ci` uses the Chromium the install command put in its own folder
(`<install folder>/browsers`, next to its Python environment) when neither `BP_BROWSERS_PATH`
nor `PLAYWRIGHT_BROWSERS_PATH` is set, so nothing needs setting after an install.

**Saved secrets in CI.** A step's `secretRef: NAME` (and a set-up or clean-up call header's) takes
its value from the environment variable `BP_SECRET_NAME` (a `-` or `.` in the name is written `_`),
and from nothing else: never a variable of the same name, never the rest of the environment, never
`BREAKPATCH_LICENCE_KEY` (a value equal to the licence key is refused, and the key is taken out of
the environment once read). `--secret NAME` (repeatable) is an allowlist: only the names listed are
looked up, still from `BP_SECRET_NAME`. A secret left out fails its step with `secretMissing` before
anything runs, and stderr says which variable to set. The values go to the engine as bare values,
so they're typed only on the start page's site (see Saved secrets).

`breakpatch-ci` runs under a **machine licence**: a machine seat on the Team licence (like the
local runner Mac's), taken through the licence service's `activate` with `kind: "machine"`, and
checked with the same built-in keys as above. It needs the `ci` feature (`--auto-fix` also needs
`autoFix`, otherwise it runs without fixing and says so on stderr).

| Variable | Use |
|---|---|
| `BREAKPATCH_LICENCE_KEY` | the licence key (a CI secret); needed to activate, never stored |
| `BREAKPATCH_WORKSPACE` | the Team workspace's Firebase project id (or pass `--workspace FILE.bpworkspace`) |
| `BP_SECRET_<NAME>` | the value of the saved secret `NAME` a test uses (see above) |
| `BREAKPATCH_MACHINE_ID` | which machine seat this is; set one fixed value per pipeline on short-lived runners so every job reuses one seat (default: a random id kept in `$BP_HOME/machine-id`). The `deviceId` is hashed from it too |
| `BREAKPATCH_MACHINE_NAME` | shown in the back office (default `CI <host name>`) |
| `BREAKPATCH_LICENCE_FILE` | the cached token (default `$BP_HOME/licence.json`, mode 0600; cache it between jobs to skip the network) |
| `BP_LICENCE_URL` | the licence service (tests, the emulator); default built in |

Each command uses a cached token that verifies and is fresh with no network; one that's a day old
or within two days of `exp` is refreshed; if the service can't be reached (or answers
`rate_limited`), the cached token works until `offlineUntil`, and a machine's token for 7 days after
it was issued at most. With no usable token, the key activates a seat; a freed seat (`released`),
or a token the service refuses (`invalid_token`), is taken again with the key.

`activate` and `refresh` send `deviceId`: a SHA-256 (64 hex characters) of `BREAKPATCH_MACHINE_ID`,
or of the host's id when it isn't set. The service binds the token to it (`dev`) and refuses a
refresh with another one. Requests are `application/json` and at most 16 KB. The licence file also
keeps the latest time seen (with an HMAC keyed from the token's signature): a clock more than a day
behind it, or behind the token's `iat`, makes the licence invalid (`clock_back`) until an online
check succeeds with the clock right.

When it can't be licensed it prints `{ "result": "error", "code", "message", "licence"? }` and
exits 3. `code` is a licence service code (`unknown_key`, `revoked`, `expired`, `out_of_machines`,
`over_seats`, `too_many_devices`, `invalid_token`, `released`, `rate_limited`, `bad_request`) or
`too_large` (413), `unsupported` (415), `no_licence`, `offline`, `offline_too_long`, `clock_back`,
`missing_feature`, `not_machine`, `unavailable`. `over_seats` means the team uses more machine
licences than it pays for and this one was freed; `too_many_devices` that the seat is used on too
many devices: both say to ask the admin.

**Usage counts** (docs/manual.md "Privacy"): each licensed run adds one CI run (passed or
failed) and the day to `usage` in the licence file; the next refresh sends them as
`usage: { runs: { ci }, runsPassed, runsFailed, activeDays }` and they're cleared when the answer says
`usageAccepted: true`. Numbers only, never anything about the test. A licence file that isn't kept
between jobs reports nothing.

`breakpatch-ci licence status` activates or refreshes as needed and prints the `Licence` (exit 0,
or 3 as above); `breakpatch-ci licence release` gives the machine seat back and deletes the cache.
