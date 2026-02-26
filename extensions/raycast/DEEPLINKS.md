# Cap Deeplinks

Cap supports deeplinks for controlling recordings and other app functionality. This enables integration with tools like Raycast, Alfred, Shortcuts, and custom scripts.

## URL Scheme

Cap uses the `cap-desktop://` URL scheme on macOS and Windows.

## Action Format

Actions are sent as JSON in the `value` query parameter:

```
cap-desktop://action?value=<URL-encoded JSON>
```

## Available Actions

### Recording Controls

#### Stop Recording
```json
{"stop_recording":{}}
```

#### Pause Recording
```json
{"pause_recording":{}}
```

#### Resume Recording
```json
{"resume_recording":{}}
```

#### Toggle Pause/Resume
```json
{"toggle_pause_recording":{}}
```

#### Restart Recording
Stops and immediately restarts with the same settings:
```json
{"restart_recording":{}}
```

#### Start Recording
```json
{
  "start_recording": {
    "capture_mode": {"screen": "Main Display"},
    "camera": null,
    "mic_label": null,
    "capture_system_audio": false,
    "mode": "instant"
  }
}
```

**capture_mode options:**
- `{"screen": "Display Name"}` - Record a specific display
- `{"window": "Window Name"}` - Record a specific window

**mode options:**
- `"instant"` - Quick recording with immediate upload
- `"studio"` - Full editing capabilities

### Input Controls

#### Set Microphone
```json
{"set_microphone": {"label": "MacBook Pro Microphone"}}
```

Set to `null` to disable:
```json
{"set_microphone": {"label": null}}
```

#### Set Camera
```json
{"set_camera": {"id": "camera-device-id"}}
```

Set to `null` to disable:
```json
{"set_camera": {"id": null}}
```

### App Controls

#### Open Settings
```json
{"open_settings": {"page": null}}
```

Open a specific settings page:
```json
{"open_settings": {"page": "recordings"}}
```

#### Open Editor
```json
{"open_editor": {"project_path": "/path/to/project.cap"}}
```

## Examples

### Shell Script (macOS)

```bash
#!/bin/bash

# Stop recording
open "cap-desktop://action?value=%7B%22stop_recording%22%3A%7B%7D%7D"

# Toggle pause
open "cap-desktop://action?value=%7B%22toggle_pause_recording%22%3A%7B%7D%7D"
```

### AppleScript

```applescript
tell application "System Events"
    open location "cap-desktop://action?value=%7B%22stop_recording%22%3A%7B%7D%7D"
end tell
```

### JavaScript/Node.js

```javascript
const { exec } = require('child_process');

function capAction(action) {
  const json = JSON.stringify(action);
  const encoded = encodeURIComponent(json);
  const url = `cap-desktop://action?value=${encoded}`;
  exec(`open "${url}"`);
}

// Stop recording
capAction({ stop_recording: {} });

// Toggle pause
capAction({ toggle_pause_recording: {} });
```

### Python

```python
import subprocess
import json
import urllib.parse

def cap_action(action):
    json_str = json.dumps(action)
    encoded = urllib.parse.quote(json_str)
    url = f"cap-desktop://action?value={encoded}"
    subprocess.run(["open", url])

# Stop recording
cap_action({"stop_recording": {}})

# Toggle pause
cap_action({"toggle_pause_recording": {}})
```

## Raycast Extension

A full Raycast extension is included in `extensions/raycast/`. See its README for installation instructions.

## Troubleshooting

1. **Cap must be running** - Deeplinks only work when Cap is open
2. **URL encoding** - Make sure the JSON is properly URL-encoded
3. **Permissions** - Some actions require an active recording session
