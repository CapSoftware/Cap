use futures::future::OptionFuture;
use serde::Serialize;
use specta::Type;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{path::PathBuf, time::Duration};
use tokio::sync::watch;

use crate::capture::CaptureController;
use crate::{
    audio, camera,
    display::{self, get_window_bounds, CaptureTarget},
    Bounds, RecordingOptions,
};


#[derive(Clone, Type, Serialize)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum DisplaySource {
    Screen,
    Window { bounds: Bounds },
}

#[derive(Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgressRecording {
    pub recording_dir: PathBuf,
    #[serde(skip)]
    pub display: CaptureController,
    pub display_source: DisplaySource,
    #[serde(skip)]
    pub camera: Option<CaptureController>,
    #[serde(skip)]
    pub audio: Option<CaptureController>,
    pub segments: Vec<f64>,
}

unsafe impl Send for InProgressRecording {}
unsafe impl Sync for InProgressRecording {}

impl InProgressRecording {
    pub async fn stop(&mut self) {
        self.display.stop();
        if let Some(camera) = &self.camera {
            camera.stop();
        }
        if let Some(audio) = &mut self.audio {
            audio.stop();
        }

        tokio::time::sleep(Duration::from_secs(1)).await;

        use cap_project::*;
        RecordingMeta {
            project_path: self.recording_dir.clone(),
            sharing: None,
            pretty_name: format!(
                "Cap {}",
                chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
            ),
            display: Display {
                path: self
                    .display
                    .output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            },
            camera: self.camera.as_ref().map(|camera| CameraMeta {
                path: camera
                    .output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            }),
            audio: self.audio.as_ref().map(|audio| AudioMeta {
                path: audio
                    .output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            }),
        }
        .save_for_project();
    }
    pub async fn pause(&mut self) -> Result<(), String> {
        self.display.pause();
        if let Some(camera) = &mut self.camera {
            camera.pause();
        }
        if let Some(audio) = &mut self.audio {
            audio.pause();
        }
        println!("Sent pause command to FFmpeg");
        Ok(())
    }

    pub async fn resume(&mut self) -> Result<(), String> {
        self.display.resume();
        if let Some(camera) = &mut self.camera {
            camera.resume();
        }
        if let Some(audio) = &mut self.audio {
            audio.resume();
        }

        println!("Sent resume command to FFmpeg");
        Ok(())
    }
}

pub async fn start(
    recording_dir: PathBuf,
    recording_options: &RecordingOptions,
) -> InProgressRecording {
    let content_dir = recording_dir.join("content");

    std::fs::create_dir_all(&content_dir).unwrap();

    let (start_writing_tx, start_writing_rx) = watch::channel(false);

    let (display, camera, audio) = tokio::join!(
        display::start_capturing(
            content_dir.join("display.mp4"),
            &recording_options.capture_target,
            start_writing_rx.clone(),
        ),
        OptionFuture::from(
            recording_options
                .camera_label()
                .and_then(camera::find_camera_by_label)
                .map(|camera_info| {
                    camera::start_capturing(
                        content_dir.join("camera.mp4"),
                        camera_info,
                        start_writing_rx.clone(),
                    )
                }),
        ),
        OptionFuture::from(
            recording_options
                .audio_input_name()
                .and_then(audio::AudioCapturer::init)
                .map(|capturer| {
                    audio::start_capturing(
                        capturer,
                        content_dir.join("audio-input.mp3"),
                        start_writing_rx,
                    )
                }),
        )
    );

    tokio::time::sleep(Duration::from_secs(1)).await;

    println!("Starting writing to named pipes");

    start_writing_tx.send(true).unwrap();

    InProgressRecording {
        segments: vec![SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()],
        recording_dir,
        // ffmpeg_process,
        display,
        display_source: match recording_options.capture_target {
            CaptureTarget::Screen => DisplaySource::Screen,
            CaptureTarget::Window { id: window_number } => DisplaySource::Window {
                bounds: get_window_bounds(window_number).unwrap(),
            },
        },
        camera,
        audio,
    }
}
