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

### Development Requirements

- Node Version 20+
- Cargo 1.77.0+ (previous versions may work)
- pnpm 8.10.5+
- Docker ([OrbStack](https://orbstack.dev/) recommended)
- pkg-config

### How do I get started with development on my local machine?

This is a very top level guide right now, but if you want to develop for both the web app and desktop app, you will need to make sure the below steps are followed. Alternatively, if you are only looking to run the desktop app locally, you can follow the `How do I run the desktop app locally without needing to use auth?` steps.

1. Clone the repository
2. Install dependencies with `pnpm install`
3. Clone .env.example and rename it to .env
4. At the root of the directory, run the app with `pnpm dev`. This will create a local database simulator, run the necessary DB migrations, and start both the web app and desktop app concurrently.
5. Make sure both the the desktop app, and web app can be built without any errors. For the desktop app, use `pnpm tauri:build`. For the web app, use `pnpm build`
6. Submit a PR with your changes

> [!NOTE]
> When running the app locally on a MacOS machine, you will need to give permissions to Cap - this will show up as your **Terminal app** in the Security & Privacy settings page.

### How do I run the desktop app locally without needing to use auth?

You can run cap in "local mode", which means that no auth is required for the desktop app, and no video segments are uploaded. Similar to the above steps, this is how you can run the Cap desktop app in local mode with the least amount of .env vars.

1. Clone the repository
2. Install dependencies with `pnpm install`
3. Clone .env.example and rename it to .env
4. Make sure you have `NEXT_PUBLIC_ENVIRONMENT=development`, `NEXT_PUBLIC_URL=http://localhost:3000` and `NEXT_PUBLIC_LOCAL_MODE=true`. These should be the only .env vars that you require to get the desktop app up and running.
5. At the root of the directory, run the app with `pnpm dev`

### How do I view the screen recording segments locally?

The video segments are stored in your app data directory, under the folder `so.cap.desktop`. You should see a directory called `chunks`, which will contain both `video` and `audio` directories. You can find the relevant segments in either of those.

### Notes for development on Windows:

Requirements: llvm, clang and VCPKG are required for compiling ffmpeg-sys.
