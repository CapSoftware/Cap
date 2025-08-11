use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

use super::{CloneInto, PipelineClock};

#[derive(Debug, Clone)]
pub struct RecordedClock {
    running: Arc<AtomicBool>,
    start_frame_offset: Arc<AtomicU32>,
    total_frame_duration: f64,
}

impl RecordedClock {
    pub fn new(duration: f64, fps: u32) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            start_frame_offset: Arc::new(AtomicU32::new(0)),
            total_frame_duration: duration * f64::from(fps),
        }
    }

    pub fn seek(&mut self, playhead: u32) {
        self.start_frame_offset.store(playhead, Ordering::Release);
    }

    pub fn playhead_ratio(&self) -> f64 {
        let playhead = self.start_frame_offset.load(Ordering::Acquire);
        f64::from(playhead) / self.total_frame_duration
    }

    fn set_running(&self, value: bool) {
        self.running.store(value, Ordering::Release);
    }
}

impl CloneInto<RecordedClock> for RecordedClock {
    fn clone_into(&self) -> RecordedClock {
        self.clone()
    }
}

impl PipelineClock for RecordedClock {
    fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    fn start(&mut self) {
        self.set_running(true);
    }

    fn stop(&mut self) {
        self.set_running(false);
    }
}
