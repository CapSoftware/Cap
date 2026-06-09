# Cap Raycast Extension

This workspace package adds two Raycast commands for Cap:

- `Cap Control`: start studio or instant recordings, stop, pause, resume, and toggle pause.
- `Switch Device`: enumerate macOS microphones and cameras from `system_profiler`, then send the matching Cap deeplink.

## Commands

### Cap Control

- Start Studio Recording
- Start Instant Recording
- Stop Recording
- Pause Recording
- Resume Recording
- Toggle Pause Recording

### Switch Device

- Disable microphone
- Switch microphone by label
- Disable camera
- Switch camera by model ID when available
- Fall back to camera device ID or label when macOS metadata does not expose a model ID

## Deeplinks

The extension uses the desktop app deeplinks documented in [`apps/desktop/src-tauri/DEEPLINKS.md`](../desktop/src-tauri/DEEPLINKS.md).

## Validation

```bash
pnpm --dir apps/raycast exec tsc --noEmit
npx @raycast/api@latest lint
```

`system_profiler` output varies across macOS versions and hardware. The camera picker prefers `model_id`, then `device_id`, then `label` so the extension can still trigger a usable Cap deeplink when one identifier is missing.
