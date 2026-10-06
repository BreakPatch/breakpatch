#!/usr/bin/env bash
# The screenshots artifact's name, for the Breakpatch GitHub Action (action.yml). Artifact names
# are unique within a workflow run, so the default tells apart every job that uses the action:
#
#   breakpatch-screenshots-<job>-<job index>-<hash>-<attempt>
#
# <job index> is strategy.job-index (each matrix leg has its own), and <hash> the first 8 hex
# digits of the SHA-256 of the tests and suite inputs (two uses in one job with different tests).
# The artifact-name input replaces it. Writes `name=` to GITHUB_OUTPUT.
# Environment: BP_ARTIFACT_NAME, BP_JOB, BP_JOB_INDEX, BP_TESTS, BP_SUITE, BP_ATTEMPT, GITHUB_OUTPUT.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-8; }

name=${BP_ARTIFACT_NAME:-}
if [ -z "$name" ]; then
  hash=$(printf 'tests=%s\nsuite=%s\n' "${BP_TESTS:-}" "${BP_SUITE:-}" | sha256)
  name="breakpatch-screenshots-${BP_JOB:-job}-${BP_JOB_INDEX:-0}-$hash-${BP_ATTEMPT:-1}"
fi
# What upload-artifact refuses in a name.
bad_chars='[":<>|*?\\/]'
case "$name" in *$'\r'* | *$'\n'*) fail "artifact-name can't have a new line." ;; esac
if printf '%s' "$name" | LC_ALL=C grep -q "$bad_chars"; then
  fail "artifact-name can't have any of \" : < > | * ? \\ /, and it's $name"
fi
echo "name=$name" >> "$GITHUB_OUTPUT"
