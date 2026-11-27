#!/usr/bin/env -S bash -euo pipefail

# Replaces native-deps' stages/99-ffmpeg.sh. Same FFmpeg source, patches and
# toolchain as the build each platform shipped before, with only the
# components Cap uses enabled (see scripts/ffmpeg/components.sh).

echo "Download ffmpeg..."
mkdir -p ffmpeg

curl_tar 'https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n7.1.tar.gz' ffmpeg 1

case "$TARGET" in
  *windows*) ;;
  *)
    for patch in \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A01-mov-read-name-track-tag-written-by-movenc.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A02-movenc-write-3gpp-track-titl-tag.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A03-mov-read-3gpp-udta-tags.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A04-movenc-write-3gpp-track-names-tags-for-all-available.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A05-avformat-mov-add-support-audio-fallback-track-ref.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A06-dvdsubdec-fix-processing-of-partial-packets.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A07-dvdsubdec-return-number-of-bytes-used.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A08-dvdsubdec-use-pts-of-initial-packet.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A09-dvdsubdec-add-an-option-to-output-subtitles-with-emp.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A10-ccaption_dec-fix-pts-in-real_time-mode.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A11-avformat-matroskaenc-return-error-if-aac-extradata-c.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A12-videotoolbox-disable-H.264-10-bit-on-Intel-macOS-it-.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A13-libswscale-fix-yuv420p-to-p01xle-color-conversion-bu.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A14-hevc_mp4toannexb.c-fix-qsv-decode-of-10bit-hdr.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A15-Expose-the-unmodified-Dolby-Vision-RPU-T35-buffers.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A16-avcodec-amfenc-Add-support-for-on-demand-key-frames.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A17-avcodec-amfenc-properly-set-primaries-transfer-and-m.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A18-Revert-avcodec-amfenc-GPU-driver-version-check.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A19-lavc-pgssubdec-Add-graphic-plane-and-cropping.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A28-enable-av1_mf-encoder.patch' \
      'https://github.com/HandBrake/HandBrake/raw/ed8cbd1/contrib/ffmpeg/A29-Revert-lavc-Check-codec_whitelist-early-in-avcodec_o.patch'; do
      curl "$patch" | patch -F5 -lp1 -d ffmpeg -t
    done
    ;;
esac

case "$TARGET" in
  *linux*)
    patch -R -F5 -lp1 -d ffmpeg -t <"$PREFIX"/patches/use-vaMapBuffer2-for-mapping-image.patch
    ;;
esac

bak_src 'ffmpeg'

cd ffmpeg

echo "Build ffmpeg..."

# shellcheck disable=SC1091
. /srv/cap-components.sh

env_specific_arg=()

case "$TARGET" in
  x86_64*)
    env_specific_arg+=(--x86asmexe=nasm --enable-x86asm)
    ;;
  aarch64*)
    env_specific_arg+=(--x86asmexe=false --enable-vfp --enable-neon --disable-i8mm)
    ;;
esac

case "$TARGET" in
  *darwin*)
    env_specific_arg+=(
      --sysroot="${MACOS_SDKROOT:?Missing macOS SDK}"
      --disable-static
      --enable-shared
      --disable-w32threads
      --enable-pthreads
      --disable-coreimage
      --disable-avfoundation
      --disable-mediafoundation
      --enable-videotoolbox
      --enable-audiotoolbox
      --nvcc=false
      --disable-cuda-llvm
      --disable-ffnvcodec
      --disable-cuda-nvcc
    )
    ;;
  *linux*)
    env_specific_arg+=(
      --disable-static
      --enable-shared
      --disable-dotprod
      --disable-coreimage
      --disable-w32threads
      --disable-videotoolbox
      --disable-avfoundation
      --disable-audiotoolbox
      --disable-mediafoundation
      --enable-pthreads
      --enable-vaapi
      --enable-libdrm
      --nvcc=false
      --disable-cuda-llvm
      --disable-cuda-nvcc
      --enable-amf
      --enable-libvpl
    )
    case "$TARGET" in
      x86_64*) env_specific_arg+=(--enable-ffnvcodec --enable-nvenc --enable-nvdec --enable-cuvid) ;;
      *) env_specific_arg+=(--disable-ffnvcodec) ;;
    esac
    ;;
  *windows*)
    export LTO=0
    env_specific_arg+=(
      --disable-static
      --enable-shared
      --disable-dotprod
      --disable-pthreads
      --enable-w32threads
      --disable-coreimage
      --disable-videotoolbox
      --disable-avfoundation
      --disable-audiotoolbox
      --enable-mediafoundation
      --enable-d3d11va
      --enable-d3d12va
      --enable-dxva2
      --enable-ffnvcodec
      --enable-nvenc
      --enable-nvdec
      --enable-cuvid
      --nvcc=false
      --disable-cuda-llvm
      --disable-cuda-nvcc
      --enable-amf
      --enable-libvpl
      --enable-libjxl
      --enable-libdavs2
      --enable-libuavs3d
      --enable-libxevd
      --enable-libcodec2
      --enable-liblc3
    )
    ;;
esac

_arch="${TARGET%%-*}"
case "$TARGET" in
  aarch64-darwin*) _arch=arm64 ;;
esac

if [ "${LTO:-1}" -eq 1 ]; then
  env_specific_arg+=(--enable-lto=thin)
fi

if ! ./configure \
  --cpu="$_arch" \
  --arch="$_arch" \
  --prefix="$OUT" \
  --target-os="$(
    case "$TARGET" in
      *linux*) echo linux ;;
      *darwin*) echo darwin ;;
      *windows*) echo mingw64 ;;
    esac
  )" \
  --cc=cc \
  --nm=nm \
  --ar=ar \
  --cxx=c++ \
  --strip=strip \
  --ranlib=ranlib \
  --host-cc=clang-17 \
  --windres="windres" \
  --pkg-config=pkg-config \
  --pkg-config-flags="--static" \
  --enable-cross-compile \
  --enable-gpl \
  --enable-version3 \
  --enable-optimizations \
  --enable-pic \
  --enable-asm \
  --enable-inline-asm \
  --disable-debug \
  --disable-doc \
  --disable-htmlpages \
  --disable-txtpages \
  --disable-manpages \
  --disable-podpages \
  --disable-programs \
  --disable-postproc \
  --disable-network \
  --disable-openssl \
  --disable-schannel \
  --disable-securetransport \
  --disable-gnutls \
  --disable-sdl2 \
  --disable-metal \
  --disable-opengl \
  --disable-opencl \
  --disable-vulkan \
  --disable-libshaderc \
  --disable-libplacebo \
  --disable-xlib \
  --disable-libxcb \
  --disable-libxcb-shm \
  --disable-libxcb-xfixes \
  --disable-libxcb-shape \
  --disable-libv4l2 \
  --disable-v4l2-m2m \
  --disable-xmm-clobber-test \
  --disable-neon-clobber-test \
  --enable-avcodec \
  --enable-avformat \
  --enable-avfilter \
  --enable-avdevice \
  --enable-swscale \
  --enable-swresample \
  --enable-zlib \
  --enable-bzlib \
  --enable-lzma \
  --enable-libx264 \
  --enable-libopus \
  --enable-libmp3lame \
  --enable-libdav1d \
  "${CAP_COMPONENT_FLAGS[@]}" \
  "${env_specific_arg[@]}"; then
  cat ffbuild/config.log >&2
  exit 1
fi

case "$TARGET" in
  *linux*)
    sed -i 's/#define HAVE_SYSCTL 1/#define HAVE_SYSCTL 0/' config.h
    ;;
esac

make -j"$(nproc)" V=1

make install

case "$TARGET" in
  *windows*)
    find "${OUT}/lib" -type f -name '*.dll.a' -exec sh -euc \
      'for dlla in "$@"; do lib="$(basename "$dlla" .dll.a).lib" && lib="${lib#"lib"}" && if ! [ -f "$lib" ]; then mv "$dlla" "$(dirname "$dlla")/${lib}"; fi; done' \
      sh {} +
    ;;
esac
