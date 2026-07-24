# Instant Mode performance profiling

These scripts provide a repeatable macOS profiling harness for the local Cap
desktop app. The harness drives the real Instant Mode pipeline with the selected
display or window, camera, and microphone. It measures resource usage across
idle preview, recording startup, active recording, stopping, and post-stop
cleanup, then validates the resulting recording.

The harness is a developer tool. It is not included in the desktop application
or executed by its production runtime.

## Files

| File | Purpose |
|---|---|
| `instant-mode-performance-macos.py` | Orchestrates profiling runs, records phase metrics, and validates recording output |
| `instant-mode-process-sampler.c` | Samples CPU, memory, energy, I/O, wakeups, syscalls, and related process counters |
| `instant-mode-action-macos.swift` | Sends debug actions to the running app and reads its macOS window state |

The Python harness compiles the C and Swift helpers into the selected artifact
directory. Compiled helper binaries are not written to the repository.

## Safety and privacy

Running the harness has real side effects:

- It starts genuine Instant Mode recordings using the local camera and
  microphone unless `--no-camera` is supplied.
- It creates `.cap` projects in the configured development recordings
  directory.
- It uploads recordings through the account and server configured in the
  running local development app.
- It writes local profiling artifacts that can include process names, device
  names, window names, network endpoints, recording paths, and recording logs.

Keep profiling artifacts out of version control and treat them as local
diagnostic data. Use non-sensitive screen content and a development account when
profiling.

The harness only accepts the repository's `target/debug/cap-desktop` process.
Its automation uses debug-only deep-link actions that are excluded from release
builds. It does not require elevated privileges, embed credentials, delete
recordings, or upload profiling artifacts separately.

## Prerequisites

- macOS with Xcode Command Line Tools available through `xcrun`
- The repository's existing debug desktop app and `target/debug/cap` CLI
- Camera, microphone, screen-recording, and Automation permissions for the
  process running the local app
- A camera and microphone available to the local development app

Do not start another desktop development server for the harness. Use the
already-running local app.

## Run a profile

From the repository root:

```bash
python3 scripts/instant-mode-performance-macos.py \
  --label instant-profile \
  --repetitions 3 \
  --recording-seconds 30
```

The default capture target is the primary display. Use `--window-name`,
`--area`, `--camera-id`, or `--mic-name` to choose another target. Run
`python3 scripts/instant-mode-performance-macos.py --help` for the complete
option list.

Use `--prepare-only` to validate prerequisites, identify the selected devices,
and compile the helpers without starting a recording.

## Results

By default, each run creates a timestamped directory under
`/private/tmp/cap-instant-mode-*`. Pass `--artifacts-dir` to choose an explicit
location. The directory contains:

- `prepared.json` with the commit, configuration, and selected devices
- phase-level process and network samples
- `run-*/result.json` with media and lifecycle validation
- `summary.json` with medians and ranges across repetitions

Compare builds with identical targets, phase durations, preview settings, and
repetition counts. Use at least three warmed repetitions and compare the
`recording` aggregates in `summary.json`. Confirm output resolution, frame rate,
audio, frame drops, upload completion, and validation errors before accepting a
performance change.
