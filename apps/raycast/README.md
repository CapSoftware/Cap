# Cap Raycast Extension

Control Cap screen recording directly from Raycast.

## Commands

- **Start Recording** - Start a new screen recording
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between pause and resume
- **Take Screenshot** - Capture a screenshot
- **Open Settings** - Open Cap settings

## Installation

1. Make sure Cap is installed and running
2. Install this extension from the Raycast Store or build locally:

```bash
cd apps/raycast
pnpm install
pnpm dev
```

## How It Works

The extension uses Cap's deeplink URL scheme (`cap-desktop://`) to communicate with the desktop app. Each command sends a specific action that Cap handles natively.

## Deeplink Format

```
cap-desktop://action?value=<json-encoded-action>
```

### Available Actions

- `"stop_recording"` - Stop recording
- `"pause_recording"` - Pause recording
- `"resume_recording"` - Resume recording
- `"toggle_pause_recording"` - Toggle pause/resume
- `"take_screenshot"` - Take screenshot
- `{"start_recording": {...}}` - Start recording with options
- `{"open_settings": {"page": "..."}}` - Open settings
