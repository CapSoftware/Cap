mod audio_buffer;
mod capture_pipeline;
pub mod cursor;
pub mod feeds;
pub mod instant_recording;
mod output_pipeline;
pub mod sources;
pub mod studio_recording;

pub use feeds::{camera::CameraFeed, microphone::MicrophoneFeed};
pub use output_pipeline::*;
pub use sources::screen_capture;

use cap_media::MediaError;
use feeds::microphone::MicrophoneFeedLock;
use scap_targets::{WindowId, bounds::LogicalBounds};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;

use crate::{feeds::camera::CameraFeedLock, sources::screen_capture::ScreenCaptureTarget};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub enum RecordingMode {
    #[default]
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
    pub output_height: Option<u32>,
    #[cfg(target_os = "macos")]
    pub shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    #[cfg(target_os = "macos")]
    pub excluded_windows: Vec<WindowId>,
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
