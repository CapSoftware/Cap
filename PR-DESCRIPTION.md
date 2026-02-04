# Add deeplink actions for recording control + Raycast extension

Closes #1540

## Summary

This PR extends Cap's deeplink support to enable full recording control via URL schemes, and includes a complete Raycast extension for quick access.

## New Deeplink Actions

Added to `deeplink_actions.rs`:

| Action | Description | URL Example |
|--------|-------------|-------------|
| `pause_recording` | Pause current recording | `cap-desktop://action?value={"pause_recording":null}` |
| `resume_recording` | Resume paused recording | `cap-desktop://action?value={"resume_recording":null}` |
| `toggle_pause_recording` | Toggle pause/resume | `cap-desktop://action?value={"toggle_pause_recording":null}` |
| `set_microphone` | Switch microphone | `cap-desktop://action?value={"set_microphone":{"label":"MacBook Pro Microphone"}}` |
| `set_camera` | Switch camera | `cap-desktop://action?value={"set_camera":{"device_id":"..."}}}` |

All new actions call the existing internal functions (`crate::recording::pause_recording`, etc.), following the same pattern as `StartRecording` and `StopRecording`.

## Raycast Extension

Located in `extensions/raycast/` with commands:
- Start Recording
- Stop Recording
- Pause Recording
- Resume Recording
- Toggle Pause
- Open Settings

## Testing

```bash
# Test pause/resume
open "cap-desktop://action?value={\"toggle_pause_recording\":null}"

# Test open settings  
open "cap-desktop://action?value={\"open_settings\":{\"page\":null}}"
```

## Checklist

- [x] Extended `DeepLinkAction` enum with new variants
- [x] Implemented `execute()` for each new action
- [x] Created Raycast extension with all commands
- [x] Added documentation

## Demo

[Demo video will be added after testing on macOS]
