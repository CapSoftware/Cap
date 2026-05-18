# Cap Desktop Deep Links

Cap registers the `cap-desktop://` URL scheme via `tauri-plugin-deep-link` and exposes a `cap-desktop://action` endpoint that consumes a JSON-encoded `DeepLinkAction` from the `value` query parameter.

```
cap-desktop://action?value=<URL-encoded JSON>
```

The full set of supported actions lives in `apps/desktop/src-tauri/src/deeplink_actions.rs`.

## Recording control

| Action | JSON payload | Notes |
| --- | --- | --- |
| Start recording | `{"start_recording": { "capture_mode": { "screen": "Display 1" } \| { "window": "Safari — example.com" }, "camera": null \| {"DeviceID": "..."} \| {"ModelID": "..."}, "mic_label": null \| "Built-in Microphone", "capture_system_audio": false, "mode": "studio" \| "instant" }}` | Same wire shape as `commands.startRecording`. `camera` and `mic_label` may be `null` to use the current selection. |
| Stop recording | `"stop_recording"` | No-op if nothing is recording. |
| Pause recording | `"pause_recording"` | No-op if no recording or already paused. |
| Resume recording | `"resume_recording"` | No-op if no recording or not paused. |
| Switch camera | `{"switch_camera": {"camera": null \| {"DeviceID": "..."} \| {"ModelID": "..."}}}` | Set `camera` to `null` to clear the camera selection. Works while recording is active or idle. |
| Switch microphone | `{"switch_microphone": {"mic_label": null \| "Built-in Microphone"}}` | Set `mic_label` to `null` to clear the microphone selection. |

## Editor / settings

| Action | JSON payload | Notes |
| --- | --- | --- |
| Open editor | `{"open_editor": {"project_path": "/path/to/project.cap"}}` | macOS also accepts a bare `file://` URL for the same effect. |
| Open settings | `{"open_settings": {"page": null \| "general" \| "recordings" \| ...}}` | `page` selects which settings pane to focus. |

## Calling from the command line

macOS:

```sh
open 'cap-desktop://action?value=%22pause_recording%22'
```

Windows:

```powershell
start 'cap-desktop://action?value=%22pause_recording%22'
```

A Raycast extension that wraps the no-view commands lives in `apps/raycast`.
