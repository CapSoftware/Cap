use cap_flags::FLAGS;
use cap_media::{
    encoders::{H264Encoder, MP3Encoder, Output},
    feeds::{AudioInputFeed, CameraFeed},
    filters::VideoFilter,
    pipeline::{builder::PipelineBuilder, Pipeline, RealTimeClock},
    sources::{AudioInputSource, CameraSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::{CursorClickEvent, CursorMoveEvent, RecordingMeta};
use either::Either;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};

use crate::{cursor::spawn_cursor_recorder, RecordingOptions};

pub enum ActorControlMessage {
    Stop(oneshot::Sender<Result<CompletedRecording, RecordingError>>),
}

pub struct Actor {
    id: String,
    recording_dir: PathBuf,
    options: RecordingOptions,
    pipeline: RecordingPipeline,
    start_time: f64,
    stop_signal: Arc<AtomicBool>,
    cursor_moves: oneshot::Receiver<Vec<CursorMoveEvent>>,
    cursor_clicks: oneshot::Receiver<Vec<CursorClickEvent>>,
}

pub struct ActorHandle {
    ctrl_tx: flume::Sender<ActorControlMessage>,
    pub options: RecordingOptions,
}

#[derive(Error, Debug)]
pub enum ActorError {
    #[error("Actor has stopped")]
    ActorStopped,

    #[error("Failed to send to actor")]
    SendFailed(#[from] flume::SendError<ActorControlMessage>),
}

#[derive(Error, Debug)]
pub enum RecordingError {
    #[error("Media/{0}")]
    Media(#[from] MediaError),

    #[error("Actor/{0}")]
    Actor(#[from] ActorError),

    #[error("Serde/{0}")]
    Serde(#[from] serde_json::Error),

    #[error("IO/{0}")]
    Io(#[from] std::io::Error),
}

macro_rules! send_message {
    ($ctrl_tx:expr, $variant:path) => {{
        let (tx, rx) = oneshot::channel();
        $ctrl_tx.send($variant(tx)).map_err(ActorError::from)?;
        rx.await.map_err(|_| ActorError::ActorStopped)?
    }};
}

impl ActorHandle {
    pub async fn stop(&self) -> Result<CompletedRecording, RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Stop)
    }
}

pub async fn spawn_recording_actor(
    id: String,
    recording_dir: impl Into<PathBuf>,
    options: RecordingOptions,
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    audio_input_feed: Option<AudioInputFeed>,
) -> Result<ActorHandle, RecordingError> {
    let recording_dir = recording_dir.into();

    let content_dir = ensure_dir(recording_dir.join("content"))?;
    let cursors_dir = ensure_dir(content_dir.join("cursors"))?;

    let screen_source = create_screen_capture(&options);

    let pipeline = create_pipeline(
        &content_dir,
        screen_source.clone(),
        camera_feed.as_deref(),
        audio_input_feed.as_ref(),
    )
    .await?;

    let start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    let stop_signal = Arc::new(AtomicBool::new(false));

    // Initialize default values for cursor channels
    let (cursor_moves, cursor_clicks) = if FLAGS.record_mouse {
        spawn_cursor_recorder(
            stop_signal.clone(),
            screen_source.get_bounds(),
            content_dir,
            cursors_dir,
        )
    } else {
        // Create dummy channels that will never receive data
        let (move_tx, move_rx) = oneshot::channel();
        let (click_tx, click_rx) = oneshot::channel();
        // Send empty vectors immediately
        move_tx.send(vec![]).unwrap();
        click_tx.send(vec![]).unwrap();
        (move_rx, click_rx)
    };

    tokio::spawn({
        let options = options.clone();
        async move {
            let actor = Actor {
                recording_dir,
                options,
                pipeline,
                start_time,
                cursor_moves,
                cursor_clicks,
                stop_signal,
                id,
            };

            loop {
                let Ok(ActorControlMessage::Stop(tx)) = ctrl_rx.recv_async().await else {
                    return;
                };

                let resp = stop_recording(actor).await;

                tx.send(resp).ok();
                return;
            }
        }
    });

    Ok(ActorHandle { ctrl_tx, options })
}

pub struct CompletedRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    pub display_output_path: PathBuf,
    pub camera_output_path: Option<PathBuf>,
    pub audio_output_path: Option<PathBuf>,
    pub display_source: ScreenCaptureTarget,
    pub meta: RecordingMeta,
    pub cursor_data: cap_project::CursorData,
    pub segments: Vec<f64>,
}

async fn stop_recording(mut actor: Actor) -> Result<CompletedRecording, RecordingError> {
    let segment = (actor.start_time, current_time_f64());

    use cap_project::*;

    let meta = RecordingMeta {
        project_path: actor.recording_dir.clone(),
        sharing: None,
        pretty_name: format!(
            "Cap {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        display: Display {
            path: actor
                .pipeline
                .display_output_path
                .strip_prefix(&actor.recording_dir)
                .unwrap()
                .to_owned(),
        },
        camera: actor
            .pipeline
            .camera_output_path
            .as_ref()
            .map(|path| CameraMeta {
                path: path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
            }),
        audio: actor
            .pipeline
            .audio_output_path
            .as_ref()
            .map(|path| AudioMeta {
                path: path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
            }),
        segments: {
            let segments = [segment];

            let relative_segments = segments
                .iter()
                .map(|(l, r)| (l - segments[0].0, r - segments[0].0))
                .collect::<Vec<_>>();

            let mut segments = vec![];

            let mut diff = 0.0;

            for (i, chunk) in relative_segments.iter().enumerate() {
                if i < relative_segments.len() / 2 {
                    segments.push(RecordingSegment {
                        start: diff,
                        end: chunk.1 - chunk.0 + diff,
                    });
                }

                diff += chunk.1 - chunk.0;
            }

            segments
        },
        cursor: Some(PathBuf::from("cursor.json")),
    };

    actor.pipeline.inner.shutdown().await?;

    actor
        .stop_signal
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let cursor_data = cap_project::CursorData {
        clicks: actor.cursor_clicks.await.unwrap_or_default(),
        moves: actor.cursor_moves.await.unwrap_or_default(),
        cursor_images: HashMap::new(), // This will be populated during recording
    };

    meta.save_for_project()
        .map_err(Either::either_into::<RecordingError>)?;

    Ok(CompletedRecording {
        id: actor.id,
        meta,
        cursor_data,
        recording_dir: actor.recording_dir,
        display_output_path: actor.pipeline.display_output_path,
        camera_output_path: actor.pipeline.camera_output_path,
        audio_output_path: actor.pipeline.audio_output_path,
        display_source: actor.options.capture_target,
        segments: vec![segment.0, segment.1],
    })
}

fn create_screen_capture(
    recording_options: &RecordingOptions,
) -> ScreenCaptureSource<impl MakeCapturePipeline> {
    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<AVFrameCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
}

struct RecordingPipeline {
    pub inner: Pipeline<RealTimeClock<()>>,
    pub display_output_path: PathBuf,
    pub audio_output_path: Option<PathBuf>,
    pub camera_output_path: Option<PathBuf>,
}

async fn create_pipeline<TCaptureFormat: MakeCapturePipeline>(
    content_dir: &PathBuf,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    camera_feed: Option<&Mutex<CameraFeed>>,
    audio_input_feed: Option<&AudioInputFeed>,
) -> Result<RecordingPipeline, MediaError> {
    let camera_feed = match camera_feed.as_ref() {
        Some(camera_feed) => Some(camera_feed.lock().await),
        None => None,
    };
    let camera_feed = camera_feed.as_deref();

    let clock = RealTimeClock::<()>::new();
    let mut pipeline_builder = Pipeline::builder(clock);

    let display_output_path = content_dir.join("display.mp4");
    let mut audio_output_path = None;
    let mut camera_output_path = None;

    pipeline_builder = TCaptureFormat::make_capture_pipeline(
        pipeline_builder,
        screen_source,
        &display_output_path,
    )?;

    if let Some(mic_source) = audio_input_feed.map(AudioInputSource::init) {
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

    if let Some(camera_source) = camera_feed.map(CameraSource::init) {
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

    Ok(RecordingPipeline {
        inner: pipeline,
        display_output_path,
        audio_output_path,
        camera_output_path,
    })
}

fn ensure_dir(path: PathBuf) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

trait MakeCapturePipeline: 'static {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;
}

impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let screen_config = source.info();

        let output_config = screen_config.scaled(1920, 30);
        let screen_encoder = cap_media::encoders::H264AVAssetWriterEncoder::init(
            "screen",
            output_config,
            Output::File(output_path.into()),
        )?;

        Ok(builder
            .source("screen_capture", source)
            .sink("screen_capture_encoder", screen_encoder))
    }
}

impl MakeCapturePipeline for cap_media::sources::AVFrameCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let screen_config = source.info();
        // let screen_bounds = screen_source.bounds;

        let output_config = screen_config.scaled(1920, 30);
        let screen_filter = VideoFilter::init("screen", screen_config, output_config)?;
        let screen_encoder =
            H264Encoder::init("screen", output_config, Output::File(output_path.into()))?;
        Ok(builder
            .source("screen_capture", source)
            .pipe("screen_capture_filter", screen_filter)
            .sink("screen_capture_encoder", screen_encoder))
    }
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
