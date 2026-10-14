#!/usr/bin/env bash
# Tests the scripts the release workflow's jobs that add files to a release use:
# scripts/linux-release-merge.sh (publish-linux), scripts/release-add-files.sh (publish-ci) and
# scripts/release-put-sums.sh (both): the first run, a re-run with the same files (as when the
# Linux desktop build is re-run, which re-runs publish-linux and publish-ci after it), and the
# cases they must refuse. Then release.yml itself: with LINUX_DESKTOP off, skipping the Linux
# desktop jobs skips nothing else (publish-ci, sign-sums and the rest still run); with it on, the
# Linux app is refused while site/install's release key is TODO-owner, and only the Linux app; and
# the images the release builds from are pinned by digest, with no token in the container image's
# build.
# Needs jq, awk, sha256sum and python3.
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
echo "release-add-files.sh (publish-ci)"
add="$repo/scripts/release-add-files.sh"
mkdir -p "$work/ci"
printf 'engine' > "$work/ci/breakpatch_engine-1.2.3-py3-none-any.whl"
printf 'team' > "$work/ci/breakpatch_team_engine-1.2.3-cp311-manylinux.whl"
printf 'reqs' > "$work/ci/breakpatch-ci-requirements-linux-x86_64.txt"
code=0; bash "$add" "$work/out1/SHA256SUMS" "$work/ci" "$work/ci1" > "$work/log" 2>&1 || code=$?
expect "the first run works" "$code" 0
expect "SHA256SUMS: the release's lines as they were, then the new files'" "$(awk '{ print $2 }' "$work/ci1/SHA256SUMS" | tr '\n' ' ')" \
  "mac.tar.gz Breakpatch_amd64.AppImage breakpatch_1.2.3_amd64.deb latest.json breakpatch-ci-requirements-linux-x86_64.txt breakpatch_engine-1.2.3-py3-none-any.whl breakpatch_team_engine-1.2.3-cp311-manylinux.whl "
expect "upload.txt lists every new file" "$(wc -l < "$work/ci1/upload.txt" | tr -d ' ')" 3
# A re-run: the release has them already, with the same SHA-256.
code=0; bash "$add" "$work/ci1/SHA256SUMS" "$work/ci" "$work/ci2" > "$work/log" 2>&1 || code=$?
expect "a re-run with the same files works" "$code" 0
if cmp -s "$work/ci1/SHA256SUMS" "$work/ci2/SHA256SUMS"; then ok "and leaves SHA256SUMS as it was (no line twice)"; else bad "a re-run changed SHA256SUMS"; diff "$work/ci1/SHA256SUMS" "$work/ci2/SHA256SUMS" || true; fi
expect "and uploads them again (--clobber)" "$(wc -l < "$work/ci2/upload.txt" | tr -d ' ')" 3
# A re-run where one platform is new (it failed the first time and was re-run): only its line is added.
printf 'mac reqs' > "$work/ci/breakpatch-ci-requirements-macos-arm64.txt"
code=0; bash "$add" "$work/ci1/SHA256SUMS" "$work/ci" "$work/ci3" > "$work/log" 2>&1 || code=$?
expect "a re-run with one more file works" "$code" 0
expect "and adds only its line" "$(diff "$work/ci1/SHA256SUMS" "$work/ci3/SHA256SUMS" | grep -c '^>' || true)" 1
rm "$work/ci/breakpatch-ci-requirements-macos-arm64.txt"
# Another build under a name the release has: refused, nothing written.
printf 'another team build' > "$work/ci/breakpatch_team_engine-1.2.3-cp311-manylinux.whl"
code=0; bash "$add" "$work/ci1/SHA256SUMS" "$work/ci" "$work/ci4" > "$work/log" 2>&1 || code=$?
expect "a different file under a name the release has is refused" "$code" 1
if grep -q "other files with these names: breakpatch_team_engine-1.2.3-cp311-manylinux.whl" "$work/log" && [ ! -e "$work/ci4" ]; then ok "and says which, writing nothing"; else bad "no message, or it wrote"; fi
printf 'team' > "$work/ci/breakpatch_team_engine-1.2.3-cp311-manylinux.whl"

echo
echo "release-put-sums.sh (publish-linux, publish-ci)"
put="$repo/scripts/release-put-sums.sh"
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'GH'
#!/bin/sh
echo "gh $*" >> "$GH_LOG"
case "$*" in
  "release view"*) printf '%s\n' $FAKE_ASSETS ;;
  "release delete-asset"* | "release upload"*) ;;
  *) echo "gh: unexpected $*" >&2; exit 2 ;;
esac
GH
chmod +x "$work/bin/gh"
put_sums() {   # ASSETS OLD NEW [FILE…]: sets $code and $gh (gh's calls, one per line)
  local assets=$1; shift
  : > "$work/gh.log"
  code=0
  env PATH="$work/bin:$PATH" GH_LOG="$work/gh.log" FAKE_ASSETS="$assets" GITHUB_REF_NAME=v1.2.3 GITHUB_REPOSITORY=BreakPatch/breakpatch \
    bash "$put" "$@" > "$work/log" 2>&1 || code=$?
  gh=$(cat "$work/gh.log")
}
# A re-run of publish-ci after sign-sums: the same lines, so nothing is uploaded and SHA256SUMS.asc stays.
put_sums "SHA256SUMS SHA256SUMS.asc" "$work/ci1/SHA256SUMS" "$work/ci2/SHA256SUMS"
expect "unchanged: works" "$code" 0
expect "unchanged: gh isn't asked for anything" "$gh" ""
# The same lines in another order (publish-linux re-run after publish-ci): unchanged too.
mkdir -p "$work/reordered"
{ grep -v 'AppImage\|_amd64\.deb' "$work/ci1/SHA256SUMS"; grep 'AppImage\|_amd64\.deb' "$work/ci1/SHA256SUMS"; } > "$work/reordered/SHA256SUMS"
put_sums "SHA256SUMS SHA256SUMS.asc" "$work/ci1/SHA256SUMS" "$work/reordered/SHA256SUMS" "$work/out1/latest.json"
expect "the same lines in another order: nothing uploaded" "$gh" ""
# Changed, after sign-sums: the old signature goes before the new SHA256SUMS goes up.
put_sums "SHA256SUMS SHA256SUMS.asc latest.json" "$work/out1/SHA256SUMS" "$work/ci1/SHA256SUMS"
expect "changed: works" "$code" 0
expect "changed: SHA256SUMS.asc deleted, then SHA256SUMS uploaded" "$(printf '%s\n' "$gh" | sed 1d | tr '\n' ';')" \
  "gh release delete-asset v1.2.3 SHA256SUMS.asc --yes --repo BreakPatch/breakpatch;gh release upload v1.2.3 $work/ci1/SHA256SUMS --clobber --repo BreakPatch/breakpatch;"
# Changed, with latest.json, before sign-sums ever ran: nothing to delete; latest.json goes up first.
put_sums "SHA256SUMS latest.json" "$work/old/SHA256SUMS" "$work/out1/SHA256SUMS" "$work/out1/latest.json"
expect "first run: latest.json, then SHA256SUMS, nothing deleted" "$(printf '%s\n' "$gh" | sed 1d | tr '\n' ';')" \
  "gh release upload v1.2.3 $work/out1/latest.json --clobber --repo BreakPatch/breakpatch;gh release upload v1.2.3 $work/out1/SHA256SUMS --clobber --repo BreakPatch/breakpatch;"
cp "$work/ci1/SHA256SUMS" "$work/sums.txt"
put_sums "" "$work/out1/SHA256SUMS" "$work/sums.txt"
expect "a new file not named SHA256SUMS is refused" "$code" 1

echo
echo "release.yml: with LINUX_DESKTOP off, only the Linux desktop jobs are skipped"
wf="$repo/.github/workflows/release.yml"
code=0
python3 - "$wf" > "$work/log" 2>&1 <<'PY' || code=$?
import re, sys
jobs, cur = {}, None
for line in open(sys.argv[1]):
    m = re.match(r"^  ([a-z0-9-]+):\s*$", line)
    if m:
        cur = jobs.setdefault(m.group(1), {"needs": [], "if": ""})
        continue
    if cur is None or not line.startswith("    ") or line.startswith("     "):
        continue
    m = re.match(r"^    needs:\s*(.*)$", line)
    if m:
        cur["needs"] = [x.strip() for x in m.group(1).strip("[] \n").split(",") if x.strip()]
    m = re.match(r"^    if:\s*(.*)$", line)
    if m:
        cur["if"] = m.group(1).strip()
gated = {j for j, d in jobs.items() if "vars.LINUX_DESKTOP == 'on'" in d["if"]}
assert gated == {"linux-release-key", "app-linux-x64", "publish-linux"}, f"jobs gated by LINUX_DESKTOP: {sorted(gated)}"
# A job is skipped when its `if` needs LINUX_DESKTOP, or when a job it needs is skipped (or
# failed) and its `if` has no status function (always(), !cancelled(), failure()) or wants that
# job's success.
def not_run(start):
    out, changed = set(start), True
    while changed:
        changed = False
        for j, d in jobs.items():
            if j in out:
                continue
            cond = d["if"]
            status = any(f in cond for f in ("always()", "cancelled()", "failure()"))
            wants = any(f"needs.{n}.result == 'success'" in cond for n in d["needs"] if n in out)
            if any(n in out for n in d["needs"]) and (not status or wants):
                out.add(j); changed = True
    return out
skipped = not_run(gated)
# With LINUX_DESKTOP on and the release key still TODO-owner, linux-release-key fails: only the
# Linux app isn't built. publish-linux still runs (it warns), and so does everything else.
assert "linux-release-key" in jobs["app-linux-x64"]["needs"], "app-linux-x64 doesn't wait for linux-release-key"
refused = not_run({"linux-release-key"})
assert refused == {"linux-release-key", "app-linux-x64"}, f"a missing release key also stops: {sorted(refused - {'linux-release-key', 'app-linux-x64'})}"
for j, d in jobs.items():
    if j not in ("app-linux-x64",):
        assert "linux-release-key" not in d["needs"], f"{j} waits on linux-release-key"
tag_jobs = {j for j, d in jobs.items() if "workflow_dispatch" not in d["if"]}
must_run = {"build", "publish", "sign-sums", "ci-linux", "ci-macos", "ci-linux-arm64", "ci-windows-x64",
            "publish-ci", "smoke-ci-linux", "ci-image-build", "ci-image"}
assert must_run <= set(jobs), f"missing jobs: {sorted(must_run - set(jobs))}"
assert skipped == gated, f"also skipped with LINUX_DESKTOP off: {sorted(skipped - gated)}"
assert tag_jobs - skipped >= must_run
# Nothing the Mac app or breakpatch-ci is published by waits on the container image, whose
# checks (a pinned CI_IMAGE_BASE) can fail it.
for j in ("publish", "publish-ci", "sign-sums", "smoke-ci-linux"):
    seen, todo = set(), [j]
    while todo:
        n = todo.pop()
        for m in jobs[n]["needs"]:
            if m not in seen:
                seen.add(m); todo.append(m)
    assert not seen & {"ci-image-build", "ci-image"}, f"{j} waits on the container image"
print("skipped:", sorted(skipped))
PY
expect "the workflow's needs and ifs" "$code" 0
[ "$code" -eq 0 ] || cat "$work/log"
if grep -q "^skipped: \['app-linux-x64', 'linux-release-key', 'publish-linux'\]$" "$work/log"; then ok "publish-ci, sign-sums and the rest run on a Mac-only release"; else bad "$(cat "$work/log")"; fi
step=$(awk '/^  publish-ci:/ { j = 1 } j && /^  [a-z]/ && !/^  publish-ci:/ { exit } j' "$wf")
# shellcheck disable=SC2016  # the literal ${files[@]} in the workflow
if grep -q 'release-add-files.sh' <<< "$step" && grep -q 'release-put-sums.sh' <<< "$step" && grep -q -- '"${files\[@\]}" --clobber' <<< "$step"; then
  ok "publish-ci adds its files with release-add-files.sh and uploads with --clobber"
else bad "publish-ci doesn't use release-add-files.sh, release-put-sums.sh and --clobber"; fi
if [ "$(grep -cE 'gh release upload .*SHA256SUMS([^.]|$)' "$wf")" -eq 0 ]; then
  ok "SHA256SUMS is only ever uploaded by release-put-sums.sh"
else bad "release.yml uploads SHA256SUMS itself: $(grep -nE 'gh release upload .*SHA256SUMS[^.]' "$wf")"; fi


echo
echo "release.yml and docker/ci/Dockerfile: images pinned, no token in the image build"
df="$repo/docker/ci/Dockerfile"
if head -n 1 "$df" | grep -Eq '^# syntax=docker/dockerfile:[0-9.]+@sha256:[0-9a-f]{64}$'; then ok "the Dockerfile frontend is pinned by digest"; else bad "the Dockerfile's syntax line isn't pinned: $(head -n 1 "$df")"; fi
if ! grep -q 'type=secret\|GITHUB_TOKEN' "$df"; then ok "no secret or token in the Dockerfile"; else bad "the Dockerfile mounts a secret or reads a token"; fi
job_of() { awk -v j="  $1:" '$0 == j { on = 1; print; next } on && /^  [a-z]/ { exit } on' "$wf"; }
img=$(job_of ci-image-build)
if ! grep -q -- '--secret\|github-token' <<< "$img"; then ok "ci-image-build gives the build no token"; else bad "ci-image-build passes a secret to the build"; fi
# Its default, when the variable is unset, must itself be pinned by digest: never a moving tag.
defaults=$(grep -oE "CI_IMAGE_BASE \|\| '[^']*'" <<< "$img" || true)
if grep -q 'CI_IMAGE_BASE must name the base image by digest' <<< "$img" &&
   { [ -z "$defaults" ] || ! grep -vqE "'[^'@]+@sha256:[0-9a-f]{64}'" <<< "$defaults"; }; then
  ok "ci-image-build needs a base pinned by digest, and its default is one"
else bad "ci-image-build doesn't require CI_IMAGE_BASE pinned, or defaults to a moving tag"; fi
app=$(job_of app-linux-x64)
first=$(grep -m 1 -- '- name:' <<< "$app" | sed 's/.*- name: //')
if [ "$first" = "Container pinned" ] && grep -q 'UBUNTU_2204_IMAGE must name' <<< "$app"; then ok "app-linux-x64 first checks UBUNTU_2204_IMAGE is pinned"; else bad "app-linux-x64's first step is '$first'"; fi

echo
echo "release.yml: the Linux desktop app needs site/install's release key (linux-release-key)"
# The job's "Release key pinned" script, with bash -e (as Actions runs it), against the tagged
# site/install as it is and against copies with a key pinned, half pinned or mistyped.
gate=$(job_of linux-release-key)
awk '/- name: Release key pinned/ { s = 1; next }
     s && /^        run: \|/ { on = 1; next }
     on && /^          / { print substr($0, 11); next }
     on && /^ *$/ { print ""; next }
     on { exit }' <<< "$gate" > "$work/gate.sh"
if grep -q 'GPG_FINGERPRINT' "$work/gate.sh"; then ok "found linux-release-key's script"; else bad "couldn't read linux-release-key's \"Release key pinned\" step"; fi
if grep -q "vars.LINUX_DESKTOP == 'on'" <<< "$(grep -m 1 '^    if:' <<< "$gate")" && ! grep -q '^    needs:' <<< "$gate" &&
   ! grep -q '^    environment:' <<< "$gate"; then
  ok "linux-release-key runs only with LINUX_DESKTOP on, first, and without the release environment"
else bad "linux-release-key's if, needs or environment: $(grep -E '^    (if|needs|environment):' <<< "$gate" | tr '\n' ' ')"; fi
gate_run() {   # INSTALL: sets $code and $out
  code=0
  out=$(env INSTALL="$1" bash -e "$work/gate.sh" 2>&1) || code=$?
}
fpr=0123456789ABCDEF0123456789ABCDEF01234567
pinned() {   # FINGERPRINT KEY-LINE > a copy of site/install with them
  python3 - "$repo/site/install" "$1" "$2" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
s, n1 = re.subn(r"(?m)^GPG_FINGERPRINT=.*$", lambda m: "GPG_FINGERPRINT=" + sys.argv[2], s)
s, n2 = re.subn(r"(?m)^GPG_PUBLIC_KEY=''$", lambda m: "GPG_PUBLIC_KEY=" + sys.argv[3], s)
assert n1 == n2 == 1, (n1, n2)
sys.stdout.write(s)
PY
}
key="'-----BEGIN PGP PUBLIC KEY BLOCK-----
mQENBGZ0ZXN0
-----END PGP PUBLIC KEY BLOCK-----'"
if grep -qx 'GPG_FINGERPRINT=TODO-owner' "$repo/site/install"; then
  gate_run "$repo/site/install"
  expect "site/install as it is (TODO-owner): refused" "$code" 1
  if grep -q '^::error::LINUX_DESKTOP is on, but .*GPG_FINGERPRINT=TODO-owner.*owner step in site/install (the TODO(owner) above GPG_FINGERPRINT).*GPG_SIGNING_KEY.*Or turn LINUX_DESKTOP off' <<< "$out"; then
    ok "and says why, naming the owner step"
  else bad "the error doesn't name the owner step: $out"; fi
else
  ok "site/install pins a release key already (the TODO-owner case is below)"
fi
pinned TODO-owner "''" > "$work/install-todo"
gate_run "$work/install-todo"
expect "TODO-owner: refused" "$code" 1
pinned "$fpr" "$key" > "$work/install-pinned"
gate_run "$work/install-pinned"
expect "a fingerprint and its public key: built" "$code" 0
if grep -q "pins the release key $fpr" <<< "$out"; then ok "and says which key"; else bad "$out"; fi
pinned "$fpr" "''" > "$work/install-nokey"
gate_run "$work/install-nokey"
expect "a fingerprint without its public key: refused" "$code" 1
pinned "${fpr,,}" "$key" > "$work/install-lower"
gate_run "$work/install-lower"
expect "a fingerprint in lower case: refused" "$code" 1
if grep -q "^::error::GPG_FINGERPRINT in this tag's site/install isn't a fingerprint" <<< "$out"; then ok "and says so"; else bad "$out"; fi

echo
if [ ${#failures[@]} -eq 0 ]; then echo "test-release-merge: all $pass checks passed"; exit 0; fi
echo "test-release-merge: ${#failures[@]} failed"; printf '  %s\n' "${failures[@]}"; exit 1
