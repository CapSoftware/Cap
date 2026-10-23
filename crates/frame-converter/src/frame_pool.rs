use crate::output_frame::cached_output_frame;
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
        let mut frames = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            frames.push(cached_output_frame(format, width, height));
        }

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
            .unwrap_or_else(|| cached_output_frame(self.format, self.width, self.height))
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
    use std::sync::Once;

    fn init_ffmpeg() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            ffmpeg::init().expect("ffmpeg init");
        });
    }

    #[test]
    fn pooled_frames_match_ffmpeg_geometry() {
        init_ffmpeg();
        let pool = VideoFramePool::new(2, Pixel::NV12, 64, 32);
        assert_eq!(pool.available(), 2);
        let frame = pool.get();
        let fresh = frame::Video::new(Pixel::NV12, 64, 32);
        assert_eq!(frame.format(), fresh.format());
        assert_eq!(frame.width(), fresh.width());
        assert_eq!(frame.height(), fresh.height());
        assert_eq!(frame.stride(0), fresh.stride(0));
        assert_eq!(frame.stride(1), fresh.stride(1));
        assert_eq!(pool.available(), 1);
        pool.put(frame);
        assert_eq!(pool.available(), 2);
    }
}
