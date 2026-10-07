#!/usr/bin/env bash
# Tests the breakpatch-ci install command (site/install-ci, served at
# https://breakpatch.dev/install-ci) on Linux, the way scripts/test-install.sh tests the app's.
#
#   scripts/test-install-ci.sh
#
# It serves fake releases from this machine over https (GitHub API JSON, SHA256SUMS, a
# breakpatch-ci-requirements-<platform>.txt per platform and the two small wheels it names; a
# throwaway certificate that curl is told to trust). The wheels are stand-ins, so pip installs
# offline (PIP_NO_INDEX): the "engine" brings a playwright module that only notes how it was
# asked to install Chromium, and the "Team engine" a breakpatch-ci that prints its version. The
# macOS-only commands (sw_vers, sysctl) and uname are small scripts on PATH, and a Python stand-in
# can say it's another version or an Apple Silicon build. The installer runs with /bin/sh and with
# bash --posix, and is linted with shellcheck. Needs python3.11, curl, openssl and sha256sum.
#
# site/install-ci.ps1 (Windows) runs against the same fake releases with PowerShell 7 (pwsh, or
# PWSH=/path/to/pwsh) when there is one, on this Linux machine: OS=Windows_NT and
# PROCESSOR_ARCHITECTURE say it's Windows, and it finds bin/ where Windows has Scripts\. Without
# pwsh those cases are skipped, and say so. The token cases and the .cmd command itself need a
# real Windows machine.
#
# The private beta (BREAKPATCH_GITHUB_TOKEN) runs against the same stand-in for api.github.com and
# objects.githubusercontent.com as scripts/test-install.sh, reached through connect-to lines in the
# test home's .curlrc, and checks the token only ever goes to api.github.com.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
script="$repo/site/install-ci"
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-test-install-ci.XXXXXX")
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

py311=$(command -v python3.11 || true)
[ -n "$py311" ] || { echo "test-install-ci: needs python3.11" >&2; exit 1; }

# ---------------------------------------------------------------- shellcheck

if ! command -v shellcheck >/dev/null; then
  echo "installing shellcheck"
  if [ "$(id -u)" -eq 0 ]; then apt-get install -y -qq shellcheck >/dev/null; else sudo apt-get install -y -qq shellcheck >/dev/null; fi
fi
echo "shellcheck site/install-ci"
shellcheck "$script"

# ---------------------------------------------------------------- platform names

# site/install-ci carries its own copy of scripts/platform.sh's names (it's downloaded on its
# own). Its check_platform must give the platform bp_platform gives for every uname pair the
# build scripts know, and refuse the rest; the extra checks it makes (Rosetta, a 32-bit system,
# the macOS version) are on top. Windows goes to install-ci.ps1, whose one platform is checked too.
echo "platform names: site/install-ci and scripts/platform.sh"
current="platform names"
# shellcheck source=platform.sh
. "$repo/scripts/platform.sh"
ci_platform_fns=$(awk '/^fail\(\) /{ print } /^check_platform\(\) \{/{ on = 1 } on { print } on && /^}/{ exit }' "$script")
# ci_platform: install-ci's platform for OS_ and ARCH_, or "refused: <its words>".
ci_platform() {
  # shellcheck disable=SC2016
  sh -c "$ci_platform_fns"'
    uname() { case "$1" in -s) echo "$OS_" ;; -m) echo "$ARCH_" ;; esac; }
    sw_vers() { echo 15.1; }
    sysctl() { echo "${TRANSLATED_:-0}"; }
    getconf() { echo 64; }
    check_platform && echo "$platform"' > "$work/platform.out" 2>&1 || true
  sed '2,$d; /^[a-z]*-[a-z0-9_]*$/!s/^/refused: /' "$work/platform.out"
}
for pair in Linux:x86_64 Linux:amd64 Linux:aarch64 Linux:arm64 Darwin:arm64 Darwin:x86_64 \
  Linux:armv7l Linux:i686 Darwin:i386 FreeBSD:amd64 MINGW64_NT-10.0:x86_64 MSYS_NT-10.0:x86_64 CYGWIN_NT-10.0:x86_64; do
  os=${pair%%:*} arch=${pair#*:}
  want=$(bp_platform "$os" "$arch" || echo none)
  got=$(OS_=$os ARCH_=$arch ci_platform)
  case "$want" in
    windows-*) if [ "$got" = "refused: On Windows, install breakpatch-ci from PowerShell: irm https://breakpatch.dev/install-ci.ps1 | iex" ]; then
                 ok "$os $arch: to install-ci.ps1 ($want)"; else bad "$os $arch: install-ci says '$got', not the PowerShell command"; fi ;;
    none) case "$got" in refused:*) ok "$os $arch: neither builds for it" ;; *) bad "$os $arch: install-ci says $got, platform.sh has no platform" ;; esac ;;
    *) if [ "$got" = "$want" ]; then ok "$os $arch: $want"; else bad "$os $arch: install-ci says '$got', platform.sh $want"; fi ;;
  esac
done
# Under Rosetta a Terminal says x86_64 on Apple Silicon: that's still the Mac's own platform.
got=$(OS_=Darwin ARCH_=x86_64 TRANSLATED_=1 ci_platform)
if [ "$got" = "$(bp_platform Darwin arm64)" ]; then ok "Darwin x86_64 under Rosetta: $got"; else bad "under Rosetta install-ci says '$got'"; fi
if grep -q "\$Platform = '$(bp_platform MINGW64_NT-10.0 x86_64)'" "$repo/site/install-ci.ps1"; then
  ok "install-ci.ps1 installs $(bp_platform MINGW64_NT-10.0 x86_64)"
else bad "install-ci.ps1's \$Platform isn't platform.sh's Windows name"; fi

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
chmod 755 "$tls"
chmod 644 "$tls"/*

# $1 folder, $2 version: the two stand-in wheels and a requirements file per platform naming
# them, like scripts/build-ci.sh writes. Options: bad-hash (the requirements file's hash for the
# Team wheel is wrong), url (it also names a package by address), extra (a third wheel), crlf
# (CRLF line endings, as Python's text mode wrote it on Windows for v0.1.0-beta.1).
make_ci_files() {
  "$py311" - "$@" <<'PY'
import base64, hashlib, os, sys, zipfile
dl, version, opts = sys.argv[1], sys.argv[2], sys.argv[3:]
pep = version.replace("-beta.", "b").replace("-rc.", "rc")

def wheel(name, files, scripts=None):
    dist = name.replace("_", "-")
    info = f"{name}-{pep}.dist-info"
    files = dict(files)
    files[f"{info}/METADATA"] = f"Metadata-Version: 2.1\nName: {dist}\nVersion: {pep}\n"
    files[f"{info}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    if scripts:
        files[f"{info}/entry_points.txt"] = "[console_scripts]\n" + "".join(f"{k} = {v}\n" for k, v in scripts.items())
    rec = []
    for n, d in files.items():
        h = base64.urlsafe_b64encode(hashlib.sha256(d.encode()).digest()).rstrip(b"=").decode()
        rec.append(f"{n},sha256={h},{len(d.encode())}")
    files[f"{info}/RECORD"] = "\n".join(rec) + f"\n{info}/RECORD,,\n"
    path = os.path.join(dl, f"{name}-{pep}-py3-none-any.whl")
    with zipfile.ZipFile(path, "w") as z:
        for n, d in files.items():
            z.writestr(n, d)
    return path

playwright = '''import os, sys
state = os.environ.get("FAKE_STATE")
if state:
    with open(os.path.join(state, "playwright"), "a") as f:
        f.write(" ".join(sys.argv[1:]) + " | " + os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "-") + "\\n")
if os.environ.get("FAKE_PLAYWRIGHT") == "fail":
    print("Failed to download Chromium"); sys.exit(1)
os.makedirs(os.path.join(os.environ["PLAYWRIGHT_BROWSERS_PATH"], "chromium-9999"), exist_ok=True)
'''
engine = wheel("breakpatch_engine", {"breakpatch_engine/__init__.py": f'__version__ = "{version}"\n',
                                     "playwright/__init__.py": "", "playwright/__main__.py": playwright})
ci = f'def main():\n    import sys\n    print("{version}")\n    return 0\n'
team = wheel("breakpatch_team_engine", {"breakpatch_team_engine/__init__.py": "", "breakpatch_team_engine/ci.py": ci},
             {"breakpatch-ci": "breakpatch_team_engine.ci:main"})
extra = wheel("sneaky", {"sneaky/__init__.py": ""}) if "extra" in opts else None

def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()

for platform in ("linux-x86_64", "linux-arm64", "macos-arm64", "windows-x86_64"):
    # As scripts/ci-requirements.py writes it: its header names the install command's address.
    lines = ["# breakpatch-ci on " + platform, "# a comment with ./not-a-wheel.whl in it",
             "# Installed by https://breakpatch.dev/install-ci with:"]
    if "url" in opts:
        lines.append("evil @ https://example.com/evil-1.0-py3-none-any.whl --hash=sha256:" + "0" * 64)
    lines.append(f"./{os.path.basename(engine)} --hash=sha256:{sha(engine)}")
    lines.append(f"./{os.path.basename(team)} --hash=sha256:{'1' * 64 if 'bad-hash' in opts else sha(team)}")
    if extra:
        lines.append(f"./{os.path.basename(extra)} --hash=sha256:{sha(extra)}")
    with open(os.path.join(dl, f"breakpatch-ci-requirements-{platform}.txt"), "w",
              newline="\r\n" if "crlf" in opts else "\n") as f:
        f.write("\n".join(lines) + "\n")
PY
}

# $1 API root name, $2 version, then options: latest (also releases/latest), prerelease, draft,
# app-only (no breakpatch-ci files), bad-sum (the Team wheel's line in SHA256SUMS is wrong),
# no-team-wheel (the requirements name a wheel the release doesn't have), foreign (the files are
# listed on another host), bad-hash, url, extra, crlf (see make_ci_files).
make_release() {
  local api=$1 version=$2 tag="v$2" latest=0 pre=0 draft=0 apponly=0 badsum=0 noteam=0 dl url
  local ci_opts=()
  shift 2
  url="$base/$api/download/$tag"
  for o in "$@"; do
    case "$o" in
      latest) latest=1 ;; prerelease) pre=1 ;; draft) draft=1 ;; app-only) apponly=1 ;; bad-sum) badsum=1 ;;
      no-team-wheel) noteam=1 ;; foreign) url="https://localhost:$port/$api/download/$tag" ;;
      bad-hash | url | extra | crlf) ci_opts+=("$o") ;;
    esac
  done
  dl="$srv/$api/download/$tag"
  mkdir -p "$dl" "$srv/$api/releases/tags"
  echo "app" > "$dl/Breakpatch_aarch64.app.tar.gz"
  [ "$apponly" -eq 1 ] || make_ci_files "$dl" "$version" ${ci_opts[@]+"${ci_opts[@]}"}
  (cd "$dl" && sha256sum -- * > SHA256SUMS)
  if [ "$badsum" -eq 1 ]; then
    sed -i 's/^[0-9a-f]\{64\}\(  breakpatch_team_engine-\)/0000000000000000000000000000000000000000000000000000000000000000\1/' "$dl/SHA256SUMS"
  fi
  if [ "$noteam" -eq 1 ]; then rm "$dl"/breakpatch_team_engine-*.whl; fi
  python3 - "$dl" "$url" "$tag" "$srv/$api/releases" "$latest" "$pre" "$draft" <<'PY'
import json, os, sys
dl, url, tag, releases, latest, pre, draft = sys.argv[1:]
assets = [{"name": n, "size": os.path.getsize(os.path.join(dl, n)), "browser_download_url": f"{url}/{n}"} for n in sorted(os.listdir(dl))]
doc = {"url": "x", "tag_name": tag, "name": f"Breakpatch {tag}", "draft": draft == "1", "prerelease": pre == "1",
       "assets": assets, "body": 'Install breakpatch-ci with {curl}. "Quoted", and "tag_name": "v0.0.1" in text.'}
with open(os.path.join(releases, "tags", tag), "w") as f: json.dump(doc, f, indent=2)
if latest == "1":
    with open(os.path.join(releases, "latest"), "w") as f: json.dump(doc, f)
PY
}

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
make_release good 1.2.0-beta.1 prerelease
make_release good 1.3.0-beta.1 prerelease draft
make_list good v1.3.0-beta.1 v1.2.0-beta.1 v1.1.0 v1.0.0
make_release apponly 1.4.0 latest app-only
make_release badsum 1.5.0 latest bad-sum
make_release noteam 1.6.0 latest no-team-wheel
make_release foreign 1.7.0 latest foreign
make_release badhash 1.8.0 latest bad-hash
make_release url 1.9.0 latest url
make_release extra 2.0.0 latest extra
make_release crlf 2.1.0 latest crlf
mkdir -p "$srv/empty/releases"
echo "[]" > "$srv/empty/releases/list.json"

# ---- the private repository, as api.github.com shows it to a token that can read it

token=github_pat_11TESTTOKEN0_privateBetaSecretValue42
gh="$srv/gh"
mkdir -p "$gh/assets"
echo 1000 > "$gh/next-id"

# $1 repository (under BreakPatch/), $2 version, then options: latest, prerelease. Each file's
# API address in "url" (what a token downloads), compact JSON as api.github.com writes it.
make_private_release() {
  local repo=$1 version=$2 tag="v$2" dl
  shift 2
  dl="$work/gh-stage/$repo/$tag"
  mkdir -p "$dl"
  make_ci_files "$dl" "$version"
  (cd "$dl" && sha256sum -- * > SHA256SUMS)
  python3 - "$dl" "$tag" "$gh" "$repo" "$@" <<'PY'
import json, os, shutil, sys
dl, tag, gh, repo, opts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
api = f"https://api.github.com/repos/BreakPatch/{repo}"
nid = int(open(f"{gh}/next-id").read())
assets = []
for n in sorted(os.listdir(dl)):
    nid += 1
    shutil.copy(os.path.join(dl, n), f"{gh}/assets/{nid}")
    assets.append({"url": f"{api}/releases/assets/{nid}", "id": nid, "name": n,
                   "browser_download_url": f"https://github.com/BreakPatch/{repo}/releases/download/{tag}/{n}"})
open(f"{gh}/next-id", "w").write(str(nid))
doc = {"url": f"{api}/releases/{nid}", "id": nid, "tag_name": tag, "name": f"Breakpatch {tag}", "draft": False,
       "prerelease": "prerelease" in opts, "assets": assets, "body": 'Beta. {"tag_name": "v0.0.1"}'}
rel = f"{gh}/repos/BreakPatch/{repo}/releases"
os.makedirs(f"{rel}/tags", exist_ok=True)
def write(path, d):
    with open(path, "w") as f: f.write(json.dumps(d, separators=(",", ":")))
write(f"{rel}/tags/{tag}", doc)
if "latest" in opts: write(f"{rel}/latest", doc)
listed = json.load(open(f"{rel}/list.json")) if os.path.exists(f"{rel}/list.json") else []
write(f"{rel}/list.json", [doc] + listed)
PY
}

make_private_release breakpatch 0.0.9 latest
make_private_release breakpatch 0.1.0-beta.1 prerelease
make_private_release httpredirect 0.3.0 latest

# ---- a stand-in python-build-standalone download: python/bin/python3.11 is this machine's 3.11
# (a link), so the environment made from it works offline. Its SHA-256 goes to the installer in
# BREAKPATCH_PYTHON_SHA256, with BREAKPATCH_PYTHON_DOWNLOADS pointing here.
pbs_release=$(sed -n 's/^PBS_RELEASE=//p' "$script")
pbs_version=$(sed -n 's/^PBS_VERSION=//p' "$script")
mkdir -p "$work/pbs-stage/python/bin" "$srv/pbs/$pbs_release"
ln -s "$py311" "$work/pbs-stage/python/bin/python3.11"
for triple in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu aarch64-apple-darwin x86_64-pc-windows-msvc; do
  tar -czf "$srv/pbs/$pbs_release/cpython-$pbs_version+$pbs_release-$triple-install_only_stripped.tar.gz" -C "$work/pbs-stage" python
done
pbs_sha=$(sha256sum "$srv/pbs/$pbs_release/cpython-$pbs_version+$pbs_release-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz" | awk '{ print $1 }')

# The same files over https (what the installer uses) and plain http (which it must refuse).
# The GitHub stand-in answers by Host and logs "host path auth=<Authorization or ->" to gh.log
# (the same server as scripts/test-install.sh).
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

# ---------------------------------------------------------------- stand-ins

shims="$work/shims"
mkdir -p "$shims"
real_uname=$(command -v uname)
cat > "$shims/uname" <<SH
#!/bin/sh
case "\$1" in
  -s) echo "\${FAKE_OS:-Linux}" ;;
  -m) echo "\${FAKE_ARCH:-x86_64}" ;;
  *) exec $real_uname "\$@" ;;
esac
SH
cat > "$shims/sw_vers" <<'SH'
#!/bin/sh
[ "$1" = -productVersion ] && echo "${FAKE_MACOS:-15.1}"
SH
cat > "$shims/sysctl" <<'SH'
#!/bin/sh
echo "${FAKE_TRANSLATED:-0}"
SH
cat > "$shims/getconf" <<'SH'
#!/bin/sh
[ "$1" = LONG_BIT ] && echo "${FAKE_LONG_BIT:-64}"
SH
# A Python 3.11 that says it's FAKE_PY_VERSION (e.g. 3.12) or built for FAKE_PY_ARCH (arm64).
pyshims="$work/py-shims"
mkdir -p "$pyshims"
cat > "$pyshims/python-as" <<SH
#!/bin/sh
case "\$*" in
  *'sys.version_info[:2]'*) if [ -n "\${FAKE_PY_VERSION:-}" ]; then echo "\$FAKE_PY_VERSION"; exit 0; fi ;;
  *'platform.machine()'*) if [ -n "\${FAKE_PY_ARCH:-}" ]; then echo "\$FAKE_PY_ARCH"; exit 0; fi ;;
esac
exec $py311 "\$@"
SH
cat > "$pyshims/python-broken" <<'SH'
#!/bin/sh
exit 1
SH
# curl as the installer runs it, for the token cases: logs its arguments and environment, then
# runs the real curl.
cshims="$work/curl-shims"
mkdir -p "$cshims"
real_curl=$(command -v curl)
cat > "$cshims/curl" <<SH
#!/bin/sh
printf 'curl %s\n' "\$*" >> "\$FAKE_STATE/curl-args"
env >> "\$FAKE_STATE/curl-env"
exec $real_curl "\$@"
SH
chmod +x "$shims"/* "$pyshims"/* "$cshims"/*

# A PATH with no python3 at all: everything in the usual folders but python*.
nopy="$work/no-python"
mkdir -p "$nopy"
for f in /usr/local/bin/* /usr/bin/* /bin/*; do
  n=$(basename "$f")
  case "$n" in python*) continue ;; esac
  [ -e "$nopy/$n" ] || ln -s "$f" "$nopy/$n"
done
# A PATH whose only python3 is a 3.12 (Raspberry Pi OS Trixie, Ubuntu 24.04).
py312="$work/python-3.12"
mkdir -p "$py312"
cat > "$py312/python3" <<SH
#!/bin/sh
case "\$*" in *'sys.version_info[:2]'*) echo 3.12; exit 0 ;; esac
exec $py311 "\$@"
SH
chmod +x "$py312/python3"

# ---------------------------------------------------------------- helpers

# new_case NAME: a fresh home, TMPDIR and state for one run. The case before is deleted: each
# holds a Python environment or two.
new_case() {
  current="$sh_name: $1"
  echo "$current"
  rm -rf "$work/cases"
  c="$work/cases/${sh_name// /}-$1"
  mkdir -p "$c/home" "$c/tmp" "$c/state"
  home="$c/home/.breakpatch-ci"
  bin="$c/home/.local/bin"
}

# run [VAR=value…] [-- args]: runs the installer; output in $out, exit code in $code. Python
# 3.11 is on PATH as python3.11 (py-shims has none by that name, so it's the real one).
run() {
  local vars=() args=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ $# -eq 0 ] || { shift; args=("$@"); }
  set +e
  out=$(env -u GITHUB_PATH HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" PIP_NO_INDEX=1 \
        PIP_DISABLE_PIP_VERSION_CHECK=1 BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" \
        BREAKPATCH_PYTHON="$py311" ${vars[@]+"${vars[@]}"} "${shell_cmd[@]}" "$script" ${args[@]+"${args[@]}"} 2>&1)
  code=$?
  set -e
}

# The same, with the script piped in, as `curl … | sh -s -- args` runs it.
run_piped() {
  local vars=() args=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ $# -eq 0 ] || { shift; args=("$@"); }
  set +e
  out=$(env -u GITHUB_PATH HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" PIP_NO_INDEX=1 \
        PIP_DISABLE_PIP_VERSION_CHECK=1 BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" \
        BREAKPATCH_PYTHON="$py311" ${vars[@]+"${vars[@]}"} "${shell_cmd[@]}" -s -- ${args[@]+"${args[@]}"} < "$script" 2>&1)
  code=$?
  set -e
}

expect_code() { if [ "$code" -eq "$1" ]; then ok "exit $1"; else bad "exit $code, expected $1. Output:"$'\n'"$out"; fi; }
expect_out() { if [[ "$out" == *"$1"* ]]; then ok "says: $1"; else bad "doesn't say: $1. Output:"$'\n'"$out"; fi; }
expect_no_out() { if [[ "$out" != *"$1"* ]]; then ok "doesn't say: $1"; else bad "says: $1"; fi; }
# The installed breakpatch-ci, through the link in bin, says this version.
expect_version() {
  local v; v=$("$bin/breakpatch-ci" --version 2>/dev/null || true)
  if [ "$v" = "$1" ]; then ok "breakpatch-ci $1 is installed"; else bad "breakpatch-ci says '${v:-nothing}', expected $1"; fi
}
expect_none() {
  if [ ! -e "$home/current" ] && [ ! -e "$bin/breakpatch-ci" ]; then ok "nothing installed"; else bad "something was installed"; fi
}
envs() { find "$home" -maxdepth 1 -name 'env-*' 2>/dev/null | wc -l | tr -d ' '; }
expect_envs() { local n; n=$(envs); if [ "$n" -eq "$1" ]; then ok "$1 environment(s) in the install folder"; else bad "$n environments, expected $1"; fi; }
expect_clean() {
  local left="" f
  for f in "$c/tmp"/* "$c/tmp"/.[!.]* "$bin"/.[!.]* "$home"/.[!.]*; do
    [ ! -e "$f" ] || left="$left $f"
  done
  if [ -z "$left" ]; then ok "nothing left behind"; else bad "left behind:$left"; fi
}
gh_case() {
  new_case "$1"
  printf 'connect-to = api.github.com:443:127.0.0.1:%s\nconnect-to = objects.githubusercontent.com:443:127.0.0.1:%s\n' \
    "$gh_port" "$gh_port" > "$c/home/.curlrc"
  : > "$gh_log"
  : > "$c/state/curl-args"; : > "$c/state/curl-env"
}
run_gh() { run BREAKPATCH_API= BREAKPATCH_DOWNLOADS= CURL_HOME="$c/home" PATH="$cshims:$shims:$PATH" "$@"; }
expect_gh() { if grep -qE -- "$1" "$gh_log"; then ok "GitHub got: $2"; else bad "GitHub didn't get: $2 (log: $(tr '\n' ';' < "$gh_log"))"; fi; }
expect_no_gh() { if ! grep -qE -- "$1" "$gh_log"; then ok "GitHub didn't get: $2"; else bad "GitHub got: $2"; fi; }
expect_token_hidden() {
  expect_no_out "$token"
  if ! grep -qF -- "$token" "$c/state/curl-args"; then ok "the token isn't in curl's arguments"; else bad "the token is in curl's arguments"; fi
  if ! grep -qF -- "$token" "$c/state/curl-env"; then ok "the token isn't in curl's environment"; else bad "the token is in curl's environment"; fi
  if ! grep -rqF -- "$token" "$c/tmp" "$c/home/.breakpatch-ci" "$c/home/.local" 2>/dev/null; then ok "the token isn't in a file left behind"; else bad "the token is in a file left behind"; fi
}

# ---------------------------------------------------------------- the release's check

# scripts/check-ci-requirements.sh, which release.yml's publish-ci runs on every platform's files
# before it publishes them, and the files scripts/ci-requirements.py writes for each platform.
if [ "${ONLY:-}" != pwsh ]; then
  echo "the release's check: scripts/check-ci-requirements.sh"
  current="release check"
  check="$repo/scripts/check-ci-requirements.sh"
  check_dir() { set +e; out=$(bash "$check" "$1" 2>&1); code=$?; set -e; }
  check_dir "$srv/good/download/v1.1.0"
  expect_code 0
  for p in linux-x86_64 linux-arm64 macos-arm64 windows-x86_64; do expect_out "breakpatch-ci-requirements-$p.txt: breakpatch_engine-"; done
  check_dir "$srv/crlf/download/v2.1.0"
  expect_code 1
  expect_out "has CRLF line endings"
  check_dir "$srv/extra/download/v2.0.0"
  expect_code 1
  expect_out "doesn't name two wheels"
  check_dir "$srv/url/download/v1.9.0"
  expect_code 1
  expect_out "names a package by address"
  check_dir "$srv/badhash/download/v1.8.0"
  expect_code 1
  expect_out "names a wheel that isn't in"
  check_dir "$srv/noteam/download/v1.6.0"
  expect_code 1
  expect_out "names a wheel that isn't in"
  check_dir "$srv/apponly/download/v1.4.0"
  expect_code 1
  expect_out "no breakpatch-ci-requirements-*.txt in"

  # scripts/ci-requirements.py itself, for each platform's Team wheel tag, with the engine's
  # dependencies stood in for (its lock and what's installed are the build's). It writes LF on
  # every platform: bytes, never text mode, which writes CRLF on Windows.
  echo "the release's check: scripts/ci-requirements.py's files"
  current="ci-requirements.py"
  gen="$work/gen"
  for p in linux-x86_64:manylinux_2_28_x86_64 linux-arm64:manylinux_2_28_aarch64 macos-arm64:macosx_11_0_arm64 windows-x86_64:win_amd64; do
    platform=${p%%:*} tag=${p#*:}
    rm -rf "$gen"; mkdir -p "$gen"
    echo engine > "$gen/breakpatch_engine-0.1.0b1-py3-none-any.whl"
    echo "team $tag" > "$gen/breakpatch_team_engine-0.1.0b1-cp311-cp311-$tag.whl"
    printf 'cryptography==46.0.1 \\\r\n    --hash=sha256:%064d\r\n' 0 > "$gen/lock.txt"   # a lock checked out with CRLF
    set +e
    out=$("$py311" - "$repo/scripts/ci-requirements.py" "$gen" "$platform" "$tag" 2>&1 <<'PY'
import importlib.util, sys
script, gen, platform, tag = sys.argv[1:]
spec = importlib.util.spec_from_file_location("ci_requirements", script)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.runtime_closure = lambda *a, **k: ["cryptography"]
sys.argv = [script, "--lock", f"{gen}/lock.txt", "--platform", platform, "--out", f"{gen}/breakpatch-ci-requirements-{platform}.txt",
            "--wheel", f"{gen}/breakpatch_engine-0.1.0b1-py3-none-any.whl",
            "--wheel", f"{gen}/breakpatch_team_engine-0.1.0b1-cp311-cp311-{tag}.whl"]
sys.exit(m.main())
PY
)
    code=$?
    set -e
    expect_code 0
    req="$gen/breakpatch-ci-requirements-$platform.txt"
    if ! grep -q $'\r' "$req"; then ok "$platform: LF line endings"; else bad "$platform: the file has a CR"; fi
    if grep -qxF "cryptography==46.0.1 \\" "$req"; then ok "$platform: the lock's pin, without its CR"; else bad "$platform: no cryptography pin: $(cat "$req")"; fi
    check_dir "$gen"
    expect_code 0
    expect_out "breakpatch-ci-requirements-$platform.txt: breakpatch_engine-0.1.0b1-py3-none-any.whl breakpatch_team_engine-0.1.0b1-cp311-cp311-$tag.whl ok"
    # The file as text mode wrote it on Windows (v0.1.0-beta.1): refused, and saying why.
    sed -i 's/$/\r/' "$req"
    check_dir "$gen"
    expect_code 1
    expect_out "breakpatch-ci-requirements-$platform.txt has CRLF line endings"
  done
fi

# ---------------------------------------------------------------- the cases

# ONLY=pwsh runs the install-ci.ps1 cases alone.
for sh_name in "sh" "bash --posix"; do
  [ "${ONLY:-}" != pwsh ] || break
  read -r -a shell_cmd <<< "$sh_name"

  new_case fresh-install-linux
  run_piped
  expect_code 0
  expect_out "Installing breakpatch-ci 1.1.0…"
  expect_out "Linux is a preview: breakpatch-ci runs tests there, and they're recorded on a Mac."
  expect_out "Installing the Python packages (checked against their hashes)…"
  expect_out "breakpatch-ci 1.1.0 is in ~/.breakpatch-ci."
  expect_out "install the libraries it needs: sudo ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium"
  # shellcheck disable=SC2088  # the message shows a ~
  expect_out "~/.local/bin isn't on your PATH. Add it, for example: export PATH=\"$bin:\$PATH\""
  expect_out "https://breakpatch.dev/docs/#from-ci-with-breakpatch-ci"
  expect_version 1.1.0
  expect_envs 1
  if grep -qx "install chromium --no-shell | $home/browsers" "$c/state/playwright"; then ok "Chromium went into ~/.breakpatch-ci/browsers"; else bad "playwright was run as: $(cat "$c/state/playwright" 2>/dev/null)"; fi
  if [ -d "$home/browsers/chromium-9999" ]; then ok "the browser folder is there"; else bad "no browser folder"; fi
  marker="$home/current/breakpatch-ci.json"
  if grep -q '"version": "1.1.0"' "$marker" && grep -q '"browsers": "../browsers"' "$marker"; then ok "breakpatch-ci.json points at the browsers"; else bad "breakpatch-ci.json: $(cat "$marker" 2>/dev/null)"; fi
  if [ "$(readlink "$bin/breakpatch-ci")" = "$home/current/bin/breakpatch-ci" ]; then ok "the command links to current"; else bad "the link is $(readlink "$bin/breakpatch-ci")"; fi
  if [ ! -e "$home/python" ]; then ok "no Python was downloaded (this machine has 3.11)"; else bad "a Python was downloaded"; fi
  if [ "$("$home/current/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" = 3.11 ]; then ok "the environment is Python 3.11"; else bad "the environment isn't Python 3.11"; fi
  expect_clean

  new_case update-and-reinstall
  run BREAKPATCH_VERSION=1.0.0
  expect_code 0
  expect_out "Installing breakpatch-ci 1.0.0…"
  first=$(readlink "$home/current")
  run
  expect_code 0
  expect_out "Updating breakpatch-ci 1.0.0 to 1.1.0…"
  expect_version 1.1.0
  expect_envs 1
  if [ ! -e "$home/$first" ]; then ok "the old environment is gone"; else bad "the old environment is still there"; fi
  run
  expect_code 0
  expect_out "Reinstalling breakpatch-ci 1.1.0…"
  expect_envs 1
  expect_clean

  new_case on-path-and-github-path
  run PATH="$bin:$shims:$PATH"
  expect_code 0
  expect_out "Run it with: breakpatch-ci run --test path/to/test.json"
  expect_no_out "isn't on your PATH"
  : > "$c/state/github-path"
  run GITHUB_PATH="$c/state/github-path"
  expect_code 0
  expect_out "Added ~/.local/bin to GITHUB_PATH: the next steps of this job can run breakpatch-ci."
  if [ "$(cat "$c/state/github-path")" = "$bin" ]; then ok "GITHUB_PATH has the folder"; else bad "GITHUB_PATH has: $(cat "$c/state/github-path")"; fi

  new_case other-folders
  run BREAKPATCH_CI_HOME="$c/ci-tools" BREAKPATCH_CI_BIN="$c/bin"
  expect_code 0
  if [ "$("$c/bin/breakpatch-ci" --version)" = 1.1.0 ] && [ -d "$c/ci-tools/browsers" ]; then ok "installed in BREAKPATCH_CI_HOME, linked in BREAKPATCH_CI_BIN"; else bad "not in the folders asked for"; fi
  expect_none

  new_case mac-apple-silicon
  run FAKE_OS=Darwin FAKE_ARCH=arm64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=arm64
  expect_code 0
  expect_out "Installing breakpatch-ci 1.1.0…"
  expect_no_out "Linux is a preview"
  expect_no_out "install-deps"
  expect_version 1.1.0
  run FAKE_OS=Darwin FAKE_ARCH=x86_64 FAKE_TRANSLATED=1 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=arm64
  expect_code 0
  expect_out "Reinstalling breakpatch-ci 1.1.0…"

  new_case linux-arm64
  run FAKE_ARCH=aarch64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=aarch64
  expect_code 0
  expect_out "Installing breakpatch-ci 1.1.0…"
  expect_out "Linux is a preview: breakpatch-ci runs tests there, and they're recorded on a Mac."
  expect_out "install the libraries it needs: sudo ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium"
  expect_version 1.1.0
  run FAKE_ARCH=aarch64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=x86_64
  expect_code 1
  expect_out "is for x86_64, not this machine."
  run FAKE_ARCH=aarch64 FAKE_LONG_BIT=32
  expect_code 1
  expect_out "This Raspberry Pi or arm computer runs a 32-bit system. Install a 64-bit one"
  run BREAKPATCH_API="$base/apponly" BREAKPATCH_DOWNLOADS="$base/apponly/download/" FAKE_ARCH=aarch64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=aarch64
  expect_code 1
  expect_out "Breakpatch 1.4.0 has no breakpatch-ci for Linux arm64."

  new_case unsupported-machines
  need="breakpatch-ci runs on a Mac with Apple Silicon (M1 or later) and macOS 14 or later, or on 64-bit Linux (x86_64 or arm64) as a preview."
  run FAKE_OS=Darwin FAKE_ARCH=x86_64
  expect_code 1
  expect_out "$need This Mac has an Intel processor."
  run FAKE_OS=Darwin FAKE_ARCH=arm64 FAKE_MACOS=13.6.1
  expect_code 1
  expect_out "$need This Mac has macOS 13.6.1."
  run FAKE_OS=Linux FAKE_ARCH=armv7l
  expect_code 1
  expect_out "$need This machine is Linux on armv7l."
  run FAKE_OS=MINGW64_NT-10.0 FAKE_ARCH=x86_64
  expect_code 1
  expect_out "On Windows, install breakpatch-ci from PowerShell: irm https://breakpatch.dev/install-ci.ps1 | iex"
  run FAKE_OS=Darwin FAKE_ARCH=arm64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=x86_64
  expect_code 1
  expect_out "is a Python for Intel Macs (x86_64). breakpatch-ci needs a Python 3.11 for Apple Silicon (arm64)."
  expect_none

  new_case python-3.11-only
  run BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_VERSION=3.12
  expect_code 1
  expect_out "breakpatch-ci needs Python 3.11, and $pyshims/python-as is Python 3.12."
  expect_out "brew install python@3.11"
  expect_out "set BREAKPATCH_PYTHON to it."
  run BREAKPATCH_PYTHON="$c/no-such-python"
  expect_code 1
  expect_out "BREAKPATCH_PYTHON is $c/no-such-python, which isn't there."
  run BREAKPATCH_PYTHON="$pyshims/python-broken"
  expect_code 1
  expect_out "Couldn't run $pyshims/python-broken."
  run BREAKPATCH_PYTHON= PATH="$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOAD=0
  expect_code 1
  expect_out "breakpatch-ci needs Python 3.11, and this machine has no python3."
  run BREAKPATCH_PYTHON= PATH="$py312:$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOAD=0
  expect_code 1
  expect_out "breakpatch-ci needs Python 3.11, and python3 is Python 3.12."
  expect_none

  new_case python-download
  pbs_dir="$home/python/cpython-$pbs_version+$pbs_release"
  pbs_vars=(BREAKPATCH_PYTHON= BREAKPATCH_PYTHON_DOWNLOADS="$base/pbs/" BREAKPATCH_PYTHON_SHA256="$pbs_sha")
  run "${pbs_vars[@]}" PATH="$shims:$nopy"
  expect_code 0
  expect_out "This machine has no Python 3.11 that breakpatch-ci can use: downloading Python $pbs_version (python-build-standalone $pbs_release)…"
  expect_out "Python $pbs_version is in ~/.breakpatch-ci/python/cpython-$pbs_version+$pbs_release."
  expect_version 1.1.0
  if [ "$("$home/current/bin/python" -c 'import sys; print(sys.base_prefix != sys.prefix)')" = True ] \
    && [ "$(readlink "$home/current/bin/python3.11")" = "$pbs_dir/bin/python3.11" ]; then ok "the environment is made from the downloaded Python"; else bad "the environment isn't from $pbs_dir"; fi
  expect_clean
  run "${pbs_vars[@]}" PATH="$py312:$shims:$nopy"
  expect_code 0
  expect_out "Using Python $pbs_version from ~/.breakpatch-ci/python/cpython-$pbs_version+$pbs_release."
  expect_no_out "downloading Python"
  expect_envs 1
  run
  expect_code 0
  if [ ! -e "$home/python" ]; then ok "the downloaded Python goes once nothing uses it"; else bad "$home/python is still there"; fi

  new_case python-download-checked
  run BREAKPATCH_PYTHON= PATH="$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOADS="$base/pbs/" BREAKPATCH_PYTHON_SHA256="$(printf '%064d' 0)"
  expect_code 1
  expect_out "The download of Python 3.11 doesn't match its checksum, so nothing was installed."
  expect_none
  run BREAKPATCH_PYTHON= PATH="$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOADS="$base/pbs/"
  expect_code 1
  expect_out "There's no checksum for the Python download for this machine, so nothing was installed."
  run BREAKPATCH_PYTHON= PATH="$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOADS="http://127.0.0.1:$http_port/pbs/" BREAKPATCH_PYTHON_SHA256="$pbs_sha"
  expect_code 1
  expect_out "BREAKPATCH_PYTHON_DOWNLOADS must start with https:// and end with /."
  run BREAKPATCH_PYTHON= PATH="$shims:$nopy" BREAKPATCH_PYTHON_DOWNLOADS="$base/no-such-pbs/" BREAKPATCH_PYTHON_SHA256="$pbs_sha"
  expect_code 1
  expect_out "Couldn't download Python 3.11."
  if [ ! -e "$home/python" ] || [ -z "$(ls -A "$home/python")" ]; then ok "no half-unpacked Python left"; else bad "left in python/: $(ls -A "$home/python")"; fi
  expect_none
  expect_clean

  new_case missing-or-old-releases
  run BREAKPATCH_API="$base/apponly" BREAKPATCH_DOWNLOADS="$base/apponly/download/"
  expect_code 1
  expect_out "Breakpatch 1.4.0 has no breakpatch-ci for Linux x86_64. Try an older version with BREAKPATCH_VERSION"
  run BREAKPATCH_API="$base/apponly" BREAKPATCH_DOWNLOADS="$base/apponly/download/" FAKE_OS=Darwin FAKE_ARCH=arm64 BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_ARCH=arm64
  expect_code 1
  expect_out "Breakpatch 1.4.0 has no breakpatch-ci for Apple Silicon Macs."
  run BREAKPATCH_VERSION=9.9.9
  expect_code 1
  expect_out "There's no Breakpatch 9.9.9. The versions are at https://github.com/BreakPatch/breakpatch/releases."
  run BREAKPATCH_API="$base/empty" BREAKPATCH_CHANNEL=beta
  expect_code 1
  expect_out "There's no Breakpatch release yet."
  run BREAKPATCH_API="https://127.0.0.1:9/nothing"
  expect_code 1
  expect_out "Couldn't reach GitHub to find Breakpatch. Check your connection and try again."
  expect_none
  expect_clean

  new_case checksums-and-hashes
  run BREAKPATCH_VERSION=1.0.0
  expect_code 0
  before=$(readlink "$home/current")
  run BREAKPATCH_API="$base/badsum" BREAKPATCH_DOWNLOADS="$base/badsum/download/"
  expect_code 1
  expect_out "The download of breakpatch_team_engine-1.5.0-py3-none-any.whl doesn't match its checksum, so nothing was installed."
  run BREAKPATCH_API="$base/badhash" BREAKPATCH_DOWNLOADS="$base/badhash/download/"
  expect_code 1
  expect_out "Couldn't install breakpatch-ci's Python packages."
  run BREAKPATCH_API="$base/noteam" BREAKPATCH_DOWNLOADS="$base/noteam/download/"
  expect_code 1
  expect_out "Breakpatch 1.6.0's breakpatch-ci is missing breakpatch_team_engine-1.6.0-py3-none-any.whl, so nothing was installed."
  if [ "$(readlink "$home/current")" = "$before" ]; then ok "the version before is still in use"; else bad "current changed"; fi
  expect_version 1.0.0
  expect_envs 1
  expect_clean

  new_case requirements-name-only-the-two-wheels
  run BREAKPATCH_API="$base/url" BREAKPATCH_DOWNLOADS="$base/url/download/"
  expect_code 1
  expect_out "Breakpatch 1.9.0's breakpatch-ci files can't be read, so nothing was installed."
  run BREAKPATCH_API="$base/extra" BREAKPATCH_DOWNLOADS="$base/extra/download/"
  expect_code 1
  expect_out "Breakpatch 2.0.0's breakpatch-ci files can't be read, so nothing was installed."
  expect_none

  new_case files-from-elsewhere
  run BREAKPATCH_API="$base/foreign" BREAKPATCH_DOWNLOADS="$base/foreign/download/"
  expect_code 1
  expect_out "Breakpatch 1.7.0 lists a file that isn't from Breakpatch's releases, so nothing was installed."
  run BREAKPATCH_DOWNLOADS="http://127.0.0.1:$http_port/good/download/"
  expect_code 1
  expect_out "BREAKPATCH_DOWNLOADS must start with https://."
  run BREAKPATCH_API="http://127.0.0.1:$http_port/good"
  expect_code 1
  expect_out "Couldn't reach GitHub to find Breakpatch."
  expect_none

  new_case chromium-fails
  run BREAKPATCH_VERSION=1.0.0
  run FAKE_PLAYWRIGHT=fail
  expect_code 1
  expect_out "Couldn't install Chromium. Check your connection and run this again."
  expect_version 1.0.0
  expect_envs 1
  expect_clean

  new_case not-ours-in-the-way
  mkdir -p "$bin"
  echo "#!/bin/sh" > "$bin/breakpatch-ci"
  run
  expect_code 1
  # shellcheck disable=SC2088  # the message shows a ~
  expect_out "~/.local/bin/breakpatch-ci is there already and isn't this installer's."
  if [ "$(cat "$bin/breakpatch-ci")" = "#!/bin/sh" ]; then ok "the file is untouched"; else bad "the file was changed"; fi

  new_case beta-channel-and-pinned
  run BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Installing breakpatch-ci 1.2.0-beta.1…"
  expect_version 1.2.0-beta.1
  run BREAKPATCH_VERSION=v1.0.0 BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Updating breakpatch-ci 1.2.0-beta.1 to 1.0.0…"
  run BREAKPATCH_CHANNEL=nightly
  expect_code 1
  expect_out "BREAKPATCH_CHANNEL is stable or beta, not nightly."
  run BREAKPATCH_VERSION=1.0/../../evil
  expect_code 1
  expect_out "BREAKPATCH_VERSION is a version like 1.2.3 or 0.1.0-beta.1."

  new_case uninstall
  run
  expect_code 0
  run_piped -- --uninstall
  expect_code 0
  expect_out "Removed breakpatch-ci and its browser from ~/.breakpatch-ci."
  expect_out "Run breakpatch-ci licence release first to give the seat back"
  if [ ! -e "$home" ] && [ ! -e "$bin/breakpatch-ci" ]; then ok "the folder and the link are gone"; else bad "something is left"; fi
  run -- --uninstall
  expect_code 0
  expect_out "breakpatch-ci isn't in ~/.breakpatch-ci. Nothing to remove."

  new_case help-and-unknown-options
  run -- --help
  expect_code 0
  expect_out "curl -fsSL https://breakpatch.dev/install-ci | sh"
  expect_out "--uninstall"
  expect_none
  run -- --bogus
  expect_code 1
  expect_out "Unknown option --bogus."

  # ---- the private beta

  gh_case token-beta-channel
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Using BREAKPATCH_GITHUB_TOKEN (private beta)."
  expect_out "Installing breakpatch-ci 0.1.0-beta.1…"
  expect_version 0.1.0-beta.1
  expect_gh "^api\.github\.com /repos/BreakPatch/breakpatch/releases/assets/[0-9]+ auth=Bearer $token\$" "a file's asset address, with the token"
  expect_no_gh "^api\.github\.com .* auth=-\$" "an API request without the token"
  expect_gh "^objects\.githubusercontent\.com /github-production-release-asset-2e65be/[0-9]+ auth=-\$" "the redirected download, without the token"
  expect_no_gh "^objects\.githubusercontent\.com .* auth=[^-]" "the token at the asset host"
  expect_token_hidden
  expect_clean

  gh_case token-only-for-api-github-com
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API="$base/good"
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN is only ever sent to https://api.github.com/, and BREAKPATCH_API isn't there."
  run_gh BREAKPATCH_GITHUB_TOKEN="$token"$'\nX-Evil: 1'
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN isn't a GitHub token (they're letters, digits and _ only)."
  expect_no_out "$token"
  expect_none

  gh_case private-without-token
  run_gh BREAKPATCH_CHANNEL=beta
  expect_code 1
  expect_out "There's no Breakpatch release yet."
  expect_no_gh "auth=[^-]" "an Authorization header"

  gh_case token-redirect-to-http
  run_gh BREAKPATCH_GITHUB_TOKEN="$token" BREAKPATCH_API=https://api.github.com/repos/BreakPatch/httpredirect
  expect_code 1
  expect_out "Couldn't download the checksums."
  expect_no_gh "^objects" "a plain http download"
  expect_token_hidden
  expect_none

  new_case cut-short-download
  head -c "$(( $(wc -c < "$script") / 2 ))" "$script" > "$c/half"
  set +e
  out=$(env HOME="$c/home" TMPDIR="$c/tmp" PATH="$shims:$PATH" FAKE_STATE="$c/state" BREAKPATCH_API="$base/good" \
        BREAKPATCH_PYTHON="$py311" "${shell_cmd[@]}" -s < "$c/half" 2>&1)
  set -e
  expect_none
  expect_no_out "Installing"
done

# ---------------------------------------------------------------- install-ci.ps1 (Windows)

ps1="$repo/site/install-ci.ps1"
pwsh=${PWSH:-$(command -v pwsh || true)}
if [ -z "$pwsh" ]; then
  echo "install-ci.ps1: SKIPPED, no pwsh (PowerShell 7) on this machine; set PWSH to one"
else
  sh_name=pwsh
  ps_case() {
    new_case "$1"
    home="$c/home/breakpatch-ci"
    bin="$home/bin"
  }
  # ps_run [VAR=value…]: install-ci.ps1 with -File (a CI step: a failure exits 1).
  ps_run() {
    set +e
    out=$(env -u GITHUB_PATH HOME="$c/home" TMPDIR="$c/tmp" PATH="$PATH" FAKE_STATE="$c/state" PIP_NO_INDEX=1 \
          OS=Windows_NT PROCESSOR_ARCHITECTURE=AMD64 SSL_CERT_FILE="$tls/cert.pem" BREAKPATCH_CI_HOME="$home" \
          BREAKPATCH_API="$base/good" BREAKPATCH_DOWNLOADS="$base/good/download/" BREAKPATCH_PYTHON="$py311" \
          "$@" "$pwsh" -NoProfile -NonInteractive -File "$ps1" 2>&1)
    code=$?
    set -e
  }
  ps_version() {
    local v; v=$("$home/$(head -n 1 "$home/current.txt" 2>/dev/null | tr -d '\r')/bin/breakpatch-ci" --version 2>/dev/null || true)
    if [ "$v" = "$1" ]; then ok "breakpatch-ci $1 is installed"; else bad "breakpatch-ci says '${v:-nothing}', expected $1"; fi
  }
  ps_envs() { local n; n=$(find "$home" -maxdepth 1 -name 'env-*' 2>/dev/null | wc -l | tr -d ' '); if [ "$n" -eq "$1" ]; then ok "$1 environment(s)"; else bad "$n environments, expected $1"; fi; }
  ps_none() { if [ ! -e "$home/current.txt" ] && [ ! -e "$bin/breakpatch-ci.cmd" ]; then ok "nothing installed"; else bad "something was installed"; fi; }

  # shellcheck disable=SC2016  # PowerShell's $, not the shell's
  echo "pwsh $("$pwsh" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"

  ps_case fresh-install-windows
  : > "$c/state/github-path"
  ps_run GITHUB_PATH="$c/state/github-path"
  expect_code 0
  expect_out "Installing breakpatch-ci 1.1.0..."
  expect_out "Windows is a preview: breakpatch-ci runs tests there, and they're recorded on a Mac."
  expect_out "Installing the Python packages (checked against their hashes)..."
  expect_out "breakpatch-ci 1.1.0 is in"
  expect_out "to GITHUB_PATH: the next steps of this job can run breakpatch-ci."
  ps_version 1.1.0
  ps_envs 1
  if [ "$(cat "$c/state/github-path")" = "$bin" ]; then ok "GITHUB_PATH has the folder"; else bad "GITHUB_PATH has: $(cat "$c/state/github-path")"; fi
  if grep -qx "install chromium --no-shell | $home/browsers" "$c/state/playwright"; then ok "Chromium went into the install folder's browsers"; else bad "playwright was run as: $(cat "$c/state/playwright" 2>/dev/null)"; fi
  envdir="$home/$(head -n 1 "$home/current.txt" | tr -d '\r')"
  if grep -q '"version": "1.1.0"' "$envdir/breakpatch-ci.json" && grep -q '"browsers": "../browsers"' "$envdir/breakpatch-ci.json"; then ok "breakpatch-ci.json points at the browsers"; else bad "breakpatch-ci.json: $(cat "$envdir/breakpatch-ci.json" 2>/dev/null)"; fi
  if grep -q 'breakpatch-ci installer' "$bin/breakpatch-ci.cmd" && grep -q 'Scripts\\breakpatch-ci.exe" %\*' "$bin/breakpatch-ci.cmd" \
    && grep -q '^setlocal' "$bin/breakpatch-ci.cmd"; then ok "bin\\breakpatch-ci.cmd starts the environment in current.txt"; else bad "the .cmd is: $(cat "$bin/breakpatch-ci.cmd" 2>/dev/null)"; fi
  if [ ! -e "$home/python" ]; then ok "no Python was downloaded (this machine has 3.11)"; else bad "a Python was downloaded"; fi
  if [ -z "$(ls -A "$c/tmp")" ]; then ok "nothing left in the temporary folder"; else bad "left behind: $(ls -A "$c/tmp")"; fi

  ps_case update-windows
  ps_run BREAKPATCH_VERSION=1.0.0
  expect_code 0
  first=$(head -n 1 "$home/current.txt" | tr -d '\r')
  ps_run
  expect_code 0
  expect_out "Updating breakpatch-ci 1.0.0 to 1.1.0..."
  ps_version 1.1.0
  ps_envs 1
  if [ ! -e "$home/$first" ]; then ok "the old environment is gone"; else bad "the old environment is still there"; fi
  ps_run
  expect_out "Reinstalling breakpatch-ci 1.1.0..."
  ps_run BREAKPATCH_CHANNEL=beta
  expect_code 0
  expect_out "Updating breakpatch-ci 1.1.0 to 1.2.0-beta.1..."

  ps_case windows-only
  ps_run OS=
  expect_code 1
  expect_out "This isn't Windows: use https://breakpatch.dev/install-ci there."
  ps_run PROCESSOR_ARCHITECTURE=ARM64
  expect_code 1
  expect_out "Windows on arm isn't supported yet."
  ps_run PROCESSOR_ARCHITECTURE=x86 PROCESSOR_ARCHITEW6432=AMD64 BREAKPATCH_API="$base/apponly" BREAKPATCH_DOWNLOADS="$base/apponly/download/"
  expect_code 1
  expect_out "Breakpatch 1.4.0 has no breakpatch-ci for Windows."
  ps_run BREAKPATCH_PYTHON="$pyshims/python-as" FAKE_PY_VERSION=3.12
  expect_code 1
  expect_out "breakpatch-ci needs Python 3.11, and $pyshims/python-as is Python 3.12."
  ps_none

  ps_case windows-checks
  ps_run BREAKPATCH_API="$base/badsum" BREAKPATCH_DOWNLOADS="$base/badsum/download/"
  expect_code 1
  expect_out "The download of breakpatch_team_engine-1.5.0-py3-none-any.whl doesn't match its checksum, so nothing was installed."
  ps_run BREAKPATCH_API="$base/url" BREAKPATCH_DOWNLOADS="$base/url/download/"
  expect_code 1
  expect_out "Breakpatch 1.9.0's breakpatch-ci files can't be read, so nothing was installed."
  ps_run BREAKPATCH_API="$base/extra" BREAKPATCH_DOWNLOADS="$base/extra/download/"
  expect_code 1
  expect_out "Breakpatch 2.0.0's breakpatch-ci files can't be read"
  ps_run BREAKPATCH_API="$base/foreign" BREAKPATCH_DOWNLOADS="$base/foreign/download/"
  expect_code 1
  expect_out "Breakpatch 1.7.0 lists a file that isn't from Breakpatch's releases, so nothing was installed."
  ps_run BREAKPATCH_API="$base/badhash" BREAKPATCH_DOWNLOADS="$base/badhash/download/"
  expect_code 1
  expect_out "Couldn't install breakpatch-ci's Python packages."
  ps_run BREAKPATCH_VERSION=9.9.9
  expect_code 1
  expect_out "There's no Breakpatch 9.9.9."
  ps_run BREAKPATCH_API="http://127.0.0.1:$http_port/good"
  expect_code 1
  expect_out "Couldn't reach GitHub to find Breakpatch."
  ps_run BREAKPATCH_GITHUB_TOKEN="$token"
  expect_code 1
  expect_out "BREAKPATCH_GITHUB_TOKEN is only ever sent to https://api.github.com/, and BREAKPATCH_API isn't there."
  expect_no_out "$token"
  ps_none
  if [ -z "$(ls -A "$c/tmp")" ]; then ok "nothing left in the temporary folder"; else bad "left behind: $(ls -A "$c/tmp")"; fi

  # A requirements file with CRLF line endings (as Windows' text mode writes it) reads the same:
  # Get-Content splits lines on either, so the two wheels are found and installed.
  ps_case windows-crlf
  if grep -q $'\r$' "$srv/crlf/download/v2.1.0/breakpatch-ci-requirements-windows-x86_64.txt"; then ok "the file has CRLF line endings"; else bad "the crlf release's file has no CR"; fi
  ps_run BREAKPATCH_API="$base/crlf" BREAKPATCH_DOWNLOADS="$base/crlf/download/"
  expect_code 0
  expect_out "Installing breakpatch-ci 2.1.0..."
  ps_version 2.1.0

  ps_case windows-python-download
  ps_run BREAKPATCH_PYTHON= PATH="$nopy" BREAKPATCH_PYTHON_DOWNLOADS="$base/pbs/" BREAKPATCH_PYTHON_SHA256="$(printf '%064d' 0)"
  expect_code 1
  expect_out "The download of Python 3.11 doesn't match its checksum, so nothing was installed."
  ps_none
  win_sha=$(sha256sum "$srv/pbs/$pbs_release/cpython-$pbs_version+$pbs_release-x86_64-pc-windows-msvc-install_only_stripped.tar.gz" | awk '{ print $1 }')
  ps_run BREAKPATCH_PYTHON= PATH="$nopy" BREAKPATCH_PYTHON_DOWNLOADS="$base/pbs/" BREAKPATCH_PYTHON_SHA256="$win_sha"
  expect_code 0
  expect_out "This PC has no Python 3.11 that breakpatch-ci can use: downloading Python $pbs_version (python-build-standalone $pbs_release)..."
  ps_version 1.1.0
  if [ -d "$home/python/cpython-$pbs_version+$pbs_release" ]; then ok "the downloaded Python is kept in the install folder"; else bad "no downloaded Python"; fi
  ps_run BREAKPATCH_PYTHON= PATH="$nopy" BREAKPATCH_PYTHON_DOWNLOAD=0
  expect_code 1
  expect_out "breakpatch-ci needs Python 3.11, and this PC has none."
  ps_run
  expect_code 0
  if [ ! -e "$home/python" ]; then ok "the downloaded Python goes once nothing uses it"; else bad "$home/python is still there"; fi

  ps_case windows-uninstall-and-iex
  ps_run
  expect_code 0
  ps_run BREAKPATCH_UNINSTALL=1
  expect_code 0
  expect_out "Removed breakpatch-ci and its browser from"
  if [ ! -e "$home" ]; then ok "the install folder is gone"; else bad "something is left: $(ls -A "$home")"; fi
  ps_run BREAKPATCH_UNINSTALL=1
  expect_out "Nothing to remove."
  # irm … | iex: a failure is printed, and doesn't close the window (no exit).
  set +e
  out=$(env HOME="$c/home" OS= "$pwsh" -NoProfile -NonInteractive -Command "iex (Get-Content -Raw '$ps1'); 'still here'" 2>&1)
  set -e
  expect_out "This isn't Windows"
  expect_out "still here"
fi

echo
if [ ${#failures[@]} -eq 0 ]; then
  echo "test-install-ci: all $pass checks passed"
else
  echo "test-install-ci: ${#failures[@]} failed, $pass passed:"
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
