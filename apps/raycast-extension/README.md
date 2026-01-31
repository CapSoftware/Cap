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

## Deeplink Format

The extension uses the `cap-desktop://` URL scheme to communicate with the Cap app. The format is:

```
cap-desktop://action?value={JSON_ACTION}
```

Where `JSON_ACTION` is a JSON-encoded action matching the `DeepLinkAction` enum in the Cap desktop app.

## Development

```bash
# Install dependencies
npm install

# Develop in Raycast
ray dev

# Build for production
npm run build

# Lint
npm run lint
```

## License

MIT
