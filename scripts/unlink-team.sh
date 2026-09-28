#!/bin/sh
# Removes the Team module link made by scripts/link-team.sh; the app builds as Community again.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
link="$repo/app/src/edition/team"

if [ -L "$link" ]; then
  rm "$link"
  echo "unlink-team: removed app/src/edition/team (Community edition)"
elif [ -e "$link" ]; then
  echo "unlink-team: $link isn't a link; leaving it alone." >&2
  exit 1
else
  echo "unlink-team: no link (already Community)"
fi
