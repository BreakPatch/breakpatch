#!/usr/bin/env bash
# Builds what https://breakpatch.dev/install-ci installs: breakpatch-ci, the Team command line for
# CI, for this machine (macOS arm64; Linux x86_64 and arm64; Windows x64, a preview). The release workflow
# (.github/workflows/release.yml, after the app) and CI (.github/workflows/ci.yml, with a
# throwaway key) run this script; so can you, with the Team checkout next to this repo.
#
#   scripts/build-ci.sh                              # both phases; real and test licence keys
#   scripts/build-ci.sh --release                    # the real licence keys only (a release)
#   scripts/build-ci.sh --keys-file KEYS.json        # only these keys (a throwaway test build)
#   scripts/build-ci.sh --engine-wheel FILE          # use this open engine wheel, don't build one
#   scripts/build-ci.sh --out DIR                    # default dist/ci
#
# Writes, into --out:
#   breakpatch_engine-<version>-py3-none-any.whl     the open engine (pip wheel, no dependencies)
#   breakpatch_team_engine-<version>-cp311-cp311-<platform>.whl
#                                                    the Team engine compiled to native code, by
#                                                    the Team checkout's engine/scripts/build_ci_wheel.sh
#                                                    (Nuitka --module; no .py of it in the wheel)
#   breakpatch-ci-requirements-<platform>.txt        what the install command installs, with
#                                                    pip --require-hashes --only-binary=:all:: the
#                                                    engine's dependencies as pinned and hashed in
#                                                    engine/locks/, and the two wheels by SHA-256
#                                                    (scripts/ci-requirements.py). On macOS with
#                                                    the AI assistant's (the mlx extra), so
#                                                    --auto-fix works on a self-hosted Mac
# One engine wheel serves every platform: the other release jobs pass the Linux x86_64 job's with
# --engine-wheel, so every requirements file names the same file and hash.
#
# Linux: run it inside a manylinux_2_28 container (scripts/build-manylinux.sh does), so the Team
# wheel's native module needs glibc 2.28 at most and the wheel is tagged manylinux_2_28_<arch>
# (the Team repo's make_wheel.py reads AUDITWHEEL_PLAT, which the container sets). Built straight
# on a newer Linux it's tagged linux_<arch> and only promises to run where it was built.
# Windows: run it under Git Bash; the venv's Python is Scripts/python.exe.
#
# Two phases, like scripts/build-release.sh (security review S2):
#   --deps-only   the build venv (VENV, default engine/.venv) from the hashed locks:
#                 engine/locks/build.txt and <platform>.dev-hardening.txt (Nuitka;
#                 macos-arm64.dev-hardening-mlx.txt on a Mac), the engine itself, and what
#                 Nuitka downloads (a test module is compiled once).
#   --no-deps     builds with that, downloading nothing.
#
# Licence keys: this script decides, never the environment. The Team checkout's
# backoffice/keys/public-keys.json, plus public-keys.test.json unless --release; --keys-file
# replaces both (never with --release). BREAKPATCH_LICENCE_URL is built in when set (https only
# with --release). The version is app/package.json's; engine/pyproject.toml and
# breakpatch_engine.__version__ must say the same.
#
# Environment: VENV, PYTHON (to create the venv, default python3.11), TEAM_DIR (the Team checkout:
# absolute, or relative to the folder holding this repo; default ../breakpatch-team, then
# ../moravision-team).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
parent=$(dirname "$repo")
engine="$repo/engine"
out="$repo/dist/ci"
release=0
keys_file=""
engine_wheel=""
phase=all

usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "build-ci: $*" >&2; exit 1; }
say() { echo "build-ci: $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --release) release=1; shift ;;
    --keys-file) [ $# -ge 2 ] || die "--keys-file needs a file"; keys_file=$2; shift 2 ;;
    --engine-wheel) [ $# -ge 2 ] || die "--engine-wheel needs a file"; engine_wheel=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a folder"; out=$2; shift 2 ;;
    --deps-only) [ "$phase" = all ] || die "--deps-only and --no-deps are the two halves: pass one"; phase=deps; shift ;;
    --no-deps) [ "$phase" = all ] || die "--deps-only and --no-deps are the two halves: pass one"; phase=build; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ "$release" -eq 0 ] || [ -z "$keys_file" ] || die "--keys-file is for test builds; a --release has the real keys only"

# shellcheck source=scripts/platform.sh
. "$repo/scripts/platform.sh"
platform=$(bp_platform "$(uname -s)" "$(uname -m)") \
  || die "breakpatch-ci is built for macOS on Apple Silicon, Linux x86_64 and arm64, and Windows x64 only, not $(uname -s) $(uname -m)"
case "$platform" in
  macos-arm64) lock_extras=dev-hardening-mlx; extras=(--extra mlx) ;;
  *) lock_extras=dev-hardening; extras=() ;;
esac
lock="$engine/locks/$platform.$lock_extras.txt"
[ -f "$lock" ] || die "no hashed lock ${lock#"$repo"/}; run scripts/lock-python.sh"

VENV=${VENV:-"$engine/.venv"}
py=$(venv_python "$VENV")
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-build-ci.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- dependencies

install_deps() {
  if [ ! -x "$py" ]; then
    base=${PYTHON:-$(command -v python3.11 || true)}
    [ -n "$base" ] || die "no python3.11 to create $VENV; set PYTHON"
    say "creating $VENV with $base"
    "$base" -m venv "$VENV"
  fi
  "$py" -m pip install -q --require-hashes -r "$engine/locks/build.txt" \
    || die "couldn't install engine/locks/build.txt with --require-hashes"
  say "installing the engine [${lock_extras//-/,}] from ${lock#"$repo"/} (hashes checked)"
  "$py" -m pip install -q --require-hashes --no-build-isolation -r "$lock" \
    || die "couldn't install ${lock#"$repo"/} with --require-hashes. If engine/pyproject.toml changed, run scripts/lock-python.sh"
  "$py" -m pip install -q --no-deps --no-build-isolation -e "$engine"
  "$py" -m pip check >/dev/null || die "the lock doesn't satisfy engine/pyproject.toml; run scripts/lock-python.sh"
  # What Nuitka downloads, fetched now so the build phase downloads nothing.
  mkdir -p "$work/warm"
  echo 'X = 1' > "$work/warm/bp_nuitka_warm.py"
  (cd "$work/warm" && "$py" -m nuitka --module bp_nuitka_warm.py --output-dir=out --remove-output \
    --assume-yes-for-downloads >"$work/warm.log" 2>&1) || { tail -20 "$work/warm.log" >&2; die "Nuitka couldn't compile a test module"; }
  say "Nuitka works (and has what it downloads)"
}

if [ "$phase" != build ]; then install_deps; fi
if [ "$phase" = deps ]; then say "dependencies installed; build with --no-deps"; exit 0; fi

[ -x "$py" ] || die "$VENV doesn't exist; run scripts/build-ci.sh --deps-only first"
"$py" -c 'import sys, nuitka, breakpatch_engine; sys.exit(sys.version_info[:2] != (3, 11))' 2>/dev/null \
  || die "$VENV needs Python 3.11 with the engine and Nuitka; run scripts/build-ci.sh --deps-only first"

# ---------------------------------------------------------------- the Team checkout

if [ -n "${TEAM_DIR:-}" ]; then
  case "$TEAM_DIR" in /*) team="$TEAM_DIR" ;; *) team="$parent/$TEAM_DIR" ;; esac
elif [ -d "$parent/breakpatch-team" ]; then team="$parent/breakpatch-team"
elif [ -d "$parent/moravision-team" ]; then team="$parent/moravision-team"
else team="$parent/breakpatch-team"
fi
[ -f "$team/engine/scripts/build_ci_wheel.sh" ] || die "$team/engine/scripts/build_ci_wheel.sh not found. Check out Breakpatch/breakpatch-team next to this repo or set TEAM_DIR."

# ---------------------------------------------------------------- version

version=$("$py" -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/app/package.json")
pep=$("$py" "$team/engine/scripts/make_wheel.py" pep440 "$version")
engine_version=$("$py" -c 'import breakpatch_engine as e; print(e.__version__)')
project_version=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$engine/pyproject.toml" | head -n 1)
[ "$engine_version" = "$version" ] || die "breakpatch_engine.__version__ is $engine_version, app/package.json $version"
[ "$project_version" = "$pep" ] || die "engine/pyproject.toml has version $project_version, not $pep (app/package.json $version)"
say "breakpatch-ci $version for $platform$([ "$release" -eq 1 ] && echo ', release')"

# ---------------------------------------------------------------- licence keys

unset BREAKPATCH_LICENCE_PUBKEYS
if [ -n "$keys_file" ]; then
  keys_src=(--only "$keys_file")
  say "licence keys: only those in $keys_file (a test build, never published)"
else
  keys_src=(--real "$team/backoffice/keys/public-keys.json")
  [ "$release" -eq 1 ] || keys_src+=(--test "$team/backoffice/keys/public-keys.test.json")
fi
keys=$("$py" - "${keys_src[@]}" <<'PY'
import json, os, re, sys
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
def read(path):
    m = json.load(open(path))
    if not isinstance(m, dict) or not m:
        raise SystemExit(f"build-ci: {path} isn't a map of licence keys")
    for kid, k in m.items():
        if not isinstance(k, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", k):
            raise SystemExit(f"build-ci: {path}: key {kid} is not a base64url Ed25519 key")
    return m
if "--only" in args:
    keys = read(args["--only"])
else:
    keys = read(args["--real"])
    test = read(args["--test"]) if "--test" in args and os.path.exists(args["--test"]) else {}
    tests_path = args["--real"].replace("public-keys.json", "public-keys.test.json")
    known_test = set(read(tests_path).values()) if os.path.exists(tests_path) else set()
    for kid, k in keys.items():
        if re.match(r"(?i)test", kid) or k in known_test:
            raise SystemExit(f"build-ci: {args['--real']} holds the test key {kid}")
    keys.update(test)
print(json.dumps(keys, sort_keys=True))
PY
) || die "couldn't read the licence keys"
say "licence keys: $("$py" -c 'import json, sys; print(", ".join(sorted(json.loads(sys.argv[1]))))' "$keys")"
if [ "$release" -eq 1 ] && [ -n "${BREAKPATCH_LICENCE_URL:-}" ] && [[ "$BREAKPATCH_LICENCE_URL" != https://* ]]; then
  die "--release needs an https BREAKPATCH_LICENCE_URL, not $BREAKPATCH_LICENCE_URL"
fi

# ---------------------------------------------------------------- the wheels

mkdir -p "$out"
rm -f "$out"/breakpatch_team_engine-*.whl "$out/breakpatch-ci-requirements-$platform.txt"
if [ -n "$engine_wheel" ]; then
  [ -f "$engine_wheel" ] || die "$engine_wheel not found"
  case "$(basename "$engine_wheel")" in
    "breakpatch_engine-$pep-py3-none-any.whl") ;;
    *) die "$(basename "$engine_wheel") isn't breakpatch_engine-$pep-py3-none-any.whl" ;;
  esac
  [ "$(cd "$(dirname "$engine_wheel")" && pwd)" = "$(cd "$out" && pwd)" ] || cp "$engine_wheel" "$out/"
  say "using the open engine wheel $(basename "$engine_wheel")"
else
  rm -f "$out"/breakpatch_engine-*.whl
  # From a copy, so the build leaves no build/ folder in the checkout. Same bytes every time.
  (cd "$engine" && tar cf - --exclude build --exclude '*.egg-info' --exclude __pycache__ --exclude .venv \
    --exclude .pytest_cache --exclude tests .) | (mkdir -p "$work/engine" && cd "$work/engine" && tar xf -)
  SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-315532800} "$py" -m pip wheel -q --no-deps --no-build-isolation -w "$out" "$work/engine" \
    || die "couldn't build the open engine wheel"
fi
engine_whl="$out/breakpatch_engine-$pep-py3-none-any.whl"
[ -f "$engine_whl" ] || die "no $(basename "$engine_whl")"

PYTHON="$py" sh "$team/engine/scripts/build_ci_wheel.sh" --version "$version" --keys-json "$keys" --out "$out" \
  ${BREAKPATCH_LICENCE_URL:+--url "$BREAKPATCH_LICENCE_URL"}
team_whl=""
for f in "$out"/breakpatch_team_engine-"$pep"-cp311-cp311-*.whl; do [ -f "$f" ] && team_whl=$f; done
[ -n "$team_whl" ] || die "the Team wheel wasn't written"
"$py" "$team/engine/scripts/make_wheel.py" check "$team_whl" || die "$(basename "$team_whl") holds Team source"

"$py" "$repo/scripts/ci-requirements.py" --lock "$lock" --wheel "$engine_whl" --wheel "$team_whl" \
  --platform "$platform" ${extras[@]+"${extras[@]}"} --out "$out/breakpatch-ci-requirements-$platform.txt"
say "wrote $(basename "$engine_whl"), $(basename "$team_whl") and breakpatch-ci-requirements-$platform.txt to $out"
