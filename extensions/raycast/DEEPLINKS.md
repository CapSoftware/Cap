# Cap Deeplinks

Cap supports deeplinks for controlling recordings and other app functionality. This enables integration with tools like Raycast, Alfred, Shortcuts, and custom scripts.

## URL Scheme

Cap uses the `cap-desktop://` URL scheme on macOS and Windows.

## Action Format

Actions are sent as JSON in the `value` query parameter:

```
cap-desktop://action?value=<URL-encoded JSON>
```

**Important:** The JSON value MUST be URL-encoded!

## Available Actions

### Recording Controls

Unit variants are serialized as JSON strings (not objects):

#### Stop Recording
```json
"stop_recording"
```

#### Pause Recording
```json
"pause_recording"
```

#### Resume Recording
```json
"resume_recording"
```

#### Toggle Pause/Resume
```json
"toggle_pause_recording"
```

#### Restart Recording
Stops and immediately restarts with the same settings:
```json
"restart_recording"
```

#### Start Recording
Struct variant (serialized as object):
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

# Stop recording (note: unit variant is a string, not object)
open "cap-desktop://action?value=%22stop_recording%22"

# Toggle pause
open "cap-desktop://action?value=%22toggle_pause_recording%22"

# Set microphone (struct variant)
open "cap-desktop://action?value=%7B%22set_microphone%22%3A%7B%22label%22%3A%22MacBook%20Pro%20Microphone%22%7D%7D"
```

### AppleScript

```applescript
tell application "System Events"
    open location "cap-desktop://action?value=%22stop_recording%22"
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

// Stop recording (unit variant = string)
capAction("stop_recording");

// Toggle pause (unit variant = string)
capAction("toggle_pause_recording");

// Set microphone (struct variant = object)
capAction({ set_microphone: { label: "MacBook Pro Microphone" } });
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

# Stop recording (unit variant = string)
cap_action("stop_recording")

# Toggle pause (unit variant = string)
cap_action("toggle_pause_recording")

# Set microphone (struct variant = dict)
cap_action({"set_microphone": {"label": "MacBook Pro Microphone"}})
```

## Raycast Extension

A full Raycast extension is included in `extensions/raycast/`. See its README for installation instructions.

## Troubleshooting

1. **Cap must be running** - Deeplinks only work when Cap is open
2. **URL encoding** - Make sure the JSON is properly URL-encoded
3. **Unit vs Struct variants** - Unit actions (stop, pause, etc.) are JSON strings like `"stop_recording"`, not objects like `{"stop_recording": {}}`
4. **Permissions** - Some actions require an active recording session
