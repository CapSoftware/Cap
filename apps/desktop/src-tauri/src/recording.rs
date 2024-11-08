use cap_flags::FLAGS;
use cap_media::{encoders::*, feeds::*, filters::*, pipeline::*, sources::*, MediaError};
use cap_project::{CursorClickEvent, CursorMoveEvent, RecordingMeta};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::path::PathBuf;
use tokio::sync::oneshot;

use crate::cursor::spawn_cursor_recorder;
use crate::RecordingOptions;

// TODO: Hacky, please fix
pub const FPS: u32 = 30;

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_screens() -> Vec<CaptureScreen> {
    ScreenCaptureSource::list_screens()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_windows() -> Vec<CaptureWindow> {
    ScreenCaptureSource::list_targets()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<String> {
    CameraFeed::list_cameras()
}

#[derive(Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgressRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    #[serde(skip)]
    pub pipeline: Pipeline<RealTimeClock<()>>,
    #[serde(skip)]
    pub display_output_path: PathBuf,
    #[serde(skip)]
    pub camera_output_path: Option<PathBuf>,
    #[serde(skip)]
    pub audio_output_path: Option<PathBuf>,
    pub display_source: ScreenCaptureTarget,
    pub segments: Vec<f64>,
    #[serde(skip)]
    pub cursor_moves: oneshot::Receiver<Vec<CursorMoveEvent>>,
    #[serde(skip)]
    pub cursor_clicks: oneshot::Receiver<Vec<CursorClickEvent>>,
    #[serde(skip)]
    pub stop_signal: Arc<AtomicBool>,
}

unsafe impl Send for InProgressRecording {}
unsafe impl Sync for InProgressRecording {}

pub struct CompletedRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    pub display_output_path: PathBuf,
    pub camera_output_path: Option<PathBuf>,
    pub audio_output_path: Option<PathBuf>,
    pub display_source: ScreenCaptureTarget,
    pub segments: Vec<f64>,
    pub meta: RecordingMeta,
    pub cursor_data: cap_project::CursorData,
}

impl InProgressRecording {
    pub async fn stop(mut self) -> CompletedRecording {
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
                    .display_output_path
                    .strip_prefix(&self.recording_dir)
                    .unwrap()
                    .to_owned(),
            },
            camera: self.camera_output_path.as_ref().map(|path| CameraMeta {
                path: path.strip_prefix(&self.recording_dir).unwrap().to_owned(),
            }),
            audio: self.audio_output_path.as_ref().map(|path| AudioMeta {
                path: path.strip_prefix(&self.recording_dir).unwrap().to_owned(),
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
            cursor: Some(PathBuf::from("cursor.json")),
        };

        // Signal the mouse event tracking to stop
        if let Err(error) = self.pipeline.shutdown().await {
            eprintln!("Error while stopping recording: {error}");
        }

        self.stop_signal
            .store(true, std::sync::atomic::Ordering::Relaxed);

        let cursor_data = cap_project::CursorData {
            clicks: self.cursor_clicks.await.unwrap(),
            moves: self.cursor_moves.await.unwrap(),
            cursor_images: HashMap::new(), // This will be populated during recording
        };

        if FLAGS.record_mouse {
            // Save mouse events to files
            let mut file = File::create(self.recording_dir.join("cursor.json")).unwrap();
            serde_json::to_writer_pretty(&mut file, &cursor_data).unwrap();
        }

        meta.save_for_project();

        CompletedRecording {
            id: self.id,
            recording_dir: self.recording_dir,
            display_output_path: self.display_output_path,
            camera_output_path: self.camera_output_path,
            audio_output_path: self.audio_output_path,
            display_source: self.display_source,
            segments: self.segments,
            meta,
            cursor_data,
        }
    }

    pub async fn stop_and_discard(&mut self) {
        // Signal the mouse event tracking to stop
        if let Err(error) = self.pipeline.shutdown().await {
            eprintln!("Error while stopping recording: {error}");
        }

        // Delete all recorded files
        if let Err(e) = std::fs::remove_dir_all(&self.recording_dir) {
            eprintln!("Failed to delete recording directory: {:?}", e);
        }
    }

    pub async fn pause(&mut self) -> Result<(), String> {
        let _ = self.pipeline.pause().await;
        Ok(())
    }

    pub async fn play(&mut self) -> Result<(), String> {
        let _ = self.pipeline.play().await;
        Ok(())
    }
}

pub async fn start(
    id: String,
    recording_dir: PathBuf,
    recording_options: &RecordingOptions,
    camera_feed: Option<&CameraFeed>,
) -> Result<InProgressRecording, MediaError> {
    let content_dir = recording_dir.join("content");
    let cursors_dir = content_dir.join("cursors");

    std::fs::create_dir_all(&content_dir).unwrap();
    std::fs::create_dir_all(&cursors_dir).unwrap();

    let clock = RealTimeClock::<()>::new();
    let mut pipeline_builder = Pipeline::builder(clock);

    let display_output_path = content_dir.join("display.mp4");
    let mut audio_output_path = None;
    let mut camera_output_path = None;

    let screen_source =
        ScreenCaptureSource::init(dbg!(&recording_options.capture_target), None, None);
    let screen_config = screen_source.info();
    let screen_bounds = screen_source.bounds;

    let output_config = screen_config.scaled(1920, 30);
    let screen_filter = VideoFilter::init("screen", screen_config, output_config)?;
    let screen_encoder = H264Encoder::init(
        "screen",
        output_config,
        Output::File(display_output_path.clone()),
    )?;
    pipeline_builder = pipeline_builder
        .source("screen_capture", screen_source)
        .pipe("screen_capture_filter", screen_filter)
        .sink("screen_capture_encoder", screen_encoder);

    if let Some(mic_source) = recording_options
        .audio_input_name
        .as_ref()
        .and_then(|name| AudioInputSource::init(name))
    {
        let mic_config = mic_source.info();
        audio_output_path = Some(content_dir.join("audio-input.mp3"));

        // let mic_filter = AudioFilter::init("microphone", mic_config, "aresample=async=1:min_hard_comp=0.100000:first_pts=0")?;
        let mic_encoder = MP3Encoder::init(
            "microphone",
            mic_config,
            Output::File(audio_output_path.clone().unwrap()),
        )?;

        pipeline_builder = pipeline_builder
            .source("microphone_capture", mic_source)
            // .pipe("microphone_filter", mic_filter)
            .sink("microphone_encoder", mic_encoder);
    }

    if let Some(camera_source) = CameraSource::init(camera_feed) {
        let camera_config = camera_source.info();
        let output_config = camera_config.scaled(1920, 30);
        camera_output_path = Some(content_dir.join("camera.mp4"));

        let camera_filter = VideoFilter::init("camera", camera_config, output_config)?;
        let camera_encoder = H264Encoder::init(
            "camera",
            output_config,
            Output::File(camera_output_path.clone().unwrap()),
        )?;

        pipeline_builder = pipeline_builder
            .source("camera_capture", camera_source)
            .pipe("camera_filter", camera_filter)
            .sink("camera_encoder", camera_encoder);
    }

    let mut pipeline = pipeline_builder.build().await?;
    pipeline.play().await?;

    let stop_signal = Arc::new(AtomicBool::new(false));

    // Initialize default values for cursor channels
    let (mouse_moves, mouse_clicks) = if FLAGS.record_mouse {
        spawn_cursor_recorder(stop_signal.clone(), screen_bounds, content_dir, cursors_dir)
    } else {
        // Create dummy channels that will never receive data
        let (move_tx, move_rx) = oneshot::channel();
        let (click_tx, click_rx) = oneshot::channel();
        // Send empty vectors immediately
        move_tx.send(vec![]).unwrap();
        click_tx.send(vec![]).unwrap();
        (move_rx, click_rx)
    };

    Ok(InProgressRecording {
        id,
        segments: vec![SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()],
        pipeline,
        recording_dir,
        display_source: recording_options.capture_target.clone(),
        display_output_path,
        audio_output_path,
        camera_output_path,
        cursor_moves: mouse_moves,
        cursor_clicks: mouse_clicks,
        stop_signal,
    })
}
