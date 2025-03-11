use std::{
    fs::File,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use cap_flags::FLAGS;
use cap_media::{
    data::{FFAudio, FFPacket},
    encoders::{H264Encoder, MP4File, OggFile, OpusEncoder},
    feeds::{AudioInputFeed, CameraFeed},
    pipeline::{
        builder::PipelineBuilder, task::PipelineSourceTask, CloneInto, Pipeline, RealTimeClock,
    },
    platform::Bounds,
    sources::{
        system_audio::{self, SystemAudioSource},
        AudioInputSource, CameraSource, ScreenCaptureSource, ScreenCaptureTarget,
    },
    MediaError,
};
use cap_project::{CursorEvents, StudioRecordingMeta};
use cap_utils::spawn_actor;
use relative_path::RelativePathBuf;
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, error, info, instrument::WithSubscriber, trace, Instrument};
use tracing_subscriber::{layer::SubscriberExt, Layer};

use crate::{
    capture_pipeline::{create_screen_capture, MakeCapturePipeline},
    cursor::{spawn_cursor_recorder, CursorActor, Cursors},
    ActorError, RecordingError, RecordingOptions,
};

enum StudioRecordingActorState {
    Recording {
        pipeline: StudioRecordingPipeline,
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

pub enum StudioRecordingActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<CompletedStudioRecording, RecordingError>>),
}

pub struct StudioRecordingActor {
    id: String,
    recording_dir: PathBuf,
    fps: u32,
    options: RecordingOptions,
    segments: Vec<StudioRecordingSegment>,
}

pub struct StudioRecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: StudioRecordingPipeline,
}

struct StudioRecordingPipeline {
    pub inner: Pipeline<RealTimeClock<()>>,
    pub display_output_path: PathBuf,
    pub audio_output_path: Option<PathBuf>,
    pub camera: Option<CameraPipelineInfo>,
    pub cursor: Option<CursorPipeline>,
    pub system_audio_path: Option<PathBuf>,
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: Option<CursorActor>,
}

#[derive(Clone)]
pub struct StudioRecordingHandle {
    ctrl_tx: flume::Sender<StudioRecordingActorControlMessage>,
    pub options: RecordingOptions,
    pub bounds: Bounds,
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

    pub async fn resume(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, StudioRecordingActorControlMessage::Resume)
    }
}

pub async fn spawn_studio_recording_actor(
    id: String,
    recording_dir: PathBuf,
    options: RecordingOptions,
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    audio_input_feed: Option<AudioInputFeed>,
) -> Result<(StudioRecordingHandle, tokio::sync::oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let segments_dir = ensure_dir(&content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

    let screen_source = create_screen_capture(&options.capture_target, false, false, 120)?;
    let bounds = screen_source.get_bounds().clone();

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
        options.capture_system_audio,
        Default::default(),
        index,
    )
    .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    trace!("spawning recording actor");

    spawn_actor({
        let options = options.clone();
        let fps = screen_source.info().fps();
        async move {
            let mut actor = StudioRecordingActor {
                id,
                recording_dir,
                options: options.clone(),
                fps,
                segments: vec![],
            };

            let mut state = StudioRecordingActorState::Recording {
                pipeline,
                pipeline_done_rx,
                index,
                segment_start_time,
            };

            'outer: loop {
                state = match state {
                    StudioRecordingActorState::Recording {
                        mut pipeline,
                        mut pipeline_done_rx,
                        index,
                        segment_start_time,
                    } => {
                        info!("recording actor recording");
                        loop {
                            let msg = tokio::select! {
                                _ = &mut pipeline_done_rx => {
                                    if let Some(cursor) = &mut pipeline.cursor {
                                        if let Some(actor) = cursor.actor.take() {
                                            actor.stop().await;
                                        }
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
                                mut pipeline: StudioRecordingPipeline,
                                actor: &mut StudioRecordingActor,
                                segment_start_time: f64,
                            ) -> Result<(Cursors, u32), RecordingError>
                            {
                                pipeline.inner.shutdown().await?;

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
                                        Default::default()
                                    }
                                } else {
                                    Default::default()
                                };

                                actor.segments.push(StudioRecordingSegment {
                                    start: segment_start_time,
                                    end: segment_stop_time,
                                    pipeline,
                                });

                                Ok(cursors)
                            }

                            break match msg {
                                StudioRecordingActorControlMessage::Pause(tx) => {
                                    let (res, cursors, next_cursor_id) =
                                        match shutdown(pipeline, &mut actor, segment_start_time)
                                            .await
                                        {
                                            Ok((cursors, next_cursor_id)) => {
                                                (Ok(()), cursors, next_cursor_id)
                                            }
                                            Err(e) => (Err(e), Default::default(), 0),
                                        };

                                    tx.send(res.map_err(Into::into)).ok();
                                    StudioRecordingActorState::Paused {
                                        next_index: index + 1,
                                        cursors,
                                        next_cursor_id,
                                    }
                                }
                                StudioRecordingActorControlMessage::Stop(tx) => {
                                    let res =
                                        shutdown(pipeline, &mut actor, segment_start_time).await;
                                    let res = match res {
                                        Ok((cursors, _)) => stop_recording(actor, cursors).await,
                                        Err(e) => Err(e),
                                    };

                                    tx.send(res).ok();

                                    break 'outer;
                                }
                                _ => continue,
                            };
                        }
                    }
                    StudioRecordingActorState::Paused {
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
                                StudioRecordingActorControlMessage::Stop(tx) => {
                                    tx.send(stop_recording(actor, cursors).await).ok();
                                    break 'outer;
                                }
                                StudioRecordingActorControlMessage::Resume(tx) => {
                                    let (state, res) = match create_segment_pipeline(
                                        &segments_dir,
                                        &cursors_dir,
                                        next_index,
                                        screen_source.clone(),
                                        camera_feed.as_deref(),
                                        audio_input_feed.as_ref(),
                                        options.capture_system_audio,
                                        cursors,
                                        next_cursor_id,
                                    )
                                    .await
                                    {
                                        Ok((pipeline, pipeline_done_rx)) => (
                                            StudioRecordingActorState::Recording {
                                                pipeline,
                                                pipeline_done_rx,
                                                index: next_index,
                                                segment_start_time: current_time_f64(),
                                            },
                                            Ok(()),
                                        ),
                                        Err(e) => {
                                            (StudioRecordingActorState::Stopped, Err(e.into()))
                                        }
                                    };

                                    tx.send(res).ok();

                                    state
                                }
                                _ => continue,
                            };
                        }
                    }
                    StudioRecordingActorState::Stopped => {
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

    Ok((
        StudioRecordingHandle {
            ctrl_tx,
            options,
            bounds,
        },
        done_rx,
    ))
}

pub struct CompletedStudioRecording {
    pub id: String,
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: StudioRecordingMeta,
    pub cursor_data: cap_project::CursorImages,
    pub segments: Vec<StudioRecordingSegment>,
}

async fn stop_recording(
    actor: StudioRecordingActor,
    cursors: Cursors,
) -> Result<CompletedStudioRecording, RecordingError> {
    use cap_project::*;

    let meta = StudioRecordingMeta::MultipleSegments {
        inner: MultipleSegments {
            segments: {
                actor
                    .segments
                    .iter()
                    .map(|s| MultipleSegment {
                        display: Display {
                            path: RelativePathBuf::from_path(
                                s.pipeline
                                    .display_output_path
                                    .strip_prefix(&actor.recording_dir)
                                    .unwrap(),
                            )
                            .unwrap(),
                            fps: actor.fps,
                        },
                        camera: s.pipeline.camera.as_ref().map(|camera| CameraMeta {
                            path: RelativePathBuf::from_path(
                                camera
                                    .output_path
                                    .strip_prefix(&actor.recording_dir)
                                    .unwrap()
                                    .to_owned(),
                            )
                            .unwrap(),
                            fps: camera.fps,
                        }),
                        audio: s.pipeline.audio_output_path.as_ref().map(|path| AudioMeta {
                            path: RelativePathBuf::from_path(
                                path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
                            )
                            .unwrap(),
                        }),
                        cursor: s.pipeline.cursor.as_ref().map(|cursor| {
                            RelativePathBuf::from_path(
                                cursor
                                    .output_path
                                    .strip_prefix(&actor.recording_dir)
                                    .unwrap()
                                    .to_owned(),
                            )
                            .unwrap()
                        }),
                        system_audio: s.pipeline.system_audio_path.as_ref().map(|path| AudioMeta {
                            path: RelativePathBuf::from_path(
                                path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
                            )
                            .unwrap(),
                        }),
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
        display_source: actor.options.capture_target,
        segments: actor.segments,
    })
}

#[tracing::instrument(skip_all, name = "segment", fields(index = index))]
async fn create_segment_pipeline<TCaptureFormat: MakeCapturePipeline>(
    segments_dir: &PathBuf,
    cursors_dir: &PathBuf,
    index: u32,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    camera_feed: Option<&Mutex<CameraFeed>>,
    audio_input_feed: Option<&AudioInputFeed>,
    capture_system_audio: bool,
    prev_cursors: Cursors,
    next_cursors_id: u32,
) -> Result<(StudioRecordingPipeline, oneshot::Receiver<()>), MediaError> {
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

    let screen_bounds = screen_source.get_bounds().clone();
    pipeline_builder = TCaptureFormat::make_capture_pipeline(
        pipeline_builder,
        screen_source,
        display_output_path.clone(),
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
        let output_path = dir.join("audio-input.ogg");

        let mic_encoder = OggFile::init(
            output_path.clone(),
            OpusEncoder::factory("microphone", mic_config),
        )?;

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

    let system_audio_path = if capture_system_audio {
        let output_path = dir.join("system_audio.ogg");

        async fn create<T: SystemAudioSource + PipelineSourceTask<Output = FFAudio>>(
            output_path: PathBuf,
            pipeline_builder: PipelineBuilder<RealTimeClock<()>>,
            source: T,
        ) -> Result<PipelineBuilder<RealTimeClock<()>>, MediaError>
        where
            T: 'static,
            T::Clock: Send + 'static,
            RealTimeClock<()>: CloneInto<T::Clock>,
        {
            let system_audio_encoder = OggFile::init(
                output_path.clone(),
                OpusEncoder::factory(
                    "system_audio",
                    T::info().map_err(|e| MediaError::TaskLaunch(e))?,
                ),
            )?;

            Ok(pipeline_builder
                .source("system_audio_capture", source)
                .sink("system_audio_encoder", system_audio_encoder))
        }

        pipeline_builder = create(output_path.clone(), pipeline_builder, {
            #[cfg(target_os = "macos")]
            {
                system_audio::macos::Source::init()
                    .await
                    .map_err(|e| MediaError::TaskLaunch(e))?
            }
            #[cfg(windows)]
            {
                system_audio::windows::Source
            }
        })
        .await?;

        Some(output_path)
    } else {
        None
    };

    let camera = if let Some(camera_source) = camera_feed.map(CameraSource::init) {
        let camera_config = camera_source.info();
        let output_path = dir.join("camera.mp4");

        let camera_encoder = MP4File::init(
            "camera",
            output_path.clone(),
            H264Encoder::factory("camera", camera_config),
            |_| None,
        )?;

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

    let cursor = FLAGS.record_mouse_state.then(|| {
        let cursor = spawn_cursor_recorder(
            screen_bounds.clone(),
            cursors_dir.clone(),
            prev_cursors,
            next_cursors_id,
        );

        CursorPipeline {
            output_path: dir.join("cursor.json"),
            actor: Some(cursor),
        }
    });

    pipeline.play().await?;

    info!("pipeline playing");

    Ok((
        StudioRecordingPipeline {
            inner: pipeline,
            display_output_path,
            audio_output_path,
            camera,
            cursor,
            system_audio_path,
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

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
