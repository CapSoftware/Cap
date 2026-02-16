# Cap Raycast Extension

Control your Cap screen recordings directly from Raycast with keyboard shortcuts.

## Features

- 🎥 **Stop Recording** - Stop your current recording
- ⏸️ **Pause Recording** - Pause your active recording  
- ▶️ **Resume Recording** - Resume your paused recording
- 🎤 **Toggle Microphone** - Toggle microphone on/off during recording
- 📷 **Toggle Camera** - Toggle camera on/off during recording
- 🎬 **Start Recording** - Quick access to start a new recording (opens Cap app)

## Installation

1. Install the Raycast extension:
   ```bash
   cd raycast-extension
   npm install
   npm run dev
   ```

2. Import the extension in Raycast

3. Set up keyboard shortcuts for each command in Raycast preferences

## How It Works

This extension uses Cap's deeplink URL scheme (`cap-desktop://`) to control recordings. Each command sends a deeplink action to Cap, which executes the corresponding function.

### Available Deeplink Actions

- `stop_recording` - Stops the current recording
- `pause_recording` - Pauses the current recording
- `resume_recording` - Resumes a paused recording
- `toggle_microphone` - Toggles the microphone (disables if enabled)
- `toggle_camera` - Toggles the camera (disables if enabled)

### URL Format

```
cap-desktop://action?value=<JSON-encoded-action>
```

Example:
```
cap-desktop://action?value=%7B%22stop_recording%22%3Anull%7D
```

## Usage

1. Start a recording in Cap (use the main app or your configured shortcuts)
2. Use Raycast commands to control the recording:
   - `Stop Recording` - End and save your recording
   - `Pause Recording` - Temporarily pause recording
   - `Resume Recording` - Continue recording after pause
   - `Toggle Microphone` - Disable microphone (toggle on requires mic selection)
   - `Toggle Camera` - Disable camera (toggle on requires camera selection)

## Notes

- **Toggle Limitations**: The toggle commands can disable camera/microphone, but cannot re-enable them without knowing which device to use. To re-enable, start a new recording with the desired devices.
- **Start Recording**: For starting a recording with specific settings (screen, window, camera, mic), use the Cap app directly. The Raycast commands are best for controlling active recordings.

## Development

```bash
# Install dependencies
npm install

# Start development mode
npm run dev

# Build for production  
npm run build

# Lint and fix
npm run fix-lint
```

## Requirements

- Cap desktop app installed
- macOS with Raycast installed
- Cap deeplink handler registered (`cap-desktop://` URL scheme)

## Icon

The extension requires a `command-icon.png` file. Use the Cap logo or create a custom icon (512x512px recommended).

## License

MIT
