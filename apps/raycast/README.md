# Cap Raycast Extension

This extension drives the Cap desktop app through Cap deeplinks.

## Commands

- Start Recording: starts an instant or studio recording for a screen or window name.
- Stop Recording: stops the active recording.
- Pause Recording: pauses the active recording.
- Resume Recording: resumes the active recording.
- Toggle Recording Pause: toggles pause state for the active recording.
- Switch Microphone: switches Cap to an exact microphone label.
- Switch Camera: switches Cap using either a camera device id or model id.

## Notes

- Screen and window names must exactly match the names Cap sees from the OS.
- Camera switching expects the raw device id or model id already used by Cap.
- The extension sends `cap-desktop://action?...` deeplinks, so the Cap desktop app must already be installed.
