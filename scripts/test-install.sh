#!/usr/bin/env bash
# Tests the install command (site/install, served at https://breakpatch.dev/install) on Linux.
#
#   scripts/test-install.sh
#
# It serves fake releases from this machine over https (GitHub API JSON plus a .app.tar.gz
# holding a dummy Breakpatch.app, its .sig and SHA256SUMS; a throwaway certificate that curl is
# told to trust), stands in for the macOS-only commands with small scripts on PATH (uname,
# sw_vers, sysctl, osascript, open, xattr, codesign, and id so the tests don't run as root), and
# runs the installer with /bin/sh and with bash --posix (macOS runs sh as bash). It also lints
# it with shellcheck, installing shellcheck with apt when it's missing. Needs python3, node,
# curl, tar, shasum and openssl.
#
# The Linux desktop app (a preview) installs on Linux x86_64: the fake releases carry a stand-in
# AppImage, and getconf (glibc), dpkg-query (a .deb install), pgrep, fusermount and the desktop
# database tools are small scripts too.
#
# The private beta (BREAKPATCH_GITHUB_TOKEN) runs against a stand-in for api.github.com and
# objects.githubusercontent.com: one https server that answers for both names (the certificate
# has them), which curl reaches through connect-to lines in the test home's .curlrc. So the
# installer uses its real default address, GitHub's asset redirect goes to another host as it
# does for real, and the server log shows which host got the Authorization header.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
script="$repo/site/install"
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-test-install.XXXXXX")
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

pass=0
failures=()
ok() { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { failures+=("$current: $1"); printf '  FAIL  %s\n' "$1"; }

# ---------------------------------------------------------------- shellcheck

if ! command -v shellcheck >/dev/null; then
  echo "installing shellcheck"
  if [ "$(id -u)" -eq 0 ]; then apt-get install -y -qq shellcheck >/dev/null; else sudo apt-get install -y -qq shellcheck >/dev/null; fi
fi
echo "shellcheck site/install"
shellcheck "$script"

# ---------------------------------------------------------------- fake releases

free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
port=$(free_port)
http_port=$(free_port)
srv="$work/srv"
base="https://127.0.0.1:$port"

# A throwaway certificate for the https test server, which curl trusts through CURL_CA_BUNDLE.
tls="$work/tls"
mkdir -p "$tls"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tls/key.pem" -out "$tls/cert.pem" -days 2 \
  -subj /CN=127.0.0.1 \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:api.github.com,DNS:objects.githubusercontent.com" >/dev/null 2>&1
# The app's code signing certificates, as `codesign --extract-certificates` writes them (DER):
# Breakpatch's (the committed one), and another.
cp "$repo/app/src-tauri/signing/breakpatch-codesign.cer" "$tls/breakpatch.cer"
openssl x509 -in "$tls/cert.pem" -outform der -out "$tls/other.cer"
chmod 755 "$tls"
chmod 644 "$tls"/*

# $1 dir, $2 version: a dummy Breakpatch.app with an Info.plist like Tauri's.
make_app() {
  mkdir -p "$1/Breakpatch.app/Contents/MacOS"
  cat > "$1/Breakpatch.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>dev.breakpatch.app</string>
	<key>CFBundleShortVersionString</key>
	<string>$2</string>
</dict>
</plist>
EOF
  printf '#!/bin/sh\necho %s\n' "$2" > "$1/Breakpatch.app/Contents/MacOS/breakpatch"
  chmod +x "$1/Breakpatch.app/Contents/MacOS/breakpatch"
}

# $1 file, $2 version: a stand-in for the Linux AppImage. Started, it logs "started <version>";
# --appimage-extract PATTERN unpacks the icon into ./squashfs-root, as the real one does.
make_appimage() {
  cat > "$1" <<EOF
#!/bin/sh
if [ "\$1" = --appimage-extract ]; then
  mkdir -p squashfs-root/usr/share/icons/hicolor/128x128/apps
  echo "icon $2" > squashfs-root/usr/share/icons/hicolor/128x128/apps/breakpatch.png
  exit 0
fi
echo "started $2 \$*" >> "\$FAKE_STATE/log"
EOF
}

# $1 API root name, $2 version, then options: latest (also releases/latest), bad-sum, no-sums,
# foreign (the files are listed on another host), dotdot (listed with ../ in their address),
# prerelease, draft, mac-only (no Linux AppImage).
make_release() {
  local api=$1 version=$2 tag="v$2" latest=0 badsum=0 nosums=0 pre=0 draft=0 linux=1 dl stage url
  shift 2
  url="$base/$api/download/$tag"
  for o in "$@"; do
    case "$o" in
      latest) latest=1 ;; bad-sum) badsum=1 ;; no-sums) nosums=1 ;; prerelease) pre=1 ;; draft) draft=1 ;;
      mac-only) linux=0 ;;
      foreign) url="https://localhost:$port/$api/download/$tag" ;;
      dotdot) url="$base/$api/download/$tag/../../../good/download/v1.1.0" ;;
    esac
  done
  dl="$srv/$api/download/$tag"
  stage="$work/stage-$api-$version"
  mkdir -p "$dl" "$stage" "$srv/$api/releases/tags"
  make_app "$stage" "$version"
  tar -czf "$dl/Breakpatch_aarch64.app.tar.gz" -C "$stage" Breakpatch.app
  # Like Tauri's: the base64 of a minisign signature file.
  printf 'untrusted comment: signature from tauri secret key\nRUQbw3MJi+i+MQ==\ntrusted comment: timestamp:0\nAAAA\n' \
    | base64 | tr -d '\n' > "$dl/Breakpatch_aarch64.app.tar.gz.sig"
  echo "dmg" > "$dl/Breakpatch_${version}_aarch64.dmg"
  if [ "$linux" -eq 1 ]; then
    make_appimage "$dl/Breakpatch_amd64.AppImage" "$version"
    cp "$dl/Breakpatch_aarch64.app.tar.gz.sig" "$dl/Breakpatch_amd64.AppImage.sig"
    echo "deb" > "$dl/breakpatch_${version}_amd64.deb"
  fi
  echo "{}" > "$dl/latest.json"
  if [ "$nosums" -eq 0 ]; then
    (cd "$dl" && shasum -a 256 -- * > SHA256SUMS)   # expanded before SHA256SUMS exists
    if [ "$badsum" -eq 1 ]; then
      sed -i 's/^[0-9a-f]\{64\}\(  Breakpatch_\(aarch64.app.tar.gz\|amd64.AppImage\)\)$/0000000000000000000000000000000000000000000000000000000000000000\1/' "$dl/SHA256SUMS"
    fi
  fi
  # The latest release as one line (like api.github.com), the tagged one indented: the
  # installer must read both. The body has commas, braces and quotes on purpose.
  python3 - "$dl" "$url" "$tag" "$srv/$api/releases" "$latest" "$pre" "$draft" <<'PY'
import json, os, sys
dl, url, tag, releases, latest, pre, draft = sys.argv[1:]
assets = [{"name": n, "size": os.path.getsize(os.path.join(dl, n)), "browser_download_url": f"{url}/{n}",
           "uploader": {"login": "github-actions[bot]", "type": "Bot"}} for n in sorted(os.listdir(dl))]
doc = {"url": "x", "tag_name": tag, "name": f"Breakpatch {tag}", "draft": draft == "1", "prerelease": pre == "1",
       "author": {"login": "someone"}, "assets": assets,
       "body": 'Download it, then {open} it. "Quoted", and "tag_name": "v0.0.1" in text.'}
with open(os.path.join(releases, "tags", tag), "w") as f: json.dump(doc, f, indent=2)
if latest == "1":
    with open(os.path.join(releases, "latest"), "w") as f: json.dump(doc, f)
PY
}

# $1 API root name, then its tags, newest first: GET releases (the list), as GitHub sorts it.
make_list() {
  local api=$1; shift
  python3 - "$srv/$api/releases" "$@" <<'PY'
import json, os, sys
releases, tags = sys.argv[1], sys.argv[2:]
docs = [json.load(open(os.path.join(releases, "tags", t))) for t in tags]
with open(os.path.join(releases, "list.json"), "w") as f: json.dump(docs, f, indent=1)
PY
}

make_release good 1.0.0
make_release good 1.1.0 latest
# Betas: GitHub's releases/latest skips them (and drafts); the list has them, newest first.
make_release good 1.2.0-beta.1 prerelease
make_release good 1.3.0-beta.1 prerelease draft
make_list good v1.3.0-beta.1 v1.2.0-beta.1 v1.1.0 v1.0.0
make_release bad 1.2.0 latest bad-sum
make_release nosums 1.3.0 latest no-sums
make_release foreign 1.4.0 latest foreign
make_release dotdot 1.5.0 latest dotdot
make_release maconly 1.6.0 latest mac-only
mkdir -p "$srv/empty/releases"
echo "[]" > "$srv/empty/releases/list.json"

# ---- the private repository, as api.github.com shows it to a token that can read it

token=github_pat_11TESTTOKEN0_privateBetaSecretValue42
gh="$srv/gh"
mkdir -p "$gh/assets"
echo 1000 > "$gh/next-id"

# $1 repository (under BreakPatch/), $2 version, then options: latest, prerelease, other-repo
# (its files' asset addresses are another repository's). The JSON is compact, as api.github.com
# writes it, with each file's API address in "url" (what a token downloads) as well as the
# browser address, which doesn't work for a private repository.
make_private_release() {
  local repo=$1 version=$2 tag="v$2" dl stage
  shift 2
  dl="$work/gh-stage/$repo/$tag"
  stage="$work/stage-gh-$repo-$version"
  mkdir -p "$dl" "$stage"
  make_app "$stage" "$version"
  tar -czf "$dl/Breakpatch_aarch64.app.tar.gz" -C "$stage" Breakpatch.app
  printf 'untrusted comment: signature from tauri secret key\nRUQbw3MJi+i+MQ==\ntrusted comment: timestamp:0\nAAAA\n' \
    | base64 | tr -d '\n' > "$dl/Breakpatch_aarch64.app.tar.gz.sig"
  echo "{}" > "$dl/latest.json"
  (cd "$dl" && shasum -a 256 Breakpatch_* latest.json > SHA256SUMS)
  python3 - "$dl" "$tag" "$gh" "$repo" "$@" <<'PY'
import json, os, shutil, sys
dl, tag, gh, repo, opts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
api = f"https://api.github.com/repos/BreakPatch/{repo}"
files_repo = "breakpatch" if "other-repo" in opts else repo
bot = {"login": "github-actions[bot]", "url": "https://api.github.com/users/github-actions%5Bbot%5D", "type": "Bot"}
nid = int(open(f"{gh}/next-id").read())
assets = []
for n in sorted(os.listdir(dl)):
    nid += 1
    shutil.copy(os.path.join(dl, n), f"{gh}/assets/{nid}")
    assets.append({"url": f"https://api.github.com/repos/BreakPatch/{files_repo}/releases/assets/{nid}", "id": nid,
                   "name": n, "label": "", "uploader": bot, "content_type": "application/octet-stream",
                   "state": "uploaded", "size": os.path.getsize(os.path.join(dl, n)),
                   "browser_download_url": f"https://github.com/BreakPatch/{repo}/releases/download/{tag}/{n}"})
open(f"{gh}/next-id", "w").write(str(nid))
doc = {"url": f"{api}/releases/{nid}", "assets_url": f"{api}/releases/{nid}/assets", "id": nid, "author": bot,
       "tag_name": tag, "name": f"Breakpatch {tag}", "draft": False, "prerelease": "prerelease" in opts,
       "assets": assets, "body": 'Beta. {"tag_name": "v0.0.1", "url": "https://example.com/x"}, try it.'}
rel = f"{gh}/repos/BreakPatch/{repo}/releases"
os.makedirs(f"{rel}/tags", exist_ok=True)
def write(path, d):
    with open(path, "w") as f: f.write(json.dumps(d, separators=(",", ":")))
write(f"{rel}/tags/{tag}", doc)
if "latest" in opts: write(f"{rel}/latest", doc)
listed = json.load(open(f"{rel}/list.json")) if os.path.exists(f"{rel}/list.json") else []
write(f"{rel}/list.json", [doc] + listed)   # newest first
PY
}

make_private_release breakpatch 0.0.9 latest
make_private_release breakpatch 0.1.0-beta.1 prerelease
make_private_release betaonly 0.1.0-beta.1 prerelease   # the private beta as it starts: one prerelease
make_private_release evil 0.2.0 latest other-repo
make_private_release httpredirect 0.3.0 latest

# The same files over https (what the installer uses) and plain http (which it must refuse).
# A folder with a list.json is a list of releases (GET …/releases?per_page=10).
#
# The GitHub stand-in (gh_port) answers by Host, and logs "host path auth=<Authorization or ->"
# to gh.log. api.github.com: 404 without the token (a private repository), 401 with another;
# releases/assets/ID with Accept: application/octet-stream redirects to
# objects.githubusercontent.com, which, like S3 with its signed address, fails a request that
# also has an Authorization header. httpredirect's files redirect to http://.
cat > "$work/serve.py" <<'PY'
import functools, http.server, os, re, ssl, sys, threading
port, http_port, gh_port, root, tls, token, gh_log = sys.argv[1:]

class Static(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = super().translate_path(path)
        return os.path.join(p, "list.json") if os.path.isfile(os.path.join(p, "list.json")) else p

class GitHub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, code, body=b"", headers=()):
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def file(self, path):
        if not os.path.isfile(path): return self.answer(404, b'{"message":"Not Found"}')
        with open(path, "rb") as f: self.answer(200, f.read())
    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        auth = self.headers.get("Authorization")
        path = self.path.split("?")[0]
        with open(gh_log, "a") as f: f.write(f"{host} {path} auth={auth or '-'}\n")
        if host == "api.github.com":
            if auth is None: return self.answer(404, b'{"message":"Not Found"}')
            if auth != "Bearer " + token: return self.answer(401, b'{"message":"Bad credentials"}')
            m = re.fullmatch(r"/repos/BreakPatch/([^/]+)/releases/assets/(\d+)", path)
            if m:
                if self.headers.get("Accept") != "application/octet-stream":
                    return self.answer(200, b'{"id":%s}' % m[2].encode())
                scheme = "http" if m[1] == "httpredirect" else "https"
                loc = (f"{scheme}://objects.githubusercontent.com/github-production-release-asset-2e65be/{m[2]}"
                       "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=f00d")
                return self.answer(302, headers=[("Location", loc)])
            p = os.path.join(root, "gh", path.lstrip("/"))
            return self.file(os.path.join(p, "list.json") if os.path.isdir(p) else p)
        if host == "objects.githubusercontent.com":
            if auth is not None:
                return self.answer(400, b"<Error><Code>InvalidArgument</Code><Message>Only one auth mechanism allowed</Message></Error>")
            m = re.fullmatch(r"/github-production-release-asset-2e65be/(\d+)", path)
            return self.file(os.path.join(root, "gh", "assets", m[1]) if m else "")
        self.answer(421)

def tls_server(p, handler):
    s = http.server.ThreadingHTTPServer(("127.0.0.1", p), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(f"{tls}/cert.pem", f"{tls}/key.pem")
    s.socket = ctx.wrap_socket(s.socket, server_side=True)
    return s

static = functools.partial(Static, directory=root)
plain = http.server.ThreadingHTTPServer(("127.0.0.1", int(http_port)), static)
threading.Thread(target=plain.serve_forever, daemon=True).start()
threading.Thread(target=tls_server(int(gh_port), GitHub).serve_forever, daemon=True).start()
tls_server(int(port), static).serve_forever()
PY
gh_port=$(free_port)
gh_log="$work/gh.log"
python3 "$work/serve.py" "$port" "$http_port" "$gh_port" "$srv" "$tls" "$token" "$gh_log" >"$work/server.log" 2>&1 &
server_pid=$!
no_proxy_hosts="127.0.0.1,localhost,api.github.com,objects.githubusercontent.com"
export CURL_CA_BUNDLE="$tls/cert.pem" NO_PROXY="$no_proxy_hosts" no_proxy="$no_proxy_hosts"
for _ in $(seq 50); do
  if curl -fs "$base/good/releases/latest" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fs "$base/good/releases/latest" >/dev/null || { echo "the test server didn't start" >&2; cat "$work/server.log" >&2; exit 1; }
curl -fs "http://127.0.0.1:$http_port/good/releases/latest" >/dev/null || { echo "the plain http test server didn't start" >&2; exit 1; }

# ---------------------------------------------------------------- macOS stand-ins

shims="$work/shims"
mkdir -p "$shims"
real_uname=$(command -v uname)
cat > "$shims/uname" <<EOF
#!/bin/sh
case "\$1" in
  -s) echo "\${FAKE_OS:-Darwin}" ;;
  -m) echo "\${FAKE_ARCH:-arm64}" ;;
  *) exec $real_uname "\$@" ;;
esac
EOF
cat > "$shims/sw_vers" <<'EOF'
#!/bin/sh
[ "$1" = -productVersion ] && echo "${FAKE_MACOS:-15.1}"
EOF
cat > "$shims/sysctl" <<'EOF'
#!/bin/sh
echo "${FAKE_TRANSLATED:-0}"
EOF
# The app "runs" while $FAKE_STATE/running exists; quitting removes it.
cat > "$shims/osascript" <<'EOF'
#!/bin/sh
case "$2" in
  *"is running"*) if [ -f "$FAKE_STATE/running" ]; then echo true; else echo false; fi ;;
  *"to quit"*) echo "quit" >> "$FAKE_STATE/log"; rm -f "$FAKE_STATE/running" ;;
  *) echo "osascript: unexpected $*" >&2; exit 1 ;;
esac
EOF
cat > "$shims/open" <<'EOF'
#!/bin/sh
echo "open $*" >> "$FAKE_STATE/log"
EOF
cat > "$shims/xattr" <<'EOF'
#!/bin/sh
echo "xattr $*" >> "$FAKE_STATE/log"
EOF
# Not root (these tests run as root in containers); FAKE_UID=0 is running with sudo.
real_id=$(command -v id)
cat > "$shims/id" <<EOF
#!/bin/sh
if [ "\$1" = -u ]; then echo "\${FAKE_UID:-501}"; else exec $real_id "\$@"; fi
EOF
# codesign: the app is signed (FAKE_CODESIGN=unsigned: it isn't) with FAKE_CERT, Breakpatch's by default.
cat > "$shims/codesign" <<EOF
#!/bin/sh
echo "codesign \$*" >> "\$FAKE_STATE/log"
[ "\${FAKE_CODESIGN:-signed}" = signed ] || { echo "code object is not signed at all" >&2; exit 1; }
for a in "\$@"; do
  case "\$a" in --extract-certificates=*) cp "\${FAKE_CERT:-$tls/breakpatch.cer}" "\${a#*=}0" ;; esac
done
EOF
# minisign, only on PATH in the cases that have it: FAKE_MINISIGN=bad makes the check fail. It
# also checks the installer decoded the .sig (a minisign file starts "untrusted comment:").
mshims="$work/minisign-shims"
mkdir -p "$mshims"
cat > "$mshims/minisign" <<'EOF'
#!/bin/sh
echo "minisign $*" >> "$FAKE_STATE/log"
sig=""; prev=""
for a in "$@"; do [ "$prev" = -x ] && sig=$a; prev=$a; done
head -n 1 "$sig" | grep -q '^untrusted comment:' || { echo "not a minisign signature" >&2; exit 2; }
[ "${FAKE_MINISIGN:-good}" = good ]
EOF
# curl as the installer runs it, for the token cases: logs its arguments (what `ps` shows), its
# environment and the mode of any -H @file, then runs the real curl. FAKE_CURL_VERSION: an old curl.
cshims="$work/curl-shims"
mkdir -p "$cshims"
real_curl=$(command -v curl)
cat > "$cshims/curl" <<EOF
#!/bin/sh
printf 'curl %s\n' "\$*" >> "\$FAKE_STATE/curl-args"
env >> "\$FAKE_STATE/curl-env"
for a in "\$@"; do case "\$a" in @*) stat -c '%a' "\${a#@}" >> "\$FAKE_STATE/auth-mode" ;; esac; done
if [ "\$1" = --version ] && [ -n "\${FAKE_CURL_VERSION:-}" ]; then echo "curl \$FAKE_CURL_VERSION (x86_64-apple-darwin23.0)"; exit 0; fi
exec $real_curl "\$@"
EOF
# Linux: glibc FAKE_GLIBC (none: no getconf answer, as on musl); FAKE_DEB=1, Breakpatch's .deb
# is installed; pgrep finds the app while $FAKE_STATE/running exists; fusermount is there unless
# the case takes it off PATH.
cat > "$shims/getconf" <<'EOF'
#!/bin/sh
[ "$1" = GNU_LIBC_VERSION ] && [ "${FAKE_GLIBC:-2.39}" != none ] && { echo "glibc ${FAKE_GLIBC:-2.39}"; exit 0; }
exit 1
EOF
cat > "$shims/dpkg-query" <<'EOF'
#!/bin/sh
[ "${FAKE_DEB:-0}" = 1 ] || { echo "dpkg-query: no packages found matching breakpatch" >&2; exit 1; }
printf 'ii '
EOF
cat > "$shims/pgrep" <<'EOF'
#!/bin/sh
[ -f "$FAKE_STATE/running" ]
EOF
for t in fusermount3 update-desktop-database update-mime-database; do
  # shellcheck disable=SC2016  # the $ are the shim's
  printf '#!/bin/sh\necho "%s $*" >> "$FAKE_STATE/log"\n' "$t" > "$shims/$t"
done
chmod +x "$shims"/* "$mshims"/* "$cshims"/*

# ---------------------------------------------------------------- helpers

# new_case NAME: a fresh home, Applications folder, TMPDIR and state for one run.
new_case() {
  current="$sh_name: $1"
  echo "$current"
  c="$work/cases/${sh_name// /}-$1"
  mkdir -p "$c/home" "$c/Applications" "$c/tmp" "$c/state"
  : > "$c/state/log"
  apps="$c/Applications"
}

# run [VAR=value…] [-- args]: runs the installer; output in $out, exit code in $code.
run() {
  local vars=() args=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ $# -eq 0 ] || { shift; args=("$@"); }
  set +e
  out=$(env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" \
        BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" BREAKPATCH_APPS_DIR="$apps" \
        ${vars[@]+"${vars[@]}"} "${shell_cmd[@]}" "$script" ${args[@]+"${args[@]}"} 2>&1)
  code=$?
  set -e
}

# The same, with the script piped in, as `curl … | sh -s -- args` runs it.
run_piped() {
  local vars=() args=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ $# -eq 0 ] || { shift; args=("$@"); }
  set +e
  out=$(env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" \
        BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" BREAKPATCH_APPS_DIR="$apps" \
        ${vars[@]+"${vars[@]}"} "${shell_cmd[@]}" -s -- ${args[@]+"${args[@]}"} < "$script" 2>&1)
  code=$?
  set -e
}

expect_code() { if [ "$code" -eq "$1" ]; then ok "exit $1"; else bad "exit $code, expected $1. Output:"$'\n'"$out"; fi; }
expect_out() { if [[ "$out" == *"$1"* ]]; then ok "says: $1"; else bad "doesn't say: $1. Output:"$'\n'"$out"; fi; }
expect_no_out() { if [[ "$out" != *"$1"* ]]; then ok "doesn't say: $1"; else bad "says: $1"; fi; }
expect_log() { if grep -qF -- "$1" "$c/state/log"; then ok "ran: $1"; else bad "didn't run: $1 (log: $(tr '\n' ';' < "$c/state/log"))"; fi; }
expect_no_log() { if ! grep -qF -- "$1" "$c/state/log"; then ok "didn't run: $1"; else bad "ran: $1"; fi; }
version_in() { sed -n '/CFBundleShortVersionString/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$1/Breakpatch.app/Contents/Info.plist" 2>/dev/null; }
expect_version() {
  local v; v=$(version_in "$1" || true)     # no app: a failed check, not the end of the tests
  if [ "$v" = "$2" ]; then ok "$2 in ${1#"$c"/}"; else bad "${1#"$c"/} has '${v:-no app}', expected $2"; fi
}
expect_no_app() { if [ ! -e "$1/Breakpatch.app" ]; then ok "no app in ${1#"$c"/}"; else bad "an app is in ${1#"$c"/}"; fi; }
expect_clean() {
  local left="" f
  for f in "$c/tmp"/* "$c/tmp"/.[!.]* "$apps"/.[!.]* "$c/home/Applications"/.[!.]*; do
    [ ! -e "$f" ] || left="$left $f"
  done
  if [ -z "$left" ]; then ok "nothing left behind"; else bad "left behind:$left"; fi
}
# gh_case NAME: a new case that reaches the GitHub stand-in: the home's .curlrc sends
# api.github.com and objects.githubusercontent.com to it (curl reads it, as it would a user's).
gh_case() {
  new_case "$1"
  printf 'connect-to = api.github.com:443:127.0.0.1:%s\nconnect-to = objects.githubusercontent.com:443:127.0.0.1:%s\n' \
    "$gh_port" "$gh_port" > "$c/home/.curlrc"
  : > "$gh_log"
  : > "$c/state/curl-args"; : > "$c/state/curl-env"; : > "$c/state/auth-mode"
}
# run_gh [VAR=value…]: run at the real default address (BREAKPATCH_API unset), through the curl shim.
run_gh() { run BREAKPATCH_API= BREAKPATCH_DOWNLOADS= CURL_HOME="$c/home" PATH="$cshims:$shims:$PATH" "$@"; }
expect_gh() { if grep -qE -- "$1" "$gh_log"; then ok "GitHub got: $2"; else bad "GitHub didn't get: $2 (log: $(tr '\n' ';' < "$gh_log"))"; fi; }
expect_no_gh() { if ! grep -qE -- "$1" "$gh_log"; then ok "GitHub didn't get: $2"; else bad "GitHub got: $2 ($(grep -E -- "$1" "$gh_log" | head -n 3 | tr '\n' ';'))"; fi; }
# The token never shows: not in the output, curl's arguments (what ps shows) or environment,
# nor in a file left behind.
expect_token_hidden() {
  expect_no_out "$token"
  if ! grep -qF -- "$token" "$c/state/curl-args"; then ok "the token isn't in curl's arguments"; else bad "the token is in curl's arguments"; fi
  if ! grep -qF -- "$token" "$c/state/curl-env"; then ok "the token isn't in curl's environment"; else bad "the token is in curl's environment"; fi
  if ! grep -rqF -- "$token" "$c/tmp" "$c/home" "$apps" 2>/dev/null; then ok "the token isn't in a file left behind"; else bad "the token is in a file left behind"; fi
}
# Every API request had the token, and the asset host never got it.
expect_token_only_to_api() {
  expect_gh "^api\.github\.com /repos/BreakPatch/[a-z]+/releases/assets/[0-9]+ auth=Bearer $token\$" "a file's asset address, with the token"
  expect_no_gh "^api\.github\.com .* auth=-\$" "an API request without the token"
  expect_gh "^objects\.githubusercontent\.com /github-production-release-asset-2e65be/[0-9]+ auth=-\$" "the redirected download, without the token"
  expect_no_gh "^objects\.githubusercontent\.com .* auth=[^-]" "the token at the asset host"
  expect_no_gh "^(127\.0\.0\.1|localhost|github\.com) " "a request for another host"
  if [ -s "$c/state/auth-mode" ] && ! grep -qvx 600 "$c/state/auth-mode"; then ok "the header file is 0600"; else bad "the header file's mode: $(tr '\n' ' ' < "$c/state/auth-mode")"; fi
}

# run_linux [VAR=value…] [-- args]: the installer on Linux x86_64, with no display.
run_linux() { run FAKE_OS=Linux FAKE_ARCH=x86_64 DISPLAY= WAYLAND_DISPLAY= "$@"; }
lbin() { printf '%s' "$c/home/.local/bin/breakpatch"; }
lentry() { printf '%s' "$c/home/.local/share/applications/breakpatch.desktop"; }
# shellcheck disable=SC2088  # messages, with a ~ to show
expect_linux_app() {   # VERSION: the AppImage of that release is installed, and can run
  if [ -x "$(lbin)" ] && grep -qF "started $1" "$(lbin)"; then ok "the $1 AppImage is ~/.local/bin/breakpatch"; else bad "~/.local/bin/breakpatch isn't the $1 AppImage"; fi
}
# shellcheck disable=SC2088
expect_no_linux_app() { if [ ! -e "$(lbin)" ]; then ok "no ~/.local/bin/breakpatch"; else bad "~/.local/bin/breakpatch is there"; fi; }
expect_entry() { if grep -qxF -- "$1" "$(lentry)" 2>/dev/null; then ok "desktop entry: $1"; else bad "desktop entry hasn't: $1 ($(tr '\n' ';' < "$(lentry)" 2>/dev/null))"; fi; }
expect_linux_clean() {
  local left="" f
  for f in "$c/tmp"/* "$c/tmp"/.[!.]* "$c/home/.local/bin"/.[!.]* "$c/home/.local/share/applications"/*.new; do
    [ ! -e "$f" ] || left="$left $f"
  done
  if [ -z "$left" ]; then ok "nothing left behind"; else bad "left behind:$left"; fi
}
# A PATH without fusermount (FUSE isn't installed).
nofuse_path() {
  local d="$c/nofuse" f n
  mkdir -p "$d"
  for f in "$shims"/* /usr/local/bin/* /usr/bin/* /bin/*; do
    n=$(basename "$f")
    case "$n" in fusermount | fusermount3) continue ;; esac
    [ -e "$d/$n" ] || ln -s "$f" "$d/$n"
  done
  printf '%s' "$d"
}

# A dummy app installed by hand, as an earlier install would have left it.
preinstall() { make_app "$1" "$2"; echo "old" > "$1/Breakpatch.app/Contents/old-file"; }

# ---------------------------------------------------------------- the cases

# ---------------------------------------------------------------- what's built into the script

current="constants"
echo "$current"
want_cert=$(grep -v '^#' "$repo/app/src-tauri/signing/fingerprint.txt" | tr -cd '0-9A-Fa-f' | tr 'a-f' 'A-F')
if grep -qx "CERT_SHA256=$want_cert" "$script"; then ok "the certificate fingerprint is fingerprint.txt's"; else bad "CERT_SHA256 in site/install isn't fingerprint.txt's ($want_cert)"; fi
want_key=$(node -p "Buffer.from(require('$repo/app/src-tauri/tauri.conf.json').plugins.updater.pubkey, 'base64').toString().split('\n')[1]")
if grep -qx "MINISIGN_KEY=$want_key" "$script"; then ok "the minisign key is the updater's"; else bad "MINISIGN_KEY in site/install isn't the updater key ($want_key)"; fi
# shellcheck disable=SC2016  # the literal characters $$
if grep -qF '$$' "$script"; then bad "site/install makes a name from the process id (guessable)"; else ok "no guessable staging names"; fi
# shellcheck disable=SC2016
if grep -qF 'mktemp -d "$dest/' "$script"; then ok "staging folders come from mktemp"; else bad "staging folders don't come from mktemp"; fi

# shellcheck disable=SC2016  # the literal ${…} in the script
want_glibc=$(sed -n 's/^glibc_max=${BP_GLIBC_MAX:-\(.*\)}$/\1/p' "$repo/scripts/linux-release-files.sh")
if grep -qx "GLIBC_MIN=$want_glibc" "$script"; then ok "the Linux glibc floor is the release check's ($want_glibc)"; else bad "GLIBC_MIN in site/install isn't scripts/linux-release-files.sh's ($want_glibc)"; fi

for sh_name in "sh" "bash --posix"; do
  read -r -a shell_cmd <<< "$sh_name"

  new_case fresh-install
  run_piped
  expect_code 0
  expect_out "Installing Breakpatch 1.1.0…"
  expect_out "Breakpatch is in $apps. Opening it now."
  expect_version "$apps" 1.1.0
  expect_log "xattr -dr com.apple.quarantine $apps/Breakpatch.app"
  expect_log "open $apps/Breakpatch.app"
  expect_no_log "quit"
  expect_clean

  new_case update-while-open
  preinstall "$apps" 1.0.0
  touch "$c/state/running"
  run
  expect_code 0
  expect_out "Updating Breakpatch 1.0.0 to 1.1.0…"
  expect_out "Quitting Breakpatch first…"
  expect_log "quit"
  expect_version "$apps" 1.1.0
  if [ ! -e "$apps/Breakpatch.app/Contents/old-file" ]; then ok "the old bundle is gone"; else bad "old files are still in the bundle"; fi
  expect_log "open $apps/Breakpatch.app"
  expect_clean

  new_case reinstall-same-version
  preinstall "$apps" 1.1.0
  run
  expect_code 0
  expect_out "Reinstalling Breakpatch 1.1.0…"
  expect_version "$apps" 1.1.0
  expect_clean

  new_case bad-checksum
  preinstall "$apps" 1.0.0
  run BREAKPATCH_API="$base/bad" BREAKPATCH_DOWNLOADS="$base/bad/download/"
  expect_code 1
  expect_out "The download doesn't match its checksum, so it wasn't installed."
  expect_version "$apps" 1.0.0
  if [ -e "$apps/Breakpatch.app/Contents/old-file" ]; then ok "the installed app is untouched"; else bad "the installed app was changed"; fi
  expect_no_log "open"
  expect_clean

  new_case release-without-checksums
  run BREAKPATCH_API="$base/nosums"
  expect_code 1
  expect_out "Breakpatch 1.3.0 can't be installed with this command. Try an older version"
  expect_no_app "$apps"

  new_case old-macos
  run FAKE_MACOS=13.6.1
  expect_code 1
  expect_out "Breakpatch needs a Mac with Apple Silicon (M1 or later) and macOS 14 or later. This Mac has macOS 13.6.1."
  expect_no_app "$apps"

  new_case intel-mac
  run FAKE_ARCH=x86_64
  expect_code 1
  expect_out "Breakpatch needs a Mac with Apple Silicon (M1 or later) and macOS 14 or later. This Mac has an Intel processor."
  expect_no_app "$apps"

  new_case rosetta-terminal
  run FAKE_ARCH=x86_64 FAKE_TRANSLATED=1
  expect_code 0
  expect_version "$apps" 1.1.0

  new_case not-a-mac
  run FAKE_OS=FreeBSD
  expect_code 1
  expect_out "Breakpatch needs a Mac with Apple Silicon (M1 or later) and macOS 14 or later."
  expect_no_app "$apps"

  new_case missing-shasum
  nosha="$c/bin"; mkdir -p "$nosha"
  for f in /usr/local/bin/* /usr/bin/* /bin/*; do
    n=$(basename "$f"); [ "$n" = shasum ] || [ -e "$nosha/$n" ] || ln -s "$f" "$nosha/$n"
  done
  set +e
  out=$(env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$nosha" FAKE_STATE="$c/state" \
        BREAKPATCH_API="$base/good" BREAKPATCH_APPS_DIR="$apps" "${shell_cmd[@]}" "$script" 2>&1)
  code=$?
  set -e
  expect_code 1
  expect_out "The installer needs shasum, which comes with macOS but isn't on this Mac's PATH."

  new_case home-applications-fallback
  apps="$c/no-such-folder/Applications"      # can't be written to: it isn't there
  run
  expect_code 0
  expect_out "Breakpatch is in ~/Applications. Opening it now."
  expect_version "$c/home/Applications" 1.1.0
  expect_log "open $c/home/Applications/Breakpatch.app"
  expect_clean

  new_case update-stays-in-home-applications
  preinstall "$c/home/Applications" 1.0.0
  run
  expect_code 0
  expect_out "Updating Breakpatch 1.0.0 to 1.1.0…"
  expect_version "$c/home/Applications" 1.1.0
  expect_no_app "$apps"

  if [ "$(id -u)" -eq 0 ] && command -v setpriv >/dev/null; then
    new_case read-only-applications-as-a-user
    chmod 555 "$apps"
    chown -R 65534:65534 "$c/home" "$c/tmp" "$c/state"
    chmod 755 "$c" "$work" "$work/cases" "$shims"
    set +e
    out=$(setpriv --reuid=65534 --regid=65534 --clear-groups env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" \
          FAKE_STATE="$c/state" BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" \
          BREAKPATCH_APPS_DIR="$apps" "${shell_cmd[@]}" "$script" 2>&1)
    code=$?
    set -e
    expect_code 0
    expect_out "Breakpatch is in ~/Applications."
    expect_version "$c/home/Applications" 1.1.0
    expect_no_app "$apps"
  fi

  new_case pinned-version
  run BREAKPATCH_VERSION=1.0.0
  expect_code 0
  expect_out "Installing Breakpatch 1.0.0…"
  expect_version "$apps" 1.0.0
  run BREAKPATCH_VERSION=v1.1.0
  expect_code 0
  expect_out "Updating Breakpatch 1.0.0 to 1.1.0…"
  expect_version "$apps" 1.1.0
  run BREAKPATCH_VERSION=9.9.9
  expect_code 1
  expect_out "There's no Breakpatch 9.9.9. The versions are at https://github.com/BreakPatch/breakpatch/releases."
  expect_version "$apps" 1.1.0

  new_case no-release-yet
  run BREAKPATCH_API="$base/empty"
  expect_code 1
  expect_out "There's no Breakpatch release yet."

  new_case github-unreachable
  run BREAKPATCH_API="https://127.0.0.1:9/nothing"
  expect_code 1
  expect_out "Couldn't reach GitHub to find Breakpatch. Check your connection and try again."

  new_case uninstall
  preinstall "$apps" 1.1.0
  mkdir -p "$c/home/Library/Application Support/Breakpatch/models"
  echo model > "$c/home/Library/Application Support/Breakpatch/models/weights"
  touch "$c/state/running"
  run_piped -- --uninstall
  expect_code 0
  expect_log "quit"
  expect_out "Removed Breakpatch from $apps."
  expect_out "Your tests are still in the tests folder you picked."
  # shellcheck disable=SC2088  # the message shows a ~
  expect_out "~/Library/Application Support/Breakpatch"
  expect_no_app "$apps"
  if [ -f "$c/home/Library/Application Support/Breakpatch/models/weights" ]; then ok "the AI assistant is kept"; else bad "the AI assistant was deleted"; fi
  expect_no_log "open"
  run -- --uninstall
  expect_code 0
  expect_out "Nothing to remove."

  new_case help-and-unknown-options
  run -- --help
  expect_code 0
  expect_out "curl -fsSL https://breakpatch.dev/install | sh"
  expect_out "--uninstall"
  expect_no_app "$apps"
  run -- --bogus
  expect_code 1
  expect_out "Unknown option --bogus."

  # ---- who published it (security review A8)

  new_case checks-the-certificate
  run
  expect_code 0
  expect_log "codesign --verify --deep --strict"
  expect_log "codesign -d --extract-certificates="
  expect_no_log "minisign"                       # not on this Mac: the certificate check still runs
  expect_version "$apps" 1.1.0

  new_case wrong-certificate
  preinstall "$apps" 1.0.0
  run FAKE_CERT="$tls/other.cer"
  expect_code 1
  expect_out "The download isn't signed with Breakpatch's certificate, so it wasn't installed."
  expect_version "$apps" 1.0.0
  if [ -e "$apps/Breakpatch.app/Contents/old-file" ]; then ok "the installed app is untouched"; else bad "the installed app was changed"; fi
  expect_no_log "open"
  expect_clean

  new_case unsigned-app
  run FAKE_CODESIGN=unsigned
  expect_code 1
  expect_out "The download isn't signed with Breakpatch's certificate, so it wasn't installed."
  expect_no_app "$apps"
  expect_clean

  new_case minisign-checks-the-signature
  run PATH="$mshims:$shims:$PATH"
  expect_code 0
  expect_log "minisign -V -q -P RWQbw3MJi+i+MQ97FPaAqkP2nnccBb+ySDCUH1PqiwViaG6y9TNEQszX -m"
  expect_version "$apps" 1.1.0
  expect_clean

  new_case minisign-bad-signature
  preinstall "$apps" 1.0.0
  run PATH="$mshims:$shims:$PATH" FAKE_MINISIGN=bad
  expect_code 1
  expect_out "The download isn't signed with Breakpatch's key, so it wasn't installed."
  expect_version "$apps" 1.0.0
  expect_no_log "codesign"                       # it stopped before unpacking
  expect_clean

  new_case files-from-elsewhere
  run BREAKPATCH_API="$base/foreign" BREAKPATCH_DOWNLOADS="$base/foreign/download/"
  expect_code 1
  expect_out "Breakpatch 1.4.0 lists a file that isn't from Breakpatch's releases, so nothing was installed."
  expect_no_app "$apps"
  run BREAKPATCH_API="$base/dotdot" BREAKPATCH_DOWNLOADS="$base/dotdot/download/"
  expect_code 1
  expect_out "Breakpatch 1.5.0 lists a file that isn't from Breakpatch's releases"
  expect_no_app "$apps"
  run BREAKPATCH_DOWNLOADS="http://127.0.0.1:$http_port/good/download/"
  expect_code 1
  expect_out "BREAKPATCH_DOWNLOADS must start with https://."
  expect_no_app "$apps"
  expect_clean

  new_case https-only
  run BREAKPATCH_API="http://127.0.0.1:$http_port/good"
  expect_code 1
  expect_out "Couldn't reach GitHub to find Breakpatch."
  expect_no_app "$apps"

  new_case refuses-root
  run FAKE_UID=0
  expect_code 1
  expect_out "Don't run the installer with sudo or as root."
  expect_no_app "$apps"
  expect_no_out "Installing"
  run FAKE_UID=0 -- --uninstall
  expect_code 1
  expect_out "Don't run the installer with sudo or as root."

  # ---- betas and the private beta

  new_case beta-channel
  run BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Installing Breakpatch 1.2.0-beta.1…"          # the newest that isn't a draft
  expect_version "$apps" 1.2.0-beta.1
  expect_clean
  run
  expect_code 0
  expect_out "Updating Breakpatch 1.2.0-beta.1 to 1.1.0…"   # stable is releases/latest: never a beta
  run BREAKPATCH_CHANNEL=beta BREAKPATCH_API="$base/empty"
  expect_code 1
  expect_out "There's no Breakpatch release yet."
  run BREAKPATCH_CHANNEL=nightly
  expect_code 1
  expect_out "BREAKPATCH_CHANNEL is stable or beta, not nightly."

  new_case pinned-prerelease
  run BREAKPATCH_VERSION=1.2.0-beta.1
  expect_code 0
  expect_out "Installing Breakpatch 1.2.0-beta.1…"
  expect_version "$apps" 1.2.0-beta.1
  run BREAKPATCH_VERSION=v1.2.0-beta.1 BREAKPATCH_CHANNEL=stable   # a pinned version wins over the channel
  expect_code 0
  expect_out "Reinstalling Breakpatch 1.2.0-beta.1…"
  run 'BREAKPATCH_VERSION=1.2.0;beta'
  expect_code 1
  expect_out "BREAKPATCH_VERSION is a version like 1.2.3 or 0.1.0-beta.1."
  run BREAKPATCH_VERSION=1.0/../../evil
  expect_code 1
  expect_out "BREAKPATCH_VERSION is a version like 1.2.3 or 0.1.0-beta.1."
  expect_version "$apps" 1.2.0-beta.1

  gh_case token-beta-channel
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Using BREAKPATCH_GITHUB_TOKEN (private beta)."
  expect_out "Installing Breakpatch 0.1.0-beta.1…"
  expect_version "$apps" 0.1.0-beta.1
  expect_gh "^api\.github\.com /repos/BreakPatch/breakpatch/releases auth=Bearer $token\$" "the list of releases, with the token"
  expect_token_only_to_api
  expect_token_hidden
  expect_log "codesign -d --extract-certificates="
  expect_log "open $apps/Breakpatch.app"
  expect_clean

  gh_case token-stable-and-pinned
  run_gh BREAKPATCH_GITHUB_TOKEN="$token"
  expect_code 0
  expect_out "Installing Breakpatch 0.0.9…"                  # releases/latest: not the beta
  expect_gh "^api\.github\.com /repos/BreakPatch/breakpatch/releases/latest auth=Bearer $token\$" "releases/latest, with the token"
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_VERSION=0.1.0-beta.1
  expect_code 0
  expect_out "Updating Breakpatch 0.0.9 to 0.1.0-beta.1…"
  expect_gh "^api\.github\.com /repos/BreakPatch/breakpatch/releases/tags/v0\.1\.0-beta\.1 auth=Bearer $token\$" "the tag, with the token"
  expect_version "$apps" 0.1.0-beta.1
  expect_token_only_to_api
  expect_token_hidden
  expect_clean

  gh_case token-only-a-beta-yet
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com/repos/BreakPatch/betaonly
  expect_code 1
  expect_out "There's no Breakpatch release yet, or BREAKPATCH_GITHUB_TOKEN can't read BreakPatch/breakpatch."
  expect_no_app "$apps"
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com/repos/BreakPatch/betaonly BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_version "$apps" 0.1.0-beta.1
  expect_token_hidden

  gh_case private-without-token
  run_gh BREAKPATCH_CHANNEL=beta
  expect_code 1
  expect_out "There's no Breakpatch release yet."
  expect_no_out "Using BREAKPATCH_GITHUB_TOKEN"
  expect_no_gh "auth=[^-]" "an Authorization header"
  expect_no_app "$apps"

  gh_case token-refused
  run_gh BREAKPATCH_GITHUB_TOKEN=github_pat_expired0000 BREAKPATCH_CHANNEL=beta
  expect_code 1
  expect_out "GitHub didn't accept BREAKPATCH_GITHUB_TOKEN. It may have expired: make a new one."
  expect_no_out github_pat_expired0000
  run_gh BREAKPATCH_GITHUB_TOKEN="$token"$'\nX-Evil: 1'
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN isn't a GitHub token (they're letters, digits and _ only)."
  expect_no_out "$token"
  expect_no_app "$apps"
  expect_clean

  gh_case token-only-for-api-github-com
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API="$base/good"
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN is only ever sent to https://api.github.com/, and BREAKPATCH_API isn't there."
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com.evil.example/repos/BreakPatch/breakpatch
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN is only ever sent to https://api.github.com/"
  if [ ! -s "$c/state/curl-args" ]; then ok "nothing was fetched"; else bad "fetched: $(tr '\n' ';' < "$c/state/curl-args")"; fi
  expect_no_app "$apps"
  expect_clean

  gh_case token-needs-a-current-curl
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" FAKE_CURL_VERSION=7.79.1
  expect_code 1
  expect_out "With BREAKPATCH_GITHUB_TOKEN the installer needs curl 7.83 or later (this Mac has 7.79)."
  if [ ! -s "$gh_log" ]; then ok "nothing was sent to GitHub"; else bad "sent: $(tr '\n' ';' < "$gh_log")"; fi
  expect_no_app "$apps"

  gh_case token-files-from-another-repo
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com/repos/BreakPatch/evil
  expect_code 1
  expect_out "Breakpatch 0.2.0 lists a file that isn't from Breakpatch's releases, so nothing was installed."
  expect_no_gh "/releases/assets/" "a download"
  expect_no_app "$apps"
  expect_clean

  gh_case token-redirect-to-http
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com/repos/BreakPatch/httpredirect
  expect_code 1
  expect_out "The download stopped."
  expect_no_gh "^objects" "a plain http download"
  expect_no_app "$apps"
  expect_token_hidden
  expect_clean

  new_case cut-short-download
  # Half the script, as a dropped connection would leave it: main never runs.
  head -c "$(( $(wc -c < "$script") / 2 ))" "$script" > "$c/half"
  set +e
  out=$(env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" \
        BREAKPATCH_API="$base/good" BREAKPATCH_APPS_DIR="$apps" "${shell_cmd[@]}" -s < "$c/half" 2>&1)
  set -e
  expect_no_app "$apps"
  expect_no_log "open"
  expect_no_out "Installing"

  # ---- Linux x86_64 (the desktop app's preview)

  new_case linux-fresh-install
  run_piped FAKE_OS=Linux FAKE_ARCH=x86_64 DISPLAY= WAYLAND_DISPLAY=
  expect_code 0
  expect_out "Installing Breakpatch 1.1.0…"
  expect_out "Checked the download against the release's checksums. Install minisign to also check it's signed by Breakpatch."
  expect_out "Breakpatch is in ~/.local/bin/breakpatch, and in your apps menu."
  expect_out "Open it from your apps menu."
  expect_linux_app 1.1.0
  expect_entry "Exec=\"$(lbin)\" %u"
  expect_entry "MimeType=x-scheme-handler/breakpatch;application/x-breakpatch-workspace;"
  expect_entry "Icon=breakpatch"
  if grep -qx "icon 1.1.0" "$c/home/.local/share/icons/hicolor/128x128/apps/breakpatch.png" 2>/dev/null; then ok "the icon is in place"; else bad "no icon"; fi
  expect_log "update-desktop-database $c/home/.local/share/applications"
  expect_no_log "started"
  expect_no_app "$apps"
  expect_no_log "codesign"
  expect_linux_clean

  new_case linux-update-and-open
  run_linux BREAKPATCH_VERSION=1.0.0
  expect_code 0
  expect_linux_app 1.0.0
  run_linux DISPLAY=:99
  expect_code 0
  expect_out "Updating Breakpatch to 1.1.0…"
  expect_out "Opening it now."
  expect_linux_app 1.1.0
  for _ in $(seq 50); do grep -q started "$c/state/log" && break; sleep 0.1; done
  expect_log "started 1.1.0"
  expect_linux_clean

  new_case linux-update-while-open
  run_linux
  touch "$c/state/running"
  : > "$c/state/log"
  run_linux WAYLAND_DISPLAY=wayland-0
  expect_code 0
  expect_out "Breakpatch is open: quit it and open it again to use 1.1.0."
  expect_no_out "Opening it now."
  sleep 0.2
  expect_no_log "started"
  expect_linux_app 1.1.0

  new_case linux-without-fuse
  run_linux DISPLAY=:99 PATH="$(nofuse_path)"
  expect_code 0
  expect_out "Breakpatch is an AppImage, which needs FUSE to start, and this computer doesn't have it."
  expect_out "sudo apt install"
  expect_no_out "Opening it now."
  expect_linux_app 1.1.0

  new_case linux-bad-checksum
  run_linux BREAKPATCH_VERSION=1.0.0
  run_linux BREAKPATCH_API="$base/bad" BREAKPATCH_DOWNLOADS="$base/bad/download/"
  expect_code 1
  expect_out "The download doesn't match its checksum, so it wasn't installed."
  expect_linux_app 1.0.0
  expect_linux_clean

  new_case linux-release-without-linux
  run_linux BREAKPATCH_API="$base/maconly" BREAKPATCH_DOWNLOADS="$base/maconly/download/"
  expect_code 1
  expect_out "Breakpatch 1.6.0 has no Linux version. The Linux app is a preview"
  expect_no_linux_app

  new_case linux-files-from-elsewhere
  run_linux BREAKPATCH_API="$base/foreign" BREAKPATCH_DOWNLOADS="$base/foreign/download/"
  expect_code 1
  expect_out "Breakpatch 1.4.0 lists a file that isn't from Breakpatch's releases, so nothing was installed."
  expect_no_linux_app

  new_case linux-needs-x86_64-and-glibc
  run_linux FAKE_ARCH=aarch64
  expect_code 1
  expect_out "Breakpatch for Linux needs a 64-bit Intel or AMD processor (x86_64) and glibc 2.35 or later: Ubuntu 22.04, Debian 12, Fedora 36 or later. This computer has aarch64."
  run_linux FAKE_GLIBC=2.31
  expect_code 1
  expect_out "This computer has glibc 2.31."
  run_linux FAKE_GLIBC=2.35
  expect_code 0
  run_linux FAKE_GLIBC=none
  expect_code 1
  expect_out "Couldn't find glibc on this computer."

  new_case linux-from-the-deb
  run_linux FAKE_DEB=1
  expect_code 1
  expect_out "Breakpatch is installed from its .deb package here, so update it the same way"
  expect_no_linux_app
  run_linux FAKE_DEB=1 -- --uninstall
  expect_code 1
  expect_out "Remove it with: sudo apt remove breakpatch"

  new_case linux-minisign
  run_linux PATH="$mshims:$shims:$PATH"
  expect_code 0
  expect_log "minisign -V -q -P RWQbw3MJi+i+MQ97FPaAqkP2nnccBb+ySDCUH1PqiwViaG6y9TNEQszX -m"
  expect_no_out "Install minisign"
  run_linux PATH="$mshims:$shims:$PATH" FAKE_MINISIGN=bad BREAKPATCH_VERSION=1.0.0
  expect_code 1
  expect_out "The download isn't signed with Breakpatch's key, so it wasn't installed."
  expect_linux_app 1.1.0
  expect_linux_clean

  new_case linux-bin-folder-with-a-quote
  run_linux BREAKPATCH_BIN="$c/home/my\"bin"
  expect_code 1
  expect_out "the path has a character a desktop entry can't hold"

  new_case linux-uninstall
  run_linux
  mkdir -p "$c/home/.local/share/mime/packages" "$c/home/.local/share/Breakpatch"
  echo x > "$c/home/.local/share/mime/packages/breakpatch.xml"
  echo x > "$c/home/.local/share/applications/breakpatch-handler.desktop"
  echo model > "$c/home/.local/share/Breakpatch/weights"
  run_linux -- --uninstall
  expect_code 0
  expect_out "Removed Breakpatch from ~/.local/bin and your apps menu."
  expect_out "Your tests are still in the tests folder you picked."
  # shellcheck disable=SC2088
  expect_out "~/.local/share/Breakpatch and ~/.local/share/dev.breakpatch.app"
  expect_no_linux_app
  for f in applications/breakpatch.desktop applications/breakpatch-handler.desktop mime/packages/breakpatch.xml icons/hicolor/128x128/apps/breakpatch.png; do
    if [ ! -e "$c/home/.local/share/$f" ]; then ok "removed $f"; else bad "$f is still there"; fi
  done
  expect_log "update-mime-database $c/home/.local/share/mime"
  if [ -f "$c/home/.local/share/Breakpatch/weights" ]; then ok "Breakpatch's data is kept"; else bad "Breakpatch's data was deleted"; fi
  run_linux -- --uninstall
  expect_code 0
  expect_out "Nothing to remove."

  new_case linux-help-and-root
  run_linux -- --help
  expect_code 0
  expect_out "Installs or updates Breakpatch on this computer (Linux x86_64, a preview)."
  expect_no_out "this Mac"
  run_linux FAKE_UID=0
  expect_code 1
  expect_out "Don't run the installer with sudo or as root."
  expect_no_linux_app
done

echo
if [ ${#failures[@]} -eq 0 ]; then
  echo "test-install: all $pass checks passed"
else
  echo "test-install: ${#failures[@]} failed, $pass passed:"
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
