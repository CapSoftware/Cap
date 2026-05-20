use std::time::Duration;

use tokio::sync::mpsc;

#[derive(Clone)]
pub struct PlaybackTelemetry {
    tx: mpsc::UnboundedSender<PlaybackTelemetryEvent>,
}

impl PlaybackTelemetry {
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<PlaybackTelemetryEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    pub(crate) fn emit(&self, event: PlaybackTelemetryEvent) {
        let _ = self.tx.send(event);
    }
}

#[derive(Debug, Clone)]
pub enum PlaybackTelemetryEvent {
    WarmupComplete {
        elapsed: Duration,
        buffered_frames: usize,
        target_frames: usize,
        start_frame_number: u32,
    },
    FrameSubmitted {
        frame_number: u32,
        source: PlaybackFrameSource,
        schedule_overshoot: Duration,
        frame_acquire_duration: Duration,
        uniforms_duration: Duration,
        submit_duration: Duration,
        prefetch_buffer_len: usize,
        total_frames_skipped: u64,
    },
    FrameSkipped {
        frame_number: u32,
        skipped: u32,
        reason: PlaybackSkipReason,
        prefetch_buffer_len: usize,
    },
    RendererFrame {
        frame_number: u32,
        queue_wait: Duration,
        drain_duration: Duration,
        flush_duration: Duration,
        render_duration: Duration,
        callback_duration: Duration,
        drained_count: u32,
        output_format: PlaybackRenderOutputFormat,
    },
    RendererPrepared {
        output_width: u32,
        output_height: u32,
        duration: Duration,
    },
    RendererDropped {
        frame_number: u32,
        replacement_frame_number: u32,
    },
    RendererSendFailed {
        frame_number: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlaybackFrameSource {
    InitialPrerender,
    Cache,
    PrefetchFront,
    PrefetchSearch,
    PrefetchWaitExact,
    PrefetchWaitFuture,
    LateDrain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlaybackSkipReason {
    ScheduleOvershoot,
    PrefetchTimeout,
    PrefetchBehind,
    PrefetchGap,
    ClockDrift,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlaybackRenderOutputFormat {
    Nv12,
    Rgba,
}
