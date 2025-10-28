use cap_recording::{screen_capture::ScreenCaptureTarget, studio_recording};
use clap::Args;
use scap_targets::{DisplayId, WindowId};
use std::{env::current_dir, path::PathBuf};
use tokio::io::AsyncBufReadExt;
use uuid::Uuid;

#[derive(Args)]
pub struct RecordStart {
    #[command(flatten)]
    target: RecordTargets,
    /// Index of the camera to record
    #[arg(long)]
    camera: Option<String>,
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
        let target_info = match (self.target.screen, self.target.window) {
            (Some(id), _) => cap_recording::screen_capture::list_displays()
                .into_iter()
                .find(|s| s.0.id == id)
                .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                .ok_or(format!("Screen with id '{id}' not found")),
            (_, Some(id)) => cap_recording::screen_capture::list_windows()
                .into_iter()
                .find(|s| s.0.id == id)
                .map(|(s, _)| ScreenCaptureTarget::Window { id: s.id })
                .ok_or(format!("Window with id '{id}' not found")),
            _ => Err("No target specified".to_string()),
        }?;

        // let camera = if let Some(model_id) = self.camera {
        //     let _model_id: ModelID = model_id
        //         .try_into()
        //         .map_err(|_| "Invalid model ID".to_string())?;

        //     todo!()
        //     // Some(CameraFeed::init(model_id).await.unwrap())
        // } else {
        //     None
        // };

        let id = Uuid::new_v4().to_string();
        let path = self
            .path
            .unwrap_or_else(|| current_dir().unwrap().join(format!("{id}.cap")));

        let actor = studio_recording::Actor::builder(path, target_info)
            .with_system_audio(self.system_audio)
            .with_custom_cursor(false)
            .build(
                #[cfg(target_os = "macos")]
                cidre::sc::ShareableContent::current().await.unwrap(),
            )
            .await
            .map_err(|e| e.to_string())?;

        println!("Recording starting, press Enter to stop");

        tokio::io::BufReader::new(tokio::io::stdin())
            .read_line(&mut String::new())
            .await
            .unwrap();

        actor.stop().await.unwrap();

        Ok(())
    }
}

#[derive(Args)]
struct RecordTargets {
    /// ID of the screen to capture
    #[arg(long, group = "target")]
    screen: Option<DisplayId>,
    /// ID of the window to capture
    #[arg(long, group = "target")]
    window: Option<WindowId>,
}
