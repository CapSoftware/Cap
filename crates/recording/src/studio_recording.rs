use crate::{
    ActorError, MediaError, RecordingBaseInputs, RecordingError,
    capture_pipeline::{MakeCapturePipeline, ScreenCaptureMethod, create_screen_capture},
    cursor::{CursorActor, Cursors, spawn_cursor_recorder},
    feeds::{
        camera::{self, CameraFeedLock},
        microphone::{self, MicrophoneFeedLock},
    },
    output_pipeline::{NewOutputPipeline, OutputPipeline},
    sources::{ScreenCaptureFormat, ScreenCaptureTarget},
};
use cap_enc_ffmpeg::{H264Encoder, MP4File, OggFile, OpusEncoder};
use cap_media_info::VideoInfo;
use cap_project::{CursorEvents, StudioRecordingMeta};
use cap_timestamp::Timestamps;
use cap_utils::spawn_actor;
use flume::Receiver;
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
    future::OptionFuture,
};
use kameo::prelude::*;
use relative_path::RelativePathBuf;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::{debug, info, trace};

#[allow(clippy::large_enum_variant)]
enum ActorState {
    Recording {
        pipeline: Pipeline,
        // pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
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

pub enum ActorControlMessage {
    Pause(oneshot::Sender<anyhow::Result<()>>),
    Resume(oneshot::Sender<anyhow::Result<()>>),
    Stop(oneshot::Sender<anyhow::Result<CompletedStudioRecording>>),
    Cancel(oneshot::Sender<anyhow::Result<()>>),
}

pub struct _Actor {
    recording_dir: PathBuf,
    fps: u32,
    segments: Vec<RecordingSegment>,
}

pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: Pipeline,
}

pub struct ScreenPipelineOutput {
    pub inner: NewOutputPipeline,
    pub video_info: VideoInfo,
}

struct Pipeline {
    pub start_time: Timestamps,
    // sources
    pub screen: ScreenPipelineOutput,
    pub microphone: Option<OutputPipeline>,
    pub camera: Option<CameraPipelineInfo>,
    pub system_audio: Option<OutputPipeline>,
    pub cursor: Option<CursorPipeline>,
}

impl Pipeline {
    pub async fn stop(&mut self) {
        self.screen.inner.stop().await;

        if let Some(mic) = self.microphone.as_mut() {
            mic.stop();
        }

        if let Some(mic) = self.microphone.as_mut() {
            mic.stop();
        }

        if let Some(system_audio) = self.system_audio.as_mut() {
            system_audio.stop();
        }

        if let Some(cursor) = self.cursor.as_mut() {
            cursor.actor.stop();
        }
    }
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: CursorActor,
}

#[derive(Clone)]
pub struct ActorHandle {
    ctrl_tx: flume::Sender<ActorControlMessage>,
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

impl ActorHandle {
    pub async fn stop(&self) -> anyhow::Result<CompletedStudioRecording> {
        send_message!(self.ctrl_tx, ActorControlMessage::Stop)
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        send_message!(self.ctrl_tx, ActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        send_message!(self.ctrl_tx, ActorControlMessage::Resume)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        send_message!(self.ctrl_tx, ActorControlMessage::Cancel)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("{0}")]
    Media(#[from] MediaError),
    #[error("{0}")]
    PipelineCreationError(#[from] CreateSegmentPipelineError),
}

impl _Actor {
    pub fn builder(output: PathBuf, capture_target: ScreenCaptureTarget) -> ActorBuilder {
        ActorBuilder::new(output, capture_target)
    }
}

pub struct ActorBuilder {
    output_path: PathBuf,
    capture_target: ScreenCaptureTarget,
    system_audio: bool,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    camera_feed: Option<Arc<CameraFeedLock>>,
    custom_cursor: bool,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            camera_feed: None,
            custom_cursor: false,
        }
    }

    pub fn with_system_audio(mut self, system_audio: bool) -> Self {
        self.system_audio = system_audio;
        self
    }

    pub fn with_mic_feed(mut self, mic_feed: Arc<MicrophoneFeedLock>) -> Self {
        self.mic_feed = Some(mic_feed);
        self
    }

    pub fn with_camera_feed(mut self, camera_feed: Arc<CameraFeedLock>) -> Self {
        self.camera_feed = Some(camera_feed);
        self
    }

    pub fn with_custom_cursor(mut self, custom_cursor: bool) -> Self {
        self.custom_cursor = custom_cursor;
        self
    }

    pub async fn build(self) -> anyhow::Result<ActorHandle> {
        spawn_studio_recording_actor(
            self.output_path,
            RecordingBaseInputs {
                capture_target: self.capture_target,
                capture_system_audio: self.system_audio,
                mic_feed: self.mic_feed,
                camera_feed: self.camera_feed,
            },
            self.custom_cursor,
        )
        .await
    }
}

async fn spawn_studio_recording_actor(
    recording_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
) -> anyhow::Result<ActorHandle> {
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = oneshot::channel();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let segments_dir = ensure_dir(&content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

    let start_time = Timestamps::now();

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
    );

    let index = 0;
    let pipeline = segment_pipeline_factory
        .create_next(Default::default(), 0)
        .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    trace!("spawning recording actor");

    let base_inputs = base_inputs.clone();
    let fps = pipeline.screen.video_info.fps();

    spawn_actor(async move {
        let mut actor = _Actor {
            recording_dir,
            fps,
            segments: Vec::new(),
        };

        let mut state = ActorState::Recording {
            pipeline,
            /*pipeline_done_rx,*/
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

    Ok(ActorHandle {
        ctrl_tx,
        capture_target: base_inputs.capture_target,
    })
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
    state: ActorState,
    ctrl_rx: &Receiver<ActorControlMessage>,
    mut actor: _Actor,
    segment_pipeline_factory: &mut SegmentPipelineFactory,
) -> Result<Option<(ActorState, _Actor)>, StudioRecordingActorError> {
    use ActorControlMessage as Msg;
    use ActorState as State;

    // Helper function to shutdown pipeline and save cursor data
    async fn shutdown(
        mut pipeline: Pipeline,
        actor: &mut _Actor,
        segment_start_time: f64,
    ) -> Result<(Cursors, u32), RecordingError> {
        tracing::info!("pipeline shuting down");

        pipeline.stop();

        tracing::info!("pipeline shutdown");

        let segment_stop_time = current_time_f64();

        let cursors = if let Some(cursor) = &mut pipeline.cursor
            && let Ok(res) = cursor.actor.rx.clone().await
        {
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
        };

        actor.segments.push(RecordingSegment {
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
            // mut pipeline_done_rx,
            mut pipeline,
            index,
            segment_start_time,
            segment_start_instant,
        } => {
            tokio::select! {
                // result = &mut pipeline_done_rx => {
                //     match result {
                //         Ok(Ok(())) => Ok(None),
                //         Ok(Err(e)) => Err(StudioRecordingActorError::Other(e)),
                //         Err(_) => Err(StudioRecordingActorError::PipelineReceiverDropped),
                //     }
                // },
                msg = ctrl_rx.recv_async() => {
                    match msg {
                        Ok(msg) => (
                            msg,
                            State::Recording {
                                pipeline,
                                // pipeline_done_rx,
                                index,
                                segment_start_time,
                                segment_start_instant,
                            },
                        ),
                        Err(_) => {
                            if let Some(cursor) = &mut pipeline.cursor {
                                cursor.actor.stop();
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

            send_response!(tx, res.map_err(Into::into));

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

            send_response!(tx, result.map_err(Into::into));
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
                Ok(pipeline) => {
                    send_response!(tx, Ok(()));
                    Some((
                        State::Recording {
                            pipeline,
                            // pipeline_done_rx,
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
            match state {
                State::Recording { mut pipeline, .. } => {
                    pipeline.stop();
                }
                State::Paused { .. } => {}
            }

            send_response!(tx, Ok(()));
            None
        }

        (_, state) => Some((state, actor)),
    })
}

pub struct CompletedStudioRecording {
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
    pub cursor_data: cap_project::CursorImages,
    // pub segments: Vec<RecordingSegment>,
}

async fn stop_recording(
    actor: _Actor,
    cursors: Cursors,
) -> Result<CompletedStudioRecording, RecordingError> {
    use cap_project::*;

    let make_relative = |path: &PathBuf| {
        RelativePathBuf::from_path(path.strip_prefix(&actor.recording_dir).unwrap()).unwrap()
    };

    let meta = StudioRecordingMeta::MultipleSegments {
        inner: MultipleSegments {
            segments: futures::stream::iter(actor.segments)
                .then(async |mut s| {
                    macro_rules! recv_timestamp {
                        ($pipeline:expr) => {
                            $pipeline
                                .first_timestamp_rx
                                .next()
                                .map(|v| {
                                    v.map(|v| v.duration_since(s.pipeline.start_time).as_secs_f64())
                                })
                                .await
                        };
                    }

                    macro_rules! recv_timestamp2 {
                        ($pipeline:expr) => {
                            $pipeline
                                .first_timestamp_rx
                                .map(|v| {
                                    v.map(|v| v.duration_since(s.pipeline.start_time).as_secs_f64())
                                        .ok()
                                })
                                .await
                        };
                    }

                    MultipleSegment {
                        display: VideoMeta {
                            path: make_relative(&s.pipeline.screen.inner.path()),
                            fps: actor.fps,
                            start_time: recv_timestamp2!(s.pipeline.screen.inner),
                        },
                        camera: OptionFuture::from(s.pipeline.camera.map(async |mut camera| {
                            VideoMeta {
                                path: make_relative(&camera.inner.path),
                                fps: camera.fps,
                                start_time: recv_timestamp!(camera.inner),
                            }
                        }))
                        .await,
                        mic: OptionFuture::from(s.pipeline.microphone.map(async |mut mic| {
                            AudioMeta {
                                path: make_relative(&mic.path),
                                start_time: recv_timestamp!(mic),
                            }
                        }))
                        .await,
                        system_audio: OptionFuture::from(s.pipeline.system_audio.map(
                            async |mut audio| AudioMeta {
                                path: make_relative(&audio.path),
                                start_time: recv_timestamp!(audio),
                            },
                        ))
                        .await,
                        cursor: s
                            .pipeline
                            .cursor
                            .as_ref()
                            .map(|cursor| make_relative(&cursor.output_path)),
                    }
                })
                .collect::<Vec<_>>()
                .await,

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
        project_path: actor.recording_dir.clone(),
        meta,
        cursor_data: Default::default(),
        // display_source: actor.options.capture_target,
        // segments: actor.segments,
    })
}

struct SegmentPipelineFactory {
    segments_dir: PathBuf,
    cursors_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
    start_time: Timestamps,
    index: u32,
}

impl SegmentPipelineFactory {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        segments_dir: PathBuf,
        cursors_dir: PathBuf,
        base_inputs: RecordingBaseInputs,
        custom_cursor_capture: bool,
        start_time: Timestamps,
    ) -> Self {
        Self {
            segments_dir,
            cursors_dir,
            base_inputs,
            custom_cursor_capture,
            start_time,
            index: 0,
        }
    }

    pub async fn create_next(
        &mut self,
        cursors: Cursors,
        next_cursors_id: u32,
    ) -> anyhow::Result<Pipeline> {
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
    start_time: Timestamps,
) -> anyhow::Result<Pipeline> {
    let system_audio = if capture_system_audio {
        let (tx, rx) = mpsc::channel(64);
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

    let screen_source = create_screen_capture(
        &capture_target,
        !custom_cursor_capture,
        120,
        start_time.system_time(),
        capture_system_audio,
        #[cfg(windows)]
        d3d_device,
    )
    .await
    .unwrap();

    let dir = ensure_dir(&segments_dir.join(format!("segment-{index}")))?;

    let screen_output_path = dir.join("display.mp4");

    trace!("preparing segment pipeline {index}");

    let screen = {
        let video_info = screen_source.info();

        let output = ScreenCaptureMethod::make_studio_mode_pipeline(
            screen_source,
            screen_output_path.clone(),
            start_time,
        )
        .await
        .unwrap();

        info!(
            r#"screen pipeline prepared, will output to "{}""#,
            screen_output_path
                .strip_prefix(segments_dir)
                .unwrap()
                .display()
        );

        ScreenPipelineOutput {
            inner: output,
            video_info,
        }
    };

    let microphone = if let Some(mic_feed) = mic_feed {
        let (tx, channel) = flume::bounded(8);
        let _ = mic_feed.ask(microphone::AddSender(tx)).await;

        let audio_info = *mic_feed.audio_info();
        let output_path = dir.join("audio-input.ogg");

        let mut encoder = OggFile::init(
            output_path.clone(),
            OpusEncoder::factory("microphone", audio_info),
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        let (output, output_internal) = OutputPipeline::new(output_path.clone());

        tokio::spawn({
            let mut output_stop_rx = output_internal.to_stop_rx();
            let mut output_frame_handler = output_internal.to_frame_handler();

            async move {
                while let Some(Ok(samples)) = output_stop_rx.race(channel.recv_async()).await {
                    output_frame_handler.handle_frame(samples.timestamp);

                    encoder.queue_frame(
                        audio_info.wrap_frame(&samples.data),
                        samples.timestamp.duration_since(start_time),
                    );
                }

                encoder.finish();
            }
        });

        info!(
            "mic pipeline prepared, will output to {}",
            output_path.strip_prefix(segments_dir).unwrap().display()
        );

        Some(output)
    } else {
        None
    };

    let system_audio = if let Some((config, mut channel)) =
        Some(ScreenCaptureMethod::audio_info()).zip(system_audio.1)
    {
        let output_path = dir.join("system_audio.ogg");

        let mut output = OggFile::init(
            output_path.clone(),
            OpusEncoder::factory("system_audio", config),
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        let (pipeline_output, output_internal) = OutputPipeline::new(output_path);

        tokio::spawn({
            let mut output_stop_rx = output_internal.to_stop_rx();
            let mut output_frame_handler = output_internal.to_frame_handler();

            async move {
                while let Some(Some(frame)) = output_stop_rx.race(channel.next()).await {
                    let timestamp = frame.timestamp;
                    output_frame_handler.handle_frame(timestamp);

                    output.queue_frame(frame.inner, timestamp.duration_since(start_time));
                }

                output.finish();
            }
        });

        Some(pipeline_output)
    } else {
        None
    };

    let camera = if let Some(camera_feed) = camera_feed {
        let (tx, channel) = flume::bounded(8);
        let _ = camera_feed.ask(camera::AddSender(tx)).await;

        let camera_config = *camera_feed.video_info();
        let time_base = camera_config.time_base;
        let output_path = dir.join("camera.mp4");

        let mut camera_encoder = MP4File::init(
            "camera",
            output_path.clone(),
            |o| H264Encoder::builder("camera", camera_config).build(o),
            |_| None,
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        let (output, output_internal) = OutputPipeline::new(output_path.clone());

        tokio::spawn({
            let mut output_stop_rx = output_internal.to_stop_rx();
            let mut output_frame_handler = output_internal.to_frame_handler();

            async move {
                while let Some(Ok(raw)) = output_stop_rx.race(channel.recv_async()).await {
                    output_frame_handler.handle_frame(raw.timestamp);

                    camera_encoder
                        .queue_video_frame(raw.frame, raw.timestamp.duration_since(start_time));
                }

                camera_encoder.finish();
            }
        });

        info!(
            "camera pipeline prepared, will output to {}",
            output_path.strip_prefix(segments_dir).unwrap().display()
        );

        Some(CameraPipelineInfo {
            inner: output,
            fps: (camera_config.frame_rate.0 / camera_config.frame_rate.1) as u32,
        })
    } else {
        None
    };

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
            actor: cursor,
        }
    });

    info!("pipeline playing");

    Ok(Pipeline {
        start_time,
        screen,
        microphone,
        camera,
        cursor,
        system_audio,
    })
}

struct CameraPipelineInfo {
    inner: OutputPipeline,
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
