# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording from Raycast.

## Features

- **Start Recording** - Start a new screen recording
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause the current recording  
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause/resume on current recording
- **Restart Recording** - Restart the current recording
- **Open Settings** - Open Cap settings

## Requirements

- [Cap](https://cap.so) must be installed and running
- macOS and Windows supported (Cap deeplinks use the `cap-desktop://` scheme)

## How It Works

This extension uses Cap's deeplink API to control recordings. Each command sends a URL like:

```
cap-desktop://action?value=%22stop_recording%22
```

Note: Unit actions (stop, pause, resume, etc.) are sent as JSON strings, while actions with parameters are sent as JSON objects.

## Installation

1. Clone this repository
2. Run `npm install` in the `extensions/raycast` directory
3. Run `npm run dev` to start development
4. Or `npm run build` to build for production

## Configuration

The extension supports the following preferences (configurable in Raycast):

- **Display Name** - Name of the display to record (leave empty for primary display)
- **Recording Mode** - Choose between "instant" or "studio" mode
- **Capture System Audio** - Whether to capture system audio by default

## Available Deeplinks

| Action | Deeplink Value (URL-encoded) |
|--------|------------------------------|
| Stop Recording | `%22stop_recording%22` |
| Pause Recording | `%22pause_recording%22` |
| Resume Recording | `%22resume_recording%22` |
| Toggle Pause | `%22toggle_pause_recording%22` |
| Restart Recording | `%22restart_recording%22` |
| Set Microphone | `%7B%22set_microphone%22%3A%7B%22label%22%3A%22Microphone%20Name%22%7D%7D` |
| Set Camera | `%7B%22set_camera%22%3A%7B%22id%22%3A%22camera-id%22%7D%7D` |
| Open Settings | `%7B%22open_settings%22%3A%7B%22page%22%3Anull%7D%7D` |

### Raw JSON Values (before URL encoding)

Unit actions (no parameters):
- `"stop_recording"`
- `"pause_recording"`
- `"resume_recording"`
- `"toggle_pause_recording"`
- `"restart_recording"`

Struct actions (with parameters):
- `{"set_microphone":{"label":"Microphone Name"}}`
- `{"set_camera":{"id":"camera-id"}}`
- `{"open_settings":{"page":null}}`

## License

MIT
