<p align="center">
  <p align="center">
   <img width="150" height="150" src="https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/icons/Square310x310Logo.png" alt="Logo">
  </p>
	<h1 align="center"><b>Cap</b></h1>
	<p align="center">
		The open source Loom alternative.
    <br />
    <a href="https://cap.so"><strong>Cap.so »</strong></a>
    <br />
    <br />
    <b>Downloads for </b>
		<a href="https://cap.so/download">macOS & Windows</a>
    <br />
  </p>
</p>
<br/>

[![Open Bounties](https://img.shields.io/endpoint?url=https%3A%2F%2Fconsole.algora.io%2Fapi%2Fshields%2FCapSoftware%2Fbounties%3Fstatus%3Dopen)](https://console.algora.io/org/CapSoftware/bounties?status=open)

Cap is the open source alternative to Loom. It's a video messaging tool that allows you to record, edit and share videos in seconds.

<img src="https://raw.githubusercontent.com/CapSoftware/Cap/refs/heads/main/apps/web/public/landing-cover.png"/>

# Self Hosting

### Quick Start (One Command)

```bash
git clone https://github.com/CapSoftware/Cap.git && cd Cap && docker compose up -d
```

Cap will be running at `http://localhost:3000`. That's it!

> **Note:** Login links appear in the logs (`docker compose logs cap-web`) since email isn't configured by default.

### Other Deployment Options

| Method | Best For |
|--------|----------|
| **Docker Compose** | VPS, home servers, any Docker host |
| **[Railway](https://railway.com/new/template/PwpGcf)** | One-click managed hosting |
| **Coolify** | Self-hosted PaaS (use `docker-compose.coolify.yml`) |

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/PwpGcf)

### Production Configuration

For production, create a `.env` file:

```bash
CAP_URL=https://cap.yourdomain.com
S3_PUBLIC_URL=https://s3.yourdomain.com
```

See our [self-hosting docs](https://cap.so/docs/self-hosting) for full configuration options including email setup, AI features, and SSL.

Cap Desktop can connect to your self-hosted instance via Settings → Cap Server URL.

# Monorepo App Architecture

We use a combination of Rust, React (Next.js), TypeScript, Tauri, Drizzle (ORM), MySQL, TailwindCSS throughout this Turborepo powered monorepo.

> A note about database: The codebase is currently designed to work with MySQL only. MariaDB or other compatible databases might partially work but are not officially supported.

### Apps:

- `desktop`: A [Tauri](https://tauri.app) (Rust) app, using [SolidStart](https://start.solidjs.com) on the frontend.
- `web`: A [Next.js](https://nextjs.org) web app.

### Packages:

- `ui`: A [React](https://reactjs.org) Shared component library.
- `utils`: A [React](https://reactjs.org) Shared utility library.
- `tsconfig`: Shared `tsconfig` configurations used throughout the monorepo.
- `database`: A [React](https://reactjs.org) and [Drizzle ORM](https://orm.drizzle.team/) Shared database library.
- `config`: `eslint` configurations (includes `eslint-config-next`, `eslint-config-prettier` other configs used throughout the monorepo).

### License:
Portions of this software are licensed as follows:

- All code residing in the `cap-camera*` and `scap-*` families of crates is licensed under the MIT License (see [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT)).
- All third party components are licensed under the original license provided by the owner of the applicable component
- All other content not mentioned above is available under the AGPLv3 license as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE)
  
# Deeplinks

Cap Desktop supports deeplinks via the `cap-desktop://` scheme (Tauri deep link). Actions are passed as a JSON payload in the `value` query param.

**Format**

```
cap-desktop://action?value={JSON}
```

**Examples**

Start recording (screen capture):
```
cap-desktop://action?value={"start_recording":{"capture_mode":{"screen":"Built-in Display"},"camera":null,"mic_label":null,"capture_system_audio":true,"mode":"instant"}}
```

Start recording (window capture):
```
cap-desktop://action?value={"start_recording":{"capture_mode":{"window":"My App"},"camera":null,"mic_label":null,"capture_system_audio":true,"mode":"instant"}}
```

Stop recording:
```
cap-desktop://action?value={"stop_recording":{}}
```

Pause recording:
```
cap-desktop://action?value={"pause_recording":{}}
```

Resume recording:
```
cap-desktop://action?value={"resume_recording":{}}
```

Switch microphone (by label):
```
cap-desktop://action?value={"set_microphone":{"mic_label":"MacBook Pro Microphone"}}
```

Switch camera (by device id or model id):
```
cap-desktop://action?value={"set_camera":{"camera":{"DeviceID":"<device-id>"}}}
```

Open settings:
```
cap-desktop://action?value={"open_settings":{"page":"general"}}
```

Open editor (macOS file deeplink):
```
file:///path/to/project
```

## Raycast Extension
A minimal Raycast extension is available under `apps/raycast`. It triggers the same deeplinks above.

Commands included:
- Start Recording (Screen)
- Start Recording (Window)
- Stop Recording
- Pause Recording
- Resume Recording
- Switch Microphone (by label)
- Switch Camera (by device id or model id)

# Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for more information. This guide is a work in progress, and is updated regularly as the app matures.

## Analytics (Tinybird)

Cap uses [Tinybird](https://www.tinybird.co) to ingest viewer telemetry for dashboards. The Tinybird admin token (`TINYBIRD_ADMIN_TOKEN` or `TINYBIRD_TOKEN`) must be available in your environment. Once the token is present you can:

- Provision the required data sources and materialized views via `pnpm analytics:setup`. This command installs the Tinybird CLI (if needed), runs `tb login` when a `.tinyb` credential file is missing, copies that credential into `scripts/analytics/tinybird`, and finally executes `tb deploy --allow-destructive-operations --wait` from that directory. **It synchronizes the Tinybird workspace to the resources defined in `scripts/analytics/tinybird`, removing any other datasources/pipes in that workspace.**
- Validate that the schema and materialized views match what the app expects via `pnpm analytics:check`.

Both commands target the workspace pointed to by `TINYBIRD_HOST` (defaults to `https://api.tinybird.co`). Make sure you are comfortable with the destructive nature of the deploy step before running `analytics:setup`.
