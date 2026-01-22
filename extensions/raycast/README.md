# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording directly from Raycast.

## Features

- **Start Recording** - Start a new screen or window recording (instant or studio mode)
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause/resume on the current recording
- **Take Screenshot** - Capture a screenshot of a screen or window
- **Recording Status** - Check the current recording status
- **Open Settings** - Open Cap settings

## Requirements

- [Cap](https://cap.so) desktop app must be installed and running
- macOS

## Installation

1. Clone this repository
2. Navigate to the `extensions/raycast` directory
3. Run `npm install`
4. Run `npm run dev` to start development mode

## How It Works

This extension uses Cap's deeplink API to control the app. Commands are sent via the `cap-desktop://` URL scheme.

## Deeplink Format

```
cap-desktop://action?value=<URL-encoded JSON>
```

### Available Actions

| Action | Description |
|--------|-------------|
| `get_status` | Get current recording status |
| `list_devices` | List available cameras, microphones, screens, and windows |
| `start_recording` | Start a new recording |
| `stop_recording` | Stop the current recording |
| `pause_recording` | Pause the current recording |
| `resume_recording` | Resume a paused recording |
| `toggle_pause_recording` | Toggle pause state |
| `restart_recording` | Restart the current recording |
| `take_screenshot` | Take a screenshot |
| `set_microphone` | Switch microphone |
| `set_camera` | Switch camera |
| `open_settings` | Open Cap settings |
| `open_editor` | Open a project in the editor |
