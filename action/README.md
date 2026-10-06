# Breakpatch UI tests: GitHub Action

Runs your [Breakpatch](https://breakpatch.dev) UI tests in GitHub Actions with `breakpatch-ci`. It installs `breakpatch-ci` for the runner, keeps the test browser and the machine licence in the Actions cache, runs the tests, writes a table to the job summary, uploads the screenshots of failed steps, and fails the job when a test fails.

It's a draft, kept in the open repo under `action/`. It will move to `BreakPatch/run`, and then you'll write `uses: BreakPatch/run@v1`.

## What you need

- A Breakpatch Team licence with a free **machine licence** for CI. Store the licence key as a secret, for example `BREAKPATCH_LICENCE_KEY`.
- A runner with Linux (x64 or arm64), macOS on Apple Silicon, or Windows x64. GitHub's `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15` and `windows-latest` all work.
- One run at a time per machine licence: add `concurrency:` to the job (below).

## Run the tests folder

```yaml
jobs:
  ui-tests:
    runs-on: ubuntu-24.04
    concurrency: breakpatch-ci          # one run at a time per machine licence
    steps:
      - uses: actions/checkout@v4
      - uses: BreakPatch/run@v1
        with:
          licence-key: ${{ secrets.BREAKPATCH_LICENCE_KEY }}
```

That runs every test file in `breakpatch-tests/apps/*/tests/`, one after another.

## Run a suite from the workspace

```yaml
      - uses: BreakPatch/run@v1
        with:
          licence-key: ${{ secrets.BREAKPATCH_LICENCE_KEY }}
          workspace: team.bpworkspace
          suite: smoke-7f3a
          secrets: STAGING_PASSWORD=https://staging.acme.com
        env:
          BREAKPATCH_CI_EMAIL: ${{ secrets.BREAKPATCH_CI_EMAIL }}
          BREAKPATCH_CI_PASSWORD: ${{ secrets.BREAKPATCH_CI_PASSWORD }}
          BP_SECRET_STAGING_PASSWORD: ${{ secrets.STAGING_PASSWORD }}
```

The CI account, the workspace file and saved secrets work as in the manual: [From CI with breakpatch-ci](https://breakpatch.dev/docs/#from-ci-with-breakpatch-ci). An encrypted workspace also needs `BREAKPATCH_MACHINE_KEY` in `env`.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `licence-key` | (required) | Your licence key. Keep it in a secret. |
| `tests` | `breakpatch-tests/apps/*/tests/*.json` | Test files to run, as glob patterns. Separate several with spaces or new lines. Paths with spaces aren't supported. |
| `suite` | | A suite to run from the workspace instead, by ID or name. Needs `workspace`. |
| `workspace` | | The workspace's `.bpworkspace` file, or `hosted:<workspace>`. |
| `version` | `latest` | The `breakpatch-ci` version, for example `1.2.3`. |
| `auto-fix` | `false` | `true` lets the AI assistant fix a step whose button moved. It needs a licence with Fixed automatically and a Mac with the AI assistant. |
| `fail-on-fix` | `false` | `true` fails a test that needed fixing. |
| `machine-id` | `github-<repository ID>` | A fixed name for this pipeline's machine licence, so every job reuses one. Give parallel jobs a name each. |
| `upload-screenshots` | `on-failure` | Upload the failed steps' screenshots as an artifact: `on-failure`, `always` or `never`. They can show personal data. |
| `artifact-name` | unique per job | The screenshots artifact's name. The default, `breakpatch-screenshots-<job>-<job index>-<hash>-<attempt>`, differs for each matrix leg and each set of `tests` or `suite`, so several uses in one run don't collide. |
| `secrets` | | Saved secrets the tests may use, one per line: `NAME`, or `NAME=https://site` for workspace tests. Each value comes from `BP_SECRET_<NAME>` in `env`. |
| `github-token` | the job's token | Reads the release from GitHub. |

## Outputs

| Output | What it holds |
|---|---|
| `result` | `passed`, `failed`, or `error` (a test couldn't run, or there's no usable licence) |
| `passed` | How many tests passed |
| `failed` | How many tests failed or didn't run |
| `json` | The path of a JSON file with every test's result |

```yaml
      - uses: BreakPatch/run@v1
        id: ui
        with:
          licence-key: ${{ secrets.BREAKPATCH_LICENCE_KEY }}
      - if: always()
        run: echo "UI tests ${{ steps.ui.outputs.result }}: ${{ steps.ui.outputs.passed }} passed, ${{ steps.ui.outputs.failed }} failed"
```

## What it does

1. Finds the release (`version`) of `BreakPatch/breakpatch`, downloads its `SHA256SUMS`, the requirements file for this runner and the two wheels it names, and checks each against `SHA256SUMS`. It refuses a requirements file that names anything but those two wheels and packages on PyPI.
2. Makes a Python 3.11 environment (with `actions/setup-python`, leaving your job's Python alone) and installs with `pip --require-hashes --only-binary=:all:`.
3. Restores Chromium from the cache, or runs `breakpatch-ci setup` to install it. On Linux, when Chromium's system libraries are missing, it adds them with `sudo playwright install-deps chromium`.
4. Restores the machine licence file from this repository's cache, so most runs don't need to check online, and saves it again at the end.
5. Runs each test file, or the suite, with `--screenshots`, and the label `GitHub · <workflow> · run <number>`.
6. Writes the table to the job summary, uploads the screenshots, sets the outputs, and fails the job unless every test passed.

## Testing it

`bash action/test.sh` tests the scripts on Linux against a fake release and a stand-in `breakpatch-ci`. CI runs it with `actionlint` and `shellcheck`.
