use serde::Serialize;
use specta::Type;
use std::path::PathBuf;

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

    let mut ffmpeg = FFmpeg::new();

    let camera = start_camera_recording(&content_dir, recording_options, &mut ffmpeg).await;
    let display = start_display_recording(&content_dir, recording_options, &mut ffmpeg).await;
    let audio = start_audio_recording(&content_dir, recording_options, &mut ffmpeg).await;

    let ffmpeg_process = ffmpeg.start();

    use cap_project::*;
    let meta = RecordingMeta {
        display: Display {
            width: display.input.width,
            height: display.input.height,
        },
        camera: camera.as_ref().map(|camera| Camera {
            width: camera.input.width,
            height: camera.input.height,
        }),
        has_audio: audio.is_some(),
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
    ffmpeg: &mut FFmpeg,
) -> Option<FFmpegCaptureOutput<FFmpegRawVideoInput>> {
    let Some(camera_info) = recording_options
        .camera_label
        .as_ref()
        .and_then(|camera_label| camera::find_camera_by_label(camera_label))
    else {
        return None;
    };

    let pipe_path = content_path.join("camera.pipe");
    let output_path = content_path.join("camera.mp4");

    let (format, capture) = camera::start_capturing(pipe_path.clone(), camera_info).await;

    use nokhwa::utils::FrameFormat;

    let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
        input: pipe_path.into_os_string(),
        width: format.resolution().width(),
        height: format.resolution().height(),
        fps: format.frame_rate(),
        pix_fmt: match format.format() {
            FrameFormat::YUYV => "uyvy422",
            FrameFormat::RAWRGB => "rgb24",
            FrameFormat::NV12 => "nv12",
            _ => panic!("unimplemented"),
        },
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
}

async fn start_display_recording(
    content_path: &PathBuf,
    recording_options: &RecordingOptions,
    ffmpeg: &mut FFmpeg,
) -> FFmpegCaptureOutput<FFmpegRawVideoInput> {
    let pipe_path = content_path.join("display.pipe");
    let output_path = content_path.join("display.mp4");

    let ((width, height), capture) =
        display::start_capturing(pipe_path.clone(), &recording_options.capture_target);

    let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
        input: pipe_path.into_os_string(),
        width,
        height,
        fps: display::FPS,
        pix_fmt: "bgra",
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

    FFmpegCaptureOutput {
        input: ffmpeg_input,
        capture,
        output_path,
    }
}

async fn start_audio_recording(
    content_path: &PathBuf,
    recording_options: &RecordingOptions,
    ffmpeg: &mut FFmpeg,
) -> Option<(FFmpegCaptureOutput<FFmpegRawAudioInput>, AudioCapturer)> {
    let Some(mut capturer) = recording_options
        .audio_input_name
        .as_ref()
        .and_then(|name| audio::AudioCapturer::init(name))
    else {
        return None;
    };

    let pipe_path = content_path.join("audio-input.pipe");
    let output_path = content_path.join("audio-input.mp3");

    let capture = audio::start_capturing(&mut capturer, pipe_path.clone());

    let ffmpeg_input = ffmpeg.add_input(FFmpegRawAudioInput {
        input: pipe_path.into_os_string(),
        sample_format: capturer.sample_format().to_string(),
        sample_rate: capturer.sample_rate(),
        channels: capturer.channels(),
    });

    ffmpeg
        .command
        .args(["-f", "mp3", "-map", &format!("{}:a", ffmpeg_input.index)])
        .args(["-b:a", "128k", "-async", "1", "-vn"])
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
}
