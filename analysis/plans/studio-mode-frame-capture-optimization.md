# Studio Mode Frame Capture Optimization

## Metadata
- **Type:** Performance
- **Status:** Planning
- **Created:** 2026-01-19
- **Areas:** crates/recording

## Overview

The studio mode recording pipeline suffers from severe frame drops during capture, with observed drop rates ranging from 9% to 99% depending on resolution and frame rate. This document analyzes the root causes and proposes a phased fix approach.

### Success Criteria
- [ ] Frame drop rate < 5% at 3024x1964 @ 30fps
- [ ] Frame drop rate < 10% at 3024x1964 @ 60fps
- [ ] Frame drop rate < 20% at 5952x3348 @ 30fps
- [ ] No false "Large forward timestamp jump" warnings during normal recording
- [ ] Graceful degradation at extreme resolutions (5952x3348 @ 60fps)

---

## Technical Context

### Architecture Summary

Studio mode recording flows through:
1. **Screen Capture** (`crates/recording/src/sources/screen_capture/macos.rs`) - ScreenCaptureKit frame acquisition
2. **Video Source Channel** (`crates/recording/src/output_pipeline/core.rs`) - Frame buffering between capture and mux
3. **Mux-Video Task** (`core.rs`) - Timestamp processing and frame forwarding
4. **M4S Muxer** (`crates/recording/src/output_pipeline/macos_fragmented_m4s.rs`) - Encoder channel and H264 encoding
5. **Encoder Thread** - FFmpeg-based H264 encoding to segmented DASH output

### Test Suite Evidence

**Test Run 1 (High System Load):**
| Resolution | Target FPS | Actual FPS | Frames | Drop Rate |
|------------|------------|------------|--------|-----------|
| 3024x1964 | 30 | 4.8 | 48/300 | 84.0% |
| 3024x1964 | 60 | 7.3 | 74/600 | 87.7% |
| 5952x3348 | 30 | 0.4 | 4/300 | 98.7% |
| 5952x3348 | 60 | 0.5 | 5/600 | 99.2% |

**Test Run 2 (Lower System Load):**
| Resolution | Target FPS | Actual FPS | Frames | Drop Rate |
|------------|------------|------------|--------|-----------|
| 3024x1964 | 30 | 27.0 | 272/300 | 9.3% |
| 3024x1964 | 60 | 48.8 | 491/600 | 18.2% |
| 5952x3348 | 30 | 10.2 | 103/300 | 65.7% |
| 5952x3348 | 60 | 0.4 | 4/600 | 99.3% |

**Key Observations:**
- Performance highly variable based on system load
- Higher resolutions consistently perform worse
- 5952x3348 @ 60fps essentially non-functional on both runs
- Timestamp anomaly warnings correlate with frame drops

---

## Root Cause Analysis

### Issue 1: Critically Small macOS Muxer Buffer (PRIMARY)

**Location:** `crates/recording/src/output_pipeline/macos_fragmented_m4s.rs:23-28`

```rust
fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3)  // <-- ONLY 3 FRAMES!
}
```

**Windows comparison:** `crates/recording/src/output_pipeline/win_fragmented_m4s.rs:25`
```rust
const DEFAULT_MUXER_BUFFER_SIZE: usize = 240;  // 80x larger
```

**Impact:**
- At 60fps, 3 frames = 50ms of buffering
- Any encoder stall > 50ms causes immediate frame drops
- `try_send` at lines 396-411 silently drops frames when buffer is full:
```rust
match state.video_tx.try_send(Some((frame.sample_buf, adjusted_timestamp))) {
    Ok(()) => { self.frame_drops.record_frame(); }
    Err(e) => match e {
        std::sync::mpsc::TrySendError::Full(_) => {
            self.frame_drops.record_drop();  // Silent drop!
        }
        // ...
    },
}
```

**Evidence:** Test logs show only 48-74 frames reaching muxer out of 300-600 expected.

---

### Issue 2: Small Screen Capture Buffer

**Location:** `crates/recording/src/sources/screen_capture/macos.rs:127-132`

```rust
fn get_screen_buffer_size() -> usize {
    std::env::var("CAP_SCREEN_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4)  // Only 4 frames
}
```

**Impact:**
- 4 frames at 60fps = 67ms of buffering
- Combined with 3-frame muxer buffer, total pipeline tolerance is ~117ms
- Any processing spike causes cascading drops

---

### Issue 3: Timestamp Anomaly False Positives

**Location:** `crates/recording/src/output_pipeline/core.rs:30, 259-294`

```rust
const LARGE_FORWARD_JUMP_SECS: f64 = 0.5;  // 500ms threshold

fn handle_forward_jump(&mut self, last: Duration, current: Duration, jump_secs: f64) {
    // ...
    let expected_increment = Duration::from_millis(33);  // Assumes 30fps
    let adjusted = last.saturating_add(expected_increment);
    let compensation_secs = current.as_secs_f64() - adjusted.as_secs_f64();
    self.accumulated_compensation_secs -= compensation_secs;  // Accumulates negative!
    // ...
}
```

**Evidence from logs:**
```
Large forward timestamp jump detected (system sleep/wake?), resyncing timeline
stream="video" forward_secs=0.599994292 accumulated_compensation_secs="-8.288"
```

**Problems:**
1. Detection triggers on startup delay (pipeline creation to first frame), not actual sleep/wake
2. Hardcoded 33ms increment doesn't account for different frame rates (60fps = 16.67ms)
3. Compensation accumulates in wrong direction, reaching -8.288 seconds
4. Warning message "system sleep/wake?" is misleading

---

### Issue 4: Insufficient Drain on Shutdown

**Location:** `crates/recording/src/output_pipeline/core.rs:976-1034`

```rust
if was_cancelled {
    info!("mux-video cancelled, draining remaining frames from channel");
    let drain_timeout = Duration::from_secs(2);
    let max_drain_frames = 30u64;  // Only 30 frames!
    // ...
}
```

**Impact:**
- Video source channel capacity is 300 frames
- On shutdown, only 30 frames are drained
- Remaining 270 buffered frames are lost

**Evidence:** Logs show `mux-video drain complete: 1 frames processed` despite frames being buffered.

---

### Issue 5: High Resolution Memory/Bandwidth Constraints

**Location:** `crates/recording/src/sources/screen_capture/macos.rs:58-97`

```rust
fn get_pixel_buffer_pool_size() -> usize {
    std::env::var("CAP_PIXEL_BUFFER_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)  // 20 buffers
}
```

**Impact at 5952x3348:**
- Each NV12 frame = 5952 * 3348 * 1.5 bytes = ~30MB
- 20-buffer pool = ~600MB memory
- At 60fps, requires ~1.8GB/s throughput
- `PixelBufferCopier` synchronously copies each frame through mutex-protected session

**Evidence:** 5952x3348 @ 60fps shows 99%+ frame drops on both test runs.

---

## Tasks

### Phase 1: Buffer Size Fixes (Critical - Immediate Impact)

#### 1.1 Increase macOS Muxer Buffer Size
- [x] **Status**: complete
- **Priority:** P0
- **Estimated Impact:** 50%+ frame improvement

**Objective:**
Align macOS muxer buffer size with Windows to provide adequate buffering for encoder throughput variations.

**Files to modify:**
- `crates/recording/src/output_pipeline/macos_fragmented_m4s.rs:27`

**Implementation:**
```rust
fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)  // 1 second at 60fps, up from 3
}
```

**Acceptance Criteria:**
- [ ] Default buffer size changed from 3 to 60
- [ ] Frame drop rate at 3024x1964 @ 30fps < 10%
- [ ] Run `cargo fmt` before completing

---

#### 1.2 Increase Screen Capture Buffer
- [x] **Status**: complete
- **Priority:** P0
- **Estimated Impact:** 10-20% frame improvement

**Objective:**
Increase screen capture channel buffer to provide more tolerance for processing jitter.

**Files to modify:**
- `crates/recording/src/sources/screen_capture/macos.rs:131`

**Implementation:**
```rust
fn get_screen_buffer_size() -> usize {
    std::env::var("CAP_SCREEN_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15)  // 500ms at 30fps, up from 4
}
```

**Acceptance Criteria:**
- [ ] Default buffer size changed from 4 to 15
- [ ] Run `cargo fmt` before completing

---

#### 1.3 Fix Drain Limit on Shutdown
- [x] **Status**: complete
- **Priority:** P0
- **Estimated Impact:** Preserve buffered frames on graceful shutdown

**Objective:**
Ensure all buffered frames are processed on recording stop.

**Files to modify:**
- `crates/recording/src/output_pipeline/core.rs:982`

**Implementation:**
```rust
let max_drain_frames = 500u64;  // Match video source channel capacity + headroom
```

**Acceptance Criteria:**
- [ ] Drain limit increased from 30 to 500
- [ ] Log message shows all buffered frames processed on shutdown
- [ ] Run `cargo fmt` before completing

---

### Phase 2: Timestamp Handling Improvements

#### 2.1 First-Frame Baseline Synchronization
- [x] **Status**: complete
- **Priority:** P1

**Objective:**
Eliminate false "Large forward timestamp jump" warnings by establishing baseline from first frame instead of pipeline creation time.

**Files to modify:**
- `crates/recording/src/output_pipeline/core.rs` - `TimestampAnomalyTracker`

**Implementation approach:**
1. Add `first_frame_baseline: Option<Duration>` field to `TimestampAnomalyTracker`
2. On first frame, capture baseline offset between frame timestamp and pipeline start
3. Apply baseline offset to all subsequent timestamp calculations
4. Only flag anomalies after baseline is established (after warmup window)

**Acceptance Criteria:**
- [ ] No "Large forward timestamp jump" warnings during normal recording startup
- [ ] Warnings still trigger for actual system sleep/wake events (>2 second gaps)
- [ ] Run `cargo fmt` before completing

---

#### 2.2 Frame-Rate-Aware Expected Increment
- [ ] **Status**: pending
- **Priority:** P1

**Objective:**
Use actual frame rate for timestamp gap expectations instead of hardcoded 33ms.

**Files to modify:**
- `crates/recording/src/output_pipeline/core.rs:271`

**Implementation:**
1. Add `expected_frame_duration: Duration` field to `TimestampAnomalyTracker`
2. Initialize based on video config fps
3. Use in `handle_forward_jump`:
```rust
let expected_increment = self.expected_frame_duration;
```

**Acceptance Criteria:**
- [ ] Expected increment calculated from actual fps
- [ ] 60fps recording uses ~16.67ms increment
- [ ] Run `cargo fmt` before completing

---

### Phase 3: High Resolution Optimization

#### 3.1 Resolution-Based Buffer Scaling
- [ ] **Status**: pending
- **Priority:** P2

**Objective:**
Automatically scale buffer sizes based on resolution to handle high-resolution capture.

**Files to modify:**
- `crates/recording/src/sources/screen_capture/macos.rs`
- `crates/recording/src/output_pipeline/macos_fragmented_m4s.rs`

**Implementation approach:**
1. Calculate pixel count: `width * height`
2. For resolutions > 4K (8.3M pixels), increase buffer multiplier
3. Example scaling:
   - < 4K: default buffers
   - 4K-6K: 1.5x buffers
   - > 6K: 2x buffers

**Acceptance Criteria:**
- [ ] Buffer sizes scale automatically with resolution
- [ ] 5952x3348 @ 30fps achieves > 50% frame capture rate
- [ ] Run `cargo fmt` before completing

---

#### 3.2 Pixel Buffer Pool Sizing
- [ ] **Status**: pending
- **Priority:** P2

**Objective:**
Scale pixel buffer pool based on resolution and frame rate to prevent pool exhaustion.

**Files to modify:**
- `crates/recording/src/sources/screen_capture/macos.rs:58-97`

**Implementation approach:**
1. Calculate required pool memory: `frame_size * pool_count`
2. At high resolutions, either:
   - Increase pool count proportionally
   - Or reduce pool count but increase buffer sizes elsewhere
3. Add memory budget configuration

**Acceptance Criteria:**
- [ ] Pool sizing accounts for resolution
- [ ] No pool exhaustion at 5952x3348
- [ ] Run `cargo fmt` before completing

---

### Phase 4: Encoder Throughput Improvements

#### 4.1 Adaptive Frame Skipping
- [ ] **Status**: pending
- **Priority:** P3

**Objective:**
When encoder can't keep up, deliberately skip frames at regular intervals instead of random drops from buffer overflow.

**Files to modify:**
- `crates/recording/src/output_pipeline/macos_fragmented_m4s.rs`

**Implementation approach:**
1. Track encoder throughput (frames encoded per second)
2. If throughput < target fps * 0.8, enable skip mode
3. In skip mode, encode every Nth frame (N = target_fps / actual_throughput)
4. Log skip rate for diagnostics

**Acceptance Criteria:**
- [ ] Consistent (lower) frame rate instead of stuttery random drops
- [ ] Skip rate logged for diagnostics
- [ ] Run `cargo fmt` before completing

---

#### 4.2 Hardware Encoder Optimization
- [ ] **Status**: pending
- **Priority:** P3

**Objective:**
Improve hardware vs software encoder selection and configuration.

**Files to modify:**
- `crates/encoder/src/h264.rs`

**Implementation approach:**
1. Review `requires_software_encoder()` thresholds
2. Consider resolution-specific encoder presets
3. Test VideoToolbox limits at various resolutions

**Acceptance Criteria:**
- [ ] Hardware encoder used when capable
- [ ] Smoother fallback to software encoder
- [ ] Run `cargo fmt` before completing

---

## Implementation Notes

### Testing Strategy
1. Run test suite after each phase: `cargo run -p cap-test -- suite recording`
2. Compare frame drop percentages against baseline
3. Test under both low and high system load conditions
4. Verify no regressions in audio sync

### Environment Variables for Tuning
| Variable | Default | Description |
|----------|---------|-------------|
| `CAP_MUXER_BUFFER_SIZE` | 3 (macOS), 240 (Windows) | Muxer channel buffer |
| `CAP_SCREEN_BUFFER_SIZE` | 4 | Screen capture channel buffer |
| `CAP_VIDEO_SOURCE_BUFFER_SIZE` | 300 | Video source channel capacity |
| `CAP_PIXEL_BUFFER_POOL_SIZE` | 20 | Pixel buffer pool count |
| `CAP_MAX_QUEUE_DEPTH` | 8 | ScreenCaptureKit queue depth |

### Rollback Plan
All changes use environment variables with fallback to current defaults. To rollback:
1. Set `CAP_MUXER_BUFFER_SIZE=3` to restore original macOS buffer
2. Set `CAP_SCREEN_BUFFER_SIZE=4` to restore original screen buffer
3. Changes are additive and backward compatible

### Dependencies
- No new dependencies required
- All changes are internal to `crates/recording`

---

## Learned Context
- macOS muxer buffer default updated to 60 to align with 1 second of 60fps buffering.
- Screen capture buffer default raised to 15 to reduce capture jitter drops.
- Drain limit increased to 500 frames to preserve buffered frames on shutdown.
- Timestamp anomaly tracking now establishes a first-frame baseline so startup delays do not trigger forward-jump warnings.

---

## Expected Results After Phase 1

| Resolution | Target FPS | Current Drop Rate | Expected Drop Rate |
|------------|------------|-------------------|-------------------|
| 3024x1964 | 30 | 9-84% | < 5% |
| 3024x1964 | 60 | 18-88% | < 10% |
| 5952x3348 | 30 | 66-99% | < 30% |
| 5952x3348 | 60 | 99% | < 50% (with software encoder) |
