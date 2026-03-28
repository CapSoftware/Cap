# Cap Raycast Extension

Control [Cap](https://cap.so) screen recordings directly from Raycast using deeplinks.

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| **Start Recording** | Start a screen/window recording with configurable options | Form |
| **Stop Recording** | Stop the current recording | Instant |
| **Pause Recording** | Pause the current recording | Instant |
| **Resume Recording** | Resume a paused recording | Instant |
| **Toggle Pause** | Toggle pause/resume on the current recording | Instant |
| **Set Camera** | Switch camera input (pass name as argument) | Instant |
| **Set Microphone** | Switch microphone input (pass label as argument) | Instant |
| **Open Settings** | Open Cap settings window | Instant |

## How It Works

This extension communicates with Cap desktop via the `cap-desktop://` URL scheme. Each command constructs a deeplink URL in the format:

```
cap-desktop://action?value={json_encoded_action}
```

Cap desktop must be running for the commands to work.

## Deeplink Reference

### Simple actions (no parameters)

```
cap-desktop://action?value="stop_recording"
cap-desktop://action?value="pause_recording"
cap-desktop://action?value="resume_recording"
cap-desktop://action?value="toggle_pause_recording"
```

### Start recording

```json
{
  "start_recording": {
    "capture_mode": { "screen": "Built-in Retina Display" },
    "camera": { "ModelID": "FaceTime HD Camera" },
    "mic_label": "MacBook Pro Microphone",
    "capture_system_audio": true,
    "mode": "studio"
  }
}
```

### Switch camera/microphone

```json
{ "set_camera": { "camera": { "ModelID": "FaceTime HD Camera" } } }
{ "set_camera": { "camera": null } }
{ "set_microphone": { "mic_label": "External Microphone" } }
{ "set_microphone": { "mic_label": null } }
```

### Open settings

```json
{ "open_settings": { "page": "recordings" } }
```
