## Merging upstream Cap into this fork

Name, icon and logo live behind one door so upstream files stay close to upstream:

- `crates/fork-brand/brand.json` holds the name, the `zworm` command, the skill name, the kept identifiers and the macOS strings. `crates/fork-brand/templates/` holds the agent skill and CLI help. `crates/fork-brand/kept-names.json` lists every old-name identifier that must not change, with the reason.
- `apps/desktop-gpui/assets/branding/brand.svg` is the one master for the art. `node scripts/fork-brand-assets.mjs` regenerates every size from it, and needs `rsvg-convert` and macOS `iconutil`.
- `tauri.conf.json` and `Info.plist` stay upstream's. `scripts/fork-brand.mjs` passes the identity to `tauri bundle` as a config overlay and stamps the plist of the built app in `scripts/bundle-ux-walk.mjs`.
- Upstream's window titles and catalog strings stay in place. `fork_brand::text` brands them when the app runs, and a test build keeps upstream's words so upstream's tests stay unchanged.
- The cloud Worker imports `brand.json` and fills `%app%` in its pages.

To rename: change `brand.json`, moving the old name into `former_names` so saved window rules follow it, replace `brand.svg`, run the asset script, and update the prose docs listed in `kept-names.json`. `node --test scripts/fork-branding.test.mjs` fails on any hard-coded name elsewhere.

The dock icon is the one image still at an upstream path, because two upstream files embed it. A nested `.gitattributes` in `apps/desktop-gpui/assets/` marks it `merge=ours`, and `apps/desktop-gpui/assets/branding/` keeps its master. Logos are drawn from a fork overlay in `src/ux_walk/assets.rs` instead, and the app icons from `assets/branding/app/`. The `ours` driver is not built into Git, so define it once per clone (worktrees share it) before merging, and turn on rerere for repeated conflicts:

```bash
git config merge.ours.driver true
git config rerere.enabled true
git config rerere.autoupdate true
```

After each merge, run `node --test scripts/fork-branding.test.mjs`. It fails when an upstream path no longer matches its master, upstream stopped drawing a protected path, or a fork name appears outside the door; re-copy the master, move it to the new path and update the guard, or route the name through the door.

## Upstream Cap development and self-hosting

The remaining documentation describes the underlying Cap platform. Its cloud features require the appropriate service or a self-hosted deployment.

## Self-Hosting

The fastest way to self-host Cap Web is Docker Compose:

```bash
git clone https://github.com/CapSoftware/Cap.git
cd Cap
docker compose up -d
```

Cap will be available at `http://localhost:3000`.

Login links appear in the service logs when email is not configured:

```bash
docker compose logs cap-web
```

### Deployment Options

| Method | Best for |
| --- | --- |
| Docker Compose | VPS, home servers, and any Docker-capable host |
| [Railway](https://railway.com/new/template/PwpGcf) | One-click managed hosting |
| Coolify | Self-hosted PaaS deployments with `docker-compose.coolify.yml` |

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/PwpGcf)

For production, configure public URLs and replace the default secrets before exposing the deployment to the internet:

```bash
CAP_URL=https://cap.yourdomain.com
S3_PUBLIC_URL=https://s3.yourdomain.com
```

See the [self-hosting guide](https://cap.so/docs/self-hosting) for email setup, AI providers, SSL, storage, production hardening, and troubleshooting.

## Local Development

Cap is a Turborepo monorepo with Rust, TypeScript, Tauri, SolidStart, Next.js, Drizzle, MySQL, Tailwind CSS, and shared media crates.

Requirements:

- Node.js 20 or newer
- Bun 1.4.0
- Rust 1.88 or newer
- Docker for MySQL, MinIO, and local services

Install and set up the repo:

```bash
bun install
bun run env-setup
bun run cap-setup
```

Common commands:

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the full local development stack |
| `bun run dev:web` | Start the web app without the desktop app |
| `bun run dev:desktop` | Start the desktop app |
| `bun run build` | Build the workspace |
| `bun run tauri:build` | Build the desktop release |
| `bun run lint` | Run Biome linting |
| `bun run format` | Format with Biome |
| `bun run typecheck` | Run TypeScript project references |
| `cargo test -p <crate>` | Run Rust tests for a crate |

Database commands:

| Command | Purpose |
| --- | --- |
| `bun run db:generate` | Generate database artifacts |
| `bun run db:push` | Push schema changes |
| `bun run db:studio` | Open Drizzle Studio |

## Repository Map

| Path | What lives there |
| --- | --- |
| `apps/desktop` | Tauri v2 desktop app with SolidStart UI and Rust backend |
| `apps/web` | Next.js web app for marketing, docs, dashboard, sharing, API routes, and auth |
| `apps/cli` | Rust CLI |
| `apps/media-server` | Media processing service used by the web app |
| `apps/discord-bot` | Discord integration |
| `packages/database` | Drizzle schema and database access |
| `packages/ui` | Shared React UI |
| `packages/ui-solid` | Shared Solid UI |
| `packages/web-backend` | Backend service layer |
| `packages/web-domain` | Web domain models and types |
| `packages/env` | Environment validation |
| `packages/sdk-embed` | Embed SDK |
| `packages/sdk-recorder` | Recorder SDK |
| `crates/*` | Recording, capture, camera, audio, encoding, rendering, muxing, export, and test crates |
| `scripts/*` | Setup, analytics, build, and maintenance tooling |
| `infra/*` | Infrastructure configuration |

The web API uses Effect and `@effect/platform` HTTP APIs. Desktop capture and export paths are backed by Rust crates for fast recording, rendering, and platform-specific media access.

## Analytics

Cap uses [Tinybird](https://www.tinybird.co) for viewer telemetry dashboards. Set `TINYBIRD_ADMIN_TOKEN` or `TINYBIRD_TOKEN` before running analytics commands.

| Command | Purpose |
| --- | --- |
| `bun run analytics:setup` | Deploy Tinybird datasources and pipes from `scripts/analytics/tinybird` |
| `bun run analytics:check` | Validate that the Tinybird workspace matches the app expectations |

`analytics:setup` can remove Tinybird resources outside the checked-in analytics configuration. Use it only against the workspace you intend to manage from this repo.

## Contributing

Cap is built in public. Issues, pull requests, design feedback, bug reports, docs fixes, and bounties are welcome.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Join the community on [Discord](https://cap.link/discord).
- Check open bounties on [Algora](https://console.algora.io/org/CapSoftware/bounties?status=open).

## License

Portions of this software are licensed as follows:

- Code in the `cap-camera*` and `scap-*` crate families is licensed under the MIT License. See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- Third-party components are licensed under the original license provided by their owner.
- All other content not mentioned above is available under the AGPLv3 license as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).

