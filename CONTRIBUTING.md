# Cap Contributor Guide: Work In Progress

**TLDR:** The quickest way to contribute to the Cap desktop app, without any external dependencies required, is the `How do I run the desktop app locally without needing to use auth?` section of this guide.

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

## Runing Cap

### Development Requirements

Before anything else, make sure you have the following installed:

- Node Version 20+
- Rust 1.88.0+
- pnpm 8.10.5+
- Docker ([OrbStack](https://orbstack.dev/) recommended)

### General Setup

Configure the necessary environment variables by copying the `.env.example` file to `.env`.
`.env.example` by default assumes you want to run both `@cap/desktop` and `@cap/web` locally.
Follow the instructions in the file for how to configure the environment variables for which apps you want to run.

Run `pnpm install`,
then run `pnpm cap-setup` to install native dependencies such as FFmpeg.

On Windows, llvm, clang, and VCPKG must be installed.
On MacOS, cmake must be installed.
`pnpm cap-setup` does not yet install these dependencies for you.

To run both `@cap/desktop` and `@cap/web` together, use `pnpm dev`.
To run only one of them, use `pnpm dev:desktop` or `pnpm dev:web` respectively.

### `@cap/desktop` (desktop app)

When running `@cap/desktop` from a terminal on macOS,
you will need to grant permissions (screen recording, microphone, etc.) to the terminal, not the Cap app.
For example, if you run `pnpm dev:desktop` in the macOS `Terminal.app`,
you will need to grant permissions to it instead of `Cap - Development.app`.

#### Where are my recordings stored?

You can find your recordings at `~/Library/Application Support/so.cap.desktop.dev/recordings` on macOS,
and `%programfiles%/so.cap.desktop.dev/recordings` on Windows.

### `@cap/web` (cap.so website)

When running `pnpm dev` or `pnpm dev:web`, a MySQL database and MinIO S3 server will also be using Docker.
If you want to _only_ run the `@cap/web` NextJS app, `cd` into `./apps/web` and run `pnpm dev`.
