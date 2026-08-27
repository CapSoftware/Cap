# Linux packages

Build release packages on Linux with the desktop dependencies installed:

```sh
pnpm with-env node scripts/build-linux-packages.mjs x86_64-unknown-linux-gnu --config src-tauri/tauri.prod.conf.json
```

The wrapper builds the CLI, GPUI, Tauri, DEB, RPM, and AppImage artifacts. It requires `TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Release CI supplies these through secrets; use a disposable key and matching updater public-key configuration for sandbox tests.

Prerelease versions containing a hyphen build DEB and AppImage but skip RPM, whose version format does not accept that character. Stable releases build all three formats. Arch packages can be built from either stable or prerelease DEBs.

## AppImage finalization

Use the Linux wrapper for distributable AppImages. The generic `build:tauri` command produces an intermediate AppImage that still needs finalization.

Bundled Wayland and PipeWire libraries can conflict with newer host Mesa drivers and ALSA plugins. The finalizer extracts the produced AppImage, removes `libwayland-client.so*` and the `usr/lib/libpipewire-0.3.so*` copy, and rebuilds it with Tauri's cached `linuxdeploy-plugin-appimage.AppImage`. It preserves other libraries, the existing AppRun, and GTK/GStreamer hooks. It supplies the input image's runtime to the output plugin through `LDAI_RUNTIME_FILE`, avoiding a new runtime download during finalization. It checks every runtime byte except the 16-byte payload checksum that appimagetool regenerates, locating that section with `readelf` from binutils. It does not replace cached packaging tools and fails if the output plugin is unavailable. Inputs must use Tauri's external updater signature; embedded GPG signatures are not supported.

The original launcher is retained as `AppRun.cap-original`. A small wrapper captures the caller's working directory before AppRun changes it, for both normal and `--appimage-extract-and-run` launches. CLI dispatch restores that directory so relative project and output paths work. An unavailable original directory produces an error instead of resolving paths inside the mounted image. GUI working-directory behavior is unchanged.

The finalizer signs the rebuilt bytes and replaces the artifact and its adjacent `.sig` only after packaging and signing succeed. With `createUpdaterArtifacts: true`, the updater consumes this `.AppImage` and `.AppImage.sig` pair, not a tar archive. Do not upload the signature from the intermediate image.

For an explicitly unsigned local test artifact:

```sh
node scripts/finalize-linux-appimage.mjs --unsigned target/x86_64-unknown-linux-gnu/release/bundle/appimage/Cap_0.6.0_amd64.AppImage
```

This removes any old signature. The host must provide its Wayland client and PipeWire libraries alongside its graphics drivers and audio plugins.

## Arch Linux and Omarchy

Run the package builder as an ordinary user in an Arch environment with `makepkg` and `bsdtar`:

```sh
bash scripts/build-linux-arch-package.sh Cap_0.6.0_amd64.deb ./arch-packages
sudo pacman -U ./arch-packages/cap-bin-0.6.0-1-x86_64.pkg.tar.zst
```

The builder reuses the exact DEB payload, changes the package-format marker, and declares Arch dependencies. It does not strip or rebuild the executables. Release CI uses a pinned Arch container without network access during packaging.

On Omarchy, screen capture uses the installed Hyprland desktop portal and PipeWire. Package installation alone does not verify recording, playback, export, or device access; these require tests in the target desktop session.

## CLI camera in Instant mode

On Linux, `cap record start --mode instant --camera DEVICE` composites the camera directly into the recorded screen or window. The CLI uses an unmirrored square at the bottom right, sized to 30% of the shorter screen edge with a 2% margin. Camera images are center-cropped without stretching. If camera frames stop arriving, screen recording continues without a stale camera image.

This CLI default does not change desktop camera-window settings or Studio's separate, editable camera track.

## Updates and verification

DEB and AppImage installations use separate updater targets. RPM and Arch installations direct users to update through their package manager or install the latest package, avoiding an incompatible DEB update.

The release workflow checks bundled executables, native FFmpeg libraries, package markers, AppImage audio configuration, RPM version metadata, and final updater signatures. Runtime validation must additionally cover GPUI/Tauri switching, capture permissions, screen/window/area selection, camera and audio, playback, export, and CLI behavior on each supported desktop.
