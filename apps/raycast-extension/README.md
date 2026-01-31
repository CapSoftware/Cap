# Cap Raycast Extension

A Raycast extension to control the Cap recording app via deeplinks.

## Features

- **Start Recording**: Start a new recording session
- **Stop Recording**: Stop the current recording
- **Pause Recording**: Pause the current recording
- **Resume Recording**: Resume a paused recording
- **Switch Microphone**: Switch to a different microphone input
- **Switch Camera**: Switch to a different camera input

## Installation

1. Open Raycast
2. Go to Extensions → Create Extension
3. Select "Import Extension"
4. Point to this directory

Or use the Raycast CLI:

```bash
cd apps/raycast-extension
pnpm install
ray dev
```

## Usage

All commands are available through Raycast's command palette. Simply search for "Cap" and select the desired action.

**Important Security Note**: Deeplink actions for recording control (start, stop, pause, resume, switch devices) require opt-in permission in Cap settings. Go to Settings → General and enable "Allow deeplink actions" to use these features. This prevents unauthorized apps or websites from controlling your recordings via URL schemes.

## Deeplink Format

The extension uses the `cap-desktop://` URL scheme to communicate with the Cap app. The format is:

```
cap-desktop://action?value={JSON_ACTION}
```

Where `JSON_ACTION` is a JSON-encoded action matching the `DeepLinkAction` enum in the Cap desktop app.

## Development

```bash
# Install dependencies
pnpm install

# Develop in Raycast
pnpm dev

# Build for production
pnpm build

# Lint
pnpm lint
```

## License

MIT
