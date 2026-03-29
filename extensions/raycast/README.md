# Cap for Raycast

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Commands

| Command | Description |
|---------|-------------|
| **Start Recording** | Start a new screen recording |
| **Stop Recording** | Stop the current recording |
| **Toggle Pause** | Pause or resume the current recording |
| **Open Cap** | Open the Cap application |
| **Open Settings** | Open Cap settings |
| **Recent Recordings** | Browse your recent recordings |

## Requirements

- [Cap](https://cap.so) desktop app installed
- macOS

## How it works

This extension communicates with Cap via the `cap-desktop://` deep link URL scheme. All commands are executed instantly without opening any UI (except "Recent Recordings" which shows a list view).

## Deep Link Format

Cap uses the following deep link format:

```
cap-desktop://action?value=<JSON-encoded-action>
```

### Supported Actions

- `start_recording` — Start recording with capture mode, camera, mic options
- `stop_recording` — Stop the current recording
- `pause_recording` — Pause the current recording
- `resume_recording` — Resume a paused recording
- `toggle_pause_recording` — Toggle pause/resume
- `open_editor` — Open a recording in the editor
- `open_settings` — Open Cap settings
- `switch_microphone` — Switch to a different microphone
- `switch_camera` — Switch to a different camera
