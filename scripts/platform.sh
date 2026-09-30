# shellcheck shell=sh
# Platform names for the build scripts (sourced by build-release.sh, build-ci.sh and
# build-manylinux.sh; site/install-ci and site/install-ci.ps1 carry their own copy, since they're
# downloaded on their own). One scheme everywhere, as engine/locks/ and the release's
# breakpatch-ci-requirements-<platform>.txt use it: <os>-<arch>, os one of linux, macos, windows,
# arch one of x86_64, arm64.

# bp_platform [OS ARCH]: the platform of `uname -s` and `uname -m` (or the two given), or nothing
# (exit 1) for one Breakpatch doesn't build for.
bp_platform() {
  _os=${1:-$(uname -s)}
  _arch=${2:-$(uname -m)}
  case "$_os-$_arch" in
    Linux-x86_64 | Linux-amd64) echo linux-x86_64 ;;
    Linux-aarch64 | Linux-arm64) echo linux-arm64 ;;
    Darwin-arm64) echo macos-arm64 ;;
    MINGW64_NT*-x86_64 | MSYS_NT*-x86_64 | CYGWIN_NT*-x86_64) echo windows-x86_64 ;;
    *) return 1 ;;
  esac
}

# venv_python VENV: the Python inside a virtual environment (Scripts/python.exe on Windows).
venv_python() {
  if [ -x "$1/Scripts/python.exe" ] || { [ ! -e "$1/bin/python" ] && is_windows; }; then
    echo "$1/Scripts/python.exe"
  else
    echo "$1/bin/python"
  fi
}

# is_windows: Git Bash, MSYS2 or Cygwin.
is_windows() {
  case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) return 0 ;; esac
  return 1
}
