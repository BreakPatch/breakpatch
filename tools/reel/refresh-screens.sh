#!/bin/bash
# Re-captures the real app screens in assets/ from the app's demo preview (Team edition linked):
#   scripts/link-team.sh && (cd app && npm ci && npm run dev)      # in another terminal, port 1420
#   tools/reel/refresh-screens.sh
# The demo has a fixed clock, so the times in the pictures stay the same from one run to the next.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
mkdir -p raw assets
node capture-screens.js
for f in raw/*.png; do
  n=$(basename "$f" .png)
  case $n in
    type_*) ffmpeg -y -loglevel error -i "$f" -vf scale=1920:-1 -q:v 2 "assets/$n.jpg" ;;
    *)      ffmpeg -y -loglevel error -i "$f" -vf scale=1920:1200 -q:v 2 "assets/$n.jpg" ;;
  esac
done
echo "assets/ refreshed from the running preview"
