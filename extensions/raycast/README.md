# Cap Raycast Extension

Control [Cap](https://cap.so) screen recordings, browse recent local and cloud Caps, copy shareable links, and open your Cap dashboard directly from Raycast.

## Prerequisites

- [Cap Desktop](https://cap.so/download) installed on your machine.
- Optional: Sign in to Cap Desktop (or configure a Cap CLI API key) to search cloud recordings and automatically copy shareable links for Instant recordings.

## Commands

- **Start Recording** (`start-recording`): Start a screen recording in Cap using your saved Cap Desktop settings (recording mode, target display or window, camera, microphone, and system audio), with optional Raycast preferences or per-invocation arguments to override the mode or display name.
- **Stop Recording** (`stop-recording`): Stop the active Cap recording session. For Instant Mode recordings, Cap Desktop uploads and copies the shareable link to your clipboard automatically when the recording finishes.
- **Search Caps** (`search-caps`): Search and browse your recent local `.cap` recording bundles and Cap Cloud recordings. Includes actions to copy the shareable link, open the video in your browser, open local recordings in the Cap Editor/Player, or reveal `.cap` bundles in Finder.
- **Open Dashboard** (`open-dashboard`): Open your Cap web dashboard (`https://cap.so/dashboard` or your self-hosted Cap server's `/dashboard`) in the default browser.
- **Open Cap Settings** (`open-settings`): Open the Cap Desktop settings window.

## Preferences

- **Cap Server URL** (`serverUrl`): Custom or self-hosted Cap server URL (defaults to Cap Desktop's configured `serverUrl` or `https://cap.so`).
- **Default Recording Mode** (`defaultMode`): Use the mode saved in Cap Desktop (`default`), or force `instant` or `studio`.
- **Default Screen Name Override** (`defaultScreen`): Optional exact display name to capture. When left empty, the extension uses Cap Desktop's saved target or detects the currently active display.
- **Camera Device ID Override** (`cameraDeviceId`): Optional camera `DeviceID` override. Leave empty to keep the camera currently selected in Cap Desktop.
- **Microphone Name Override** (`micLabel`): Optional microphone label override. Leave empty to keep the microphone currently selected in Cap Desktop.
- **Capture System Audio** (`systemAudio`): Use the setting saved in Cap Desktop (`default`), or explicitly enable/disable system audio capture.
- **Recordings Directory** (`recordingsDirectory`): Optional custom local directory containing `.cap` recording bundles (defaults to Cap Desktop's configured recordings folder).
- **Cap API Key / Token** (`apiKey`): Optional Cap CLI API key for listing cloud recordings in **Search Caps** (falls back to `CAP_AGENT_TOKEN`, `CAP_API_KEY`, or your existing Cap Desktop login).
