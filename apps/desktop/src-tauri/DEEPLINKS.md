# Cap Desktop Deeplinks

Cap Desktop registers the `cap-desktop://` URL scheme.

## Recording controls

### Start recording

```bash
open 'cap-desktop://record/start?mode=studio&capture_type=screen&target=Built-in%20Display&capture_system_audio=true&mic_label=External%20Microphone'
```

Query params:
- `mode`: `studio` or `instant` (default: `studio`)
- `capture_type`: `screen` or `window` (required)
- `target`: screen/window name exactly as shown in Cap (required)
- `capture_system_audio`: `true` / `false` (optional)
- `mic_label`: microphone label exactly as shown in Cap (optional)
- omitting `mic_label`, `device_id`, `model_id`, and `off` keeps the current Cap inputs unchanged
- camera:
  - `device_id=<id>` or `model_id=<VID:PID>`
  - `off=true` to disable camera

### Stop / pause / resume / toggle / restart

```bash
open 'cap-desktop://record/stop'
open 'cap-desktop://record/pause'
open 'cap-desktop://record/resume'
open 'cap-desktop://record/toggle-pause'
open 'cap-desktop://record/restart'
```

## Device switching

### Switch microphone

```bash
open 'cap-desktop://device/microphone?label=External%20Microphone'
```

To disable microphone input:

```bash
open 'cap-desktop://device/microphone?off=true'
```

### Switch camera

```bash
open 'cap-desktop://device/camera?device_id=YOUR_DEVICE_ID'
open 'cap-desktop://device/camera?model_id=VID:PID'
open 'cap-desktop://device/camera?off=true'
```

`off=true` cannot be combined with `device_id` or `model_id`.

## Settings

```bash
open 'cap-desktop://settings/open?page=hotkeys'
```

## Backward compatibility

Legacy JSON payload links remain supported:

```bash
open 'cap-desktop://action?value={...json...}'
```
