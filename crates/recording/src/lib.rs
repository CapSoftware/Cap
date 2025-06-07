mod capture_pipeline;
pub mod cursor;
pub mod instant_recording;
pub mod studio_recording;

use std::sync::Arc;

pub use studio_recording::{
    spawn_studio_recording_actor, CompletedStudioRecording, StudioRecordingHandle,
};

use cap_media::{
    feeds::{AudioInputFeed, CameraFeed},
    platform::Bounds,
    sources::*,
    MediaError,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

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
pub struct RecordingBaseInputs<'a> {
    pub capture_target: ScreenCaptureTarget,
    pub capture_system_audio: bool,
    pub mic_feed: &'a Option<AudioInputFeed>,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RecordingOptionCaptureTarget {
    Window { id: u32 },
    Screen { id: u32 },
    Area { screen_id: u32, bounds: Bounds },
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
