# Cap Raycast Extension

Control Cap screen recording from Raycast.

## Features

- **Start Recording** - Start a new screen recording instantly
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between pause and resume
- **Switch Microphone** - Change to a different microphone input
- **Switch Camera** - Change to a different camera input

## Installation

1. Make sure you have [Raycast](https://raycast.com/) installed
2. Install the Cap extension from the Raycast Store
3. Ensure [Cap](https://cap.so) is installed on your Mac

## Deep Link Protocol

This extension uses Cap's deep link protocol to control the app:

- `cap://record` - Start recording
- `cap://stop` - Stop recording
- `cap://pause` - Pause recording
- `cap://resume` - Resume recording
- `cap://toggle-pause` - Toggle pause state
- `cap://switch-mic?label=<id>` - Switch microphone
- `cap://switch-camera?id=<id>` - Switch camera

## Requirements

- macOS 11.0 or later
- Cap app installed
- Raycast v1.50.0 or later

## Development

```bash
cd extensions/raycast-cap
npm install
npm run dev
```

## License

MIT
