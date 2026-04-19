# Cap Raycast extension (local)

Companion to desktop deeplinks (`cap-desktop://action?value=…`) implemented in `apps/desktop/src-tauri/src/deeplink_actions.rs`.

## Prereqs

- macOS with [Raycast](https://www.raycast.com/) (extensions target macOS).
- Cap desktop running (dev or prod) so `cap-desktop://` is registered.

## Install (dev)

```bash
cd extensions/cap
npm install
npm run dev
```

Pick the extension in Raycast, then run **Refresh Device Cache** once Cap is open so `raycast-device-cache.json` is written under Cap’s app data directory (`so.cap.desktop` or `so.cap.desktop.dev` on macOS).

## Commands

| Command | Deeplink payload |
|--------|-------------------|
| Start Recording | `start_recording` — `capture_mode` `{ "screen": "…" }` / `{ "window": "…" }`, `mode` `studio` \| `instant`, optional `mic_label`, `camera`, `capture_system_audio` |
| Stop / Pause / Resume / Toggle pause | `stop_recording`, `pause_recording`, `resume_recording`, `toggle_pause_recording` |
| Refresh Device Cache | `refresh_raycast_device_cache` |
| Take Screenshot | `take_screenshot` with `capture_mode` `screen` / `window` (CLI format `screen:Display Name`) |
| Set Microphone | `set_microphone.mic_label` (string or null) |
| Set Camera | `set_camera.camera` = JSON of `device_or_model_id` from cache |

Desktop parsing accepts both `cap-desktop://action?...` (host `action`) and **`cap-desktop:/action?...`** (empty host, path `/action`) — the second shape shows up from some Windows launchers.

On **Windows**, Raycast uses `cmd /c start "" <url>` so the registered `cap-desktop` handler gets the same ShellExecute path as Explorer.

**If the cache file stays empty:** Cap must be **installed** (URL scheme is registered by the installer), running, and check both `%AppData%\so.cap.desktop` and `%AppData%\so.cap.desktop.dev` if you mix prod vs dev builds.

## Bounty PR

Comment `/attempt #1540` on the issue, then open a PR against `CapSoftware/Cap` with `/claim #1540` in the body and a short demo video per Algora rules.
