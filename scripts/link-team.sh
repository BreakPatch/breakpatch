#!/bin/sh
# Links the private Team module (Breakpatch/breakpatch-team, checked out next to this repo)
# into the app, so the app builds as the Team edition:
#   app/src/edition/team -> ../../../../breakpatch-team/app
# Undo with scripts/unlink-team.sh. The link is in .gitignore.
#
# The Team checkout is found at, in order:
#   1. $TEAM_DIR, when set (absolute, or relative to the folder that holds this repo)
#   2. ../breakpatch-team
#   3. ../moravision-team (checkouts made before the rename keep their old folder name)
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
parent=$(dirname "$repo")
link="$repo/app/src/edition/team"

if [ -n "${TEAM_DIR:-}" ]; then
  case "$TEAM_DIR" in
    /*) team="$TEAM_DIR" ;;
    *) team="$parent/$TEAM_DIR" ;;
  esac
elif [ -d "$parent/breakpatch-team" ]; then
  team="$parent/breakpatch-team"
elif [ -d "$parent/moravision-team" ]; then
  team="$parent/moravision-team"
else
  team="$parent/breakpatch-team"
fi

if [ ! -f "$team/app/index.ts" ]; then
  echo "link-team: $team/app/index.ts not found. Check out Breakpatch/breakpatch-team next to this repo or set TEAM_DIR." >&2
  exit 1
fi
team=$(cd "$team" && pwd)

# A relative link when the Team checkout sits next to this repo, an absolute one otherwise.
if [ "$(dirname "$team")" = "$parent" ]; then
  target="../../../../$(basename "$team")/app"
else
  target="$team/app"
fi

if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "link-team: $link exists and isn't a link; move it away first." >&2
  exit 1
fi
rm -f "$link"
ln -s "$target" "$link"
# The link must land on the Team module.
if [ ! -f "$link/index.ts" ]; then
  echo "link-team: $link doesn't resolve to the Team module." >&2
  rm -f "$link"
  exit 1
fi
echo "link-team: app/src/edition/team -> $target (Team edition)"
