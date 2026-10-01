#!/usr/bin/env bash
# Builds the Linux pieces inside a manylinux_2_28 container (AlmaLinux 8, glibc 2.28), so they run
# on every Linux with glibc 2.28 or later: Debian 12, Raspberry Pi OS Bookworm, Ubuntu 22.04 and
# later. Built straight on ubuntu-24.04 (glibc 2.39) a Nuitka module or a PyInstaller binary can
# need symbols those don't have (plan docs/linux-windows-plan.md §1.4, "glibc floor").
#
#   scripts/build-manylinux.sh ci [build-ci.sh options]     breakpatch-ci: the Team wheel (tagged
#                                                           manylinux_2_28_<arch>), the engine wheel
#                                                           and breakpatch-ci-requirements-linux-<arch>.txt
#   scripts/build-manylinux.sh sidecar [--out DIR]          the Community engine sidecar
#                                                           (breakpatch-engine-<arch>-unknown-linux-gnu)
#
# For this machine's architecture: run it on x86_64 for linux-x86_64 and on arm64 (a Raspberry Pi,
# ubuntu-24.04-arm) for linux-arm64. It doesn't emulate another architecture.
#
# The checkout is copied into the container (read-only mount, then a copy), so nothing in it is
# changed and nothing is written as root; only --out (default dist/ci, or dist/sidecar) is written.
# Inside, the same scripts run as on any machine: scripts/build-ci.sh --deps-only then --no-deps
# (hashed locks, Nuitka's downloads first; the build phase downloads nothing), or the engine's
# lock and engine/scripts/build_sidecar.sh. The Team checkout is found as build-ci.sh finds it
# (TEAM_DIR, ../breakpatch-team, ../moravision-team) and mounted read-only as well.
#
# Environment:
#   MANYLINUX_IMAGE  the image (default quay.io/pypa/manylinux_2_28_<arch>). For a release, pin it
#                    by digest: quay.io/pypa/manylinux_2_28_x86_64@sha256:… (release.yml reads it
#                    from the repository variables MANYLINUX_X64_IMAGE and MANYLINUX_ARM64_IMAGE)
#   DOCKER           docker (default) or podman
#   TEAM_DIR, BREAKPATCH_LICENCE_URL, SOURCE_DATE_EPOCH   passed on to build-ci.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
parent=$(dirname "$repo")
die() { echo "build-manylinux: $*" >&2; exit 1; }
say() { echo "build-manylinux: $*"; }
usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; }

what=${1:-}
[ $# -eq 0 ] || shift
case "$what" in
  ci | sidecar) ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

# shellcheck source=scripts/platform.sh
. "$repo/scripts/platform.sh"
platform=$(bp_platform "$(uname -s)" "$(uname -m)") || die "this is $(uname -s) $(uname -m); run it on Linux x86_64 or arm64"
case "$platform" in
  linux-x86_64) arch=x86_64 ;;
  linux-arm64) arch=aarch64 ;;
  *) die "manylinux containers are for Linux; this is $platform" ;;
esac
image=${MANYLINUX_IMAGE:-quay.io/pypa/manylinux_2_28_$arch}
docker=${DOCKER:-docker}
command -v "$docker" >/dev/null 2>&1 || die "$docker not found; install Docker (or set DOCKER=podman)"
"$docker" info >/dev/null 2>&1 || die "$docker can't reach its daemon; start it, or run as a user who can"

release=0
out=""
args=()
inputs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a folder"; out=$2; shift 2 ;;
    --release) release=1; args+=("$1"); shift ;;
    --keys-file | --engine-wheel)
      # Files the container must see: mounted next to the output.
      if [ $# -lt 2 ] || [ ! -f "$2" ]; then die "$1 needs a file"; fi
      args+=("$1" "/in/$(basename "$2")"); inputs+=("$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[ "$what" = ci ] || [ ${#args[@]} -eq 0 ] || die "sidecar takes --out only"
if [ "$release" -eq 1 ] && [[ "$image" != *@sha256:* ]]; then
  echo "build-manylinux: WARNING: $image isn't pinned by digest; a release should name quay.io/pypa/manylinux_2_28_$arch@sha256:…" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$image isn't pinned by digest (set the repository variable)"; fi
fi
out=${out:-"$repo/dist/$([ "$what" = ci ] && echo ci || echo sidecar)"}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# The Team checkout (ci only), as build-ci.sh looks for it.
team=""
if [ "$what" = ci ]; then
  if [ -n "${TEAM_DIR:-}" ]; then
    case "$TEAM_DIR" in /*) team="$TEAM_DIR" ;; *) team="$parent/$TEAM_DIR" ;; esac
  elif [ -d "$parent/breakpatch-team" ]; then team="$parent/breakpatch-team"
  elif [ -d "$parent/moravision-team" ]; then team="$parent/moravision-team"
  fi
  if [ -z "$team" ] || [ ! -f "$team/engine/scripts/build_ci_wheel.sh" ]; then
    die "the Team checkout wasn't found (TEAM_DIR, ../breakpatch-team or ../moravision-team)"
  fi
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/bp-manylinux.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/in" "$stage/work"
for f in ${inputs[@]+"${inputs[@]}"}; do cp "$f" "$stage/in/"; done

# What runs in the container. The checkouts are copied out of their read-only mounts, without
# venvs, node_modules, Rust targets or build output. The build venv and the copies are in a
# temporary folder of this machine's (mounted at /work), deleted afterwards.
cat > "$stage/inside.sh" <<'SH'
set -euo pipefail
copy() {   # <from> <to>
  mkdir -p "$2"
  (cd "$1" && tar cf - --exclude ./.git --exclude .venv --exclude node_modules --exclude ./app/src-tauri/target \
     --exclude ./dist --exclude __pycache__ --exclude '*.egg-info' --exclude ./build .) | (cd "$2" && tar xf -)
}
copy /src/breakpatch /work/breakpatch
if [ -d /src/breakpatch-team ]; then copy /src/breakpatch-team /work/breakpatch-team; fi
export PYTHON=/opt/python/cp311-cp311/bin/python3.11 VENV=/work/venv PIP_DISABLE_PIP_VERSION_CHECK=1
echo "build-manylinux: in $(cat /etc/redhat-release 2>/dev/null || uname -a), glibc $(ldd --version | head -n 1 | awk '{ print $NF }'), AUDITWHEEL_PLAT=${AUDITWHEEL_PLAT:-unset}"
cd /work/breakpatch
if [ "$BP_WHAT" = ci ]; then
  TEAM_DIR=/work/breakpatch-team bash scripts/build-ci.sh --deps-only
  TEAM_DIR=/work/breakpatch-team bash scripts/build-ci.sh --no-deps --out /out "$@"
else
  "$PYTHON" -m venv "$VENV"
  arch=$(uname -m); plat=linux-$([ "$arch" = aarch64 ] && echo arm64 || echo "$arch")
  "$VENV/bin/python" -m pip install -q --require-hashes -r engine/locks/build.txt
  "$VENV/bin/python" -m pip install -q --require-hashes --no-build-isolation -r "engine/locks/$plat.dev.txt"
  "$VENV/bin/python" -m pip install -q --no-deps --no-build-isolation -e engine
  "$VENV/bin/python" -m pip check
  BP_TARGET_TRIPLE="$arch-unknown-linux-gnu" PYTHON="$VENV/bin/python" sh engine/scripts/build_sidecar.sh --out /out
fi
SH

mounts=(-v "$repo:/src/breakpatch:ro" -v "$out:/out" -v "$stage/in:/in:ro" -v "$stage/inside.sh:/inside.sh:ro"
        -v "$stage/work:/work")
if [ -n "$team" ]; then mounts+=(-v "$team:/src/breakpatch-team:ro"); fi
envs=(-e "BP_WHAT=$what")
for v in BREAKPATCH_LICENCE_URL SOURCE_DATE_EPOCH CI GITHUB_ACTIONS; do
  if [ -n "${!v:-}" ]; then envs+=(-e "$v=${!v}"); fi
done

say "building $what for $platform in $image"
# As this user, so what lands in --out is theirs (HOME is somewhere the user can write).
"$docker" run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -w /work "${mounts[@]}" "${envs[@]}" \
  "$image" bash /inside.sh ${args[@]+"${args[@]}"}
say "done: wrote to $out:"
find "$out" -maxdepth 1 -type f -newer "$stage/inside.sh" -exec basename {} \;
