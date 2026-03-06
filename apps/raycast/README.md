# Cap Raycast Extension

This extension controls Cap Desktop through the `cap-desktop://action` deeplink.

## Commands

- Start Recording
- Stop Recording
- Pause Recording
- Resume Recording
- Toggle Pause Recording
- Switch Microphone
- Switch Camera

All commands serialize a `DeepLinkAction` payload and open:

`cap-desktop://action?value=<json>`
