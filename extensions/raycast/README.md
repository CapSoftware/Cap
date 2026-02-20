# Cap Raycast Extension

Raycast commands for controlling Cap desktop through deeplinks.

## Commands

- Start Recording
- Stop Recording
- Pause Recording
- Resume Recording
- Switch Microphone
- Switch Camera

Switch commands accept optional arguments.

- `Switch Microphone` argument: microphone label
- `Switch Camera` argument: camera display name, device id, or model id

If no argument is provided, Cap switches to the next available device.

## Development

Install dependencies:

```bash
pnpm install
```

Typecheck extension sources:

```bash
pnpm --dir extensions/raycast typecheck
```
