# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Commands

| Command                 | Description                       |
| ----------------------- | --------------------------------- |
| Start Instant Recording | Start an instant screen recording |
| Start Studio Recording  | Start a studio screen recording   |
| Stop Recording          | Stop the current recording        |
| Pause Recording         | Pause the current recording       |
| Resume Recording        | Resume a paused recording         |
| Toggle Pause Recording  | Toggle pause/resume               |
| Restart Recording       | Restart the current recording     |
| Take Screenshot         | Take a screenshot                 |
| Open Settings           | Open Cap settings                 |

## How It Works

The extension communicates with the Cap desktop app through deeplinks using the `cap-desktop://` URL scheme. All commands dispatch actions via deeplink URLs that Cap handles natively.

### Deeplink Format

Unit actions (no parameters):

```
cap-desktop://action?value="stop_recording"
```

Actions with parameters:

```
cap-desktop://action?value={"start_recording":{"capture_mode":{"screen":"Built-in Retina Display"},"camera":null,"mic_label":null,"capture_system_audio":false,"mode":"studio"}}
```

### Available Deeplink Actions

| Action                   | Type          | Parameters                                                            |
| ------------------------ | ------------- | --------------------------------------------------------------------- |
| `start_recording`        | Parameterized | `capture_mode`, `camera`, `mic_label`, `capture_system_audio`, `mode` |
| `stop_recording`         | Unit          | —                                                                     |
| `pause_recording`        | Unit          | —                                                                     |
| `resume_recording`       | Unit          | —                                                                     |
| `toggle_pause_recording` | Unit          | —                                                                     |
| `restart_recording`      | Unit          | —                                                                     |
| `take_screenshot`        | Parameterized | `capture_mode` (optional)                                             |
| `list_cameras`           | Unit          | —                                                                     |
| `set_camera`             | Parameterized | `id`                                                                  |
| `list_microphones`       | Unit          | —                                                                     |
| `set_microphone`         | Parameterized | `label`                                                               |
| `list_displays`          | Unit          | —                                                                     |
| `list_windows`           | Unit          | —                                                                     |
| `open_editor`            | Parameterized | `project_path`                                                        |
| `open_settings`          | Parameterized | `page` (optional)                                                     |

## Prerequisites

- [Cap](https://cap.so) desktop app installed and running
- [Raycast](https://raycast.com) installed

## Development

```bash
cd apps/raycast
npm install
npm run dev
```
