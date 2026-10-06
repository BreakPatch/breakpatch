#!/usr/bin/env bash
# breakpatch-ci for this runner, for the Breakpatch GitHub Action (action.yml). Two phases:
#
#   install.sh download   finds the release (BP_VERSION: latest or 1.2.3), downloads its
#                         SHA256SUMS, breakpatch-ci-requirements-<platform>.txt and the two wheels
#                         that file names, and checks each against SHA256SUMS. Writes the outputs
#                         version, platform and key (the requirements file's SHA-256, for the
#                         browser cache).
#   install.sh install    makes a Python 3.11 environment (BP_PYTHON, from actions/setup-python)
#                         and installs from that file with pip --require-hashes --only-binary=:all:.
#
# The same checks as https://breakpatch.dev/install-ci (site/install-ci): https only, files only
# from the release, exactly the two wheels and no package addresses. It doesn't run install-ci
# itself: that isn't a release file (so the action couldn't check it against SHA256SUMS), and it
# installs its own Python and Chromium where the action uses setup-python and its cache. Instead
# action/test.sh runs both against the same fake releases and fails when they disagree: change
# one, change the other. GH_TOKEN (the job's token) is sent to
# api.github.com only; curl doesn't send it on to the asset host a download redirects to.
# Environment: BP_DIR (where it all goes), BP_VERSION, BP_REPO (default BreakPatch/breakpatch),
# GH_TOKEN, BP_PYTHON, RUNNER_OS, RUNNER_ARCH, GITHUB_OUTPUT.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
repo=${BP_REPO:-BreakPatch/breakpatch}
api=${BP_API:-https://api.github.com/repos/$repo}   # BP_API: for tests only
dir=${BP_DIR:?BP_DIR is the folder to install into}
files="$dir/files"

platform() {
  case "${RUNNER_OS:-}-${RUNNER_ARCH:-}" in
    Linux-X64) echo linux-x86_64 ;;
    Linux-ARM64) echo linux-arm64 ;;
    macOS-ARM64) echo macos-arm64 ;;
    Windows-X64) echo windows-x86_64 ;;
    *) fail "breakpatch-ci runs on Linux (x64, arm64), macOS on Apple Silicon and Windows x64, not ${RUNNER_OS:-?} ${RUNNER_ARCH:-?}." ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print tolower($1) }'
}

# The token's header goes in a file only this user can read, so it's never in curl's arguments.
auth=()
case "$api" in https://api.github.com/*) ;; *) GH_TOKEN="" ;; esac   # the token goes to GitHub only
if [ -n "${GH_TOKEN:-}" ]; then
  header="${RUNNER_TEMP:-$dir}/breakpatch-auth-$$"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$GH_TOKEN" > "$header")
  trap 'rm -f "$header"' EXIT
  auth=(-H "@$header")
fi
unset GH_TOKEN

# api_get PATH FILE: the JSON at the API path, with the token.
api_get() {
  curl -fsSL --proto =https --proto-redir =https --retry 3 -H 'Accept: application/vnd.github+json' \
    ${auth[@]+"${auth[@]}"} -o "$2" "$api/$1"
}

# fetch NAME: release file NAME into $files, by its asset address on api.github.com.
fetch() {
  local id
  id=$("$py" -c 'import json, sys
r = json.load(open(sys.argv[1]))
print(next((str(a["id"]) for a in r.get("assets", []) if a.get("name") == sys.argv[2]), ""))' "$dir/release.json" "$1")
  [ -n "$id" ] || fail "Breakpatch $version has no $1 (breakpatch-ci for $plat may not be in this release)."
  curl -fsSL --proto =https --proto-redir =https --retry 3 -H 'Accept: application/octet-stream' \
    ${auth[@]+"${auth[@]}"} -o "$files/$1" "$api/releases/assets/$id" || fail "Couldn't download $1."
}

check_sum() {
  local want
  want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$files/SHA256SUMS")
  [ -n "$want" ] || fail "Breakpatch $version has no checksum for $1, so nothing was installed."
  [ "$(sha256_of "$files/$1")" = "$want" ] || fail "The download of $1 doesn't match its checksum, so nothing was installed."
}

download() {
  py=${BP_PYTHON:-python3}
  plat=$(platform)
  mkdir -p "$files"
  case "${BP_VERSION:-latest}" in
    latest | '') api_get releases/latest "$dir/release.json" || fail "Couldn't find the latest Breakpatch release." ;;
    *)
      want=${BP_VERSION#v}
      case "$want" in [0-9]*) ;; *) fail "version is latest or a version like 1.2.3, not $BP_VERSION." ;; esac
      case "$want" in *[!0-9A-Za-z.-]*) fail "version is latest or a version like 1.2.3, not $BP_VERSION." ;; esac
      api_get "releases/tags/v$want" "$dir/release.json" || fail "There's no Breakpatch $want." ;;
  esac
  tag=$("$py" -c 'import json, sys; print(json.load(open(sys.argv[1])).get("tag_name", ""))' "$dir/release.json")
  case "$tag" in v[0-9]*) ;; *) fail "Couldn't read the release from GitHub." ;; esac
  case "$tag" in *[!0-9A-Za-z.v-]*) fail "Couldn't read the release from GitHub." ;; esac
  version=${tag#v}
  reqs="breakpatch-ci-requirements-$plat.txt"
  fetch SHA256SUMS
  fetch "$reqs"
  check_sum "$reqs"
  # Exactly two wheels by name and hash; every other line is a package on PyPI, never an address.
  # Comment lines don't count.
  sed -n 's#^\./\([A-Za-z0-9][A-Za-z0-9._-]*\.whl\) --hash=sha256:[0-9a-f]\{64\}$#\1#p' "$files/$reqs" > "$dir/wheels.txt"
  local_lines=$(grep -c '^[^#A-Za-z0-9 ]' "$files/$reqs" || true)
  if ! grep -q '^breakpatch_engine-' "$dir/wheels.txt" || ! grep -q '^breakpatch_team_engine-' "$dir/wheels.txt" \
    || [ "$(wc -l < "$dir/wheels.txt" | tr -d ' ')" -ne 2 ] || [ "$local_lines" -ne 2 ] \
    || grep -v '^[[:space:]]*#' "$files/$reqs" | grep -q '://\|@ '; then
    fail "Breakpatch $version's breakpatch-ci files can't be read, so nothing was installed."
  fi
  while IFS= read -r wheel; do
    fetch "$wheel"
    check_sum "$wheel"
  done < "$dir/wheels.txt"
  echo "breakpatch-ci $version for $plat: downloaded and checked against SHA256SUMS."
  {
    echo "version=$version"
    echo "platform=$plat"
    echo "requirements=$reqs"
    echo "key=$(sha256_of "$files/$reqs")"
  } >> "$GITHUB_OUTPUT"
}

install() {
  py=${BP_PYTHON:-python3}
  reqs=${BP_REQUIREMENTS:?}
  [ "$("$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" = 3.11 ] || fail "breakpatch-ci needs Python 3.11, and $py isn't."
  rm -rf "$dir/venv"
  "$py" -m venv "$dir/venv"
  if [ -x "$dir/venv/Scripts/python.exe" ]; then vpy="$dir/venv/Scripts/python.exe"; bindir="$dir/venv/Scripts"; else vpy="$dir/venv/bin/python"; bindir="$dir/venv/bin"; fi
  (cd "$files" && PIP_DISABLE_PIP_VERSION_CHECK=1 "$vpy" -m pip install -q --require-hashes --only-binary=:all: -r "$reqs") \
    || fail "Couldn't install breakpatch-ci's Python packages."
  "$bindir/breakpatch-ci" --version
  {
    echo "python=$vpy"
    echo "bin=$bindir"
  } >> "$GITHUB_OUTPUT"
}

case "${1:-}" in
  download) download ;;
  install) install ;;
  *) fail "install.sh download|install" ;;
esac
