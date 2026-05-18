# Cap Recorder for Raycast

Drive Cap's recording controls from Raycast via the `cap-desktop://` URL scheme. Five commands are bundled:

- **Stop Cap Recording** — stops the active recording.
- **Pause Cap Recording** — pauses the active recording.
- **Resume Cap Recording** — resumes a paused recording.
- **Switch Cap Microphone** — switches the active microphone by label. Leave the argument blank to clear the selection.
- **Switch Cap Camera** — switches the active camera. An 8+ character hex/dash identifier is interpreted as a `DeviceID`; anything else is treated as a `ModelID`. Leave blank to clear.

The extension is a thin Raycast wrapper: each command builds a `cap-desktop://action?value=<json>` URL and opens it via `@raycast/api`'s `open(...)`. The desktop app's `DeepLinkAction::handle` parses the action and dispatches it. See [`apps/desktop/src-tauri/DEEPLINKS.md`](../desktop/src-tauri/DEEPLINKS.md) for the full action wire format and additional payloads that the app accepts (start recording, open editor, open settings).

## Development

```sh
cd apps/raycast
pnpm install
pnpm dev
```

`pnpm dev` launches Raycast in development mode against this extension. `pnpm build` produces a Raycast-store-shaped bundle; `pnpm lint` runs Raycast's lint pass.

Cap must be running for the deep links to land — the macOS app registers the `cap-desktop` scheme on first launch.
