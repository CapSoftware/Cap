# Cap Contributor Guide: Work In Progress

## Introduction

### What is Cap?

Cap is an open-source and privacy-focused alternative to Loom. It's a video messaging tool that allows you to record, edit, and share videos in seconds.

The development of Cap is still in its early stages, so please bear with us as we build out this guide.

### What is this guide?

This guide is for anyone who wants to contribute to Cap. It's a work in progress and will be updated regularly.

### How can I contribute?

There are many ways to contribute to Cap. You can:

- [Report a bug](https://github.com/CapSoftware/cap/issues/new)
- [Suggest a feature (via Discord)](https://discord.com/invite/y8gdQ3WRN3)
- Submit a PR

### How do I get started with development on my local machine?

This is a very top-level guide right now, but the basics are:

1. Clone the repository
2. Install dependencies with `pnpm install`
3. Duplicate the example env file - `cp .env.example .env`
4. Add your own API keys to the `.env` file
5. Run the app with `pnpm dev`
6. Make sure both the desktop app and web app can be built without any errors. For the desktop app, use `pnpm tauri:build`. For the web app, use `pnpm build`
7. Submit a PR with your changes
