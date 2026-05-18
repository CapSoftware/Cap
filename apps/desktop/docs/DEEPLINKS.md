# Cap Deeplinks API Documentation

This document describes the deeplinks API available in the Cap desktop application for integration with external tools like Raycast.

## URL Scheme

All deeplinks use the `cap-desktop://` URL scheme.

## Format

Deeplinks follow this format:
```
cap-desktop://action?value=<JSON_ENCODED_ACTION>
```

Where `<JSON_ENCODED_ACTION>` is a JSON object containing:
- `action`: The action type (snake_case)
- Additional parameters specific to each action

## Available Actions

### 1. Start Recording

Starts a new screen recording.

**Action:** `start_recording`

**Parameters:**
- `capture_mode` (object): Screen or Window selection
  - `Screen`: `{ "Screen": "Screen Name" }`
  - `Window`: `{ "Window": "Window Name" }`
- `camera` (optional): Camera device ID or model ID
  - `{ "DeviceID": "device-id" }` or `{ "ModelID": "model-id" }`
- `mic_label` (optional, string): Microphone device name
- `capture_system_audio` (boolean): Whether to capture system audio
- `mode` (string): Recording mode - `"studio"`, `"instant"`, or `"screenshot"`

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22start_recording%22%2C%22capture_mode%22%3A%7B%22Screen%22%3A%22Primary%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22studio%22%7D
```

### 2. Stop Recording

Stops the current recording.

**Action:** `stop_recording`

**Parameters:** None

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22stop_recording%22%7D
```

### 3. Pause Recording

Pauses the current recording without stopping it.

**Action:** `pause_recording`

**Parameters:** None

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22pause_recording%22%7D
```

### 4. Resume Recording

Resumes a paused recording.

**Action:** `resume_recording`

**Parameters:** None

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22resume_recording%22%7D
```

### 5. Toggle Pause

Toggles between pause and resume states.

**Action:** `toggle_pause_recording`

**Parameters:** None

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22toggle_pause_recording%22%7D
```

### 6. Switch Microphone

Changes the active microphone input.

**Action:** `switch_microphone`

**Parameters:**
- `mic_label` (string or null): Microphone device name, or `null` to disable microphone

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22switch_microphone%22%2C%22mic_label%22%3A%22Built-in%20Microphone%22%7D
```

### 7. Switch Camera

Changes the active camera input.

**Action:** `switch_camera`

**Parameters:**
- `camera` (object or null): Camera identifier or `null` to disable camera
  - `{ "DeviceID": "device-id" }` or `{ "ModelID": "model-id" }`

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22switch_camera%22%2C%22camera%22%3A%7B%22DeviceID%22%3A%22camera-id%22%7D%7D
```

### 8. Open Editor

Opens a project in the Cap editor.

**Action:** `open_editor`

**Parameters:**
- `project_path` (string): Full path to the .cap project file

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22open_editor%22%2C%22project_path%22%3A%22%2Fpath%2Fto%2Fproject.cap%22%7D
```

**Note:** On macOS, you can also use `file://` URLs to open .cap files directly.

### 9. Open Settings

Opens the Cap settings window.

**Action:** `open_settings`

**Parameters:**
- `page` (optional, string): Settings page to open

**Example:**
```
cap-desktop://action?value=%7B%22action%22%3A%22open_settings%22%2C%22page%22%3A%22general%22%7D
```

## Error Handling

If a deeplink action fails:
1. The error is logged to the console
2. The user may see a notification from the Cap app
3. The action is silently ignored if the app is not running

## Requirements

- Cap desktop app must be installed
- Cap desktop app should be running (some actions will launch it if not)
- On macOS, the `cap-desktop` URL scheme is registered automatically during installation
- On Windows, the URL scheme is registered automatically during installation

## Testing Deeplinks

You can test deeplinks from the terminal:

### macOS
```bash
open "cap-desktop://action?value=%7B%22action%22%3A%22start_recording%22%2C%22capture_mode%22%3A%7B%22Screen%22%3A%22Primary%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22studio%22%7D"
```

### Windows
```powershell
start "cap-desktop://action?value=%7B%22action%22%3A%22start_recording%22%2C%22capture_mode%22%3A%7B%22Screen%22%3A%22Primary%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22studio%22%7D"
```

### Linux
```bash
xdg-open "cap-desktop://action?value=%7B%22action%22%3A%22start_recording%22%2C%22capture_mode%22%3A%7B%22Screen%22%3A%22Primary%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22studio%22%7D"
```

## Integration Examples

### Raycast Extension
See the `extensions/raycast/cap` directory for a complete Raycast extension implementation.

### Alfred Workflow
You can create Alfred workflows using the deeplink URLs with the `open` command on macOS.

### Keyboard Shortcuts (Custom)
Use tools like BetterTouchTool (macOS) or AutoHotkey (Windows) to trigger deeplinks with custom keyboard shortcuts.
