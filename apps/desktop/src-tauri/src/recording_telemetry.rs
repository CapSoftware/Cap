use cap_recording::PipelineHealthEvent;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

#[derive(Debug)]
pub struct RecordingHealthAccumulator {
    started_at: Instant,
    capture_stalls_count: AtomicU64,
    capture_stalls_max_ms: AtomicU64,
    mixer_stalls_count: AtomicU64,
    mixer_stalls_max_ms: AtomicU64,
    audio_gaps_count: AtomicU64,
    audio_gaps_total_ms: AtomicU64,
    frame_drop_rate_high_count: AtomicU64,
    source_restarts_count: AtomicU64,
    muxer_crash_count: AtomicU64,
    audio_degraded_count: AtomicU64,
    muxer_crashed_fired: AtomicBool,
    audio_degraded_fired: AtomicBool,
}

#[derive(Debug, Clone, Copy)]
pub struct RecordingHealthSnapshot {
    pub capture_stalls_count: u64,
    pub capture_stalls_max_ms: u64,
    pub mixer_stalls_count: u64,
    pub mixer_stalls_max_ms: u64,
    pub audio_gaps_count: u64,
    pub audio_gaps_total_ms: u64,
    pub frame_drop_rate_high_count: u64,
    pub source_restarts_count: u64,
    pub muxer_crash_count: u64,
    pub audio_degraded_count: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum CriticalEvent {
    MuxerCrashed {
        reason_index: usize,
        seconds_into_recording: f64,
    },
    AudioDegraded {
        reason_index: usize,
        seconds_into_recording: f64,
    },
}

impl RecordingHealthAccumulator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            started_at: Instant::now(),
            capture_stalls_count: AtomicU64::new(0),
            capture_stalls_max_ms: AtomicU64::new(0),
            mixer_stalls_count: AtomicU64::new(0),
            mixer_stalls_max_ms: AtomicU64::new(0),
            audio_gaps_count: AtomicU64::new(0),
            audio_gaps_total_ms: AtomicU64::new(0),
            frame_drop_rate_high_count: AtomicU64::new(0),
            source_restarts_count: AtomicU64::new(0),
            muxer_crash_count: AtomicU64::new(0),
            audio_degraded_count: AtomicU64::new(0),
            muxer_crashed_fired: AtomicBool::new(false),
            audio_degraded_fired: AtomicBool::new(false),
        })
    }

    pub fn seconds_since_start(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    pub fn record_event(&self, event: &PipelineHealthEvent) -> Option<(String, CriticalEvent)> {
        match event {
            PipelineHealthEvent::Stalled { source, waited_ms } => {
                let is_mixer = source.starts_with("mixer:");
                let waited = *waited_ms;
                if is_mixer {
                    self.mixer_stalls_count.fetch_add(1, Ordering::Relaxed);
                    update_max(&self.mixer_stalls_max_ms, waited);
                } else {
                    self.capture_stalls_count.fetch_add(1, Ordering::Relaxed);
                    update_max(&self.capture_stalls_max_ms, waited);
                }
                None
            }
            PipelineHealthEvent::AudioGapDetected { gap_ms } => {
                self.audio_gaps_count.fetch_add(1, Ordering::Relaxed);
                self.audio_gaps_total_ms
                    .fetch_add(*gap_ms, Ordering::Relaxed);
                None
            }
            PipelineHealthEvent::FrameDropRateHigh { .. } => {
                self.frame_drop_rate_high_count
                    .fetch_add(1, Ordering::Relaxed);
                None
            }
            PipelineHealthEvent::SourceRestarting => {
                self.source_restarts_count.fetch_add(1, Ordering::Relaxed);
                None
            }
            PipelineHealthEvent::SourceRestarted => None,
            PipelineHealthEvent::MuxerCrashed { reason } => {
                self.muxer_crash_count.fetch_add(1, Ordering::Relaxed);
                let first = !self.muxer_crashed_fired.swap(true, Ordering::AcqRel);
                if first {
                    Some((
                        reason.clone(),
                        CriticalEvent::MuxerCrashed {
                            reason_index: 0,
                            seconds_into_recording: self.seconds_since_start(),
                        },
                    ))
                } else {
                    None
                }
            }
            PipelineHealthEvent::AudioDegradedToVideoOnly { reason } => {
                self.audio_degraded_count.fetch_add(1, Ordering::Relaxed);
                let first = !self.audio_degraded_fired.swap(true, Ordering::AcqRel);
                if first {
                    Some((
                        reason.clone(),
                        CriticalEvent::AudioDegraded {
                            reason_index: 0,
                            seconds_into_recording: self.seconds_since_start(),
                        },
                    ))
                } else {
                    None
                }
            }
            PipelineHealthEvent::DiskSpaceLow { .. }
            | PipelineHealthEvent::DiskSpaceExhausted { .. }
            | PipelineHealthEvent::DeviceLost { .. }
            | PipelineHealthEvent::EncoderRebuilt { .. }
            | PipelineHealthEvent::SourceAudioReset { .. }
            | PipelineHealthEvent::RecoveryFragmentCorrupt { .. }
            | PipelineHealthEvent::CaptureTargetLost { .. } => None,
        }
    }

    pub fn snapshot(&self) -> RecordingHealthSnapshot {
        RecordingHealthSnapshot {
            capture_stalls_count: self.capture_stalls_count.load(Ordering::Acquire),
            capture_stalls_max_ms: self.capture_stalls_max_ms.load(Ordering::Acquire),
            mixer_stalls_count: self.mixer_stalls_count.load(Ordering::Acquire),
            mixer_stalls_max_ms: self.mixer_stalls_max_ms.load(Ordering::Acquire),
            audio_gaps_count: self.audio_gaps_count.load(Ordering::Acquire),
            audio_gaps_total_ms: self.audio_gaps_total_ms.load(Ordering::Acquire),
            frame_drop_rate_high_count: self.frame_drop_rate_high_count.load(Ordering::Acquire),
            source_restarts_count: self.source_restarts_count.load(Ordering::Acquire),
            muxer_crash_count: self.muxer_crash_count.load(Ordering::Acquire),
            audio_degraded_count: self.audio_degraded_count.load(Ordering::Acquire),
        }
    }
}

fn update_max(cell: &AtomicU64, candidate: u64) {
    let mut current = cell.load(Ordering::Acquire);
    while candidate > current {
        match cell.compare_exchange_weak(current, candidate, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return,
            Err(observed) => current = observed,
        }
    }
}

pub fn mode_label(mode: cap_recording::RecordingMode) -> &'static str {
    match mode {
        cap_recording::RecordingMode::Studio => "studio",
        cap_recording::RecordingMode::Instant => "instant",
        cap_recording::RecordingMode::Screenshot => "screenshot",
    }
}

pub fn target_kind_label(
    target: &cap_recording::sources::screen_capture::ScreenCaptureTarget,
) -> &'static str {
    use cap_recording::sources::screen_capture::ScreenCaptureTarget;
    match target {
        ScreenCaptureTarget::Display { .. } => "display",
        ScreenCaptureTarget::Window { .. } => "window",
        ScreenCaptureTarget::Area { .. } => "area",
        ScreenCaptureTarget::CameraOnly => "camera_only",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_stall(source: &str, waited_ms: u64) -> PipelineHealthEvent {
        PipelineHealthEvent::Stalled {
            source: source.to_string(),
            waited_ms,
        }
    }

    #[test]
    fn accumulator_separates_capture_and_mixer_stalls() {
        let acc = RecordingHealthAccumulator::new();
        acc.record_event(&make_stall("screen-video", 80));
        acc.record_event(&make_stall("screen-system-audio", 50));
        acc.record_event(&make_stall("mixer:mic", 200));
        acc.record_event(&make_stall("mixer:sys", 950));
        let snap = acc.snapshot();
        assert_eq!(snap.capture_stalls_count, 2);
        assert_eq!(snap.capture_stalls_max_ms, 80);
        assert_eq!(snap.mixer_stalls_count, 2);
        assert_eq!(snap.mixer_stalls_max_ms, 950);
    }

    #[test]
    fn accumulator_fires_muxer_crash_once() {
        let acc = RecordingHealthAccumulator::new();
        let first = acc.record_event(&PipelineHealthEvent::MuxerCrashed {
            reason: "boom".to_string(),
        });
        let second = acc.record_event(&PipelineHealthEvent::MuxerCrashed {
            reason: "again".to_string(),
        });
        assert!(
            first.is_some(),
            "first muxer crash must fire critical event"
        );
        assert!(
            second.is_none(),
            "second muxer crash must not re-fire (still increments counter)"
        );
        let snap = acc.snapshot();
        assert_eq!(snap.muxer_crash_count, 2);
    }

    #[test]
    fn accumulator_fires_audio_degraded_once() {
        let acc = RecordingHealthAccumulator::new();
        let first = acc.record_event(&PipelineHealthEvent::AudioDegradedToVideoOnly {
            reason: "mic died".to_string(),
        });
        let second = acc.record_event(&PipelineHealthEvent::AudioDegradedToVideoOnly {
            reason: "sys died".to_string(),
        });
        assert!(first.is_some());
        assert!(second.is_none());
        let snap = acc.snapshot();
        assert_eq!(snap.audio_degraded_count, 2);
    }

    #[test]
    fn accumulator_accumulates_audio_gaps_and_drop_rate() {
        let acc = RecordingHealthAccumulator::new();
        acc.record_event(&PipelineHealthEvent::AudioGapDetected { gap_ms: 120 });
        acc.record_event(&PipelineHealthEvent::AudioGapDetected { gap_ms: 340 });
        acc.record_event(&PipelineHealthEvent::FrameDropRateHigh {
            source: "screen-video".to_string(),
            rate_pct: 12.5,
        });
        acc.record_event(&PipelineHealthEvent::SourceRestarting);
        acc.record_event(&PipelineHealthEvent::SourceRestarted);
        let snap = acc.snapshot();
        assert_eq!(snap.audio_gaps_count, 2);
        assert_eq!(snap.audio_gaps_total_ms, 460);
        assert_eq!(snap.frame_drop_rate_high_count, 1);
        assert_eq!(snap.source_restarts_count, 1);
    }
}
