# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from [Raycast](https://raycast.com).

## Commands

| Command | Description |
|---|---|
| **Start Recording** | Start a new Cap screen recording instantly |
| **Stop Recording** | Stop the active recording |
| **Pause / Resume Recording** | Toggle pause state of the current recording |
| **Switch Microphone** | Choose from a list of available microphones |
| **Switch Camera** | Choose from a list of available cameras |
| **Recording Status** | Check whether Cap is currently recording |

## Requirements

- [Cap](https://cap.so) installed and running on macOS
- [Raycast](https://raycast.com) installed

## How It Works

Each command triggers a `cap-desktop://action?value=...` deeplink that is handled natively by the Cap desktop app's [`deeplink_actions.rs`](../../apps/desktop/src-tauri/src/deeplink_actions.rs) handler.

## Development

```bash
cd raycast-extension
npm install
npm run dev
```
