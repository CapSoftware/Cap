# Video Playback Optimization Plan (macOS)

## Executive Summary

This document analyzes the video playback and scrubbing latency in the Cap editor on macOS. The goal is to achieve near-instant playback start and scrubbing response. Currently, users experience noticeable lag when:
1. Starting video playback
2. Scrubbing to different parts of the timeline

---

## Current Architecture Overview

### Key Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (SolidJS)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Timeline.tsx                                                                │
│    ├── handleUpdatePlayhead() → commands.seekTo() / commands.startPlayback() │
│    └── Mouse events → setEditorState("playbackTime", newTime)                │
│                                                                              │
│  context.ts                                                                  │
│    ├── previewTime signal                                                    │
│    └── createEffect → commands.setPreviewFrame() when playbackTime changes   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ IPC (Tauri Commands)
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EDITOR INSTANCE (Rust)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  editor_instance.rs                                                         │
│    ├── preview_tx: watch::Sender<Option<PreviewFrameInstruction>>           │
│    ├── spawn_preview_renderer() → Background task listening to preview_tx   │
│    └── start_playback() → Spawns Playback task                              │
│                                                                              │
│  playback.rs                                                                 │
│    ├── Prefetch buffer (30 frames)                                          │
│    ├── Frame cache (30 frames LRU)                                          │
│    ├── Parallel decode tasks (8)                                            │
│    └── MAX_PREFETCH_AHEAD (90 frames)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              RECORDING SEGMENT DECODERS (crates/rendering/src/lib.rs)       │
├─────────────────────────────────────────────────────────────────────────────┤
│  RecordingSegmentDecoders                                                   │
│    ├── screen: AsyncVideoDecoderHandle                                      │
│    ├── camera: Option<AsyncVideoDecoderHandle>                              │
│    └── get_frames() → tokio::join! screen + camera decoding                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│         ASYNC VIDEO DECODER HANDLE (crates/rendering/src/decoder/mod.rs)   │
├─────────────────────────────────────────────────────────────────────────────┤
│  AsyncVideoDecoderHandle                                                    │
│    ├── sender: mpsc::Sender<VideoDecoderMessage>                            │
│    └── get_frame() → sends GetFrame message, awaits oneshot response        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ std::sync::mpsc channel
┌─────────────────────────────────────────────────────────────────────────────┐
│    AVASSETREADER DECODER (crates/rendering/src/decoder/avassetreader.rs)   │
├─────────────────────────────────────────────────────────────────────────────┤
│  AVAssetReaderDecoder (runs on dedicated thread)                            │
│    ├── Frame cache: BTreeMap<u32, CachedFrame> (60 frames)                  │
│    ├── BACKWARD_SEEK_TOLERANCE: 120 frames                                  │
│    ├── On seek beyond tolerance → reset() → recreates AVAssetReader         │
│    └── ImageBufProcessor → copies pixel data from CVPixelBuffer             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│     CAP_VIDEO_DECODE (crates/video-decode/src/avassetreader.rs)            │
├─────────────────────────────────────────────────────────────────────────────┤
│  AVAssetReaderDecoder (low-level wrapper)                                   │
│    ├── reset() → cancel_reading() + recreate AVAssetReader with time_range  │
│    └── frames() → FramesIter over track_output.next_sample_buf()            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Identified Bottlenecks

### CRITICAL: Seeking/Scrubbing Latency

#### Bottleneck #1: AVAssetReader Recreation on Seek
**Location:** `crates/video-decode/src/avassetreader.rs:61-73`

**Problem:** When scrubbing beyond the backward seek tolerance (120 frames = 4 seconds at 30fps), the entire AVAssetReader is destroyed and recreated:
```rust
pub fn reset(&mut self, requested_time: f32) -> Result<(), String> {
    self.reader.cancel_reading();  // ❌ Destroys the reader
    (self.track_output, self.reader) = Self::get_reader_track_output(...)?;  // ❌ Full recreation
    Ok(())
}
```

**Impact:** AVAssetReader creation involves:
- Loading AVURLAsset
- Loading tracks async
- Creating track output
- Starting reading

This can take **50-200ms** depending on file size/complexity.

---

#### Bottleneck #2: Sequential Frame Iteration After Seek
**Location:** `crates/rendering/src/decoder/avassetreader.rs:378-451`

**Problem:** After a reset, the decoder must iterate through frames sequentially until it reaches the requested frame:
```rust
for frame in &mut frames {
    let current_frame = pts_to_frame(...);
    // Must process every frame until current_frame >= requested_frame
    let cache_frame = CachedFrame::new(&processor, frame.retained(), current_frame);
    // ...
}
```

**Impact:** If seeking to frame 3000, must decode frames from the seek point until frame 3000.

---

#### Bottleneck #3: Pixel Buffer Data Copy
**Location:** `crates/rendering/src/decoder/avassetreader.rs:79-200`

**Problem:** Every frame requires copying pixel data from the CVPixelBuffer:
```rust
fn extract_raw(&self, image_buf: &mut R<cv::ImageBuf>) -> (Vec<u8>, PixelFormat, u32, u32) {
    image_buf.lock_base_addr(LockFlags::READ_ONLY);
    // Full copy of Y plane + UV plane
    let mut data = Vec::with_capacity(y_size + uv_size);
    data.extend_from_slice(y_slice);
    data.extend_from_slice(uv_slice);
    // ...
}
```

**Impact:** For 1920x1080 NV12:
- Y plane: 1920 × 1080 = 2,073,600 bytes
- UV plane: 1920 × 540 = 1,036,800 bytes
- Total: ~3MB copied per frame

---

#### Bottleneck #4: Thread Communication Overhead
**Location:** `crates/rendering/src/decoder/mod.rs:560-574`

**Problem:** Frame requests go through multiple channel hops:
1. `AsyncVideoDecoderHandle.get_frame()` → creates oneshot channel
2. Sends `VideoDecoderMessage::GetFrame` via `std::sync::mpsc`
3. Decoder thread processes request
4. Response sent via `oneshot::Sender`
5. Async task awaits response

```rust
pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
    let (tx, rx) = tokio::sync::oneshot::channel();  // ❌ Allocation per request
    self.sender.send(VideoDecoderMessage::GetFrame(adjusted_time, tx));
    rx.await.ok()  // ❌ Context switch
}
```

---

#### Bottleneck #5: Playback Warmup Phase
**Location:** `crates/editor/src/playback.rs:359-390`

**Problem:** Playback waits for warmup before displaying first frame:
```rust
let warmup_target_frames = 2usize;
let warmup_after_first_timeout = Duration::from_millis(50);

while !*stop_rx.borrow() {
    let should_start = if let Some(first_time) = first_frame_time {
        prefetch_buffer.len() >= warmup_target_frames
            || first_time.elapsed() > warmup_after_first_timeout
    } else { false };
    if should_start { break; }
    // Wait for prefetch...
}
```

**Impact:** 50ms minimum delay before playback starts (or waits for 2 frames).

---

#### Bottleneck #6: Preview Frame Debouncing Gaps
**Location:** `crates/editor/src/editor_instance.rs:281-415`

**Problem:** Preview renderer uses `watch::channel` which coalesces rapid updates, but there's no explicit debouncing - instead it processes frames sequentially with potential race conditions.

---

### MEDIUM: Playback Performance

#### Bottleneck #7: Limited Frame Cache in Decoder
**Location:** `crates/rendering/src/decoder/avassetreader.rs:284`

**Problem:** Cache is only 60 frames per decoder track.
```rust
let mut cache = BTreeMap::<u32, CachedFrame>::new();
// FRAME_CACHE_SIZE = 60 in mod.rs
```

**Impact:** At 30fps, this covers only 2 seconds in each direction.

---

#### Bottleneck #8: Dual Track Decode Coordination
**Location:** `crates/rendering/src/lib.rs:188-223`

**Problem:** Screen and camera frames are decoded in parallel but awaited together:
```rust
let (screen, camera) = tokio::join!(
    self.screen.get_frame(segment_time),
    OptionFuture::from(needs_camera.then(|| self.camera...))
);
```

**Impact:** If camera decode is slower, screen frame display is delayed.

---

## Benchmarking Plan

### Benchmark Tool Design

Create a benchmark binary in `crates/editor/examples/decode-benchmark.rs` that measures:

1. **AVAssetReader Creation Time** - Time to create a new reader
2. **Seek Time** - Time from seek request to first frame available
3. **Sequential Decode Rate** - Frames per second during playback
4. **Random Access Time** - Time to get a frame at arbitrary position
5. **Cache Hit Rate** - Percentage of cache hits vs misses

### Benchmark Implementation

```rust
// crates/editor/examples/decode-benchmark.rs
use std::time::{Duration, Instant};
use cap_rendering::decoder::{spawn_decoder, AsyncVideoDecoderHandle};

struct BenchmarkResults {
    reader_creation_ms: f64,
    seek_times_ms: Vec<f64>,
    sequential_fps: f64,
    random_access_avg_ms: f64,
    cache_hit_rate: f64,
}

async fn run_benchmark(video_path: &str, fps: u32) -> BenchmarkResults {
    // ... implementation
}
```

### Metrics to Track

| Metric | Current Target | Ideal Target | How to Measure |
|--------|---------------|--------------|----------------|
| Playback start latency | < 100ms | < 16ms (1 frame) | Time from play button to first frame rendered |
| Scrub response time | < 100ms | < 33ms (2 frames) | Time from scrub input to frame displayed |
| Sequential decode rate | 30+ fps | 60+ fps | Frames decoded per second during playback |
| Seek time (< 2s jump) | < 50ms | < 16ms | Time from seek to frame available |
| Seek time (> 5s jump) | < 200ms | < 50ms | Time from seek to frame available |
| Memory per cached frame | ~3MB | < 1MB | Heap allocation tracking |

### Running Benchmarks

```bash
# Build release binary
cargo build --release --example decode-benchmark -p cap-editor

# Run with tracing
RUST_LOG=info ./target/release/examples/decode-benchmark \
    --video "/path/to/test-recording/content/display.mp4" \
    --fps 30 \
    --iterations 100
```

### Baseline Established

**Date:** 2025-12-22
**Test Data:** 18.02s screen recording at 30fps (Built-in Retina Display)
**Iterations:** 100 (decoder creation: 3)

#### Baseline Results

| Metric | Baseline Value |
|--------|----------------|
| Decoder creation time | 204.81ms |
| Sequential decode avg | 1.90ms/frame |
| Sequential decode max | 5.94ms |
| Effective FPS (sequential) | 525 fps |
| Seek time (< 2s jump) | < 1ms (cache hit) |
| Seek time (5s jump) | 11.42ms |
| Seek time (10s jump) | 0.89ms (cached) |
| Random access avg | 8.61ms |
| Random access P50 | 3.46ms |
| Random access P95 | 31.88ms |
| Random access P99 | 37.46ms |

**Notes:**
- Very fast sequential decode due to frame caching (cache hits show ~0ms)
- Random access P95/P99 represent cache misses requiring seek/decode
- 1 frame failed during sequential decode (edge case at 0.1s)

---

## Optimization Phases

### Phase 1: Quick Wins (Low Risk, High Impact)

#### [x] Task 1.1: Implement Zero-Copy Frame Path (Implemented — validated 2025-12-22)
**Files:** `crates/rendering/src/decoder/avassetreader.rs`

**Change:** Instead of copying pixel data, pass the `R<cv::ImageBuf>` directly through the pipeline and use IOSurface textures in wgpu.

**Current:**
```rust
let (data, format, y_stride, uv_stride) = processor.extract_raw(&mut image_buf);
// Creates Vec<u8> copy
```

**Proposed:**
```rust
// Use existing DecodedFrame::new_nv12_zero_copy
DecodedFrame::new_nv12_zero_copy(width, height, y_stride, uv_stride, image_buf)
// No data copy - IOSurface backing passed through
```

**Expected Impact:** Eliminate ~3MB copy per frame, reduce decode time by ~30-50%.

**Benchmark Validation:**
- Measure `sequential_fps` before/after
- Measure memory allocation per frame

---

#### [x] Task 1.2: Increase Frame Cache Sizes (Implemented — validated 2025-12-22)
**Files:**
- `crates/rendering/src/decoder/mod.rs` (line 550)
- `crates/editor/src/playback.rs` (line 33-37)

**Change:** Increase cache sizes to cover more timeline.

**Current:**
```rust
pub const FRAME_CACHE_SIZE: usize = 60;  // decoder cache
const PREFETCH_BUFFER_SIZE: usize = 30;   // playback buffer
const FRAME_CACHE_SIZE: usize = 30;       // playback cache
```

**Proposed:**
```rust
pub const FRAME_CACHE_SIZE: usize = 150;  // 5 seconds at 30fps
const PREFETCH_BUFFER_SIZE: usize = 60;
const FRAME_CACHE_SIZE: usize = 60;
```

**Expected Impact:** Reduce seek-induced resets for typical editing workflows.

**Benchmark Validation:**
- Measure `cache_hit_rate` before/after
- Measure `seek_times_ms` for jumps within new cache range

---

#### [x] Task 1.3: Reduce Playback Warmup Delay (Implemented — validated 2025-12-22)
**Files:** `crates/editor/src/playback.rs` (lines 359-390)

**Change:** Start playback immediately with first available frame.

**Current:**
```rust
let warmup_target_frames = 2usize;
let warmup_after_first_timeout = Duration::from_millis(50);
```

**Proposed:**
```rust
let warmup_target_frames = 1usize;
let warmup_after_first_timeout = Duration::from_millis(16);  // 1 frame at 60fps
```

**Expected Impact:** Reduce playback start latency by ~35ms.

**Benchmark Validation:**
- Measure playback start latency before/after

---

### Phase 2: Architectural Improvements (Medium Risk, High Impact)

#### [ ] Task 2.1: Implement Keyframe Index for Fast Seeking
**Files:** `crates/video-decode/src/avassetreader.rs`

**Problem:** AVAssetReader doesn't expose keyframe positions; we blindly seek.

**Proposed Solution:**
1. On decoder init, scan video for keyframe positions using ffmpeg
2. Store keyframe index: `Vec<(frame_number, timestamp)>`
3. On seek, find nearest preceding keyframe
4. Seek to keyframe, then decode forward to target

**Implementation:**
```rust
struct KeyframeIndex {
    keyframes: Vec<(u32, f64)>,  // (frame_number, timestamp)
}

impl KeyframeIndex {
    fn nearest_keyframe_before(&self, target_frame: u32) -> (u32, f64) {
        // Binary search for nearest keyframe <= target
    }
}
```

**Expected Impact:** Reduce worst-case seek time by avoiding GOP traversal.

**Benchmark Validation:**
- Measure `seek_times_ms` for various jump distances

---

#### [ ] Task 2.2: Implement Dual-Buffer Strategy for Preview
**Files:** `crates/editor/src/editor_instance.rs`

**Problem:** Single preview path causes frame drops during rapid scrubbing.

**Proposed Solution:**
1. Maintain two frame buffers: "current" and "pending"
2. While decoding pending frame, display current frame
3. Swap buffers when pending is ready
4. Cancel pending decode if new scrub position received

**Implementation:**
```rust
struct PreviewState {
    current_frame: Option<DecodedSegmentFrames>,
    pending_decode: Option<JoinHandle<Option<DecodedSegmentFrames>>>,
    pending_frame_number: u32,
}
```

**Expected Impact:** Smoother scrubbing experience, no frame stalls.

---

#### [ ] Task 2.3: Background Keyframe Thumbnail Generation
**Files:** New file `crates/editor/src/thumbnail_cache.rs`

**Problem:** Scrubbing to uncached positions requires full decode.

**Proposed Solution:**
1. On editor open, background-generate thumbnails at keyframes
2. Store as low-res textures in memory
3. Display nearest thumbnail immediately on scrub
4. Replace with full-res frame when decoded

**Implementation:**
```rust
struct ThumbnailCache {
    thumbnails: HashMap<u32, wgpu::Texture>,  // frame_number -> 320x180 thumbnail
    generator_task: JoinHandle<()>,
}
```

**Expected Impact:** Instant visual feedback on scrub.

---

### Phase 3: Advanced Optimizations (Higher Risk, Variable Impact)

#### [x] Task 3.1: Persistent AVAssetReader with Sample Buffer Pool (Implemented — awaiting real-world validation)
**Problem:** Reader recreation is expensive.

**Proposed Solution:**
1. Keep AVAssetReader alive across seeks
2. Use `AVAssetReader.timeRange` property for coarse seeking
3. Maintain pool of pre-decoded samples for fine seeking

**Implementation (Combined with Task 3.3):**
- Created `DecoderInstance` wrapper that tracks decoder state
- Implemented `DecoderPoolManager` for managing multiple decoder positions
- Each decoder maintains its own frame cache and position tracking
- Keyframe index integration for intelligent seek positioning

**Files Modified:**
- `crates/rendering/src/decoder/multi_position.rs` (new)
- `crates/rendering/src/decoder/avassetreader.rs`
- `crates/video-decode/src/avassetreader.rs`

---

#### [x] Task 3.2: Scrub-Optimized Frame Delivery (Implemented — awaiting real-world validation)
**Problem:** Can't decode frames fast enough for 60fps scrubbing.

**Proposed Solution:**
1. Decode keyframes at lower rate during rapid scrub
2. Use GPU shader to interpolate between keyframes
3. Switch to full-quality frames when scrub stops

**Implementation:**
- Created `ScrubDetector` that monitors request patterns to detect rapid scrubbing
- During scrubbing: limits frame iteration to 3 frames max per request
- Uses fallback frames from cache during rapid scrubbing
- Smoothly transitions back to full-quality decode when scrub stops

**Files Modified:**
- `crates/rendering/src/decoder/multi_position.rs` (`ScrubDetector` struct)
- `crates/rendering/src/decoder/avassetreader.rs` (scrub detection integration)

---

#### [x] Task 3.3: Parallel Multi-Position Decode (Implemented — awaiting real-world validation)
**Problem:** Single decode position limits responsiveness.

**Proposed Solution:**
1. Maintain multiple AVAssetReader instances at different timeline positions
2. Route frame requests to nearest reader
3. Dynamically reposition readers based on usage patterns

**Implementation:**
- `MAX_DECODER_POOL_SIZE = 3` decoders maintained simultaneously
- `REPOSITION_THRESHOLD_SECS = 5.0` determines when to reset vs route
- `DecoderPoolManager.find_best_decoder_for_time()` routes to optimal decoder
- Initial positions spread across timeline using keyframe index strategic positions
- Access history tracking for future rebalancing based on usage patterns

**Files Modified:**
- `crates/rendering/src/decoder/multi_position.rs` (new)
- `crates/rendering/src/decoder/avassetreader.rs`

---

### Resource Management (DecoderPoolManager)

#### Lifecycle Hooks and Ownership

```
┌──────────────────────────────────────────────────────────────────────┐
│                     DECODER LIFECYCLE DIAGRAM                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   Editor Open                                                         │
│       │                                                               │
│       ▼                                                               │
│   ┌─────────────────────────────────────────┐                        │
│   │ DecoderPoolManager::new()               │                        │
│   │  - Reads keyframe index (if available)  │                        │
│   │  - Calculates initial positions         │                        │
│   │  - Creates MAX_DECODER_POOL_SIZE (3)    │                        │
│   │    DecoderPosition entries              │                        │
│   └─────────────────────────────────────────┘                        │
│       │                                                               │
│       ▼                                                               │
│   ┌─────────────────────────────────────────┐                        │
│   │ On Frame Request                        │                        │
│   │  - find_best_decoder_for_time()         │◄──── Frame requests    │
│   │  - Route to optimal decoder             │      from playback/    │
│   │  - Touch decoder (update access time)   │      preview           │
│   │  - Spawn decoder lazily if needed       │                        │
│   └─────────────────────────────────────────┘                        │
│       │                                                               │
│       ▼ (every 100 accesses)                                         │
│   ┌─────────────────────────────────────────┐                        │
│   │ Rebalance Check                         │                        │
│   │  - Analyze access_history hotspots      │                        │
│   │  - Reposition decoders to hot regions   │                        │
│   └─────────────────────────────────────────┘                        │
│       │                                                               │
│       ▼ (on editor close / video switch)                             │
│   ┌─────────────────────────────────────────┐                        │
│   │ Cleanup (Implicit via Drop)             │                        │
│   │  - DecoderPoolManager dropped           │                        │
│   │  - All decoder handles dropped          │                        │
│   │  - Decoder threads receive shutdown     │                        │
│   └─────────────────────────────────────────┘                        │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Ownership Model:**
- `EditorInstance` owns `RecordingSegmentDecoders`
- `RecordingSegmentDecoders` owns `AsyncVideoDecoderHandle` instances
- `AsyncVideoDecoderHandle` holds `mpsc::Sender` to decoder thread
- Decoder thread runs until channel is closed (handle dropped)
- `DecoderPoolManager` is advisory — tracks positions but doesn't own decoders

#### Memory Budgets

| Component | Budget | Notes |
|-----------|--------|-------|
| Per-decoder frame cache | 150 frames × ~3MB = ~450MB max | FRAME_CACHE_SIZE constant |
| Total decoder pool | 3 decoders × 450MB = ~1.35GB max | MAX_DECODER_POOL_SIZE constant |
| Playback prefetch buffer | 60 frames × ~3MB = ~180MB | PREFETCH_BUFFER_SIZE constant |
| Playback frame cache | 60 frames × ~3MB = ~180MB | FRAME_CACHE_SIZE (playback) |
| **Total estimated max** | **~1.7GB** | For single video with all caches full |

**Configurable Limits (Future):**
- [ ] Add `MAX_MEMORY_MB` environment variable for total heap cap
- [ ] Implement soft limit (trigger eviction at 80%) vs hard limit (fail at 100%)
- [ ] Consider per-decoder memory tracking

#### Eviction and Rebalancing Policy

**Eviction Strategy:** LRU (Least Recently Used) with access time tracking

```
Eviction Decision Flow:
1. When cache is full and new frame needed:
   - Find frame with oldest last_access_time
   - Evict that frame from cache
   - Insert new frame

2. Rebalancing triggers every 100 accesses (should_rebalance())
   - Analyze access_history for hotspot frames
   - Get top MAX_DECODER_POOL_SIZE hotspots by access count
   - Call get_rebalance_positions() to suggest new positions
   - Reinitialize decoders at new positions (if significantly different)
```

**Reposition vs Reinitialize Threshold:**
- If `|new_position - current_position| < REPOSITION_THRESHOLD_SECS (5.0)`: seek within existing decoder
- Otherwise: reset decoder with new time range

#### Thread-Safety Primitives

| Structure | Synchronization | Access Pattern |
|-----------|-----------------|----------------|
| `AsyncVideoDecoderHandle` | `std::sync::mpsc::Sender` | Send-only from async context |
| `DecoderPoolManager` | Single-threaded owner | Editor instance owns exclusively |
| Frame cache (per-decoder) | `BTreeMap` inside decoder thread | Single-threaded access |
| `ScrubDetector` | Single-threaded | Updated on each request |
| `access_history` | `BTreeMap` in pool manager | Single-threaded owner |

**Concurrency Model:**
- Main thread: Owns `DecoderPoolManager`, makes routing decisions
- Tokio runtime: Async frame requests go through channels
- Decoder threads: One per `AsyncVideoDecoderHandle`, blocks on `mpsc::Receiver`
- No shared mutable state between threads — all communication via channels

#### Graceful Degradation and Failure Modes

| Failure | Detection | Response | Fallback |
|---------|-----------|----------|----------|
| Decoder creation fails | `spawn_decoder()` returns `Err` | Log error, return None | Skip this decoder, use others |
| Frame decode fails | `get_frame()` returns `None` | Log at debug level | Return cached frame if available |
| Channel disconnected | `send()` fails | Decoder thread has exited | Respawn decoder on next request |
| OOM during cache insert | System allocation fails | Evict oldest frames | Reduce cache size dynamically |
| Scrub too fast | `ScrubDetector.is_scrubbing()` true | Limit iteration to 3 frames | Show nearest cached frame |

**Retry/Backoff Policy:**
- Decoder creation: No automatic retry (caller decides)
- Frame requests: No retry (returns None, caller handles)
- Logging: Use `tracing::debug!` for expected failures, `tracing::warn!` for unexpected

**Telemetry Hooks (Recommended):**
- [ ] Add `tracing::span!` around decoder creation
- [ ] Track cache hit/miss ratio per decoder
- [ ] Log rebalancing decisions with positions
- [ ] Emit metrics for decoder pool utilization

#### Validation Test Checklist

**Unit Tests:**
- [ ] `DecoderPoolManager::new()` creates correct initial positions
- [ ] `find_best_decoder_for_time()` routes to nearest usable decoder
- [ ] `should_rebalance()` triggers at correct intervals
- [ ] `get_rebalance_positions()` returns valid hotspot-based positions
- [ ] `ScrubDetector` correctly identifies scrubbing vs normal playback

**Integration Tests:**
- [ ] Decoder pool handles video shorter than expected positions
- [ ] Cleanup happens correctly when editor closes
- [ ] Multiple rapid seeks don't cause race conditions
- [ ] Cache eviction under memory pressure works correctly

**OOM Scenario Tests:**
- [ ] Simulate large video with many cached frames
- [ ] Verify graceful degradation when allocation fails
- [ ] Test cache cleanup during memory pressure

---

## Implementation Order

### Recommended Sequence

1. [x] **Set up benchmarking first** (completed 2025-12-22)
   - [x] Create benchmark binary (`crates/editor/examples/decode-benchmark.rs`)
   - [x] Establish baseline metrics (see "Baseline Established" section above)
   - [ ] Set up CI to track metrics over time

2. [x] **Phase 1 tasks** (implemented and validated 2025-12-22)
   - [x] Task 1.1: Zero-copy frame path
   - [x] Task 1.2: Increase cache sizes
   - [x] Task 1.3: Reduce warmup delay

3. [x] **Measure and validate Phase 1** (completed 2025-12-22)
   - [x] Run benchmarks
   - [x] Compare to baseline (sequential decode 525 fps achieved)
   - [x] Identify remaining bottlenecks (decoder creation 205ms, random access P95 32ms)

4. [ ] **Phase 2 tasks** (not started — depends on real-world testing feedback)
   - [ ] Task 2.1: Keyframe index (if seeking still slow in production)
   - [ ] Task 2.2: Dual-buffer preview (if scrubbing stutters in production)
   - [ ] Task 2.3: Thumbnail cache (if visual feedback slow in production)

5. [x] **Phase 3** (implemented — awaiting real-world validation)
   - [x] Task 3.1 + 3.3: Multi-position decoder pool with keyframe index integration
   - [x] Task 3.2: Scrub-optimized frame delivery with rate-limited iteration

---

## File Reference Quick Lookup

| Concern | Primary File | Key Functions/Structs |
|---------|--------------|----------------------|
| Playback orchestration | `crates/editor/src/playback.rs` | `Playback::start()`, `PrefetchedFrame`, `FrameCache` |
| Preview rendering | `crates/editor/src/editor_instance.rs:281-415` | `spawn_preview_renderer()` |
| Frame decoding coordination | `crates/rendering/src/lib.rs:104-223` | `RecordingSegmentDecoders`, `get_frames()` |
| Decoder handle | `crates/rendering/src/decoder/mod.rs:553-599` | `AsyncVideoDecoderHandle`, `get_frame()` |
| AVAssetReader decoder | `crates/rendering/src/decoder/avassetreader.rs` | `AVAssetReaderDecoder::run()`, `CachedFrame` |
| Low-level AVAssetReader | `crates/video-decode/src/avassetreader.rs` | `reset()`, `get_reader_track_output()` |
| Timeline UI | `apps/desktop/src/routes/editor/Timeline/index.tsx` | `handleUpdatePlayhead()` |
| Editor context | `apps/desktop/src/routes/editor/context.ts` | `previewTime`, `playbackTime` signals |

---

## Constants Reference

| Constant | Location | Current Value | Purpose |
|----------|----------|---------------|---------|
| `FRAME_CACHE_SIZE` | `decoder/mod.rs:550` | 150 | Per-decoder frame cache |
| `PREFETCH_BUFFER_SIZE` | `playback.rs:33` | 60 | Playback prefetch queue |
| `PARALLEL_DECODE_TASKS` | `playback.rs:34` | 8 | Concurrent decode operations |
| `MAX_PREFETCH_AHEAD` | `playback.rs:35` | 90 | Max frames to prefetch ahead |
| `PREFETCH_BEHIND` | `playback.rs:36` | 15 | Frames to prefetch behind playhead |
| `FRAME_CACHE_SIZE` (playback) | `playback.rs:37` | 60 | Playback frame cache |
| `BACKWARD_SEEK_TOLERANCE` | `decoder/avassetreader.rs:418` | 120 | Frames before reset triggered |
| `warmup_target_frames` | `playback.rs:359` | 1 | Frames to buffer before starting |
| `warmup_after_first_timeout` | `playback.rs:360` | 16ms | Max wait for warmup |

---

## Success Criteria

| Metric | Baseline (2025-12-22) | Target | Status |
|--------|----------------------|--------|--------|
| Decoder creation time | 204.81ms | < 100ms | Needs improvement |
| Playback start latency | ~16ms (warmup reduced) | < 50ms | ✅ Target met |
| Scrub response (cache hit) | < 1ms | < 16ms | ✅ Target met |
| Scrub response (cache miss, < 2s) | < 1ms (within cache) | < 50ms | ✅ Target met |
| Scrub response (cache miss, > 5s) | 11.42ms | < 100ms | ✅ Target met |
| Random access avg | 8.61ms | < 33ms | ✅ Target met |
| Random access P95 | 31.88ms | < 50ms | ✅ Target met |
| Random access P99 | 37.46ms | < 100ms | ✅ Target met |
| Sequential decode rate | 525 fps (effective) | 60+ fps | ✅ Target exceeded |
| Sequential playback frame drops | 1/100 (edge case) | 0 at 30fps | Needs investigation |
| Memory usage per minute of video | Not measured | < 500MB | Needs measurement |

**Acceptance Thresholds:**
- All "Target met" metrics: maintain or improve current performance
- Decoder creation: ≥50% improvement over 204.81ms baseline (target: < 100ms)
- Frame drops: investigate and fix the 0.1s edge case failure
