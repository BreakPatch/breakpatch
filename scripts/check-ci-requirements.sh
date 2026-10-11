#!/usr/bin/env bash
# Checks breakpatch-ci's files before a release publishes them (release.yml's publish-ci runs it
# on the folder holding every platform's files; CI's ci-command on the Linux build's).
#
#   scripts/check-ci-requirements.sh DIR
#
# Every breakpatch-ci-requirements-<platform>.txt in DIR (there must be one) must, as
# https://breakpatch.dev/install-ci and install-ci.ps1 read it:
#   - have LF line endings (scripts/ci-requirements.py writes LF on Windows too; a CR on a line
#     hides the wheels from the line patterns below),
#   - name exactly two wheels, "./<name>.whl --hash=sha256:<64 hex>", the open engine's
#     (breakpatch_engine-*) and the Team engine's (breakpatch_team_engine-*), and no other local
#     file or address,
#   - and each wheel must be in DIR with the hash the file gives.
set -euo pipefail

fail() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error::$*"; fi
  echo "check-ci-requirements: $*" >&2
  exit 1
}

if [ $# -ne 1 ] || [ ! -d "$1" ]; then echo "usage: $0 DIR" >&2; exit 2; fi
dir=$1
expected=$(mktemp "${TMPDIR:-/tmp}/bp-check-ci.XXXXXX")
trap 'rm -f "$expected"' EXIT

n=0
for req in "$dir"/breakpatch-ci-requirements-*.txt; do
  [ -f "$req" ] || continue
  n=$((n + 1))
  name=${req#"$dir"/}
  if LC_ALL=C grep -q $'\r' "$req"; then
    fail "$name has CRLF line endings; scripts/ci-requirements.py writes LF"
  fi
  LC_ALL=C sed -n 's#^\./\([A-Za-z0-9][A-Za-z0-9._-]*\.whl\) --hash=sha256:\([0-9a-f]\{64\}\)$#\2  \1#p' "$req" > "$expected"
  local_lines=$(LC_ALL=C grep -c '^[^#A-Za-z0-9 ]' "$req" || true)
  if [ "$(wc -l < "$expected" | tr -d ' ')" -ne 2 ] || [ "$local_lines" -ne 2 ] \
    || ! grep -q '  breakpatch_engine-' "$expected" || ! grep -q '  breakpatch_team_engine-' "$expected"; then
    fail "$name doesn't name two wheels (the engine's and the Team engine's) and no other file"
  fi
  if LC_ALL=C grep -v '^[[:space:]]*#' "$req" | LC_ALL=C grep -q '://\|@ '; then
    fail "$name names a package by address"
  fi
  (cd "$dir" && sha256sum --check --strict --quiet "$expected") \
    || fail "$name names a wheel that isn't in $dir with the hash it gives"
  echo "check-ci-requirements: $name: $(awk '{ print $2 }' "$expected" | tr '\n' ' ')ok"
done
[ "$n" -gt 0 ] || fail "no breakpatch-ci-requirements-*.txt in $dir"
