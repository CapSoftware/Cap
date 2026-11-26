#!/usr/bin/env bash
# models.sh <dir>: the transcription and speaker models a meeting uses, from Cap's model releases,
# laid out as the app keeps them (parakeet-best/, speaker-embedding-v1.onnx, nemotron-3-diarization/).
# Does nothing for files already there, so a restored cache costs no download.
set -euo pipefail
D=$1
B=https://github.com/CapSoftware/transcription-models/releases/download
mkdir -p "$D/parakeet-best" "$D/nemotron-3-diarization"
get() { [ -s "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
get "$B/parakeet-tdt-v2/encoder-model.q8.onnx" "$D/parakeet-best/encoder-model.onnx"
get "$B/parakeet-tdt-v1/decoder_joint-model.int8.onnx" "$D/parakeet-best/decoder_joint-model.int8.onnx"
get "$B/parakeet-tdt-v1/vocab.txt" "$D/parakeet-best/vocab.txt"
get "$B/speaker-v1/speaker-embedding-v1.onnx" "$D/speaker-embedding-v1.onnx"
get "$B/speaker-v2/model_quantized.onnx" "$D/nemotron-3-diarization/model_quantized.onnx"
get "$B/speaker-v2/model_quantized.onnx_data" "$D/nemotron-3-diarization/model_quantized.onnx_data"
ls -la "$D" "$D/parakeet-best" "$D/nemotron-3-diarization"
