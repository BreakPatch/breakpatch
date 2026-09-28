# Editions

Breakpatch comes in two editions. **Community** is free and open source (Apache 2.0): one person, one Mac, tests saved as files. **Team** is paid: everything shared, unattended or tracked over time.

## Community (free)

| Area | Included |
|---|---|
| Recording | Record by clicking; describe a step and let the AI assistant find it; every action (click, double, long and right click, hover, swipe, scroll, drag and drop, write text, wait, go to address, tabs and popups, upload a sample file, check a download); checkpoints; loops; shared steps; set-up and clean-up calls; automatic screen checks; re-record a step |
| Running | Run a test or a suite by hand on this Mac; live run view; report with expected vs seen and the reason |
| Storage | Tests saved as JSON files in a folder you pick (for example inside your project's Git repo). Only the latest version is kept: saving overwrites. The last run of each test is kept. |
| This Mac | Saved secrets in the macOS Keychain; Standard AI assistant (Larger optional on 32 GB+); auto-updates; dark and light; works offline; anonymous usage counts you can turn off (Settings → Privacy) |

## Team (paid)

| Area | Included |
|---|---|
| Collaboration | Workspace on your own Firebase; invite link and `.bpworkspace` file; members and roles; shared apps, tests and runs; Only you / In team suite |
| History | Version history with restore; runs show the version they tested; full run history for the team |
| Fixing | Fixed automatically (the AI assistant finds moved buttons during a run); Accept new position; Fail the test if anything needed fixing; calibration runs |
| Automation | Schedules on any Mac; local runner (runner mode, queue, newest request wins); run requests from CI or other tools; result messages; headless CLI for CI |
| Company controls | AI assistant model override per workspace |

## Data format safety (Team)

Workspaces carry a `schemaVersion`: the data format the newest app that saved there uses. The app raises it automatically the first time it saves in a newer format. An older app that finds a higher number keeps reading and running tests, but saving is turned off, with the banner "Update Breakpatch to save changes. Someone on your team uses a newer version." There is no minimum app version setting and no blocking update screen. Community files are local and don't need this.

## Code layout

- **Open source** (this repository, Apache 2.0) is the Community edition: the app shell, Home and apps, the recorder and shared steps editor, the run view and report, suites (list and editor), Setup, Settings (AI assistant, Saved secrets, Appearance, Privacy, About), the demo backend, and the engine's recording, replay and screen checks. The local file backend comes next.
- **Commercial module** (private `BreakPatch/breakpatch-team`, licence key) is the Team edition: the Firebase workspace backend (connect, invite links, sign in, members, `schemaVersion`), version history, fixing and calibration, schedules, the local runner, run requests, result messages, the CI command line, the security rules, and the licence screens (Settings → Licence, the licence banner) and the licence service.

How they fit:

- **App.** The Team module is linked in at `app/src/edition/team` (`scripts/link-team.sh`, undone by `scripts/unlink-team.sh`; the link is gitignored). `app/src/edition/index.ts` finds it at build time; without it the app builds as Community. The module default-exports an `Edition` (`app/src/edition/types.ts`): its starting `features` (read in open screens with `useFeature(...)` or `hasFeature(...)`, see Licence below), routes, Settings sections (each can hide itself with a `useVisible` hook), top-nav items, slots in open screens (Suites columns, Run on runner, the suite editor panel, the welcome screen, a line above the apps on Home), the first-launch gate and `openWorkspace`. Team code imports open code as `@bp/…`, never by relative path; bare imports resolve from `app/node_modules` (`preserveSymlinks`), so there is one React.
- **Engine.** The open engine is Community. The Team package `breakpatch_team_engine` is installed into the same venv; `engine/src/breakpatch_engine/plugins.py` imports it (the only place that does) and it registers the healer for moved targets. It also ships the `breakpatch-ci` command. Without it, a moved target fails with `targetNotFound`.
- **Licence.** Team features come from the licence, not from the build. The Rust shell (`app/src-tauri/src/licence.rs`) checks licence tokens offline against Ed25519 public keys compiled in from `BREAKPATCH_LICENCE_PUBKEYS`; Community and source builds have none, so its commands (`licence_status`, `licence_activate`, `licence_refresh`, `licence_release`) answer "not available in this edition". The shell hands the stored token to the engine sidecar (`licence.set`, engine/PROTOCOL.md "Licence"); the Team engine checks it again with the same keys, built into it by `scripts/build-release.sh`, and heals only with the `autoFix` feature. `breakpatch-ci` runs under a machine licence of its own (PROTOCOL.md "CLI (CI)"). Open screens read features from `app/src/edition/features.ts` (`useFeature` re-renders when they change, `hasFeature` reads them once); Community's are all off and locked, and the Team module's Provider sets them from the licence at runtime.
- **Builds.** `scripts/build-release.sh --edition community|team` builds either edition the way releases are built, checks that the sidecar's `system.info` and the frontend are the edition asked for, and always leaves the checkout as Community. CI in this repository builds and tests Community only (including that script). The release workflow checks out the Team module next to this repo and runs the script with `--edition team`. Settings → About shows the edition, and warns when the app and its engine disagree.
- **Usage counts** (docs/manual.md "Privacy"). The counting (`app/src/data/countUsage.ts`, wrapping every backend the session opens) and the shell's store and sender (`app/src-tauri/src/usage.rs`) are open code in both editions. Community sends anonymous daily totals with no identifier to `/api/usage` (on unless turned off; Settings → Privacy, `BREAKPATCH_NO_USAGE=1`). Team, told apart by the licence keys built in, sends its counts with each licence refresh instead; the Team runner marks schedule runs (`addRun(…, { trigger: 'schedule' })`) and `breakpatch-ci` counts its own runs in its licence file.
- **Upgrading from Community.** Both editions are the same app (`dev.breakpatch.app`), so installing Team over Community keeps the AI assistant model and browser in `~/Library/Application Support/Breakpatch`, the settings and saved secrets, and access to the tests folder. Team opens that folder as it was (the app works as Community there) and offers **Settings → Upgrade to Team**: connect a workspace, activate the licence, copy the tests. The open app gives it only a read-everything view of a folder (`LocalBackend.read`, a `FolderSnapshot`); the plan, the copy and the workspace writes are in the Team module (`app/upgrade/`). Copying never changes the folder, and each item's workspace id comes from its place in the folder and when it was made, so copying again adds only what's new.
