#!/usr/bin/env bash
# Writes shields.io endpoint files for coverage and pushes them to the orphan branch `badges`,
# with the workflow's GITHUB_TOKEN (the calling job needs `permissions: contents: write`).
# No third-party service or token: the README reads them through
#   https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<owner>/<repo>/badges/<name>.json
#
#   publish-badges.sh <name> <label> <percent> [<name> <label> <percent> …]
#   publish-badges.sh coverage-app "coverage app" 35.96 coverage-engine "coverage engine" 79
#
# Only the files named are replaced, so several workflows can share the branch. A push that loses
# a race with another workflow fetches the branch again and retries.
#
# The token can write the whole repo, so the script guards what it pushes (security review,
# "Badges job"): only to refs/heads/badges, never a force push, and only a branch that holds
# nothing but top-level .json files. The branch rulesets on main, v* and badges are the real
# limit (SECURITY-REPORT section 7).
set -euo pipefail

readonly BADGES_REF=refs/heads/badges

if [ $# -eq 0 ] || [ $(($# % 3)) -ne 0 ]; then
  echo "usage: $0 <name> <label> <percent> [...]" >&2
  exit 2
fi
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

out=$(mktemp -d)
while [ $# -gt 0 ]; do
  name=$1 label=$2 pct=$3
  shift 3
  case "$name" in *[!A-Za-z0-9._-]*|"") echo "bad badge name: $name" >&2; exit 2 ;; esac
  case "$pct" in ''|*[!0-9.]*) echo "bad percentage for $name: '$pct'" >&2; exit 2 ;; esac
  whole=$(printf '%.0f' "$pct")
  if   [ "$whole" -ge 90 ]; then color=brightgreen
  elif [ "$whole" -ge 80 ]; then color=green
  elif [ "$whole" -ge 70 ]; then color=yellowgreen
  elif [ "$whole" -ge 60 ]; then color=yellow
  elif [ "$whole" -ge 50 ]; then color=orange
  else color=red
  fi
  printf '{"schemaVersion":1,"label":"%s","message":"%s%%","color":"%s"}\n' \
    "$label" "$whole" "$color" > "$out/$name.json"
  cat "$out/$name.json"
done

# BADGES_REMOTE: another remote, for trying the script against a local bare repo.
url=${BADGES_REMOTE:-https://github.com/$GITHUB_REPOSITORY.git}
auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"

for attempt in 1 2 3 4 5; do
  work=$(mktemp -d)
  git -C "$work" init -q
  g() { git -C "$work" -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    -c http.https://github.com/.extraheader="$auth" "$@"; }
  if g fetch -q --depth 1 "$url" "$BADGES_REF" 2>/dev/null; then
    g checkout -q -B badges FETCH_HEAD
    others=$(g ls-tree -r --name-only HEAD | grep -v '^[A-Za-z0-9._-]*\.json$' || true)
    if [ -n "$others" ]; then
      echo "badges: refusing: the badges branch holds files other than badge .json files: $others" >&2
      exit 1
    fi
  else
    g checkout -q --orphan badges   # first run: the branch doesn't exist yet
  fi
  cp "$out"/*.json "$work"/
  g add -A .
  if g diff --cached --quiet; then
    echo "badges: unchanged"
    exit 0
  fi
  g commit -q -m "Coverage badges for ${GITHUB_SHA:-local}"
  dest=$BADGES_REF
  case "$dest" in
    refs/heads/badges) ;;
    *) echo "badges: refusing to push to $dest: only refs/heads/badges" >&2; exit 1 ;;
  esac
  # A plain push: never forced, so it can only add to the badges branch.
  if g push -q "$url" "HEAD:$dest"; then
    echo "badges: pushed to the badges branch"
    exit 0
  fi
  echo "badges: push rejected, retrying ($attempt)" >&2
  sleep $((attempt * 3))
done
echo "badges: couldn't push the badges branch" >&2
exit 1
