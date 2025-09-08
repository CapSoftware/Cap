mod capture_pipeline;
pub mod cursor;
pub mod feeds;
pub mod instant_recording;
pub mod pipeline;
pub mod sources;
pub mod studio_recording;

pub use instant_recording::{
    CompletedInstantRecording, InstantRecordingActor, spawn_instant_recording_actor,
};
pub use sources::{camera, screen_capture};
pub use studio_recording::{
    CompletedStudioRecording, StudioRecordingHandle, spawn_studio_recording_actor,
};

use cap_media::MediaError;
use feeds::microphone::MicrophoneFeedLock;
use scap_targets::bounds::LogicalBounds;
use serde::{Deserialize, Serialize};
use sources::*;
use std::sync::Arc;
use thiserror::Error;

use crate::feeds::camera::CameraFeedLock;

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RecordingMode {
    Studio,
    Instant,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub capture_target: ScreenCaptureTarget,
    #[serde(alias = "audio_input_name")]
    pub mic_name: Option<String>,
    pub camera_label: Option<String>,
    #[serde(default)]
    pub capture_system_audio: bool,
    pub mode: RecordingMode,
}

#[derive(Clone)]
pub struct RecordingBaseInputs {
    pub capture_target: ScreenCaptureTarget,
    pub capture_system_audio: bool,
    pub mic_feed: Option<Arc<MicrophoneFeedLock>>,
    pub camera_feed: Option<Arc<CameraFeedLock>>,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RecordingOptionCaptureTarget {
    Window {
        id: u32,
    },
    Screen {
        id: u32,
    },
    Area {
        screen_id: u32,
        bounds: LogicalBounds,
    },
}

impl RecordingOptions {
    pub fn camera_label(&self) -> Option<&str> {
        self.camera_label.as_deref()
    }

    pub fn mic_name(&self) -> Option<&str> {
        self.mic_name.as_deref()
    }
}

#[derive(Error, Debug)]
pub enum ActorError {
    #[error("Actor has stopped")]
    ActorStopped,

    #[error("Failed to send to actor")]
    SendFailed(#[from] flume::SendError<()>),
}

#[derive(Error, Debug)]
pub enum RecordingError {
    #[error("Media error: {0}")]
    Media(#[from] MediaError),

    #[error("Actor error: {0}")]
    Actor(#[from] ActorError),

    #[error("Serde/{0}")]
    Serde(#[from] serde_json::Error),

    #[error("IO/{0}")]
    Io(#[from] std::io::Error),
}
