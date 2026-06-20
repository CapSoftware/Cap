---
name: cap
description: >-
  Record the screen, capture screenshots, and create shareable video links from the command line using
  the Cap CLI. Use when the user wants to record a screen demo or bug repro, capture a screenshot of a
  screen/window, produce a Loom-style shareable video link, or automate/script screen recording. Requires
  the `cap` command to be installed (Cap Desktop, https://cap.so).
---

# Cap CLI

`cap` is a command-line screen recorder built to be driven by agents. Every command takes `--json` for
machine-readable output on stdout; stderr stays human-readable; failures exit non-zero and, in `--json`
mode, print a final object/event with an `error` field.

**`cap guide --json` is the authoritative contract** (output convention, env vars, exit codes, and every
command's output mode + event tags). Prefer it over guessing, and `cap <command> --help` for flags.

## First: check it's available

```sh
cap doctor --json
```

- If `cap` is not found, it isn't installed. Tell the user to install Cap Desktop from
  https://cap.so/download, then enable the CLI (Settings → Command Line), or run
  `curl -fsSL https://cap.so/install-cli.sh | sh` (Windows: `irm https://cap.so/install-cli.ps1 | iex`).
- Read `captureReady` and `permissions.screenRecording` from the output. On macOS, recording fails until
  Screen Recording permission is granted in System Settings.

## Discover capture targets

```sh
cap targets --json     # screens, windows, cameras, mics
```

Use a screen's `id` (or a window's `id`) for `--screen`/`--window`, a camera's `deviceId` for `--camera`,
and a mic's `name` for `--mic`.

## Record (background lifecycle — the usual agent pattern)

When you don't know the duration in advance: start detached, do the work, then stop.

```sh
cap record start --screen <id> --json --detach   # -> {"type":"started","recordingId","pid","path"}
# ... perform the actions to capture ...
cap record stop --id <recordingId> --json        # -> {"type":"stopped","path","recordingMetaExists":true}
cap record status --json                          # list active sessions
```

A `stopped` event is only a complete recording when `recordingMetaExists` is `true`.

Fixed-length alternative (no detach): `cap record start --screen <id> --duration 10 --json`.

## Screenshot

```sh
cap screenshot --screen <id> --path shot.png --json   # -> {"path","width","height"}
```

## Export and share

```sh
cap project validate <path.cap> --json        # confirm the recording is complete
cap export <path.cap> --output out.mp4 --json # render (here --format means container: mp4|gif|mov)
cap upload out.mp4 --json                      # -> {"type":"uploaded","id","link"}
```

`cap upload` authenticates automatically by reusing the user's Cap Desktop login — check with
`cap auth status --json`. If it reports `authenticated:false`, tell the user to sign into Cap Desktop,
or set `CAP_API_KEY` (a Cap auth key from Settings) for headless use. `cap upload <path.cap> --export
--json` exports then uploads in one step.

## Automations

Automations are `trigger -> (conditions) -> actions` rules authored in Cap Desktop (Settings →
Automations) and shared with the CLI. After `cap screenshot`, a `cap record` finish, and `cap upload`,
the CLI evaluates the matching rules and runs their actions (save to a folder, run a command, send a
webhook, export, etc.).

```sh
cap automations list --json   # the rules the CLI will honor
```

Desktop-only actions (copy to clipboard, OCR, notifications, open editor) are skipped on the CLI; all
others run. `cap doctor --json` reports the configured rule count under `automations`.

## Conventions to rely on

- Add `--json` to any command; it overrides each command's `--format`.
- Detect failure with a single check: the process exits non-zero and the JSON carries an `error` field.
- `record` and `export` stream newline-delimited JSON (NDJSON) events; everything else returns one object.
- `doctor`, `project validate`, and `recordings list` are reports — branch on their fields
  (`ok`/`captureReady`, `valid`), not just the exit code.
