use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone)]
pub struct CaptureController {
    pub output_path: PathBuf,
    is_stopped: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
}

impl CaptureController {
    pub fn new(output_path: PathBuf) -> Self {
        Self {
            output_path,
            is_stopped: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn stop(&self) {
        self.is_stopped.store(true, Ordering::Relaxed);
    }

    pub fn pause(&mut self) {
        println!("setting is_paused to true");
        self.is_paused.store(true, Ordering::Relaxed);
    }

    pub fn resume(&mut self) {
        self.is_paused.store(false, Ordering::Relaxed);
    }

    pub fn is_stopped(&self) -> bool {
        self.is_stopped.load(Ordering::Relaxed)
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::Relaxed)
    }
}
