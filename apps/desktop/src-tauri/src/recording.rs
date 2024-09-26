use cap_ffmpeg::{FFmpeg, FFmpegInput, FFmpegProcess, FFmpegRawAudioInput};
use futures::future::OptionFuture;
use serde::Serialize;
use specta::Type;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::{path::PathBuf, time::Duration};
use tokio::sync::watch;

use crate::audio::AudioCapturer;
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
    pub ffmpeg_process: FFmpegProcess,
    #[serde(skip)]
    pub display: CaptureController,
    pub display_source: DisplaySource,
    #[serde(skip)]
    pub camera: Option<CaptureController>,
    #[serde(skip)]
    pub audio: Option<(FFmpegCaptureOutput<FFmpegRawAudioInput>, AudioCapturer)>,
    pub segments: Vec<f64>,
}

unsafe impl Send for InProgressRecording {}
unsafe impl Sync for InProgressRecording {}

impl InProgressRecording {
    pub async fn stop(&mut self) {
        use cap_project::*;
        let meta = RecordingMeta {
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
                    .0
                    .output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            }),
        };

        self.display.stop();
        if let Some(camera) = &self.camera {
            camera.stop();
        }

        self.ffmpeg_process.stop();
        if let Err(e) = self.ffmpeg_process.wait() {
            eprintln!("Failed to wait for ffmpeg process: {:?}", e);
        }
        if let Some(audio) = self.audio.take() {
            audio.0.capture.stop();
            drop(audio);
        }

        tokio::time::sleep(Duration::from_secs(1)).await;

        meta.save_for_project();
    }
    pub async fn pause(&mut self) -> Result<(), String> {
        self.display.pause();
        if let Some(camera) = &mut self.camera {
            camera.pause();
        }
        if let Some(audio) = &mut self.audio {
            audio.0.capture.pause();
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
            audio.0.capture.resume();
        }

        println!("Sent resume command to FFmpeg");
        Ok(())
    }
}

pub struct FFmpegCaptureOutput<T> {
    pub input: FFmpegInput<T>,
    pub capture: CaptureController,
    pub output_path: PathBuf,
}

pub async fn start(
    recording_dir: PathBuf,
    recording_options: &RecordingOptions,
) -> InProgressRecording {
    let content_dir = recording_dir.join("content");

    std::fs::create_dir_all(&content_dir).unwrap();

    let mut ffmpeg = FFmpeg::new();

    let (start_writing_tx, start_writing_rx) = watch::channel(false);

    let audio_pipe_path = content_dir.join("audio-input.pipe");

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
                    audio::start_capturing(capturer, audio_pipe_path.clone(), start_writing_rx)
                }),
        )
    );

    let audio = if let Some((controller, capturer)) = audio {
        let output_path = content_dir.join("audio-input.mp3");

        dbg!(&capturer.config);

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawAudioInput {
            input: audio_pipe_path.into_os_string(),
            sample_format: capturer.sample_format().to_string(),
            sample_rate: capturer.sample_rate(),
            channels: capturer.channels(),
        });

        ffmpeg
            .command
            .args(["-f", "mp3", "-map", &format!("{}:a", ffmpeg_input.index)])
            .args(["-b:a", "128k"])
            .args(["-ar", &capturer.sample_rate().to_string()])
            .args(["-ac", &capturer.channels().to_string(), "-async", "1"])
            .args([
                "-af",
                "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
            ])
            .arg(&output_path);

        Some((
            FFmpegCaptureOutput {
                input: ffmpeg_input,
                capture: controller,
                output_path,
            },
            capturer,
        ))
    } else {
        None
    };

    let ffmpeg_process = ffmpeg.start();

    tokio::time::sleep(Duration::from_secs(1)).await;

    println!("Starting writing to named pipes");

    start_writing_tx.send(true).unwrap();

    InProgressRecording {
        segments: vec![SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()],
        recording_dir,
        ffmpeg_process,
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
