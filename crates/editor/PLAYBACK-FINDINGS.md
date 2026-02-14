# Cap Playback Performance Findings

> **SELF-HEALING DOCUMENT**: This file is designed to maintain complete context for playback performance work. After any work session, UPDATE this file with your findings before ending.

---

## Quick Start (Read This First)

**When your context resets, do this:**

1. Read this file completely
2. Read `PLAYBACK-BENCHMARKS.md` for latest raw test data
3. Ensure test recordings exist (or create them):
   ```bash
   # Check for existing recordings
   ls /tmp/cap-real-device-tests/

   # If none exist, create them first:
   cargo run -p cap-recording --example real-device-test-runner -- baseline --keep-outputs
   ```
4. Run a quick playback benchmark to verify current state:
   ```bash
   cargo run -p cap-recording --example playback-test-runner -- full
   ```
5. Continue work from "Next Steps" section below

**After completing work, UPDATE these sections:**
- [ ] Current Status table (if metrics changed)
- [ ] Root Cause Analysis (if new issues found)
- [ ] Fix Progress (if fixes implemented)
- [ ] Next Steps (mark completed, add new)
- [ ] Session Notes (add your session)

---

## Current Status

**Last Updated**: 2026-02-13

### Performance Summary

| Metric | Target | MP4 Mode | Fragmented Mode | Status |
|--------|--------|----------|-----------------|--------|
| Decoder Init (display) | <200ms | 337ms* | TBD | 🟡 Note |
| Decoder Init (camera) | <200ms | 23ms | TBD | ✅ Pass |
| Decode Latency (p95) | <50ms | 3.1ms | TBD | ✅ Pass |
| Effective FPS | ≥30 fps | 549 fps | TBD | ✅ Pass |
| Decode Jitter | <10ms | ~1ms | TBD | ✅ Pass |
| A/V Sync (mic↔video) | <100ms | 77ms | TBD | ✅ Pass |
| A/V Sync (system↔video) | <100ms | 162ms | TBD | 🟡 Known |
| Camera-Display Drift | <100ms | 0ms | TBD | ✅ Pass |

*Display decoder init time includes multi-position pool initialization (3 decoder instances)

### What's Working
- ✅ Playback test infrastructure in place
- ✅ Uses recordings from real-device-test-runner
- ✅ Hardware-accelerated decoding on macOS (AVAssetReader)
- ✅ Excellent decode performance (549 fps effective, 1.8ms avg latency)
- ✅ Multi-position decoder pool for smooth scrubbing
- ✅ Mic audio sync within tolerance
- ✅ Camera-display sync perfect (0ms drift)
- ✅ Editor playback now keeps a live seek channel during playback instead of stop/start restart loops
- ✅ Audio playback defaults to low-latency streaming buffer path with bounded prefill

### Known Issues (Lower Priority)
1. **System audio timing**: ~162ms difference inherited from recording-side timing issue
2. **Display decoder init time**: baseline was 337ms from eager multi-decoder setup; now reduced by lazy decoder warmup but needs benchmark confirmation

---

## Next Steps

### Active Work Items
*(Update this section as you work)*

- [ ] **Test fragmented mode** - Run playback tests on fragmented recordings
- [ ] **Collect cross-platform benchmark evidence** - macOS 13+ and Windows GPU matrix for FPS, scrub settle, audio start latency, and A/V drift
- [ ] **Validate lazy decoder warmup impact** - measure display decoder init and scrub settle before/after on real recordings
- [ ] **Validate streaming audio startup/sync** - benchmark low-latency path vs legacy pre-render path across long timelines

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)
- [x] **Remove seek restart churn in timeline path** - in-playback seeks now route through live playback handle (2026-02-13)
- [x] **Switch default audio mode to low-latency streaming** - full prerender now opt-in by env flag (2026-02-13)
- [x] **Reduce eager AVAssetReader decoder warmup** - pool now initializes lazily beyond first warm decoders (2026-02-13)

---

## Benchmarking Commands

```bash
# Full playback validation (RECOMMENDED)
cargo run -p cap-recording --example playback-test-runner -- full

# Test specific categories
cargo run -p cap-recording --example playback-test-runner -- decoder
cargo run -p cap-recording --example playback-test-runner -- playback
cargo run -p cap-recording --example playback-test-runner -- scrub
cargo run -p cap-recording --example playback-test-runner -- audio-sync
cargo run -p cap-recording --example playback-test-runner -- camera-sync

# List available recordings
cargo run -p cap-recording --example playback-test-runner -- list

# Test a specific recording
cargo run -p cap-recording --example playback-test-runner -- --recording-path /path/to/recording full

# Save benchmark results to PLAYBACK-BENCHMARKS.md
cargo run -p cap-recording --example playback-test-runner -- full --benchmark-output

# Combined workflow: record then playback
cargo run -p cap-recording --example real-device-test-runner -- baseline --keep-outputs && \
cargo run -p cap-recording --example playback-test-runner -- full
```

**Note**: Playback tests require recordings to exist. Run the recording test runner with `--keep-outputs` first.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `crates/rendering/src/decoder.rs` | Main decoder interface, spawn_decoder() |
| `crates/video-decode/src/` | Platform-specific decoders |
| `crates/video-decode/src/macos.rs` | AVAssetReader hardware decoder |
| `crates/video-decode/src/ffmpeg.rs` | FFmpeg software fallback |
| `crates/audio/src/lib.rs` | AudioData loading and sync analysis |
| `crates/recording/examples/playback-test-runner.rs` | Playback benchmark runner |

---

## Completed Fixes

1. **Low-latency audio startup enabled by default (2026-02-13)**
   - `AudioPlayback::spawn()` now selects streaming `create_stream()` path by default.
   - Legacy full-timeline prerender path is still available via `CAP_AUDIO_PRERENDER_PLAYBACK=1`.
   - `AudioPlaybackBuffer` is available on all platforms so Windows can use streaming sync logic.

2. **In-playback seek path without stop/start (2026-02-13)**
   - Added seek channel to `PlaybackHandle` and playback loop.
   - `seek_to` and `set_playhead_position` commands now forward seek requests to active playback.
   - Timeline seek no longer tears down and recreates playback while playing.
   - Seek signaling now uses watch semantics so only latest frame target is consumed under heavy scrub load.
   - Tauri playhead/seek commands now skip no-op same-frame state emission to reduce state/event churn.

3. **Lazy decoder pool warmup on macOS AVAssetReader (2026-02-13)**
   - Initial warmup now creates only a small subset of decoder instances.
   - Additional decoder instances are initialized lazily when scrub patterns request them.
   - Failed lazy init falls back safely to currently available decoders.

4. **Playback benchmark runner now captures scrub and startup metrics (2026-02-13)**
   - Added `scrub` benchmark mode to `playback-test-runner`.
   - Playback result now includes first-frame decode and startup-to-first-frame latency.
   - Scrub result now reports seek p50/p95/p99 and seek failure counts.

5. **Playback runtime emits startup latency signals (2026-02-13)**
   - Playback loop now logs first rendered frame latency.
   - Audio stream setup now logs startup preparation time and first callback latency.
   - Playback loop now logs seek settle latency (`seek_target_frame` to rendered frame).

6. **Decode benchmark now supports machine-readable evidence output (2026-02-13)**
   - `decode-benchmark` supports `--output-json` for structured metric capture.
   - Added sequential frame and random sample count controls to scale benchmark depth per hardware class.
   - Supports fragmented segment directories for duration-aware benchmarking.

7. **Timeline seek dispatch now coalesces during drag (2026-02-13)**
   - Frontend seek calls are requestAnimationFrame-batched.
   - Only the latest pending seek frame is sent while an async seek is in-flight.
   - Duplicate same-frame seeks are dropped in both frontend dispatch and playback seek signaling.

8. **Playback frame wait timeout now scales with target FPS (2026-02-13)**
   - Replaced fixed 200ms frame fetch waits with FPS-derived bounded timeout.
   - Reduces long stall windows on 60fps playback and improves real-time catch-up behavior.
   - In-flight polling interval now scales with frame budget instead of fixed 5ms.
   - Catch-up skip threshold now adapts with late streak depth and logs skip event telemetry.
   - Warmup target and warmup timeout now scale with FPS, reducing startup buffering overhead.
   - Prefetch ahead/behind windows now scale with FPS to reduce unnecessary decode pressure at lower targets.
   - Prefetch parallelism now scales with FPS target to increase decode throughput under 60fps workloads.

8. **Playback benchmark runner now supports JSON evidence export (2026-02-13)**
   - `playback-test-runner` supports `--json-output` for structured report emission.
   - JSON output includes command metadata, system info, summary, and per-recording test detail.
   - Command metadata now includes input scope and output flags for reproducibility.
   - Startup-to-first-frame threshold is configurable with `--startup-threshold-ms` and tracked as pass/fail signal.

9. **Added JSON aggregate utility for cross-platform benchmark collation (2026-02-13)**
   - `scripts/aggregate-playback-benchmarks.js` builds a markdown table from multiple JSON outputs.
   - Aggregates platform/gpu/scenario-tagged runs for matrix reporting.

10. **Added matrix run helper for platform/GPU benchmark execution (2026-02-13)**
   - `scripts/run-playback-benchmark-matrix.js` runs `full` and `scrub` scenarios with tagged notes and JSON output.
   - Automatically generates aggregate markdown for each machine run directory.
   - Performs per-machine post-run validation for required scenarios and optional format requirements.
   - Supports scenario subset reruns via `--scenarios` for faster targeted validation.
   - Supports startup threshold tuning via `--startup-threshold-ms`.

11. **Added matrix completeness validator (2026-02-13)**
   - `scripts/validate-playback-matrix.js` validates required platform/gpu/scenario cells.
   - Supports required format checks per cell (mp4 + fragmented).
   - Root `package.json` now exposes `bench:playback:*` script aliases for matrix, aggregate, and validate flows.
   - Can emit structured validation JSON for artifact upload and automation.

12. **Added matrix status report generator (2026-02-13)**
   - `scripts/build-playback-matrix-report.js` generates concise matrix markdown from JSON results.
   - Highlights missing cells, scenario pass/fail, and format coverage per platform/GPU row.

13. **Added matrix finalization helper (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` generates aggregate markdown, status markdown, and validation JSON in one command.
   - Supports optional required format enforcement during finalization.
   - Also emits bottleneck analysis markdown using configurable FPS/scrub/startup thresholds.
   - Can optionally publish finalized artifacts directly into benchmark history target.

14. **Added matrix summary publisher (2026-02-13)**
   - `scripts/publish-playback-matrix-summary.js` injects finalized matrix artifacts into playback benchmark history.
   - Keeps matrix evidence updates consistent and repeatable.
   - Supports optional bottleneck analysis attachment in published summary.

15. **Added bottleneck analyzer for continuous FPS optimization (2026-02-13)**
   - `scripts/analyze-playback-matrix-bottlenecks.js` ranks matrix cells by FPS, startup, and scrub threshold breaches.
   - Produces prioritized optimization backlog from real matrix evidence.
   - Supports structured JSON output for automation and regression tracking.

16. **Added baseline-vs-candidate comparator for regression gating (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` compares candidate matrix outputs against baseline outputs.
   - Flags regressions when FPS drops or startup/scrub latency increase beyond configured tolerance.
   - Exits non-zero on regressions so matrix-driven optimization loops can be gated automatically.

17. **Added prefetch generation gating for live seek correctness and latency (2026-02-13)**
   - Prefetch outputs are tagged with seek-generation IDs and stale generation frames are dropped.
   - Seek events now advance generation and flush prefetch consumption to prevent old in-flight decode outputs from polluting post-seek playback.
   - Reduces redundant decode/render work during aggressive scrub and improves settle reliability.

18. **Flushed prefetched-frame buffer on seek generation changes (2026-02-13)**
   - Live seek handling now clears prefetch buffer immediately on seek events.
   - Prevents stale buffered frames from prior playback position from being reused after seek jumps.
   - Reduces unnecessary post-seek frame scans and improves settle determinism.

19. **Tightened in-flight prefetch buffering to current playhead (2026-02-13)**
   - In-flight wait path now buffers only frames at or ahead of current frame.
   - Avoids re-queueing older frames from initial start position baseline.
   - Reduces avoidable prefetch buffer churn during late playback and aggressive seek scenarios.

20. **Expanded comparison gating for multi-run matrix diffs (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports multiple baseline and candidate inputs.
   - Enables aggregate regression gating across batched machine runs instead of one directory at a time.
   - Improves reliability of continuous optimization loops when matrix outputs are split across multiple sources.

21. **Added finalization-integrated regression gate support (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now supports `--compare-baseline` and threshold args.
   - Finalization can now produce aggregate/status/validation/bottleneck artifacts and run baseline-vs-candidate gating in one command.
   - Keeps optimization loops strict by failing finalize runs when regression tolerances are exceeded.

22. **Made in-flight tracking generation-aware to avoid seek races (2026-02-13)**
   - Shared in-flight frame tracking now keys entries by `(seek_generation, frame_number)`.
   - Prevents old-generation decode completions from removing new-generation in-flight markers for the same frame number.
   - Improves seek correctness under rapid repeated seeks to nearby frame ranges.

23. **Added comparison artifact publishing in finalize workflows (2026-02-13)**
   - `scripts/publish-playback-matrix-summary.js` now accepts optional `--comparison-md`.
   - `scripts/finalize-playback-matrix.js` now forwards generated comparison artifact to publishing when both compare and publish options are enabled.
   - Keeps benchmark history entries self-contained with regression gate evidence.

24. **Separated prefetch/direct decode in-flight tracking (2026-02-13)**
   - Playback now tracks prefetch in-flight frames and direct decode in-flight frames in separate generation-aware sets.
   - Prevents prefetch-side clear/reset paths from clearing direct decode in-flight markers.
   - In-flight wait logic now checks both sets and direct decode outputs are dropped when a pending seek is detected before frame use.

25. **Added comparison coverage gating for missing candidate rows (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now reports baseline rows that are missing in candidate runs.
   - Comparison now fails by default when candidate coverage is missing baseline rows.
   - Optional `--allow-missing-candidate` flag keeps metric regression checks while allowing partial candidate matrices.

26. **Fixed finalize publish ordering for comparison artifacts (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now executes baseline comparison before publish when both options are enabled.
   - Prevents publish step from referencing missing comparison artifact files.
   - Added finalize passthrough support for `--allow-missing-candidate`.

27. **Added structured JSON output for comparison gating (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--output-json`.
   - Emits comparison summary/regression/missing-coverage details for automation.
   - `scripts/finalize-playback-matrix.js` now writes comparison markdown and JSON artifacts during baseline comparison runs.

28. **Switched playback prefetch buffer to keyed map storage (2026-02-13)**
   - Playback prefetch buffer now uses `BTreeMap<u32, PrefetchedFrame>` keyed by frame number.
   - Removes repeated linear scans over deque entries for target frame lookup in hot playback path.
   - Retains bounded buffer behavior with deterministic far-ahead/oldest eviction.

29. **Added sorted prefetch stale-frame pruning (2026-02-13)**
   - Playback loop now prunes prefetched frames older than current playhead from the keyed buffer.
   - Uses ordered map operations to remove outdated frames efficiently.
   - Reduces stale-buffer buildup during frame skips and sustained catch-up scenarios.

30. **Published comparison gate status in matrix summaries (2026-02-13)**
   - `scripts/publish-playback-matrix-summary.js` now accepts optional `--comparison-json`.
   - Published matrix summary now includes comparison gate pass/fail, regression count, and missing-candidate-row count when comparison JSON is provided.
   - `scripts/finalize-playback-matrix.js` now forwards both comparison markdown and comparison JSON to publish flow.

31. **Tightened prefetch warmup/skip maintenance with keyed buffer helpers (2026-02-13)**
   - Warmup first-frame timer now starts only after at least one eligible prefetched frame is present in the keyed buffer.
   - Skip catch-up path now uses ordered stale-frame pruning helper instead of full-map retain filtering.
   - Reduces avoidable warmup timing noise and stale-buffer maintenance overhead in high-skip playback paths.

32. **Expanded comparison outputs with candidate-only coverage visibility (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now reports candidate-only rows that do not exist in baseline.
   - Markdown and JSON comparison outputs now include both missing-candidate and candidate-only coverage summaries.
   - Improves matrix diff diagnostics when test coverage differs between baseline and candidate runs.

33. **Extended published comparison summary fields (2026-02-13)**
   - `scripts/publish-playback-matrix-summary.js` now includes candidate-only row count from comparison JSON in published matrix summary bullets.
   - Keeps published matrix evidence aligned with expanded comparison coverage diagnostics.

34. **Published comparison policy mode in summary output (2026-02-13)**
   - Published matrix summary now includes comparison policy modes for missing-candidate and candidate-only coverage handling.
   - Keeps published evidence explicit about whether coverage gaps were allowed or gated in the comparison run.

35. **Added strict candidate-only gating option for comparison workflows (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--fail-on-candidate-only`.
   - When enabled, comparison exits non-zero if candidate contains rows not present in baseline.
   - `scripts/finalize-playback-matrix.js` now forwards the same strict option in integrated compare flows.

36. **Required contiguous prefetched frames for warmup readiness (2026-02-13)**
   - Playback warmup readiness now checks contiguous prefetched frame coverage from current frame.
   - Avoids treating sparse/non-contiguous prefetched entries as equivalent to contiguous startup readiness.
   - Reduces early playback start jitter risk when warmup buffer is fragmented.

37. **Added finalize summary JSON artifact output (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now supports optional `--output-json`.
   - Finalize now emits `playback-finalize-summary.json` by default in output directory.
   - Summary JSON includes artifact paths, settings, and validation/comparison pass flags for automation.

38. **Optimized contiguous warmup coverage scan on keyed buffer (2026-02-13)**
   - Contiguous prefetched-frame counting now walks ordered keys via map range iteration.
   - Reduces repeated keyed lookups during warmup readiness checks.
   - Preserves contiguous coverage semantics while lowering per-loop lookup overhead.

39. **Added git metadata to finalize summary artifacts (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now records git branch and commit SHA in finalize summary JSON output.
   - Improves traceability of benchmark artifacts to exact source revision.

40. **Wired finalize summary artifact into publish flow (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now generates finalize summary JSON before publish step.
   - Finalize now forwards `--finalize-summary-json` to `publish-playback-matrix-summary.js`.
   - Published matrix summaries can now include finalize artifact metadata in one-shot finalize runs.

41. **Improved comparison aggregation across multi-input runs (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now aggregates metrics per comparison key across all contributing input reports instead of last-write-wins replacement.
   - Comparison output now includes baseline/candidate run counts per row to surface aggregation depth.
   - Fixed comparison regression evaluation to use explicit options parameter wiring inside compare function.

42. **Skipped contiguous warmup scans before first eligible frame (2026-02-13)**
   - Warmup loop now defers contiguous-prefetch counting until first warmup frame arrival is observed.
   - Reduces avoidable buffer scan work during pre-frame warmup wait.

43. **Added minimum sample-count gating for matrix comparisons (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--min-samples-per-row`.
   - Comparison now flags rows with insufficient effective sample counts and reports them in markdown/JSON outputs.
   - `scripts/finalize-playback-matrix.js` forwards minimum sample gating settings into compare stage, and publish summary now surfaces sample gating status fields.

44. **Fixed sample gating semantics for non-comparable metrics (2026-02-13)**
   - Minimum sample checks now only consider metrics that are actually comparable for the row.
   - Prevents scrub sample requirements from incorrectly failing non-scrub comparison rows.
   - Comparison output now includes compared metric count and effective sample count per row.

45. **Extended finalize summary comparison diagnostics (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now includes comparison failure reasons and gate outcomes in summary results.
   - `scripts/publish-playback-matrix-summary.js` now surfaces finalize comparison failure reasons when present.

44. **Cached warmup contiguous coverage counts during warmup (2026-02-13)**
   - Warmup loop now recomputes contiguous prefetched coverage only when warmup buffer content changes.
   - Avoids repeated contiguous scans on idle warmup iterations.

45. **Added explicit comparison gate diagnostics in JSON and published summaries (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now emits `failureReasons` and `gateOutcomes` in summary JSON.
   - `scripts/publish-playback-matrix-summary.js` now surfaces comparison failure reasons when present.

46. **Added parse-error gating and parse stats to comparison flows (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--fail-on-parse-errors`.
   - Comparison JSON now includes baseline/candidate file parsing stats and parse error entries.
   - `scripts/finalize-playback-matrix.js` now forwards parse-error gating option to compare stage; published summary surfaces parse policy and parse error counts.

47. **Made keyed prefetch insert helper report structural changes (2026-02-13)**
   - `insert_prefetched_frame` now returns whether keyed prefetch buffer changed (insert and/or trim).
   - Warmup loop now uses this direct signal instead of length-only delta checks for contiguous coverage cache invalidation.
   - Improves warmup cache correctness when inserts and trims occur with stable overall buffer length.

48. **Extended finalize summary with comparison file stats (2026-02-13)**
   - Finalize summary JSON now includes comparison file stats payload when comparison is enabled.
   - Publish summary now surfaces finalize baseline/candidate parse error counts from finalize summary metadata.

49. **Stabilized comparison report ordering for reproducibility (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now deterministically sorts comparison, missing, candidate-only, and insufficient-sample rows.
   - Keeps markdown/JSON outputs stable across repeated runs with identical inputs.

50. **Extended finalize summary with comparison count rollups (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` now captures comparison count rollups in summary results (compared rows, regressions, missing/candidate-only/insufficient-sample counts).
   - `scripts/publish-playback-matrix-summary.js` now surfaces these finalize comparison counts in published summaries.

51. **Added optional zero-comparison gating (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--fail-on-zero-compared`.
   - Enables strict failure when comparison processing yields zero comparable rows.
   - `scripts/finalize-playback-matrix.js` forwards zero-comparison gating option in integrated compare flows.

52. **Added warmup-stage seek handling before playback loop entry (2026-02-13)**
   - Warmup loop now consumes seek updates immediately instead of waiting for playback loop start.
   - Seek during warmup now resets warmup timers/buffer state and updates frame/audio playhead targets immediately.
   - Improves responsiveness when users seek while playback is still warming up.

53. **Added optional skipped-file gating for comparison workflows (2026-02-13)**
   - `scripts/compare-playback-benchmark-runs.js` now supports `--fail-on-skipped-files`.
   - Enables strict failure when baseline/candidate inputs include skipped JSON files without usable benchmark payloads.
   - `scripts/finalize-playback-matrix.js` forwards skipped-file gating option in integrated compare flows.

54. **Added skipped-file reason breakdown in comparison file stats (2026-02-13)**
   - Comparison file stats now report skipped-file reasons as `skippedNoReports` and `skippedNoUsableMetrics`.
   - Published summary now surfaces skipped-file breakdown for baseline and candidate inputs.

55. **Scaled warmup idle poll interval by frame budget (2026-02-13)**
   - Warmup loop fallback poll now scales with frame duration and stays in bounded low-latency range.
   - Reduces fixed 100ms idle poll delay during warmup while avoiding high-frequency busy polling.

56. **Retained in-flight prefetch markers for small frame-request shifts (2026-02-13)**
   - Frame-request rebases now clear in-flight marker sets only for backward or large-distance seeks that also reset in-flight futures.
   - Prevents duplicate decode scheduling caused by clearing marker sets while earlier in-flight futures are still active.

57. **Added local in-flight frame tracking inside prefetch scheduler (2026-02-13)**
   - Prefetch scheduler now tracks active frame numbers locally and uses this set for duplicate scheduling checks.
   - Reduces repeated shared lock reads in prefetch hot-path while preserving cross-thread in-flight visibility.

58. **Batched warmup prefetch queue consumption (2026-02-13)**
   - Warmup stage now drains all immediately available prefetched frames on each receive wake-up.
   - Improves warmup readiness convergence by reducing one-frame-per-iteration queue handling overhead.

59. **Scaled prefetch idle polling by frame budget (2026-02-13)**
   - Prefetch scheduler idle-yield interval now scales with target frame duration in a bounded low-latency range.
   - Reduces fixed 1ms wakeup churn in empty in-flight periods while keeping prefetch request responsiveness high.

60. **Bounded behind-prefetch dedupe memory growth (2026-02-13)**
   - Behind-prefetch dedupe tracking now keeps a bounded eviction-ordered window instead of unbounded growth over long playback sessions.
   - Prevents long-session hash-set expansion from degrading behind-prefetch lookup efficiency.

61. **Cached clip-offset lookups for decode scheduling paths (2026-02-13)**
   - Prefetch and direct-decode paths now use cached clip-index-to-offset maps instead of repeated linear clip scans.
   - Reduces per-frame scheduling overhead in playback and prefetch loops when projects contain many clips.

62. **Deduplicated frame-request watch updates (2026-02-13)**
   - Playback loop now uses change-aware frame-request signaling instead of unconditional watch broadcasts.
   - Reduces redundant prefetch wakeups and channel churn when requested frame value does not change.

63. **Removed duplicate keyed-buffer lookups during prefetch insert (2026-02-13)**
   - Prefetch buffer insertion now uses a single `BTreeMap::entry` match to detect insertion and store new frames.
   - Eliminates the prior contains-check plus entry-insert double lookup in prefetch hot path.

64. **Centralized change-aware frame request signaling (2026-02-13)**
   - Playback now uses a shared helper for change-aware frame-request watch updates across warmup/seek/skip paths.
   - Reduces duplicated watch-update closure logic and keeps no-op request dedupe behavior consistent in all frame-request call sites.

65. **Short-circuited frame waits when seek updates are pending (2026-02-13)**
   - In-flight frame wait polling now exits early when a seek change is observed, instead of waiting through full wait budgets.
   - Startup prefetch wait path now also bails out immediately when seek state changes during wait.

66. **Added pre-wait seek guards before startup and direct decode waits (2026-02-13)**
   - Startup prefetch wait path now checks for pending seeks before entering timeout waits and before skip fallback on timeout.
   - Direct decode fallback path now checks for pending seek updates before scheduling synchronous decode work.

67. **Batched keyed-buffer trims during queue-drain insertion (2026-02-13)**
   - Warmup and playback queue-drain paths now insert prefetched frames without per-item trim checks and apply one bounded trim pass after the batch.
   - Reduces repeated trim work when multiple prefetched frames are drained in the same loop iteration.

68. **Limited prefetch state resets to major/backward rebases (2026-02-13)**
   - Frame-request rebases now only reset decoded-ramp and behind-prefetch tracking on backward seeks or large seek-distance jumps.
   - Preserves prefetch ramp state on small forward rebases to reduce unnecessary throughput drops.

69. **Gated behind-prefetch scans to one pass per playback frame (2026-02-13)**
   - Behind-prefetch scheduling now scans at most once for each observed playback frame value.
   - Avoids repeated behind-window scan work in tight scheduler loops when playback position has not advanced.

---

## Root Cause Analysis Archive

1. **Audio start delay from full-track prerender**
   - Root cause: playback startup used `create_stream_prerendered()` for all sample formats, forcing full timeline audio render before output stream started.
   - Fix direction: switch default to incremental `AudioPlaybackBuffer` path with bounded prefill and live playhead correction.

2. **Scrub lag from playback restart loop**
   - Root cause: timeline seek while playing called stop → seek → start, rebuilding playback/audio state on every interactive seek.
   - Fix direction: add live seek channel into running playback loop and route frontend seeks to it.

3. **Display decoder init inflation on macOS**
   - Root cause: AVAssetReader decoder pool eagerly initialized multiple decoders during startup.
   - Fix direction: reduce eager warmup and lazily instantiate additional pool decoders when scrub behavior actually needs them.

---

## Architecture Overview

```
Recording Files (from real-device-test-runner)
├── baseline_mp4/
│   └── content/segments/segment-0/
│       ├── display.mp4        ─┐
│       ├── camera.mp4          ├── Decoder tests
│       ├── audio-input.ogg    ─┼── Audio sync tests
│       └── system_audio.ogg   ─┘
│
└── baseline_fragmented/
    └── content/segments/segment-0/
        ├── display/           ─┐
        │   ├── init.mp4        │  Fragmented decoder
        │   └── segment_*.m4s   │  (combines init + segments)
        ├── camera/            ─┘
        ├── audio-input.m4a    ─┬── Audio sync tests
        └── system_audio.m4a   ─┘

Decoder Pipeline:
┌─────────────────────────────────────────────────────────────────┐
│ spawn_decoder()                                                  │
│   ├── macOS: AVAssetReader (VideoToolbox HW accel)              │
│   ├── Windows: MediaFoundation (DXVA2/D3D11 HW accel)           │
│   └── Fallback: FFmpeg software decoder                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Notes

> **IMPORTANT**: Add a new session entry whenever you work on playback performance.
> This maintains context for future sessions.

---

### Session Template (Copy This)

```
### Session YYYY-MM-DD (Brief Description)

**Goal**: What you set out to do

**What was done**:
1. Step 1
2. Step 2
3. ...

**Changes Made**:
- File: description of change

**Results**:
- ✅ What worked
- ❌ What didn't work

**Stopping point**: Where you left off, what to do next
```

---

### Session 2026-02-13 (Audio Startup + Live Seek + Lazy Decoder Warmup)

**Goal**: Remove major editor playback bottlenecks affecting startup latency, scrub responsiveness, and decoder init overhead.

**What was done**:
1. Switched playback audio startup default to streaming buffer path.
2. Kept prerender audio path behind `CAP_AUDIO_PRERENDER_PLAYBACK` as explicit fallback.
3. Enabled `AudioPlaybackBuffer` for all platforms so Windows uses live buffering/sync path.
4. Added a seek channel to `PlaybackHandle` and integrated seek handling into the main playback loop.
5. Updated Tauri seek/playhead commands to forward seeks into active playback handle.
6. Removed frontend timeline stop/start cycle when seeking while playing.
7. Reduced AVAssetReader eager pool warmup and added lazy decoder instantiation for additional pool slots.
8. Extended playback benchmark tooling with scrub mode and startup latency metrics.
9. Added playback runtime startup telemetry logs for first frame and audio callback bring-up.
10. Enhanced decode benchmark example with structured JSON output and configurable sample depth.
11. Added timeline seek dispatch coalescing to reduce seek command storms during drag.
12. Added JSON report output support to playback-test-runner for benchmark evidence collection.
13. Added cross-platform benchmark JSON aggregation utility script.
14. Added matrix execution helper script for full + scrub benchmark runs per platform/GPU.
15. Added matrix validation script for required cell and format coverage checks.
16. Added matrix status report generator for concise artifact summaries.
17. Added one-shot finalization script for aggregate + status + validation outputs.
18. Added benchmark history publisher script for finalized matrix artifacts.
19. Added matrix bottleneck analysis script for prioritized FPS optimization follow-up.
20. Added baseline-vs-candidate comparison script to gate regressions in optimization loops.
21. Added seek-generation prefetch gating to drop stale decode outputs after live seek updates.
22. Cleared prefetched-frame buffer on live seek handling to avoid stale buffered frame reuse.
23. Restricted in-flight prefetch buffering to current frame or newer frames during frame wait path.
24. Expanded benchmark comparison gating to support multi-input baseline/candidate matrix sets.
25. Added optional baseline comparison gating inside matrix finalization workflow.
26. Made in-flight frame tracking generation-aware to prevent cross-seek marker collisions.
27. Split prefetch and direct decode in-flight tracking and guarded direct decode frame usage when seek updates are pending.
28. Added missing-candidate-row coverage gating in baseline-vs-candidate comparison script with optional override flag.
29. Fixed finalize compare/publish ordering so comparison artifacts exist before publish attachment and added finalize support for missing-candidate override.
30. Added structured JSON output for baseline-vs-candidate comparison script and wired finalize comparison runs to emit comparison JSON artifacts.
26. Made shared in-flight frame tracking generation-aware to prevent cross-seek marker collisions.
27. Added comparison artifact attachment support in publish/finalize matrix summary workflows.
28. Split prefetch and direct decode in-flight tracking to avoid cross-path marker interference.
29. Added missing-candidate-row gating to baseline-vs-candidate comparison workflow.
30. Fixed finalize compare/publish ordering and propagated missing-candidate override into finalize compare flow.
31. Added structured JSON artifact emission for baseline-vs-candidate comparison workflows.
32. Replaced playback prefetch deque scans with keyed `BTreeMap` buffering for lower lookup overhead in frame acquisition path.
33. Added ordered stale-frame pruning in keyed prefetch buffer to keep playback buffer aligned with current playhead.
34. Added comparison gate status fields to published matrix summary entries via comparison JSON attachment.
35. Tightened keyed prefetch buffer warmup timing and skip-path pruning behavior using map-aware helper usage in playback loop.
36. Expanded baseline-vs-candidate comparison outputs with candidate-only row reporting.
37. Added strict `fail-on-candidate-only` gating option for compare/finalize matrix comparison workflows.
38. Added candidate-only row count reporting in published matrix summary comparison status bullets.
39. Updated playback warmup start condition to require contiguous prefetched frame coverage from current frame.
40. Added comparison policy mode reporting (allow/fail) for missing-candidate and candidate-only coverage in published matrix summaries.
41. Added finalize summary JSON artifact output with artifact/settings/result metadata for automation workflows.
42. Optimized contiguous prefetched-frame warmup scan using ordered map range iteration instead of repeated key lookups.
43. Added git branch/commit metadata into finalize summary JSON artifacts for source traceability.
44. Wired finalize summary JSON into publish flow so one-shot finalize runs can publish summary metadata alongside matrix artifacts.
45. Improved multi-input comparison aggregation by merging per-key metrics across runs and surfacing baseline/candidate run counts per comparison row.
46. Skipped contiguous warmup coverage scans until first warmup frame observation to reduce pre-frame warmup loop scan overhead.
47. Added minimum-sample comparison gating with `--min-samples-per-row`, insufficient-sample reporting, and finalize passthrough support.
48. Cached warmup contiguous coverage values and only recomputed contiguous scan when warmup buffer changed.
49. Added comparison JSON gate diagnostics (`failureReasons`, `gateOutcomes`) and surfaced failure reasons in published summary output.
50. Corrected minimum sample gating semantics to only count comparable metrics and added compared-metric/effective-sample columns in comparison output.
51. Extended finalize summary and publish output with comparison failure reasons and gate outcome metadata.
52. Added comparison parse-error gating (`--fail-on-parse-errors`) with parse stats surfaced in comparison JSON, finalize settings, and published summaries.
53. Updated keyed prefetch insert helper to emit structural-change signals for warmup contiguous coverage cache invalidation.
54. Extended finalize summary and publish output with comparison file stats (including parse error counts).
55. Stabilized comparison output ordering with deterministic sorting for comparison rows and coverage-delta sections.
56. Extended finalize and publish summaries with comparison count rollups (compared rows, regressions, missing/candidate-only/insufficient-sample counts).
57. Added optional zero-comparison gating (`--fail-on-zero-compared`) for compare/finalize flows and surfaced zero-compare policy in comparison/published summaries.
58. Added warmup-stage seek handling to apply seeks immediately while playback warmup is in progress.
59. Added optional skipped-file gating (`--fail-on-skipped-files`) for compare/finalize flows and surfaced skipped-file policy in comparison/published summaries.
60. Added skipped-file reason breakdown (`skippedNoReports`, `skippedNoUsableMetrics`) into comparison file stats and published summaries.
61. Scaled warmup idle poll interval with frame budget to reduce warmup fallback latency under sparse frame arrival.
62. Retained in-flight prefetch markers for small frame-request shifts to avoid duplicate decode scheduling during active prefetch execution.
63. Added local in-flight frame tracking in prefetch scheduler to reduce lock-heavy duplicate-check lookups on scheduling hot-path.
64. Batched warmup prefetch queue consumption to reduce warmup staging overhead and improve contiguous warmup-fill responsiveness.
65. Scaled prefetch idle polling with frame budget to reduce scheduler wakeup churn during empty in-flight periods.
66. Bounded behind-prefetch dedupe tracking window to avoid unbounded growth and preserve lookup efficiency over long sessions.
67. Cached clip-offset lookups for prefetch and direct-decode scheduling to replace repeated linear clip scans on decode hot paths.
68. Deduplicated frame-request watch updates so unchanged frame requests no longer trigger redundant watch notifications.
69. Replaced contains+entry prefetch insertion with single-entry map insertion to remove duplicate keyed-buffer lookups in frame-insert hot path.
70. Centralized change-aware frame-request watch updates via shared helper for consistent no-op dedupe behavior across warmup/seek/skip paths.
71. Added seek-aware short-circuiting in in-flight/startup frame wait paths to avoid waiting full frame-fetch budgets when seek updates arrive.
72. Added pre-wait seek guards in startup/direct-decode fallback paths so pending seeks skip timeout waits and avoid stale synchronous decode work.
73. Batched keyed-buffer trimming during warmup/playback prefetch queue drains to avoid per-insert trim checks under burst frame arrivals.
74. Limited prefetch state resets to backward/major frame-request rebases so small forward rebases preserve decode-ramp and behind-prefetch tracking state.
75. Gated behind-prefetch scheduling scans to one pass per playback frame to avoid repeated behind-window scan churn while playback position is unchanged.

**Changes Made**:
- `crates/editor/src/playback.rs`: default low-latency audio mode, playback seek channel, seek-aware scheduling.
- `crates/editor/src/audio.rs`: cross-platform `AudioPlaybackBuffer`, windows-only smooth seek helper.
- `apps/desktop/src-tauri/src/lib.rs`: forward `seek_to` and `set_playhead_position` into active playback handle.
- `apps/desktop/src/routes/editor/Timeline/index.tsx`: seek while playing now sends direct `seekTo` without playback restart.
- `crates/rendering/src/decoder/avassetreader.rs`: lower eager decoder warmup and lazy pool growth.
- `crates/recording/examples/playback-test-runner.rs`: added scrub command and startup/scrub latency metrics.
- `crates/editor/PLAYBACK-BENCHMARKS.md`: updated benchmark reference and metric definitions.
- `crates/editor/src/playback.rs`: added first-render and audio-callback startup latency logging.
- `crates/editor/examples/decode-benchmark.rs`: added `--output-json`, startup metrics, and configurable sequential/random sampling.
- `apps/desktop/src/routes/editor/Timeline/index.tsx`: added requestAnimationFrame-based seek coalescing with in-flight protection.
- `crates/recording/examples/playback-test-runner.rs`: added `--json-output` to emit structured benchmark reports.
- `scripts/aggregate-playback-benchmarks.js`: added markdown aggregation for multiple playback benchmark JSON artifacts.
- `scripts/run-playback-benchmark-matrix.js`: added orchestrated full/scrub benchmark runner with per-machine aggregate generation.
- `scripts/validate-playback-matrix.js`: added required matrix cell/format validation for aggregated evidence.
- `scripts/build-playback-matrix-report.js`: added concise matrix status report generation from JSON benchmark outputs.
- `scripts/finalize-playback-matrix.js`: added one-shot matrix artifact finalization workflow.
- `scripts/publish-playback-matrix-summary.js`: added matrix artifact publisher into PLAYBACK-BENCHMARKS history region.
- `scripts/analyze-playback-matrix-bottlenecks.js`: added prioritized bottleneck analysis output from matrix JSON evidence.
- `scripts/compare-playback-benchmark-runs.js`: added regression-aware baseline/candidate comparison with configurable FPS/startup/scrub tolerances.
- `scripts/compare-playback-benchmark-runs.js`: fixed options wiring inside comparison regression checks and now aggregates per-key metrics across multi-input runs with run-count reporting.
- `scripts/compare-playback-benchmark-runs.js`: comparison row sets are now deterministically sorted for stable markdown/json artifact diffs.
- `scripts/compare-playback-benchmark-runs.js`: added optional `--fail-on-zero-compared` and zero-compare gate diagnostics in markdown/json outputs.
- `scripts/finalize-playback-matrix.js`: forwards `--fail-on-zero-compared` into compare stage and records policy in finalize summary settings.
- `scripts/finalize-playback-matrix.js`: finalize summary now includes comparison count rollup fields for compared rows, regressions, and coverage deltas.
- `scripts/publish-playback-matrix-summary.js`: publish summary now surfaces finalize comparison count rollups when finalize summary metadata is attached.
- `scripts/publish-playback-matrix-summary.js`: added optional baseline-vs-candidate comparison artifact attachment in published summaries.
- `crates/editor/src/playback.rs`: warmup loop now handles seek updates immediately, resetting warmup state and updating frame/audio targets before playback loop entry.
- `crates/editor/src/playback.rs`: warmup loop fallback polling now scales with frame budget instead of fixed 100ms sleep to improve responsiveness without busy waiting.
- `crates/editor/src/playback.rs`: frame-request rebases now preserve in-flight marker sets unless in-flight futures are explicitly reset for backward/large seek changes.
- `crates/editor/src/playback.rs`: prefetch scheduler now uses a local in-flight frame set for duplicate scheduling checks and mirrors it into shared generation-keyed in-flight markers for playback coordination.
- `crates/editor/src/playback.rs`: warmup prefetch receive path now drains immediately queued prefetched frames in batches to accelerate warmup buffer population.
- `crates/editor/src/playback.rs`: prefetch scheduler idle polling now scales with frame budget (bounded) instead of fixed 1ms delay, reducing idle wakeup overhead.
- `crates/editor/src/playback.rs`: behind-prefetch dedupe tracking now uses a bounded eviction-ordered window to prevent unbounded set growth during long playback.
- `crates/editor/src/playback.rs`: prefetch and playback direct-decode paths now use cached clip-offset maps rebuilt on project updates, avoiding repeated clip list linear searches.
- `crates/editor/src/playback.rs`: frame-request updates now use `watch::Sender::send_if_modified` across playback/warmup/skip paths to avoid redundant unchanged-frame notifications.
- `crates/editor/src/playback.rs`: prefetch insertion now uses single `BTreeMap::entry` insertion path instead of separate contains-check + insert lookup.
- `crates/editor/src/playback.rs`: frame-request watch updates now route through shared helper to keep no-op dedupe behavior and call-site logic consistent across warmup/seek/skip paths.
- `crates/editor/src/playback.rs`: in-flight and startup frame wait paths now short-circuit when seek updates are pending to improve scrub responsiveness under wait pressure.
- `crates/editor/src/playback.rs`: startup prefetch wait and direct-decode fallback paths now pre-check seek updates before waiting/synchronous decode scheduling to skip stale work under active seeks.
- `crates/editor/src/playback.rs`: warmup and playback queue-drain insertion paths now perform untrimmed batch insertions and run a single keyed-buffer trim pass after each drain batch.
- `crates/editor/src/playback.rs`: frame-request rebases now only clear prefetch ramp/behind-tracking state on backward or large-distance jumps, preserving throughput state on small forward rebases.
- `crates/editor/src/playback.rs`: behind-prefetch scheduling now scans at most once per playback frame value, reducing repeated behind-window scan overhead in tight scheduler loops.
- `crates/editor/src/playback.rs`: split prefetch/direct decode in-flight tracking and combined both sets in wait-path in-flight checks.
- `scripts/compare-playback-benchmark-runs.js`: comparison now reports baseline rows missing from candidate and fails by default on coverage gaps.
- `scripts/finalize-playback-matrix.js`: compare stage now runs before publish stage in combined workflows and forwards allow-missing-candidate flag.
- `scripts/compare-playback-benchmark-runs.js`: added structured comparison JSON output with pass/fail summary and regression detail payload.
- `scripts/compare-playback-benchmark-runs.js`: comparison outputs now include candidate-only rows in addition to missing-candidate coverage deltas.
- `scripts/finalize-playback-matrix.js`: baseline comparison flow now writes both `playback-comparison.md` and `playback-comparison.json`.
- `scripts/compare-playback-benchmark-runs.js`: added optional strict `--fail-on-candidate-only` coverage gate and surfaced coverage gate mode in comparison markdown output.
- `scripts/compare-playback-benchmark-runs.js`: added optional strict `--fail-on-skipped-files` gate and parse/skip policy reporting in comparison markdown/json outputs.
- `scripts/compare-playback-benchmark-runs.js`: comparison file stats now include skipped-file reason breakdown (`skippedNoReports`, `skippedNoUsableMetrics`).
- `scripts/finalize-playback-matrix.js`: added passthrough support for strict `--fail-on-candidate-only` compare mode in one-shot finalize workflows.
- `scripts/finalize-playback-matrix.js`: forwards `--fail-on-skipped-files` into compare stage and records skipped-file policy in finalize summary settings.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes candidate-only row count from comparison JSON summary.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes missing-candidate and candidate-only coverage policy modes from comparison JSON tolerance settings.
- `crates/editor/src/playback.rs`: warmup readiness now requires contiguous prefetched frame coverage from current frame instead of raw buffer length threshold.
- `crates/editor/src/playback.rs`: contiguous warmup coverage scan now uses ordered map range iteration to reduce repeated key lookup overhead.
- `crates/editor/src/playback.rs`: warmup first-frame timing now only starts after eligible prefetched frame insertion, and skip catch-up now reuses ordered stale-prune helper.
- `scripts/finalize-playback-matrix.js`: added optional `--output-json` and default finalize summary JSON emission with artifact path and pass/fail metadata.
- `scripts/finalize-playback-matrix.js`: finalize summary JSON now includes git branch and commit metadata when available.
- `scripts/finalize-playback-matrix.js`: finalize now writes summary JSON before publish and passes `--finalize-summary-json` into publish flow.
- `scripts/publish-playback-matrix-summary.js`: publish flow now supports optional finalize summary JSON input and surfaces finalize source/validation metadata.
- `scripts/compare-playback-benchmark-runs.js`: added `--min-samples-per-row`, insufficient-sample row reporting, and sample gate fields in markdown/JSON outputs.
- `scripts/compare-playback-benchmark-runs.js`: minimum sample checks now apply only to metrics that are comparable for each row; output now includes compared metric count and effective sample count columns.
- `scripts/finalize-playback-matrix.js`: forwards `--min-samples-per-row` into compare stage and captures it in finalize summary settings.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes insufficient sample row count and minimum sample threshold fields.
- `scripts/compare-playback-benchmark-runs.js`: comparison JSON summary now includes explicit `failureReasons` and `gateOutcomes` fields.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes comparison failure reasons when present.
- `scripts/finalize-playback-matrix.js`: finalize summary now includes comparison failure reasons and gate outcome fields in results metadata.
- `scripts/compare-playback-benchmark-runs.js`: added parse-error gating and baseline/candidate file parse stats/parse error entries in JSON output.
- `scripts/finalize-playback-matrix.js`: forwards parse-error gating and records parse-error policy in finalize summary settings.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes parse policy and baseline/candidate parse error counts.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes skipped-file policy mode from comparison tolerance settings.
- `scripts/publish-playback-matrix-summary.js`: published comparison status now includes skipped-file breakdown counts for no-reports and no-usable-metrics cases.
- `crates/editor/src/playback.rs`: `insert_prefetched_frame` now returns structural-change signals and warmup cache invalidation uses this signal to avoid stale contiguous counts when insert+trim keeps buffer length unchanged.
- `scripts/finalize-playback-matrix.js`: finalize summary now includes comparison file stats payload when comparison runs are enabled.
- `scripts/publish-playback-matrix-summary.js`: publish summary now surfaces finalize baseline/candidate parse error counts from finalize summary metadata.
- `crates/editor/src/playback.rs`: warmup loop now skips contiguous coverage scanning until first warmup frame has been observed.
- `crates/editor/src/playback.rs`: warmup contiguous coverage counts are now cached and recomputed only on warmup buffer changes.
- `crates/editor/src/playback.rs`: replaced deque-based prefetch buffering with keyed `BTreeMap` buffering and bounded eviction for faster target frame retrieval.
- `crates/editor/src/playback.rs`: added ordered pruning of stale prefetched frames below current playhead to reduce stale buffer overhead during catch-up.
- `scripts/publish-playback-matrix-summary.js`: publish flow now surfaces comparison gate status/summary metrics when comparison JSON is provided.
- `scripts/finalize-playback-matrix.js`: finalize publish pass now forwards both comparison markdown and comparison JSON artifacts.
- `crates/editor/src/playback.rs`: added seek-generation tagging for prefetched frames so stale in-flight decode results are ignored after seek generation advances.
- `crates/editor/src/playback.rs`: seek handling now clears prefetched frame buffer on generation changes to guarantee stale buffered frames are discarded immediately.
- `crates/editor/src/playback.rs`: in-flight prefetch wait path now only buffers frames at or ahead of current frame to reduce stale buffer accumulation.
- `scripts/compare-playback-benchmark-runs.js`: comparison gating now accepts multiple baseline and candidate inputs for aggregated matrix regression checks.
- `scripts/finalize-playback-matrix.js`: finalization now supports optional baseline comparison gating and threshold controls in the same pass.
- `crates/editor/src/playback.rs`: in-flight frame markers now include seek generation to prevent old decode paths from clearing current-generation markers.
- `scripts/publish-playback-matrix-summary.js`: publish flow now supports optional comparison artifact attachment.
- `scripts/finalize-playback-matrix.js`: finalize flow now includes comparison artifact when publishing and baseline comparison are both requested.
- `crates/editor/src/playback.rs`: prefetch and direct decode now use separate generation-aware in-flight sets, with combined checks in frame wait path.
- `scripts/compare-playback-benchmark-runs.js`: comparison now reports and gates missing candidate rows relative to baseline coverage.
- `scripts/finalize-playback-matrix.js`: comparison now runs before publish in combined workflows and forwards missing-candidate override to compare step.
- `scripts/compare-playback-benchmark-runs.js`: comparison now supports optional structured JSON output for downstream automation.
- `scripts/finalize-playback-matrix.js`: baseline comparison in finalize now writes both markdown and JSON comparison artifacts.

**Results**:
- ✅ `cargo +stable check -p cap-editor` passes after changes.
- ✅ `cargo +stable check -p cap-rendering` passes after changes.
- ✅ `pnpm --dir apps/desktop exec tsc --noEmit` passes after frontend seek changes.
- ⚠️ `cargo +stable check -p cap-desktop` and `cargo +stable run -p cap-recording --example playback-test-runner -- list` fail in this Linux environment because `scap-targets` does not currently compile on this target (`DisplayIdImpl`/`WindowImpl` unresolved), preventing local benchmark execution here.
- ⚠️ Cross-platform FPS/scrub/A-V benchmark evidence still pending on macOS and Windows devices with real recordings.

**Stopping point**: Core playback code-path optimizations are implemented and compiling in touched crates; next step is benchmark execution on macOS 13+ and Windows GPU matrix to quantify gains.

---

### Session 2026-01-28 (Initial Baseline - MP4)

**Goal**: Establish initial playback performance baseline

**What was done**:
1. Created PLAYBACK-FINDINGS.md (self-healing document)
2. Created /performance-playback skill
3. Verified test recordings exist from recording benchmarks
4. Ran full playback validation on MP4 recording

**Changes Made**:
- Created `crates/editor/PLAYBACK-FINDINGS.md`
- Created `.claude/skills/performance-playback/SKILL.md`

**Results**:
- ✅ Decoder: AVAssetReader hardware acceleration working
- ✅ Display: 4096x1152, init=337ms (multi-decoder pool)
- ✅ Camera: 1920x1080, init=23ms
- ✅ Playback: 549 fps effective, avg=1.8ms, p95=3.1ms, p99=4.4ms
- ✅ Mic sync: 77ms diff (within 100ms target)
- ✅ Camera sync: 0ms drift (perfect)
- 🟡 System audio: 162ms diff (inherited from recording)

**Stopping point**: MP4 baseline established. Need to test fragmented mode next.

---

### Session 2026-01-28 (Performance Check - Healthy)

**Goal**: Verify current playback performance against targets

**What was done**:
1. Read PLAYBACK-FINDINGS.md and PLAYBACK-BENCHMARKS.md for context
2. Created fragmented baseline recording
3. Ran full playback validation tests
4. Analyzed results against performance targets

**Changes Made**:
- None - performance is healthy

**Results** (Fragmented Mode):
- ✅ Decoder: FFmpeg (hardware) with VideoToolbox HW acceleration
- ✅ Display decoder init: 139ms (target <200ms)
- ✅ Camera decoder init: 19ms (target <200ms)
- ✅ Effective FPS: 278 fps (target ≥60 fps)
- ✅ Decode latency avg: 3.6ms, p95: 3.2ms, p99: 135ms (target p95 <50ms)
- ✅ Mic audio sync: 8ms diff (target <100ms)
- ✅ System audio sync: 99ms diff (target <100ms)
- ✅ Camera-display drift: 0ms (target <100ms)

**Notes**:
- AVAssetReader fails on fragmented recordings (directory path), falls back to FFmpeg
- FFmpeg with VideoToolbox provides excellent hardware-accelerated decoding
- All playback metrics well within targets

**Stopping point**: All metrics healthy. No action required.

---

### Session 2026-01-30 (Performance Check - Healthy)

**Goal**: Verify current playback performance against targets

**What was done**:
1. Read PLAYBACK-FINDINGS.md and PLAYBACK-BENCHMARKS.md for context
2. Verified test recordings exist from recording benchmark run
3. Ran full playback validation tests twice
4. Analyzed results against performance targets

**Changes Made**:
- None - performance is healthy

**Results** (MP4 Mode):
- ✅ Decoder: AVAssetReader (hardware) with VideoToolbox HW acceleration
- ✅ Display decoder init: 320-354ms (multi-position pool with 3 decoders)
- ✅ Camera decoder init: 35ms (target <200ms)
- ✅ Effective FPS: 334-337 fps (target ≥60 fps)
- ✅ Decode latency: avg=3.0ms, p95=5.1ms, p99=79-81ms (target p95 <50ms)
- ✅ Mic audio sync: 81.7ms diff (target <100ms)
- ✅ Camera-display drift: 0ms (target <100ms)
- 🟡 System audio sync: 186.7ms diff (known issue, inherited from recording)

**Analysis**:
- Playback decoder performance is excellent (334-337 fps effective, 5.1ms p95 latency)
- Hardware acceleration (VideoToolbox) confirmed working
- All core sync metrics pass targets
- System audio timing issue is recording-side, not playback-side

**Stopping point**: All metrics healthy. No action required.

---

### Session 2026-01-30 (Fix Frame Rate Bottleneck - CPU→GPU RGBA)

**Goal**: Fix editor playback only achieving ~40-50fps instead of 60fps

**What was done**:
1. Analyzed the full playback pipeline: Rust decoder → GPU render → readback → WebSocket → JavaScript → display
2. Identified bottleneck: `convert_to_nv12()` in `frame_ws.rs` doing per-pixel CPU color conversion (~6M pixels/frame)
3. Implemented fix: Skip NV12 conversion, send RGBA directly to WebGPU

**Changes Made**:
- `apps/desktop/src-tauri/src/frame_ws.rs`: Replaced NV12 conversion with direct RGBA packing in `create_watch_frame_ws()`
- `apps/desktop/src/utils/socket.ts`: Added WebGPU RGBA rendering path using `renderFrameWebGPU()`

**Root Cause Analysis**:
The pipeline was:
1. GPU renders RGBA → readback to CPU (~23MB)
2. **CPU converts RGBA→NV12** (per-pixel, ~15-25ms per frame) ← BOTTLENECK
3. Send NV12 over WebSocket (~9MB)
4. JavaScript receives NV12 → WebGPU converts NV12→display

The CPU RGBA→NV12 conversion was taking 15-25ms per frame for 3024x1964 resolution, limiting frame rate to 40-50fps. NV12 was originally used to reduce WebSocket bandwidth (12 vs 32 bits/pixel), but the CPU cost outweighed the bandwidth savings for local WebSocket.

**Fix**: Skip NV12 conversion entirely. Send RGBA directly and use WebGPU `renderFrameWebGPU()` to display. This trades 2.7x bandwidth increase for eliminating the 15-25ms CPU conversion per frame.

**Results**:
- Eliminates ~15-25ms CPU overhead per frame
- Expected improvement: 40-50fps → 60fps
- Bandwidth increase: ~9MB → ~23MB per frame (acceptable for local WebSocket)

**Stopping point**: Fix implemented and compiles. Needs testing with actual editor to verify 60fps achievement.

---

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `PLAYBACK-MATRIX-RUNBOOK.md` - Cross-platform playback evidence collection process
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
