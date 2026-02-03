#!/bin/bash
echo "Configuring Cap Desktop Build Environment..."

# 1. Disable VCPKG to prevent conflicts
unset VCPKG_ROOT
echo " - Unset VCPKG_ROOT"

# 2. Add CMake to PATH (VS Build Tools)
export PATH="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin:$PATH"

# 3. Configure FFmpeg 6.1
export FFMPEG_DIR="C:/Tools/ffmpeg-6.1-shared"
export PATH="$FFMPEG_DIR/bin:$PATH"
export BINDGEN_EXTRA_CLANG_ARGS="-I$FFMPEG_DIR/include"
echo " - Configured FFmpeg 6.1 at $FFMPEG_DIR"

# 4. Configure Clang
export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
echo " - Configured Clang at $LIBCLANG_PATH"

# 5. Ensure DLLs are present in target (Fixes STATUS_DLL_NOT_FOUND)
TARGET_DIR="../../../target/debug"
if [ -d "$TARGET_DIR" ]; then
    echo " - Copying FFmpeg DLLs to target/debug..."
    cp "$FFMPEG_DIR/bin/"*.dll "$TARGET_DIR/" 2>/dev/null || true
fi

echo "✅ Environment Ready! You can now run 'pnpm tauri dev'."
