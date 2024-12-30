use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use cap_flags::FLAGS;
use cap_media::{
    encoders::{H264Encoder, MP3Encoder, Output},
    feeds::{AudioInputFeed, CameraFeed},
    filters::VideoFilter,
    pipeline::{builder::PipelineBuilder, Pipeline, RealTimeClock},
    sources::{AudioInputSource, CameraSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::{CursorEvents, RecordingMeta};
use either::Either;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};

use crate::{
    cursor::{spawn_cursor_recorder, CursorActor, Cursors},
    RecordingOptions,
};

enum ActorState {
    Recording {
        pipeline: RecordingPipeline,
        index: u32,
        segment_start_time: f64,
    },
    Paused {
        next_index: u32,
        cursors: Cursors,
        next_cursor_id: i32,
    },
    Stopped,
}

pub enum ActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<CompletedRecording, RecordingError>>),
}

pub struct Actor {
    id: String,
    recording_dir: PathBuf,
    options: RecordingOptions,
    segments: Vec<RecordingSegment>,
}

pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: RecordingPipeline,
}

struct RecordingPipeline {
    pub inner: Pipeline<RealTimeClock<()>>,
    pub display_output_path: PathBuf,
    pub audio_output_path: Option<PathBuf>,
    pub camera_output_path: Option<PathBuf>,
    pub cursor: Option<CursorPipeline>,
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: CursorActor,
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
    #[error("Media error: {0}")]
    Media(#[from] MediaError),

    #[error("Actor error: {0}")]
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

    pub async fn pause(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Resume)
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

    let segments_dir = ensure_dir(content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(content_dir.join("cursors"))?;

    let screen_source = create_screen_capture(&options);

    let index = 0;
    let pipeline = create_segment_pipeline(
        &segments_dir,
        &cursors_dir,
        index,
        screen_source.clone(),
        camera_feed.as_deref(),
        audio_input_feed.as_ref(),
        Default::default(),
        0,
    )
    .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    tokio::spawn({
        let options = options.clone();
        async move {
            let mut actor = Actor {
                id,
                recording_dir,
                options,
                segments: Vec::new(),
            };

            let mut state = ActorState::Recording {
                pipeline,
                index,
                segment_start_time,
            };

            loop {
                state = match state {
                    ActorState::Recording {
                        pipeline,
                        index,
                        segment_start_time,
                    } => loop {
                        let Ok(msg) = ctrl_rx.recv_async().await else {
                            return;
                        };

                        async fn shutdown(
                            mut pipeline: RecordingPipeline,
                            actor: &mut Actor,
                            segment_start_time: f64,
                        ) -> Result<(Cursors, i32), RecordingError> {
                            pipeline.inner.shutdown().await?;

                            let segment_stop_time = current_time_f64();

                            let cursors = if let Some(cursor) = pipeline.cursor.take() {
                                let res = cursor.actor.stop().await;

                                dbg!(&res.cursors);

                                std::fs::write(
                                    &cursor.output_path,
                                    serde_json::to_string_pretty(&CursorEvents {
                                        clicks: res.clicks,
                                        moves: res.moves,
                                    })?,
                                )?;

                                (res.cursors, res.next_cursor_id)
                            } else {
                                Default::default()
                            };

                            actor.segments.push(RecordingSegment {
                                start: segment_start_time,
                                end: segment_stop_time,
                                pipeline,
                            });

                            Ok(cursors)
                        }

                        break match msg {
                            ActorControlMessage::Pause(tx) => {
                                let (res, cursors, next_cursor_id) = match shutdown(
                                    pipeline,
                                    &mut actor,
                                    segment_start_time,
                                )
                                .await
                                {
                                    Ok((cursors, next_cursor_id)) => {
                                        (Ok(()), cursors, next_cursor_id)
                                    }
                                    Err(e) => (Err(e), Default::default(), 0),
                                };

                                tx.send(res.map_err(Into::into)).ok();
                                ActorState::Paused {
                                    next_index: index + 1,
                                    cursors,
                                    next_cursor_id,
                                }
                            }
                            ActorControlMessage::Stop(tx) => {
                                let res = shutdown(pipeline, &mut actor, segment_start_time).await;
                                let res = match res {
                                    Ok((cursors, _)) => stop_recording(actor, cursors).await,
                                    Err(e) => Err(e),
                                };

                                tx.send(res).ok();

                                return;
                            }
                            _ => continue,
                        };
                    },
                    ActorState::Paused {
                        next_index,
                        cursors,
                        next_cursor_id,
                    } => loop {
                        let Ok(msg) = ctrl_rx.recv_async().await else {
                            return;
                        };

                        break match msg {
                            ActorControlMessage::Stop(tx) => {
                                tx.send(stop_recording(actor, cursors).await).ok();
                                return;
                            }
                            ActorControlMessage::Resume(tx) => {
                                let (state, res) = match create_segment_pipeline(
                                    &segments_dir,
                                    &cursors_dir,
                                    next_index,
                                    screen_source.clone(),
                                    camera_feed.as_deref(),
                                    audio_input_feed.as_ref(),
                                    cursors,
                                    next_cursor_id,
                                )
                                .await
                                {
                                    Ok(pipeline) => (
                                        ActorState::Recording {
                                            pipeline,
                                            index: next_index,
                                            segment_start_time: current_time_f64(),
                                        },
                                        Ok(()),
                                    ),
                                    Err(e) => (ActorState::Stopped, Err(e.into())),
                                };

                                tx.send(res).ok();

                                state
                            }
                            _ => continue,
                        };
                    },
                    ActorState::Stopped => return,
                };
            }
        }
    });

    Ok(ActorHandle { ctrl_tx, options })
}

pub struct CompletedRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: RecordingMeta,
    pub cursor_data: cap_project::CursorImages,
    pub segments: Vec<RecordingSegment>,
}

async fn stop_recording(
    actor: Actor,
    cursors: Cursors,
) -> Result<CompletedRecording, RecordingError> {
    use cap_project::*;

    let meta = RecordingMeta {
        project_path: actor.recording_dir.clone(),
        sharing: None,
        pretty_name: format!(
            "Cap {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        content: Content::MultipleSegments {
            inner: MultipleSegments {
                segments: {
                    actor
                        .segments
                        .iter()
                        .map(|s| MultipleSegment {
                            display: Display {
                                path: s
                                    .pipeline
                                    .display_output_path
                                    .strip_prefix(&actor.recording_dir)
                                    .unwrap()
                                    .to_owned(),
                            },
                            camera: s
                                .pipeline
                                .camera_output_path
                                .as_ref()
                                .map(|path| CameraMeta {
                                    path: path
                                        .strip_prefix(&actor.recording_dir)
                                        .unwrap()
                                        .to_owned(),
                                }),
                            audio: s.pipeline.audio_output_path.as_ref().map(|path| AudioMeta {
                                path: path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
                            }),
                            cursor: None,
                        })
                        .collect()
                },
                cursors: cursors
                    .into_values()
                    .map(|(file_name, id)| {
                        (
                            id.to_string(),
                            PathBuf::from("content/cursors").join(&file_name),
                        )
                    })
                    .collect(),
            },
        },
    };

    meta.save_for_project()
        .map_err(Either::either_into::<RecordingError>)?;

    Ok(CompletedRecording {
        id: actor.id,
        meta,
        cursor_data: Default::default(),
        recording_dir: actor.recording_dir,
        display_source: actor.options.capture_target,
        segments: actor.segments,
    })
}

fn create_screen_capture(
    recording_options: &RecordingOptions,
) -> ScreenCaptureSource<impl MakeCapturePipeline> {
    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            dbg!(&recording_options.capture_target),
            recording_options.output_resolution.clone(),
            None,
            recording_options.fps,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<cap_media::sources::AVFrameCapture>::init(
            dbg!(&recording_options.capture_target),
            recording_options.output_resolution.clone(),
            None,
            recording_options.fps,
        )
    }
}

async fn create_segment_pipeline<TCaptureFormat: MakeCapturePipeline>(
    segments_dir: &PathBuf,
    cursors_dir: &PathBuf,
    index: u32,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    camera_feed: Option<&Mutex<CameraFeed>>,
    audio_input_feed: Option<&AudioInputFeed>,
    prev_cursors: Cursors,
    next_cursors_id: i32,
) -> Result<RecordingPipeline, MediaError> {
    let camera_feed = match camera_feed.as_ref() {
        Some(camera_feed) => Some(camera_feed.lock().await),
        None => None,
    };
    let camera_feed = camera_feed.as_deref();

    let dir = ensure_dir(segments_dir.join(format!("segment-{index}")))?;

    let clock = RealTimeClock::<()>::new();
    let mut pipeline_builder = Pipeline::builder(clock);

    let display_output_path = dir.join("display.mp4");
    let mut audio_output_path = None;
    let mut camera_output_path = None;

    let screen_bounds = screen_source.get_bounds();
    pipeline_builder = TCaptureFormat::make_capture_pipeline(
        pipeline_builder,
        screen_source,
        &display_output_path,
    )?;

    if let Some(mic_source) = audio_input_feed.map(AudioInputSource::init) {
        let mic_config = mic_source.info();
        audio_output_path = Some(dir.join("audio-input.mp3"));

        let mic_encoder = MP3Encoder::init(
            "microphone",
            mic_config,
            Output::File(audio_output_path.clone().unwrap()),
        )?;

        pipeline_builder = pipeline_builder
            .source("microphone_capture", mic_source)
            .sink("microphone_encoder", mic_encoder);
    }

    if let Some(camera_source) = camera_feed.map(CameraSource::init) {
        let camera_config = camera_source.info();
        let output_config = camera_config.scaled(1280_u32, 30_u32);
        camera_output_path = Some(dir.join("camera.mp4"));

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

    let cursor = FLAGS.record_mouse.then(|| {
        let cursor = spawn_cursor_recorder(
            screen_bounds,
            cursors_dir.clone(),
            prev_cursors,
            next_cursors_id,
        );

        CursorPipeline {
            output_path: dir.join("cursor.json"),
            actor: cursor,
        }
    });

    pipeline.play().await?;

    Ok(RecordingPipeline {
        inner: pipeline,
        display_output_path,
        audio_output_path,
        camera_output_path,
        cursor,
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

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let screen_config = source.info();
        let screen_encoder = cap_media::encoders::H264AVAssetWriterEncoder::init(
            "screen",
            screen_config,
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
        let screen_filter = VideoFilter::init("screen", screen_config, screen_config)?;
        let screen_encoder =
            H264Encoder::init("screen", screen_config, Output::File(output_path.into()))?;
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
