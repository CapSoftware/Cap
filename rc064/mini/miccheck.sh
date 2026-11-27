#!/bin/zsh
# miccheck.sh: 3 s tone into BlackHole 2ch, recorded from the default input and
# from "Cap Test Mic B"; prints mean volume of each. Run as a launcher child.
export PATH=/opt/homebrew/bin:/usr/bin:/bin
O=$HOME/gate064/out/miccheck; mkdir -p $O
ffmpeg -v error -re -f lavfi -i "sine=f=1000:d=6" -f audiotoolbox -audio_device_index 0 - &
T=$!
sleep 1
ffmpeg -v error -y -f avfoundation -i ":Cap Test Mic B" -t 3 $O/micb.wav 2> $O/micb.err
ffmpeg -v error -y -f avfoundation -i ":BlackHole 2ch" -t 2 $O/bh.wav 2> $O/bh.err
kill $T 2>/dev/null
for f in micb bh; do echo "$f $(ffmpeg -hide_banner -i $O/$f.wav -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume' | tr '\n' ' ')"; done > $O/result.txt
