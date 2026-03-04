# Cap Raycast Extension

Control [Cap](https://cap.so) screen recorder directly from Raycast.

## Commands

| Command                        | Description                                   |
| ------------------------------ | --------------------------------------------- |
| Start Instant Recording        | Start an instant screen recording             |
| Start Studio Recording         | Start a studio screen recording               |
| Start Recording (Saved Settings) | Start a recording using your saved Cap settings |
| Stop Recording                 | Stop the current recording                    |
| Pause Recording                | Pause the current recording                   |
| Resume Recording               | Resume a paused recording                     |
| Toggle Pause Recording         | Toggle pause/resume                           |
| Restart Recording              | Restart the current recording                 |
| Take Screenshot                | Take a screenshot                             |
| Open Settings                  | Open Cap settings                             |

## How It Works

The extension communicates with the Cap desktop app through deeplinks using the `cap-desktop://` URL scheme. All commands dispatch actions via deeplink URLs that Cap handles natively.

See [DEEPLINKS.md](../../apps/desktop/src-tauri/DEEPLINKS.md) for full deeplink documentation.

## Prerequisites

- [Cap](https://cap.so) desktop app installed and running
- [Raycast](https://raycast.com) installed

## Development

```bash
cd extensions/raycast
pnpm install
pnpm dev
```
