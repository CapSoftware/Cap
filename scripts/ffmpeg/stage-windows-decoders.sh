#!/usr/bin/env -S bash -euo pipefail

# Windows only. The Gyan build Cap shipped before decodes JPEG XL, AVS2, AVS3,
# EVC, Codec2 and LC3 through external libraries that FFmpeg has no native
# decoder for. Build those libraries at the versions Gyan 7.1 used so imports
# that decoded before still decode.

case "$TARGET" in
  *windows*) ;;
  *)
    UNSUPPORTED=1
    exit 1
    ;;
esac

fetch() {
  mkdir -p "$1"
  curl_tar "https://github.com/$2/archive/$3.tar.gz" "$1" 1
}

append_pc() {
  sed -ri "s/^($2:.*)$/\1 $3/" "${PREFIX}/lib/pkgconfig/$1"
}

# CMake projects add -pthread to the helper programs they build alongside the
# libraries. Zig's MinGW has no libpthread; the libraries use Win32 threads,
# so give those program links an empty one. FFmpeg never links against it.
mkdir -p /srv/nopthread
ar rcs /srv/nopthread/libpthread.a
export LDFLAGS="${LDFLAGS} -L/srv/nopthread"

echo "Download decoder libraries..."
fetch libjxl libjxl/libjxl 7e178a51b0a59fcc8e58c78ce88058a9b97abf5b
fetch libjxl/third_party/highway google/highway 457c891775a7397bdb0376bb1031e6e027af1c48
fetch libjxl/third_party/brotli google/brotli v1.1.0
fetch davs2 pkuvcl/davs2 b41cf117452e2d73d827f02d3e30aa20f1c721ac
fetch uavs3d uavs3/uavs3d 1fd04917cff50fac72ae23e45f82ca6fd9130bd8
fetch xevd mpeg5/xevd 70e18a507022790339690407c263ac172ace3cb0
fetch codec2 drowe67/codec2 ff00a6e2489f870abb10117ff5bf4b0a64bf05d4
fetch lc3 google/liblc3 0d45f4ecf6d5d0e9c0dd392d84f371c4e01aed60

for src in libjxl davs2 uavs3d xevd codec2 lc3; do
  bak_src "$src"
done

echo "Build libjxl..."
(
  export CFLAGS="${CFLAGS} -DJXL_STATIC_DEFINE -DJXL_THREADS_STATIC_DEFINE -DJXL_CMS_STATIC_DEFINE"
  export CXXFLAGS="${CXXFLAGS} -DJXL_STATIC_DEFINE -DJXL_THREADS_STATIC_DEFINE -DJXL_CMS_STATIC_DEFINE"
  cmake -S libjxl -B libjxl/build \
    -DBUILD_TESTING=OFF \
    -DJPEGXL_STATIC=ON \
    -DJPEGXL_ENABLE_TOOLS=OFF \
    -DJPEGXL_ENABLE_JPEGLI=OFF \
    -DJPEGXL_ENABLE_BENCHMARK=OFF \
    -DJPEGXL_ENABLE_DOXYGEN=OFF \
    -DJPEGXL_ENABLE_JNI=OFF \
    -DJPEGXL_ENABLE_MANPAGES=OFF \
    -DJPEGXL_ENABLE_OPENEXR=OFF \
    -DJPEGXL_ENABLE_SJPEG=OFF \
    -DJPEGXL_ENABLE_SKCMS=OFF \
    -DJPEGXL_ENABLE_EXAMPLES=OFF \
    -DBROTLI_DISABLE_TESTS=ON \
    -DJPEGXL_FORCE_SYSTEM_LCMS2=ON
  ninja -C libjxl/build -j"$(nproc)"
  ninja -C libjxl/build install
)
for pc in libjxl.pc libjxl_threads.pc libjxl_cms.pc; do
  if [ -f "${PREFIX}/lib/pkgconfig/${pc}" ]; then
    append_pc "$pc" Cflags '-DJXL_STATIC_DEFINE -DJXL_THREADS_STATIC_DEFINE -DJXL_CMS_STATIC_DEFINE'
    append_pc "$pc" Libs.private '-lstdc++'
  fi
done

echo "Build davs2..."
(
  cd davs2/build/linux
  # The endian probe reads strings from an object file, which LTO bitcode
  # hides; every Windows target is little endian.
  sed -i -e 's/EGIB/bss/g' -e 's/naidnePF/bss/g' configure
  ./configure \
    --prefix="$PREFIX" \
    --host=x86_64-w64-mingw32 \
    --enable-pic \
    --disable-cli
  make -j"$(nproc)"
  make install
)

echo "Build uavs3d..."
(
  # A 10-bit build decodes both 8 and 10-bit streams, as Gyan's does.
  cmake -S uavs3d -B uavs3d/build -DCOMPILE_10BIT=ON
  ninja -C uavs3d/build -j"$(nproc)"
  ninja -C uavs3d/build install
)

echo "Build xevd..."
(
  echo 'v0.5.0' >xevd/version.txt
  sed -i 's/-Werror //' xevd/CMakeLists.txt
  sed -i '/add_subdirectory(app)/d' xevd/CMakeLists.txt
  # Use xevd's Win32 thread pool instead of pthreads.
  export CFLAGS="${CFLAGS} -DWIN32 -DWIN64"
  cmake -S xevd -B xevd/build
  ninja -C xevd/build -j"$(nproc)" xevd
  ninja -C xevd/build install
)
rm -f "${PREFIX}"/lib/libxevd.dll.a "${PREFIX}"/bin/libxevd*.dll "${PREFIX}"/bin/xevd*.dll
sed -i 's|^Libs: -L${libdir} -lxevd|Libs: -L${libdir}/xevd -lxevd|' "${PREFIX}/lib/pkgconfig/xevd.pc"
append_pc xevd.pc Cflags '-DXEVD_STATIC_DEFINE'

echo "Build codec2..."
(
  # codec2 generates its codebooks with a tool it builds for the target; build
  # that tool for the build machine instead.
  mkdir -p /srv/codec2-host
  clang-17 -O2 codec2/src/generate_codebook.c -lm -o /srv/codec2-host/generate_codebook
  sed -i '/ExternalProject_Add(codec2_native/,/^    )$/d' codec2/src/CMakeLists.txt
  sed -i '/add_dependencies(generate_codebook codec2_native)/d' codec2/src/CMakeLists.txt
  sed -i 's#IMPORTED_LOCATION ${CMAKE_CURRENT_BINARY_DIR}/generate_codebook#IMPORTED_LOCATION /srv/codec2-host/generate_codebook#' codec2/src/CMakeLists.txt
  grep -q 'IMPORTED_LOCATION /srv/codec2-host/generate_codebook' codec2/src/CMakeLists.txt
  if grep -q 'codec2_native' codec2/src/CMakeLists.txt; then
    echo "codec2 still builds its codebook tool for the target" >&2
    exit 1
  fi
  sed -i 's|if(WIN32)|if(FALSE)|g' codec2/CMakeLists.txt
  sed -i '/add_subdirectory(demo)/d' codec2/CMakeLists.txt
  cmake -S codec2 -B codec2/build -DUNITTEST=OFF -DINSTALL_EXAMPLES=OFF -DLPCNET=OFF
  ninja -C codec2/build -j"$(nproc)" codec2
  ninja -C codec2/build install
)

echo "Build lc3..."
(
  mkdir -p lc3/build
  cd lc3/build
  if ! meson -Dtools=false -Dpython=false ..; then
    cat meson-logs/meson-log.txt
    exit 1
  fi
  ninja -j"$(nproc)"
  ninja install
)

for pc in libjxl.pc libjxl_threads.pc davs2.pc uavs3d.pc xevd.pc codec2.pc lc3.pc; do
  test -f "${PREFIX}/lib/pkgconfig/${pc}"
done
