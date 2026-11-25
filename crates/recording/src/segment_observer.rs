//! Optional per-segment observers of a Studio recording. An observer is told
//! when each segment starts (with the segment's clock and what it captures)
//! and its observation is stopped with the segment. Without observers the
//! recording runs exactly as before.

use std::{path::PathBuf, sync::Arc};

use cap_timestamp::Timestamps;

use crate::{
    cursor::CursorCaptureTarget, output_pipeline::RecordingStartGate,
    studio_recording::pipeline_epoch,
};

/// The clock a segment's tracks are measured from (its start, or the start
/// cue for a primed first segment).
#[derive(Clone)]
pub struct SegmentClock {
    start_time: Timestamps,
    start_gate: Option<RecordingStartGate>,
}

impl SegmentClock {
    pub(crate) fn new(start_time: Timestamps, start_gate: Option<RecordingStartGate>) -> Self {
        Self {
            start_time,
            start_gate,
        }
    }

    /// The segment's epoch; before a primed segment's start cue this is its
    /// build instant, after it the cue.
    pub fn epoch(&self) -> Timestamps {
        pipeline_epoch(self.start_time, self.start_gate.as_ref())
    }
}

pub struct SegmentStart {
    pub index: u32,
    /// The segment's directory (beside its display video).
    pub dir: PathBuf,
    pub clock: SegmentClock,
    /// The captured area, as the cursor recorder sees it (absent for camera
    /// or audio only recordings).
    pub target: Option<CursorCaptureTarget>,
}

pub trait SegmentObserver: Send + Sync {
    fn segment_started(&self, start: SegmentStart) -> Box<dyn SegmentObservation>;
}

pub trait SegmentObservation: Send {
    /// Ends the observation (the segment stopped); returns once its output is
    /// complete.
    fn stop(self: Box<Self>);
}

pub(crate) type SegmentObservers = Vec<Arc<dyn SegmentObserver>>;
