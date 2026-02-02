# Cap Raycast Extension

Control Cap screen recorder directly from Raycast.

## Features

- **Start Recording** - Begin a new screen recording
- **Stop Recording** - End the current recording
- **Pause Recording** - Pause the current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between paused/recording states

## Installation

1. Install the Cap desktop app from [cap.so](https://cap.so)
2. Open Raycast
3. Search for "Cap" in the Raycast Store
4. Install the extension

## Development

```bash
cd extensions/raycast
npm install
npm run dev
```

## How it Works

This extension uses Cap's deeplink protocol (`cap-desktop://`) to communicate with the desktop app. Each command sends a specific deeplink action:

| Command | Deeplink Action |
|---------|-----------------|
| Start Recording | `start_recording` |
| Stop Recording | `stop_recording` |
| Pause Recording | `pause_recording` |
| Resume Recording | `resume_recording` |
| Toggle Pause | `toggle_pause_recording` |

## Deeplink Format

```
cap-desktop://action?value={"action_name": {...params}}
```

Example:
```
cap-desktop://action?value={"pause_recording":null}
```

## Requirements

- macOS 11.0 or later
- Cap desktop app installed
- Raycast installed

## License

MIT
