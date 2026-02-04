# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Features

- **Start Recording** - Pick a screen or window to start recording
- **Stop Recording** - Stop the current recording
- **Toggle Pause** - Pause or resume the current recording
- **Switch Camera** - Switch to a different camera or disable camera
- **Switch Microphone** - Switch to a different microphone or disable microphone
- **Open Cap** - Launch the Cap application

## Requirements

- [Cap](https://cap.so) must be installed on your Mac
- macOS 13.0 or later

## How It Works

This extension uses Cap's deeplink protocol to control the application:

```
cap://action?value={"action_type": {...}}
```

### Available Deeplink Actions

| Action | Description |
|--------|-------------|
| `start_recording` | Start a new recording with specified capture mode |
| `stop_recording` | Stop the current recording |
| `pause_recording` | Pause the current recording |
| `resume_recording` | Resume a paused recording |
| `toggle_pause_recording` | Toggle pause/resume state |
| `switch_camera` | Switch to a different camera |
| `switch_microphone` | Switch to a different microphone |

### Example Deeplinks

**Start recording a screen:**
```bash
open "cap://action?value=%7B%22start_recording%22%3A%7B%22capture_mode%22%3A%7B%22screen%22%3A%22Built-in%20Retina%20Display%22%7D%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22instant%22%7D%7D"
```

**Stop recording:**
```bash
open "cap://action?value=%22stop_recording%22"
```

**Toggle pause:**
```bash
open "cap://action?value=%22toggle_pause_recording%22"
```

**Switch camera:**
```bash
open "cap://action?value=%7B%22switch_camera%22%3A%7B%22device_id%22%3A%22FaceTime%20HD%20Camera%22%7D%7D"
```

**Disable camera:**
```bash
open "cap://action?value=%7B%22switch_camera%22%3A%7B%22device_id%22%3Anull%7D%7D"
```

## Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build
npm run build

# Lint
npm run lint
```

## License

MIT
