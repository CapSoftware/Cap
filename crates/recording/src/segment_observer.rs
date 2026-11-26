//! Optional per-segment observers of a Studio recording. An observer is told
//! when each segment starts (with the segment's clock and what it captures)
//! and its observation is stopped with the segment. Without observers the
//! recording runs exactly as before.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use cap_timestamp::Timestamps;

use crate::{
    cursor::CursorCaptureTarget,
    output_pipeline::{RecordingStartGate, VideoSource, VideoTap},
    sources::screen_capture,
    studio_recording::pipeline_epoch,
};

/// A frame of a segment's display video, as its muxer is handed it.
pub type ScreenFrame = <screen_capture::VideoSource as VideoSource>::Frame;

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

    /// Where the segment's screen frames go, if this observation wants them.
    fn screen_frames(&self) -> Option<Arc<dyn ScreenFrames>> {
        None
    }
}

/// The frame's pixels, copied out of its capture buffer so the buffer can go
/// back to the system straight away.
pub fn screen_frame_video(frame: &ScreenFrame) -> anyhow::Result<ffmpeg::frame::Video> {
    #[cfg(target_os = "macos")]
    {
        use scap_ffmpeg::AsFFmpeg;
        frame
            .sample_buf
            .as_ffmpeg()
            .map_err(|error| anyhow::anyhow!("copy screen frame: {error:?}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = frame;
        anyhow::bail!("screen frames are not copied on this platform")
    }
}

/// Receives the frames a segment's display video is written with, in order,
/// on the muxing task: it must hand them off without blocking.
pub trait ScreenFrames: Send + Sync {
    /// One frame, with the timestamp the muxer writes it at.
    fn frame(&self, frame: &ScreenFrame, timestamp: Duration);

    /// How many frames the display video got before this receiver was
    /// attached; they were not passed to [`Self::frame`].
    fn missed(&self, frames: u64);
}

/// Between a segment's screen pipeline, which exists first, and the frame
/// receivers of its observations, attached once they are created.
#[derive(Default)]
pub(crate) struct ScreenTap {
    state: Mutex<ScreenTapState>,
}

#[derive(Default)]
struct ScreenTapState {
    receivers: Option<Vec<Arc<dyn ScreenFrames>>>,
    early: u64,
}

impl ScreenTap {
    pub(crate) fn video_tap(self: &Arc<Self>) -> VideoTap<ScreenFrame> {
        let tap = self.clone();
        Arc::new(move |frame: &ScreenFrame, timestamp: Duration| tap.frame(frame, timestamp))
    }

    fn frame(&self, frame: &ScreenFrame, timestamp: Duration) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match &state.receivers {
            Some(receivers) => {
                for receiver in receivers {
                    receiver.frame(frame, timestamp);
                }
            }
            None => state.early += 1,
        }
    }

    pub(crate) fn attach(&self, receivers: Vec<Arc<dyn ScreenFrames>>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.early > 0 {
            for receiver in &receivers {
                receiver.missed(state.early);
            }
        }
        state.receivers = Some(receivers);
    }
}

pub(crate) type SegmentObservers = Vec<Arc<dyn SegmentObserver>>;

/// The running observations, with the segment each one observes.
pub(crate) type Observations = Arc<Mutex<Vec<(u32, Box<dyn SegmentObservation>)>>>;
