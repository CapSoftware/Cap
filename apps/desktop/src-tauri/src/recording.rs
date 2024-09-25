use device_query::{DeviceQuery, DeviceState, MouseState};
use nokhwa::utils::CameraFormat;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{fs::File, io::Write, path::PathBuf, time::Duration};
use tokio::sync::watch;

use objc::rc::autoreleasepool;
use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
use objc::*;
use tauri_nspanel::objc_foundation::{INSString, NSString};

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

#[derive(Serialize, Deserialize, Clone, Type)]
pub struct MouseEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub event_type: String,
    pub unix_time_ms: f64,
    pub x: f64,
    pub y: f64,
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
    #[serde(skip)]
    pub mouse_moves: Arc<Mutex<Vec<MouseEvent>>>,
    #[serde(skip)]
    pub mouse_clicks: Arc<Mutex<Vec<MouseEvent>>>,
    #[serde(skip)]
    pub stop_signal: Arc<Mutex<bool>>,
}

unsafe impl Send for InProgressRecording {}
unsafe impl Sync for InProgressRecording {}

impl InProgressRecording {
    pub async fn stop(&mut self) {
        // Signal the mouse event tracking to stop
        *self.stop_signal.lock().unwrap() = true;

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

        // Save mouse events to files
        let mouse_moves_path = self.recording_dir.join("mousemoves.json");
        let mouse_clicks_path = self.recording_dir.join("mouseclicks.json");

        let mouse_moves = self.mouse_moves.lock().unwrap();
        let mouse_clicks = self.mouse_clicks.lock().unwrap();

        let mut mouse_moves_file = File::create(mouse_moves_path).unwrap();
        let mut mouse_clicks_file = File::create(mouse_clicks_path).unwrap();

        serde_json::to_writer(&mut mouse_moves_file, &*mouse_moves).unwrap();
        serde_json::to_writer(&mut mouse_clicks_file, &*mouse_clicks).unwrap();

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
            audio: self.audio.as_ref().map(|(audio, _)| AudioMeta {
                path: audio
                    .output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            }),
        }
        .save_for_project();
    }
}

pub struct FFmpegCaptureOutput<T> {
    pub input: FFmpegInput<T>,
    pub capture: NamedPipeCapture,
    pub output_path: PathBuf,
    pub start_time: Instant,
}

pub async fn start(
    recording_dir: PathBuf,
    recording_options: &RecordingOptions,
) -> InProgressRecording {
    let content_dir = recording_dir.join("content");

    std::fs::create_dir_all(&content_dir).unwrap();

    let mut ffmpeg = FFmpeg::new();

    let (start_writing_tx, start_writing_rx) = watch::channel(false);

    let (display, camera, audio) = tokio::join!(
        start_display_recording(&content_dir, recording_options, start_writing_rx.clone()),
        start_camera_recording(&content_dir, recording_options, start_writing_rx.clone()),
        start_audio_recording(&content_dir, recording_options, start_writing_rx.clone())
    );

    let display = {
        let ((width, height), capture, start_time) = display;

        let output_path = content_dir.join("display.mp4");

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
            input: capture.path().clone().into_os_string(),
            width,
            height,
            fps: 0,
            pix_fmt: "bgra",
            ..Default::default()
        });

        let keyframe_interval_secs = 2;
        let keyframe_interval = keyframe_interval_secs * display::FPS;
        let keyframe_interval_str = keyframe_interval.to_string();

        ffmpeg
            .command
            .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-g", &keyframe_interval_str])
            .args(["-keyint_min", &keyframe_interval_str])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .args([
                "-vf",
                &format!("fps={},scale=in_range=full:out_range=limited", display::FPS),
            ])
            .arg(&output_path);

        FFmpegCaptureOutput {
            input: ffmpeg_input,
            capture,
            output_path,
            start_time,
        }
    };

    let camera = if let Some((format, capture, start_time)) = camera {
        use nokhwa::utils::FrameFormat;

        let output_path = content_dir.join("camera.mp4");

        let fps = 30;

        let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
            input: capture.path().clone().into_os_string(),
            width: format.resolution().width(),
            height: format.resolution().height(),
            fps,
            pix_fmt: match format.format() {
                FrameFormat::YUYV => "uyvy422",
                FrameFormat::RAWRGB => "rgb24",
                FrameFormat::NV12 => "nv12",
                _ => panic!("unimplemented"),
            },
        });

        let keyframe_interval_secs = 2;
        let keyframe_interval = keyframe_interval_secs * fps;
        let keyframe_interval_str = keyframe_interval.to_string();

        ffmpeg
            .command
            .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
            .args(["-movflags", "frag_keyframe+empty_moov"])
            .args(["-g", &keyframe_interval_str])
            .args(["-keyint_min", &keyframe_interval_str])
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
            start_time,
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
            wallclock: true,
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
                start_time,
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

    // Initialize mouse event tracking
    let mouse_moves = Arc::new(Mutex::new(Vec::new()));
    let mouse_clicks = Arc::new(Mutex::new(Vec::new()));
    let stop_signal = Arc::new(Mutex::new(false));

    // Start mouse event tracking
    let mouse_moves_clone = Arc::clone(&mouse_moves);
    let mouse_clicks_clone = Arc::clone(&mouse_clicks);
    let stop_signal_clone = Arc::clone(&stop_signal);
    tokio::spawn(async move {
        let device_state = DeviceState::new();
        let mut last_mouse_state = device_state.get_mouse();
        let start_time = Instant::now();

        while !*stop_signal_clone.lock().unwrap() {
            let mouse_state = device_state.get_mouse();
            let elapsed = start_time.elapsed().as_secs_f64() * 1000.0;
            let unix_time = chrono::Utc::now().timestamp_millis() as f64;

            if mouse_state.coords != last_mouse_state.coords {
                let mouse_event = MouseEvent {
                    active_modifiers: vec![],
                    cursor_id: get_cursor_id(),
                    process_time_ms: elapsed,
                    event_type: "mouseMoved".to_string(),
                    unix_time_ms: unix_time,
                    x: mouse_state.coords.0 as f64,
                    y: mouse_state.coords.1 as f64,
                };
                mouse_moves_clone.lock().unwrap().push(mouse_event);
            }

            if mouse_state.button_pressed[0] && !last_mouse_state.button_pressed[0] {
                let mouse_event = MouseEvent {
                    active_modifiers: vec![],
                    cursor_id: get_cursor_id(),
                    process_time_ms: elapsed,
                    event_type: "mouseClicked".to_string(),
                    unix_time_ms: unix_time,
                    x: mouse_state.coords.0 as f64,
                    y: mouse_state.coords.1 as f64,
                };
                mouse_clicks_clone.lock().unwrap().push(mouse_event);
            }

            last_mouse_state = mouse_state;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });

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
        mouse_moves,
        mouse_clicks,
        stop_signal,
    }
}

fn get_cursor_id() -> String {
    autoreleasepool(|| {
        // Get the NSCursor class
        let nscursor_class = match Class::get("NSCursor") {
            Some(cls) => cls,
            None => return "Unknown".to_string(),
        };

        unsafe {
            // Get the current cursor
            let current_cursor: *mut Object = msg_send![nscursor_class, currentSystemCursor];
            if current_cursor.is_null() {
                return "Unknown".to_string();
            }

            // Define an array of known cursor names
            let cursor_names = [
                "arrowCursor",
                "IBeamCursor",
                "crosshairCursor",
                "closedHandCursor",
                "openHandCursor",
                "pointingHandCursor",
                "resizeLeftCursor",
                "resizeRightCursor",
                "resizeLeftRightCursor",
                "resizeUpCursor",
                "resizeDownCursor",
                "resizeUpDownCursor",
                "disappearingItemCursor",
                "IBeamCursorForVerticalLayout",
                "operationNotAllowedCursor",
                "dragLinkCursor",
                "dragCopyCursor",
                "contextualMenuCursor",
            ];

            // Iterate through known cursor names
            for cursor_name in cursor_names.iter() {
                let sel = Sel::register(cursor_name);
                let cursor: *mut Object = msg_send![nscursor_class, performSelector:sel];
                if !cursor.is_null() {
                    let is_equal: BOOL = msg_send![current_cursor, isEqual:cursor];
                    if is_equal == YES {
                        return cursor_name.to_string();
                    }
                }
            }

            // If no match is found, return "Unknown"
            "Unknown".to_string()
        }
    })
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
