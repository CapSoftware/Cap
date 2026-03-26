# Cap for Raycast

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Commands

| Command | Description |
| --- | --- |
| Start Recording | Start a new screen recording |
| Stop Recording | Stop the current recording |
| Pause Recording | Pause the current recording |
| Resume Recording | Resume a paused recording |
| Toggle Pause | Toggle pause/resume |
| Restart Recording | Restart the current recording |
| Take Screenshot | Take a screenshot |
| Open Settings | Open Cap settings |

## How It Works

This extension uses Cap's deeplink protocol (`cap-desktop://action?value=<json>`) to communicate with the desktop app. Make sure Cap is running before using the commands.

## Deeplink Protocol

Cap supports the following deeplink actions:

```
cap-desktop://action?value="stop_recording"
cap-desktop://action?value="pause_recording"
cap-desktop://action?value="resume_recording"
cap-desktop://action?value="toggle_pause_recording"
cap-desktop://action?value="restart_recording"
cap-desktop://action?value={"start_recording":{"capture_mode":{"screen":"Main Display"},"camera":null,"mic_label":null,"capture_system_audio":false,"mode":"studio"}}
cap-desktop://action?value={"take_screenshot":{"capture_mode":{"screen":"Main Display"}}}
cap-desktop://action?value={"open_editor":{"project_path":"/path/to/project"}}
cap-desktop://action?value={"open_settings":{"page":null}}
```

## Development

```bash
cd extensions/raycast
npm install
npm run dev
```
