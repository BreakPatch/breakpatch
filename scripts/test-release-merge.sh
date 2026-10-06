#!/usr/bin/env bash
# Tests scripts/linux-release-merge.sh (the release workflow's publish-linux job): the first run,
# a re-run with the same files, and the cases it must refuse. Needs jq, awk and sha256sum.
#
#   bash scripts/test-release-merge.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
merge="$repo/scripts/linux-release-merge.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-test-merge.XXXXXX")
trap 'rm -rf "$work"' EXIT
pass=0 failures=()
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { failures+=("$1"); echo "  FAIL  $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', expected '$3'"; fi; }

# The release as publish made it (macOS), and what the Linux build made.
mkdir -p "$work/old" "$work/linux"
echo '{"version": "1.2.3", "platforms": {"darwin-aarch64": {"signature": "m", "url": "https://x/mac.tar.gz"}}}' > "$work/old/latest.json"
printf 'mac' > "$work/mac.tar.gz"
(cd "$work" && sha256sum mac.tar.gz; cd old && sha256sum latest.json) > "$work/old/SHA256SUMS"
printf 'appimage' > "$work/linux/Breakpatch_amd64.AppImage"
printf 'deb' > "$work/linux/breakpatch_1.2.3_amd64.deb"
(cd "$work/linux" && sha256sum Breakpatch_amd64.AppImage breakpatch_1.2.3_amd64.deb) > "$work/linux/SHA256SUMS"
echo '{"linux-x86_64": {"signature": "a", "url": "https://x/Breakpatch_amd64.AppImage"}, "linux-x86_64-deb": {"signature": "d", "url": "https://x/breakpatch_1.2.3_amd64.deb"}}' > "$work/linux/latest-linux.json"

echo "linux-release-merge.sh"
code=0; bash "$merge" "$work/old" "$work/linux" "$work/out1" > "$work/log" 2>&1 || code=$?
expect "the first run works" "$code" 0
expect "latest.json has every platform" "$(jq -c '.platforms | keys' "$work/out1/latest.json")" '["darwin-aarch64","linux-x86_64","linux-x86_64-deb"]'
expect "SHA256SUMS: the Mac file, the Linux files, the new latest.json" "$(awk '{ print $2 }' "$work/out1/SHA256SUMS" | tr '\n' ' ')" "mac.tar.gz Breakpatch_amd64.AppImage breakpatch_1.2.3_amd64.deb latest.json "
expect "latest.json's line is the new one's" "$(awk '$2 == "latest.json" { print $1 }' "$work/out1/SHA256SUMS")" "$(sha256sum "$work/out1/latest.json" | cut -d' ' -f1)"
expect "upload.txt lists the Linux files" "$(wc -l < "$work/out1/upload.txt" | tr -d ' ')" 2

# A re-run: the release now has what the first run uploaded.
mkdir -p "$work/old2"
cp "$work/out1/latest.json" "$work/out1/SHA256SUMS" "$work/old2/"
code=0; bash "$merge" "$work/old2" "$work/linux" "$work/out2" > "$work/log" 2>&1 || code=$?
expect "a re-run with the same files works" "$code" 0
if cmp -s "$work/out1/SHA256SUMS" "$work/out2/SHA256SUMS" && cmp -s "$work/out1/latest.json" "$work/out2/latest.json"; then
  ok "and gives the same latest.json and SHA256SUMS (no line twice)"
else bad "a re-run changed the result"; diff "$work/out1/SHA256SUMS" "$work/out2/SHA256SUMS" || true; fi

# Another build of the same names: refused.
cp -r "$work/linux" "$work/linux3"
printf 'other appimage' > "$work/linux3/Breakpatch_amd64.AppImage"
(cd "$work/linux3" && sha256sum Breakpatch_amd64.AppImage breakpatch_1.2.3_amd64.deb) > "$work/linux3/SHA256SUMS"
code=0; bash "$merge" "$work/old2" "$work/linux3" "$work/out3" > "$work/log" 2>&1 || code=$?
expect "a different file under a name the release has is refused" "$code" 1
if grep -q "other files with these names: Breakpatch_amd64.AppImage" "$work/log" && [ ! -e "$work/out3" ]; then ok "and says which, writing nothing"; else bad "no message, or it wrote"; fi

# latest.json with a different entry for a Linux platform: refused.
jq '.platforms["linux-x86_64"].signature = "other"' "$work/out1/latest.json" > "$work/old2/latest.json"
code=0; bash "$merge" "$work/old2" "$work/linux" "$work/out4" > "$work/log" 2>&1 || code=$?
expect "a different Linux entry in latest.json is refused" "$code" 1

echo
if [ ${#failures[@]} -eq 0 ]; then echo "test-release-merge: all $pass checks passed"; exit 0; fi
echo "test-release-merge: ${#failures[@]} failed"; printf '  %s\n' "${failures[@]}"; exit 1
