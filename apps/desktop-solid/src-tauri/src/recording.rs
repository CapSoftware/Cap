use nokhwa::utils::CameraFormat;
use serde::Serialize;
use specta::Type;
use std::time::Instant;
use std::{path::PathBuf, time::Duration};
use tokio::sync::watch;

use crate::{
    audio::{self, AudioCapturer},
    camera,
    display::{self, get_window_bounds, CaptureTarget},
    Bounds, RecordingOptions,
};

use cap_ffmpeg::*;

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
    pub display: FFmpegCaptureOutput<FFmpegRawVideoInput>,
    pub display_source: DisplaySource,
    #[serde(skip)]
    pub camera: Option<FFmpegCaptureOutput<FFmpegRawVideoInput>>,
    #[serde(skip)]
    pub audio: Option<(FFmpegCaptureOutput<FFmpegRawAudioInput>, AudioCapturer)>,
}

unsafe impl Send for InProgressRecording {}
unsafe impl Sync for InProgressRecording {}

impl InProgressRecording {
    pub async fn stop(&mut self) {
        self.ffmpeg_process.stop();

        if let Err(e) = self.ffmpeg_process.wait() {
            eprintln!("Failed to wait for ffmpeg process: {:?}", e);
        }

        self.display.capture.stop();
        if let Some(camera) = &self.camera {
            camera.capture.stop();
        }
        if let Some(audio) = &mut self.audio {
            audio.1.stop().ok();
        }
    }
}

pub struct FFmpegCaptureOutput<T> {
    pub input: FFmpegInput<T>,
    pub capture: NamedPipeCapture,
    pub output_path: PathBuf,
}

pub async fn start(
    recording_dir: PathBuf,
    recording_options: &RecordingOptions,
) -> InProgressRecording {
    let content_dir = recording_dir.join("content");

    std::fs::create_dir_all(&content_dir).unwrap();

    let now = Instant::now();

    let mut ffmpeg = FFmpeg::new();

    let (start_writing_tx, start_writing_rx) = watch::channel(false);

    let (display, camera, audio) = tokio::join!(
        start_display_recording(&content_dir, recording_options, start_writing_rx.clone()),
        start_camera_recording(&content_dir, recording_options, start_writing_rx.clone()),
        start_audio_recording(&content_dir, recording_options, start_writing_rx.clone())
    );

    // let latest_start_time = std::cmp::max(
    //     display.2,
    //     std::cmp::max(
    //         camera.as_ref().map(|c| c.2).unwrap_or(now),
    //         audio.as_ref().map(|a| a.1).unwrap_or(now),
    //     ),
    // );

    let display = {
        let ((width, height), capture, start_time) = display;

        let output_path = content_dir.join("display.mp4");

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
            input: capture.path().clone().into_os_string(),
            width,
            height,
            fps: 30,
            pix_fmt: "bgra",
            // offset: start_time.duration_since(latest_start_time).as_secs_f64(),
            ..Default::default()
        });

        ffmpeg
            .command
            .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            // .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
            // .args(["-movflags", "frag_keyframe+empty_moov"])
            .args([
                "-vf",
                &format!("fps={},scale=in_range=full:out_range=limited", display::FPS),
            ])
            .arg(&output_path);

        FFmpegCaptureOutput {
            input: ffmpeg_input,
            capture,
            output_path,
        }
    };

    let camera = if let Some((format, capture, start_time)) = camera {
        use nokhwa::utils::FrameFormat;

        let output_path = content_dir.join("camera.mp4");

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
            input: capture.path().clone().into_os_string(),
            width: format.resolution().width(),
            height: format.resolution().height(),
            fps: 30,
            // fps: format.frame_rate(),
            pix_fmt: match format.format() {
                FrameFormat::YUYV => "uyvy422",
                FrameFormat::RAWRGB => "rgb24",
                FrameFormat::NV12 => "nv12",
                _ => panic!("unimplemented"),
            },
            // offset: start_time.duration_since(latest_start_time).as_secs_f64(),
        });

        ffmpeg
            .command
            .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
            .args(["-movflags", "frag_keyframe+empty_moov"])
            .args([
                "-vf",
                &format!(
                    "fps={},scale=in_range=full:out_range=limited",
                    ffmpeg_input.fps
                ),
            ])
            .arg(&output_path);

        Some(FFmpegCaptureOutput {
            input: ffmpeg_input,
            capture,
            output_path,
        })
    } else {
        None
    };

    let audio = if let Some((capture, start_time, capturer)) = audio {
        let output_path = content_dir.join("audio-input.mp3");

        dbg!(&capturer.config);

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawAudioInput {
            input: capture.path().clone().into_os_string(),
            sample_format: capturer.sample_format().to_string(),
            sample_rate: capturer.sample_rate(),
            channels: capturer.channels(),
            // offset: start_time.duration_since(latest_start_time).as_secs_f64(),
        });

        ffmpeg
            .command
            .args(["-f", "mp3", "-map", &format!("{}:a", ffmpeg_input.index)])
            .args(["-b:a", "192k"])
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
                capture,
                output_path,
            },
            capturer,
        ))
    } else {
        None
    };

    let ffmpeg_process = ffmpeg.start();

    println!("Starting writing to named pipes");

    start_writing_tx.send(true).unwrap();

    use cap_project::*;
    let meta = RecordingMeta {
        display: Display {
            path: display
                .output_path
                .strip_prefix(&recording_dir)
                .unwrap()
                .to_owned(),
            width: display.input.width,
            height: display.input.height,
        },
        camera: camera.as_ref().map(|camera| Camera {
            path: camera
                .output_path
                .strip_prefix(&recording_dir)
                .unwrap()
                .to_owned(),
            width: camera.input.width,
            height: camera.input.height,
        }),
        audio: audio.as_ref().map(|(audio, _)| Audio {
            path: audio
                .output_path
                .strip_prefix(&recording_dir)
                .unwrap()
                .to_owned(),
            sample_rate: audio.input.sample_rate,
            channels: audio.input.channels,
        }),
    };

    std::fs::write(
        recording_dir.join("recording-meta.json"),
        serde_json::to_string(&meta).unwrap(),
    )
    .ok();

    InProgressRecording {
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

async fn start_camera_recording(
    content_path: &PathBuf,
    recording_options: &RecordingOptions,
    start_writing_rx: watch::Receiver<bool>,
) -> Option<(CameraFormat, NamedPipeCapture, Instant)> {
    let Some(camera_info) = recording_options
        .camera_label
        .as_ref()
        .and_then(|camera_label| camera::find_camera_by_label(camera_label))
    else {
        return None;
    };

    let pipe_path = content_path.join("camera.pipe");

    Some(camera::start_capturing(pipe_path.clone(), camera_info, start_writing_rx).await)
}

async fn start_display_recording(
    content_path: &PathBuf,
    recording_options: &RecordingOptions,
    start_writing_rx: watch::Receiver<bool>,
) -> ((u32, u32), NamedPipeCapture, Instant) {
    let pipe_path = content_path.join("display.pipe");
    display::start_capturing(
        pipe_path.clone(),
        &recording_options.capture_target,
        start_writing_rx,
    )
    .await
}

async fn start_audio_recording(
    content_path: &PathBuf,
    recording_options: &RecordingOptions,
    start_writing_rx: watch::Receiver<bool>,
) -> Option<(NamedPipeCapture, Instant, AudioCapturer)> {
    let Some(mut capturer) = recording_options
        .audio_input_name
        .as_ref()
        .and_then(|name| audio::AudioCapturer::init(name))
    else {
        return None;
    };

    let pipe_path = content_path.join("audio-input.pipe");

    let (capture, start_time) =
        audio::start_capturing(&mut capturer, pipe_path.clone(), start_writing_rx).await;

    Some((capture, start_time, capturer))
}
