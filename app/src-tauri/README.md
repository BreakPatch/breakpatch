# Breakpatch desktop shell (Tauri 2)

The native side of the app: the window, the Python engine sidecar, Keychain secrets,
`.bpworkspace` files, `breakpatch://` links, the updater and the local-runner helpers.
The UI reaches it through `src/platform.ts`, `src/engine/sidecarEngine.ts` and `src/lib/updates.ts`.

```
src/lib.rs        plugins, commands, app lifecycle (RunEvent::Opened / Exit)
src/engine.rs     sidecar supervisor + JSON-lines request table (engine/PROTOCOL.md)
src/secrets.rs    Keychain store + name index
src/workspace.rs  opened .bpworkspace files
src/runner.rs     keep awake, memory size, result messages
tauri.conf.json   window, bundle, CSP, file association, deep link, updater
capabilities/     what the webview may call
Entitlements.plist hardened-runtime exceptions the PyInstaller sidecar needs
signing/          the public part of Breakpatch's code signing certificate (.cer, fingerprint.txt)
```

## Commands and events

| Command | Args | Returns |
|---|---|---|
| `engine_request` | `method, params` | the engine's `result`; rejects with the JSON string `{code, message, details}` |
| `secrets_list` | – | saved names, sorted |
| `secrets_set` | `name, value` | – |
| `secrets_delete` | `name` | – |
| `secrets_resolve` | `names` | `{name: value}` for the names that exist; missing ones are left out |
| `workspace_file_take` | – | the `.bpworkspace` text the app was launched with, once, or `null` |
| `runner_keep_awake` | `on` | – (`caffeinate -dimsu -w <pid>` on macOS, no-op elsewhere) |
| `runner_open_at_login` | `on` | resulting state (autostart plugin, LaunchAgent) |
| `runner_open_at_login_enabled` | – | current state |
| `system_memory_gb` | – | installed RAM in whole GB |
| `runner_post_result` | `url, body` | HTTP status (POST from Rust so the CSP can stay strict) |

Events: `engine://event` `{event, data}` for every engine event line, and `workspace-file`
(the file's text) when a `.bpworkspace` file is opened while the app runs.

**Engine.** `breakpatch-engine serve` starts with the app. Each request gets an id and a
pending entry; the matching stdout line resolves it. Requests time out after 60 s
(180 s for recording and browser calls; none for the browser install and model download,
which report progress through events). If the engine exits, waiting requests fail with
`internal` and it restarts after 1, 2, 4 … 30 s. Its stderr goes to the app log
(`~/Library/Logs/dev.breakpatch.app/`). On quit it gets SIGINT (the engine closes
Chromium), then SIGTERM after 3 s, then SIGKILL.

## Develop

Needs Node 22, Rust stable and the engine's venv
(`cd engine && python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]'`).
On Linux also the WebKit libraries (`libwebkit2gtk-4.1-dev` and friends, see `.github/workflows/ci.yml`).

```sh
cd app
npm install
npm run tauri:dev      # writes the dev sidecar, then `tauri dev` (Vite on :1420)
```

`scripts/dev-sidecar.sh` writes `binaries/breakpatch-engine-<host triple>`, a tiny shell
script that runs `python -m breakpatch_engine` from `engine/.venv`. It never overwrites a
real build (use `--force` to replace one). Sidecar binaries are gitignored.

```sh
cargo check && cargo clippy -- -D warnings && cargo test   # in app/src-tauri
```

In a debug build on Linux the `breakpatch://` scheme is registered at start-up so links can be
tried; on macOS the scheme and the file association only work from a bundled `.app`.

## Build a release locally

```sh
scripts/build-release.sh --target aarch64-apple-darwin      # from the repo root
```

Output in `target/aarch64-apple-darwin/release/bundle/`: `dmg/Breakpatch_<v>_aarch64.dmg`,
`macos/Breakpatch.app`, and with the updater key set, `Breakpatch.app.tar.gz` + `.sig`.
Without signing secrets the app is signed ad-hoc (the script warns): fine to try, not to ship.

CI does this on every `v*` tag (`.github/workflows/release.yml`) and publishes a GitHub
Release with the `.dmg`, `.app.tar.gz`, `.sig`, `latest.json` and `SHA256SUMS`. The tag must
match `app/package.json` `version` (the app version comes from there).

## Hardening (Team release)

**This is deterrence, not protection. The licence check is the real gate** — Team features come
from the licence, not from the build (`docs/editions.md` "Licence"): the app shell and the engine
both verify Ed25519 licence tokens against keys compiled in at build time. Hardening only raises
the effort to lift the paid code out of a shipped `.app`; a determined person with the binary can
still recover a lot. Do not rely on it for anything the licence check should enforce. **Community
is untouched** — it is Apache-2.0 open source, so it ships plainly minified with nothing hidden.

What a Team build does (all in `scripts/build-release.sh`, which fails the build if any of it
regressed):

- **Engine — native code.** The paid Python package `breakpatch_team_engine` is compiled to a
  single native extension (`.so`) with Nuitka before packaging, so **no `.py` or `.pyc` of it
  ships** — not even the licence keys, which live in a generated `_keys.py` that is compiled into
  that `.so`. The rest of the sidecar is packaged as before with PyInstaller (`--onefile`), which
  is proven with Playwright's driver and mlx / mlx-vlm. See `engine/scripts/build_sidecar.sh`.
  - Nuitka keeps docstrings and identifier names as readable strings, and control flow is native
    but not encrypted. So this hides the *source*, not the *behaviour*.
  - `SIDECAR_COMPILER=nuitka` compiles the **whole** sidecar with Nuitka instead. It is opt-in
    because Nuitka cannot package **Playwright's driver** cleanly today (it claims
    `playwright/driver/node` as both an executable and a data file) and compiling mlx-vlm /
    transformers on the macOS runner is slow (tens of minutes) and fragile. PyInstaller is the
    shipping default for exactly that reason; the Team package is native either way.
  - `BP_NO_HARDEN=1` skips the native compile and ships the Team source (`.pyc`). Local debugging
    only — a release built this way fails the checks below.
- **Frontend — Team edition (`app/vite.config.ts`).** Terser minify (Community stays on the
  default oxc minifier); **no source maps**; `console` and `debugger` stripped; property mangling
  scoped to our own `_bp_`-prefixed properties only (broad mangling would break Firebase, React
  and the Tauri IPC / JSON formats, so it is deliberately off). Our Team code is kept in its own
  `team` chunk, the Firebase SDK in a separate `vendor-firebase` chunk.
  - `BP_OBFUSCATE=1` additionally runs `javascript-obfuscator` (moderate: control-flow flattening
    at 0.5, base64 string array, no dead-code injection or self-defending) over the `team` chunk
    **only** — never the Firebase vendor chunk. Measured cost on the current app: the `team` chunk
    grows ~84 % (≈340 KB → ≈625 KB), total JS ~21 % (≈1.35 MB → ≈1.64 MB); every other chunk is
    byte-for-byte unchanged. Runtime/startup cost was not measured on-device — flatten + string-
    array add parse and decode overhead, so keep it opt-in and time a real launch before enabling.
- **Bundle checks (Team only, fail the build):** no `.py`/`.pyc` of `breakpatch_team_engine`
  (the sidecar's PyInstaller archive is inspected too), no JS source maps (`.map` files or
  `sourceMappingURL`), and no readable Team-checkout source paths embedded in the engine or the
  frontend.

Nuitka must be in the build venv (`engine[hardening]` — `nuitka`, `zstandard`);
`scripts/build-release.sh` installs it for Team builds, and `release.yml` caches Nuitka + ccache
across runs to keep build time down.

## Code signing

Keychain items belong to the app's *designated requirement*, which comes from its code
signature. Every release must keep the same one, or users get a Keychain prompt per saved
secret (and the licence) after updating, and an unattended runner stops at those prompts.
`scripts/build-release.sh` signs the sidecar and the app with the first of:

1. **Apple Developer ID** (`APPLE_*` secrets): hardened runtime, notarised. Gatekeeper-friendly
   `.dmg`. Switching to it changes the designated requirement once.
2. **Breakpatch's own certificate** (`BP_CODESIGN_P12`, `BP_CODESIGN_P12_PASSWORD`): a
   self-signed code signing certificate, imported into a temporary keychain for the build.
   Not notarised, hardened runtime off. The build fails if it isn't the certificate in
   `signing/fingerprint.txt`.
3. **Ad-hoc** (`codesign -s -`): local builds only. `--release` refuses it.

It then checks the app with `codesign --verify --deep --strict`, prints the designated
requirement, and checks that the update archive and the `.dmg` hold the same signed app.

**Make the certificate (once, on a Mac):** `scripts/make-signing-cert.sh`. It prints what to
store as the two `BP_CODESIGN_P12*` secrets in `BreakPatch/breakpatch`, writes
`signing/breakpatch-codesign.cer` and `signing/fingerprint.txt` to commit, and tells you to
keep the `.p12` and its password in a password manager. Losing them means a new certificate,
and one round of Keychain prompts for everyone.

Installing: `site/install` (served at `https://breakpatch.dev/install`) downloads the
`.app.tar.gz` with `curl`, checks it against `SHA256SUMS` and puts it in `/Applications`.
Files downloaded with `curl` aren't quarantined, so Gatekeeper doesn't stop the app.
`scripts/test-install.sh` tests it on Linux.

Repository secrets used by the release:

| Secret | What |
|---|---|
| `BP_CODESIGN_P12` | base64 of Breakpatch's own `.p12` (from `scripts/make-signing-cert.sh`) |
| `BP_CODESIGN_P12_PASSWORD` | its password |
| `APPLE_CERTIFICATE` | optional, instead: base64 of the Developer ID Application `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarisation |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the 10-character team id |
| `TAURI_SIGNING_PRIVATE_KEY` | updater private key (contents of the key file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

## Updater key (do this once)

```sh
cd app
npx tauri signer generate -w ~/.tauri/breakpatch.key
```

1. Put the contents of `~/.tauri/breakpatch.key.pub` in `tauri.conf.json` →
   `plugins.updater.pubkey`. Done: the key in there is minisign key `31BEE88B0973C31B`. Only
   replace it if the private key is lost, and then installed apps can't update any more.
2. Save the contents of `~/.tauri/breakpatch.key` as `TAURI_SIGNING_PRIVATE_KEY` and its
   password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep the private key somewhere safe. Losing it means installed apps can't update any more.

The endpoint is `https://github.com/BreakPatch/breakpatch/releases/latest/download/latest.json`.
`requireSignedVersion` is on, so every release must be signed by a current Tauri CLI.

## Secrets

Values live in the macOS Keychain, service `dev.breakpatch.secrets`, account = the reference
name (e.g. `ACME_TEST_EMAIL`). The Keychain can't enumerate entries for an app, so the
names are also kept in `~/Library/Application Support/dev.breakpatch.app/secrets-index.json`
(names only, never values). To inspect one by hand:

```sh
security find-generic-password -s dev.breakpatch.secrets -a ACME_TEST_EMAIL -w
```

On Linux (development only) values go to the kernel keyring and don't survive a reboot.

## Security

- CSP: scripts from the app only; styles and fonts also from Google Fonts; network only to
  the Firebase endpoints (Auth, Firestore, Remote Config, Storage). `devCsp` additionally
  allows Vite's inline preamble and HMR socket in `tauri dev`.
- The webview can read and write only files the user picked in an open/save dialog.
- `shell:allow-open` opens web links in the default browser.
- The asset protocol serves the engine's folder (`~/Library/Application Support/Breakpatch`,
  for failure screenshots) and the app's own data and cache folders.

## Window

1280 × 800 (also the minimum), overlay title bar with hidden title. The traffic lights sit
at `trafficLightPosition` `{x: 16, y: 20}` to centre them in the 52 px bar next to the
`.traffic-space` placeholder in `AppFrame`; check it on a Mac after macOS updates.
