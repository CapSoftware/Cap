pub mod actor;
pub mod cursor;

pub use actor::{spawn_recording_actor, ActorHandle, CompletedRecording, RecordingError};

use cap_media::sources::*;
use cap_project::Resolution;
use serde::{Deserialize, Serialize};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub capture_target: ScreenCaptureTarget,
    pub camera_label: Option<String>,
    pub audio_input_name: Option<String>,
    pub fps: u32,
    pub output_resolution: Option<Resolution>,
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
            fps: 30,
            output_resolution: None,
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
