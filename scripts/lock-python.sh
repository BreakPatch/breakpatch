#!/usr/bin/env bash
# Writes the hashed Python lock files in engine/locks/ from engine/pyproject.toml, with uv
# (https://docs.astral.sh/uv/; `pipx install uv` or `brew install uv`). Security review S3: CI and
# scripts/build-release.sh install the engine's dependencies only from these files, with
# `pip install --require-hashes`, so a changed or replaced package on PyPI fails the install.
#
#   scripts/lock-python.sh            # all lock files
#   scripts/lock-python.sh --upgrade  # also move every package to its newest allowed version
#
# Run it after changing dependencies in engine/pyproject.toml, and commit engine/locks/.
#
# Files (one per platform and set of extras, the extras sorted and joined with "-"):
#   build.txt                            pip, setuptools, wheel: installed first, so the locked
#                                        packages build (Nuitka is a source release) without pip
#                                        fetching unhashed build tools (--no-build-isolation)
#   linux-x86_64.<extras>.txt            CI (ubuntu, Python 3.11): dev, dev-hardening
#   macos-arm64.<extras>.txt             Apple Silicon, macOS 14+: dev, dev-hardening, dev-mlx,
#                                        dev-hardening-mlx (the release build)
#   linux-arm64.<extras>.txt             Linux on arm64 (Raspberry Pi, ubuntu-24.04-arm): dev,
#                                        dev-hardening
#   windows-x86_64.<extras>.txt          Windows x64: dev, dev-hardening
# Every file also has the `ci` extra (cryptography, for breakpatch-ci's encrypted workspaces), so
# the names don't list it; scripts/ci-requirements.py takes it from whichever lock it's given.
# Platforms are named the same everywhere (build-release.sh, build-ci.sh, the release's
# breakpatch-ci-requirements-<platform>.txt): <os>-<arch>, with arm64 and x86_64.
# A lock file that doesn't exist yet starts from its sibling's pins (the linux-x86_64 file of the
# same extras), so a new platform gets the versions the others have, not the newest ones.
# The engine itself is installed after the lock, with --no-deps (it isn't in the lock), and
# `pip check` then fails if the lock misses something pyproject.toml asks for.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
engine="$repo/engine"
locks="$engine/locks"
python_version=3.11
upgrade=()
case "${1:-}" in
  --upgrade) upgrade=(--upgrade) ;;
  "") ;;
  *) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

command -v uv >/dev/null || { echo "lock-python: uv not found (pipx install uv, or brew install uv)" >&2; exit 1; }
mkdir -p "$locks"

compile() {   # <output> <platform> <extras...>
  local out=$1 platform=$2; shift 2
  local extra_args=(--extra ci) seed
  for e in "$@"; do extra_args+=(--extra "$e"); done
  seed="$locks/linux-x86_64.$(basename "$out" | cut -d. -f2-)"
  if [ ! -f "$out" ] && [ -f "$seed" ] && [ "$seed" != "$out" ]; then
    # uv keeps the pins of an existing output file: start from the x86_64 ones.
    echo "lock-python: $(basename "$out") starts from $(basename "$seed")'s pins"
    cp "$seed" "$out"
  fi
  echo "lock-python: $(basename "$out")"
  # macOS 14 is the oldest the app supports; mlx has no macOS 13 wheels.
  (cd "$repo" && MACOSX_DEPLOYMENT_TARGET=14.0 uv pip compile --quiet engine/pyproject.toml \
    ${extra_args[@]+"${extra_args[@]}"} --constraint "engine/locks/build.txt" \
    --generate-hashes --python-version "$python_version" --python-platform "$platform" \
    --custom-compile-command "scripts/lock-python.sh" ${upgrade[@]+"${upgrade[@]}"} \
    --output-file "engine/locks/$(basename "$out")")
}

printf '# Build tools for the locked packages (scripts/lock-python.sh writes build.txt from this)\npip\nsetuptools>=68\nwheel\n' > "$locks/build.in"
echo "lock-python: build.txt"
(cd "$repo" && uv pip compile --quiet engine/locks/build.in --generate-hashes --python-version "$python_version" \
  --custom-compile-command "scripts/lock-python.sh" ${upgrade[@]+"${upgrade[@]}"} --output-file engine/locks/build.txt)

compile "$locks/linux-x86_64.dev.txt"                x86_64-unknown-linux-gnu dev
compile "$locks/linux-x86_64.dev-hardening.txt"      x86_64-unknown-linux-gnu dev hardening
compile "$locks/macos-arm64.dev.txt"                 aarch64-apple-darwin     dev
compile "$locks/macos-arm64.dev-hardening.txt"       aarch64-apple-darwin     dev hardening
compile "$locks/macos-arm64.dev-mlx.txt"             aarch64-apple-darwin     dev mlx
compile "$locks/macos-arm64.dev-hardening-mlx.txt"   aarch64-apple-darwin     dev hardening mlx
compile "$locks/linux-arm64.dev.txt"                 aarch64-manylinux_2_28   dev
compile "$locks/linux-arm64.dev-hardening.txt"       aarch64-manylinux_2_28   dev hardening
compile "$locks/windows-x86_64.dev.txt"              x86_64-pc-windows-msvc   dev
compile "$locks/windows-x86_64.dev-hardening.txt"    x86_64-pc-windows-msvc   dev hardening
echo "lock-python: done; commit engine/locks/"
