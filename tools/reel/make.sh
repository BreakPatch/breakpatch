#!/bin/bash
# Renders the reel and teasers into out/:  ./make.sh [recipe ...]   (default: all four)
#   ./make.sh                      main cut and the three teasers
#   ./make.sh tease-flutter        one recipe from recipes/
# Needs: node 22 (npm ci, then npx playwright-core install chromium), python3 with numpy and scipy, ffmpeg.
# Set CHROMIUM=/path/to/chrome to use a browser you already have. About 1.5 frames/s on 4 cores.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
recipes=("$@"); [ ${#recipes[@]} -gt 0 ] || recipes=(main tease-find tease-flutter tease-fix)
mkdir -p out
for r in "${recipes[@]}"; do
  name=$(python3 -c "import json,sys;print(json.load(open('recipes/$r.json'))['name'])")
  echo "== $r -> out/$name.mp4"
  rm -rf "frames_$r"
  node render.js frames "recipes/$r.json" "frames_$r" "${WORKERS:-4}"
  python3 audio_cut.py "recipes/$r.json" "out/$name.wav"
  br=4500k; [ "$r" = main ] && br=4200k
  ffmpeg -y -loglevel error -framerate 30 -i "frames_$r/f%04d.png" -i "out/$name.wav" \
    -c:v libx264 -preset slow -b:v $br -maxrate 7M -bufsize 10M -pix_fmt yuv420p -profile:v high \
    -movflags +faststart -c:a aac -b:a 192k -shortest "out/$name.mp4"
  rm -rf "frames_$r" "out/$name.wav"
done
