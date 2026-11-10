#!/usr/bin/env bash
# Usage: model_setup.sh <dir> <clip.ogg> <ffmpeg> [full]
# Fetches what the item 6 scenarios start from, unless the cache already
# restored it: the Recommended model in its old layout (the three files the
# download wrote before PR 3908), the fixture clip as a WAV a player can
# play, and with `full` the High Accuracy model as its download leaves it.
set -euo pipefail
dir=$1 clip=$2 ffmpeg=$3 full=${4:-}
release=https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1

fetch() {
  local target=$1 url=$2 size=$3
  if [[ -f $target && $(wc -c <"$target" | tr -d ' ') == "$size" ]]; then
    echo "have $target"
    return
  fi
  mkdir -p "$(dirname "$target")"
  curl --fail --location --silent --show-error --retry 5 --output "$target" "$url"
  [[ $(wc -c <"$target" | tr -d ' ') == "$size" ]] || { echo "wrong size for $target" >&2; exit 1; }
  echo "fetched $target"
}

fetch "$dir/old/encoder-model.int8.onnx" "$release/encoder-model.int8.onnx" 652183999
fetch "$dir/old/decoder_joint-model.int8.onnx" "$release/decoder_joint-model.int8.onnx" 18202004
fetch "$dir/old/vocab.txt" "$release/vocab.txt" 93939

if [[ $full == full ]]; then
  fetch "$dir/full/encoder-model.onnx" "$release/encoder-model.onnx" 41770866
  fetch "$dir/full/decoder_joint-model.onnx" "$release/decoder_joint-model.onnx" 72520893
  fetch "$dir/full/vocab.txt" "$release/vocab.txt" 93939
  data="$dir/full/encoder-model.onnx.data"
  if [[ ! -f $data || $(wc -c <"$data" | tr -d ' ') != 2435420160 ]]; then
    fetch "$dir/parts/part0" "$release/encoder-model.onnx.data.part0" 1300000000
    fetch "$dir/parts/part1" "$release/encoder-model.onnx.data.part1" 1135420160
    cat "$dir/parts/part0" "$dir/parts/part1" >"$data"
    rm -f "$dir/parts/part0" "$dir/parts/part1"
    [[ $(wc -c <"$data" | tr -d ' ') == 2435420160 ]]
  fi
fi

"$ffmpeg" -hide_banner -loglevel error -y -i "$clip" -ar 48000 -ac 2 -c:a pcm_s16le "$dir/clip.wav"
ls -la "$dir" "$dir/old"
