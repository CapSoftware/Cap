# Cap Raycast Extension

Control Cap screen recording directly from Raycast.

## Features

- **Start Recording**: Quickly start recording your screen
- **Start Recording Window**: Select and record a specific window
- **Stop Recording**: Stop the current recording
- **Toggle Pause**: Pause or resume recording (coming soon)
- **Switch Camera**: Change camera input during recording
- **Switch Microphone**: Change microphone input during recording
- **Open Settings**: Open Cap settings

## Installation

### Prerequisites

- [Cap](https://cap.so) must be installed on your system
- [Raycast](https://raycast.com) must be installed

### Setup

1. Clone this repository or download the extension
2. Navigate to the `raycast-extension` directory
3. Run `npm install` to install dependencies
4. Run `npm run dev` to load the extension in Raycast

## Usage

Open Raycast and search for any of the Cap commands:

- `Start Recording` - Immediately start recording your primary screen
- `Start Recording Window` - Choose a window to record
- `Stop Recording` - Stop the current recording
- `Toggle Pause Recording` - Pause/resume (coming soon)
- `Switch Camera` - Change camera input
- `Switch Microphone` - Change microphone input
- `Open Settings` - Open Cap settings

## Deeplink Protocol

This extension uses Cap's deeplink protocol (`cap://action`) to communicate with the Cap app. The deeplink actions are defined in the Cap desktop app at `apps/desktop/src-tauri/src/deeplink_actions.rs`.

### Supported Actions

- `StartRecording`: Start a new recording with specified capture mode, camera, microphone, and audio settings
- `StopRecording`: Stop the current recording
- `OpenSettings`: Open Cap settings with optional page parameter

### Future Actions (To Be Implemented)

- `PauseRecording`: Pause the current recording
- `ResumeRecording`: Resume a paused recording
- `SwitchCamera`: Change camera input during recording
- `SwitchMicrophone`: Change microphone input during recording

## Development

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
npm run fix-lint
```

### Publishing

```bash
npm run publish
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT
