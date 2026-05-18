# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder from Raycast.

## Commands

| Command | Description |
|---------|-------------|
| Start Recording | Select a display and start recording (Studio or Instant mode) |
| Stop Recording | Stop the current recording |
| Toggle Pause | Pause or resume the current recording |
| Take Screenshot | Capture a screenshot of a selected display |
| Switch Microphone | Select an input device or disable the microphone |
| Switch Camera | Select a camera or disable it |
| Open Settings | Open Cap settings |

## How It Works

The extension communicates with Cap via deeplinks using the `cap-desktop://` URL scheme. Cap must be running for the commands to work.

## Requirements

- [Cap](https://cap.so) desktop app installed and running
- macOS (uses `system_profiler` for device enumeration)

## Development

```bash
npm install
npm run dev
```
