use std::path::PathBuf;

use scap::Target;

use crate::{camera, display, ffmpeg::*, RecordingOptions};

pub struct InProgressRecording {
    pub recording_dir: PathBuf,
    pub ffmpeg_process: FFmpegProcess,
    pub display: FFmpegCaptureOutput<FFmpegRawVideoInput>,
    pub camera: Option<FFmpegCaptureOutput<FFmpegRawVideoInput>>,
}

impl InProgressRecording {
    pub fn stop(&mut self) {
        self.display.capture.stop();
        if let Some(camera) = &self.camera {
            camera.capture.stop();
        }

        self.ffmpeg_process.stop();
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

    let camera = start_camera_recording(&content_dir, &recording_options, &mut ffmpeg).await;
    let display = start_display_recording(&content_dir, recording_options, &mut ffmpeg).await;

    let ffmpeg_process = ffmpeg.start();

    InProgressRecording {
        recording_dir,
        ffmpeg_process,
        display,
        camera,
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
