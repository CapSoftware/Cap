#!/usr/bin/env bash
# The FFmpeg components Cap ships. Sourced by stage-ffmpeg.sh (with TARGET set)
# and read by scripts/ffmpeg/check-components.mjs, which fails CI when code
# asks FFmpeg for an encoder, muxer, filter or protocol that is not listed here.
#
# Encoding, muxing, filtering and protocols are limited to what Cap calls.
# Decoders, demuxers, parsers, bitstream filters and hwaccels stay complete,
# because imports accept any codec inside mp4/mov/avi/mkv/webm/wmv/m4v/flv and
# mp3/wav/m4a/aac/ogg/opus/flac, and probing picks demuxers by content.

CAP_ENCODERS_ALL=(
  libx264
  aac
  libopus
  libmp3lame
  pcm_s16le
  pcm_f32le
  prores_ks
  mjpeg
)
CAP_ENCODERS_DARWIN=(
  h264_videotoolbox
  hevc_videotoolbox
  aac_at
)
CAP_ENCODERS_WINDOWS=(
  h264_mf
  hevc_mf
  h264_nvenc
  hevc_nvenc
  h264_qsv
  hevc_qsv
  h264_amf
  hevc_amf
)
CAP_ENCODERS_LINUX=(
  h264_nvenc
  hevc_nvenc
  h264_vaapi
  hevc_vaapi
  h264_qsv
  hevc_qsv
  h264_amf
  hevc_amf
)
CAP_MUXERS=(
  mp4
  mov
  ipod
  dash
  ogg
  wav
  mp3
)
CAP_FILTERS=(
  abuffer
  abuffersink
  aformat
  aresample
  amix
  anull
  atempo
  asetrate
  volume
  acompressor
  alimiter
  ebur128
)
CAP_PROTOCOLS=(
  file
)

cap_component_flags() {
  local encoders=("${CAP_ENCODERS_ALL[@]}")
  case "${TARGET:?}" in
    *darwin*) encoders+=("${CAP_ENCODERS_DARWIN[@]}") ;;
    *windows*) encoders+=("${CAP_ENCODERS_WINDOWS[@]}") ;;
    *linux*) encoders+=("${CAP_ENCODERS_LINUX[@]}") ;;
  esac

  CAP_COMPONENT_FLAGS=(
    --disable-everything
    --enable-decoders
    --enable-demuxers
    --enable-parsers
    --enable-bsfs
    --enable-hwaccels
  )
  local name
  for name in "${encoders[@]}"; do CAP_COMPONENT_FLAGS+=("--enable-encoder=${name}"); done
  for name in "${CAP_MUXERS[@]}"; do CAP_COMPONENT_FLAGS+=("--enable-muxer=${name}"); done
  for name in "${CAP_FILTERS[@]}"; do CAP_COMPONENT_FLAGS+=("--enable-filter=${name}"); done
  for name in "${CAP_PROTOCOLS[@]}"; do CAP_COMPONENT_FLAGS+=("--enable-protocol=${name}"); done
}

cap_component_flags
