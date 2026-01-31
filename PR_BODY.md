/claim #1540

## Description

This PR adds deeplink support for pause/resume recording and device switching, plus a Raycast extension to control Cap via these deeplinks.

## Changes

### Deeplinks Support
- Added `PauseRecording` deeplink action
- Added `ResumeRecording` deeplink action
- Added `SwitchMicrophone` deeplink action with `mic_label` parameter
- Added `SwitchCamera` deeplink action with `camera_id` parameter

All new actions follow the same pattern as existing `StartRecording` and `StopRecording` actions, using the existing Tauri commands.

### Raycast Extension
- Created new Raycast extension at `apps/raycast-extension/`
- Added 6 commands: Start, Stop, Pause, Resume, Switch Microphone, Switch Camera
- Each command uses the `cap-desktop://` deeplink scheme to communicate with the app

## Testing

Ready for testing. The implementation wires up existing functionality, so it should work with the current recording system.
