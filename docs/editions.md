# Editions

Breakpatch has four editions. **Community** is free and open source (Apache 2.0): one person, one Mac, tests saved as files. It's the only one at launch. **Team** is paid: everything shared, unattended or tracked over time. **Business** is Team for bigger companies. **Solo** is Team's automation for one person. Team, Business and Solo aren't on sale yet and have no prices yet: the site shows Team and Business as coming, and hides Solo until the back office's `SOLO_ON_SALE` is on. The Documentation (`docs/manual.md`) names no prices.

| | Community | Solo (not on sale yet) | Team (not on sale yet) | Business (not on sale yet) |
|---|---|---|---|---|
| People | 1 | 1 | From 3 (`tiers.ts` `minSeats`) | From 20 |
| Machine licences | None | 1, no extras | 1 included, more can be bought | 5 included, more can be bought |
| Where tests live | A tests folder | A tests folder or Git; a workspace of your own is optional | A workspace hosted by Breakpatch, or in the customer's own Firebase | The same as Team |

Hosted workspaces (Breakpatch Cloud, no Firebase set-up) are built for Team and Business and will be the default way to get a workspace when they open; the customer's own Firebase stays as "Host it yourself". In the app they're behind the Team module's `HOSTED_OPEN` switch (`app/cloud/config.ts`), off until Breakpatch Cloud opens: until then the app says "Hosted by Breakpatch isn't open yet".

## Community (free)

| Area | Included |
|---|---|
| Recording | Record by clicking or drawing on the page, each step confirmed before it's done (the "Describe the next step" box is off until the real model is checked on a Mac again: `DESCRIBE_STEPS` in `app/src/screens/recorder/actions.ts`); every action (click, double, long and right click, hover, swipe, scroll, drag and drop, write text, wait, go to address, tabs and popups, upload a sample file, check a download); checkpoints; loops; shared steps; set-up and clean-up calls; automatic screen checks; re-record a step |
| Running | Run a test or a suite by hand on this Mac; **Run all** for an app's tests; live run view; report with expected vs seen and the reason; **Copy details** and **Copy as Markdown** (a ready-made bug report) on every failed step |
| Storage | Tests saved as JSON files in a folder you pick (for example inside your project's Git repo). Only the latest version is kept: saving overwrites. The last run of each test is kept. Deleted apps, tests, shared steps and suites stay in Recently deleted (the folder's `deleted/`) for 30 days. |
| This Mac | Saved secrets in the macOS Keychain; the Standard AI assistant, the one built-in model (the Larger one only from Team's runner settings, on 32 GB+); auto-updates; dark and light; works offline; anonymous usage counts you can turn off (Settings → Privacy) |

## Team (paid)

| Area | Included |
|---|---|
| Collaboration | Workspace on your own Firebase (its `(default)` database or a separate one); invite link and `.bpworkspace` file; several workspaces on one Mac; members and roles; shared apps, tests and runs; Only you / In team suite; Check the connection and Edit connection |
| History | Version history with restore; runs show the version they tested; the team's run history, kept 90 days (runs and suite runs carry a required `expiresAt`); lists that grow page 20 at a time |
| Fixing | Fixed automatically (the AI assistant finds moved buttons during a run); Accept new position; Fail the test if anything needed fixing; calibration runs |
| Writing tests | **Write a test from a story** (coming with Team: no tier lists `aiTests` yet): the AI assistant suggests a user story's steps (engine `record.plan`), and the person confirms, skips or edits each one in the recorder |
| Failures | **Why did this fail?**: the AI assistant says in plain words what changed, the likely cause and what to do; **Create issue** in GitHub, Linear or Jira Cloud, with each person's own token |
| Automation | Schedules on any Mac; local runner (runner mode, queue, newest request wins); run requests from CI or other tools; result messages to Slack, Microsoft Teams (Workflows) or any web address, with the failed step's screenshot if the suite asks; `breakpatch-ci` for CI, reading suites and tests straight from the workspace |
| Costs | A copy of the workspace on each Mac and a change marker (`workspace/changes`), so opening it again reads only what changed; the runner's heartbeat on change or every 90 s |

Business is everything in Team, plus 5 machine licences and the `modelOverride` feature (choosing another AI model), which has no screen yet: the built-in model is the only one, and the Documentation says bringing your own isn't available yet. Its support and billing are set when it goes on sale.

Solo (when it goes on sale) is Team's automation for one person: fixed automatically, Why did this fail?, schedules on the Mac, result messages and `breakpatch-ci`, on a tests folder. Version history, the local runner and run requests need a workspace of its own. It has no members, roles, sharing, model override or Create issue. The site hides it until `soloOnSale` is on (site/README.md). The app side is in the Team module (Settings → Licence → Enter Solo licence key on a tests folder).

## Licence features

Team features come from the licence's `features` (`app/src/edition/types.ts` `Features`; the back office's `tiers.ts` decides each tier's list):

| Feature | What it turns on | Solo | Team, Business |
|---|---|---|---|
| `collaboration` | Shared workspace, members, Only you / In team suite | No | Yes |
| `versions` | Version history and restore | With a workspace | Yes |
| `autoFix` | Fixed automatically, Accept new position, Fail the test if anything needed fixing | Yes | Yes |
| `calibration` | Calibration runs | Yes | Yes |
| `schedules` | Schedules | Yes | Yes |
| `runner` | Local runner, run requests, result messages | With a workspace | Yes |
| `ci` | `breakpatch-ci` | Yes | Yes |
| `modelOverride` | The workspace's AI assistant model | No | Yes (sold as a Business feature) |
| `explain` | Why did this fail? (engine `run.explain`) | Yes | Yes |
| `integrations` | Create issue in GitHub, Linear or Jira | No | Yes (needs a workspace) |
| `aiTests` | Write a test from a story (engine `record.plan`) | Not decided | Not decided (no tier lists it yet: the back office's `tiers.ts`) |

Licences issued before a feature existed get it at their next refresh (tokens last 7 days). Copy as Markdown isn't a feature: it's in every edition.

## Data format safety (Team)

Workspaces carry a `schemaVersion`: the data format the newest app that saved there uses. The app raises it automatically the first time it saves in a newer format. An older app that finds a higher number keeps reading and running tests, but saving is turned off, with the banner "Update Breakpatch to save changes. Someone on your team uses a newer version." There is no minimum app version setting and no blocking update screen. Community tests folders have the same number in `breakpatch.json`: an older app refuses a folder with a higher one. A folder or workspace only moves to a newer format when it needs to: for example, the first phone or tablet test raises it, so an app from before phone tests won't open the folder, or save over the test in a workspace. An older Team app, local runner or `breakpatch-ci` can still run a workspace's phone test as a desktop test, though, and so can an older `breakpatch-ci` from a test file: update them first. From the version with phone tests on, the local runner and `breakpatch-ci` don't run the tests of a workspace whose number is higher than they know, and say to update. The security rules can also refuse an older app's writes outright: since batch 2, a run without `expiresAt`, or a change to apps, tests, shared steps or suites that doesn't move the change marker.

## Code layout

- **Open source** (this repository, Apache 2.0) is the Community edition: the app shell, Home and apps, the recorder and shared steps editor, the run view and report (with Copy as Markdown, `screens/report/issueText.ts`), suites (list and editor), Setup, Settings (AI assistant, Saved secrets, Appearance, Privacy, About), the demo backend, the local file backend (`data/local/`), and the engine's recording, replay and screen checks. The shell's Team-only commands are open code too, used only when the Team module calls them: posting result messages (`runner.rs`) and the GitHub, Linear and Jira clients with each person's token in the Keychain (`trackers.rs`).
- **Commercial module** (private `BreakPatch/breakpatch-team`, licence key) is the Team edition: the Firebase workspace backend (connect, invite links, sign in, members, `schemaVersion`, the cache and change marker), version history, fixing and calibration, the explainer behind Why did this fail?, the planner behind Write a test from a story, schedules, the local runner, run requests, result messages (Slack and Teams), Create issue (Settings → Issue trackers), the CI command line, the security rules, the licence screens (Settings → Licence, the licence banner) and the licence service, and the Breakpatch Cloud server side (not open yet).

How they fit:

- **App.** The Team module is linked in at `app/src/edition/team` (`scripts/link-team.sh`, undone by `scripts/unlink-team.sh`; the link is gitignored). `app/src/edition/index.ts` finds it at build time; without it the app builds as Community. The module default-exports an `Edition` (`app/src/edition/types.ts`): its starting `features` (read in open screens with `useFeature(...)` or `hasFeature(...)`, see Licence below), routes, Settings sections (each can hide itself with a `useVisible` hook), top-nav items, slots in open screens (Suites columns, Run on runner, the suite editor panel, the report's actions for a fixed step and for a failed step, the welcome screen, a line above the apps on Home), the first-launch gate and `openWorkspace`. Team code imports open code as `@bp/…`, never by relative path; bare imports resolve from `app/node_modules` (`preserveSymlinks`), so there is one React.
- **Engine.** The open engine is Community. The Team package `breakpatch_team_engine` is installed into the same venv; `engine/src/breakpatch_engine/plugins.py` imports it (the only place that does) and it registers the healer for moved targets, the explainer for `run.explain` and the planner for `record.plan`. It also ships the `breakpatch-ci` command, which CI machines install with `https://breakpatch.dev/install-ci`: the open engine's wheel and the Team engine compiled to a native module in a wheel of its own (`scripts/build-ci.sh`, run by the release after the app). Without it, a moved target fails with `targetNotFound`, and `run.explain` and `record.plan` answer `not_ready`.
- **Licence.** Team features come from the licence, not from the build. The Rust shell (`app/src-tauri/src/licence.rs`) checks licence tokens offline against Ed25519 public keys compiled in from `BREAKPATCH_LICENCE_PUBKEYS`; Community and source builds have none, so its commands (`licence_status`, `licence_activate`, `licence_refresh`, `licence_release`) answer "not available in this edition". The shell hands the stored token to the engine sidecar (`licence.set`, engine/PROTOCOL.md "Licence"); the Team engine checks it again with the same keys, built into it by `scripts/build-release.sh`, and heals only with the `autoFix` feature and explains only with `explain`. `breakpatch-ci` runs under a machine licence of its own (PROTOCOL.md "CLI (CI)"). Open screens read features from `app/src/edition/features.ts` (`useFeature` re-renders when they change, `hasFeature` reads them once); Community's are all off and locked, and the Team module's Provider sets them from the licence at runtime.
- **Builds.** `scripts/build-release.sh --edition community|team` builds either edition the way releases are built, checks that the sidecar's `system.info` and the frontend are the edition asked for, and always leaves the checkout as Community. CI in this repository builds and tests Community only (including that script). The release workflow checks out the Team module next to this repo and runs the script with `--edition team`. Settings → About shows the edition, and warns when the app and its engine disagree.
- **Usage counts** (docs/manual.md "Privacy"). The counting (`app/src/data/countUsage.ts`, wrapping every backend the session opens) and the shell's store and sender (`app/src-tauri/src/usage.rs`) are open code in both editions. Community sends anonymous daily totals with no identifier to `/api/usage` (on unless turned off; Settings → Privacy, `BREAKPATCH_NO_USAGE=1`). Team, told apart by the licence keys built in, sends its counts with each licence refresh instead; the Team runner marks schedule runs (`addRun(…, { trigger: 'schedule' })`) and `breakpatch-ci` counts its own runs in its licence file.
- **Upgrading from Community.** Both editions are the same app (`dev.breakpatch.app`), so installing Team over Community keeps the AI assistant model and browser in `~/Library/Application Support/Breakpatch`, the settings and saved secrets, and access to the tests folder. Team opens that folder as it was (the app works as Community there) and offers **Settings → Upgrade to Team**: connect a workspace, activate the licence, copy the tests. The open app gives it only a read-everything view of a folder (`LocalBackend.read`, a `FolderSnapshot`); the plan, the copy and the workspace writes are in the Team module (`app/upgrade/`). Copying never changes the folder until the copy has been read back and checked, and each item's workspace id comes from its place in the folder and when it was made, so copying again adds only what's new. A last run over 90 days old isn't copied (the workspace keeps 90 days). Only then, and once confirmed, does the folder's copy go to the Trash.
