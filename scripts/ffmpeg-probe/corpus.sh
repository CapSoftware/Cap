#!/usr/bin/env bash
# Builds the import corpus: every container the Import picker accepts, with
# the codecs people actually bring, plus every image and audio type.
#   scripts/ffmpeg-probe/corpus.sh <out dir>
set -euo pipefail
OUT="${1:?out dir}"
mkdir -p "$OUT/video" "$OUT/image" "$OUT/audio"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
export SVT_LOG=1
V=(-f lavfi -i "testsrc2=size=320x240:rate=30:duration=2")
A=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2")
BX=(-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1)

video() { local name="$1"; shift; ff "${V[@]}" "${A[@]}" -shortest "$@" "${BX[@]}" "$OUT/video/$name"; }

video h264-aac.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac
video hevc-aac.mp4 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -c:a aac -x265-params log-level=error
video hevc10-aac.mov -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p10le -c:a aac -x265-params log-level=error
video mpeg4-mp3.mp4 -c:v mpeg4 -c:a libmp3lame
video av1-opus.mp4 -c:v libsvtav1 -c:a libopus
video h264-high444.mp4 -c:v libx264 -pix_fmt yuv444p -c:a aac
video h264-10bit.mkv -c:v libx264 -pix_fmt yuv420p10le -c:a flac
video h264-unrotated.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac
ff -display_rotation:v 90 -i "$OUT/video/h264-unrotated.mp4" -c copy "${BX[@]}" "$OUT/video/h264-rotated.mp4"
rm "$OUT/video/h264-unrotated.mp4"
video h264-odd.mp4 -c:v libx264 -pix_fmt yuv444p -vf scale=321:241 -c:a aac
video h264-vfr.mp4 -c:v libx264 -pix_fmt yuv420p -vf "select='lt(n\,20)+not(mod(n\,3))'" -fps_mode vfr -enc_time_base:v 1/1000 -c:a aac
video h264-noaudio.mp4 -an -c:v libx264 -pix_fmt yuv420p
video prores-pcm.mov -c:v prores_ks -profile:v 3 -c:a pcm_s16le
video prores4444-alpha.mov -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -c:a pcm_s24le
video h264-alac.mov -c:v libx264 -pix_fmt yuv420p -c:a alac
video mjpeg-pcm.mov -c:v mjpeg -q:v 3 -c:a pcm_s16le
video dnxhr-pcm.mov -c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -c:a pcm_s16le
video qtrle-pcm.mov -c:v qtrle -c:a pcm_s16le
video h264-aac.m4v -c:v libx264 -pix_fmt yuv420p -c:a aac
video h264-flac.mkv -c:v libx264 -pix_fmt yuv420p -c:a flac
video hevc-opus.mkv -c:v libx265 -pix_fmt yuv420p -c:a libopus -x265-params log-level=error
video vp9-vorbis.mkv -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a vorbis -strict -2 -ac 2
video mpeg2-ac3.mkv -c:v mpeg2video -c:a ac3
video h264-eac3.mkv -c:v libx264 -pix_fmt yuv420p -c:a eac3
video ffv1-pcm.mkv -c:v ffv1 -c:a pcm_s16le
video vp8-vorbis.webm -c:v libvpx -deadline realtime -cpu-used 8 -c:a vorbis -strict -2 -ac 2
video vp9-opus.webm -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus
video vp9-alpha.webm -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -pix_fmt yuva420p -c:a libopus
video av1-opus.webm -c:v libsvtav1 -c:a libopus
video mpeg4-mp3.avi -c:v mpeg4 -vtag xvid -c:a libmp3lame
video mjpeg-pcm.avi -c:v mjpeg -q:v 3 -c:a pcm_s16le
video msmpeg4-mp3.avi -c:v msmpeg4 -c:a libmp3lame
video cinepak-pcm.avi -c:v cinepak -c:a pcm_u8
video wmv2-wmav2.wmv -c:v wmv2 -b:v 1M -c:a wmav2
video wmv1-wmav2.wmv -c:v wmv1 -b:v 1M -c:a wmav2
video flv1-mp3.flv -c:v flv -c:a libmp3lame -ar 44100
video h264-aac.flv -c:v libx264 -pix_fmt yuv420p -c:a aac

I=(-f lavfi -i "testsrc2=size=640x480:rate=1:duration=1" -frames:v 1)
image() { local name="$1"; shift; ff "${I[@]}" "$@" "$OUT/image/$name"; }
image rgb.png
image rgba.png -vf "format=rgba,geq=r='r(X\,Y)':g='g(X\,Y)':b='b(X\,Y)':a='X/W*255'"
image rgb48.png -pix_fmt rgb48be
image gray.png -pix_fmt gray
image photo.jpg -q:v 2
image gray.jpg -pix_fmt gray -q:v 2
image photo.jpeg -q:v 5
cwebp -quiet -q 80 "$OUT/image/rgb.png" -o "$OUT/image/lossy.webp"
cwebp -quiet -lossless "$OUT/image/rgba.png" -o "$OUT/image/lossless-alpha.webp"
image still.gif
ff -f lavfi -i "testsrc2=size=320x240:rate=10:duration=1" -loop 0 "$OUT/image/animated.gif"
image bitmap.bmp
image rgba.bmp -pix_fmt bgra
image lzw.tif -compression_algo lzw
image raw.tiff -compression_algo raw
image rgb48.tiff -pix_fmt rgb48le

audio() { local name="$1"; shift; ff -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=3" -ac 2 "$@" -fflags +bitexact -map_metadata -1 "$OUT/audio/$name"; }
audio cbr.mp3 -c:a libmp3lame -b:a 192k
audio vbr44.mp3 -c:a libmp3lame -q:a 4 -ar 44100
audio s16.wav -c:a pcm_s16le
audio s24.wav -c:a pcm_s24le
audio f32.wav -c:a pcm_f32le
audio mono22.wav -c:a pcm_s16le -ac 1 -ar 22050
audio aac.m4a -c:a aac
audio alac.m4a -c:a alac
audio adts.aac -c:a aac
audio vorbis.ogg -c:a vorbis -strict -2
audio opus.ogg -c:a libopus
audio speech.opus -c:a libopus -b:a 32k
audio s16.flac -c:a flac
audio s24.flac -c:a flac -sample_fmt s32 -bits_per_raw_sample 24

find "$OUT" -type f | sort | while read -r file; do printf '%8d %s\n' "$(wc -c <"$file")" "${file#"$OUT"/}"; done
