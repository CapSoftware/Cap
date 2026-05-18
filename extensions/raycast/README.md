# Cap Raycast Extension

Control Cap screen recording directly from Raycast.

## Features

- **Start Recording**: Choose between screen or window capture with Studio or Instant mode
- **Stop Recording**: Quickly stop your current recording
- **Pause Recording**: Pause the recording without stopping
- **Resume Recording**: Resume a paused recording
- **Toggle Pause**: Toggle between pause and resume states
- **Switch Camera**: Change the camera being used during recording
- **Switch Microphone**: Change the microphone being used during recording

## Installation

### From Source

1. Clone the Cap repository
2. Navigate to the extension directory:
   ```bash
   cd extensions/raycast
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build and import to Raycast:
   ```bash
   npm run dev
   ```

## Usage

Once installed, you can access all Cap commands from Raycast:

- Type "Cap" in Raycast to see all available commands
- Use keyboard shortcuts to quickly control your recordings
- Commands execute instantly without opening the Cap UI

## Requirements

- Cap desktop application must be installed and running
- macOS (Cap is currently macOS-only)
- Raycast

## Deep Link Protocol

This extension uses Cap's deep link protocol (`cap://action`) to communicate with the desktop application. All commands are executed via URL schemes that trigger the corresponding actions in Cap.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Lint code
npm run lint

# Fix linting issues
npm run fix-lint
```

## License

MIT
