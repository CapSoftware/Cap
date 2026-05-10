# Cap Raycast Extension

Control Cap desktop recordings from Raycast.

## Commands

- Start Studio Recording
- Start Instant Recording
- Stop Recording
- Restart Recording
- Pause or Resume Recording
- Open Recording Picker
- Set Microphone
- Clear Microphone
- Set Camera
- Clear Camera
- Open Settings

## How It Works

The extension opens Cap desktop deeplinks using the `cap-desktop://action` scheme.

Examples:

- `cap-desktop://action?value=%22stop_recording%22`
- `cap-desktop://action?value=%22toggle_pause_recording%22`
- `cap-desktop://action?value=%7B%22start_recording_from_settings%22%3A%7B%22mode%22%3A%22studio%22%7D%7D`
- `cap-desktop://action?value=%7B%22set_microphone%22%3A%7B%22mic_label%22%3A%22MacBook%20Pro%20Microphone%22%7D%7D`
- `cap-desktop://action?value=%7B%22set_camera%22%3A%7B%22camera%22%3A%7B%22DeviceID%22%3A%22camera-device-id%22%7D%7D%7D`

The desktop app parses the `value` query parameter as JSON and executes the corresponding action.
