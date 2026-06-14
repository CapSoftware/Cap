# Cap Raycast Extension

Control [Cap](https://cap.so) screen recording directly from Raycast.

## Features

- **Start Recording** - Start a new screen or window recording with instant or studio mode
- **Stop Recording** - Stop the current recording with context-aware confirmation
- **Pause Recording** - Pause the current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause/resume on the current recording
- **Restart Recording** - Restart the current recording
- **Take Screenshot** - Capture a screenshot of a screen or window
- **Recording Status** - Check the current recording status with live elapsed timer
- **Switch Microphone** - Change the active microphone input
- **Switch Camera** - Change the active camera input
- **Open Settings** - Open Cap settings
- **Menu Bar** - Control recording from the macOS menu bar (optional)

## Requirements

- [Cap](https://cap.so) desktop app must be installed and running
- macOS

## Installation

1. Clone this repository
2. Navigate to the `extensions/raycast` directory
3. Run `npm install`
4. Run `npm run dev` to start development mode

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| Start Recording | Choose screen/window and recording mode | View |
| Stop Recording | Stop with confirmation showing recording mode | No-view |
| Pause Recording | Pause current recording | No-view |
| Resume Recording | Resume paused recording | No-view |
| Toggle Pause | Toggle pause/resume state | No-view |
| Restart Recording | Restart current recording | No-view |
| Take Screenshot | Capture screen or window | View |
| Recording Status | Live status with timer and controls | View |
| Switch Microphone | Select audio input device | View |
| Switch Camera | Select video input device | View |
| Open Settings | Open Cap preferences | No-view |

## Keyboard Shortcuts

### Start Recording / Take Screenshot
- `⌘ Return` - Submit and start capture
- `⌘ T` - Toggle between Screen and Window capture type
- `⌘ M` - Toggle between Instant and Studio recording mode (Start Recording only)

### Recording Status
- `⌘ R` - Refresh status
- `⌘ ⇧ P` - Pause/Resume recording
- `⌘ ⇧ R` - Restart recording
- `⌘ ⇧ Backspace` - Stop recording

### Device Selection (Switch Camera/Microphone)
- `⌘ 1-9` - Quick select device by number
- `⌘ Return` - Select highlighted device

## How It Works

This extension uses Cap's deeplink API to control the app. Commands are sent via the `cap-desktop://` URL scheme.

## Deeplink Format

```
cap-desktop://action?value=<URL-encoded JSON>
```

### Available Actions

| Action | Description |
|--------|-------------|
| `get_status` | Get current recording status |
| `list_devices` | List available cameras, microphones, screens, and windows |
| `start_recording` | Start a new recording |
| `stop_recording` | Stop the current recording |
| `pause_recording` | Pause the current recording |
| `resume_recording` | Resume a paused recording |
| `toggle_pause_recording` | Toggle pause state |
| `restart_recording` | Restart the current recording |
| `take_screenshot` | Take a screenshot |
| `set_microphone` | Switch microphone |
| `set_camera` | Switch camera |
| `open_settings` | Open Cap settings |
| `open_editor` | Open a project in the editor |

## UX Features

- **Recent Items**: Recently used screens/windows/cameras/microphones are remembered and shown at the top of lists
- **Empty States**: Helpful messages when Cap isn't running or no devices are found
- **Live Timer**: Recording Status shows elapsed time in real-time
- **HUD Feedback**: Quick visual confirmation instead of disruptive toasts
- **Color-coded Status**: Red = Recording, Yellow = Paused, Gray = Idle
- **Smart Defaults**: Auto-selects the first available target on load
- **Context-aware**: Stop Recording shows whether it's instant or studio mode

## Development

```bash
npm install
npm run dev
```

## License

MIT
