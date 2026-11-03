# niri 26.04 as released, with only its refusal of software renderers removed
# so it runs on vkms with llvmpipe: CI has no GPU. Its screencast code (format
# negotiation, GBM DMA-BUF allocation, PipeWire) is untouched.
FROM cap-harness-arch AS build
RUN pacman -Sy --noconfirm --needed base-devel git rust clang libinput libxkbcommon mesa \
      pipewire seatd pango libdisplay-info libglvnd systemd-libs >/dev/null
RUN git clone --depth 1 --branch v26.04 https://github.com/YaLTeR/niri /niri
WORKDIR /niri
RUN grep -n 'software EGL renderers are skipped' src/backend/tty.rs \
    && sed -i 's/!egl_device.is_software(),/true,/' src/backend/tty.rs \
    && grep -n 'software EGL renderers are skipped' -B2 src/backend/tty.rs
RUN cargo build --release --locked 2>&1 | tail -3 && ls -la target/release/niri
FROM cap-harness-arch
COPY --from=build /niri/target/release/niri /usr/bin/niri
