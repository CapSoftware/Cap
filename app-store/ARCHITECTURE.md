# App Store architecture

This is how Cap Apps work end to end: what an app is, where it lives, how it reaches people, and what keeps it safe and fast. If you want to build an app, start with [README.md](./README.md). This document is for people working on the store itself.

## Principles

1. **One app, one manifest, one store.** There is no separate web store and desktop store. An app lists what it contributes, and Cap works out where it runs from that. People install an app once and it works everywhere they use Cap.
2. **Apps declare, Cap draws.** No app ships UI code, on the web or on desktop. Apps describe settings fields, actions and content, and Cap renders all of it with its own components. Every app looks native, stays fast, and keeps working when Cap's design changes.
3. **Trust follows the code.** Content apps have no code at all. Connection apps run their code on their author's own server and only see what their declared permissions allow. Code that runs on the device (WebAssembly, in a later API version) gets its own sandbox and capability list.
4. **The repo is the registry.** Every app is a folder in `app-store/apps`. A pull request is a submission, CI is the first reviewer, and merging publishes. Cap's build turns the folder into a signed, content-addressed catalog.
5. **Guards are code, not prose.** Every rule in the guidelines that a machine can check is checked by `bun app-store validate`, in CI and again when the catalog is built.

## Where things live

```
app-store/
  README.md            Build an app (start here)
  GUIDELINES.md        Review rules
  ARCHITECTURE.md      This file
  manifest.schema.json Generated from the manifest schema, for editor autocomplete
  templates/           Starting points used by `bun app-store new`
  apps/<id>/           One folder per app

packages/app-store/    @cap/app-store: manifest schema, validator, catalog builder,
                       CLI, request signing and verification
apps/web/              Store pages, install API, event delivery, actions
apps/desktop-gpui/     Store page in Settings, catalog sync, content and actions in the editor
```

## What an app can contribute (API version 1)

| Contribution | Kind | Runs | Where it shows up |
|---|---|---|---|
| `backgrounds` | Content | Desktop | Editor background picker, in an Apps tab |
| `captionStyles` | Content | Desktop | Editor caption presets |
| `colorLooks` | Content | Desktop | Editor color presets |
| `connection.events` | Connection | Author's server | Signed event delivery after Cap events |
| `connection.actions` | Connection | Author's server | Cap menus on web and desktop ("Send to Notion") |
| `connection.settings` | Connection | Cap | A settings form Cap renders at install, on web and desktop |

Where an app runs is worked out from its contributions and is never declared, so the badges in the store cannot drift from what the app does.

Planned for later API versions, with the manifest reserving room for them:

- **Transitions and effects** as WGSL shaders with a fixed uniform block, validated with naga in CI and on load.
- **Device code** as WebAssembly components (`wasm32-wasip2`), one frozen WIT world per API version, the way Zed does it. Device code will return the same declarative views connections use, so a slot never cares where its logic runs.
- **Scoped API tokens** for connections that need to call the Cap API, minted per install from the permissions the user granted.

## Manifest

Each app folder has a `manifest.json`. The schema lives in `packages/app-store/src/manifest.ts` and is the single source of truth: the validator, the catalog builder, the web app and the generated JSON Schema all come from it, and the desktop app parses every app in the repo in a test so its Rust types cannot drift.

```json
{
	"$schema": "../../manifest.schema.json",
	"apiVersion": 1,
	"id": "discord",
	"name": "Discord",
	"version": "1.0.0",
	"description": "Post new Caps to a Discord channel.",
	"author": { "name": "Cap", "github": "CapSoftware" },
	"license": "MIT",
	"categories": ["communication"],
	"connection": {
		"url": "/api/app-store/first-party/discord",
		"permissions": ["cap.transcript"],
		"events": ["cap.ready"],
		"settings": [
			{ "key": "webhookUrl", "type": "secret", "label": "Webhook URL", "required": true }
		],
		"actions": [{ "id": "post", "title": "Post to Discord", "target": "cap" }]
	}
}
```

`apiVersion` works like Shopify's dated API versions and Zed's frozen WIT folders. Each Cap client accepts a range of API versions, and the catalog tells it which apps it can run, so an older desktop build never sees an app it does not understand.

## Catalog

`bun app-store build` runs before the web app builds. It validates every app, then writes:

- `catalog.json`: every app's listing (name, description, icon, categories, derived platforms, permissions, contributions) plus the hash of each asset.
- `public/app-store/<id>/<sha256>.<ext>`: every asset under a content hash, served from Cap's CDN with an immutable cache header.

The web app reads the catalog in process. The desktop app fetches `GET /api/app-store/catalog` with an ETag, keeps the last copy on disk so the store works offline, downloads assets on install and checks each one against its hash before use.

The catalog also carries a `blocked` list. A blocked app disappears from the store, its connection receives nothing, and the desktop app stops loading its content on the next catalog sync. That is the kill switch.

## Installs

An install belongs to an account, never a device.

- **For me:** the app sees only Caps you own.
- **For my organization:** owners and admins install it, and it sees Caps their owners shared with that organization. A Cap that only belongs to the organization stays private to its owner. Owners can stop members from installing connection apps at all.

Installs live in `app_store_installations`, one row per app and scope, with settings encrypted using the same app-layer encryption as storage integrations. The row records the permissions and events that were granted. When a new version of an app asks for more, Cap keeps delivering only what was granted and asks for a review in the store, the way Slack asks for re-consent on new scopes.

Desktop content apps also work signed out. The desktop keeps a local install list, and when you sign in it merges that list with your account's installs.

## Connections

A connection is a server the app's author runs. Cap calls it, and it never calls into Cap's internals. All requests go to fixed paths under the declared `url`:

| Request | Path | When |
|---|---|---|
| Lifecycle | `POST {url}/lifecycle` | Installed, settings changed, uninstalled |
| Events | `POST {url}/events` | A subscribed Cap event happened |
| Actions | `POST {url}/actions/{actionId}` | Someone ran an action from a Cap menu |

Every request is signed with Ed25519, the way Discord signs interactions. Cap derives the signing key from its server secret, publishes the public key at `/.well-known/cap-app-store-keys.json`, and sends `Cap-Signature`, `Cap-Timestamp` and `Cap-Request-Id` headers. Apps verify with the public key, so no secret has to reach an author before the first request. `packages/app-store/src/signing.ts` has `verifyCapRequest`, which only needs Node's `crypto`, for authors to copy into a TypeScript server.

Payloads carry only what the install was granted. Every Cap event includes the basics (id, title, share link, owner name, creation time, duration). `cap.transcript` adds the transcript text, `cap.summary` adds the AI title, summary and chapters, and `cap.comments` adds comment text.

Delivery reuses the Infra webhook machinery: the same URL rules (https only, default port, public addresses only, no redirects), a 10 second timeout, retries with backoff over about a day on Vercel Workflow, and switching a connection off after sustained failures. Actions are synchronous with the same 10 second limit and return one of a fixed set of results (`toast` with a message, or `open` with an https URL) that Cap renders natively.

First-party connections declare a relative URL and use exactly the same signed requests, dispatched in process by the Cap server that sends them, so a self-hosted Cap serves its own and nothing listens publicly for them.

## Built-in apps

Slack, Amazon S3 and Google Drive already exist as integrations with their own flows. They appear in the store as built-in apps (`"builtin": "<name>"`), whose install button opens the existing setup. Only apps owned by Cap can declare `builtin`, and the validator enforces it.

## Guards

Checked by `bun app-store validate` in CI and again at catalog build:

- The manifest matches the schema exactly. Unknown keys are errors.
- `id` is kebab-case, 3 to 40 characters, matches the folder name, is unique, and does not contain "cap".
- `version` is semver and must go up whenever anything in the folder changes.
- Required files are present: `manifest.json`, `icon.png` (512x512, at most 256 KB), `README.md` and a license the guidelines accept.
- Only files the manifest references, plus the required ones, may be in the folder. No hidden files, symlinks, executables or archives.
- Images are PNG, JPEG or WebP, with dimensions and file sizes inside the limits for their slot, and the whole folder stays under 25 MB.
- Connection URLs are https on the default port, with a public hostname and no credentials, query or fragment.
- Settings keys are unique, select options are non-empty, there are at most 20 fields, and secrets are only ever `secret` fields.
- Only apps owned by Cap can be built-in.

Checked at runtime:

- Catalog assets are verified by hash before use.
- Connections only ever receive what was granted, within the 10 second limit, and are switched off after sustained failures.
- Action results are a fixed set; `open` URLs must be https.
- Strings from apps are rendered as plain text only, never as HTML or markdown, except the app's README on its store page, which is sanitised markdown.
