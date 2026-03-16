# Cap Raycast Extension

Control Cap screen recording directly from Raycast using deeplinks.

## Features

This extension provides quick commands to control Cap recordings:

- **Start Recording** - Start a new Cap recording (cap://record)
- **Stop Recording** - Stop the current recording (cap://stop)
- **Pause Recording** - Pause the current recording (cap://pause)
- **Resume Recording** - Resume a paused recording (cap://resume)
- **Toggle Microphone** - Toggle microphone on/off during recording (cap://toggle-mic)
- **Toggle Camera** - Toggle camera on/off during recording (cap://toggle-camera)

## Installation

1. Ensure Cap is installed and running
2. Install this Raycast extension
3. Use the commands from Raycast's command palette

## Deeplinks

This extension uses the following deeplink protocol:

- `cap-desktop://action?value="<action>"`

Where `<action>` can be:
- `stop_recording`
- `pause_recording`
- `resume_recording`
- `toggle_mic`
- `toggle_camera`

For `start_recording`, a JSON object is required with recording parameters.

## Notes

- The "Start Recording" command currently uses default settings. Future versions may allow configuration.
- Toggle mic and camera are only supported for studio recordings, not instant recordings.
- The extension requires Cap to be running to work.

## Development

```bash
npm install
npm run dev
```

## License

MIT
