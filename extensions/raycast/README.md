# Cap Raycast Extension

Control Cap screen recordings directly from Raycast.

## Features

- **Pause Recording** - Pause your current recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle between pause and resume states
- **Stop Recording** - Stop the current recording
- **Switch Microphone** - Change your active microphone from a searchable list
- **Switch Camera** - Change your active camera from a searchable list

## Installation

### Prerequisites

- [Raycast](https://www.raycast.com/) installed on macOS
- [Cap](https://cap.so/) installed and running

### Install from Source

1. Clone the Cap repository
2. Navigate to the extension directory:
   ```bash
   cd extensions/raycast
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build and install the extension:
   ```bash
   npm run build
   ```
5. Import the extension in Raycast:
   - Open Raycast
   - Go to Extensions
   - Click "+" and select "Import Extension"
   - Select the `extensions/raycast` directory

## Usage

### Recording Control

Open Raycast and search for:
- "Pause Recording" - Pauses your current Cap recording
- "Resume Recording" - Resumes a paused recording
- "Toggle Pause" - Toggles between pause/resume
- "Stop Recording" - Stops the current recording

### Device Management

Open Raycast and search for:
- "Switch Microphone" - Shows a list of available microphones
- "Switch Camera" - Shows a list of available cameras

Select a device from the list to switch to it.

## Deeplink Format

The extension uses Cap's deeplink protocol to trigger actions:

```
cap-desktop://action?value=<URL_ENCODED_JSON>
```

### Available Actions

**Recording Control:**
```json
{"pause_recording": {}}
{"resume_recording": {}}
{"toggle_pause_recording": {}}
{"stop_recording": {}}
```

**Device Management:**
```json
{"switch_microphone": {"mic_label": "Microphone Name"}}
{"switch_camera": {"camera": {"device_id": "camera-id"}}}
{"list_microphones": {}}
{"list_cameras": {}}
```

### Example

To pause a recording programmatically:

```bash
open "cap-desktop://action?value=%7B%22pause_recording%22%3A%7B%7D%7D"
```

Or in JavaScript:
```javascript
const action = { pause_recording: {} };
const json = JSON.stringify(action);
const encoded = encodeURIComponent(json);
const deeplink = `cap-desktop://action?value=${encoded}`;
await open(deeplink);
```

## Development

### Setup

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Lint

```bash
npm run lint
```

## Troubleshooting

### Commands Not Working

1. Make sure Cap is running
2. Check that Cap has the necessary permissions (microphone, camera, screen recording)
3. Try restarting Cap

### Device Lists Empty

1. Verify Cap has microphone/camera permissions in System Settings
2. Make sure devices are connected and recognized by your system
3. Try running Cap with elevated permissions

### Deeplinks Not Triggering

1. Verify the deeplink format is correct
2. Check that the JSON is properly URL-encoded
3. Ensure Cap is the default handler for `cap-desktop://` URLs

## License

MIT

## Support

For issues and feature requests, please visit the [Cap GitHub repository](https://github.com/CapSoftware/Cap).
