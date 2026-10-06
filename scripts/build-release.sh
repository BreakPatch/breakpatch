#!/usr/bin/env bash
# Builds Breakpatch, Community or Team edition, the way releases are built (docs/editions.md).
# The release workflow (.github/workflows/release.yml) runs this script; so can you.
#
#   scripts/build-release.sh                                  # Community, this machine's bundle
#   scripts/build-release.sh --edition team                   # Team: needs the Team checkout
#   TEAM_DIR=/path/to/breakpatch-team scripts/build-release.sh --edition team
#   scripts/build-release.sh --no-bundle                      # just the app binary
#   scripts/build-release.sh --bundles deb                    # a Linux package
#   scripts/build-release.sh --edition team --release --target aarch64-apple-darwin
#
# Two phases, so that no third-party install code runs next to the signing keys (security
# review S2). Without either flag the script runs both, one after the other.
#   --deps-only   installs everything and stops: the build venv from the hashed lock in
#                 engine/locks/ (`pip install --require-hashes`; scripts/lock-python.sh writes
#                 them), Nuitka's downloads for Team hardening, `npm ci --ignore-scripts` and
#                 `cargo fetch --locked`. It refuses to run with any signing variable set.
#   --no-deps     builds with what --deps-only installed and downloads nothing (the Team engine
#                 is installed from its local copy, cargo runs offline). The release workflow
#                 passes the signing secrets to this phase only.
#   --release     a build to publish: the real licence keys only, and the signing variables
#                 below are required.
#   --no-test-key Team: the real licence keys only, like --release, but unsigned is fine. For
#                 test builds other people may download (the release workflow's manual runs).
#
# Steps:
#   1. Team only: link the Team module (scripts/link-team.sh; TEAM_DIR or ../breakpatch-team)
#      and install the Team engine into the build venv. Community: make sure neither is there.
#   2. The engine sidecar (engine/scripts/build_sidecar.sh), checked: a real build that reports
#      the edition asked for in `system.info`.
#   3. The frontend (tsc, vite), checked for the edition's code, then `npx tauri build`.
#      Team builds compile in the licence public keys (BREAKPATCH_LICENCE_PUBKEYS, read by
#      app/src-tauri/src/licence.rs) from the Team checkout's backoffice/keys/: the real key
#      table public-keys.json, plus the test key (public-keys.test.json) unless --release. A
#      --release build has the real keys and never the test key; Community builds have none.
#      The built binary is checked for exactly those keys. The Team engine gets the same table
#      (its engine/scripts/embed_keys.py writes breakpatch_team_engine/_keys.py into the copy that
#      is installed), so the sidecar and breakpatch-ci check licence tokens with the same keys;
#      the installed package is checked for exactly those keys too.
#   4. Always, even when a step fails: unlink the Team module, take the Team engine out of the
#      venv and, after a Team build, the Team sidecar out of app/src-tauri/binaries (the one that
#      was there before is put back). The checkout is left as Community.
#
# Signing is driven by the environment (an empty variable counts as absent). On macOS the app
# and the engine sidecar are code signed with the first of these that is set:
#   1. Apple Developer ID: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
#      notarised when APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID are set too. Hardened runtime on.
#   2. Breakpatch's own certificate: BP_CODESIGN_P12 (base64 .p12), BP_CODESIGN_P12_PASSWORD,
#      made once by scripts/make-signing-cert.sh. It's imported into a temporary keychain
#      (deleted at the end), and must be the certificate committed in app/src-tauri/signing/
#      (fingerprint.txt): the same certificate keeps the app's designated requirement, so
#      Keychain items stay readable after updates. Not notarised; hardened runtime on. The
#      keychain is made only after the sidecar and the frontend are built, just before signing.
#   3. Otherwise ad-hoc (`codesign -s -`), with a warning: fine to try, not to publish, because
#      every build then has a new identity and the Keychain asks again after each update.
#      Hardened runtime on too, so test builds behave like releases.
# Every signed .app is checked (codesign --verify --deep --strict, hardened runtime flag), its
# designated requirement printed, and the update archive and .dmg checked to hold that same
# signed app. The signing variables are taken out of the environment at the start and handed
# only to the commands that sign (openssl/security for the .p12, `tauri build`), so the sidecar
# and frontend builds (PyInstaller, Nuitka, tsc, vite) never see them.
# Elsewhere than macOS nothing is code signed.
#   TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD           updater archive + .sig
# Without TAURI_SIGNING_PRIVATE_KEY the update archive isn't made (createUpdaterArtifacts is
# turned off for this build only). --release (CI uses it) needs the updater key and, on macOS,
# the Developer ID (all six APPLE_ variables) or the Breakpatch certificate.
#
# Other environment:
#   VENV           the build venv (default engine/.venv; created when missing)
#   PYTHON         Python used to create it (default python3.11, else python3)
#   ENGINE_EXTRAS  extras installed with the engine (default "dev"; on Apple Silicon "dev,mlx"
#                  bundles the AI assistant). Team builds add "hardening" (Nuitka). They're
#                  installed from engine/locks/<platform>.<extras sorted, "-"-joined>.txt; with
#                  no lock for them a developer build installs unlocked, with a warning, and a
#                  --release or CI build fails.
#   BREAKPATCH_LICENCE_URL  Team: the licence service address built in (default in licence.rs,
#                  https://account.breakpatch.dev/api); --release allows only https addresses
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
app="$repo/app"
engine="$repo/engine"

edition=community
bundle_args=()
bundle_set=0
target=""
release=0
no_test_key=0
phase=all            # all, deps (--deps-only) or build (--no-deps)

usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "build-release: $*" >&2; exit 1; }
say() { echo "build-release: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --edition) [ $# -ge 2 ] || die "--edition needs community or team"; edition=$2; shift 2 ;;
    --edition=*) edition=${1#*=}; shift ;;
    --no-bundle) bundle_args=(--no-bundle); bundle_set=1; shift ;;
    --bundles) [ $# -ge 2 ] || die "--bundles needs a list, e.g. deb or app,dmg"; bundle_args=(--bundles "$2"); bundle_set=1; shift 2 ;;
    --target) [ $# -ge 2 ] || die "--target needs a triple"; target=$2; shift 2 ;;
    --release) release=1; shift ;;
    --no-test-key) no_test_key=1; shift ;;
    --deps-only) [ "$phase" = all ] || die "--deps-only and --no-deps are the two halves: pass one"; phase=deps; shift ;;
    --no-deps) [ "$phase" = all ] || die "--deps-only and --no-deps are the two halves: pass one"; phase=build; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$edition" in community|team) ;; *) die "--edition must be community or team, not '$edition'" ;; esac

host=$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')
[ -n "$host" ] || die "rustc not found; install Rust from https://rustup.rs"
if [ -n "$target" ] && [ "$target" != "$host" ]; then
  die "the engine sidecar is built for this machine ($host), so --target must be $host, not $target"
fi
triple=${target:-$host}
sidecar="$app/src-tauri/binaries/breakpatch-engine-$triple"

VENV=${VENV:-"$engine/.venv"}
# shellcheck source=scripts/platform.sh
. "$repo/scripts/platform.sh"
py=$(venv_python "$VENV")

work=$(mktemp -d "${TMPDIR:-/tmp}/bp-release.XXXXXX")
saved_sidecar=""
team_sidecar=0      # 1 once this run started writing a Team sidecar

# ---------------------------------------------------------------- back to Community, always

team_engine_installed() { [ -x "$py" ] && "$py" -c "import breakpatch_team_engine" 2>/dev/null; }

to_community() {
  sh "$repo/scripts/unlink-team.sh" || true
  if team_engine_installed; then
    "$py" -m pip uninstall -y -q breakpatch-team-engine || true
    team_engine_installed && echo "build-release: couldn't take breakpatch-team-engine out of $VENV" >&2
    say "removed the Team engine from $VENV"
  fi
}

# macOS code signing state, undone by signing_cleanup (see "macOS code signing" below).
codesign_kc=""        # the temporary keychain holding BP_CODESIGN_P12, once this run made it
saved_keychains=()    # the user's keychain search list before that, put back at the end
dmg_mount=""          # where the .dmg is attached while it's checked

signing_cleanup() {
  if [ -n "$dmg_mount" ]; then hdiutil detach -quiet "$dmg_mount" || hdiutil detach -quiet -force "$dmg_mount"; fi
  if [ -n "$codesign_kc" ]; then
    security list-keychains -d user -s ${saved_keychains[@]+"${saved_keychains[@]}"}
    security delete-keychain "$codesign_kc" && say "deleted the temporary signing keychain"
  fi
}

cleanup() {
  local code=$?
  set +e
  echo "build-release: cleaning up (back to Community)"
  signing_cleanup
  to_community
  if [ "$team_sidecar" -eq 1 ]; then
    # Never leave a Team sidecar where a later plain `tauri build` would bundle it.
    rm -f "$sidecar"
    if [ -n "$saved_sidecar" ]; then mv "$saved_sidecar" "$sidecar"; say "put back the previous $(basename "$sidecar")"; fi
  fi
  rm -rf "$work"
  if [ "$code" -eq 0 ]; then say "done ($edition)"; else echo "build-release: FAILED ($edition, exit $code)" >&2; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- dependencies

# Team builds compile breakpatch_team_engine to native code before packaging (release hardening,
# src-tauri/README.md "Hardening"), which needs Nuitka: the "hardening" extra. SIDECAR_COMPILER=nuitka
# (the whole-sidecar compile) needs it too.
needs_nuitka() { [ "$edition" = team ] || [ "${SIDECAR_COMPILER:-}" = nuitka ]; }

# The extras to install, sorted and without repeats: ENGINE_EXTRAS, plus hardening when needed.
engine_extras() {
  { printf '%s\n' "${ENGINE_EXTRAS:-dev}" | tr ',' '\n'; if needs_nuitka; then echo hardening; fi; } \
    | tr -d ' ' | grep -v '^$' | sort -u | paste -sd, -
}

# The platform's name in engine/locks/ (scripts/platform.sh: linux-x86_64, linux-arm64,
# macos-arm64, windows-x86_64).
lock_platform() {
  bp_platform "$(uname -s)" "$(uname -m)" || echo "$(uname -s)-$(uname -m)"
}

# The engine and its dependencies, from the hashed lock (security review S3): build tools first,
# then the lock without build isolation (so pip never fetches unhashed setuptools to build a
# source release such as Nuitka), then the engine itself without dependencies. `pip check` fails
# if the lock is missing something engine/pyproject.toml asks for.
install_engine() {
  local extras lock
  extras=$(engine_extras)
  lock="$engine/locks/$(lock_platform).${extras//,/-}.txt"
  "$py" -m pip install -q --require-hashes -r "$engine/locks/build.txt" \
    || die "couldn't install engine/locks/build.txt with --require-hashes"
  if [ -f "$lock" ]; then
    say "installing the engine [$extras] into $VENV from ${lock#"$repo"/} (hashes checked)"
    "$py" -m pip install -q --require-hashes --no-build-isolation -r "$lock" \
      || die "couldn't install ${lock#"$repo"/} with --require-hashes. If engine/pyproject.toml changed, run scripts/lock-python.sh and commit engine/locks/"
    "$py" -m pip install -q --no-deps --no-build-isolation -e "$engine"
    "$py" -m pip check >"$work/pip-check.log" 2>&1 \
      || die "the lock doesn't satisfy engine/pyproject.toml ($(tr '\n' ' ' < "$work/pip-check.log")). Run scripts/lock-python.sh and commit engine/locks/"
  else
    if [ "$release" -eq 1 ] || [ -n "${CI:-}" ]; then
      die "no hashed lock for [$extras] on $(lock_platform): ${lock#"$repo"/}. Add it to scripts/lock-python.sh and run it"
    fi
    echo "build-release: WARNING: no hashed lock for [$extras] on this platform (${lock#"$repo"/})." >&2
    echo "build-release: WARNING: installing the newest allowed versions unchecked: fine to try, not to publish." >&2
    "$py" -m pip install -q -e "${engine}[${extras}]"
  fi
}

# Nuitka asks before downloading helpers it needs; build_sidecar.sh doesn't let it, so they're
# fetched here, before any signing variable is around, by compiling a one-line module once.
warm_nuitka() {
  mkdir -p "$work/nuitka-warm"
  echo 'X = 1' > "$work/nuitka-warm/bp_nuitka_warm.py"
  (cd "$work/nuitka-warm" && "$py" -m nuitka --module bp_nuitka_warm.py --output-dir=out \
    --remove-output --assume-yes-for-downloads >"$work/nuitka-warm.log" 2>&1) \
    || { tail -20 "$work/nuitka-warm.log" >&2; die "Nuitka couldn't compile a test module"; }
  say "Nuitka works (and has what it downloads)"
}

install_deps() {
  if [ ! -x "$py" ]; then
    base=${PYTHON:-$(command -v python3.11 || command -v python3 || true)}
    [ -n "$base" ] || die "no Python 3.11 to create $VENV; set PYTHON"
    say "creating $VENV with $base"
    "$base" -m venv "$VENV"
  fi
  install_engine
  if needs_nuitka; then warm_nuitka; fi
  # No install scripts (security review S2). None of the app's is needed to build: @firebase/util's
  # only reads FIREBASE_WEBAPP_CONFIG, protobufjs's checks a version, fsevents is for dev watching.
  if [ -n "${CI:-}" ] || [ ! -d "$app/node_modules" ]; then (cd "$app" && npm ci --ignore-scripts); fi
  # The crates, checked against Cargo.lock, so `tauri build` can run offline.
  cargo fetch --locked --manifest-path "$app/src-tauri/Cargo.toml" ${target:+--target "$target"}
}

# --no-deps: everything must be there already, since nothing is downloaded.
check_deps() {
  local hint="run scripts/build-release.sh --deps-only first (same --edition and ENGINE_EXTRAS)"
  [ -x "$py" ] || die "$VENV doesn't exist; $hint"
  "$py" -c "import breakpatch_engine, PyInstaller" 2>/dev/null || die "the engine or PyInstaller isn't in $VENV; $hint"
  if needs_nuitka; then "$py" -c "import nuitka" 2>/dev/null || die "Nuitka isn't in $VENV; $hint"; fi
  [ -d "$app/node_modules" ] || die "app/node_modules doesn't exist; $hint"
  export CARGO_NET_OFFLINE=true
  say "using the installed dependencies (--no-deps; cargo offline)"
}

# ---------------------------------------------------------------- signing environment

signing_vars=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD
              APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
              TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
              BP_CODESIGN_P12 BP_CODESIGN_P12_PASSWORD)
# GitHub Actions passes a missing secret as an empty string; the Tauri CLI would try to use it.
# The others stay shell variables but leave the environment (export -n): no child process sees
# them unless it's handed them (run_tauri, the openssl calls that open the .p12).
for v in "${signing_vars[@]}"; do
  if [ -z "${!v:-}" ]; then unset "$v"; else export -n "${v?}"; fi
done

if [ "$phase" = deps ]; then
  set_vars=()
  for v in "${signing_vars[@]}"; do [ -z "${!v:-}" ] || set_vars+=("$v"); done
  [ ${#set_vars[@]} -eq 0 ] || die "--deps-only installs third-party packages, so it must run without signing variables in the environment; unset ${set_vars[*]}"
  install_deps
  say "dependencies installed; build with --no-deps"
  exit 0
fi

updater=1
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  updater=0
fi
pubkey=$(node -p "require('$app/src-tauri/tauri.conf.json').plugins.updater.pubkey")

# macOS code signing: Apple Developer ID, else Breakpatch's own certificate, else ad-hoc.
signing_dir="$app/src-tauri/signing"      # the committed public part of Breakpatch's certificate
darwin=0
if [ "$(uname -s)" = Darwin ]; then darwin=1; fi
if [ "$darwin" -eq 0 ]; then
  sign_mode=none
elif [ -n "${APPLE_CERTIFICATE:-}" ]; then
  sign_mode=developer-id
elif [ -n "${BP_CODESIGN_P12:-}" ]; then
  sign_mode=self-signed
elif [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  sign_mode=developer-id                 # an Apple identity already in this Mac's keychain
else
  sign_mode=ad-hoc
fi

if [ "$release" -eq 1 ]; then
  missing=()
  [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || missing+=(TAURI_SIGNING_PRIVATE_KEY)
  case "$sign_mode" in
    developer-id)
      for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
        [ -n "${!v:-}" ] || missing+=("$v")
      done ;;
    self-signed) [ -n "${BP_CODESIGN_P12_PASSWORD:-}" ] || missing+=(BP_CODESIGN_P12_PASSWORD) ;;
    ad-hoc) missing+=("BP_CODESIGN_P12 and BP_CODESIGN_P12_PASSWORD (or the APPLE_ Developer ID variables)") ;;
  esac
  [ ${#missing[@]} -eq 0 ] || die "--release needs ${missing[*]}"
fi
if [ "$sign_mode" = self-signed ] && [ -z "${BP_CODESIGN_P12_PASSWORD:-}" ]; then
  die "BP_CODESIGN_P12 is set but BP_CODESIGN_P12_PASSWORD isn't"
fi
if [ "$updater" -eq 1 ] && [[ "$pubkey" != dW50cnVzdGVk* ]]; then
  # Every minisign public key file starts "untrusted comment:", base64 "dW50cnVzdGVk".
  die "plugins.updater.pubkey in app/src-tauri/tauri.conf.json isn't a real key ($pubkey); installed copies couldn't check updates. Put the .pub file's contents there (src-tauri/README.md)."
fi

say "edition $edition, target $triple$([ "$release" -eq 1 ] && echo ', release')"
if [ "$updater" -eq 1 ]; then say "signing the update archive"; else say "no update archive (no TAURI_SIGNING_PRIVATE_KEY)"; fi

# ---------------------------------------------------------------- macOS code signing

# Fingerprints as bare upper-case hex, whatever the notation ("SHA256 Fingerprint=AB:CD…").
hex() { sed 's/^.*=//' | tr -cd '0-9A-Fa-f' | tr 'a-f' 'A-F'; }
cert_sha256() { openssl x509 -noout -fingerprint -sha256 "$@" | hex; }
committed_sha256() { grep -v '^#' "$signing_dir/fingerprint.txt" | hex; }

# The .p12's certificate as PEM. OpenSSL 3 needs -legacy for the old algorithms macOS uses.
# The password reaches openssl through its environment only, never its command line.
p12_leaf() {
  BP_CODESIGN_P12_PASSWORD=$BP_CODESIGN_P12_PASSWORD openssl pkcs12 -in "$1" -nokeys -clcerts -passin env:BP_CODESIGN_P12_PASSWORD 2>/dev/null \
    || BP_CODESIGN_P12_PASSWORD=$BP_CODESIGN_P12_PASSWORD openssl pkcs12 -legacy -in "$1" -nokeys -clcerts -passin env:BP_CODESIGN_P12_PASSWORD 2>/dev/null
}
decode_p12() {   # <out>
  printf '%s' "$BP_CODESIGN_P12" | tr -d ' \r\n' | openssl base64 -d -A > "$1" 2>/dev/null || true
  [ -s "$1" ] || die "BP_CODESIGN_P12 isn't the base64 of a .p12 file"
}

# Releases must be signed with the committed certificate: the designated requirement names it,
# and the Keychain only lets the app back in to its items while that requirement holds.
check_stable_identity() {
  local have=$1 want cer_fp
  if [ ! -f "$signing_dir/fingerprint.txt" ]; then
    [ "$release" -eq 0 ] || die "app/src-tauri/signing/fingerprint.txt isn't committed, so this release can't be checked against the certificate users already have. Commit the public files scripts/make-signing-cert.sh wrote."
    echo "build-release: WARNING: no app/src-tauri/signing/fingerprint.txt to check the certificate against" >&2
    return 0
  fi
  want=$(committed_sha256)
  if [ -f "$signing_dir/breakpatch-codesign.cer" ]; then
    cer_fp=$(cert_sha256 -inform der -in "$signing_dir/breakpatch-codesign.cer")
    [ "$cer_fp" = "$want" ] || die "app/src-tauri/signing/breakpatch-codesign.cer ($cer_fp) doesn't match fingerprint.txt ($want)"
  fi
  if [ "$have" != "$want" ]; then
    die "the certificate in BP_CODESIGN_P12 isn't Breakpatch's committed signing certificate.
  in BP_CODESIGN_P12:                     SHA-256 $have
  app/src-tauri/signing/fingerprint.txt:  SHA-256 $want
A different certificate gives the app a new code signing identity. After updating, every user
would get a Keychain prompt once for each saved secret and the licence, and an unattended
runner would stop at those prompts. Put the original .p12 back in the BP_CODESIGN_P12 secrets
(it's in the owner's password manager). Only if the change is intended: commit the new
breakpatch-codesign.cer and fingerprint.txt from scripts/make-signing-cert.sh --force."
  fi
}

# Checks BP_CODESIGN_P12 before the build starts, so a wrong certificate fails in seconds. Only
# the public certificate is kept ($work/codesign-leaf.pem); open_signing_keychain uses the key.
cert_sha1=""
check_self_signed() {
  local p12="$work/codesign.p12" leaf="$work/codesign-leaf.pem"
  for c in security codesign openssl; do command -v "$c" >/dev/null || die "$c not found"; done
  decode_p12 "$p12"
  p12_leaf "$p12" > "$leaf" || true
  rm -f "$p12"
  openssl x509 -in "$leaf" -noout 2>/dev/null || die "couldn't open BP_CODESIGN_P12 with BP_CODESIGN_P12_PASSWORD (wrong password?)"
  [[ $(openssl x509 -in "$leaf" -noout -text) == *"Code Signing"* ]] || die "the certificate in BP_CODESIGN_P12 isn't for code signing (no codeSigning extended key usage)"
  openssl x509 -in "$leaf" -noout -checkend 0 >/dev/null || die "the certificate in BP_CODESIGN_P12 has expired"
  if ! openssl x509 -in "$leaf" -noout -checkend 7776000 >/dev/null; then
    echo "build-release: WARNING: the signing certificate expires within 90 days ($(openssl x509 -in "$leaf" -noout -enddate))" >&2
  fi
  check_stable_identity "$(cert_sha256 -in "$leaf")"
  cert_sha1=$(openssl x509 -in "$leaf" -noout -fingerprint -sha1 | hex)
}

# Imports BP_CODESIGN_P12 into a temporary keychain on the search list, so codesign (and the
# Tauri CLI, through APPLE_SIGNING_IDENTITY) can use it. signing_cleanup deletes it. Called only
# once the sidecar and the frontend are built, just before signing (security review S2).
open_signing_keychain() {
  local p12="$work/codesign.p12" leaf="$work/codesign-leaf.pem" kc_pass line
  decode_p12 "$p12"
  while IFS= read -r line; do
    line=${line#*\"}; line=${line%\"*}
    [ -z "$line" ] || saved_keychains+=("$line")
  done < <(security list-keychains -d user)
  kc_pass=$(openssl rand -hex 24)
  codesign_kc="$work/codesign.keychain-db"
  security create-keychain -p "$kc_pass" "$codesign_kc"
  security set-keychain-settings -lut 3600 "$codesign_kc"      # locks itself after an hour
  security unlock-keychain -p "$kc_pass" "$codesign_kc"
  security import "$p12" -k "$codesign_kc" -f pkcs12 -P "$BP_CODESIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null \
    || die "macOS couldn't import BP_CODESIGN_P12"
  rm -f "$p12"
  # Lets codesign use the key without a dialog.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$codesign_kc" >/dev/null
  security list-keychains -d user -s "$codesign_kc" ${saved_keychains[@]+"${saved_keychains[@]}"}

  # One test signature, so a certificate codesign won't use fails here and not after the build.
  # codesign normally signs with an untrusted self-signed certificate; if this Mac's codesign
  # won't, a CI machine (passwordless sudo) may trust it for code signing and try again.
  cp /usr/bin/true "$work/sign-check"
  if ! codesign --force --sign "$cert_sha1" "$work/sign-check" 2>"$work/sign-check.log"; then
    if [ -n "${CI:-}" ] && sudo -n true 2>/dev/null; then
      say "codesign refused the certificate as it is ($(cat "$work/sign-check.log")); trusting it for code signing on this CI machine"
      sudo -n security add-trusted-cert -d -r trustRoot -p codeSign -k "$codesign_kc" "$leaf"
      codesign --force --sign "$cert_sha1" "$work/sign-check" || die "codesign can't sign with the certificate in BP_CODESIGN_P12"
    else
      die "codesign can't sign with the certificate in BP_CODESIGN_P12: $(cat "$work/sign-check.log")"
    fi
  fi
  rm -f "$work/sign-check" "$work/sign-check.log"
  say "signing keychain ready"
}

# The hardened runtime is on in every macOS signing mode (security review A7): it needs no
# notarisation, and without it any process running as the user could start the genuine app with
# DYLD_INSERT_LIBRARIES and read its Keychain items with no prompt. tauri.conf.json turns it on
# with app/src-tauri/Entitlements.plist, which Tauri applies to the app and to the sidecar in it.
# That file keeps com.apple.security.cs.disable-library-validation, and it must: with library
# validation a hardened process may only load code signed by Apple or with its own Team ID. A
# self-signed or ad-hoc signature has no Team ID at all, and the PyInstaller sidecar unpacks its
# Python extension modules and bundled dylibs (numpy, OpenCV, MLX's libmlx and Metal kernels)
# at run time and loads them with their vendors' own signatures, not ours. Dropping it needs the
# sidecar signed apart from the app, with its own entitlements (a follow-up; the app itself only
# loads system frameworks). allow-jit and allow-unsigned-executable-memory are for MLX and numpy.
entitlements="$app/src-tauri/Entitlements.plist"
case "$sign_mode" in
  none)
    echo "build-release: WARNING: not code signing: that's macOS only (this is $(uname -s))" >&2 ;;
  developer-id)
    say "code signing with Apple Developer ID${APPLE_SIGNING_IDENTITY:+ ($APPLE_SIGNING_IDENTITY)}, hardened runtime"
    if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then say "notarising"; else say "not notarising (no APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID)"; fi ;;
  self-signed)
    check_self_signed
    say "code signing with Breakpatch Code Signing (certificate SHA-1 $cert_sha1), not notarised"
    # Tauri signs the app and the sidecar in it with this identity (the hash: unambiguous
    # even when the same certificate is in the login keychain too). Nothing to notarise.
    export APPLE_SIGNING_IDENTITY=$cert_sha1
    unset APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH ;;
  ad-hoc)
    echo "build-release: WARNING: ad-hoc code signing (no BP_CODESIGN_P12 or APPLE_ signing variables)." >&2
    echo "build-release: WARNING: fine to try on this Mac, not to publish: each build has a new identity, so the Keychain asks again after every update." >&2
    export APPLE_SIGNING_IDENTITY=-
    unset APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH ;;
esac
sign_identity=${APPLE_SIGNING_IDENTITY:-}

# The PyInstaller sidecar is one Mach-O (--onefile; the Python libraries inside it are
# unpacked at run time), so signing it signs everything in it. Tauri signs it again inside the
# .app; signing it here first proves the signed binary still starts, under the hardened runtime
# with the app's entitlements. With a Developer ID only Tauri has the certificate (it imports
# APPLE_CERTIFICATE itself), so it signs it there.
sign_sidecar() {
  case "$sign_mode" in
    self-signed|ad-hoc)
      codesign --force --options runtime --entitlements "$entitlements" --sign "$sign_identity" "$sidecar"
      codesign --verify --strict "$sidecar" || die "$sidecar doesn't verify after signing"
      has_runtime "$sidecar" || die "$sidecar was signed without the hardened runtime"
      "$sidecar" --version >/dev/null || die "$sidecar doesn't start after signing (hardened runtime)"
      say "signed $(basename "$sidecar") ($sign_mode, hardened runtime)" ;;
    developer-id) say "the sidecar is signed with the Developer ID inside the .app" ;;
  esac
}

cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
# codesign -dv prints e.g. "CodeDirectory v=20500 size=… flags=0x10000(runtime) hashes=…".
# Reads codesign's whole output first: `codesign … | grep -q` stops reading at the first match,
# codesign then dies of SIGPIPE, and under pipefail a signed binary reads as unsigned.
has_runtime() { local info; info=$(codesign -dv "$1" 2>&1) || return 1; [[ $info =~ flags=0x[0-9a-f]*\([^\)]*runtime ]]; }

# The signed .app: valid, with the requirement this signing mode must give it, and the same
# signed app in the update archive and the .dmg (both are made from it after signing).
verify_signed_bundle() {
  local bundle="$out/bundle" appdir dr hash fp dmg
  appdir="$bundle/macos/Breakpatch.app"
  [ "$darwin" -eq 1 ] || return 0
  [ -d "$appdir" ] || { say "no .app bundle, so no code signature to check"; return 0; }
  codesign --verify --deep --strict --verbose=2 "$appdir" || die "$appdir doesn't pass codesign --verify --deep --strict"
  codesign --verify --strict "$appdir/Contents/MacOS/breakpatch-engine" || die "the engine sidecar in $appdir isn't signed properly"
  has_runtime "$appdir" || die "$appdir isn't signed with the hardened runtime"
  has_runtime "$appdir/Contents/MacOS/breakpatch-engine" || die "the engine sidecar in $appdir isn't signed with the hardened runtime"
  dr=$(codesign -d -r- "$appdir" 2>&1 | sed -n 's/^designated => //p')
  hash=$(cdhash "$appdir")
  say "designated requirement: $dr"
  case "$sign_mode" in
    self-signed)
      [[ "$(printf '%s' "$dr" | tr 'a-f' 'A-F')" == *"$cert_sha1"* ]] || die "the designated requirement doesn't name the Breakpatch certificate ($cert_sha1)"
      rm -f "$work"/app-cert-*
      codesign -d --extract-certificates="$work/app-cert-" "$appdir" 2>/dev/null
      fp=$(cert_sha256 -inform der -in "$work/app-cert-0")
      if [ ! -f "$signing_dir/fingerprint.txt" ]; then
        say "signed with the certificate in BP_CODESIGN_P12 (SHA-256 $fp; none committed to compare)"
      elif [ "$fp" != "$(committed_sha256)" ]; then
        die "$appdir is signed with $fp, not the committed certificate"
      else
        say "signed with the committed Breakpatch certificate (SHA-256 $fp)"
      fi ;;
    developer-id)
      [[ "$dr" == *"anchor apple generic"* ]] || echo "build-release: WARNING: the designated requirement isn't an Apple one" >&2 ;;
    ad-hoc)
      echo "build-release: WARNING: ad-hoc signed: the designated requirement is this build's hash, so don't publish it" >&2 ;;
  esac
  if [ -f "$bundle/macos/Breakpatch.app.tar.gz" ]; then
    rm -rf "$work/archive"; mkdir "$work/archive"
    tar -xzf "$bundle/macos/Breakpatch.app.tar.gz" -C "$work/archive"
    codesign --verify --deep --strict "$work/archive/Breakpatch.app" || die "the app in Breakpatch.app.tar.gz doesn't pass codesign --verify"
    [ "$(cdhash "$work/archive/Breakpatch.app")" = "$hash" ] || die "Breakpatch.app.tar.gz doesn't hold the signed app (a different code signature)"
    rm -rf "$work/archive"
    say "the update archive holds the signed app"
  fi
  for dmg in "$bundle"/dmg/*.dmg; do
    [ -f "$dmg" ] || continue
    dmg_mount="$work/dmg"; mkdir -p "$dmg_mount"
    hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$dmg_mount" "$dmg" || die "couldn't open $dmg"
    [ "$(cdhash "$dmg_mount/Breakpatch.app")" = "$hash" ] || die "$(basename "$dmg") doesn't hold the signed app"
    hdiutil detach -quiet "$dmg_mount"; dmg_mount=""
    say "$(basename "$dmg") holds the signed app"
  done
}

# ---------------------------------------------------------------- 1. edition and venv

if [ "$phase" = build ]; then check_deps; else install_deps; fi

# The AI assistant models must be pinned for a release (engine/src/breakpatch_engine/models.py):
# a commit SHA and a SHA-256 for every file. Other builds only get a warning.
check_model_pins() {
  if "$py" -m breakpatch_engine.models --check-release; then return 0; fi
  [ "$release" -eq 0 ] || die "--release needs every AI assistant model pinned in engine/src/breakpatch_engine/models.py (see its TODO)"
  echo "build-release: WARNING: the AI assistant models aren't pinned yet: fine to try, not to publish" >&2
}
check_model_pins

# Off macOS the AI assistant runs on llama.cpp, whose runtime build must be pinned for a release
# too (engine/src/breakpatch_engine/runtimes.py): a real URL, a SHA-256 and a size for every build.
# macOS builds don't use it and don't check it.
check_runtime_pins() {
  [ "$darwin" -eq 0 ] || return 0
  if "$py" -m breakpatch_engine.runtimes --check-release; then return 0; fi
  [ "$release" -eq 0 ] || die "--release needs the llama.cpp runtime pinned in engine/src/breakpatch_engine/runtimes.py (see its TODO)"
  echo "build-release: WARNING: the llama.cpp runtime isn't pinned yet: fine to try, not to publish" >&2
}
check_runtime_pins

# Start from Community either way: a Team link or Team engine left by an earlier build goes.
to_community

if [ "$edition" = team ]; then
  sh "$repo/scripts/link-team.sh"
  team=$(dirname "$(cd "$app/src/edition/team" && pwd -P)")   # the checkout the link points into
  [ -f "$team/engine/pyproject.toml" ] || die "$team/engine isn't the Team engine"
  say "installing the Team engine from $team/engine"
  # Not editable, and without dependencies: the open engine in this venv is the one it needs.
  # From a copy, so the build leaves no build/ folder in the Team checkout.
  # Never a _keys.py from the checkout (a developer's may hold the test key): the licence keys
  # step below writes this build's own.
  mkdir "$work/team-engine"
  (cd "$team/engine" && tar cf - --exclude build --exclude '*.egg-info' --exclude __pycache__ --exclude .venv --exclude _keys.py .) | (cd "$work/team-engine" && tar xf -)
fi

# ---------------------------------------------------------------- licence keys

# Only this script decides which licence keys a build carries: never one from the environment.
unset BREAKPATCH_LICENCE_PUBKEYS
real_keys="" test_keys=""
if [ "$edition" = team ]; then
  real_keys="$team/backoffice/keys/public-keys.json"
  test_keys="$team/backoffice/keys/public-keys.test.json"
  [ -f "$real_keys" ] || die "$real_keys not found: the Team checkout must have the licence public keys"
  with_test=$([ "$release" -eq 1 ] || [ "$no_test_key" -eq 1 ] && echo 0 || echo 1)
  # A JSON map kid -> base64url Ed25519 key. The real table must not hold a test key.
  BREAKPATCH_LICENCE_PUBKEYS=$(node -e '
    const fs = require("fs");
    process.on("uncaughtException", e => { console.error("build-release: " + e.message); process.exit(1); });
    const [real, test, withTest] = process.argv.slice(1);
    const read = f => { const m = JSON.parse(fs.readFileSync(f, "utf8")); if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error(f + " is not a map"); return m; };
    const keys = read(real);
    const testKeys = fs.existsSync(test) ? read(test) : {};
    const testValues = new Set(Object.values(testKeys));
    if (!Object.keys(keys).length) throw new Error(real + " has no keys");
    for (const [kid, k] of Object.entries(keys)) {
      if (/^test/i.test(kid) || testValues.has(k)) throw new Error(real + " holds the test key " + kid);
      if (!/^[A-Za-z0-9_-]{43}$/.test(k)) throw new Error(real + ": key " + kid + " is not a base64url Ed25519 key");
    }
    process.stdout.write(JSON.stringify(withTest === "1" ? { ...keys, ...testKeys } : keys));
  ' "$real_keys" "$test_keys" "$with_test") || die "couldn't read the licence keys from $team/backoffice/keys"
  export BREAKPATCH_LICENCE_PUBKEYS
  say "licence keys: $(node -p 'Object.keys(JSON.parse(process.argv[1])).join(", ")' "$BREAKPATCH_LICENCE_PUBKEYS")$([ "$with_test" -eq 1 ] && echo ' (with the test key: not a --release or --no-test-key build)')"
  if [ "$release" -eq 1 ] && [ -n "${BREAKPATCH_LICENCE_URL:-}" ] && [[ "$BREAKPATCH_LICENCE_URL" != https://* ]]; then
    die "--release needs an https BREAKPATCH_LICENCE_URL, not $BREAKPATCH_LICENCE_URL"
  fi

  # The Team engine checks tokens itself (healing, breakpatch-ci) with the same keys.
  [ -f "$work/team-engine/scripts/embed_keys.py" ] || die "$team/engine/scripts/embed_keys.py not found: this Team checkout's engine can't take licence keys"
  "$py" "$work/team-engine/scripts/embed_keys.py" --keys-json "$BREAKPATCH_LICENCE_PUBKEYS" \
    --out "$work/team-engine/src/breakpatch_team_engine/_keys.py" ${BREAKPATCH_LICENCE_URL:+--url "$BREAKPATCH_LICENCE_URL"} \
    || die "couldn't build the licence keys into the Team engine"
  # --no-build-isolation: setuptools is the locked one in the venv, so nothing is downloaded here.
  "$py" -m pip install -q --no-deps --no-build-isolation "$work/team-engine"
  "$py" -c "from breakpatch_engine import plugins; assert plugins.edition() == 'team', plugins.edition()" \
    || die "the Team engine is installed but didn't register"
  engine_kids=$(cd "$work" && "$py" -c "from breakpatch_team_engine import licence; print(','.join(sorted(licence.compiled_keys())))")
  want_kids=$(node -p 'Object.keys(JSON.parse(process.argv[1])).sort().join(",")' "$BREAKPATCH_LICENCE_PUBKEYS")
  [ "$engine_kids" = "$want_kids" ] || die "the Team engine has the licence keys '$engine_kids', not '$want_kids'"
  say "Team engine licence keys: $engine_kids"
else
  unset BREAKPATCH_LICENCE_URL
fi

# ---------------------------------------------------------------- 2. engine sidecar

if [ "$edition" = team ]; then
  if [ -e "$sidecar" ]; then
    saved_sidecar="$work/$(basename "$sidecar")"
    mv "$sidecar" "$saved_sidecar"
  fi
  team_sidecar=1
fi
PYTHON="$py" sh "$engine/scripts/build_sidecar.sh"
[ -x "$sidecar" ] || die "$sidecar wasn't written"
if grep -q breakpatch-dev-sidecar-placeholder "$sidecar"; then die "$sidecar is the dev placeholder, not a PyInstaller build"; fi
reported=$(BP_HOME="$work/home" "$sidecar" info 2>/dev/null | "$py" -c "import json, sys; print(json.load(sys.stdin).get('edition'))") \
  || die "$sidecar info failed"
[ "$reported" = "$edition" ] || die "the sidecar says it's the $reported edition, not $edition"
# Its licence as it sees it with no token: "none" with keys built in (Team), else "unavailable".
licence_state=$(BP_HOME="$work/home" "$sidecar" info 2>/dev/null | "$py" -c "import json, sys; print((json.load(sys.stdin).get('licence') or {}).get('state'))") \
  || die "$sidecar info failed"
want_state=$([ "$edition" = team ] && echo none || echo unavailable)
[ "$licence_state" = "$want_state" ] || die "the sidecar's licence state is $licence_state, not $want_state (are the Team engine's licence keys built in?)"
say "sidecar $(basename "$sidecar") reports edition $reported, licence $licence_state"

# ---------------------------------------------------------------- 3. frontend and app

cd "$app"
npx tsc -b
npx vite build
# The Team module's code is in the bundle exactly when this is the Team edition. Two markers
# that survive minification and appear in no open code: a Team button and the Firebase SDK.
markers=0
for m in "Run on runner" "firestore.googleapis.com"; do
  if grep -rqF "$m" dist; then markers=$((markers + 1)); fi
done
case "$markers" in
  0) built=community ;;
  2) built=team ;;
  *) die "app/dist has only some of the Team edition's code (\"Run on runner\", firestore.googleapis.com)" ;;
esac
[ "$built" = "$edition" ] || die "app/dist is the $built edition, not $edition"
say "app/dist is the $edition edition"

# Signing starts here: the sidecar and the frontend are built, so the keychain is made now.
if [ "$sign_mode" = self-signed ]; then open_signing_keychain; fi
sign_sidecar

# Only for this build: the frontend is built already, and no updater key means no update archive.
# The hardened runtime stays as tauri.conf.json has it (on) in every mode.
overrides="$work/tauri.build.json"
node -e '
  const [updater] = process.argv.slice(1);
  const conf = { build: { beforeBuildCommand: null } };
  if (updater === "0") conf.bundle = { createUpdaterArtifacts: false };
  process.stdout.write(JSON.stringify(conf));
' "$updater" > "$overrides"

if [ "$bundle_set" -eq 0 ] && [ "$(uname -s)" != Darwin ]; then
  # tauri.conf.json bundles the macOS .app and .dmg; elsewhere build the app binary only.
  say "not bundling on $(uname -s) (the configured bundles are macOS ones); use --bundles deb for a package"
  bundle_args=(--no-bundle)
fi

out="$app/src-tauri/target/${target:+$target/}release"
# Bundles from an earlier build (maybe the other edition) must not sit next to this one's.
rm -rf "$out/bundle"

tauri_args=(build --config "$overrides" ${bundle_args[@]+"${bundle_args[@]}"})
[ -z "$target" ] || tauri_args+=(--target "$target")
# The only command that gets the signing variables: the Tauri CLI signs the app and the update
# archive with them (exported in this subshell only).
(
  for v in "${signing_vars[@]}"; do
    if [ -n "${!v:-}" ]; then export "${v?}"; fi
  done
  exec npx tauri "${tauri_args[@]}"
)

# The licence keys in the binary are exactly the ones asked for: masked, each key shows as its digest
# "bplk1:<sha256 of breakpatch-licence-key-v1:KEY>" (src-tauri/src/licence_embed.rs).
bin="$out/breakpatch"
[ -f "$bin" ] || die "$bin wasn't built"
has_key() { grep -aqF "$1" "$bin" || grep -aqF "bplk1:$(printf 'breakpatch-licence-key-v1:%s' "$1" | shasum -a 256 | cut -c1-64)" "$bin"; }
key_values() { [ -f "$1" ] && node -e 'for (const v of Object.values(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))) console.log(v)' "$1"; }
if [ "$edition" = team ]; then
  for k in $(key_values "$real_keys"); do has_key "$k" || die "$bin doesn't have the licence key $k"; done
  for k in $(key_values "$test_keys"); do
    if [ "$with_test" -eq 0 ] && has_key "$k"; then die "$bin has the test licence key: a --release or --no-test-key build must not"; fi
    if [ "$with_test" -eq 1 ] && ! has_key "$k"; then die "$bin doesn't have the test licence key"; fi
  done
  say "licence keys checked in $(basename "$bin")"
elif has_key '"2026-09"' || has_key 'test-rfc8032'; then
  die "$bin has licence keys, but Community builds have none"
fi

verify_signed_bundle

# ---------------------------------------------------------------- Team bundle hardening checks
#
# After a Team build, refuse to ship if the paid code or its source could be lifted from the
# bundle (src-tauri/README.md "Hardening"): no .py/.pyc of breakpatch_team_engine, no JS source
# maps, and no readable Team source file paths. Deterrence, not protection: the licence check is
# the real gate. Community is open source, so it's exempt.
if [ "$edition" = team ]; then
  say "checking the Team bundle is hardened"
  dist="$app/dist"
  scan_roots="$sidecar $dist"
  [ -d "$out/bundle" ] && scan_roots="$scan_roots $out/bundle"

  # 1. No .py or .pyc of breakpatch_team_engine as a real file anywhere in the bundle.
  # shellcheck disable=SC2086
  leak=$(find $scan_roots -type f \( -name '*.py' -o -name '*.pyc' \) 2>/dev/null | grep breakpatch_team_engine || true)
  [ -z "$leak" ] || die "the Team bundle ships breakpatch_team_engine source/bytecode:
$leak"

  # 1b. The engine sidecar is a onefile executable; if PyInstaller built it, read its embedded
  # archive and fail on any breakpatch_team_engine entry that isn't the compiled .so extension.
  if "$py" -c "import PyInstaller" 2>/dev/null; then
    "$py" - "$sidecar" <<'PY' || die "the engine sidecar ships breakpatch_team_engine as Python, not native code (build_sidecar hardening didn't run)"
import sys
try:
    from PyInstaller.archive.readers import CArchiveReader
    toc = list(CArchiveReader(sys.argv[1]).toc)
except Exception:
    sys.exit(0)  # not a PyInstaller onefile (e.g. Nuitka); the file/path scans cover it
bad = [n for n in toc
       if (n == "breakpatch_team_engine" or n.startswith("breakpatch_team_engine."))
       and not n.endswith(".so") and not n.endswith(".pyd") and not n.endswith(".dylib")]
if bad:
    print("  not native:", ", ".join(sorted(bad)), file=sys.stderr)
    sys.exit(1)
PY
    say "the engine sidecar carries breakpatch_team_engine as native code only"
  fi

  # 2. No JavaScript source maps in the shipped frontend.
  maps=$(find "$dist" -name '*.map' 2>/dev/null || true)
  [ -z "$maps" ] || die "the Team frontend ships source maps:
$maps"
  if grep -rlF 'sourceMappingURL' "$dist" >/dev/null 2>&1; then
    die "the Team frontend has sourceMappingURL references (source maps not fully stripped): $(grep -rlF 'sourceMappingURL' "$dist" | tr '\n' ' ')"
  fi

  # 3. No readable Team source file paths: the Team checkout's location must not be embedded in
  # the engine sidecar or the frontend.
  if grep -aqF "$team/" "$sidecar" 2>/dev/null; then
    die "the engine sidecar embeds the Team checkout path ($team); source paths leak"
  fi
  if grep -raqF "$team/" "$dist" 2>/dev/null; then
    die "the Team frontend embeds the Team checkout path ($team); source paths leak"
  fi
  say "Team bundle hardening checks passed"
fi

say "app binary: $bin"
if [ -d "$out/bundle" ]; then
  say "bundles:"
  find "$out/bundle" -maxdepth 2 -mindepth 2 \( -name '*.dmg' -o -name '*.app' -o -name '*.tar.gz' -o -name '*.sig' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) -print | sed 's/^/  /'
fi
