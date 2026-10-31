# Cap Contributor Guide

## Introduction

### What is Cap?

Cap is an open source and privacy focused alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.

The development of Cap is still in its early stages, so please bare with us as we build out this guide.

### What is this guide?

This guide is for anyone who wants to contribute to Cap. It's a work in progress, and will be updated regularly.

### How can I contribute?

There are many ways to contribute to Cap. You can:

- [Report a bug](https://github.com/CapSoftware/cap/issues/new)
- [Suggest a feature (via Discord)](https://discord.com/invite/y8gdQ3WRN3)
- Submit a PR

## Running Cap

### Development Requirements

Before anything else, make sure you have the following installed:

- Node Version 24+
- Rust via [rustup](https://rustup.rs) (the workspace pins 1.88.0; the desktop app pins its own toolchain, which rustup installs on first build)
- Bun 1.4.4
- Docker ([OrbStack](https://orbstack.dev/) recommended)

### General Setup

Keep the root `react` and `react-dom` development dependencies aligned with `apps/mobile`. They keep Expo native dependencies deduplicated under Bun’s hoisted linker, while the web app retains its separately resolved React version.

Run `bun install`, then run `bun run env-setup` to generate a `.env` file configured for your environment.
It will ask you which apps you intend to run, whether you'd like to use Docker to run S3 (MinIO) and MySQL locally,
and allow you to provide overrides as needed.

Then run `bun run cap-setup` to install native dependencies such as FFmpeg.

On Windows, llvm, clang, and VCPKG must be installed.
On MacOS, cmake must be installed.
`bun run cap-setup` does not yet install these dependencies for you.

To run both `@cap/desktop` and `@cap/web` together, use `bun run dev`.
To run only one of them, use `bun run dev:desktop` or `bun run dev:web` respectively.

### `@cap/desktop` (desktop app)

The desktop app lives in `apps/desktop-gpui`. It is native Rust with a [GPUI](https://www.gpui.rs/) interface,
and [its README](apps/desktop-gpui/README.md) covers how it is built, packaged, and updated.

`bun run dev:desktop` checks out Cap's patched gpui next to this repository (`../zed-cap`) on first run,
then starts the app. On macOS it rebuilds on save and relaunches the app where you left it (`apps/desktop-gpui/dev.sh`);
on Windows and Linux it builds and runs the app once. The first build takes around ten minutes.

When running the desktop app from a terminal on macOS,
you will need to grant permissions (screen recording, microphone, etc.) to the terminal, not the Cap app.
For example, if you run `bun run dev:desktop` in the macOS `Terminal.app`, grant the permissions to `Terminal.app`.

#### Where are my recordings stored?

Development builds use the same data directory as an installed Cap:
`~/Library/Application Support/so.cap.desktop/recordings` on macOS,
`%APPDATA%\so.cap.desktop\recordings` on Windows,
and `~/.local/share/so.cap.desktop/recordings` on Linux.
Set `CAP_GPUI_APP_DATA_DIR` to keep a development build's recordings and settings separate.

### `@cap/web` (cap.so website)

When running `bun run dev` or `bun run dev:web`, a MySQL database and MinIO S3 server will also be using Docker.
If you want to _only_ run the `@cap/web` NextJS app, `cd` into `./apps/web` and run `bun run dev`.
