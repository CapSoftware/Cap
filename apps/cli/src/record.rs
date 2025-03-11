use std::{env::current_dir, hash::Hash, path::PathBuf, sync::Arc};

use cap_media::{feeds::CameraFeed, sources::ScreenCaptureTarget};
use cap_recording::{RecordingMode, RecordingOptions};
use clap::Args;
use nokhwa::utils::{ApiBackend, CameraIndex};
use tokio::{io::AsyncBufReadExt, sync::Mutex};
use uuid::Uuid;

#[derive(Args)]
pub struct RecordStart {
    #[command(flatten)]
    target: RecordTargets,
    /// Index of the camera to record
    #[arg(long)]
    camera: Option<u32>,
    /// ID of the microphone to record
    #[arg(long)]
    mic: Option<u32>,
    /// Whether to capture system audio
    #[arg(long)]
    system_audio: bool,
    /// Path to save the '.cap' project to
    #[arg(long)]
    path: Option<PathBuf>,
    /// Maximum fps to record at (max 60)
    #[arg(long)]
    fps: Option<u32>,
}

impl RecordStart {
    pub async fn run(self) -> Result<(), String> {
        let (target_info, _) = self
            .target
            .screen
            .map(|id| {
                cap_media::sources::list_screens()
                    .into_iter()
                    .find(|s| s.0.id == id)
                    .map(|(s, t)| (ScreenCaptureTarget::Screen { id: s.id }, t))
                    .ok_or(format!("Screen with id '{id}' not found"))
            })
            .or_else(|| {
                self.target.window.map(|id| {
                    cap_media::sources::list_windows()
                        .into_iter()
                        .find(|s| s.0.id == id)
                        .map(|(s, t)| (ScreenCaptureTarget::Window { id: s.id }, t))
                        .ok_or(format!("Window with id '{id}' not found"))
                })
            })
            .ok_or("No target specified".to_string())??;

        let camera = if let Some(camera_index) = self.camera {
            if let Some(camera_info) = nokhwa::query(ApiBackend::Auto)
                .unwrap()
                .into_iter()
                .find(|c| *c.index() == CameraIndex::Index(camera_index))
            {
                let name = camera_info.human_name();

                Some(CameraFeed::init(&name).await.unwrap())
            } else {
                None
            }
        } else {
            None
        };

        let id = Uuid::new_v4().to_string();
        let path = self
            .path
            .unwrap_or_else(|| current_dir().unwrap().join(format!("{id}.cap")));

        let actor = cap_recording::spawn_studio_recording_actor(
            id,
            path,
            RecordingOptions {
                capture_target: target_info,
                camera_label: camera.as_ref().map(|c| c.camera_info.human_name()),
                audio_input_name: None,
                mode: RecordingMode::Studio,
                capture_system_audio: self.system_audio,
            },
            camera.map(|c| Arc::new(Mutex::new(c))),
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

        println!("Recording starting, press Enter to stop");

        tokio::io::BufReader::new(tokio::io::stdin())
            .read_line(&mut String::new())
            .await
            .unwrap();

        actor.0.stop().await.unwrap();

        Ok(())
    }
}

#[derive(Args)]
struct RecordTargets {
    /// ID of the screen to capture
    #[arg(long, group = "target")]
    screen: Option<u32>,
    /// ID of the window to capture
    #[arg(long, group = "target")]
    window: Option<u32>,
}
