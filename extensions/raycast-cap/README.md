# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording directly from Raycast.

## Features

- **Start Recording** - Start a new screen recording
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause state of the current recording
- **Take Screenshot** - Capture the current screen
- **Open Cap** - Open the Cap application
- **Open Settings** - Open Cap settings
- **Recording Controls** - Quick access to all Cap commands in a list view

## Requirements

- [Cap](https://cap.so) must be installed on your Mac
- macOS 11.0 or later

## How It Works

This extension uses Cap's deeplink protocol (`cap-desktop://`) to communicate with the Cap application. When you trigger a command, it opens a deeplink URL that Cap handles to perform the requested action.

### Deeplink Format

Cap deeplinks use the following format:
```
cap-desktop://action?value=<JSON_ENCODED_ACTION>
```

Available actions:
- `start_recording` - Start recording with capture mode, camera, mic settings
- `stop_recording` - Stop the current recording
- `pause_recording` - Pause the current recording
- `resume_recording` - Resume a paused recording
- `toggle_pause` - Toggle pause state
- `take_screenshot` - Take a screenshot
- `open_settings` - Open settings with optional page parameter
- `show_main_window` - Show the main Cap window

## Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build the extension
npm run build

# Publish to Raycast Store
npm run publish
```

## License

AGPL-3.0 - See [LICENSE](../../LICENSE) for details.
