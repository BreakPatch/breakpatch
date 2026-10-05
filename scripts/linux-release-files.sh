#!/usr/bin/env bash
# Checks the Linux desktop bundles that scripts/build-release.sh --bundles deb,appimage built, and
# copies them into OUT with the names the release uses (.github/workflows/release.yml):
#
#   scripts/linux-release-files.sh [--release] [--url BASE] --version V BUNDLE_DIR OUT
#
#   BUNDLE_DIR   app/src-tauri/target/release/bundle (Tauri's deb/ and appimage/ folders)
#   OUT          gets Breakpatch_amd64.AppImage (the name the install command and the updater
#                use, whatever the version), breakpatch_<V>_amd64.deb, their .sig files when the
#                build had the updater key, SHA256SUMS of those, and latest-linux.json: the updater's
#                Linux entries (linux-x86_64 and linux-x86_64-appimage for the AppImage,
#                linux-x86_64-deb for the .deb), with BASE + file name as their address. The release
#                workflow merges them into the release's latest.json. Without .sig files it's {}.
#   --release    the .sig files must be there, and so must --url.
#
# What it checks, so a broken bundle never reaches a release:
#   - one .deb and one AppImage, of version V;
#   - the .deb: package breakpatch, its dependencies (WebKitGTK 4.1, xdg-utils, desktop-file-utils),
#     the app, the engine sidecar, the desktop entry and the .bpworkspace type
#     (/usr/share/mime/packages/breakpatch.xml);
#   - the desktop entry (desktop-file-validate when it's installed): it passes links and files on
#     (Exec=breakpatch %u) and lists x-scheme-handler/breakpatch and application/x-breakpatch-workspace;
#   - no binary needs a glibc newer than BP_GLIBC_MAX (default 2.35, Ubuntu 22.04's: the release
#     builds in an Ubuntu 22.04 container), so the app starts on 22.04, Debian 12 and later;
#   - the AppImage unpacks (its own --appimage-extract, no FUSE needed) and holds the app.
# Needs dpkg-deb, objdump (binutils) and sha256sum.
set -euo pipefail

die() { echo "linux-release-files: $*" >&2; exit 1; }
say() { echo "linux-release-files: $*"; }

release=0 url="" version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) release=1; shift ;;
    --url) [ $# -ge 2 ] || die "--url needs an address"; url=$2; shift 2 ;;
    --version) [ $# -ge 2 ] || die "--version needs a version"; version=$2; shift 2 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: $0 [--release] [--url BASE] --version V BUNDLE_DIR OUT"
[ -d "$1" ] || die "$1 isn't a folder"
bundle=$(cd "$1" && pwd) out=$2
[ -n "$version" ] || die "--version is needed"
if [ "$release" -eq 1 ] && [ -z "$url" ]; then die "--release needs --url"; fi
case "$url" in '' | https://*/) ;; *) die "--url must be an https address ending in /" ;; esac
for t in dpkg-deb objdump sha256sum; do command -v "$t" >/dev/null || die "$t not found"; done
glibc_max=${BP_GLIBC_MAX:-2.35}

one() {   # <what> <files…>: exactly one existing file
  local what=$1; shift
  if [ $# -ne 1 ] || [ ! -f "$1" ]; then die "expected one $what in $bundle, found: $*"; fi
  printf '%s' "$1"
}
shopt -s nullglob
deb=$(one ".deb" "$bundle"/deb/*.deb)
appimage=$(one "AppImage" "$bundle"/appimage/*.AppImage)
shopt -u nullglob
[[ "$(basename "$appimage")" == *"_${version}_amd64.AppImage" ]] || die "$(basename "$appimage") isn't version $version for amd64"

work=$(mktemp -d "${TMPDIR:-/tmp}/bp-linux-files.XXXXXX")
trap 'rm -rf "$work"' EXIT

# ---- the .deb
field() { dpkg-deb -f "$deb" "$1"; }
[ "$(field Package)" = breakpatch ] || die "the .deb's package is $(field Package), not breakpatch"
[ "$(field Version)" = "$version" ] || die "the .deb is version $(field Version), not $version"
[ "$(field Architecture)" = amd64 ] || die "the .deb is for $(field Architecture), not amd64"
depends=$(field Depends)
for d in libwebkit2gtk-4.1-0 xdg-utils desktop-file-utils; do
  [[ ", $depends," == *", $d"[\ ,]* ]] || die "the .deb doesn't depend on $d (Depends: $depends)"
done
dpkg-deb -x "$deb" "$work/deb"
for f in usr/bin/breakpatch usr/bin/breakpatch-engine usr/share/mime/packages/breakpatch.xml; do
  [ -f "$work/deb/$f" ] || die "the .deb has no /$f"
done
entries=("$work"/deb/usr/share/applications/*.desktop)
if [ ${#entries[@]} -ne 1 ] || [ ! -f "${entries[0]}" ]; then die "the .deb has ${#entries[@]} desktop entries, not one"; fi

check_entry() {   # <desktop entry> <what> <exec>
  local e=$1 what=$2 exec=$3 mime
  grep -qx "Exec=$exec %u" "$e" || die "$what: Exec isn't '$exec %u': $(grep '^Exec=' "$e" || echo none)"
  mime=$(sed -n 's/^MimeType=//p' "$e")
  for m in x-scheme-handler/breakpatch application/x-breakpatch-workspace; do
    [[ ";$mime;" == *";$m;"* ]] || die "$what: MimeType doesn't list $m: '$mime'"
  done
  if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$e" || die "$what doesn't pass desktop-file-validate"; fi
}
check_entry "${entries[0]}" "the .deb's desktop entry" breakpatch
say "$(basename "$deb"): package, dependencies, files and desktop entry"

# ---- glibc: the newest GLIBC_x.y symbol version each binary needs
newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" != "$2" ]; }   # $1 newer than $2?
for bin in "$work/deb/usr/bin/breakpatch" "$work/deb/usr/bin/breakpatch-engine"; do
  need=$(objdump -T "$bin" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n 1)
  [ -n "$need" ] || die "couldn't read the glibc versions $(basename "$bin") needs"
  if newer "$need" "$glibc_max"; then
    die "$(basename "$bin") needs glibc $need, newer than $glibc_max: build it on Ubuntu 22.04 (the release's container), or it won't start there"
  fi
  say "$(basename "$bin") needs glibc $need (at most $glibc_max)"
done

# ---- the AppImage
chmod +x "$appimage"
(cd "$work" && "$appimage" --appimage-extract >/dev/null) || die "$(basename "$appimage") doesn't unpack (--appimage-extract)"
[ -x "$work/squashfs-root/usr/bin/breakpatch" ] || die "the AppImage has no usr/bin/breakpatch"
[ -x "$work/squashfs-root/usr/bin/breakpatch-engine" ] || die "the AppImage has no engine sidecar"
[ -f "$work/squashfs-root/usr/share/icons/hicolor/128x128/apps/breakpatch.png" ] \
  || die "the AppImage has no 128x128 icon (site/install puts it in the apps menu)"
# Not byte for byte the .deb's app: Tauri writes the bundle type (deb, appimage) into each copy,
# for the updater.
grep -aq '__TAURI_BUNDLE_TYPE_VAR_APP' "$work/squashfs-root/usr/bin/breakpatch" \
  || die "the AppImage's app isn't marked as an AppImage, so its updater can't update it"
grep -aq '__TAURI_BUNDLE_TYPE_VAR_DEB' "$work/deb/usr/bin/breakpatch" \
  || die "the .deb's app isn't marked as a .deb, so its updater can't update it"
say "$(basename "$appimage") unpacks and holds the app, marked as an AppImage"

# ---- the release files
mkdir -p "$out"
deb_name="breakpatch_${version}_amd64.deb"
cp "$appimage" "$out/Breakpatch_amd64.AppImage"
cp "$deb" "$out/$deb_name"
signed=()
for pair in "$appimage.sig:Breakpatch_amd64.AppImage.sig" "$deb.sig:$deb_name.sig"; do
  if [ -f "${pair%%:*}" ]; then cp "${pair%%:*}" "$out/${pair#*:}"; signed+=("${pair#*:}"); fi
done
if [ "$release" -eq 1 ] && [ ${#signed[@]} -ne 2 ]; then
  die "--release: the updater .sig files are missing (only: ${signed[*]:-none}). Was TAURI_SIGNING_PRIVATE_KEY set?"
fi
(cd "$out" && sha256sum -- Breakpatch_amd64.AppImage* "$deb_name"* > SHA256SUMS)

# The updater picks linux-x86_64-<bundle> first (deb for a .deb install, appimage for an AppImage),
# then linux-x86_64.
sig() { if [ -f "$1" ]; then cat "$1"; fi; }
SIG_APPIMAGE=$(sig "$out/Breakpatch_amd64.AppImage.sig") SIG_DEB=$(sig "$out/$deb_name.sig") \
URL="$url" DEB="$deb_name" python3 - "$out/latest-linux.json" <<'PY'
import json, os, sys
e = os.environ
platforms = {}
if e["SIG_APPIMAGE"]:
    a = {"signature": e["SIG_APPIMAGE"], "url": e["URL"] + "Breakpatch_amd64.AppImage"}
    platforms["linux-x86_64"] = a
    platforms["linux-x86_64-appimage"] = a
if e["SIG_DEB"]:
    platforms["linux-x86_64-deb"] = {"signature": e["SIG_DEB"], "url": e["URL"] + e["DEB"]}
with open(sys.argv[1], "w") as f:
    json.dump(platforms, f, indent=2)
    f.write("\n")
PY
say "wrote to $out:"
(cd "$out" && ls -l)
cat "$out/SHA256SUMS"
