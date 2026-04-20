# Cap Raycast Extension

Control Cap screen recorder directly from Raycast.

## Features

- **Start Recording** - Begin a new screen recording
- **Stop Recording** - Stop the current recording
- **Pause Recording** - Pause an active recording
- **Resume Recording** - Resume a paused recording
- **Toggle Pause** - Toggle pause state
- **Switch Microphone** - Change the active microphone
- **Switch Camera** - Change the active camera
- **Open Settings** - Access Cap settings pages

## Installation

1. Clone the Cap repository
2. Navigate to `apps/raycast-extension`
3. Run `pnpm install`
4. Run `pnpm dev` to develop or `pnpm build` to build

## Usage

After installing the extension in Raycast, you can:

1. Open Raycast (default: `Cmd + K`)
2. Type "Cap" to see all available commands
3. Select the command you want to execute

## Deep Link Protocol

This extension uses Cap's deep link protocol (`cap-desktop://action`) to communicate with the desktop app. All commands are executed through deep links that trigger actions in the Cap desktop application.

## Development

```bash
# Install dependencies
pnpm install

# Start development mode
pnpm dev

# Build for production
pnpm build
```

## License

MIT
