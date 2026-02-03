# Cap Raycast Extension

Control Cap screen recorder directly from Raycast with powerful deeplink commands.

## Features

### Recording Controls
- **Start Recording** - Begin a new screen recording
- **Stop Recording** - Stop the current recording  
- **Pause Recording** - Pause the active recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause/resume state

### Device Switching
- **Switch Camera** - Cycle through available cameras
- **Switch Microphone** - Cycle through available microphones

## Installation

1. Build the extension:
```bash
cd extensions/raycast
npm install
npm run build
```

2. Install in Raycast:
   - Open Raycast
   - Go to Extensions → Add Extension
   - Select "Import Extension"
   - Choose the `extensions/raycast` directory

## Usage

Simply open Raycast and type any of the command names:
- "Start Recording" - Starts a new recording
- "Stop Recording" - Stops current recording
- "Pause Recording" - Pauses active recording
- "Resume Recording" - Resumes paused recording
- "Toggle Pause" - Toggles pause state
- "Switch Camera" - Cycles to next camera
- "Switch Microphone" - Cycles to next microphone

## Requirements

- Cap desktop app must be installed and running
- Cap must be configured to handle deeplinks (default behavior)

## Development

### Building
```bash
npm run build
```

### Development Mode
```bash
npm run dev
```

### Linting
```bash
npm run lint
npm run fix-lint
```

## Technical Details

The extension uses Cap's deeplink protocol (`cap-desktop://action`) to communicate with the desktop app. Each command constructs a JSON action that gets sent to Cap via URL scheme.

### Supported Actions

All actions follow the format:
```json
{
  "action_name": null
}
```

Available actions:
- `start_recording`
- `stop_recording`
- `pause_recording`
- `resume_recording`
- `toggle_pause_recording`
- `switch_camera`
- `switch_microphone`

## Error Handling

The extension includes comprehensive error handling:
- Checks if Cap is installed before attempting commands
- Provides user-friendly error messages via HUD notifications
- Logs errors to console for debugging

## Testing

1. Ensure Cap desktop app is running
2. Test each command individually
3. Verify error messages when Cap is not running
4. Test device switching with multiple cameras/microphones

## Contributing

This extension is part of the Cap monorepo. To contribute:
1. Make changes to the source files
2. Build and test locally
3. Submit a pull request to the main Cap repository