# Cap.so Raycast Extension

Control [Cap](https://cap.so) screen recordings and open your web dashboard directly from Raycast.

## Commands

- **Start Recording** (`start-recording`): Starts a Cap screen recording using your configured default recording mode (`instant` or `studio`), target screen, camera, microphone, and system audio settings via `cap-desktop://action?value=...`.
- **Stop Recording** (`stop-recording`): Stops the active Cap recording via `cap-desktop://action?value=%22stop_recording%22` and preserves/copies the shareable Cap video link (`https://cap.so/s/...`) to your clipboard by default.
- **Open Web Dashboard** (`open-dashboard`): Opens `https://cap.so/dashboard` (or your custom self-hosted Cap Web URL) in your default browser.
