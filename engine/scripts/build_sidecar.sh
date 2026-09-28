#!/bin/sh
# Builds the engine sidecar as one executable for the Tauri app:
#   app/src-tauri/binaries/breakpatch-engine-<target-triple>
# The triple comes from `rustc -vV` (Tauri's externalBin naming). Chromium is NOT bundled:
# setup installs it on first launch (`setup.installBrowser`). The Playwright driver is bundled.
# On Apple Silicon, mlx / mlx-vlm are bundled when they're installed in the venv (`pip install -e '.[mlx]'`).
# The Breakpatch Team engine (breakpatch_team_engine: healing) is bundled when it's installed in the
# venv (`pip install -e ../breakpatch-team/engine`); without it the sidecar is the Community edition.
#
# Packagers (SIDECAR_COMPILER, or --compiler):
#   pyinstaller  (default) One PyInstaller --onefile executable, as releases have always shipped.
#                Proven with Playwright's driver and mlx / mlx-vlm. For a Team build the paid
#                package breakpatch_team_engine is first compiled to a native extension with
#                Nuitka (see "Team hardening" below) and that .so is bundled instead of its
#                source, so no .py or .pyc of it ships. Community bundles plain.
#   nuitka       Compile the WHOLE sidecar with Nuitka (--standalone --onefile). Maximal
#                deterrence (the open engine is compiled too) but slower to build and, today,
#                Nuitka can't package Playwright's driver cleanly (it double-claims
#                playwright/driver/node as both an executable and a data file) and compiling
#                mlx-vlm / transformers on the macOS runner is slow and fragile. So this is
#                opt-in; PyInstaller is the shipping default. See src-tauri/README.md "Hardening".
#
# Team hardening (release hardening of the Team build, docs/editions.md): for a Team build the
# paid package is turned into native code before packaging, so a shipped .app carries no readable
# .py/.pyc of breakpatch_team_engine (its compiled-in _keys.py included). With the pyinstaller
# packager this is a Nuitka `--module` compile of the installed package into one .so, swapped into
# the venv for the build and put back afterwards; with the nuitka packager the whole program
# (breakpatch_team_engine included) is compiled, so it happens anyway. This is deterrence, not
# protection: Nuitka keeps docstrings and names as readable strings, and the licence check is the
# real gate (docs/editions.md "Licence"). Set BP_NO_HARDEN=1 to skip it (a plain PyInstaller build
# that ships the Team source; for local debugging only, never a release).
#
#   engine/scripts/build_sidecar.sh              # uses engine/.venv
#   engine/scripts/build_sidecar.sh --out DIR    # write somewhere else (e.g. to try a build)
#   engine/scripts/build_sidecar.sh --compiler nuitka
#   PYTHON=/path/to/python engine/scripts/build_sidecar.sh
#   SIDECAR_COMPILER=nuitka engine/scripts/build_sidecar.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
engine_dir=$(dirname "$here")
repo_dir=$(dirname "$engine_dir")
out_dir="$repo_dir/app/src-tauri/binaries"
PYTHON=${PYTHON:-"$engine_dir/.venv/bin/python"}
compiler=${SIDECAR_COMPILER:-pyinstaller}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) out_dir=$2; shift 2 ;;
    --compiler) compiler=$2; shift 2 ;;
    --compiler=*) compiler=${1#*=}; shift ;;
    *) echo "usage: $0 [--out DIR] [--compiler pyinstaller|nuitka]" >&2; exit 2 ;;
  esac
done
case "$compiler" in
  pyinstaller|nuitka) ;;
  *) echo "build_sidecar: --compiler must be pyinstaller or nuitka, not '$compiler'" >&2; exit 2 ;;
esac

triple=$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')
if [ -z "$triple" ]; then
  echo "build_sidecar: rustc not found; install Rust from https://rustup.rs" >&2
  exit 1
fi
if [ ! -x "$PYTHON" ]; then
  echo "build_sidecar: $PYTHON not found. Create it: cd engine && python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]'" >&2
  exit 1
fi

name="breakpatch-engine-$triple"
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-sidecar.XXXXXX")

# Team hardening state (see harden_team_module): the compiled package swapped into the venv is
# put back on exit, whether the build worked or not.
team_pkg_dir=""       # the package's directory in site-packages, once moved aside
team_pkg_backup=""    # where its source was moved to
team_pkg_so=""        # the .so dropped in, to remove on restore
restore_team_module() {
  [ -n "$team_pkg_backup" ] || return 0
  [ -n "$team_pkg_so" ] && rm -f "$team_pkg_so" 2>/dev/null || true
  if [ -d "$team_pkg_backup" ] && [ ! -e "$team_pkg_dir" ]; then
    mv "$team_pkg_backup" "$team_pkg_dir" && echo "build_sidecar: put the Team engine source back in the venv"
  fi
  team_pkg_backup=""
}
trap 'restore_team_module; rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

team_installed() { "$PYTHON" -c "import breakpatch_team_engine" 2>/dev/null; }
team_is_source() { "$PYTHON" -c "import breakpatch_team_engine as t, sys; sys.exit(0 if t.__file__.endswith('.py') else 1)" 2>/dev/null; }
have_nuitka() { "$PYTHON" -c "import nuitka" 2>/dev/null; }

# Compile the installed breakpatch_team_engine to one native extension (.so) with Nuitka and swap
# it into the venv in place of its source, so the packager bundles native code. Nuitka's `--module`
# builds the whole package (submodules and the generated _keys.py) into a single stripped .so.
harden_team_module() {
  have_nuitka || {
    echo "build_sidecar: Nuitka is needed to compile the Team engine to native code, but it isn't in $PYTHON." >&2
    echo "build_sidecar: install it ($PYTHON -m pip install nuitka), or set BP_NO_HARDEN=1 to ship the Team source (debug only)." >&2
    exit 1
  }
  team_pkg_dir=$("$PYTHON" -c "import breakpatch_team_engine as t, os; print(os.path.dirname(t.__file__))")
  sp=$(dirname "$team_pkg_dir")
  echo "build_sidecar: compiling breakpatch_team_engine to native code (Nuitka --module)"
  # ccache, when present, is picked up by Nuitka automatically and makes re-builds much faster.
  # No --assume-yes-for-downloads (security review S2): this runs in the release's signing step,
  # so Nuitka mustn't fetch anything here. scripts/build-release.sh --deps-only lets it download
  # what it needs beforehand; if it still wants something, it fails here (stdin is closed).
  "$PYTHON" -m nuitka --module "$team_pkg_dir" --include-package=breakpatch_team_engine \
    --output-dir="$work/team-so" --remove-output </dev/null >"$work/team-nuitka.log" 2>&1 || {
      echo "build_sidecar: Nuitka couldn't compile breakpatch_team_engine:" >&2; tail -20 "$work/team-nuitka.log" >&2; exit 1; }
  so=$(ls "$work"/team-so/breakpatch_team_engine*.so 2>/dev/null | head -1)
  [ -n "$so" ] || { echo "build_sidecar: Nuitka didn't write a breakpatch_team_engine .so" >&2; exit 1; }
  team_pkg_backup="$work/team-src-backup"
  mv "$team_pkg_dir" "$team_pkg_backup"
  team_pkg_so="$sp/$(basename "$so")"
  cp "$so" "$team_pkg_so"
  # It must still import and still carry the compiled-in licence keys.
  "$PYTHON" -c "from breakpatch_engine import plugins; assert plugins.edition()=='team', plugins.edition(); from breakpatch_team_engine import licence; assert licence.compiled_keys(), 'no keys in the compiled module'" \
    || { echo "build_sidecar: the compiled Team engine doesn't load or lost its licence keys" >&2; exit 1; }
  echo "build_sidecar: bundling native breakpatch_team_engine ($(du -h "$team_pkg_so" | cut -f1)); no .py/.pyc of it will ship"
}

cat > "$work/entry.py" <<'PY'
from breakpatch_engine.cli import main

raise SystemExit(main())
PY

team_hidden="--hidden-import breakpatch_team_engine --collect-submodules breakpatch_team_engine"
if team_installed; then
  if [ "${BP_NO_HARDEN:-0}" = 1 ]; then
    echo "build_sidecar: WARNING: BP_NO_HARDEN=1, shipping the Team engine as source (.pyc). Debug only, never a release." >&2
  elif team_is_source; then
    harden_team_module
    # The package is now a single extension module: include it by name, don't walk it for submodules.
    team_hidden="--hidden-import breakpatch_team_engine"
  else
    echo "build_sidecar: breakpatch_team_engine is already compiled (not source); bundling as is"
    team_hidden="--hidden-import breakpatch_team_engine"
  fi
fi

# ---------------------------------------------------------------- nuitka: whole-sidecar compile

if [ "$compiler" = nuitka ]; then
  have_nuitka || { echo "build_sidecar: --compiler nuitka needs Nuitka: $PYTHON -m pip install 'nuitka[onefile]'" >&2; exit 1; }
  echo "build_sidecar: compiling the whole sidecar with Nuitka (--standalone --onefile)"
  mlx_flags=""
  if "$PYTHON" -c "import mlx_vlm" 2>/dev/null; then
    echo "build_sidecar: including mlx / mlx-vlm (may be slow; if Nuitka can't compile a dependency, use the pyinstaller packager)"
    mlx_flags="--include-package=mlx --include-package=mlx_vlm --include-package=transformers --include-package=tokenizers"
  else
    echo "build_sidecar: mlx-vlm not installed; this build has no AI assistant (fine for CI and Linux)"
  fi
  # A stable, versioned extraction dir so only the first launch pays the unpack cost.
  ver=$("$PYTHON" -c "import breakpatch_engine as e; print(e.__version__)")
  # shellcheck disable=SC2086
  "$PYTHON" -m nuitka --standalone --onefile \
    --output-dir="$work/nuitka" --output-filename="$name" \
    --onefile-tempdir-spec="{CACHE_DIR}/breakpatch-engine/$ver" \
    --include-package=breakpatch_team_engine \
    --include-package-data=breakpatch_engine \
    --include-module=scipy.fftpack \
    --include-package=imagehash \
    --nofollow-import-to=tkinter --nofollow-import-to=matplotlib --nofollow-import-to=pytest \
    --assume-yes-for-downloads --remove-output \
    $mlx_flags \
    "$work/entry.py"
  mkdir -p "$out_dir"
  cp "$work/nuitka/$name" "$out_dir/$name"
  chmod +x "$out_dir/$name"
  "$out_dir/$name" --version >/dev/null
  echo "build_sidecar: wrote $out_dir/$name ($(du -h "$out_dir/$name" | cut -f1), Nuitka)"
  exit 0
fi

# ---------------------------------------------------------------- pyinstaller (default)

"$PYTHON" -c "import PyInstaller" 2>/dev/null || { echo "build_sidecar: PyInstaller missing: $PYTHON -m pip install -e '${engine_dir}[dev]'" >&2; exit 1; }

extra=""
if "$PYTHON" -c "import mlx_vlm" 2>/dev/null; then
  echo "build_sidecar: bundling mlx-vlm (AI assistant)"
  extra="--collect-all mlx --collect-all mlx_vlm --collect-all transformers --collect-all tokenizers"
else
  echo "build_sidecar: mlx-vlm not installed; this build has no AI assistant (fine for CI and Linux)"
fi

if team_installed; then
  echo "build_sidecar: bundling the Breakpatch Team engine"
  # plugins.py imports it by name at run time, so PyInstaller can't see it without help.
  extra="$extra $team_hidden"
else
  echo "build_sidecar: Breakpatch Team engine not installed; this is a Community build"
fi

# shellcheck disable=SC2086
"$PYTHON" -m PyInstaller --noconfirm --clean --onefile --console \
  --name "$name" \
  --distpath "$work/dist" --workpath "$work/build" --specpath "$work" \
  --collect-data breakpatch_engine \
  --collect-data playwright \
  --collect-submodules imagehash \
  --hidden-import scipy.fftpack \
  --exclude-module tkinter --exclude-module matplotlib --exclude-module pytest \
  $extra \
  "$work/entry.py"

mkdir -p "$out_dir"
cp "$work/dist/$name" "$out_dir/$name"
chmod +x "$out_dir/$name"

# Smoke test: the binary starts and reports its version.
"$out_dir/$name" --version >/dev/null
echo "build_sidecar: wrote $out_dir/$name ($(du -h "$out_dir/$name" | cut -f1))"
