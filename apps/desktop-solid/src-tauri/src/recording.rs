use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

use crate::{
    camera,
    display::{self, get_window_bounds, CaptureTarget},
    ffmpeg::*,
    Bounds, RecordingOptions,
};

use crate::video_renderer::RenderOptions;

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
}

impl InProgressRecording {
    pub async fn stop(&mut self) {
        self.display.capture.stop();
        if let Some(camera) = &self.camera {
            camera.capture.stop();
        }

        self.ffmpeg_process.stop();

        self.ffmpeg_process.wait();

        // let render_options = RenderOptions {
        //     screen_recording_path: self.display.output_path.clone(),
        //     webcam_recording_path: self
        //         .camera
        //         .as_ref()
        //         .map_or(PathBuf::new(), |c| c.output_path.clone()),
        //     webcam_size: (320, 240),
        //     // webcam_style: WebcamStyle {
        //     //     border_radius: 10.0,
        //     //     shadow_color: [0.0, 0.0, 0.0, 0.5],
        //     //     shadow_blur: 5.0,
        //     //     shadow_offset: (2.0, 2.0),
        //     // },
        //     output_size: (1280, 720),
        //     // background: Background::Color([0.0, 0.0, 0.0, 1.0]),
        // };

        // Call render_video
        // if let Err(e) = render_video(render_options).await {
        //     eprintln!("Error rendering video: {:?}", e);
        // }
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

    let ffmpeg_process = ffmpeg.start();

    use recording_meta::*;
    let meta = RecordingMeta {
        display: Display {
            width: display.input.width,
            height: display.input.height,
        },
        camera: camera.as_ref().map(|camera| Camera {
            width: camera.input.width,
            height: camera.input.height,
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
            CaptureTarget::Window(window_number) => DisplaySource::Window {
                bounds: get_window_bounds(window_number).unwrap(),
            },
        },
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

pub mod recording_meta {
    use super::*;

    #[derive(Serialize, Deserialize, Debug)]
    pub struct Display {
        pub width: u32,
        pub height: u32,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct Camera {
        pub width: u32,
        pub height: u32,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RecordingMeta {
        pub display: Display,
        pub camera: Option<Camera>,
    }
}
