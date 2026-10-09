# Build from the repository root:
#   docker build -f apps/render-farm/Dockerfile -t cap-render-farm .
FROM rust:1.90-trixie AS engine
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		clang libclang-dev libssl-dev libasound2-dev libx11-dev libvulkan-dev \
		pkg-config ffmpeg libavcodec-dev libavformat-dev libavfilter-dev \
		libavdevice-dev libavutil-dev libswscale-dev libswresample-dev \
		libpostproc-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY vendor ./vendor
COPY apps/cli ./apps/cli
COPY apps/desktop/src-tauri ./apps/desktop/src-tauri
# The hot loops run on the GPU (NVDEC, Vulkan compositing, NVENC); fat LTO
# costs minutes per build for no measurable export speed.
ENV CARGO_PROFILE_RELEASE_LTO=false \
	CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
	CARGO_PROFILE_RELEASE_DEBUG=0
RUN cargo build --release --locked -p cap-render-farm \
	&& install -Dm755 target/release/cap-render-farm /out/cap-render-farm

FROM oven/bun:1.4.0 AS bun

FROM debian:trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ffmpeg libasound2t64 libvulkan1 mesa-vulkan-drivers fontconfig \
		fonts-dejavu-core ca-certificates libx11-6 libxext6 libgl1 libegl1 \
		libglvnd0 \
	&& rm -rf /var/lib/apt/lists/*
# The NVIDIA container toolkit mounts the driver libraries but not the
# manifests. NVIDIA's headless Vulkan goes through EGL, so without the glvnd
# EGL vendor file the ICD fails to initialise and wgpu silently falls back to
# llvmpipe.
RUN mkdir -p /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d \
	&& printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}\n' \
		> /usr/share/vulkan/icd.d/nvidia_icd.json \
	&& printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}\n' \
		> /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV NVIDIA_VISIBLE_DEVICES=all \
	NVIDIA_DRIVER_CAPABILITIES=all \
	CAP_LINUX_GPU_FRAMES=1 \
	CAP_LINUX_HW_DECODE=cuda \
	RF_ENCODER=h264_nvenc \
	RF_NVENC_PRESET=p1 \
	RF_REQUIRE_GPU=1
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=engine /out/cap-render-farm /usr/local/bin/cap-render-farm
WORKDIR /app
COPY apps/render-farm/src ./src
CMD ["bun", "/app/src/boot.ts"]
