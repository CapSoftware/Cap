use ffmpeg::{format::Pixel, frame};
use parking_lot::Mutex;
use std::sync::Arc;

pub struct VideoFramePool {
    frames: Mutex<Vec<frame::Video>>,
    format: Pixel,
    width: u32,
    height: u32,
    capacity: usize,
}

impl VideoFramePool {
    pub fn new(capacity: usize, format: Pixel, width: u32, height: u32) -> Arc<Self> {
        // Allocate the backing Vec lazily rather than pre-filling it with
        // `capacity` full-size frames. Each frame is a full pixel buffer
        // (e.g. ~3 MB for 1920x1080 NV12), so eagerly creating `capacity`
        // frames spikes memory by `capacity * frame_size` the instant a pool
        // is built — a direct contributor to the recording-time memory
        // pressure reported in issue #109. Frames are still recycled through
        // `get`/`put`, so steady-state allocation is bounded by the actual
        // number of in-flight frames (workers + queue depth), not peak
        // capacity. `Vec::with_capacity` only reserves the (tiny) pointer
        // array, not the pixel buffers.
        let frames = Vec::with_capacity(capacity);

        Arc::new(Self {
            frames: Mutex::new(frames),
            format,
            width,
            height,
            capacity,
        })
    }

    pub fn get(&self) -> frame::Video {
        self.frames
            .lock()
            .pop()
            .unwrap_or_else(|| frame::Video::new(self.format, self.width, self.height))
    }

    pub fn put(&self, frame: frame::Video) {
        let mut frames = self.frames.lock();
        if frames.len() < self.capacity {
            frames.push(frame);
        }
    }

    pub fn available(&self) -> usize {
        self.frames.lock().len()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn format(&self) -> Pixel {
        self.format
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Counting allocator to measure heap bytes requested during pool creation.
    // This lets us assert the pool no longer eagerly allocates `capacity`
    // full-size pixel buffers up front (issue #109 memory spike).
    static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);

    struct CountingAllocator;

    unsafe impl std::alloc::GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
            ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
            unsafe { std::alloc::System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
            unsafe { std::alloc::System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(
            &self,
            ptr: *mut u8,
            layout: std::alloc::Layout,
            new_size: usize,
        ) -> *mut u8 {
            ALLOC_BYTES.fetch_add(new_size, Ordering::Relaxed);
            unsafe { std::alloc::System.realloc(ptr, layout, new_size) }
        }
    }

    #[global_allocator]
    static GLOBAL: CountingAllocator = CountingAllocator;

    const W: u32 = 1920;
    const H: u32 = 1080;
    // NV12/YUV420p 1920x1080 = 1920*1080*1.5 = 3_110_400 bytes (~3.1 MB).
    const FRAME_BYTES: usize = (W as usize) * (H as usize) * 3 / 2;
    const CAP: usize = 16;

    #[test]
    fn new_does_not_eagerly_allocate_frames() {
        // Warm up so one-time lazy statics don't pollute the measurement.
        let _ = VideoFramePool::new(1, Pixel::NV12, W, H);

        ALLOC_BYTES.store(0, Ordering::SeqCst);
        let pool = VideoFramePool::new(CAP, Pixel::NV12, W, H);
        let allocated = ALLOC_BYTES.load(Ordering::SeqCst);

        // Lazy: creating the pool must NOT allocate CAP full-size frames.
        // Eager (old behaviour) would allocate CAP * FRAME_BYTES (~49.8 MB).
        let eager_bytes = CAP * FRAME_BYTES;
        assert!(
            allocated < FRAME_BYTES,
            "pool creation allocated {allocated} bytes; expected < one frame ({FRAME_BYTES}). \
             Eager allocation would be {eager_bytes} bytes (~{} MB)",
            eager_bytes / (1024 * 1024)
        );

        // Pool starts empty; first get() allocates exactly one frame.
        assert_eq!(pool.available(), 0);
        let f = pool.get();
        assert_eq!(pool.available(), 0);
        assert_eq!(f.width(), W);
        assert_eq!(f.height(), H);
        drop(f);
    }

    #[test]
    fn frames_are_recycled_not_reallocated() {
        let pool = VideoFramePool::new(CAP, Pixel::NV12, W, H);

        // First get allocates.
        let f = pool.get();
        ALLOC_BYTES.store(0, Ordering::SeqCst);

        // put + get should recycle with zero new frame-sized allocations.
        pool.put(f);
        assert_eq!(pool.available(), 1);
        let f2 = pool.get();
        assert_eq!(pool.available(), 0);
        let allocated = ALLOC_BYTES.load(Ordering::SeqCst);
        assert!(
            allocated < FRAME_BYTES,
            "recycle path allocated {allocated} bytes; expected < one frame ({FRAME_BYTES})"
        );
        drop(f2);
    }

    #[test]
    fn put_respects_capacity_bound() {
        let pool = VideoFramePool::new(2, Pixel::NV12, W, H);
        pool.put(frame::Video::new(Pixel::NV12, W, H));
        pool.put(frame::Video::new(Pixel::NV12, W, H));
        pool.put(frame::Video::new(Pixel::NV12, W, H)); // exceeds capacity
        assert_eq!(pool.available(), 2);
        assert_eq!(pool.capacity(), 2);
    }
}
