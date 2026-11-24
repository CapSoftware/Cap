#!/usr/bin/env bash
# Builds Cap's FFmpeg for one target with spacedriveapp/native-deps' Docker
# toolchain, keeping the dependency versions each platform shipped before:
# macOS from native-deps v0.25, Linux from v0.26, Windows from v0.25 with the
# library versions of the Gyan 7.1 build it replaces.
#
# Usage: scripts/ffmpeg/build.sh <target> <out-dir>
#   target: aarch64-darwin-apple | x86_64-darwin-apple | x86_64-linux-gnu | aarch64-linux-gnu | x86_64-windows-gnu
set -euo pipefail

TARGET="${1:?target}"
DEST="$(mkdir -p "${2:?out dir}" && cd "$2" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/cap-ffmpeg-${TARGET}"

case "$TARGET" in
  *darwin* | x86_64-windows-gnu) NATIVE_DEPS=047be5031239b2ea914b04b1d0a9ed5183fa327c ;;
  *-linux-gnu) NATIVE_DEPS=2c9a3fd241f60f0bc4bbc46d5be52134b83ff34a ;;
  *)
    echo "unsupported target $TARGET" >&2
    exit 1
    ;;
esac

rm -rf "$WORK"
git clone --quiet https://github.com/spacedriveapp/native-deps "$WORK"
git -C "$WORK" checkout --quiet "$NATIVE_DEPS"
cd "$WORK"

keep=(
  00-ndk.sh
  00-apple/00-sdk.sh 00-apple/01-xar.sh 00-apple/02-tapi.sh 00-apple/03-dispatch.sh
  00-apple/04-cctools.sh 00-apple/05-ldid.sh
  10-compiler-rt.sh 10-sse2neon.sh
  20-zlib.sh 20-bzip2.sh 25-lzma.sh
  45-dav1d.sh 50-x264.sh 50-opus.sh 50-lame.sh
)
case "$TARGET" in
  *linux*) keep+=(25-pciaccess.sh 45-drm.sh 50-va.sh 50-nvenc.sh 50-amf.sh 50-onevpl.sh) ;;
  *windows*) keep+=(25-lcms.sh 50-nvenc.sh 50-amf.sh 50-onevpl.sh) ;;
esac

while IFS= read -r stage; do
  name="${stage#stages/}"
  if [[ " ${keep[*]} " != *" ${name} "* ]]; then
    printf '#!/usr/bin/env -S bash -euo pipefail\nUNSUPPORTED=1\nexit 1\n' >"$stage"
  fi
done < <(find stages -type f -name '*.sh' | sort)

{
  sed '/^cap_component_flags$/d' "$HERE/components.sh"
  echo 'cap_component_flags'
  sed '/cap-components.sh/d' "$HERE/stage-ffmpeg.sh"
} >stages/99-ffmpeg.sh

if [[ "$TARGET" == *windows* ]]; then
  sed -i "s/^_commit=.*/_commit='c24e06c2e184345ceb33eb20a15d1024d9fd3497'/" stages/50-x264.sh
  sed -i "s/^_tag=.*/_tag='2.13.0'/" stages/50-onevpl.sh
  sed -i "s/^_tag=.*/_tag='1.4.2'/" stages/45-dav1d.sh
  sed -i \
    -e "s#curl_tar 'https://github.com/HandBrake/HandBrake-contribs/releases/download/contribs/AMF-1.4.33-slim.tar.gz' 'amf' 1#curl_tar 'https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v1.4.34/AMF-headers.tar.gz' 'amf' 1#" \
    -e "s#^rm -rf amf/.*##" \
    -e "s#mv 'amf/amf/public/include' \"\${PREFIX}/include/AMF\"#mv 'amf' \"\${PREFIX}/include/AMF\"#" \
    stages/50-amf.sh
  grep -q "v1.4.34/AMF-headers.tar.gz" stages/50-amf.sh
  grep -q "c24e06c2e184345ceb33eb20a15d1024d9fd3497" stages/50-x264.sh
  grep -q "_tag='2.13.0'" stages/50-onevpl.sh
  grep -q "_tag='1.4.2'" stages/45-dav1d.sh

  # Compile every Windows dependency to machine code in its own build. Left as
  # LTO bitcode, its code is generated at the FFmpeg DLL link, where zig spills
  # 32-byte AVX2 values with aligned moves to a 16-byte aligned stack (seen in
  # libopus's silk_NSQ_del_dec_avx2), which crashes when the stack lands on an
  # odd 16 bytes.
  sed -i 's/^set -euo pipefail$/set -euo pipefail\ncase "$TARGET" in *windows*) export LTO=0 ;; esac/' scripts/build.sh
  grep -q '^case "$TARGET" in \*windows\*) export LTO=0 ;; esac$' scripts/build.sh

  # Decoders Gyan's build had through external libraries, built in their own
  # layer and copied into the prefix FFmpeg links against.
  cp "$HERE/stage-windows-decoders.sh" stages/50-cap-decoders.sh
  python3 - <<'PY'
import re

path = "Dockerfile"
text = open(path).read()
layer = (
    "FROM layer-45 AS layer-50-cap-decoders\n\n"
    "RUN --mount=type=cache,target=/root/.cache `\n"
    "\t--mount=type=bind,source=stages/50-cap-decoders.sh,target=/srv/stage.sh `\n"
    "\t/srv/build.sh\n\n"
)
anchor = "FROM layer-45 AS layer-50\n"
assert text.count(anchor) == 1
text = text.replace(anchor, layer + anchor)
copy = 'COPY --from=layer-50-zimg "${PREFIX}/." "$PREFIX"\n'
assert text.count(copy) == 1
text = text.replace(copy, copy + 'COPY --from=layer-50-cap-decoders "${PREFIX}/." "$PREFIX"\n')
open(path, "w").write(text)
PY
  grep -q 'COPY --from=layer-50-cap-decoders' Dockerfile
fi

sed -i 's#^mv "${OUT}/models" .*#[ ! -d "${OUT}/models" ] || mv "${OUT}/models" "${OUT}/${_framework}/Versions/A/Resources/Models"#' scripts/create-macos-framework.sh
grep -q '\[ ! -d "${OUT}/models" \]' scripts/create-macos-framework.sh

# Only FFmpeg goes into the final image; the other native-deps outputs
# (heif, pdfium, onnx, protoc, yolo) are not built.
sed -i -E '/COPY --from=layer-99-(heif|protoc|pdfium|yolo|onnx) /d' Dockerfile
if grep -qE 'COPY --from=layer-99-(heif|protoc|pdfium|yolo|onnx) ' Dockerfile; then
  echo "Dockerfile still references unused stages" >&2
  exit 1
fi

docker build --build-arg TARGET="$TARGET" --build-arg OS_IPHONE=0 --build-arg VERSION=7.1 -o "$WORK/build" .

out="$WORK/build/out"
mv "$out/src.tar.xz" "$DEST/cap-ffmpeg-${TARGET}-src.tar.xz"
find "$out" -name '*.a' -delete
if [[ "$TARGET" == *windows* ]]; then
  archive="cap-ffmpeg-${TARGET}.zip"
  (cd "$out" && zip -qr -9 "$DEST/$archive" .)
else
  archive="cap-ffmpeg-${TARGET}.tar.xz"
  XZ_OPT='-T0 -9' tar -cJf "$DEST/$archive" -C "$out" .
fi
(cd "$DEST" && sha256sum "$archive" >"$archive.sha256")
find "$out" -type f \( -name '*.dll' -o -name '*.dylib' -o -name '*.so*' \) -exec ls -l {} + | awk '{print $5, $NF}'
du -sh "$out"
