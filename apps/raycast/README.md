# Cap Raycast Extension (WIP)

This extension controls the Cap desktop app through `cap-desktop://action?value=...` deeplinks.

## Supported actions

- `start_recording`
- `stop_recording`
- `pause_recording`
- `resume_recording`
- `toggle_pause_recording`
- `switch_microphone`
- `switch_camera`

## Development

```bash
pnpm install
pnpm dev
```

> Requires the Cap desktop app to be installed and registered for the `cap-desktop://` URL scheme.
