mod capture_pipeline;
pub mod cursor;
pub mod instant_recording;
pub mod studio_recording;

pub use studio_recording::{
    spawn_studio_recording_actor, CompletedStudioRecording, StudioRecordingHandle,
};

use cap_media::{sources::*, MediaError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RecordingMode {
    Studio,
    Instant,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub capture_target: ScreenCaptureTarget,
    pub audio_input_name: Option<String>,
    pub camera_label: Option<String>,
    pub mode: RecordingMode,
}

impl Default for RecordingOptions {
    fn default() -> Self {
        Self {
            capture_target: ScreenCaptureTarget::Screen(CaptureScreen {
                id: 0,
                name: String::new(),
                refresh_rate: 0,
            }),
            camera_label: None,
            audio_input_name: None,
            mode: RecordingMode::Studio,
        }
    }
}

impl RecordingOptions {
    pub fn camera_label(&self) -> Option<&str> {
        self.camera_label.as_deref()
    }

    pub fn audio_input_name(&self) -> Option<&str> {
        self.audio_input_name.as_deref()
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
