#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default, Clone, Copy)]
pub struct ConversionStatsSnapshot {
    pub zero_copy_frames: u64,
    pub copied_frames: u64,
    pub copy_nanos: u64,
}

impl ConversionStatsSnapshot {
    pub fn average_copy_micros(&self) -> f64 {
        if self.copied_frames == 0 {
            0.0
        } else {
            self.copy_nanos as f64 / self.copied_frames as f64 / 1_000.0
        }
    }
}

#[derive(Debug, Default)]
pub struct ConversionStats {
    zero_copy_frames: AtomicU64,
    copied_frames: AtomicU64,
    copy_nanos: AtomicU64,
}

impl ConversionStats {
    pub fn record_zero_copy(&self) {
        self.zero_copy_frames.fetch_add(1, Ordering::Relaxed);
        self.log_periodically();
    }

    pub fn record_copy(&self, elapsed_nanos: u64) {
        self.copied_frames.fetch_add(1, Ordering::Relaxed);
        self.copy_nanos.fetch_add(elapsed_nanos, Ordering::Relaxed);
        self.log_periodically();
    }

    fn log_periodically(&self) {
        let snapshot = self.snapshot();
        let total = snapshot.zero_copy_frames + snapshot.copied_frames;
        if total > 0 && total.is_multiple_of(300) {
            tracing::debug!(
                zero_copy_frames = snapshot.zero_copy_frames,
                copied_frames = snapshot.copied_frames,
                average_copy_micros = snapshot.average_copy_micros(),
                "Camera frame conversion stats"
            );
        }
    }

    pub fn snapshot(&self) -> ConversionStatsSnapshot {
        ConversionStatsSnapshot {
            zero_copy_frames: self.zero_copy_frames.load(Ordering::Relaxed),
            copied_frames: self.copied_frames.load(Ordering::Relaxed),
            copy_nanos: self.copy_nanos.load(Ordering::Relaxed),
        }
    }
}

pub static CONVERSION_STATS: ConversionStats = ConversionStats {
    zero_copy_frames: AtomicU64::new(0),
    copied_frames: AtomicU64::new(0),
    copy_nanos: AtomicU64::new(0),
};

pub fn conversion_stats() -> ConversionStatsSnapshot {
    CONVERSION_STATS.snapshot()
}

pub trait CapturedFrameExt {
    /// Creates an ffmpeg video frame from the native frame.
    /// Only size, format, and data are set.
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
