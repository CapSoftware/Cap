# Cap Desktop Deeplinks

Cap Desktop registers the `cap-desktop://` URL scheme.

## Recording controls

### Start recording

```bash
open 'cap-desktop://record/start?mode=studio&capture_type=screen&target=Built-in%20Display&capture_system_audio=true&mic_label=MacBook%20Microphone'
```

Query params:

- `mode`: `studio` or `instant` (default: `studio`)
- `capture_type`: `screen` or `window` (required)
- `target`: screen/window name exactly as shown in Cap (required)
- `capture_system_audio`: `true` / `false` (optional)
- `mic_label`: microphone label (optional)
- camera (optional):
  - `device_id=<id>` **or** `model_id=<id>`
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
open 'cap-desktop://device/microphone?label=Shure%20MV7'
```

To disable mic input:

```bash
open 'cap-desktop://device/microphone'
```

### Switch camera

```bash
open 'cap-desktop://device/camera?device_id=YOUR_DEVICE_ID'
open 'cap-desktop://device/camera?model_id=YOUR_MODEL_ID'
open 'cap-desktop://device/camera?off=true'
```

## Settings

```bash
open 'cap-desktop://settings/open?page=hotkeys'
```

## Backward compatibility

Legacy JSON payload links are still supported:

```bash
open 'cap-desktop://action?value={...json...}'
```
