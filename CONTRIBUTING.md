# Contributing to Breakpatch

Thanks for helping. Breakpatch is here to find what breaks, including in itself.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Paste *Copy details* from the error if there is one. No screenshots of real customer data.
- **Ideas:** open a discussion first. Small, focused changes are easier to accept than big ones.
- **Security problems:** don't open a public issue. Email support@breakpatch.dev (see [SECURITY.md](SECURITY.md)).

## Set up

Requirements: Node 22, Python 3.11 and Rust (stable). The full app needs a Mac with Apple Silicon and macOS 14+; the UI preview and all the tests also run on Linux.

```sh
git clone https://github.com/BreakPatch/breakpatch.git
cd breakpatch
(cd engine && python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]')
cd app && npm ci
npm run dev          # the UI in a browser: open http://localhost:1420/?demo
npm run tauri:dev    # the whole app, with the engine from engine/.venv
```

The README's [For developers](README.md#for-developers) section has the architecture and the details.

## Making a change

1. Branch from `main`: `fix/short-name` or `feat/short-name`.
2. Keep the UI copy in the product's voice: short, plain, second person, no jargon, no exclamation marks. The UI requirements have a table of plain-language terms.
3. Add or update tests for engine changes. UI changes need a screenshot or short clip in the pull request.
4. Before pushing, run the checks CI runs: in `app/`, `npm run lint`, `npx tsc -b` and `npx vitest run`; in `engine/`, `.venv/bin/python -m pytest -q`; in `app/src-tauri/`, `cargo clippy --all-targets -- -D warnings` and `cargo test`.
5. Open a pull request describing what changed and why. Link the issue.

## Things we won't merge

- Anything that sends screenshots, test data or secrets off the user's Mac, or usage data beyond the anonymous counts the manual's Privacy section describes.
- Pixels decide. Page structure (accessible names and roles) may only be used to find things, never CSS or XPath selectors, and every step is still checked on the screen.
- New settings that ask users to tune numbers. If it needs tuning, the app should work it out.

## Releases

Maintainers tag `vX.Y.Z` on `main`. CI builds and signs the app and publishes a GitHub Release with the update archive, `latest.json` and `SHA256SUMS`, which the install command and the in-app updater read.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the same as the project.
