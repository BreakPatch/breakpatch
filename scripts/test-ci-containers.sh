#!/usr/bin/env bash
# Installs breakpatch-ci as a customer does, in clean Linux containers: site/install-ci against the
# files scripts/build-ci.sh wrote (served from this machine as a fake GitHub release over https),
# then breakpatch-ci setup before and after the system libraries, a run that lacks them, the
# Team repo's wheel smoke test (engine/scripts/smoke_ci_wheel.py: a passing and a failing test in
# a real Chromium, another system, no licence) and --uninstall.
#
#   scripts/test-ci-containers.sh --dist DIR --seed FILE [IMAGE…]     (default ubuntu:22.04 ubuntu:24.04 debian:12)
#
# --dist: build-ci.sh's --out (the two wheels and breakpatch-ci-requirements-<platform>.txt).
# --seed: the throwaway key's seed the wheels were built with (smoke_ci_wheel.py keys).
# The Team checkout is found as build-ci.sh finds it (TEAM_DIR, ../breakpatch-team).
#
# The images start with nothing: no Python (the install command downloads its pinned 3.11), no
# curl (the script installs curl and ca-certificates with apt, as a customer's CI job does) and
# none of Chromium's libraries. Each must end with "PASS"; the log of one that doesn't is shown.
#
# Behind a proxy that re-signs TLS (a sandbox, not GitHub's runners): HTTPS_PROXY is passed in and
# apt is pointed at it over https, CONTAINER_CA names a CA file to trust inside, and
# CONTAINER_BROWSERS a folder with chromium-<revision> and ffmpeg-<revision> to use when
# Playwright's download hosts can't be reached (linked in, as `playwright install` would leave it).
#
# Needs docker (DOCKER=podman works), python3, openssl and curl.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
parent=$(dirname "$repo")
die() { echo "test-ci-containers: $*" >&2; exit 1; }
dist="" seed="" images=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dist) [ $# -ge 2 ] || die "--dist needs a folder"; dist=$(cd "$2" && pwd); shift 2 ;;
    --seed) [ $# -ge 2 ] || die "--seed needs a file"; seed=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) images+=("$1"); shift ;;
  esac
done
if [ -z "$dist" ] || [ -z "$seed" ]; then die "needs --dist and --seed (see --help)"; fi
[ ${#images[@]} -gt 0 ] || images=(ubuntu:22.04 ubuntu:24.04 debian:12)
team=${TEAM_DIR:-}
case "$team" in '') team="$parent/breakpatch-team" ;; /*) ;; *) team="$parent/$team" ;; esac
[ -f "$team/engine/scripts/smoke_ci_wheel.py" ] || die "the Team checkout wasn't found ($team); set TEAM_DIR"
docker=${DOCKER:-docker}
"$docker" info >/dev/null 2>&1 || die "$docker can't reach its daemon"
reqs=""
for f in "$dist"/breakpatch-ci-requirements-linux-*.txt; do [ -f "$f" ] && reqs=$(basename "$f"); done
[ -n "$reqs" ] || die "no breakpatch-ci-requirements-linux-*.txt in $dist"
version=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/app/package.json")

work=$(mktemp -d "${TMPDIR:-/tmp}/bp-ci-containers.XXXXXX")
server=""
cleanup() { if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT

# ---------------------------------------------------------------- the fake release

mkdir -p "$work/tls" "$work/srv/api/releases/tags" "$work/srv/download/v$version"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/tls/key.pem" -out "$work/tls/cert.pem" -days 2 \
  -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1
chmod 644 "$work/tls"/*.pem
cp "$dist"/breakpatch_engine-*.whl "$dist"/breakpatch_team_engine-*.whl "$dist/$reqs" "$work/srv/download/v$version/"
(cd "$work/srv/download/v$version" && sha256sum -- * > SHA256SUMS)
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
cat > "$work/serve.py" <<'PY'
import functools, http.server, json, os, ssl, sys
port, root, tls, version = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
dl = os.path.join(root, "download", f"v{version}")
url = f"https://127.0.0.1:{port}/download/v{version}"
doc = {"tag_name": f"v{version}", "draft": False, "prerelease": "-" in version,
       "assets": [{"name": n, "browser_download_url": f"{url}/{n}"} for n in sorted(os.listdir(dl))]}
for name in (f"tags/v{version}", "latest"):
    with open(os.path.join(root, "api", "releases", name), "w") as f:
        json.dump(doc, f)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=root))
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(f"{tls}/cert.pem", f"{tls}/key.pem")
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
python3 "$work/serve.py" "$port" "$work/srv" "$work/tls" "$version" >"$work/server.log" 2>&1 &
server=$!
for _ in $(seq 50); do
  curl -fs --cacert "$work/tls/cert.pem" --noproxy 127.0.0.1 "https://127.0.0.1:$port/api/releases/latest" >/dev/null 2>&1 && break
  sleep 0.1
done

# ---------------------------------------------------------------- inside each container

cat > "$work/inside.sh" <<'SH'
#!/bin/sh
# Prints what happened, then PASS or FAIL: <why>.
set -u
problems=""
check() { if [ "$1" = "$2" ]; then echo "  ok    $3"; else echo "  FAIL  $3 (got $1, expected $2)"; problems="$problems; $3"; fi; }
step() { printf '\n=== %s\n' "$*"; }
cat /tls/cert.pem > /tmp/ca.pem
if [ -f /extra-ca.pem ]; then cat /extra-ca.pem >> /tmp/ca.pem; fi
export CURL_CA_BUNDLE=/tmp/ca.pem NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
if [ -f /extra-ca.pem ]; then export PIP_CERT=/extra-ca.pem; fi
if [ -n "${HTTPS_PROXY:-}" ]; then
  printf 'Acquire::https::Proxy "%s";\n' "$HTTPS_PROXY" > /etc/apt/apt.conf.d/99proxy
  if [ -f /extra-ca.pem ]; then printf 'Acquire::https::CAInfo "/extra-ca.pem";\n' >> /etc/apt/apt.conf.d/99proxy; fi
  sed -i 's#http://#https://#g' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null
fi
step "$(. /etc/os-release && echo "$PRETTY_NAME"), $(getconf GNU_LIBC_VERSION), $(command -v python3 || echo 'no python3')"
if ! { apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates; } >/tmp/apt.log 2>&1; then
  tail -3 /tmp/apt.log; echo "FAIL: apt-get couldn't install curl"; exit 1
fi
if [ -d /browsers ]; then
  mkdir -p "$HOME/.breakpatch-ci/browsers"
  for d in /browsers/*; do ln -s "$d" "$HOME/.breakpatch-ci/browsers/$(basename "$d")"; done
fi
step "install-ci"
BREAKPATCH_API="https://127.0.0.1:$PORT/api" BREAKPATCH_DOWNLOADS="https://127.0.0.1:$PORT/download/" \
  BREAKPATCH_VERSION="$VERSION" sh /install-ci >/tmp/install.log 2>&1
code=$?
cat /tmp/install.log
check "$code" 0 "the install command works"
check "$(grep -c "The browser can't start: this machine is missing system libraries" /tmp/install.log)" 1 "it names the missing libraries"
ci="$HOME/.local/bin/breakpatch-ci"
check "$("$ci" --version 2>&1)" "$VERSION" "breakpatch-ci --version"
step "setup, before the libraries"
"$ci" setup >/tmp/setup.json 2>/tmp/setup.log; code=$?
cat /tmp/setup.log
check "$code" 2 "setup exits 2 without the libraries"
check "$(grep -c '"missing": \[$' /tmp/setup.json)" 1 "setup's JSON lists them"
step "a run, before the libraries"
echo '{"name": "t", "startUrl": "about:blank", "steps": []}' > /tmp/t.json
"$ci" run --test /tmp/t.json >/tmp/run.json 2>/dev/null; code=$?
cat /tmp/run.json
check "$code" 2 "the run exits 2, not as a failed test"
check "$(grep -c '"code": "libraries"' /tmp/run.json)" 1 "with code libraries"
step "install-deps"
"$HOME/.breakpatch-ci/current/bin/python" -m playwright install-deps chromium >/tmp/deps.log 2>&1; code=$?
tail -n 2 /tmp/deps.log
check "$code" 0 "install-deps works"
"$ci" setup >/tmp/setup.json 2>/tmp/setup.log; code=$?
cat /tmp/setup.log
check "$code" 0 "setup exits 0 with the libraries"
step "smoke test"
"$HOME/.breakpatch-ci/current/bin/python" /team/engine/scripts/smoke_ci_wheel.py run --ci "$HOME/.breakpatch-ci/current/bin/breakpatch-ci" \
  --seed-file /seed --site /site --version "$VERSION"
check "$?" 0 "the smoke test passes"
step "uninstall"
sh /install-ci --uninstall; code=$?
check "$code" 0 "--uninstall works"
check "$([ -e "$HOME/.breakpatch-ci" ] || [ -e "$ci" ]; echo $?)" 1 "nothing is left"
if [ -z "$problems" ]; then echo PASS; else echo "FAIL:${problems#;}"; fi
SH

failed=()
for image in "${images[@]}"; do
  echo "test-ci-containers: $image"
  args=(--rm --network host -e "PORT=$port" -e "VERSION=$version"
        -v "$work/tls:/tls:ro" -v "$work/inside.sh:/inside.sh:ro" -v "$repo/site/install-ci:/install-ci:ro"
        -v "$team:/team:ro" -v "$repo/engine/tests/site:/site:ro" -v "$seed:/seed:ro")
  if [ -n "${HTTPS_PROXY:-}" ]; then args+=(-e HTTPS_PROXY); fi
  if [ -n "${CONTAINER_CA:-}" ]; then args+=(-v "$CONTAINER_CA:/extra-ca.pem:ro"); fi
  if [ -n "${CONTAINER_BROWSERS:-}" ]; then args+=(-v "$CONTAINER_BROWSERS:/browsers:ro"); fi
  log="$work/$(echo "$image" | tr -c 'A-Za-z0-9.\n' '-').log"
  "$docker" run "${args[@]}" "$image" sh /inside.sh >"$log" 2>&1 || true
  if [ "$(tail -n 1 "$log")" = PASS ]; then
    grep -E '^  (ok|FAIL) ' "$log" | sed "s/^/  $image /"
    echo "test-ci-containers: $image PASS"
  else
    cat "$log"
    failed+=("$image")
  fi
done
[ ${#failed[@]} -eq 0 ] || die "failed on ${failed[*]}"
echo "test-ci-containers: all passed (${images[*]})"
