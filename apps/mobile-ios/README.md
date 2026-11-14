# Cap for iOS

Native iPhone app for Cap, written in Swift and SwiftUI. It targets iOS 26 and uses system components throughout: Liquid Glass, `TabView`, `NavigationStack`, `Form`, `PhotosPicker`, AVKit, Swift Charts and `ASWebAuthenticationSession`. It has no third-party dependencies.

## Layout

- `Cap.xcodeproj` is a minimal project that uses synchronized folders, so files added under `Cap/` are picked up automatically.
- `Cap/` holds the SwiftUI app: `App/` (state, session, library, uploads), `DesignSystem/`, and `Features/` (Auth, Home, Cap, Analytics, Settings).
- `CapKit/` is a Foundation-only Swift package for the API client, models, link parsing, keychain storage, caches, image coding, uploads and usage analytics. It builds and tests on macOS, so `swift test` covers it without a simulator.
- `CapWidgets/` is the Live Activity shown in the Dynamic Island while uploads, imports and recordings finish.
- `CapBroadcast/` is the screen recording extension (ReplayKit broadcast upload).
- `Config/` holds the `Info.plist` files and the entitlements.

## Recording

Camera and screen recordings upload while they're being made, so the link works as soon as recording stops.

- `SegmentWriter` (CapKit) encodes with the hardware H.264 and AAC encoders into separate fragmented MP4 video and audio tracks, cut every two seconds, and writes each piece to disk as the encoder emits it.
- `RecordingUploads` (CapKit) creates the Cap through `/api/mobile/recordings`, fetches upload links a few segments ahead in batches (one small request every ~10 seconds), uploads segments through a background `URLSession` and completes the recording once the last one lands. Each recording is persisted, so a recording cut short by a crash is finished on the next launch with what reached the disk.
- Camera mode (`Cap/Features/Record`) runs `AVCaptureSession` at 1080×1920, 30 fps, about 4 Mbps. The camera can switch mid-recording. It stops and keeps the recording if iOS takes the camera away (Cap moves to the background, a call comes in). The free plan stops at 5 minutes.
- Screen mode starts the system broadcast sheet preset to Cap. The extension reads the app's session from the shared keychain group, records the screen with the microphone (or app audio when the mic is off), uploads as it goes, copies the link when it stops, and leaves a handoff so opening Cap lands on the new recording. Static screens send no frames, so the last one is repeated to keep segments regular.

## Usage analytics

The app records what people do as named events with a few plain values (`recording_started` with `mode: camera`), never titles, links, ids or anything typed. Events go to the Cap server the app is signed in to, at `/api/mobile/events`, which forwards them to its own analytics when that is configured and discards them when it is not. A server that has no such endpoint is asked once per launch.

- `Usage.track` (in `Cap/App/Usage.swift`) is the only call sites need. It stamps the event and returns: about 3.5 microseconds in a debug build.
- `Analytics` (CapKit) sends one request per batch: 30 seconds after the first unsent event, as soon as 20 are waiting, and when the app leaves the screen. Nothing runs while there is nothing to send.
- Events that could not be sent are kept in a file, retried with a growing delay, and dropped after a week or once 500 are waiting. A user's unsent events are dropped when they sign out, and are never sent under another user's session.
- The server only accepts events from a signed-in session and attaches the user from that session, never from what the app claims. A signed-out app sends nothing: events from before sign-in wait on the device and go out with the session of whoever signs in next.
- Debug builds record nothing unless they point at a local server, so development does not show up as usage.

## Develop

Open `Cap.xcodeproj` in Xcode 26 or later and run the `Cap` scheme.

Debug builds talk to `https://cap.so` by default. To use a local Cap web server, set `CAP_API_BASE_URL` in the scheme's environment, for example `http://localhost:3000`. Only Debug builds accept HTTP, and only for localhost, `.local` and private network addresses.

Test CapKit:

```sh
cd CapKit && swift test
```

Build from the command line:

```sh
xcodebuild -project Cap.xcodeproj -scheme Cap -destination "generic/platform=iOS Simulator" build
```

Simulator builds need to be signed, either ad hoc (`CODE_SIGN_IDENTITY=-`) or with a team, because the keychain is unavailable to unsigned apps.

## UI tests

`CapUITests` drives the app on a simulator and saves a screenshot for each step. Debug builds read a few launch environment variables that only work against a local server: `CAP_DEBUG_SESSION=<apiKey>:<userId>` signs in without the email flow, `CAP_DEBUG_SIGNED_OUT=1` starts signed out, and `CAP_DEBUG_ROUTE` opens a screen (`cap:<id>?t=<seconds>&comment=<id>`, `tab:analytics`, `tab:settings`, `settings:organization`, `settings:profile`, `analytics:<id>`). Release builds compile none of this.

- `CapUITests` runs against `Fixtures/server.py`, a fixture API with stress data: very long titles and names, hundreds of comments and reactions, RTL and CJK text, locked, restricted, screenshot and over-limit Caps, and an empty account. Start it with `python3 Fixtures/server.py 4310` (it generates stand-in videos and thumbnails with ffmpeg on first run) and pass its address as `TEST_RUNNER_CAP_FIXTURE_URL`.
- `CapLiveTests` runs against a real local Cap web server (`TEST_RUNNER_CAP_LIVE_URL`): an upload through the real Photos picker, a Loom import, a second account commenting on someone else's Cap, unlocking a password-protected Cap, and a camera recording. It skips unless those variables are set.
- Simulators have no camera. In Debug builds, `CAP_DEBUG_RECORDER_FILE=<path to a portrait video>` plays a file into the recorder in real time instead, which exercises the real encoder, segmenting and upload path (`TEST_RUNNER_CAP_LIVE_RECORDER_FILE` for the UI test). Screen recording only runs on a device.

```sh
xcodebuild test -project Cap.xcodeproj -scheme Cap -destination "platform=iOS Simulator,name=iPhone 17" \
  CODE_SIGN_IDENTITY=- TEST_RUNNER_CAP_FIXTURE_URL=http://localhost:4310 TEST_RUNNER_CAP_SHOT_DIR=/tmp/cap-shots
```

## Security

- The API key lives in the keychain as `WhenUnlockedThisDeviceOnly` and is never synced. It is cleared on sign out, on a 401 from the server, and on the first launch after a reinstall.
- API requests use an ephemeral session with no cookies, no URL cache and no credential storage, and they refuse redirects. The bearer token is only attached to Cap's own origin. Image and transcript requests strip it when a redirect leaves that origin. Playback URLs never carry it.
- Web sign-in uses an ephemeral browser session, so an existing Safari session can't silently pick the account. The `cap://auth` callback is validated strictly.
- Deep links, pasted links and IDs from the server are validated before use, and every path segment is percent-encoded.
- Share passwords are checked by the server, which returns an encrypted unlock token bound to the signed-in user and that one Cap. The app keeps it in memory only and sends it only with requests about that Cap.
- Uploaded profile and organization images are re-encoded on device, which strips location and other metadata.
- Cached library snapshots and thumbnails use data protection, are excluded from backups and are wiped on sign out.
- Release builds enable Enhanced Security (pointer authentication, hardened heap, read-only dyld state and checked allocations).

## Release notes

The bundle identifier is `so.cap.mobile` under team `47B7FCLL43`, matching the App Store record the Expo app was prepared for. Associated Domains are not enabled yet because cap.so does not serve an `apple-app-site-association` file. `cap://s/<id>` links and pasted share links work today.
