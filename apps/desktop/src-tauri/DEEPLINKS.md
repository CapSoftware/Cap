# Cap Desktop Deeplinks

Cap desktop registers the `cap-desktop://` URL scheme for external automation and integrations (e.g. Raycast, Alfred, shell scripts).

## URL Format

All actions use the `action` host with a JSON-encoded `value` query parameter:

```
cap-desktop://action?value=<url-encoded-json>
```

### Unit actions (no parameters)

The JSON value is a quoted string:

```
cap-desktop://action?value=%22stop_recording%22
```

### Parameterized actions

The JSON value is an object keyed by the action name (shown unencoded for readability; URL-encode the JSON in actual deeplinks):

```
cap-desktop://action?value={"start_recording":{"capture_mode":null,"camera":null,"mic_label":null,"capture_system_audio":false,"mode":"studio"}}
```

## Available Actions

### Recording Controls

| Action                    | Type          | Description                                         |
| ------------------------- | ------------- | --------------------------------------------------- |
| `start_recording`         | Parameterized | Start a new recording with explicit settings        |
| `start_current_recording` | Parameterized | Start a recording using saved settings from the app |
| `stop_recording`          | Unit          | Stop the current recording                          |
| `pause_recording`         | Unit          | Pause the current recording                         |
| `resume_recording`        | Unit          | Resume a paused recording                           |
| `toggle_pause_recording`  | Unit          | Toggle pause/resume on the current recording        |
| `restart_recording`       | Unit          | Restart the current recording                       |

### Screenshots

| Action            | Type          | Description          |
| ----------------- | ------------- | -------------------- |
| `take_screenshot` | Parameterized | Capture a screenshot |

### Device Management

| Action             | Type          | Description                                     |
| ------------------ | ------------- | ----------------------------------------------- |
| `list_cameras`     | Unit          | Copy available cameras as JSON to clipboard     |
| `set_camera`       | Parameterized | Set the active camera                           |
| `list_microphones` | Unit          | Copy available microphones as JSON to clipboard |
| `set_microphone`   | Parameterized | Set the active microphone                       |
| `list_displays`    | Unit          | Copy available displays as JSON to clipboard    |
| `list_windows`     | Unit          | Copy available windows as JSON to clipboard     |

### Other

| Action          | Type          | Description                  |
| --------------- | ------------- | ---------------------------- |
| `open_editor`   | Parameterized | Open a project in the editor |
| `open_settings` | Parameterized | Open the settings window     |

## Action Parameters

### `start_recording`

| Field                  | Type                                                     | Required | Description                                                            |
| ---------------------- | -------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `capture_mode`         | `null` \| `{"screen":"<name>"}` \| `{"window":"<name>"}` | No       | Target to capture. Defaults to primary display when omitted or `null`. |
| `camera`               | `null` \| device ID object                               | No       | Camera device. Defaults to no camera when omitted or `null`.           |
| `mic_label`            | `null` \| `string`                                       | No       | Microphone label. Defaults to no microphone when omitted or `null`.    |
| `capture_system_audio` | `boolean`                                                | Yes      | Whether to capture system audio.                                       |
| `mode`                 | `"studio"` \| `"instant"`                                | Yes      | Recording mode.                                                        |

### `start_current_recording`

| Field  | Type                                | Required | Description                                                                         |
| ------ | ----------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `mode` | `null` \| `"studio"` \| `"instant"` | No       | Override the saved recording mode. `null` uses the saved mode (defaults to studio). |

### `take_screenshot`

| Field          | Type                                                     | Required | Description                                         |
| -------------- | -------------------------------------------------------- | -------- | --------------------------------------------------- |
| `capture_mode` | `null` \| `{"screen":"<name>"}` \| `{"window":"<name>"}` | No       | Target to capture. `null` uses the primary display. |

### `set_camera`

| Field | Type                       | Required | Description                                     |
| ----- | -------------------------- | -------- | ----------------------------------------------- |
| `id`  | `null` \| device ID object | No       | Camera to activate. `null` disables the camera. |

### `set_microphone`

| Field   | Type               | Required | Description                                       |
| ------- | ------------------ | -------- | ------------------------------------------------- |
| `label` | `null` \| `string` | No       | Microphone label. `null` disables the microphone. |

### `list_cameras` clipboard output

JSON array of camera objects:

```json
[{ "device_id": "...", "model_id": "...", "display_name": "..." }]
```

Pass `device_id` or `model_id` as the `id` field of `set_camera`.

### `list_microphones` clipboard output

JSON array of label strings (sorted):

```json
["Built-in Microphone", "External Headset"]
```

Pass a label string directly as the `label` field of `set_microphone`.

### `list_displays` clipboard output

JSON array of display objects:

```json
[{ "id": 1, "name": "Built-in Retina Display", "refresh_rate": 60 }]
```

### `list_windows` clipboard output

JSON array of window objects:

```json
[{ "id": 1, "owner_name": "Safari", "name": "Page Title", "bounds": { ... }, "refresh_rate": 60, "bundle_identifier": "com.apple.Safari" }]
```

### `open_editor`

| Field          | Type     | Required | Description                             |
| -------------- | -------- | -------- | --------------------------------------- |
| `project_path` | `string` | Yes      | Absolute path to the project directory. |

### `open_settings`

| Field  | Type               | Required | Description                                           |
| ------ | ------------------ | -------- | ----------------------------------------------------- |
| `page` | `null` \| `string` | No       | Settings page to open. `null` opens the default page. |

## Examples

Start a studio recording on the primary display:

```bash
open "cap-desktop://action?value=$(python3 -c 'import urllib.parse, json; print(urllib.parse.quote(json.dumps({"start_recording":{"capture_mode":None,"camera":None,"mic_label":None,"capture_system_audio":False,"mode":"studio"}})))')"
```

Start a recording using saved app settings:

```bash
open "cap-desktop://action?value=$(python3 -c 'import urllib.parse, json; print(urllib.parse.quote(json.dumps({"start_current_recording":{"mode":None}})))')"
```

Stop a recording:

```bash
open "cap-desktop://action?value=%22stop_recording%22"
```

Take a screenshot:

```bash
open "cap-desktop://action?value=$(python3 -c 'import urllib.parse, json; print(urllib.parse.quote(json.dumps({"take_screenshot":{"capture_mode":None}})))')"
```

List available microphones (copies JSON to clipboard):

```bash
open "cap-desktop://action?value=%22list_microphones%22"
```
