# Cap Desktop Deeplinks

Cap registers the `cap-desktop://` URL scheme for controlling the app externally.

## Path-based Deeplinks

### Recording Controls

| Action | URL |
|--------|-----|
| Start recording | `cap-desktop://record/start?screen=<display_name>&mode=<studio\|instant>` |
| Start recording (window) | `cap-desktop://record/start?window=<window_name>` |
| Stop recording | `cap-desktop://record/stop` |
| Pause recording | `cap-desktop://record/pause` |
| Resume recording | `cap-desktop://record/resume` |
| Toggle pause | `cap-desktop://record/toggle-pause` |

**Start recording parameters:**
- `screen` or `window` — capture target name (must match exactly)
- `mode` — `studio` (default) or `instant`
- `mic` — microphone label (optional)
- `system_audio` — `true` to capture system audio (optional)

### Screenshots

| Action | URL |
|--------|-----|
| Take screenshot | `cap-desktop://screenshot?screen=<display_name>` |
| Take screenshot (window) | `cap-desktop://screenshot?window=<window_name>` |

### Device Switching

| Action | URL |
|--------|-----|
| Set microphone | `cap-desktop://device/microphone?label=<mic_name>` |
| Disable microphone | `cap-desktop://device/microphone` |
| Set camera (by device ID) | `cap-desktop://device/camera?device_id=<id>` |
| Set camera (by model ID) | `cap-desktop://device/camera?model_id=<id>` |
| Disable camera | `cap-desktop://device/camera?off=true` |

### Settings

| Action | URL |
|--------|-----|
| Open settings | `cap-desktop://settings` |
| Open settings page | `cap-desktop://settings?page=<page_name>` |

## Legacy JSON Deeplinks

The original JSON format is still supported for backward compatibility:

```
cap-desktop://action?value={"start_recording":{"capture_mode":{"screen":"Built-in Retina Display"},"camera":null,"mic_label":"MacBook Pro Microphone","capture_system_audio":true,"mode":"Studio"}}
```

## Examples

```bash
# Start a studio recording on the main display
open "cap-desktop://record/start?screen=Built-in%20Retina%20Display&mode=studio"

# Stop recording
open "cap-desktop://record/stop"

# Toggle pause
open "cap-desktop://record/toggle-pause"

# Switch microphone
open "cap-desktop://device/microphone?label=MacBook%20Pro%20Microphone"

# Take a screenshot
open "cap-desktop://screenshot?screen=Built-in%20Retina%20Display"

# Open settings
open "cap-desktop://settings?page=recordings"
```
