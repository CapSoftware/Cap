# Cap Desktop Deeplinks

Cap desktop handles action deeplinks in this format:

`cap-desktop://action?value=<url-encoded-json>`

The `value` parameter is JSON for a `DeepLinkAction`.

## Recording controls

- `"start_current_recording"`
- `"stop_recording"`
- `"pause_recording"`
- `"resume_recording"`

`start_current_recording` uses the current saved recording settings.

## Device switching

Switch microphone:

```json
{"switch_microphone":{"mic_label":null}}
```

When `mic_label` is `null`, Cap rotates to the next available microphone.

```json
{"switch_microphone":{"mic_label":"Shure MV7"}}
```

Switch camera:

```json
{"switch_camera":{"camera_selector":null}}
```

When `camera_selector` is `null`, Cap rotates to the next available camera.

```json
{"switch_camera":{"camera_selector":"FaceTime HD Camera"}}
```

`camera_selector` can be camera display name, device id, or model id.

## Other actions

```json
{"open_settings":{"page":"general"}}
```

```json
{"open_editor":{"project_path":"/absolute/path/to/project.cap"}}
```

```json
{"start_recording":{"capture_mode":{"screen":"Built-in Retina Display"},"camera":null,"mic_label":null,"capture_system_audio":true,"mode":"studio"}}
```
