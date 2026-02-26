# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from Raycast using deeplinks.

## Features

- **Start Recording** - Begin a new screen recording
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the active recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between pause/resume states
- **Switch Microphone** - Change the active microphone input
- **Switch Camera** - Change the active camera input
- **Open Settings** - Open Cap settings window

## Requirements

- [Cap](https://cap.so) desktop app must be installed
- Cap desktop app must be running

## Setup

1. Install the Cap desktop app from [cap.so](https://cap.so)
2. Install this Raycast extension
3. Start using the commands!

## Usage

All commands work through deeplinks to the Cap desktop app. The extension supports the following preferences:

- **Default Recording Mode**: Choose between "Studio" or "Instant" recording mode
- **Capture System Audio**: Enable/disable system audio capture by default

## Commands Reference

| Command | Description |
|---------|-------------|
| Start Recording | Starts a new recording with configured settings |
| Stop Recording | Stops the current active recording |
| Pause Recording | Pauses the recording without stopping it |
| Resume Recording | Resumes a paused recording |
| Toggle Pause | Toggles between pause and resume states |
| Switch Microphone | Opens a list to select a different microphone |
| Switch Camera | Opens a list to select a different camera |
| Open Settings | Opens the Cap settings window |

## Development

```bash
# Install dependencies
npm install

# Build the extension
npm run build

# Watch for changes during development
npm run dev
```

## License

MIT
