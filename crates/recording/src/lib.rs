mod actor;
mod cursor;
mod segmented_actor;

pub use actor::{spawn_recording_actor, ActorHandle, RecordingError};

use cap_media::{pipeline::*, sources::*};
use cap_project::{CursorClickEvent, CursorMoveEvent};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::oneshot;

// TODO: Hacky, please fix
pub const FPS: u32 = 30;

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

#[derive(Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgressRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    #[serde(skip)]
    pub pipeline: Pipeline<RealTimeClock<()>>,
    #[serde(skip)]
    pub display_output_path: PathBuf,
    #[serde(skip)]
    pub camera_output_path: Option<PathBuf>,
    #[serde(skip)]
    pub audio_output_path: Option<PathBuf>,
    pub display_source: ScreenCaptureTarget,
    pub segments: Vec<f64>,
    #[serde(skip)]
    pub cursor_moves: oneshot::Receiver<Vec<CursorMoveEvent>>,
    #[serde(skip)]
    pub cursor_clicks: oneshot::Receiver<Vec<CursorClickEvent>>,
    #[serde(skip)]
    pub stop_signal: Arc<AtomicBool>,
}

impl InProgressRecording {
    pub async fn stop_and_discard(&mut self) {
        // Signal the mouse event tracking to stop
        if let Err(error) = self.pipeline.shutdown().await {
            eprintln!("Error while stopping recording: {error}");
        }

        // Delete all recorded files
        if let Err(e) = std::fs::remove_dir_all(&self.recording_dir) {
            eprintln!("Failed to delete recording directory: {:?}", e);
        }
    }

    // pub async fn pause(&mut self) -> Result<(), String> {
    //     let _ = self.pipeline.pause().await;
    //     Ok(())
    // }

    pub async fn play(&mut self) -> Result<(), String> {
        let _ = self.pipeline.play().await;
        Ok(())
    }
}
