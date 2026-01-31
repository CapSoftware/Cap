# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording directly from Raycast!

## Features

This extension provides quick access to Cap's recording functionality through Raycast commands:

### Recording Controls
- **Start Recording** - Start a new screen or window recording with customizable options
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the active recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between paused and active recording states

### Capture
- **Take Screenshot** - Capture a screenshot of a specific display or window

### Hardware Management
- **Switch Camera** - Change the active camera input or disable camera
- **Switch Microphone** - Change the active microphone input or mute

## Requirements

- [Cap](https://cap.so) desktop application (v0.3.0 or later) must be installed
- macOS (Raycast is macOS-only)
- Cap must be running to respond to commands

## Installation

### From Raycast Store (Coming Soon)
1. Open Raycast
2. Search for "Cap"
3. Click "Install Extension"

### Manual Installation (Development)
1. Clone the repository:
   ```bash
   git clone https://github.com/CapSoftware/Cap.git
   cd Cap/apps/raycast-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run dev
   ```

4. The extension will automatically be available in Raycast during development

## Usage

### Starting a Recording
1. Open Raycast (⌘ + Space)
2. Type "Start Recording"
3. Fill in the form:
   - **Capture Type**: Choose Screen or Window
   - **Target Name**: Enter the display/window name
   - **Recording Mode**: Studio (editable) or Instant (immediately uploaded)
   - **Enable Camera**: Toggle camera on/off
   - **Enable Microphone**: Toggle microphone on/off
   - **Capture System Audio**: Include system audio in recording
4. Press Enter to start recording

### Finding Display/Window Names
Use the built-in Cap commands to list available targets:
- In your terminal, run Cap with `--list-displays` or `--list-windows` flags
- Or check the Cap UI for display/window names

### Quick Actions
All other commands are instant actions:
- **Stop Recording**: Simply run the command
- **Pause/Resume**: Run the respective command while recording
- **Toggle Pause**: Quick shortcut to toggle pause state
- **Take Screenshot**: Fill in the target and capture instantly

### Hardware Switching
1. Run "Switch Camera" or "Switch Microphone"
2. Enter the device ID or name
3. Toggle enable/disable as needed
4. Press Enter to switch

**Tip**: Use the "List Cameras" and "List Microphones" Cap commands to see available devices

## Commands Reference

| Command | Shortcut | Description |
|---------|----------|-------------|
| Start Recording | - | Start a new recording with options |
| Stop Recording | - | Stop the current recording |
| Pause Recording | - | Pause the active recording |
| Resume Recording | - | Resume a paused recording |
| Toggle Pause | - | Toggle pause state |
| Take Screenshot | - | Capture a screenshot |
| Switch Camera | - | Change camera input |
| Switch Microphone | - | Change microphone input |

## Troubleshooting

### Command Not Working
- Ensure Cap is running
- Check that Cap has necessary permissions (Screen Recording, Camera, Microphone)
- Verify you're running Cap v0.3.0 or later with deeplink support

### "Failed to Start Recording"
- Double-check the display/window name is correct
- Ensure the target display/window exists and is accessible
- Check Cap's permissions in System Settings > Privacy & Security

### Camera/Microphone Not Switching
- Verify the device ID/name is correct
- Check that the device is connected and recognized by your system
- Ensure Cap has permission to access camera/microphone

## Development

### Project Structure
```
src/
├── utils/
│   └── deeplink.ts          # Deeplink utility functions
├── start-recording.tsx       # Start recording command
├── stop-recording.tsx        # Stop recording command
├── pause-recording.tsx       # Pause command
├── resume-recording.tsx      # Resume command
├── toggle-pause.tsx          # Toggle pause command
├── take-screenshot.tsx       # Screenshot command
├── switch-camera.tsx         # Camera switching command
└── switch-microphone.tsx     # Microphone switching command
```

### Building
```bash
npm run build
```

### Linting
```bash
npm run lint
npm run fix-lint
```

## How It Works

This extension communicates with Cap using the `cap-desktop://` URL scheme. Each command constructs a deeplink URL with JSON-encoded actions and opens it, which Cap intercepts and executes.

Example deeplink:
```
cap-desktop://action?value={"pauseRecording":{}}
```

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Links

- [Cap Website](https://cap.so)
- [Cap GitHub](https://github.com/CapSoftware/Cap)
- [Report Issues](https://github.com/CapSoftware/Cap/issues)
- [Raycast](https://raycast.com)

## Credits

Created for the Cap deeplinks bounty (#1540)
