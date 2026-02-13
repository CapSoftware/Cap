# Playback Matrix Runbook

This runbook defines how to collect benchmark evidence for desktop playback performance and sync validation across required hardware classes.

## Target matrix

| Platform | GPU class | Required scenarios |
|---|---|---|
| macOS 13+ | Apple Silicon | full, scrub |
| Windows 11 | NVIDIA discrete | full, scrub |
| Windows 11 | AMD discrete | full, scrub |
| Windows 11 | Integrated baseline | full, scrub |

## Preconditions

1. Build can run on target machine.
2. Real-device recording outputs are available.
3. Recordings include both MP4 and fragmented samples.
4. Node and Rust toolchains are installed.

## Inputs and output directories

Set these per machine:

- `INPUT_DIR`: recording root (default `/tmp/cap-real-device-tests`)
- `OUT_DIR`: machine-local output folder for JSON and aggregate markdown

Example:

```bash
export INPUT_DIR="/tmp/cap-real-device-tests"
export OUT_DIR="/tmp/cap-playback-matrix/macos-apple-silicon"
mkdir -p "$OUT_DIR"
```

## Machine run command

Run this once per platform/GPU class:

```bash
node scripts/run-playback-benchmark-matrix.js \
  --platform "<platform-label>" \
  --gpu "<gpu-label>" \
  --output-dir "$OUT_DIR" \
  --fps 60 \
  --require-formats mp4,fragmented \
  --input-dir "$INPUT_DIR"
```

Equivalent shortcut:

```bash
pnpm bench:playback:matrix -- --platform "<platform-label>" --gpu "<gpu-label>" --output-dir "$OUT_DIR" --fps 60 --require-formats mp4,fragmented --input-dir "$INPUT_DIR"
```

Examples:

```bash
node scripts/run-playback-benchmark-matrix.js --platform macos-13 --gpu apple-silicon --output-dir /tmp/cap-playback-matrix/macos-apple-silicon --fps 60 --input-dir /tmp/cap-real-device-tests
node scripts/run-playback-benchmark-matrix.js --platform windows-11 --gpu nvidia-discrete --output-dir C:\temp\cap-playback-matrix\windows-nvidia --fps 60 --input-dir C:\temp\cap-real-device-tests
node scripts/run-playback-benchmark-matrix.js --platform windows-11 --gpu amd-discrete --output-dir C:\temp\cap-playback-matrix\windows-amd --fps 60 --input-dir C:\temp\cap-real-device-tests
node scripts/run-playback-benchmark-matrix.js --platform windows-11 --gpu integrated --output-dir C:\temp\cap-playback-matrix\windows-integrated --fps 60 --input-dir C:\temp\cap-real-device-tests
```

## Outputs produced per machine

Each run directory contains:

- timestamped `full` scenario JSON
- timestamped `scrub` scenario JSON
- `<platform>-<gpu>-aggregate.md` summary table

## Cross-machine aggregation

After collecting all machine folders into a shared root:

```bash
node scripts/aggregate-playback-benchmarks.js --input /path/to/all-machine-results --output /tmp/playback-matrix-aggregate.md
```

Equivalent shortcut:

```bash
pnpm bench:playback:aggregate -- --input /path/to/all-machine-results --output /tmp/playback-matrix-aggregate.md
```

Validate matrix completeness:

```bash
node scripts/validate-playback-matrix.js --input /path/to/all-machine-results --require-formats mp4,fragmented
```

Equivalent shortcut:

```bash
pnpm bench:playback:validate -- --input /path/to/all-machine-results --require-formats mp4,fragmented
```

## Evidence checklist

1. Confirm all matrix rows exist.
2. Confirm each row has both `full` and `scrub` scenarios.
3. Capture aggregate markdown and raw JSON artifacts.
4. Attach outputs to playback findings update.
