# Cap — Raycast Extension
<!-- Fix for Issue #1540 - Deep Links & Raycast Support -->

Control your [Cap](https://cap.so) screen recording sessions directly from Raycast — no mouse required.

## Commands

| Command | Description |
|---|---|
| **Cap: Recording Controls** | Start, stop, pause, resume, or toggle your recording session |
| **Cap: Switch Input Device** | Switch the active microphone or camera |

## Requirements

- **Cap for macOS** installed from [cap.so](https://cap.so)
- A **Cap API key** (only required for the device switcher — find it in Cap Settings → Developer)

## How It Works

Both commands build a `cap-desktop://action?value=<JSON>` deep link and call `open()` to hand off control to the Cap desktop app. Cap handles all state transitions; this extension stays stateless.

### URL Schema

```
cap-desktop://action?value=<URL-encoded JSON>
```

| Action | JSON |
|---|---|
| Start Recording | `{"type":"startRecording","captureMode":{"screen":"Built-in Display"},...}` |
| Stop Recording | `{"type":"stopRecording"}` |
| Pause Recording | `{"type":"pauseRecording"}` |
| Resume Recording | `{"type":"resumeRecording"}` |
| Toggle Pause | `{"type":"togglePauseRecording"}` |
| Switch Microphone | `{"type":"switchMicrophone","label":"MacBook Pro Microphone"}` |
| Switch Camera | `{"type":"switchCamera","id":"<deviceId>"}` |
| Disable Microphone | `{"type":"switchMicrophone","label":null}` |
| Disable Camera | `{"type":"switchCamera","id":null}` |

## Setup

### Cap: Recording Controls
No setup required. Just invoke the command and select an action.

### Cap: Switch Input Device
1. Open the command in Raycast.
2. On first use you'll be prompted to enter your Cap API key.
3. The key is stored in Raycast's encrypted local storage — never sent anywhere except the Cap API.
4. Select a microphone or camera to switch. Cap will activate the chosen device immediately.

## Security

- API keys are stored in **Raycast's `LocalStorage`** (encrypted, sandboxed per extension).
- No credentials are hard-coded or logged.
- Deep links only communicate with the locally running Cap app.

## Development

```bash
cd extensions/raycast
npm install
npm run dev     # Hot-reload development mode
npm run build   # Production build
npm run lint    # ESLint check
```

## Related

- [Cap GitHub Repository](https://github.com/CapSoftware/Cap)
- [Issue #1540 — Bounty: Deeplinks support + Raycast Extension](https://github.com/CapSoftware/Cap/issues/1540)
- [Raycast Developer Documentation](https://developers.raycast.com)
