# Cap Raycast Extension

Control [Cap](https://cap.so) screen recordings directly from [Raycast](https://raycast.com).

## Commands

| Command | Description |
|---------|-------------|
| **Start Recording** | Start a new screen recording with default settings |
| **Stop Recording** | Stop the current recording |
| **Toggle Pause** | Pause or resume the current recording |
| **Open Settings** | Open Cap settings window |
| **Recent Recordings** | Browse and open recent recordings |

## How It Works

This extension communicates with Cap using deeplinks (`cap-desktop://action?value=...`). Cap must be running for commands to work.

## Deeplinks

Cap supports the following deeplink actions:

- `start_recording` — Start recording with capture mode, camera, mic, and mode options
- `stop_recording` — Stop the current recording
- `pause_recording` — Pause the current recording
- `resume_recording` — Resume a paused recording
- `toggle_pause` — Toggle pause/resume
- `set_camera` — Switch the active camera
- `set_microphone` — Switch the active microphone
- `open_editor` — Open a recording in the editor
- `open_settings` — Open the settings window

### URL Format

```
cap-desktop://action?value=<url-encoded-json>
```

Unit actions (no parameters):
```
cap-desktop://action?value=%22stop_recording%22
```

Actions with parameters (URL-encode the JSON):
```
cap-desktop://action?value=%7B%22start_recording%22%3A%7B%22capture_mode%22%3A%7B%22screen%22%3A%22Main%20Display%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22studio%22%7D%7D
```

## Development

```bash
cd apps/raycast-extension
pnpm install
pnpm dev
```
