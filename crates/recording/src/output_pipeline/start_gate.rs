use std::{
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_timestamp::{Timestamp, Timestamps};
use tracing::warn;

/// Longest a primed pipeline will hold frames back without an explicit arm.
/// The apps arm the gate the moment the start cue finishes, so hitting this is
/// a caller bug; admitting everything is safer than recording nothing.
pub const START_GATE_FAILSAFE: Duration = Duration::from_secs(20);

/// Holds captured media back until the recording is allowed to begin.
///
/// Sources, encoders and muxers spin up ahead of the start cue so their warm-up
/// latency overlaps the countdown. Every frame captured before the gate is
/// armed is discarded, so the first admitted frame becomes the recording's
/// timeline zero exactly as if the pipeline had been built at the arm instant.
#[derive(Clone)]
pub struct RecordingStartGate(Arc<Inner>);

struct Inner {
    armed_at: OnceLock<Timestamps>,
    created: Instant,
    failsafe_logged: AtomicBool,
    video_origin_at_arm: AtomicBool,
}

impl Default for RecordingStartGate {
    fn default() -> Self {
        Self::new()
    }
}

impl RecordingStartGate {
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            armed_at: OnceLock::new(),
            created: Instant::now(),
            failsafe_logged: AtomicBool::new(false),
            video_origin_at_arm: AtomicBool::new(false),
        }))
    }

    /// Stamps the first admitted video frame at the arm point, so the video
    /// timeline starts where audio anchored at the recording epoch does.
    /// Instant merges its tracks by timestamp; Studio aligns them with each
    /// track's recorded start time instead and leaves this off.
    pub fn set_video_origin_at_arm(&self) {
        self.0.video_origin_at_arm.store(true, Ordering::Release);
    }

    /// How far the first admitted video frame was captured after `origin`,
    /// when [`Self::set_video_origin_at_arm`] is on and the gate is open.
    /// `origin` is where the recording's audio starts: the arm point, or the
    /// pipeline epoch if the gate was armed before it. The video track then
    /// starts there too: the first frame is shown from the origin and every
    /// later frame is muxed this much later than its offset from the first,
    /// so each keeps its capture time relative to the origin.
    pub(crate) fn video_origin_lead(
        &self,
        admitted: Timestamp,
        origin: Timestamps,
    ) -> Option<Duration> {
        if !self.0.video_origin_at_arm.load(Ordering::Acquire) {
            return None;
        }
        self.armed_at_or_failsafe()?;
        let offset = admitted.signed_duration_since_secs(origin);
        Some(Duration::from_secs_f64(offset.max(0.0)))
    }

    pub fn arm(&self) -> bool {
        self.arm_at(Timestamps::now())
    }

    pub fn arm_at(&self, at: Timestamps) -> bool {
        let armed = self.0.armed_at.set(at).is_ok();
        if armed {
            tracing::info!(
                primed_for_ms = self.0.created.elapsed().as_millis() as u64,
                "Recording start gate armed"
            );
        }
        armed
    }

    pub fn armed_at(&self) -> Option<Timestamps> {
        self.0.armed_at.get().copied()
    }

    pub fn is_armed(&self) -> bool {
        self.0.armed_at.get().is_some()
    }

    pub fn created_at(&self) -> Instant {
        self.0.created
    }

    fn armed_at_or_failsafe(&self) -> Option<Timestamps> {
        if let Some(at) = self.0.armed_at.get() {
            return Some(*at);
        }
        if self.0.created.elapsed() < START_GATE_FAILSAFE {
            return None;
        }
        let _ = self.0.armed_at.set(Timestamps::now());
        if !self.0.failsafe_logged.swap(true, Ordering::AcqRel) {
            warn!(
                failsafe_secs = START_GATE_FAILSAFE.as_secs(),
                "Recording start gate was never armed; admitting capture"
            );
        }
        self.0.armed_at.get().copied()
    }

    /// The arm instant, once the gate is armed or its failsafe has expired.
    pub(crate) fn armed_instant(&self) -> Option<Instant> {
        self.armed_at_or_failsafe().map(|armed| armed.instant())
    }

    /// Seconds from the arm point to `timestamp`, negative for media captured
    /// before it. `None` while the gate is still closed.
    pub(crate) fn offset_secs(&self, timestamp: Timestamp) -> Option<f64> {
        let armed_at = self.armed_at_or_failsafe()?;
        Some(timestamp.signed_duration_since_secs(armed_at))
    }

    pub(crate) fn admits_video(&self, timestamp: Timestamp) -> bool {
        self.offset_secs(timestamp)
            .is_some_and(|offset| offset >= 0.0)
    }

    pub(crate) fn admit_audio(
        &self,
        timestamp: Timestamp,
        samples: usize,
        sample_rate: u32,
    ) -> AudioAdmission {
        let Some(offset) = self.offset_secs(timestamp) else {
            return AudioAdmission::Drop;
        };
        if offset >= 0.0 {
            return AudioAdmission::Admit;
        }
        let leading = (-offset * f64::from(sample_rate)).round() as usize;
        if leading == 0 {
            AudioAdmission::Admit
        } else if leading >= samples {
            AudioAdmission::Drop
        } else {
            AudioAdmission::Trim { samples: leading }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioAdmission {
    Drop,
    Trim { samples: usize },
    Admit,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Timestamps, offset_ms: i64) -> Timestamp {
        let instant = base.instant();
        if offset_ms >= 0 {
            Timestamp::Instant(instant + Duration::from_millis(offset_ms as u64))
        } else {
            Timestamp::Instant(
                instant
                    .checked_sub(Duration::from_millis((-offset_ms) as u64))
                    .unwrap(),
            )
        }
    }

    #[test]
    fn video_origin_lead_only_when_asked() {
        let armed = Timestamps::now();
        let admitted = at(armed, 21);
        let near = |lead: Option<Duration>, ms: u64| {
            lead.is_some_and(|lead| {
                lead.abs_diff(Duration::from_millis(ms)) < Duration::from_micros(1)
            })
        };

        let gate = RecordingStartGate::new();
        assert!(gate.arm_at(armed));
        assert_eq!(gate.video_origin_lead(admitted, armed), None);

        let gate = RecordingStartGate::new();
        gate.set_video_origin_at_arm();
        assert_eq!(gate.video_origin_lead(admitted, armed), None, "closed gate");
        assert!(gate.arm_at(armed));
        assert!(near(gate.video_origin_lead(admitted, armed), 21));
        assert_eq!(
            gate.video_origin_lead(at(armed, 0), armed),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn video_origin_lead_counts_from_a_pipeline_epoch_after_the_arm_point() {
        let armed = Timestamps::now();
        std::thread::sleep(Duration::from_millis(5));
        let epoch = Timestamps::now();
        let gate = RecordingStartGate::new();
        gate.set_video_origin_at_arm();
        assert!(gate.arm_at(armed));
        let admitted = Timestamp::Instant(epoch.instant() + Duration::from_millis(12));
        let lead = gate.video_origin_lead(admitted, epoch).unwrap();
        assert!(lead.abs_diff(Duration::from_millis(12)) < Duration::from_micros(1));
    }

    #[test]
    fn closed_gate_admits_nothing() {
        let gate = RecordingStartGate::new();
        let now = Timestamps::now();
        assert!(!gate.admits_video(at(now, 0)));
        assert!(!gate.admits_video(at(now, 5_000)));
        assert_eq!(
            gate.admit_audio(at(now, 0), 480, 48_000),
            AudioAdmission::Drop
        );
        assert!(!gate.is_armed());
    }

    #[test]
    fn armed_gate_admits_only_media_from_the_arm_point() {
        let gate = RecordingStartGate::new();
        let armed = Timestamps::now();
        assert!(gate.arm_at(armed));
        assert!(!gate.arm_at(Timestamps::now()));
        assert!(!gate.admits_video(at(armed, -1)));
        assert!(gate.admits_video(at(armed, 0)));
        assert!(gate.admits_video(at(armed, 33)));
    }

    #[test]
    fn audio_straddling_the_arm_point_is_trimmed_to_it() {
        let gate = RecordingStartGate::new();
        let armed = Timestamps::now();
        gate.arm_at(armed);
        assert_eq!(
            gate.admit_audio(at(armed, -20), 480, 48_000),
            AudioAdmission::Drop
        );
        assert_eq!(
            gate.admit_audio(at(armed, -10), 480, 48_000),
            AudioAdmission::Drop
        );
        assert_eq!(
            gate.admit_audio(at(armed, -5), 480, 48_000),
            AudioAdmission::Trim { samples: 240 }
        );
        assert_eq!(
            gate.admit_audio(at(armed, 0), 480, 48_000),
            AudioAdmission::Admit
        );
        assert_eq!(
            gate.admit_audio(at(armed, 7), 480, 48_000),
            AudioAdmission::Admit
        );
    }
}
