#!/usr/bin/env bash
# Runs the tests for the Breakpatch GitHub Action (action.yml): a suite from the workspace
# (BP_SUITE), or each test file the BP_TESTS patterns match, one after another (a machine licence
# runs one test at a time). Each run's JSON goes to $BP_DIR/results/<n>.json, its exit code to
# <n>.code and its test file to <n>.test; summary.py reads them.
#
# Environment: BP_DIR, BP_CI (the breakpatch-ci command), BP_TESTS (glob patterns, one per line
# or separated by spaces), BP_SUITE, BP_WORKSPACE, BP_AUTO_FIX, BP_FAIL_ON_FIX, BP_SECRETS
# (one --secret value per line), BP_LABEL. The licence and sign-in variables come from the job.
set -euo pipefail
shopt -s nullglob globstar

fail() { echo "::error::$*" >&2; exit 1; }
results="$BP_DIR/results"
shots="$BP_DIR/screenshots"
rm -rf "$results" "$shots"
mkdir -p "$results" "$shots"

opts=()
if [ "${BP_AUTO_FIX:-false}" = true ]; then opts+=(--auto-fix); fi
if [ "${BP_FAIL_ON_FIX:-false}" = true ]; then opts+=(--fail-on-fix); fi
if [ -n "${BP_LABEL:-}" ]; then opts+=(--label "$BP_LABEL"); fi
while IFS= read -r s; do
  s=${s#"${s%%[![:space:]]*}"}; s=${s%"${s##*[![:space:]]}"}
  if [ -n "$s" ]; then opts+=(--secret "$s"); fi
done <<< "${BP_SECRETS:-}"
ws=()
if [ -n "${BP_WORKSPACE:-}" ]; then ws=(--workspace "$BP_WORKSPACE"); fi

# run N TEST-OR-SUITE ARGS…: one breakpatch-ci run.
run() {
  local n=$1 what=$2 code=0
  shift 2
  mkdir -p "$shots/$n"
  echo "::group::$what"
  "$BP_CI" run "$@" ${ws[@]+"${ws[@]}"} --screenshots "$shots/$n" ${opts[@]+"${opts[@]}"} > "$results/$n.json" || code=$?
  echo "::endgroup::"
  echo "$code" > "$results/$n.code"
  printf '%s\n' "$what" > "$results/$n.test"
  case "$code" in
    0) echo "$what: passed" ;;
    1) echo "::error title=Breakpatch::$what failed" ;;
    *) echo "::error title=Breakpatch::$what didn't run (exit $code): $(sed -n 's/.*"message": "\([^"]*\)".*/\1/p' "$results/$n.json" | head -n 1)" ;;
  esac
  # A licence problem (3) stops the rest: every other test would say the same.
  [ "$code" -ne 3 ] || exit 0
}

if [ -n "${BP_SUITE:-}" ]; then
  [ -n "${BP_WORKSPACE:-}" ] || fail "suite needs workspace: the workspace's .bpworkspace file (or hosted:<workspace>)."
  run 1 "suite $BP_SUITE" --suite "$BP_SUITE"
  exit 0
fi

files=()
read -r -a patterns <<< "$(printf '%s' "${BP_TESTS:-}" | tr '\n' ' ')"
for p in ${patterns[@]+"${patterns[@]}"}; do
  # shellcheck disable=SC2206  # the pattern is meant to expand here
  matched=($p)
  files+=(${matched[@]+"${matched[@]}"})
done
[ ${#files[@]} -gt 0 ] || fail "No test files match ${BP_TESTS:-(nothing)}. Set tests to your tests folder's files, for example breakpatch-tests/apps/*/tests/*.json."
n=0
declare -A seen=()
for f in "${files[@]}"; do
  [ -z "${seen[$f]:-}" ] || continue
  seen[$f]=1
  n=$((n + 1))
  run "$n" "$f" --test "$f"
done
