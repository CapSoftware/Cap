#!/usr/bin/env bash
# shellcheck disable=SC2034 # the lists are read by check-components.mjs and the Rust check
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
CAP_ENCODERS_LINUX_X86_64=(
  h264_nvenc
  hevc_nvenc
)
CAP_ENCODERS_LINUX=(
  h264_vaapi
  hevc_vaapi
  h264_qsv
  hevc_qsv
  h264_amf
  hevc_amf
)
# Named only where code checks whether an encoder exists (diagnostics and the
# HEVC encoder no recording or export path calls). Not built.
CAP_PROBE_ONLY_ENCODERS=(
  libx265
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

# Built because every decoder, demuxer, parser and bitstream filter is kept.
# Listed so the runtime check fails if one Cap depends on ever goes missing.
CAP_REQUIRED_DECODERS=(
  h264 hevc mjpeg mpeg4 prores vp8 vp9 libdav1d wmv2 wmv3 vc1 flv h263 mpeg2video dnxhd rawvideo
  png gif webp bmp tiff
  aac mp3float opus vorbis flac alac pcm_s16le pcm_f32le wmav2 ac3 eac3
)
# Windows imports decoded these through external libraries before, so the
# Windows build keeps them (scripts/ffmpeg/stage-windows-decoders.sh).
# libxevd registers its decoder as "evc"; FFmpeg has no native EVC decoder.
CAP_REQUIRED_DECODERS_WINDOWS=(
  libjxl libdavs2 libuavs3d evc libcodec2 liblc3
)
CAP_REQUIRED_DEMUXERS=(
  mov matroska avi asf flv ogg wav mp3 aac flac concat image2 png_pipe jpeg_pipe webp_pipe gif bmp_pipe tiff_pipe
)
CAP_REQUIRED_BSFS=(
  h264_mp4toannexb aac_adtstoasc null
)
# Codecs, by decoder name, whose parser stream probing needs.
CAP_REQUIRED_PARSERS=(
  h264 hevc aac mp3float flac opus vorbis vp8 vp9 libdav1d mjpeg mpeg4 png gif webp vc1
)

cap_component_flags() {
  local encoders=("${CAP_ENCODERS_ALL[@]}")
  case "${TARGET:?}" in
    *darwin*) encoders+=("${CAP_ENCODERS_DARWIN[@]}") ;;
    *windows*) encoders+=("${CAP_ENCODERS_WINDOWS[@]}") ;;
    x86_64-linux*) encoders+=("${CAP_ENCODERS_LINUX[@]}" "${CAP_ENCODERS_LINUX_X86_64[@]}") ;;
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
