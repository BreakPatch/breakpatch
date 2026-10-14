#!/usr/bin/env bash
# Puts a new SHA256SUMS on this tag's release, for the release workflow's jobs that add files
# (publish-linux, publish-ci; .github/workflows/release.yml):
#
#   scripts/release-put-sums.sh OLD NEW [FILE…]
#
#   OLD    the release's SHA256SUMS before this job (gh release download)
#   NEW    the new one, a file named SHA256SUMS
#   FILE   files to upload first (publish-linux's latest.json, whose line is in NEW)
#
# When NEW has the same lines as OLD (a re-run that added nothing new), nothing is uploaded, so
# the release's SHA256SUMS.asc still signs it. Otherwise the release's SHA256SUMS.asc, which
# signed OLD, is deleted first, then FILE… and NEW are uploaded (--clobber): there's never a stale
# signature beside SHA256SUMS. The sign-sums job, which runs after every job that writes it (and
# again when one of them is re-run), signs the new one.
#
# Needs gh (GH_TOKEN), GITHUB_REF_NAME and GITHUB_REPOSITORY.
set -euo pipefail

die() { echo "release-put-sums: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: release-put-sums.sh OLD NEW [FILE…]"
old=$1 new=$2
shift 2
for f in "$old" "$new"; do [ -f "$f" ] || die "$f isn't there"; done
[ "$(basename "$new")" = SHA256SUMS ] || die "$new must be named SHA256SUMS (gh uploads it under its own name)"
: "${GITHUB_REF_NAME:?}" "${GITHUB_REPOSITORY:?}"

if cmp -s <(LC_ALL=C sort "$old") <(LC_ALL=C sort "$new"); then
  echo "SHA256SUMS is unchanged: nothing to upload, and its signature (if any) still holds."
  exit 0
fi
assets=$(gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')
if printf '%s\n' "$assets" | grep -qx 'SHA256SUMS\.asc'; then
  echo "SHA256SUMS changes: deleting SHA256SUMS.asc, which signed the old one (sign-sums signs the new one)."
  gh release delete-asset "$GITHUB_REF_NAME" SHA256SUMS.asc --yes --repo "$GITHUB_REPOSITORY"
fi
if [ $# -gt 0 ]; then gh release upload "$GITHUB_REF_NAME" "$@" --clobber --repo "$GITHUB_REPOSITORY"; fi
gh release upload "$GITHUB_REF_NAME" "$new" --clobber --repo "$GITHUB_REPOSITORY"
