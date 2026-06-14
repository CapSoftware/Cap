# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording directly from [Raycast](https://raycast.com).

## Commands

| Command | Description |
|---------|-------------|
| Start Instant Recording | Start an instant screen recording |
| Start Studio Recording | Start a studio screen recording |
| Stop Recording | Stop the current recording |
| Toggle Pause Recording | Pause or resume the current recording |
| Take Screenshot | Take a screenshot |
| Open Settings | Open Cap settings |

## How It Works

This extension communicates with the Cap desktop app via deeplinks (`cap-desktop://action?value=...`). The Cap app must be running for commands to work.

## Supported Deeplink Actions

The following deeplink actions are available:

- `start_recording` — Start a recording (instant or studio mode)
- `stop_recording` — Stop the current recording
- `pause_recording` — Pause the current recording
- `resume_recording` — Resume a paused recording
- `toggle_pause` — Toggle pause/resume
- `take_screenshot` — Capture a screenshot
- `set_camera` — Switch camera input
- `set_microphone` — Switch microphone input
- `open_editor` — Open the editor for a project
- `open_settings` — Open the settings window

### Deeplink Format

```
cap-desktop://action?value=<url-encoded-json>
```

Example:
```
cap-desktop://action?value=%7B%22stop_recording%22%3A%7B%7D%7D
```
