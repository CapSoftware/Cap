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
- macOS only (Cap deeplinks use the `cap-desktop://` scheme)

## How It Works

This extension uses Cap's deeplink API to control recordings. Each command sends a URL like:

```
cap-desktop://action?value={"stop_recording":{}}
```

## Installation

1. Clone this repository
2. Run `npm install` in the `extensions/raycast` directory
3. Run `npm run dev` to start development
4. Or `npm run build` to build for production

## Available Deeplinks

| Action | Deeplink |
|--------|----------|
| Stop Recording | `cap-desktop://action?value={"stop_recording":{}}` |
| Pause Recording | `cap-desktop://action?value={"pause_recording":{}}` |
| Resume Recording | `cap-desktop://action?value={"resume_recording":{}}` |
| Toggle Pause | `cap-desktop://action?value={"toggle_pause_recording":{}}` |
| Restart Recording | `cap-desktop://action?value={"restart_recording":{}}` |
| Set Microphone | `cap-desktop://action?value={"set_microphone":{"label":"Microphone Name"}}` |
| Set Camera | `cap-desktop://action?value={"set_camera":{"id":"camera-id"}}` |
| Open Settings | `cap-desktop://action?value={"open_settings":{"page":null}}` |

## License

MIT
