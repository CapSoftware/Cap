<p align="center">
  <p align="center">
   <img width="150" height="150" src="/app-icon.png" alt="Logo">
  </p>
	<h1 align="center"><b>Cap</b></h1>
	<p align="center">
		Beautiful, shareable screen recordings. Open source and cross-platform.
    <br />
    <a href="https://cap.so"><strong>Cap.so »</strong></a>
    <br />
    <br />
    <b>Download for </b>
		macOS ·
		Windows ·
		Linux
    <br />
    <i>~ Cap is currently in early access testing. Join the <a href="https://discord.gg/y8gdQ3WRN3">Cap Discord</a> to help test and get early access. Public download links will be added soon. ~</i>
  </p>
</p>
<br/>

> NOTE: Cap is under active development, and is currently in early access testing. This repository is updated regularly with changes and new releases.

Cap is an open source alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.

![cap-emoji-banner](https://github.com/CapSoftware/cap/assets/33632126/85425396-ad31-463b-b209-7c4bdf7e2e4f)


# Roadmap

View what's currently in progress, and what's planned for the future: [Cap Roadmap](https://capso.notion.site/7aac740edeee49b5a23be901a7cb734e)

# Monorepo App Architecture

We use a combination of Rust, React (Next.js), TypeScript, Tauri, Drizzle (ORM), MySQL, TailwindCSS throughout this Turborepo powered monorepo.

### Apps:

- `desktop`: A [Tauri](https://tauri.app) (Rust) app, using [Next.js](https://nextjs.org) on the frontend.
- `web`: A [Next.js](https://nextjs.org) web app.

### Packages:

- `ui`: A [React](https://reactjs.org) Shared component library.
- `utils`: A [React](https://reactjs.org) Shared utility library.
- `tsconfig`: Shared `tsconfig` configurations used throughout the monorepo.
- `database`: A [React](https://reactjs.org) and [Drizzle ORM](https://orm.drizzle.team/) Shared database library.
- `config`: `eslint` configurations (includes `eslint-config-next`, `eslint-config-prettier` other configs used throughout the monorepo).

# Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for more information. This guide is a work in progress, and is updated regularly as the app matures.
