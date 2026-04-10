# Cap Raycast Extension

This extension controls Cap with `cap-desktop://` deeplinks.

Commands:
- Start recording
- Stop recording
- Pause recording
- Resume recording
- Toggle pause recording
- Restart recording
- Switch microphone
- Switch camera
- Open settings

Notes:
- Target names and device identifiers must match what Cap expects.
- The extension never uses `cap://`; it always sends `cap-desktop://` deeplinks.
- Camera switching supports `device_id`, `model_id`, or `off=true`.
