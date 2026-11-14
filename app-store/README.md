# Build a Cap App

Cap Apps add things to Cap: backgrounds and caption styles in the editor, color looks, and connections that send Caps to the tools people already use. Every app lives in this folder, and opening a pull request is how you publish one.

People install an app once from the App Store, on the web or in Cap Desktop, and it works everywhere they use Cap.

## Quick start

```sh
bun install
bun app-store new my-app                         # content app (backgrounds, captions, looks)
bun app-store new my-app --template connection   # app backed by your own server
bun app-store validate                           # run every check CI runs
```

Then edit `app-store/apps/my-app/manifest.json`, replace `icon.png` and `README.md`, and open a pull request.

## What an app is

A folder with a manifest, an icon and a README:

```
app-store/apps/my-app/
  manifest.json   What the app is and what it adds
  icon.png        512x512 PNG, at most 256 KB
  README.md       What it does and how to set it up
  CHANGELOG.md    Optional
  ...             Images the manifest references, such as backgrounds/ocean.jpg
```

Nothing else may be in the folder. Your editor autocompletes and checks `manifest.json` through its `$schema` line.

## What an app can add

### Backgrounds

Images or gradients that appear in an Apps tab of the editor's background picker.

```json
"backgrounds": [
	{ "id": "ocean", "name": "Ocean", "image": "backgrounds/ocean.jpg" },
	{ "id": "sunset", "name": "Sunset", "gradient": { "from": "#FF7E5F", "to": "#6A3093", "angle": 135 } },
	{ "id": "ink", "name": "Ink", "color": "#111827" }
]
```

Images are PNG, JPEG or WebP, at least 1920x1080, at most 7680 pixels on a side and 8 MB each. 2560x1440 JPEG is the sweet spot: Cap renders backgrounds at up to 2560 pixels wide. Up to 24 per app.

### Caption styles

Presets in the editor's caption panel. Every field is required so a style always looks the same.

```json
"captionStyles": [
	{
		"id": "headline", "name": "Headline", "description": "Big and bold",
		"fontWeight": 700, "size": 64, "color": "#FFFFFF",
		"backgroundColor": "#000000", "backgroundOpacity": 0,
		"outline": true, "outlineColor": "#000000",
		"highlightColor": "#FFD43B", "activeWordHighlight": true,
		"highlightStyle": "color", "animation": "pop",
		"uppercase": true, "fadeDuration": 0.12
	}
]
```

### Color looks

Presets in the editor's Color tab. Applying a look sets the whole grade, like Cap's built-in looks, so any value you leave out goes back to neutral.

```json
"colorLooks": [
	{
		"id": "golden-hour", "name": "Golden Hour", "description": "Warm highlights",
		"values": { "contrast": 0.08, "saturation": 0.1, "temperature": 0.32, "vignette": 0.15 }
	}
]
```

`intensity`, `fade`, `vignette` and `grain` go from 0 to 1. `exposure`, `contrast`, `saturation`, `temperature`, `tint` and `splitTone` go from -1 to 1.

### Connections

A connection is a server you run. Cap sends it signed requests when something happens to a Cap, and when someone runs one of your actions. You never ship UI: Cap draws your settings form and action buttons on the web and in Cap Desktop.

```json
"privacyPolicy": "https://my-app.example.com/privacy",
"connection": {
	"url": "https://my-app.example.com/cap",
	"permissions": ["cap.transcript"],
	"events": ["cap.ready", "cap.transcript.ready"],
	"settings": [
		{ "key": "apiKey", "type": "secret", "label": "API key", "required": true }
	],
	"actions": [{ "id": "send", "title": "Send to My App", "target": "cap" }]
}
```

Cap calls three paths under `url`, always with `POST` and a JSON body:

| Path | Body `kind` | When |
|---|---|---|
| `{url}/lifecycle` | `lifecycle` | `installed`, `settings.updated` or `uninstalled` |
| `{url}/events` | `event` | A subscribed event happened |
| `{url}/actions/{actionId}` | `action` | Someone ran your action on a Cap |

Return any 2xx status for lifecycle and event requests. Cap retries failures with backoff for about a day, and switches a connection off if it keeps failing. Each event has a stable `id`, so use it to ignore repeats.

For actions, reply within 10 seconds with one of:

```json
{ "type": "toast", "message": "Sent to My App" }
{ "type": "open", "url": "https://my-app.example.com/item/123", "message": "Opening My App" }
```

**Events**

| Event | Needs permission |
|---|---|
| `cap.ready` | none |
| `cap.transcript.ready` | `cap.transcript` |
| `cap.summary.ready` | `cap.summary` |
| `cap.comment.created` | `cap.comments` |

Installed for one person, a connection hears about that person's Caps. Installed for an organization, it hears about Caps their owners shared with that organization, never private ones.

**Permissions** decide what is in each payload. Every request includes the Cap's id, title, share link, owner name, length and creation time. `cap.transcript` adds the transcript, `cap.summary` adds the AI title, summary and chapters, and `cap.comments` adds comment text and author names. Ask only for what you use: people see this list before they install.

**Settings** are a form Cap renders at install time. Field types are `text`, `url`, `secret`, `select` and `toggle`. Values arrive in every request as `settings`. Use `secret` for API keys and tokens: Cap encrypts them at rest and never shows them again after they are saved.

### Verifying requests

Every request is signed with Ed25519. Fetch Cap's public keys once from `https://cap.so/.well-known/cap-app-store-keys.json` (or the same path on a self-hosted Cap), then check each request. In TypeScript, copy [`packages/app-store/src/signing.ts`](../packages/app-store/src/signing.ts) into your server (it only needs Node's `crypto`) and call:

```ts

const body = await request.text();
const result = verifyCapRequest({ headers: request.headers, body, keys });
if (!result.ok) return new Response("Unauthorized", { status: 401 });
```

Outside TypeScript, verify `v1.{Cap-Timestamp}.{Cap-Request-Id}.{body}` against the base64url `v1` value in `Cap-Signature` using the key whose `kid` matches, and reject timestamps more than five minutes old.

## The rules

CI runs `bun app-store validate` on every pull request. It checks:

- `manifest.json` matches the schema exactly. Unknown keys are errors.
- `id` is lowercase kebab-case, 3 to 40 characters, matches the folder name and does not use the words "cap" or "official".
- `version` is `major.minor.patch` and goes up whenever anything in your folder changes.
- `name` is unique, 2 to 30 characters. `description` is one sentence of 10 to 140 characters.
- `icon.png` is exactly 512x512 and at most 256 KB. `README.md` explains what the app does and how to set it up.
- Every file in the folder is referenced by the manifest or is one of the standard files. No hidden files, symlinks or executables.
- Images are real PNG, JPEG or WebP files, inside the size limits for their slot. The folder is at most 25 MB.
- Connections use a public https URL on the default port with no query string, link a privacy policy, and ask for every permission their events need.
- Up to 20 settings and 5 actions, with unique keys and ids.

Read [GUIDELINES.md](./GUIDELINES.md) for the rules a reviewer checks by hand.

## Publishing and updates

1. Open a pull request that touches only your app's folder.
2. CI validates it. A Cap maintainer reviews it against the guidelines.
3. Once merged, the app appears in the store with the next deploy of Cap.

To update your app, change it and raise `version` in the same pull request. People get updates automatically. If an update asks for new permissions or events, Cap keeps sending only what people already approved until they review the change.

## API versions

`apiVersion` is the App Store API your app is written for. Cap only shows an app to clients that support its API version, so an older Cap Desktop never loads something it does not understand. Version 1 is the current API.
