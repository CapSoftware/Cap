# Editor Video Playback Optimizations

## Quick Wins (Low Effort, High Impact)

- [x] 1. **Replace lz4js with WASM LZ4**
  - Current: Using `lz4js` (pure JavaScript) for decompression in `frame-worker.ts:28-41`
  - Change: Replace with a WASM-based LZ4 decoder (e.g., `lz4-wasm` or compile LZ4 to WASM directly)
  - Impact: WASM typically runs 2-5x faster than pure JS for compute-heavy operations
  - Done: Replaced with `lz4-wasm` package which uses the same size-prepended format as `lz4_flex`

- [x] 2. **Remove debug file writes and console logging**
  - Current: Extensive debug logging with file writes at multiple points in `playback.rs`
  - Change: Removed all debug file writes from `playback.rs` and removed performance logging from `socket.ts` and `context.ts`
  - Impact: Eliminates file I/O overhead and reduces console noise

- [ ] 3. **Cache project config between frames**
  - Current: `self.project.borrow().clone()` called every frame at `playback.rs:523`
  - Change: Cache project config and only re-clone when it actually changes (use `watch::has_changed`)
  - Impact: Reduces allocation and cloning overhead per frame

- [ ] 4. **Use WebGL for canvas rendering**
  - Current: Using 2D canvas context at `Player.tsx:478-484`
  - Change: GPU-accelerated image scaling and display instead of 2D canvas
  - Impact: Hardware-accelerated rendering with better scaling quality

## Medium Effort

- [ ] 5. **OffscreenCanvas in worker**
  - Current: ImageBitmap created in worker, transferred to main thread, drawn on main thread canvas
  - Change: Move canvas rendering entirely to the worker using OffscreenCanvas
  - Impact: Eliminates main thread rendering jank entirely

- [ ] 6. **WebSocket transfer overhead / SharedArrayBuffer**
  - Current: Each frame transfers an ArrayBuffer to the worker via `postMessage`, incurring serialization overhead
  - Change: Use `SharedArrayBuffer` for zero-copy frame transfer between main thread and worker
  - Impact: Could reduce frame transfer time by 50-80% for large frames
  - Note: Requires COOP/COEP headers

- [ ] 7. **Dynamic prefetch buffer sizing**
  - Current: Fixed `PREFETCH_BUFFER_SIZE = 180` frames at `playback.rs:31`
  - Change: Adjust based on available memory and video resolution
  - Impact: Better memory utilization and prefetch efficiency

- [ ] 8. **Debounce canvas size calculations**
  - Current: Canvas size recalculated every frame via reactive computations at `Player.tsx:562-574`
  - Change: Debounce size calculations and only update canvas dimensions when container actually resizes
  - Impact: Reduces reactive computation overhead

- [ ] 9. **Eliminate stride mismatch copies**
  - Current: In `frame-worker.ts:92-113`, when stride differs from expected row bytes, there's a row-by-row copy loop
  - Change: Request matching stride from Rust side to avoid the copy, or use WASM/SIMD for the stride correction
  - Impact: Eliminates per-frame buffer manipulation

- [ ] 10. **Always use rAF for rendering**
  - Current: When paused, frames render directly without rAF at `Player.tsx:514-516`
  - Change: Always use rAF even when paused to ensure vsync alignment
  - Impact: Avoids potential tearing artifacts

## High Effort (Architectural)

- [ ] 11. **Direct GPU texture sharing**
  - Current: GPU renders → CPU readback → LZ4 compress → WebSocket → decompress → ImageBitmap
  - Change: Share GPU textures directly with the browser (WebGPU interop)
  - Impact: Eliminates entire CPU roundtrip for frame data

- [ ] 12. **Predictive prefetch with velocity detection**
  - Current: Fixed prefetch direction and rate
  - Change: Use playback velocity (scrubbing vs normal play) to adjust prefetch direction and priority
  - Impact: Better prefetch hit rate during scrubbing

- [ ] 13. **Weighted cache eviction**
  - Current: Simple LRU eviction at `playback.rs:106-110`
  - Change: Use weighted eviction considering distance from playhead, decode cost (I-frames), and access patterns
  - Impact: Higher cache hit rate for commonly accessed frames

- [ ] 14. **Skip compression for localhost**
  - Current: LZ4 compression used regardless of transport
  - Change: If WebSocket is localhost, skip LZ4 or use lighter compression
  - Impact: Reduces latency for local playback

- [ ] 15. **Optimize WebSocket message format**
  - Current: Metadata (stride, height, width) appended as 12 bytes at the end of each frame
  - Change: Send metadata in a separate message or header for better SIMD alignment
  - Impact: Better memory access patterns for decompression

## Additional Improvements

- [ ] 16. **Smarter frame drop strategy**
  - Current: In `socket.ts:121-132`, drops frames when worker is busy (keeps newest)
  - Change: Track frame timestamps and intelligently select which frames to keep
  - Impact: Better frame selection during seeking/scrubbing

- [ ] 17. **Immediate first frame rendering**
  - Current: Wait for 2 frames OR 50ms timeout at `playback.rs:436-437`
  - Change: Start rendering the first frame immediately while prefetch continues
  - Impact: Improved perceived responsiveness

- [ ] 18. **Double buffering for canvas**
  - Current: Single canvas with direct drawing
  - Change: Pre-render next frame to a second canvas for instant swap
  - Impact: Eliminates any visible rendering delay
