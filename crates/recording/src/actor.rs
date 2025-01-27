use std::{
    fs::File,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use cap_flags::FLAGS;
use cap_media::{
    data::Pixel,
    encoders::{H264Encoder, MP3Encoder, Output},
    feeds::{AudioInputFeed, CameraFeed},
    pipeline::{builder::PipelineBuilder, Pipeline, RealTimeClock},
    sources::{AudioInputSource, CameraSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::{CursorEvents, RecordingMeta};
use cap_utils::spawn_actor;
use either::Either;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};
use tracing::{
    debug, info,
    instrument::{self, WithSubscriber},
    trace, Instrument,
};
use tracing_subscriber::{fmt::FormatFields, layer::SubscriberExt, Layer};

use crate::{
    cursor::{spawn_cursor_recorder, CursorActor, Cursors},
    RecordingOptions,
};

enum ActorState {
    Recording {
        pipeline: RecordingPipeline,
        pipeline_done_rx: oneshot::Receiver<()>,
        index: u32,
        segment_start_time: f64,
    },
    Paused {
        next_index: u32,
        cursors: Cursors,
        next_cursor_id: u32,
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
    pub camera: Option<CameraPipelineInfo>,
    pub cursor: Option<CursorPipeline>,
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: CursorActor,
}

#[derive(Clone)]
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
    recording_dir: PathBuf,
    options: RecordingOptions,
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    audio_input_feed: Option<AudioInputFeed>,
) -> Result<(ActorHandle, tokio::sync::oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;
    let logfile = File::create(recording_dir.join("recording-logs.log"))?;

    let collector = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(false)
                .with_writer(logfile)
                .with_filter(
                    tracing_subscriber::filter::EnvFilter::builder()
                        .with_default_directive(tracing::level_filters::LevelFilter::TRACE.into())
                        .from_env_lossy(),
                ),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(false)
                .with_filter(
                    tracing_subscriber::filter::EnvFilter::builder()
                        .with_default_directive(tracing::level_filters::LevelFilter::TRACE.into())
                        .from_env_lossy(),
                ),
        );

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    async {
        async {
            trace!("creating recording actor");

            let content_dir = ensure_dir(&recording_dir.join("content"))?;

            let segments_dir = ensure_dir(&content_dir.join("segments"))?;
            let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

            let screen_source = create_screen_capture(&options);

            debug!("screen capture: {screen_source:#?}");

            if let Some(camera_feed) = &camera_feed {
                let camera_feed = camera_feed.lock().await;
                debug!("camera device info: {:#?}", camera_feed.camera_info());
                debug!("camera video info: {:#?}", camera_feed.video_info());
            }

            if let Some(audio_feed) = &audio_input_feed {
                debug!("mic audio info: {:#?}", audio_feed.audio_info())
            }

            let index = 0;
            let (pipeline, pipeline_done_rx) = create_segment_pipeline(
                &segments_dir,
                &cursors_dir,
                index,
                screen_source.clone(),
                camera_feed.as_deref(),
                audio_input_feed.as_ref(),
                Default::default(),
                index,
            )
            .await?;

            let segment_start_time = current_time_f64();

            let (ctrl_tx, ctrl_rx) = flume::bounded(1);

            trace!("spawning recording actor");

            spawn_actor({
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
                        pipeline_done_rx,
                        index,
                        segment_start_time,
                    };

                    'outer: loop {
                        state = match state {
                            ActorState::Recording {
                                mut pipeline,
                                mut pipeline_done_rx,
                                index,
                                segment_start_time,
                            } => {
                                info!("recording actor recording");
                                loop {
                                    let msg = tokio::select! {
                                        _ = &mut pipeline_done_rx => {
                                            if let Some(cursor) = pipeline.cursor.take() {
                                                cursor.actor.stop().await;
                                            }

                                            break 'outer;
                                        }
                                        msg = ctrl_rx.recv_async() => {
                                            let Ok(msg) = msg else {
                                                break 'outer;
                                            };

                                            msg
                                        }
                                    };

                                    async fn shutdown(
                                        mut pipeline: RecordingPipeline,
                                        actor: &mut Actor,
                                        segment_start_time: f64,
                                    ) -> Result<(Cursors, u32), RecordingError>
                                    {
                                        pipeline.inner.shutdown().await?;

                                        let segment_stop_time = current_time_f64();

                                        let cursors = if let Some(cursor) = pipeline.cursor.take() {
                                            let res = cursor.actor.stop().await;

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
                                            let res =
                                                shutdown(pipeline, &mut actor, segment_start_time)
                                                    .await;
                                            let res = match res {
                                                Ok((cursors, _)) => {
                                                    stop_recording(actor, cursors).await
                                                }
                                                Err(e) => Err(e),
                                            };

                                            tx.send(res).ok();

                                            break 'outer;
                                        }
                                        _ => continue,
                                    };
                                }
                            }
                            ActorState::Paused {
                                next_index,
                                cursors,
                                next_cursor_id,
                            } => {
                                info!("recording actor paused");
                                loop {
                                    let Ok(msg) = ctrl_rx.recv_async().await else {
                                        break 'outer;
                                    };

                                    break match msg {
                                        ActorControlMessage::Stop(tx) => {
                                            tx.send(stop_recording(actor, cursors).await).ok();
                                            break 'outer;
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
                                                Ok((pipeline, pipeline_done_rx)) => (
                                                    ActorState::Recording {
                                                        pipeline,
                                                        pipeline_done_rx,
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
                                }
                            }
                            ActorState::Stopped => {
                                info!("recording actor paused");
                                break;
                            }
                        };
                    }

                    info!("recording actor finished");

                    done_tx.send(()).ok();
                }
                .in_current_span()
            });

            Ok(ActorHandle { ctrl_tx, options })
        }
        .instrument(tracing::info_span!("recording"))
        .await
    }
    .with_subscriber(collector)
    .await
    .map(|a| (a, done_rx))
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
                                fps: actor.options.capture_target.recording_fps(),
                            },
                            camera: s.pipeline.camera.as_ref().map(|camera| CameraMeta {
                                path: camera
                                    .output_path
                                    .strip_prefix(&actor.recording_dir)
                                    .unwrap()
                                    .to_owned(),
                                fps: camera.fps,
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

    let project_config = cap_project::ProjectConfiguration::default();
    project_config
        .write(&actor.recording_dir)
        .map_err(RecordingError::from)?;

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
            &recording_options.capture_target,
            recording_options.output_resolution.clone(),
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<cap_media::sources::AVFrameCapture>::init(
            &recording_options.capture_target,
            recording_options.output_resolution.clone(),
            None,
        )
    }
}

#[tracing::instrument(skip_all, name = "segment", fields(index = index))]
async fn create_segment_pipeline<TCaptureFormat: MakeCapturePipeline>(
    segments_dir: &PathBuf,
    cursors_dir: &PathBuf,
    index: u32,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    camera_feed: Option<&Mutex<CameraFeed>>,
    audio_input_feed: Option<&AudioInputFeed>,
    prev_cursors: Cursors,
    next_cursors_id: u32,
) -> Result<(RecordingPipeline, oneshot::Receiver<()>), MediaError> {
    let camera_feed = match camera_feed.as_ref() {
        Some(camera_feed) => Some(camera_feed.lock().await),
        None => None,
    };
    let camera_feed = camera_feed.as_deref();

    let dir = ensure_dir(&segments_dir.join(format!("segment-{index}")))?;

    let clock = RealTimeClock::<()>::new();
    let mut pipeline_builder = Pipeline::builder(clock);

    let display_output_path = dir.join("display.mp4");

    trace!("preparing segment pipeline {index}");

    let screen_bounds = screen_source.get_bounds();
    pipeline_builder = TCaptureFormat::make_capture_pipeline(
        pipeline_builder,
        screen_source,
        &display_output_path,
    )?;

    info!(
        r#"screen pipeline prepared, will output to "{}""#,
        display_output_path
            .strip_prefix(&segments_dir)
            .unwrap()
            .display()
    );

    let audio_output_path = if let Some(mic_source) = audio_input_feed.map(AudioInputSource::init) {
        let mic_config = mic_source.info();
        let output_path = dir.join("audio-input.mp3");

        let mic_encoder =
            MP3Encoder::init("microphone", mic_config, Output::File(output_path.clone()))?;

        pipeline_builder = pipeline_builder
            .source("microphone_capture", mic_source)
            .sink("microphone_encoder", mic_encoder);

        info!(
            "mic pipeline prepared, will output to {}",
            output_path.strip_prefix(&segments_dir).unwrap().display()
        );

        Some(output_path)
    } else {
        None
    };

    let camera = if let Some(camera_source) = camera_feed.map(CameraSource::init) {
        let camera_config = camera_source.info();
        let output_path = dir.join("camera.mp4");

        let camera_encoder =
            H264Encoder::init("camera", camera_config, Output::File(output_path.clone()))?;

        pipeline_builder = pipeline_builder
            .source("camera_capture", camera_source)
            .sink("camera_encoder", camera_encoder);

        info!(
            "camera pipeline prepared, will output to {}",
            output_path.strip_prefix(&segments_dir).unwrap().display()
        );

        Some(CameraPipelineInfo {
            output_path,
            fps: (camera_config.frame_rate.0 / camera_config.frame_rate.1) as u32,
        })
    } else {
        None
    };

    let (mut pipeline, pipeline_done_rx) = pipeline_builder.build().await?;

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

    info!("pipeline playing");

    Ok((
        RecordingPipeline {
            inner: pipeline,
            display_output_path,
            audio_output_path,
            camera,
            cursor,
        },
        pipeline_done_rx,
    ))
}

struct CameraPipelineInfo {
    output_path: PathBuf,
    fps: u32,
}

fn ensure_dir(path: &PathBuf) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(&path)?;
    Ok(path.clone())
}

type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

trait MakeCapturePipeline: std::fmt::Debug + 'static {
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
        let screen_encoder =
            H264Encoder::init("screen", screen_config, Output::File(output_path.into()))?;
        Ok(builder
            .source("screen_capture", source)
            .sink("screen_capture_encoder", screen_encoder))
    }
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
