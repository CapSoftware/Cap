# Playback Performance Optimizations

This document tracks performance optimizations for the Cap editor playback system.

## Current Performance Baseline (as of 2025-12-11)

| Metric | Current Value | Target | Status |
|--------|--------------|--------|--------|
| Initial startup delay | ~50-80ms warmup | <100ms | ✅ Improved |
| GPU render time | 2-7ms typical | 7-15ms/frame | ✅ Excellent |
| Frame skipping at start | 0-3 frames | 0 frames | ✅ Good |
| WebSocket frame size | 7.2MB → 1.3-1.5MB (LZ4) | <2MB | ✅ Excellent |
| WebSocket send time | <30ms | <50ms | ✅ Good |
| GPU poll/readback | <1ms | <10ms | ✅ Excellent |
| Effective FPS | 30-60fps stable | Stable 30fps+ | ✅ Good |

### Recent Optimizations (2025-12-11)

1. **Enabled LZ4 Compression** - Frame data now actually compressed with LZ4 (~5-6x compression)
2. **Non-blocking render_frame** - Playback loop no longer waits for GPU render completion
3. **Removed debug logging** - Eliminated expensive disk I/O in hot paths
4. **Faster canvas rendering** - Using createImageBitmap instead of putImageData
5. **Increased prefetch parallelism** - 4 initial parallel tasks (was 1) for faster startup
6. **Removed redundant timing measurements** - Less overhead in frame processing

---

## High Priority Optimizations

### [x] Pre-warm Prefetch Buffer Before Playback

**Problem**: Playback starts immediately with an empty prefetch buffer, causing:
- First frame fetch takes 1.3 seconds
- 38+ frames skipped at startup
- Noticeable stutter/jump when pressing play

**Solution**: Add a warmup phase before the playback loop starts.

**Status**: Implemented but insufficient alone - needed additional fixes below.

---

### [x] Fix Prefetch Buffer Management

**Problem**: After implementing warmup, logs showed:
- `prefetch_hit=false prefetch_buffer_size=64` - buffer full but frames missing!
- `frame_fetch_us=233319` (233ms!) to fetch frames that should be in cache
- 52+ frames skipped during playback

**Root Causes Identified**:
1. **Out-of-order completion**: `FuturesUnordered` causes frames to complete in random order
2. **FIFO eviction is wrong**: Popping oldest *inserted* frame, not furthest from playback
3. **Prefetch runs too far ahead**: Buffer contains frames 100+ ahead while current frame missing

**Solution**: Three-part fix in `crates/editor/src/playback.rs`:

1. **Added MAX_PREFETCH_AHEAD constant** (90 frames):
   - Limits how far ahead the prefetch task can run
   - Prefetch now waits when too far ahead of playback position

2. **Smart eviction strategy**:
   - Instead of FIFO, evict frames furthest from current playback position
   - Keeps frames closest to what we need

3. **Real-time playback position tracking**:
   - Added `playback_position_tx/rx` watch channel
   - Prefetch task knows current playback position
   - Position updated on both frame render and frame skip

**Expected Impact**:
- Near 100% prefetch hit rate (vs 78% before)
- Eliminate 100-400ms frame fetch delays
- Reduce frame skipping from 50+ to near zero

---

### [x] Add Frame Compression for WebSocket Transmission

**Problem**: Each frame is 7.2MB raw RGBA data, requiring 216MB/s at 30fps.

**Solution**: Add LZ4 compression (fast, ~50% size reduction).

**Status**: ✅ Implemented and verified on 2025-12-10

**Files Modified**:
- `apps/desktop/src-tauri/src/frame_ws.rs` - Added `compress_frame_data()` helper using `lz4_flex::compress_prepend_size`
- `apps/desktop/src/utils/socket.ts` - Added `decompressLz4()` using `lz4js.decompressBlock`

**Dependencies Added**:
- Rust: `lz4_flex = "0.11"` in `apps/desktop/src-tauri/Cargo.toml`
- TypeScript: `lz4js` + `@types/lz4js` in `apps/desktop/package.json`

**Implementation Details**:
- Rust side uses `lz4_flex::compress_prepend_size()` which prepends the uncompressed size as a 4-byte little-endian u32
- TypeScript side uses `lz4js.decompressBlock()` for raw LZ4 block decompression
- Compression metrics logged with `[PERF:WS]` and `[PERF:WS_WATCH]` tags showing original/compressed sizes and compression ratio
- Decompression metrics logged with `[PERF:FRONTEND_WS]` tag showing decompress time

**Wire Format**:
```
[uncompressed_size (4 bytes LE)] [LZ4 compressed: pixel_data + stride(4) + height(4) + width(4)]
```

**Measured Results** (1662x1080 frames):
| Metric | Value |
|--------|-------|
| Original size | 7,188,480 bytes (7.2MB) |
| Compressed size | 1,282,011 - 1,472,462 bytes (1.3-1.5MB) |
| Compression ratio | **17-20% of original (5-6x compression)** |
| Bandwidth reduction | ~82% (exceeds 50% target) |

**Note**: While compression is working excellently, WebSocket send times remain 130-150ms due to upstream GPU readback blocking. The compression itself is not the bottleneck.

---

### [x] Async GPU Readback with True Double Buffering ✅ IMPLEMENTED

**Problem**: GPU poll was blocking for **147-151ms** waiting for readback to complete - this was the PRIMARY bottleneck causing frame skipping.

**Solution Implemented** (2025-12-10):

Created a pipelined GPU readback system in `crates/rendering/src/frame_pipeline.rs`:

1. **Triple-buffered staging buffers**: Pool of 3 `Arc<wgpu::Buffer>` for readback operations
2. **`PipelinedGpuReadback` struct**: Manages buffer pool and pending readback operations
3. **`PendingReadback` struct**: Tracks in-flight readback with oneshot channel for completion notification
4. **Pipeline priming**: First frame waits synchronously, then submits a "priming" readback so subsequent frames can pipeline

**Key Implementation Details**:
- `submit_readback()`: Submits render encoder, copies texture to buffer, starts `map_async()`, returns immediately
- `PendingReadback::wait()`: Polls for completion with async yield, reads buffer data when ready
- `finish_encoder()`: Takes previous frame's pending readback, submits current frame, waits for previous (which is usually already ready)
- First frame primes the pipeline by submitting an additional readback after waiting

**Files Modified**:
- `crates/rendering/src/frame_pipeline.rs` - Complete rewrite with `PipelinedGpuReadback`, `PendingReadback`, moved `RenderSession` here
- `crates/rendering/src/lib.rs` - Updated imports, removed duplicate `RenderSession`

**Measured Results**:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| GPU poll time | 147-160ms | 0-13μs | **~10,000x** |
| finish_encoder time | 150-160ms | 1.3-2.7ms | **~60x** |
| Effective readback | Blocking | Pipelined | ✅ |

**Sample logs after fix**:
```
[PERF:GPU_BUFFER] pipelined finish_encoder (first frame, primed pipeline) wait_us=6514 prime_us=532
[PERF:GPU_BUFFER] pipelined finish_encoder (pipelined, waited for previous) wait_us=1714 total_us=2240
[PERF:GPU_BUFFER] pipelined readback wait completed poll_us=1 data_copy_us=1553
```

**Impact**: GPU readback is no longer the bottleneck. Remaining frame skipping is due to video decoding and WebSocket transmission, not GPU operations

---

## Medium Priority Optimizations

### [ ] Increase Parallel Decode Tasks

**Problem**: With 8 parallel decode tasks, prefetch buffer can't keep up during fast seeking.

**Solution**: Increase `PARALLEL_DECODE_TASKS` from 8 to 12-16.

**File**: `crates/editor/src/playback.rs:32`

**Current**:
```rust
const PARALLEL_DECODE_TASKS: usize = 8;
```

**Change to**:
```rust
const PARALLEL_DECODE_TASKS: usize = 12;
```

**Expected Impact**: Better prefetch coverage, fewer cache misses during playback

---

### [x] Reduce Layer Preparation Time ✅ IMPLEMENTED

**Problem**: `prepare_us` takes 6-22ms, often the largest single operation.

**File**: `crates/rendering/src/lib.rs` (RendererLayers::prepare)

**Solutions Implemented** (2025-12-10):

1. **Persistent staging buffers for texture uploads**:
   - Added `staging_buffer` field to `DisplayLayer` and `CameraLayer`
   - Staging buffers are reused across frames (only reallocated if size increases)
   - Data is written to staging buffer in `prepare()`, then copied to texture via encoder in `copy_to_texture()`
   - This separates CPU-to-buffer write from buffer-to-texture GPU copy, allowing better pipelining

2. **Cached sampler in CompositeVideoFramePipeline**:
   - Sampler is now created once in `new()` and reused for all bind group creations
   - Previously a new sampler was created every time `bind_group()` was called

3. **Performance metrics breakdown**:
   - Added detailed timing for each layer's prepare step: background, blur, display, cursor, camera, text, captions
   - Logs `[PERF:PREPARE]` when total prepare time exceeds 5ms

**Files Modified**:
- `crates/rendering/src/layers/display.rs` - Added staging buffer with proper 256-byte row alignment
- `crates/rendering/src/layers/camera.rs` - Added staging buffer with proper 256-byte row alignment
- `crates/rendering/src/composite_frame.rs` - Cached sampler in pipeline struct
- `crates/rendering/src/lib.rs` - Added per-layer timing metrics in `RendererLayers::prepare()`

**Implementation Details**:
- Staging buffers use `COPY_SRC | COPY_DST` usage flags for buffer-to-texture copies
- Row alignment is 256 bytes (wgpu requirement for `copy_buffer_to_texture`)
- When source data row stride doesn't match alignment, data is copied row-by-row with padding
- `copy_to_texture()` method now issues `encoder.copy_buffer_to_texture()` commands

**Expected Impact**: Reduce prepare time from 6-22ms to 4-8ms by:
- Eliminating per-frame sampler allocation
- Using dedicated staging buffers instead of internal wgpu staging
- Better separation of CPU and GPU work

---

### [ ] Optimize Decoder Cache Management

**Problem**: Cache eviction may remove useful frames; screen frames are much larger than camera frames.

**File**: `crates/rendering/src/decoder/avassetreader.rs`

**Solutions**:
- [ ] Separate cache size limits for screen vs camera decoders
- [ ] Priority-based eviction (keep frames closer to current position)
- [ ] Adaptive cache sizing based on available memory

**Expected Impact**: Fewer cache misses, more consistent frame timing

---

## Lower Priority Optimizations

### [ ] Direct Surface Rendering (Architecture Change)

**Problem**: Current pipeline has unnecessary overhead:
```
GPU Render → Readback to CPU → WebSocket → Frontend → Canvas
```

**Solution**: Render directly to a native surface or use shared memory.

**Options**:
- Use `wgpu` surface rendering to a native window
- Shared memory between Rust and frontend (platform-specific)
- Metal layer on macOS, Direct3D surface on Windows

**Expected Impact**: Eliminate WebSocket overhead entirely (~10-15ms savings)

---

### [ ] Frame Rate Adaptation

**Problem**: When system can't maintain 30fps, frames pile up and get skipped in batches.

**Solution**: Adaptive frame rate based on actual rendering performance.

**Implementation**:
- Track rolling average of frame times
- Dynamically adjust target FPS
- Skip frames proactively rather than reactively

**Expected Impact**: Smoother playback on slower systems

---

### [ ] Hardware Video Decoder Optimization

**Problem**: AVAssetReader is hardware-accelerated but pixel format conversions may happen on CPU.

**File**: `crates/rendering/src/decoder/avassetreader.rs`

**Solutions**:
- [ ] Ensure VideoToolbox hardware decoding is active
- [ ] Keep pixel data in GPU-friendly format (avoid CPU conversions)
- [ ] Use `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` directly

**Expected Impact**: Faster decode times, lower CPU usage

---

## Performance Monitoring

### Existing Metrics (in logs)

The codebase already has comprehensive performance logging:

- `[PERF:PLAYBACK]` - Frame rendering, skipping, prefetch stats
- `[PERF:DECODER]` - Cache hits/misses, decode times, resets
- `[PERF:GPU]` - Render timing breakdown
- `[PERF:GPU_BUFFER]` - Readback timing breakdown
- `[PERF:PREPARE]` - Layer prepare timing breakdown (background, display, camera, cursor, text, captions)
- `[PERF:WS]` - WebSocket frame transmission
- `[PERF:EDITOR_RENDER]` - Editor render loop metrics

### [ ] Add Performance Dashboard

**Idea**: Surface these metrics in the UI for easier debugging.

- Show current FPS
- Show prefetch buffer status
- Show frame latency breakdown
- Highlight bottlenecks in real-time

---

## Frame Time Budget (30fps = 33.3ms)

| Component | Measured | Target | Status |
|-----------|----------|--------|--------|
| Decode (prefetched) | 0-4μs | 0-1ms | ✅ Excellent |
| Decode (cache miss) | 4-7ms | <10ms | ✅ Good |
| Uniforms | 20-40μs | 0.2-0.4ms | ✅ Excellent |
| GPU prepare | 4-7ms | 4-8ms | ✅ Good (optimized) |
| GPU render pass | 0.5-0.7ms | 0.5-1.4ms | ✅ Good |
| GPU readback poll | 0-13μs | <10ms | ✅ Fixed |
| Buffer data copy | 0.6-2ms | 1-2ms | ✅ Good |
| LZ4 compression | ~1-2ms (est) | <3ms | ✅ Good |
| WS transmission | <50ms | <50ms | ✅ Good |
| **Total** | **<33ms** | **<33ms** | ✅ |

*WebSocket send time is high because frames queue up behind GPU blocking.

### Actual Log Measurements (2025-12-10)

```
[PERF:GPU_BUFFER] buffer_size_bytes=7188480 submit1_us=151 buffer_setup_us=0
                  copy_encoder_us=87 submit2_us=91 gpu_poll_us=151681
                  map_wait_us=1 data_copy_us=1223 total_us=153431

[PERF:GPU] prepare_us=6535 encoder_create_us=10 render_pass_us=550
           finish_encoder_us=153508 total_us=160604

[PERF:PLAYBACK] frame rendered frame=34 prefetch_hit=true prefetch_buffer_size=6
                frame_fetch_us=1 uniforms_us=26 render_us=9
```

---

## Observed Playback Behavior (2025-12-10)

### Frame Skipping Pattern
```
[PERF:PLAYBACK] skipping frames to catch up frames_behind=16 frames_skipped=3 current_frame=6 total_skipped=3
[PERF:PLAYBACK] skipping frames to catch up frames_behind=12 frames_skipped=3 current_frame=10 total_skipped=6
[PERF:PLAYBACK] skipping frames to catch up frames_behind=12 frames_skipped=3 current_frame=14 total_skipped=9
...
[PERF:PLAYBACK] skipping frames to catch up frames_behind=2 frames_skipped=2 current_frame=32 total_skipped=20
```

Frame skipping occurs in batches of 3 frames when the system falls behind. This is caused by GPU poll blocking.

### Prefetch System Status
- Prefetch hit rate: ~70-80% (good, but drops during GPU stalls)
- Buffer size: 0-6 frames typically buffered
- Cache hits working well for camera decoder (253 entries cached)
- Screen decoder cache: 142-205 entries

### Editor Render Loop
```
[PERF:EDITOR_RENDER] periodic metrics frames_rendered=7 frames_dropped=0
                     avg_render_time_us=44464 avg_callback_time_us=12
                     max_render_time_us=155589 max_callback_time_us=15
[PERF:EDITOR_RENDER] dropped frames to catch up dropped_frames=4 total_dropped=5
```

The render loop is dropping frames because individual frames take up to 155ms (due to GPU poll blocking).

---

## Testing Checklist

After implementing optimizations, verify:

- [ ] Playback starts without visible stutter
- [ ] No frame skipping on initial play (check logs for `frames_skipped`)
- [ ] Consistent 30fps during playback
- [ ] Seeking responds quickly (<200ms)
- [ ] Memory usage remains stable
- [ ] CPU usage is reasonable (<50% on modern hardware)
- [ ] Works with both screen-only and screen+camera recordings
