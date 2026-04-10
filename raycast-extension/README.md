# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Features

- Start/Stop/Resume Recording
- Pause/Resume Recording
- Toggle Camera
- Toggle Microphone

## Requirements

- [Cap](https://cap.so) installed on your Mac
- macOS 12.0 or later

## Installation

1. Clone or download this extension
2. Run `npm install` in the extension directory
3. Run `npm run dev` to test in development mode
4. Run `npm run build` to build for production

## Usage

### Start Recording

Use the "Start Recording" command to begin a new recording. You can choose to:
- Record with system audio
- Record without audio

### Stop Recording

Stop the current recording and save it.

### Pause/Resume Recording

Pause an ongoing recording and resume it later.

### Toggle Camera/Microphone

Enable or disable your camera and microphone during recording.

## Deeplinks

This extension uses Cap's deeplink API:

- `cap://action?value={"start_recording":{...}}`
- `cap://action?value={"stop_recording":{}}`
- `cap://action?value={"pause_recording":{}}`
- `cap://action?value={"resume_recording":{}}`
- `cap://action?value={"set_microphone":{"mic_label":"..."}}`
- `cap://action?value={"set_camera":{"camera":{...}}}`

## License

MIT
