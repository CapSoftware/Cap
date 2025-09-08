use crate::{
    ActorError, MediaError, RecordingBaseInputs, RecordingError,
    capture_pipeline::{
        MakeCapturePipeline, ScreenCaptureMethod, SourceTimestamp, SourceTimestamps,
        create_screen_capture,
    },
    cursor::{CursorActor, Cursors, spawn_cursor_recorder},
    feeds::{camera::CameraFeedLock, microphone::MicrophoneFeedLock},
    pipeline::Pipeline,
    sources::{AudioInputSource, CameraSource, ScreenCaptureFormat, ScreenCaptureTarget},
};
use cap_enc_ffmpeg::{H264Encoder, MP4File, OggFile, OpusEncoder};
use cap_media_info::VideoInfo;
use cap_project::{CursorEvents, StudioRecordingMeta};
use cap_utils::spawn_actor;
use flume::Receiver;
use relative_path::RelativePathBuf;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use tracing::{debug, info, trace};

#[allow(clippy::large_enum_variant)]
enum StudioRecordingActorState {
    Recording {
        pipeline: StudioRecordingPipeline,
        pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        index: u32,
        segment_start_time: f64,
        segment_start_instant: Instant,
    },
    Paused {
        next_index: u32,
        cursors: Cursors,
        next_cursor_id: u32,
    },
}

pub enum StudioRecordingActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), CreateSegmentPipelineError>>),
    Stop(oneshot::Sender<Result<CompletedStudioRecording, RecordingError>>),
    Cancel(oneshot::Sender<Result<(), RecordingError>>),
}

pub struct StudioRecordingActor {
    id: String,
    recording_dir: PathBuf,
    fps: u32,
    segments: Vec<StudioRecordingSegment>,
    #[allow(unused)]
    start_instant: Instant,
}

pub struct StudioRecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: StudioRecordingPipeline,
}

pub struct PipelineOutput {
    pub path: PathBuf,
    pub first_timestamp_rx: flume::Receiver<SourceTimestamp>,
}

pub struct ScreenPipelineOutput {
    pub inner: PipelineOutput,
    pub video_info: VideoInfo,
}

struct StudioRecordingPipeline {
    pub start_time: SourceTimestamps,
    pub inner: Pipeline,
    pub screen: ScreenPipelineOutput,
    pub microphone: Option<PipelineOutput>,
    pub camera: Option<CameraPipelineInfo>,
    pub cursor: Option<CursorPipeline>,
    pub system_audio: Option<PipelineOutput>,
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: Option<CursorActor>,
}

#[derive(Clone)]
pub struct StudioRecordingHandle {
    ctrl_tx: flume::Sender<StudioRecordingActorControlMessage>,
    pub capture_target: ScreenCaptureTarget,
}

macro_rules! send_message {
    ($ctrl_tx:expr, $variant:path) => {{
        let (tx, rx) = oneshot::channel();
        $ctrl_tx
            .send($variant(tx))
            .map_err(|_| flume::SendError(()))
            .map_err(ActorError::from)?;
        rx.await.map_err(|_| ActorError::ActorStopped)?
    }};
}

impl StudioRecordingHandle {
    pub async fn stop(&self) -> Result<CompletedStudioRecording, RecordingError> {
        send_message!(self.ctrl_tx, StudioRecordingActorControlMessage::Stop)
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, StudioRecordingActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> Result<(), CreateSegmentPipelineError> {
        send_message!(self.ctrl_tx, StudioRecordingActorControlMessage::Resume)
    }

    pub async fn cancel(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, StudioRecordingActorControlMessage::Cancel)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnStudioRecordingError {
    #[error("{0}")]
    Media(#[from] MediaError),
    #[error("{0}")]
    PipelineCreationError(#[from] CreateSegmentPipelineError),
}

pub async fn spawn_studio_recording_actor(
    id: String,
    recording_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
) -> Result<(StudioRecordingHandle, oneshot::Receiver<Result<(), String>>), SpawnStudioRecordingError>
{
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = oneshot::channel();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let segments_dir = ensure_dir(&content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

    // TODO: move everything to start_instant
    let start_time = SystemTime::now();
    let start_instant = Instant::now();

    if let Some(camera_feed) = &base_inputs.camera_feed {
        debug!("camera device info: {:#?}", camera_feed.camera_info());
        debug!("camera video info: {:#?}", camera_feed.video_info());
    }

    if let Some(mic_feed) = &base_inputs.mic_feed {
        debug!("mic audio info: {:#?}", mic_feed.audio_info());
    };

    let mut segment_pipeline_factory = SegmentPipelineFactory::new(
        segments_dir,
        cursors_dir,
        base_inputs.clone(),
        custom_cursor_capture,
        start_time,
        start_instant,
    );

    let index = 0;
    let (pipeline, pipeline_done_rx) = segment_pipeline_factory
        .create_next(Default::default(), 0)
        .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    trace!("spawning recording actor");

    let base_inputs = base_inputs.clone();
    let fps = pipeline.screen.video_info.fps();

    spawn_actor(async move {
        let mut actor = StudioRecordingActor {
            id,
            recording_dir,
            fps,
            segments: Vec::new(),
            start_instant,
        };

        let mut state = StudioRecordingActorState::Recording {
            pipeline,
            pipeline_done_rx,
            index,
            segment_start_time,
            segment_start_instant: Instant::now(),
        };

        let result = loop {
            match run_actor_iteration(state, &ctrl_rx, actor, &mut segment_pipeline_factory).await {
                Ok(None) => break Ok(()),
                Ok(Some((new_state, new_actor))) => {
                    state = new_state;
                    actor = new_actor;
                }
                Err(err) => break Err(err),
            }
        };

        info!("recording actor finished: {:?}", &result);

        let _ = done_tx.send(result.map_err(|v| v.to_string()));
    });

    Ok((
        StudioRecordingHandle {
            ctrl_tx,
            capture_target: base_inputs.capture_target,
        },
        done_rx,
    ))
}

#[derive(thiserror::Error, Debug)]
enum StudioRecordingActorError {
    #[error("Pipeline receiver dropped")]
    PipelineReceiverDropped,
    #[error("Control receiver dropped")]
    ControlReceiverDropped,
    #[error("{0}")]
    Other(String),
}

// Helper macro for sending responses
macro_rules! send_response {
    ($tx:expr, $res:expr) => {
        let _ = $tx.send($res);
    };
}

async fn run_actor_iteration(
    state: StudioRecordingActorState,
    ctrl_rx: &Receiver<StudioRecordingActorControlMessage>,
    mut actor: StudioRecordingActor,
    segment_pipeline_factory: &mut SegmentPipelineFactory,
) -> Result<Option<(StudioRecordingActorState, StudioRecordingActor)>, StudioRecordingActorError> {
    use StudioRecordingActorControlMessage as Msg;
    use StudioRecordingActorState as State;

    // Helper function to shutdown pipeline and save cursor data
    async fn shutdown(
        mut pipeline: StudioRecordingPipeline,
        actor: &mut StudioRecordingActor,
        segment_start_time: f64,
    ) -> Result<(Cursors, u32), RecordingError> {
        tracing::info!("pipeline shuting down");

        pipeline.inner.shutdown().await?;

        tracing::info!("pipeline shutdown");

        let segment_stop_time = current_time_f64();

        let cursors = if let Some(cursor) = &mut pipeline.cursor {
            if let Some(actor) = cursor.actor.take() {
                let res = actor.stop().await;

                std::fs::write(
                    &cursor.output_path,
                    serde_json::to_string_pretty(&CursorEvents {
                        clicks: res.clicks,
                        moves: res.moves,
                    })?,
                )?;

                (res.cursors, res.next_cursor_id)
            } else {
                (Default::default(), 0)
            }
        } else {
            (Default::default(), 0)
        };

        actor.segments.push(StudioRecordingSegment {
            start: segment_start_time,
            end: segment_stop_time,
            pipeline,
        });

        Ok(cursors)
    }

    // Log current state
    info!(
        "recording actor state: {:?}",
        match &state {
            State::Recording { .. } => "recording",
            State::Paused { .. } => "paused",
        }
    );

    // Receive event based on current state
    let event = match state {
        State::Recording {
            mut pipeline_done_rx,
            mut pipeline,
            index,
            segment_start_time,
            segment_start_instant,
        } => {
            tokio::select! {
                result = &mut pipeline_done_rx => {
                    let res = match result {
                        Ok(Ok(())) => Ok(None),
                        Ok(Err(e)) => Err(StudioRecordingActorError::Other(e)),
                        Err(_) => Err(StudioRecordingActorError::PipelineReceiverDropped),
                    };

                    if let Some(cursor) = &mut pipeline.cursor
                        && let Some(actor) = cursor.actor.take() {
                        actor.stop().await;
                    }

                    return res;
                },
                msg = ctrl_rx.recv_async() => {
                    match msg {
                        Ok(msg) => (
                            msg,
                            State::Recording {
                                pipeline,
                                pipeline_done_rx,
                                index,
                                segment_start_time,
                                segment_start_instant,
                            },
                        ),
                        Err(_) => {
                            if let Some(cursor) = &mut pipeline.cursor
                                && let Some(actor) = cursor.actor.take() {
                                actor.stop().await;
                            }

                            return Err(StudioRecordingActorError::ControlReceiverDropped)
                        },
                    }
                }
            }
        }
        paused_state @ State::Paused { .. } => match ctrl_rx.recv_async().await {
            Ok(msg) => (msg, paused_state),
            Err(_) => return Err(StudioRecordingActorError::ControlReceiverDropped),
        },
    };

    let (event, state) = event;

    // Handle state transitions based on event and current state
    Ok(match (event, state) {
        // Pause from Recording
        (
            Msg::Pause(tx),
            State::Recording {
                pipeline,
                index,
                segment_start_time,
                ..
            },
        ) => {
            let (res, cursors, next_cursor_id) =
                match shutdown(pipeline, &mut actor, segment_start_time).await {
                    Ok((cursors, next_cursor_id)) => (Ok(()), cursors, next_cursor_id),
                    Err(e) => (Err(e), HashMap::new(), 0),
                };

            send_response!(tx, res);

            Some((
                State::Paused {
                    next_index: index + 1,
                    cursors,
                    next_cursor_id,
                },
                actor,
            ))
        }

        // Stop from any state
        (Msg::Stop(tx), state) => {
            let result = match state {
                State::Recording {
                    pipeline,
                    segment_start_time,
                    segment_start_instant,
                    ..
                } => {
                    // Wait for minimum segment duration
                    tokio::time::sleep_until(
                        (segment_start_instant + Duration::from_secs(1)).into(),
                    )
                    .await;

                    match shutdown(pipeline, &mut actor, segment_start_time).await {
                        Ok((cursors, _)) => stop_recording(actor, cursors).await,
                        Err(e) => Err(e),
                    }
                }
                State::Paused { cursors, .. } => stop_recording(actor, cursors).await,
            };

            println!("recording successfully stopped");

            send_response!(tx, result);
            None
        }

        // Resume from Paused
        (
            Msg::Resume(tx),
            State::Paused {
                next_index,
                cursors,
                next_cursor_id,
            },
        ) => {
            match segment_pipeline_factory
                .create_next(cursors, next_cursor_id)
                .await
            {
                Ok((pipeline, pipeline_done_rx)) => {
                    send_response!(tx, Ok(()));
                    Some((
                        State::Recording {
                            pipeline,
                            pipeline_done_rx,
                            index: next_index,
                            segment_start_time: current_time_f64(),
                            segment_start_instant: Instant::now(),
                        },
                        actor,
                    ))
                }
                Err(e) => {
                    send_response!(tx, Err(e));
                    None
                }
            }
        }

        // Cancel from any state
        (Msg::Cancel(tx), state) => {
            let result = match state {
                State::Recording { mut pipeline, .. } => {
                    if let Some(cursor) = &mut pipeline.cursor
                        && let Some(actor) = cursor.actor.take()
                    {
                        actor.stop().await;
                    }

                    pipeline.inner.shutdown().await
                }
                State::Paused { .. } => Ok(()),
            };

            send_response!(tx, result.map_err(Into::into));
            None
        }

        (_, state) => Some((state, actor)),
    })
}

pub struct CompletedStudioRecording {
    pub id: String,
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
    pub cursor_data: cap_project::CursorImages,
    pub segments: Vec<StudioRecordingSegment>,
}

async fn stop_recording(
    actor: StudioRecordingActor,
    cursors: Cursors,
) -> Result<CompletedStudioRecording, RecordingError> {
    use cap_project::*;

    let make_relative = |path: &PathBuf| {
        RelativePathBuf::from_path(path.strip_prefix(&actor.recording_dir).unwrap()).unwrap()
    };

    let meta = StudioRecordingMeta::MultipleSegments {
        inner: MultipleSegments {
            segments: {
                actor
                    .segments
                    .iter()
                    .map(|s| {
                        let recv_timestamp = |pipeline: &PipelineOutput| {
                            pipeline
                                .first_timestamp_rx
                                .try_recv()
                                .ok()
                                .map(|v| v.duration_since(s.pipeline.start_time).as_secs_f64())
                        };

                        MultipleSegment {
                            display: VideoMeta {
                                path: make_relative(&s.pipeline.screen.inner.path),
                                fps: actor.fps,
                                start_time: recv_timestamp(&s.pipeline.screen.inner),
                            },
                            camera: s.pipeline.camera.as_ref().map(|camera| VideoMeta {
                                path: make_relative(&camera.inner.path),
                                fps: camera.fps,
                                start_time: recv_timestamp(&camera.inner),
                            }),
                            mic: s.pipeline.microphone.as_ref().map(|mic| AudioMeta {
                                path: make_relative(&mic.path),
                                start_time: recv_timestamp(mic),
                            }),
                            cursor: s
                                .pipeline
                                .cursor
                                .as_ref()
                                .map(|cursor| make_relative(&cursor.output_path)),
                            system_audio: s.pipeline.system_audio.as_ref().map(|audio| AudioMeta {
                                path: make_relative(&audio.path),
                                start_time: recv_timestamp(audio),
                            }),
                        }
                    })
                    .collect()
            },
            cursors: cap_project::Cursors::Correct(
                cursors
                    .into_values()
                    .map(|cursor| {
                        (
                            cursor.id.to_string(),
                            CursorMeta {
                                image_path: RelativePathBuf::from("content/cursors")
                                    .join(&cursor.file_name),
                                hotspot: cursor.hotspot,
                                shape: cursor.shape,
                            },
                        )
                    })
                    .collect(),
            ),
        },
    };

    let project_config = cap_project::ProjectConfiguration::default();
    project_config
        .write(&actor.recording_dir)
        .map_err(RecordingError::from)?;

    Ok(CompletedStudioRecording {
        id: actor.id,
        project_path: actor.recording_dir.clone(),
        meta,
        cursor_data: Default::default(),
        // display_source: actor.options.capture_target,
        segments: actor.segments,
    })
}

struct SegmentPipelineFactory {
    segments_dir: PathBuf,
    cursors_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
    start_time: SystemTime,
    start_instant: Instant,
    index: u32,
}

impl SegmentPipelineFactory {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        segments_dir: PathBuf,
        cursors_dir: PathBuf,
        base_inputs: RecordingBaseInputs,
        custom_cursor_capture: bool,
        start_time: SystemTime,
        start_instant: Instant,
    ) -> Self {
        Self {
            segments_dir,
            cursors_dir,
            base_inputs,
            custom_cursor_capture,
            start_time,
            start_instant,
            index: 0,
        }
    }

    pub async fn create_next(
        &mut self,
        cursors: Cursors,
        next_cursors_id: u32,
    ) -> Result<
        (
            StudioRecordingPipeline,
            oneshot::Receiver<Result<(), String>>,
        ),
        CreateSegmentPipelineError,
    > {
        let result = create_segment_pipeline(
            &self.segments_dir,
            &self.cursors_dir,
            self.index,
            self.base_inputs.capture_target.clone(),
            self.base_inputs.mic_feed.clone(),
            self.base_inputs.capture_system_audio,
            self.base_inputs.camera_feed.clone(),
            cursors,
            next_cursors_id,
            self.custom_cursor_capture,
            self.start_time,
            self.start_instant,
        )
        .await?;

        self.index += 1;

        Ok(result)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreateSegmentPipelineError {
    #[error("NoDisplay")]
    NoDisplay,
    #[error("NoBounds")]
    NoBounds,
    #[error("PipelineBuild/{0}")]
    PipelineBuild(MediaError),
    #[error("PipelinePlay/{0}")]
    PipelinePlay(MediaError),
    #[error("Actor/{0}")]
    Actor(#[from] ActorError),
    #[error("{0}")]
    Recording(#[from] RecordingError),
    #[error("{0}")]
    Media(#[from] MediaError),
}

#[tracing::instrument(skip_all, name = "segment", fields(index = index))]
#[allow(clippy::too_many_arguments)]
async fn create_segment_pipeline(
    segments_dir: &PathBuf,
    cursors_dir: &Path,
    index: u32,
    capture_target: ScreenCaptureTarget,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    capture_system_audio: bool,
    camera_feed: Option<Arc<CameraFeedLock>>,
    prev_cursors: Cursors,
    next_cursors_id: u32,
    custom_cursor_capture: bool,
    start_time: SystemTime,
    start_instant: Instant,
) -> Result<
    (
        StudioRecordingPipeline,
        oneshot::Receiver<Result<(), String>>,
    ),
    CreateSegmentPipelineError,
> {
    let start_time = SourceTimestamps::now();

    let system_audio = if capture_system_audio {
        let (tx, rx) = flume::bounded(64);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let display = capture_target
        .display()
        .ok_or(CreateSegmentPipelineError::NoDisplay)?;
    let crop_bounds = capture_target
        .cursor_crop()
        .ok_or(CreateSegmentPipelineError::NoBounds)?;

    #[cfg(windows)]
    let d3d_device = crate::capture_pipeline::create_d3d_device().unwrap();

    let (screen_source, screen_rx) = create_screen_capture(
        &capture_target,
        !custom_cursor_capture,
        120,
        system_audio.0,
        #[cfg(windows)]
        d3d_device,
    )
    .await
    .unwrap();

    let dir = ensure_dir(&segments_dir.join(format!("segment-{index}")))?;

    let mut pipeline_builder = Pipeline::builder();

    let screen_output_path = dir.join("display.mp4");

    trace!("preparing segment pipeline {index}");

    let screen = {
        let video_info = screen_source.info();

        let (pipeline_builder_, screen_timestamp_rx) =
            ScreenCaptureMethod::make_studio_mode_pipeline(
                pipeline_builder,
                (screen_source, screen_rx),
                screen_output_path.clone(),
            )
            .unwrap();
        pipeline_builder = pipeline_builder_;

        info!(
            r#"screen pipeline prepared, will output to "{}""#,
            screen_output_path
                .strip_prefix(segments_dir)
                .unwrap()
                .display()
        );

        ScreenPipelineOutput {
            inner: PipelineOutput {
                path: screen_output_path,
                first_timestamp_rx: screen_timestamp_rx,
            },
            video_info,
        }
    };

    let microphone = if let Some(mic_feed) = mic_feed {
        let (tx, rx) = flume::bounded(8);

        let mic_source = AudioInputSource::init(mic_feed, tx);

        let mic_config = mic_source.info();
        let output_path = dir.join("audio-input.ogg");

        let mut mic_encoder = OggFile::init(
            output_path.clone(),
            OpusEncoder::factory("microphone", mic_config),
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        pipeline_builder.spawn_source("microphone_capture", mic_source);

        let (timestamp_tx, first_timestamp_rx) = flume::bounded(1);

        pipeline_builder.spawn_task("microphone_encoder", move |ready| {
            let mut timestamp_tx = Some(timestamp_tx);
            let _ = ready.send(Ok(()));

            while let Ok(frame) = rx.recv() {
                if let Some(timestamp_tx) = timestamp_tx.take() {
                    timestamp_tx.send(frame.1).unwrap();
                }

                mic_encoder.queue_frame(frame.0);
            }
            mic_encoder.finish();
            Ok(())
        });

        info!(
            "mic pipeline prepared, will output to {}",
            output_path.strip_prefix(segments_dir).unwrap().display()
        );

        Some(PipelineOutput {
            path: output_path,
            first_timestamp_rx,
        })
    } else {
        None
    };

    let system_audio = if let Some((config, channel)) =
        Some(ScreenCaptureMethod::audio_info()).zip(system_audio.1.clone())
    {
        let output_path = dir.join("system_audio.ogg");

        let mut system_audio_encoder = OggFile::init(
            output_path.clone(),
            OpusEncoder::factory("system_audio", config),
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        let (timestamp_tx, timestamp_rx) = flume::bounded(1);

        pipeline_builder.spawn_task("system_audio_encoder", move |ready| {
            let mut timestamp_tx = Some(timestamp_tx);
            let _ = ready.send(Ok(()));

            while let Ok(frame) = channel.recv() {
                if let Some(timestamp_tx) = timestamp_tx.take() {
                    timestamp_tx.send(frame.1).unwrap();
                }

                system_audio_encoder.queue_frame(frame.0);
            }
            system_audio_encoder.finish();
            Ok(())
        });

        Some(PipelineOutput {
            path: output_path,
            first_timestamp_rx: timestamp_rx,
        })
    } else {
        None
    };

    let camera = if let Some(camera_feed) = camera_feed {
        let (tx, rx) = flume::bounded(8);

        let camera_source = CameraSource::init(camera_feed, tx, start_instant);
        let camera_config = camera_source.info();
        let output_path = dir.join("camera.mp4");

        let mut camera_encoder = MP4File::init(
            "camera",
            output_path.clone(),
            |o| H264Encoder::builder("camera", camera_config).build(o),
            |_| None,
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        pipeline_builder.spawn_source("camera_capture", camera_source);

        let (timestamp_tx, timestamp_rx) = flume::bounded(1);

        pipeline_builder.spawn_task("camera_encoder", move |ready| {
            let mut timestamp_tx = Some(timestamp_tx);
            let _ = ready.send(Ok(()));

            let mut start = None;
            while let Ok(mut frame) = rx.recv() {
                if let Some(timestamp_tx) = timestamp_tx.take() {
                    timestamp_tx.send(frame.1).unwrap();
                }

                if let Some(start) = start {
                    // frame.0.set_pts(Some(
                    //     ((camera_config.time_base.denominator() as f64
                    //         / camera_config.time_base.numerator() as f64)
                    //         * (frame.1 - start)) as i64,
                    // ));
                } else {
                    start = Some(frame.1);
                    frame.0.set_pts(Some(0));
                }

                camera_encoder.queue_video_frame(frame.0);
            }
            camera_encoder.finish();
            Ok(())
        });

        info!(
            "camera pipeline prepared, will output to {}",
            output_path.strip_prefix(segments_dir).unwrap().display()
        );

        Some(CameraPipelineInfo {
            inner: PipelineOutput {
                path: output_path,
                first_timestamp_rx: timestamp_rx,
            },
            fps: (camera_config.frame_rate.0 / camera_config.frame_rate.1) as u32,
        })
    } else {
        None
    };

    let (mut pipeline, pipeline_done_rx) = pipeline_builder
        .build()
        .await
        .map_err(CreateSegmentPipelineError::PipelineBuild)?;

    pipeline
        .play()
        .await
        .map_err(CreateSegmentPipelineError::PipelinePlay)?;

    let cursor = custom_cursor_capture.then(move || {
        let cursor = spawn_cursor_recorder(
            crop_bounds,
            display,
            cursors_dir.to_path_buf(),
            prev_cursors,
            next_cursors_id,
            start_time,
        );

        CursorPipeline {
            output_path: dir.join("cursor.json"),
            actor: Some(cursor),
        }
    });

    info!("pipeline playing");

    Ok((
        StudioRecordingPipeline {
            inner: pipeline,
            start_time,
            screen,
            microphone,
            camera,
            cursor,
            system_audio,
        },
        pipeline_done_rx,
    ))
}

struct CameraPipelineInfo {
    inner: PipelineOutput,
    fps: u32,
}

fn ensure_dir(path: &PathBuf) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(path)?;
    Ok(path.clone())
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
