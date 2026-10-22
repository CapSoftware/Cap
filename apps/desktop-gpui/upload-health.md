# Upload diagnostics

The signed-in GPUI app checks its upload path at startup and at most once an hour
while idle. The header indicator can request a manual check, with a one-minute
cooldown. Signing out or changing the server invalidates the account-bound result;
saving/deleting S3 settings or connecting, disconnecting, or switching Google Drive
also invalidates it. Checks do not block recording when diagnostics are unavailable.

## Measurement and resolution

The client reuses one HTTP client, warms the authenticated connection with a GET,
then sends two 2 MiB binary samples. The server measures the interval between the
first and last nonempty body chunks. Authentication, cold start, storage access,
and object cleanup are outside that interval. A proxy that buffers an entire
sample can produce an inconclusive result; that result preserves the configured
resolution.

A cap requires two valid samples, both lasting at least 500 ms, whose rates differ
by no more than a factor of two. The faster sample selects the maximum width:

| Transfer rate | Maximum width |
| --- | --- |
| Below 5 Mbps | 1280 (720p) |
| 5 to below 10 Mbps | 1920 (1080p) |
| 10 to below 20 Mbps | 2560 (1440p) |
| At least 20 Mbps, inconsistent or inconclusive | Configured resolution |

The effective width is the minimum of this cap and the existing plan/user limit.
Saved settings and Studio recordings are unchanged. A measurement expires after
15 minutes, including time spent asleep; a backwards wall-clock change invalidates
it. The header and Quality settings show an active cap. Once recording starts,
the applied-cap indicator stays visible for that recording even if the measurement
expires.

Recording admission cancels the active probe and invalidates its generation.
Engine startup waits for the probe future to be dropped before continuing; late
results cannot update the measurement or start another probe during recording.

## Storage check and bounds

Only the first sample checks storage. After validating current organization
membership, it resolves the same writable storage access used for recordings
(organization/personal S3, Google Drive, or default storage). It writes at most
1 KiB of synthetic data under `<user-id>/.cap-upload-health/<uuid>` and attempts
cleanup even when writing fails. Write failures make the check unavailable;
cleanup failures are logged and do not turn a successful upload into a failure.
The check verifies storage write access, not screen capture or encoder correctness.

Body input is streamed with an 8 MiB limit; the reader retains only the small
storage sample. Storage writes time out after ten seconds, cleanup after three,
and the request after 25 seconds. A check transfers 4 MiB in total. The process
limiter allows four POSTs per authenticated user per minute and retains at most
1024 rate-limit entries. For a distributed deployment, configure the existing
Vercel Firewall integration's `rl_desktop_upload_health` rule with the desired
per-user limit; the process limit alone is not a distributed quota.

## Verification

Native Linux UI captures use an isolated profile and synthetic API responses;
they demonstrate rendering, not measured network performance or a real recording:

- [Slow upload with a visible 720p cap](docs/upload-health-slow-linux.png)
- [Fast upload without a cap](docs/upload-health-fast-linux.png)
- [Failed upload check](docs/upload-health-failed-linux.png)

```sh
bun run --cwd apps/web test __tests__/unit/upload-health.test.ts __tests__/unit/upload-health-route.test.ts
./scripts/prepare-gpui-dependency.sh
# Run scripts/setup.js with the same target/native dependencies as desktop CI.
cd apps/desktop-gpui
cargo check --locked -p cap-desktop-gpui
cargo test --locked -p cap-desktop-gpui --bin cap-gpui network_health
```

Manual desktop checks before acceptance:

1. On macOS and Windows, sign in and capture the header and Quality settings with
   a successful probe and an applied cap. Confirm the app layout still fits.
2. Compare a fast connection with added RTT against a genuinely throttled upload.
   A single slow sample or an inconclusive/buffered sample must not lower quality.
3. Start recording during the first POST, during storage processing, and between
   samples. Confirm no later sample starts and recording proceeds after cancellation.
4. Change account, server and selected storage; the old result must not be applied.
5. Make the selected storage unwritable while keeping the app API reachable. The
   indicator must report the failed check; merely reaching the app is insufficient.
6. Deny deletion after allowing writes. The upload check stays successful and
   cleanup is logged. Operators can remove residual objects under the probe prefix.
7. Check an older self-hosted server without this endpoint: diagnostics are
   unavailable and the configured recording resolution is preserved.
