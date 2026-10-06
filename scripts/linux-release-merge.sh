#!/usr/bin/env bash
# Merges the Linux desktop files into a release's latest.json and SHA256SUMS, for the release
# workflow's publish-linux job (.github/workflows/release.yml):
#
#   scripts/linux-release-merge.sh OLD LINUX OUT
#
#   OLD    the release's SHA256SUMS and latest.json, as they are now (gh release download)
#   LINUX  what scripts/linux-release-files.sh wrote: the files, their SHA256SUMS and
#          latest-linux.json (the updater's Linux platforms)
#   OUT    gets latest.json (OLD's with the Linux platforms added) and SHA256SUMS (OLD's lines,
#          LINUX's, and the new latest.json's), and upload.txt: the LINUX files to upload, one per line
#
# Safe to run again (a re-run of the job): a file the release already has must have the same
# SHA-256, and a Linux platform already in latest.json must be the same entry; then the result is
# the same as the first time. Anything else is refused (exit 1), and nothing is written to OUT.
# Needs jq, awk and sha256sum.
set -euo pipefail

die() { echo "linux-release-merge: $*" >&2; exit 1; }
[ $# -eq 3 ] || die "usage: linux-release-merge.sh OLD LINUX OUT"
old=$1 linux=$2 out=$3
for f in "$old/SHA256SUMS" "$old/latest.json" "$linux/SHA256SUMS" "$linux/latest-linux.json"; do
  [ -f "$f" ] || die "$f isn't there"
done

clash=$(awk 'NR == FNR { have[$2] = $1; next } ($2 in have) && have[$2] != $1 { print $2 }' "$old/SHA256SUMS" "$linux/SHA256SUMS")
[ -z "$clash" ] || die "the release already has other files with these names: $(echo "$clash" | tr '\n' ' ')"

jq -e --slurpfile l "$linux/latest-linux.json" \
  '.platforms as $have | [$l[0] | to_entries[] | select($have[.key] != null and $have[.key] != .value)] == []' \
  "$old/latest.json" >/dev/null || die "latest.json already has a different entry for a Linux platform"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/linux-release-merge.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
jq --slurpfile l "$linux/latest-linux.json" '.platforms += $l[0]' "$old/latest.json" > "$tmp/latest.json"
{
  grep -v '  latest\.json$' "$old/SHA256SUMS" | awk 'NR == FNR { mine[$2] = 1; next } !($2 in mine)' "$linux/SHA256SUMS" - || true
  cat "$linux/SHA256SUMS"
  (cd "$tmp" && sha256sum latest.json)
} > "$tmp/SHA256SUMS"
awk -v d="$linux" '{ print d "/" $2 }' "$linux/SHA256SUMS" > "$tmp/upload.txt"
mkdir -p "$out"
mv "$tmp/latest.json" "$tmp/SHA256SUMS" "$tmp/upload.txt" "$out/"
