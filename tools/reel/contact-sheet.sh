#!/bin/bash
n=$(ls $1/t*.png | wc -l); cols=${3:-3}; rows=$(( (n+cols-1)/cols ))
ffmpeg -y -loglevel error -pattern_type glob -i "$1/t*.png" -vf "scale=640:-1,tile=${cols}x${rows}:padding=6:color=gray" -frames:v 1 -q:v 3 "$2"
