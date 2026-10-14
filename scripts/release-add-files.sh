#!/usr/bin/env bash
# Adds files to a release's SHA256SUMS, for the release workflow's publish-ci job
# (.github/workflows/release.yml):
#
#   scripts/release-add-files.sh SUMS DIR OUT
#
#   SUMS   the release's SHA256SUMS, as it is now (gh release download)
#   DIR    the files to add (every file in it)
#   OUT    gets SHA256SUMS (SUMS's lines as they are, then a line per DIR file it hasn't) and
#          upload.txt: every DIR file, one path per line, to upload with --clobber
#
# Safe to run again (a re-run of the job, as when a job it needs is re-run): a file whose name the
# release already lists must have the same SHA-256, and then its line stays as it is, so the result
# is SUMS unchanged. A different file under a name the release has is refused (exit 1), and
# nothing is written to OUT. scripts/linux-release-merge.sh does the same for publish-linux.
# Needs awk and sha256sum.
set -euo pipefail

die() { echo "release-add-files: $*" >&2; exit 1; }
[ $# -eq 3 ] || die "usage: release-add-files.sh SUMS DIR OUT"
sums=$1 dir=$2 out=$3
[ -f "$sums" ] || die "$sums isn't there"
[ -d "$dir" ] || die "$dir isn't a folder"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/release-add-files.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
(cd "$dir" && find . -maxdepth 1 -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do sha256sum -- "$f"; done) > "$tmp/new"
[ -s "$tmp/new" ] || die "$dir has no files"

clash=$(awk 'NR == FNR { have[$2] = $1; next } ($2 in have) && have[$2] != $1 { print $2 }' "$sums" "$tmp/new")
[ -z "$clash" ] || die "the release already has other files with these names: $(echo "$clash" | tr '\n' ' ')"

{
  cat "$sums"
  awk 'NR == FNR { have[$2] = 1; next } !($2 in have)' "$sums" "$tmp/new"
} > "$tmp/SHA256SUMS"
awk -v d="$dir" '{ print d "/" $2 }' "$tmp/new" > "$tmp/upload.txt"
mkdir -p "$out"
mv "$tmp/SHA256SUMS" "$tmp/upload.txt" "$out/"
