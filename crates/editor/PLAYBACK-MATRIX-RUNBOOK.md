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
  --startup-threshold-ms 250 \
  --require-formats mp4,fragmented \
  --scenarios full,scrub \
  --input-dir "$INPUT_DIR"
```

Equivalent shortcut:

```bash
pnpm bench:playback:matrix -- --platform "<platform-label>" --gpu "<gpu-label>" --output-dir "$OUT_DIR" --fps 60 --startup-threshold-ms 250 --require-formats mp4,fragmented --scenarios full,scrub --input-dir "$INPUT_DIR"
```

Rerun only scrub scenario for a machine:

```bash
pnpm bench:playback:matrix -- --platform "<platform-label>" --gpu "<gpu-label>" --output-dir "$OUT_DIR" --fps 60 --scenarios scrub --input-dir "$INPUT_DIR"
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
- `<platform>-<gpu>-validation.json` matrix validation result

## Cross-machine aggregation

After collecting all machine folders into a shared root:

```bash
node scripts/aggregate-playback-benchmarks.js --input /path/to/all-machine-results --output /tmp/playback-matrix-aggregate.md
node scripts/build-playback-matrix-report.js --input /path/to/all-machine-results --output /tmp/playback-matrix-status.md
```

Equivalent shortcut:

```bash
pnpm bench:playback:aggregate -- --input /path/to/all-machine-results --output /tmp/playback-matrix-aggregate.md
pnpm bench:playback:report -- --input /path/to/all-machine-results --output /tmp/playback-matrix-status.md
```

Validate matrix completeness:

```bash
node scripts/validate-playback-matrix.js --input /path/to/all-machine-results --require-formats mp4,fragmented
```

Equivalent shortcut:

```bash
pnpm bench:playback:validate -- --input /path/to/all-machine-results --require-formats mp4,fragmented
```

One-shot finalize command:

```bash
pnpm bench:playback:finalize -- --input /path/to/all-machine-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented
pnpm bench:playback:finalize -- --input /path/to/all-machine-results --output-dir /tmp/playback-matrix-final --output-json /tmp/playback-matrix-final/playback-finalize-summary.json
```

Finalize summary JSON includes artifact paths, gate outcomes, settings, and git branch/commit metadata when available.
When comparison is enabled, finalize summary JSON also includes comparison failure reasons and gate outcome details.

Include optimization thresholds when finalizing:

```bash
pnpm bench:playback:finalize -- --input /path/to/all-machine-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250

# include baseline comparison gate during finalization
pnpm bench:playback:finalize -- --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --allow-fps-drop 2 --allow-startup-increase-ms 25 --allow-scrub-p95-increase-ms 5

# optional: allow missing candidate rows during compare gate
pnpm bench:playback:finalize -- --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --allow-missing-candidate

# optional: fail finalize compare gate when candidate includes rows absent in baseline
pnpm bench:playback:finalize -- --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --fail-on-candidate-only

# optional: require minimum sample count per compared row
pnpm bench:playback:finalize -- --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --min-samples-per-row 3
```

Finalize and publish to benchmark history in one command:

```bash
pnpm bench:playback:finalize -- --input /path/to/all-machine-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250 --publish-target /workspace/crates/editor/PLAYBACK-BENCHMARKS.md
```

Publish finalized artifacts into benchmark history:

```bash
pnpm bench:playback:publish -- \
  --aggregate-md /tmp/playback-matrix-final/playback-benchmark-aggregate.md \
  --status-md /tmp/playback-matrix-final/playback-matrix-status.md \
  --validation-json /tmp/playback-matrix-final/playback-matrix-validation.json \
  --bottlenecks-md /tmp/playback-matrix-final/playback-bottlenecks.md

pnpm bench:playback:publish -- \
  --aggregate-md /tmp/playback-matrix-final/playback-benchmark-aggregate.md \
  --status-md /tmp/playback-matrix-final/playback-matrix-status.md \
  --validation-json /tmp/playback-matrix-final/playback-matrix-validation.json \
  --comparison-md /tmp/playback-matrix-final/playback-comparison.md \
  --comparison-json /tmp/playback-matrix-final/playback-comparison.json \
  --finalize-summary-json /tmp/playback-matrix-final/playback-finalize-summary.json
```

Generate bottleneck analysis for optimization backlog:

```bash
pnpm bench:playback:analyze -- --input /path/to/all-machine-results --output /tmp/playback-matrix-final/playback-bottlenecks.md --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250
pnpm bench:playback:analyze -- --input /path/to/all-machine-results --output /tmp/playback-matrix-final/playback-bottlenecks.md --output-json /tmp/playback-matrix-final/playback-bottlenecks.json --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250
```

Compare candidate run against baseline and fail on regressions:

```bash
pnpm bench:playback:compare -- --baseline /path/to/baseline-results --candidate /path/to/candidate-results --output /tmp/playback-matrix-final/playback-comparison.md --allow-fps-drop 2 --allow-startup-increase-ms 25 --allow-scrub-p95-increase-ms 5

# multiple baseline/candidate directories can be provided
pnpm bench:playback:compare -- --baseline /path/to/baseline-a --baseline /path/to/baseline-b --candidate /path/to/candidate-a --candidate /path/to/candidate-b --output /tmp/playback-matrix-final/playback-comparison.md

# optional: allow missing candidate rows while still checking metric regressions
pnpm bench:playback:compare -- --baseline /path/to/baseline-results --candidate /path/to/candidate-results --allow-missing-candidate

# emit structured JSON alongside markdown for automation
pnpm bench:playback:compare -- --baseline /path/to/baseline-results --candidate /path/to/candidate-results --output /tmp/playback-matrix-final/playback-comparison.md --output-json /tmp/playback-matrix-final/playback-comparison.json

# compare output now includes both missing-candidate rows and candidate-only rows
# optional: fail compare gate when candidate includes rows absent in baseline
pnpm bench:playback:compare -- --baseline /path/to/baseline-results --candidate /path/to/candidate-results --fail-on-candidate-only

# when multiple inputs are provided, comparison output includes baseline/candidate run counts per row
# optional: require minimum sample count per compared row
pnpm bench:playback:compare -- --baseline /path/to/baseline-results --candidate /path/to/candidate-results --min-samples-per-row 3

# comparison JSON includes failureReasons and gateOutcomes for automation
# minimum sample gating uses metrics that are actually comparable for each row
```

## Evidence checklist

1. Confirm all matrix rows exist.
2. Confirm each row has both `full` and `scrub` scenarios.
3. Capture aggregate markdown and raw JSON artifacts.
4. Attach outputs to playback findings update.
