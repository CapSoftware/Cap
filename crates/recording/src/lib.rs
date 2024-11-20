mod actor;
mod cursor;
mod segmented_actor;

pub use actor::{spawn_recording_actor, ActorHandle, RecordingError};

use cap_media::sources::*;
use serde::{Deserialize, Serialize};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub capture_target: ScreenCaptureTarget,
    pub camera_label: Option<String>,
    pub audio_input_name: Option<String>,
}

impl RecordingOptions {
    pub fn camera_label(&self) -> Option<&str> {
        self.camera_label.as_deref()
    }

    pub fn audio_input_name(&self) -> Option<&str> {
        self.audio_input_name.as_deref()
    }
}
