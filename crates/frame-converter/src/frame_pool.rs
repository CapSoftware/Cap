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
            frames.push(frame::Video::new(format, width, height));
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
