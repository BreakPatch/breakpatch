#!/usr/bin/env bash
# Tests the action's scripts on Linux, without GitHub: install.sh against a fake release served
# over https from this machine (stand-in wheels, so pip installs offline), run.sh with a stand-in
# breakpatch-ci that passes, fails or can't run tests by their names, and summary.py's table,
# JSON and outputs. Needs python3.11, curl, openssl and sha256sum.
#
#   bash action/test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/bp-action-test.XXXXXX")
server=""
# shellcheck disable=SC2317  # run by the EXIT trap
cleanup() { if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT; [ -z "${KEEP:-}" ] || trap - EXIT
py=$(command -v python3.11) || { echo "action/test.sh: needs python3.11" >&2; exit 1; }
pass=0 failures=()
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { failures+=("$1"); echo "  FAIL  $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', expected '$3'"; fi; }
contains() { if grep -qF -- "$3" "$2"; then ok "$1"; else bad "$1: $2 doesn't have '$3'"; fi; }

# ---------------------------------------------------------------- a fake release

dl="$work/srv/dl"
mkdir -p "$dl" "$work/srv/api/releases/tags" "$work/srv/api/releases/assets" "$work/tls"
"$py" - "$dl" <<'PY'
import base64, hashlib, os, sys, zipfile
dl = sys.argv[1]
def wheel(name, files, scripts=None):
    info = f"{name}-1.2.3.dist-info"
    files = dict(files)
    files[f"{info}/METADATA"] = f"Metadata-Version: 2.1\nName: {name.replace('_', '-')}\nVersion: 1.2.3\n"
    files[f"{info}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    if scripts:
        files[f"{info}/entry_points.txt"] = "[console_scripts]\n" + "".join(f"{k} = {v}\n" for k, v in scripts.items())
    rec = [f"{n},sha256={base64.urlsafe_b64encode(hashlib.sha256(d.encode()).digest()).rstrip(b'=').decode()},{len(d.encode())}" for n, d in files.items()]
    files[f"{info}/RECORD"] = "\n".join(rec) + f"\n{info}/RECORD,,\n"
    path = os.path.join(dl, f"{name}-1.2.3-py3-none-any.whl")
    with zipfile.ZipFile(path, "w") as z:
        for n, d in files.items():
            z.writestr(n, d)
    return path
ci = "def main():\n    print('1.2.3')\n    return 0\n"
e = wheel("breakpatch_engine", {"breakpatch_engine/__init__.py": ""})
t = wheel("breakpatch_team_engine", {"breakpatch_team_engine/__init__.py": "", "breakpatch_team_engine/ci.py": ci},
          {"breakpatch-ci": "breakpatch_team_engine.ci:main"})
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
for plat in ("linux-x86_64", "linux-arm64"):
    open(os.path.join(dl, f"breakpatch-ci-requirements-{plat}.txt"), "w").write(
        f"# breakpatch-ci on {plat}\n# Installed by https://breakpatch.dev/install-ci with:\n"
        f"./{os.path.basename(e)} --hash=sha256:{sha(e)}\n./{os.path.basename(t)} --hash=sha256:{sha(t)}\n")
PY
(cd "$dl" && sha256sum -- * > SHA256SUMS)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/tls/key.pem" -out "$work/tls/cert.pem" -days 1 \
  -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1
port=$("$py" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
"$py" - "$work/srv" <<'PY'
import json, os, shutil, sys
srv = sys.argv[1]
assets = []
for i, n in enumerate(sorted(os.listdir(f"{srv}/dl")), 100):
    shutil.copy(f"{srv}/dl/{n}", f"{srv}/api/releases/assets/{i}")
    assets.append({"id": i, "name": n})
doc = {"tag_name": "v1.2.3", "assets": assets}
json.dump(doc, open(f"{srv}/api/releases/latest", "w"))
json.dump(doc, open(f"{srv}/api/releases/tags/v1.2.3", "w"))
PY
cat > "$work/serve.py" <<'PY'
import functools, http.server, ssl, sys
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), functools.partial(Q, directory=sys.argv[2]))
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
c.load_cert_chain(sys.argv[3] + "/cert.pem", sys.argv[3] + "/key.pem")
s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
PY
"$py" "$work/serve.py" "$port" "$work/srv" "$work/tls" >/dev/null 2>&1 &
server=$!
export CURL_CA_BUNDLE="$work/tls/cert.pem" NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
for _ in $(seq 50); do curl -fs "https://127.0.0.1:$port/api/releases/latest" >/dev/null 2>&1 && break; sleep 0.1; done

# ---------------------------------------------------------------- install.sh

echo "install.sh"
inst() { env BP_DIR="$work/bp" BP_API="https://127.0.0.1:$port/api" BP_PYTHON="$py" RUNNER_OS=Linux RUNNER_ARCH=X64 \
  GITHUB_OUTPUT="$work/out" PIP_NO_INDEX=1 "$@" bash "$here/scripts/install.sh" "${phase:-download}"; }
: > "$work/out"
code=0; inst > "$work/log" 2>&1 || code=$?
expect "download works" "$code" 0
contains "it says it checked" "$work/log" "breakpatch-ci 1.2.3 for linux-x86_64: downloaded and checked against SHA256SUMS."
contains "version output" "$work/out" "version=1.2.3"
contains "platform output" "$work/out" "platform=linux-x86_64"
contains "cache key output" "$work/out" "key=$(sha256sum "$dl/breakpatch-ci-requirements-linux-x86_64.txt" | cut -d' ' -f1)"
code=0; phase=install inst BP_REQUIREMENTS=breakpatch-ci-requirements-linux-x86_64.txt > "$work/log" 2>&1 || code=$?
expect "install works" "$code" 0
expect "breakpatch-ci runs" "$("$work/bp/venv/bin/breakpatch-ci" --version)" 1.2.3
contains "bin output" "$work/out" "bin=$work/bp/venv/bin"
code=0; inst BP_VERSION=1.2.3 > "$work/log" 2>&1 || code=$?
expect "a given version" "$code" 0
code=0; inst BP_VERSION=9.9.9 > "$work/log" 2>&1 || code=$?
expect "a missing version fails" "$code" 1
contains "and says so" "$work/log" "There's no Breakpatch 9.9.9."
code=0; inst BP_VERSION='1.0/../x' > "$work/log" 2>&1 || code=$?
contains "an odd version is refused" "$work/log" "version is latest or a version like 1.2.3"
code=0; inst RUNNER_OS=macOS RUNNER_ARCH=X64 > "$work/log" 2>&1 || code=$?
contains "an Intel Mac is refused" "$work/log" "not macOS X64"
code=0; inst RUNNER_ARCH=ARM64 > "$work/log" 2>&1 || code=$?
expect "linux-arm64 downloads its own files" "$code" 0
# A wheel that doesn't match SHA256SUMS.
cp "$work/srv/api/releases/assets/102" "$work/keep"
printf 'x' >> "$work/srv/api/releases/assets/102"
code=0; inst > "$work/log" 2>&1 || code=$?
expect "a changed file fails" "$code" 1
contains "and says it doesn't match" "$work/log" "doesn't match its checksum, so nothing was installed."
cp "$work/keep" "$work/srv/api/releases/assets/102"
# The token never goes anywhere but api.github.com.
code=0; GH_TOKEN=secret-token inst > "$work/log" 2>&1 || code=$?
expect "with a token for another address it still works" "$code" 0
if ! grep -rq secret-token "$work/bp" "$work/log"; then ok "the token isn't kept or shown"; else bad "the token is in a file or the log"; fi

# ---------------------------------------------------------------- run.sh and summary.py

echo "run.sh and summary.py"
cat > "$work/fake-ci" <<'SH'
#!/bin/sh
# breakpatch-ci run --test FILE … : passes, fails or can't run, by the file's name.
log="$FAKE_LOG"; echo "$*" >> "$log"
case "$*" in
  *--suite*) cat "$FAKE_SUITE"; exit "${FAKE_SUITE_CODE:-1}" ;;
  *pass.json*) echo '{"result": "pass", "name": "Log in", "steps": [{"stepId": "a", "result": "passed"}]}' ;;
  *fixed.json*) echo '{"result": "pass", "name": "Fixed one", "steps": [{"stepId": "a", "result": "healed"}]}' ;;
  *fail.json*) echo '{"result": "fail", "name": "Checkout", "message": "The total | didn'"'"'t match.", "steps": [{"stepId": "s1", "result": "passed"}, {"stepId": "s2", "result": "failed", "reason": "checkFailed"}]}'
               mkdir -p "$(echo "$*" | sed 's/.*--screenshots \([^ ]*\).*/\1/')" && touch "$(echo "$*" | sed 's/.*--screenshots \([^ ]*\).*/\1/')/s2.png"; exit 1 ;;
  *) echo '{"result": "error", "code": "licence", "message": "No machine licences left."}'; exit 3 ;;
esac
SH
chmod +x "$work/fake-ci"
t="$work/repo/breakpatch-tests/apps/web/tests"
mkdir -p "$t"
echo '{"name": "Log in", "steps": [{"id": "a", "label": "Open"}]}' > "$t/pass.json"
echo '{"name": "Checkout", "steps": [{"id": "s1", "label": "Open"}, {"id": "s2", "label": "Check the total"}]}' > "$t/fail.json"
echo '{"name": "Fixed one", "steps": [{"id": "a", "label": "Press Buy"}]}' > "$t/fixed.json"
runit() {
  (cd "$work/repo" && env BP_DIR="$work/run" BP_CI="$work/fake-ci" FAKE_LOG="$work/calls" FAKE_SUITE="$work/suite.json" \
    GITHUB_OUTPUT="$work/out" GITHUB_STEP_SUMMARY="$work/summary.md" "$@" bash "$here/scripts/run.sh")
}
summ() {
  : > "$work/out"; : > "$work/summary.md"
  (cd "$work/repo" && GITHUB_OUTPUT="$work/out" GITHUB_STEP_SUMMARY="$work/summary.md" "$py" "$here/scripts/summary.py" "$work/run" > /dev/null)
}
: > "$work/calls"
code=0; runit BP_TESTS='breakpatch-tests/apps/*/tests/*.json breakpatch-tests/apps/web/tests/pass.json' BP_FAIL_ON_FIX=true \
  BP_SECRETS=$'STAGING_PASSWORD\n  API_TOKEN=https://api.acme.com  \n' BP_LABEL="GitHub · CI · run 7" > "$work/log" 2>&1 || code=$?
expect "run.sh ends 0 (the action fails the job later)" "$code" 0
expect "each file runs once" "$(wc -l < "$work/calls" | tr -d ' ')" 3
contains "with its options" "$work/calls" "--fail-on-fix --label GitHub · CI · run 7 --secret STAGING_PASSWORD --secret API_TOKEN=https://api.acme.com"
contains "a failure is an annotation" "$work/log" "::error title=Breakpatch::breakpatch-tests/apps/web/tests/fail.json failed"
summ
contains "result output" "$work/out" "result=failed"
contains "passed output" "$work/out" "passed=1"
contains "failed output" "$work/out" "failed=1"
contains "json output" "$work/out" "json=$work/run/results.json"
contains "the summary counts" "$work/summary.md" "### Breakpatch: 1 passed, 1 fixed, 1 failed"
contains "the summary names the failed step" "$work/summary.md" '| Checkout | ❌ failed | Check the total | The total \| didn'"'"'t match. |'
expect "the JSON has every test" "$("$py" -c 'import json, sys; print(len(json.load(open(sys.argv[1]))["tests"]))' "$work/run/results.json")" 3
if [ -f "$work/run/screenshots/1/s2.png" ]; then ok "the failed step's screenshot is kept"; else bad "no screenshot"; fi

# No licence: the first run says why, and the rest don't run.
mkdir -p "$work/repo/nolicence"
echo '{}' > "$work/repo/nolicence/a.json"; echo '{}' > "$work/repo/nolicence/b.json"
: > "$work/calls"
runit BP_TESTS='nolicence/*.json' > "$work/log" 2>&1
expect "after a licence problem nothing else runs" "$(wc -l < "$work/calls" | tr -d ' ')" 1
contains "it says why" "$work/log" "didn't run (exit 3): No machine licences left."
summ
contains "the result is error" "$work/out" "result=error"

# Nothing matches.
code=0; runit BP_TESTS='nothing/*.json' > "$work/log" 2>&1 || code=$?
expect "no matching files fails" "$code" 1
contains "and says how" "$work/log" "No test files match nothing/*.json."

# A suite.
cat > "$work/suite.json" <<'JSON'
{"result": "failed", "suite": "Smoke", "counts": {"total": 2}, "tests": [
 {"name": "Log in", "result": "passed"},
 {"name": "Buy", "result": "failed", "failedStep": {"label": "Press Buy", "reason": "notFound"}}]}
JSON
: > "$work/calls"
runit BP_SUITE=smoke-7f3a BP_WORKSPACE=team.bpworkspace > "$work/log" 2>&1
contains "the suite runs from the workspace" "$work/calls" "run --suite smoke-7f3a --workspace team.bpworkspace"
summ
contains "a suite's tests are rows" "$work/summary.md" "| Buy | ❌ failed | Press Buy | notFound |"
code=0; runit BP_SUITE=smoke-7f3a > "$work/log" 2>&1 || code=$?
contains "a suite needs a workspace" "$work/log" "suite needs workspace"

# ---------------------------------------------------------------- the screenshots' artifact name

echo "artifact-name.sh"
aname() { : > "$work/aout"; env GITHUB_OUTPUT="$work/aout" BP_JOB=ui BP_ATTEMPT=1 "$@" bash "$here/scripts/artifact-name.sh" > "$work/alog" 2>&1; sed -n 's/^name=//p' "$work/aout"; }
leg0=$(aname BP_JOB_INDEX=0 BP_TESTS='tests/*.json')
leg1=$(aname BP_JOB_INDEX=1 BP_TESTS='tests/*.json')
other=$(aname BP_JOB_INDEX=0 BP_TESTS='smoke/*.json')
suite=$(aname BP_JOB_INDEX=0 BP_TESTS='tests/*.json' BP_SUITE=smoke)
case "$leg0" in breakpatch-screenshots-ui-0-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-1) ok "the default names the job, its index, a hash and the attempt ($leg0)" ;; *) bad "default name: $leg0" ;; esac
if [ "$leg0" != "$leg1" ]; then ok "two matrix legs get two names"; else bad "two matrix legs collide: $leg0"; fi
if [ "$leg0" != "$other" ] && [ "$leg0" != "$suite" ]; then ok "two uses with other tests or a suite get two names"; else bad "other tests collide"; fi
expect "the same leg and tests give the same name" "$(aname BP_JOB_INDEX=0 BP_TESTS='tests/*.json')" "$leg0"
expect "artifact-name replaces it" "$(aname BP_ARTIFACT_NAME=my-shots BP_JOB_INDEX=3)" my-shots
expect "a name upload-artifact refuses fails here" "$(aname BP_ARTIFACT_NAME='a/b')" ""
contains "and says why" "$work/alog" "artifact-name can't have any of"
# shellcheck disable=SC2016  # the text of action.yml, not shell
contains "action.yml passes the matrix leg's index" "$here/action.yml" 'BP_JOB_INDEX: ${{ strategy.job-index }}'
# shellcheck disable=SC2016
contains "and uploads under that name" "$here/action.yml" 'name: ${{ steps.artifact.outputs.name }}'

echo
if [ ${#failures[@]} -eq 0 ]; then echo "action/test.sh: all $pass checks passed"; exit 0; fi
echo "action/test.sh: ${#failures[@]} failed"; printf '  %s\n' "${failures[@]}"; exit 1
