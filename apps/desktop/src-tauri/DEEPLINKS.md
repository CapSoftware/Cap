# Cap Desktop Deeplinks

Cap registers the `cap-desktop://` scheme in [`tauri.conf.json`](./tauri.conf.json).

## Existing Links

| URL | Behavior | Notes |
| --- | --- | --- |
| `cap-desktop://signin?<query>` | Completes desktop auth from the web flow | Handled by the frontend deep-link listener in `apps/desktop/src/utils/auth.ts` |
| `cap-desktop://action?value=<urlencoded-json>` | Executes the legacy JSON action payload | Handled by `apps/desktop/src-tauri/src/deeplink_actions.rs` |
| `file:///path/to/project.cap` | Opens a `.cap` project file | macOS only |

The legacy `action` payload still deserializes the snake_case `DeepLinkAction` enum. Example:

```text
cap-desktop://action?value=%7B%22open_settings%22%3A%7B%22page%22%3A%22general%22%7D%7D
```

## Recording Control

| URL | Behavior |
| --- | --- |
| `cap-desktop://record/start` | Starts recording with the saved recording mode from `RecordingSettingsStore`; falls back to Cap's default mode when none is saved |
| `cap-desktop://record/start?mode=studio` | Starts studio recording with the saved target and saved device selections |
| `cap-desktop://record/start?mode=instant` | Starts instant recording with the saved target and saved device selections |
| `cap-desktop://record/start?mode=screenshot` | Passes screenshot mode through to the existing start path and will return the same error Cap already emits for screenshot mode |
| `cap-desktop://record/stop` | Stops the active recording |
| `cap-desktop://record/pause` | Pauses the active recording |
| `cap-desktop://record/resume` | Resumes the active recording |
| `cap-desktop://record/toggle-pause` | Toggles pause/resume on the active recording |

These routes reuse the same recording command paths that the desktop app already uses, so `RecordingEvent::Paused`, `RecordingEvent::Resumed`, and `RecordingEvent::Stopped` stay in sync with the in-app recording UI.

## Device Switching

Cap pauses an active recording before switching microphone or camera inputs, matching the existing in-progress recording UI flow.

### Microphone

| URL | Behavior |
| --- | --- |
| `cap-desktop://device/microphone?label=<device-label>` | Selects the microphone with the matching label |
| `cap-desktop://device/microphone?off=true` | Disables the microphone |

Microphones are selected by the same label string returned by `list_audio_devices`.

### Camera

| URL | Behavior |
| --- | --- |
| `cap-desktop://device/camera?model_id=<vid:pid>` | Selects the camera whose model ID matches `<vid:pid>` |
| `cap-desktop://device/camera?device_id=<unique-id>` | Selects the camera whose device ID matches `<unique-id>` |
| `cap-desktop://device/camera?id=<unique-id>` | Alias for `device_id` |
| `cap-desktop://device/camera?label=<display-name>` | Selects the first camera whose display name matches `<display-name>` |
| `cap-desktop://device/camera?off=true` | Disables the camera |

Internally, the Tauri command expects `DeviceOrModelID`, which serializes as:

```text
{"DeviceID":"<unique-id>"}
{"ModelID":"<vid:pid>"}
```

The deeplink parser accepts the query-string forms above and resolves them back to the same `DeviceOrModelID` variants before calling Cap's existing camera input command.

## Errors

- Unknown routes return an invalid-deeplink error and are ignored by the Rust action handler.
- Unknown microphone labels surface the existing `set_mic_input` error.
- Unknown camera labels, model IDs, and device IDs are rejected before Cap calls the camera input command.
- `signin` links are intentionally ignored by the Rust action handler so the frontend auth flow continues to work unchanged.
