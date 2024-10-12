use crate::audio::AudioCapturer;
use crate::camera::CameraFeed;
use crate::capture::CaptureController;
use crate::flags;
use cap_ffmpeg::{FFmpeg, FFmpegInput, FFmpegProcess, FFmpegRawAudioInput};
use device_query::{DeviceQuery, DeviceState};
use futures::future::OptionFuture;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::{
    fs::File,
    sync::{Arc, Mutex},
};
use std::{path::PathBuf, time::Duration};
use tauri::AppHandle;
use tokio::sync::watch;

use objc::rc::autoreleasepool;
use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
use objc::*;

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
    pub display: CaptureController,
    pub display_source: DisplaySource,
    #[serde(skip)]
    pub camera: Option<CaptureController>,
    #[serde(skip)]
    pub audio: Option<(FFmpegCaptureOutput<FFmpegRawAudioInput>, AudioCapturer)>,
    pub segments: Vec<f64>,
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
    pub fn stop(&mut self) {
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
            segments: {
                let relative_segments = self
                    .segments
                    .iter()
                    .map(|s| s - self.segments[0])
                    .collect::<Vec<_>>();

                let mut segments = vec![];

                let mut diff = 0.0;

                for (i, chunk) in relative_segments.chunks_exact(2).enumerate() {
                    if i < relative_segments.len() / 2 {
                        segments.push(RecordingSegment {
                            start: diff,
                            end: chunk[1] - chunk[0] + diff,
                        });
                    }

                    diff += chunk[1] - chunk[0];
                }

                segments
            },
        };

        // Signal the mouse event tracking to stop
        *self.stop_signal.lock().unwrap() = true;

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

        if flags::RECORD_MOUSE {
            // Save mouse events to files
            let mouse_moves_path = self.recording_dir.join("mousemoves.json");
            let mouse_clicks_path = self.recording_dir.join("mouseclicks.json");

            let mouse_moves = self.mouse_moves.lock().unwrap();
            let mouse_clicks = self.mouse_clicks.lock().unwrap();

            let mut mouse_moves_file = File::create(mouse_moves_path).unwrap();
            let mut mouse_clicks_file = File::create(mouse_clicks_path).unwrap();

            serde_json::to_writer(&mut mouse_moves_file, &*mouse_moves).unwrap();
            serde_json::to_writer(&mut mouse_clicks_file, &*mouse_clicks).unwrap();
        }

        meta.save_for_project();
    }

    pub fn stop_and_discard(&mut self) {
        // Signal the mouse event tracking to stop
        *self.stop_signal.lock().unwrap() = true;

        // Stop all recording processes
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

        // Delete all recorded files
        if let Err(e) = std::fs::remove_dir_all(&self.recording_dir) {
            eprintln!("Failed to delete recording directory: {:?}", e);
        }
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
    camera_feed: Option<&CameraFeed>,
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
        OptionFuture::from(camera_feed.map(|camera_feed| {
            camera::start_capturing(
                content_dir.join("camera.mp4"),
                camera_feed,
                start_writing_rx.clone(),
            )
        }),),
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
        segments: vec![SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()],
        recording_dir,
        ffmpeg_process,
        display,
        display_source: match recording_options.capture_target {
            CaptureTarget::Screen { id: screen_id } => DisplaySource::Screen,
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
