use crate::{
    ActorError, MediaError, RecordingBaseInputs, RecordingError,
    capture_pipeline::{
        MakeCapturePipeline, ScreenCaptureMethod, Stop, target_to_display_and_crop,
    },
    cursor::{CursorActor, Cursors, spawn_cursor_recorder},
    feeds::{camera::CameraFeedLock, microphone::MicrophoneFeedLock},
    ffmpeg::{Mp4Muxer, OggMuxer},
    output_pipeline::{DoneFut, FinishedOutputPipeline, OutputPipeline, PipelineDoneError},
    screen_capture::ScreenCaptureConfig,
    sources::{self, screen_capture},
};
use anyhow::{Context as _, anyhow};
use cap_media_info::VideoInfo;
use cap_project::{CursorEvents, StudioRecordingMeta};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{FutureExt, StreamExt, future::OptionFuture, stream::FuturesUnordered};
use kameo::{Actor as _, prelude::*};
use relative_path::RelativePathBuf;
use scap_targets::WindowId;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use tracing::{Instrument, debug, error_span, info, trace};

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

#[derive(Clone)]
pub struct ActorHandle {
    actor_ref: kameo::actor::ActorRef<Actor>,
    pub capture_target: screen_capture::ScreenCaptureTarget,
    done_fut: DoneFut,
    // pub bounds: Bounds,
}

#[derive(kameo::Actor)]
pub struct Actor {
    recording_dir: PathBuf,
    capture_target: screen_capture::ScreenCaptureTarget,
    video_info: VideoInfo,
    state: Option<ActorState>,
    fps: u32,
    segment_factory: SegmentPipelineFactory,
    segments: Vec<RecordingSegment>,
    completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
}

impl Actor {
    async fn stop_pipeline(
        &mut self,
        pipeline: Pipeline,
        segment_start_time: f64,
    ) -> anyhow::Result<(Cursors, u32)> {
        tracing::info!("pipeline shuting down");

        let mut pipeline = pipeline.stop().await?;

        tracing::info!("pipeline shutdown");

        let segment_stop_time = current_time_f64();

        let cursors = if let Some(cursor) = pipeline.cursor.as_mut()
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

        self.segments.push(RecordingSegment {
            start: segment_start_time,
            end: segment_stop_time,
            pipeline,
        });

        Ok(cursors)
    }

    fn notify_completion_ok(&self) {
        if self.completion_tx.borrow().is_none() {
            let _ = self.completion_tx.send(Some(Ok(())));
        }
    }
}

impl Message<Stop> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(&mut self, _: Stop, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let cursors = match self.state.take() {
            Some(ActorState::Recording {
                pipeline,
                segment_start_time,
                segment_start_instant,
                ..
            }) => {
                // Wait for minimum segment duration
                tokio::time::sleep_until((segment_start_instant + Duration::from_secs(1)).into())
                    .await;

                let (cursors, _) = self.stop_pipeline(pipeline, segment_start_time).await?;

                cursors
            }
            Some(ActorState::Paused { cursors, .. }) => cursors,
            _ => return Err(anyhow!("Not recording")),
        };

        ctx.actor_ref().stop_gracefully().await?;

        let recording = stop_recording(
            self.recording_dir.clone(),
            std::mem::take(&mut self.segments),
            cursors,
        )
        .await?;

        self.notify_completion_ok();

        Ok(recording)
    }
}

struct Pause;

impl Message<Pause> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Pause, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.state = match self.state.take() {
            Some(ActorState::Recording {
                pipeline,
                segment_start_time,
                index,
                ..
            }) => {
                let (cursors, next_cursor_id) =
                    self.stop_pipeline(pipeline, segment_start_time).await?;

                Some(ActorState::Paused {
                    next_index: index + 1,
                    cursors,
                    next_cursor_id,
                })
            }
            state => state,
        };

        Ok(())
    }
}

struct Resume;

impl Message<Resume> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Resume, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.state = match self.state.take() {
            Some(ActorState::Paused {
                next_index,
                cursors,
                next_cursor_id,
            }) => {
                let pipeline = self
                    .segment_factory
                    .create_next(cursors, next_cursor_id)
                    .await?;

                Some(ActorState::Recording {
                    pipeline,
                    // pipeline_done_rx,
                    index: next_index,
                    segment_start_time: current_time_f64(),
                    segment_start_instant: Instant::now(),
                })
            }
            state => state,
        };

        Ok(())
    }
}

struct Cancel;

impl Message<Cancel> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Cancel, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if let Some(ActorState::Recording { pipeline, .. }) = self.state.take() {
            let _ = pipeline.stop().await;

            self.notify_completion_ok();
        }

        Ok(())
    }
}

pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: FinishedPipeline,
}

pub struct ScreenPipelineOutput {
    pub inner: OutputPipeline,
    pub video_info: VideoInfo,
}

struct Pipeline {
    pub start_time: Timestamps,
    // sources
    pub screen: OutputPipeline,
    pub microphone: Option<OutputPipeline>,
    pub camera: Option<OutputPipeline>,
    pub system_audio: Option<OutputPipeline>,
    pub cursor: Option<CursorPipeline>,
}

struct FinishedPipeline {
    pub start_time: Timestamps,
    // sources
    pub screen: FinishedOutputPipeline,
    pub microphone: Option<FinishedOutputPipeline>,
    pub camera: Option<FinishedOutputPipeline>,
    pub system_audio: Option<FinishedOutputPipeline>,
    pub cursor: Option<CursorPipeline>,
}

impl Pipeline {
    pub async fn stop(mut self) -> anyhow::Result<FinishedPipeline> {
        let (screen, microphone, camera, system_audio) = futures::join!(
            self.screen.stop(),
            OptionFuture::from(self.microphone.map(|s| s.stop())),
            OptionFuture::from(self.camera.map(|s| s.stop())),
            OptionFuture::from(self.system_audio.map(|s| s.stop()))
        );

        if let Some(cursor) = self.cursor.as_mut() {
            cursor.actor.stop();
        }

        Ok(FinishedPipeline {
            start_time: self.start_time,
            screen: screen?,
            microphone: microphone.transpose()?,
            camera: camera.transpose()?,
            system_audio: system_audio.transpose()?,
            cursor: self.cursor,
        })
    }

    fn spawn_watcher(&self, completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>) {
        let mut futures = FuturesUnordered::new();
        futures.push(self.screen.done_fut());

        if let Some(ref microphone) = self.microphone {
            futures.push(microphone.done_fut());
        }

        if let Some(ref camera) = self.camera {
            futures.push(camera.done_fut());
        }

        if let Some(ref system_audio) = self.system_audio {
            futures.push(system_audio.done_fut());
        }

        tokio::spawn(async move {
            while let Some(res) = futures.next().await {
                if let Err(err) = res {
                    if completion_tx.borrow().is_none() {
                        let _ = completion_tx.send(Some(Err(err)));
                    }
                }
            }
        });
    }
}

struct CursorPipeline {
    output_path: PathBuf,
    actor: CursorActor,
}

impl ActorHandle {
    pub async fn stop(&self) -> anyhow::Result<CompletedRecording> {
        Ok(self.actor_ref.ask(Stop).await?)
    }

    pub fn done_fut(&self) -> DoneFut {
        self.done_fut.clone()
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Pause).await?)
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Resume).await?)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Cancel).await?)
    }
}

impl Actor {
    pub fn builder(
        output: PathBuf,
        capture_target: screen_capture::ScreenCaptureTarget,
    ) -> ActorBuilder {
        ActorBuilder::new(output, capture_target)
    }
}

pub struct ActorBuilder {
    output_path: PathBuf,
    capture_target: screen_capture::ScreenCaptureTarget,
    system_audio: bool,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    camera_feed: Option<Arc<CameraFeedLock>>,
    custom_cursor: bool,
    #[cfg(target_os = "macos")]
    excluded_windows: Vec<WindowId>,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: screen_capture::ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            camera_feed: None,
            custom_cursor: false,
            #[cfg(target_os = "macos")]
            excluded_windows: Vec::new(),
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

    #[cfg(target_os = "macos")]
    pub fn with_excluded_windows(mut self, excluded_windows: Vec<WindowId>) -> Self {
        self.excluded_windows = excluded_windows;
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    ) -> anyhow::Result<ActorHandle> {
        spawn_studio_recording_actor(
            self.output_path,
            RecordingBaseInputs {
                capture_target: self.capture_target,
                capture_system_audio: self.system_audio,
                mic_feed: self.mic_feed,
                camera_feed: self.camera_feed,
                #[cfg(target_os = "macos")]
                shareable_content,
                #[cfg(target_os = "macos")]
                excluded_windows: self.excluded_windows,
            },
            self.custom_cursor,
        )
        .await
    }
}

#[tracing::instrument("studio_recording", skip_all)]
async fn spawn_studio_recording_actor(
    recording_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
) -> anyhow::Result<ActorHandle> {
    ensure_dir(&recording_dir)?;

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let segments_dir = ensure_dir(&content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

    let start_time = Timestamps::now();

    let (completion_tx, completion_rx) =
        watch::channel::<Option<Result<(), PipelineDoneError>>>(None);

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
        completion_tx.clone(),
    );

    let index = 0;
    let pipeline = segment_pipeline_factory
        .create_next(Default::default(), 0)
        .await?;

    let done_fut = completion_rx_to_done_fut(completion_rx);

    let segment_start_time = current_time_f64();

    trace!("spawning recording actor");

    let base_inputs = base_inputs.clone();
    let fps = pipeline.screen.video_info().unwrap().fps();

    let actor_ref = Actor::spawn(Actor {
        recording_dir,
        fps,
        capture_target: base_inputs.capture_target.clone(),
        video_info: pipeline.screen.video_info().unwrap(),
        state: Some(ActorState::Recording {
            pipeline,
            /*pipeline_done_rx,*/
            index,
            segment_start_time,
            segment_start_instant: Instant::now(),
        }),
        segment_factory: segment_pipeline_factory,
        segments: Vec::new(),
        completion_tx: completion_tx.clone(),
    });

    Ok(ActorHandle {
        actor_ref,
        capture_target: base_inputs.capture_target,
        done_fut,
    })
}

pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
    pub cursor_data: cap_project::CursorImages,
}

async fn stop_recording(
    recording_dir: PathBuf,
    segments: Vec<RecordingSegment>,
    cursors: Cursors,
) -> Result<CompletedRecording, RecordingError> {
    use cap_project::*;

    let make_relative = |path: &PathBuf| {
        RelativePathBuf::from_path(path.strip_prefix(&recording_dir).unwrap()).unwrap()
    };

    let meta = StudioRecordingMeta::MultipleSegments {
        inner: MultipleSegments {
            segments: futures::stream::iter(segments)
                .then(async |s| {
                    let to_start_time = |timestamp: Timestamp| {
                        timestamp
                            .duration_since(s.pipeline.start_time)
                            .as_secs_f64()
                    };

                    MultipleSegment {
                        display: VideoMeta {
                            path: make_relative(&s.pipeline.screen.path),
                            fps: s.pipeline.screen.video_info.unwrap().fps(),
                            start_time: Some(to_start_time(s.pipeline.screen.first_timestamp)),
                        },
                        camera: s.pipeline.camera.map(|camera| VideoMeta {
                            path: make_relative(&camera.path),
                            fps: camera.video_info.unwrap().fps(),
                            start_time: Some(to_start_time(camera.first_timestamp)),
                        }),
                        mic: s.pipeline.microphone.map(|mic| AudioMeta {
                            path: make_relative(&mic.path),
                            start_time: Some(to_start_time(mic.first_timestamp)),
                        }),
                        system_audio: s.pipeline.system_audio.map(|audio| AudioMeta {
                            path: make_relative(&audio.path),
                            start_time: Some(to_start_time(audio.first_timestamp)),
                        }),
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
            status: Some(StudioRecordingStatus::Complete),
        },
    };

    let project_config = cap_project::ProjectConfiguration::default();
    project_config
        .write(&recording_dir)
        .map_err(RecordingError::from)?;

    Ok(CompletedRecording {
        project_path: recording_dir,
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
    completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    #[cfg(windows)]
    encoder_preferences: crate::capture_pipeline::EncoderPreferences,
}

impl SegmentPipelineFactory {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        segments_dir: PathBuf,
        cursors_dir: PathBuf,
        base_inputs: RecordingBaseInputs,
        custom_cursor_capture: bool,
        start_time: Timestamps,
        completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    ) -> Self {
        Self {
            segments_dir,
            cursors_dir,
            base_inputs,
            custom_cursor_capture,
            start_time,
            index: 0,
            completion_tx,
            #[cfg(windows)]
            encoder_preferences: crate::capture_pipeline::EncoderPreferences::new(),
        }
    }

    pub async fn create_next(
        &mut self,
        cursors: Cursors,
        next_cursors_id: u32,
    ) -> anyhow::Result<Pipeline> {
        let pipeline = create_segment_pipeline(
            &self.segments_dir,
            &self.cursors_dir,
            self.index,
            self.base_inputs.clone(),
            cursors,
            next_cursors_id,
            self.custom_cursor_capture,
            self.start_time,
            #[cfg(windows)]
            self.encoder_preferences.clone(),
        )
        .await?;

        self.index += 1;

        pipeline.spawn_watcher(self.completion_tx.clone());

        Ok(pipeline)
    }
}

fn completion_rx_to_done_fut(
    mut rx: watch::Receiver<Option<Result<(), PipelineDoneError>>>,
) -> DoneFut {
    async move {
        loop {
            if let Some(result) = rx.borrow().clone() {
                return result;
            }

            if rx.changed().await.is_err() {
                return Ok(());
            }
        }
    }
    .boxed()
    .shared()
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
    base_inputs: RecordingBaseInputs,
    prev_cursors: Cursors,
    next_cursors_id: u32,
    custom_cursor_capture: bool,
    start_time: Timestamps,
    #[cfg(windows)] encoder_preferences: crate::capture_pipeline::EncoderPreferences,
) -> anyhow::Result<Pipeline> {
    #[cfg(windows)]
    let d3d_device = crate::capture_pipeline::create_d3d_device().unwrap();

    let (display, crop) =
        target_to_display_and_crop(&base_inputs.capture_target).context("target_display_crop")?;

    let screen_config = ScreenCaptureConfig::<ScreenCaptureMethod>::init(
        display,
        crop,
        !custom_cursor_capture,
        120,
        start_time.system_time(),
        base_inputs.capture_system_audio,
        #[cfg(windows)]
        d3d_device,
        #[cfg(target_os = "macos")]
        base_inputs.shareable_content,
        #[cfg(target_os = "macos")]
        base_inputs.excluded_windows,
    )
    .await
    .context("screen capture init")?;

    let (capture_source, system_audio) = screen_config.to_sources().await?;

    let dir = ensure_dir(&segments_dir.join(format!("segment-{index}")))?;

    let screen_output_path = dir.join("display.mp4");

    trace!("preparing segment pipeline {index}");

    let screen = ScreenCaptureMethod::make_studio_mode_pipeline(
        capture_source,
        screen_output_path.clone(),
        start_time,
        #[cfg(windows)]
        encoder_preferences,
    )
    .instrument(error_span!("screen-out"))
    .await
    .context("screen pipeline setup")?;

    let camera = OptionFuture::from(base_inputs.camera_feed.map(|camera_feed| {
        OutputPipeline::builder(dir.join("camera.mp4"))
            .with_video::<sources::Camera>(camera_feed)
            .with_timestamps(start_time)
            .build::<Mp4Muxer>(())
            .instrument(error_span!("camera-out"))
    }))
    .await
    .transpose()
    .context("camera pipeline setup")?;

    let microphone = OptionFuture::from(base_inputs.mic_feed.map(|mic_feed| {
        OutputPipeline::builder(dir.join("audio-input.ogg"))
            .with_audio_source::<sources::Microphone>(mic_feed)
            .with_timestamps(start_time)
            .build::<OggMuxer>(())
            .instrument(error_span!("mic-out"))
    }))
    .await
    .transpose()
    .context("microphone pipeline setup")?;

    let system_audio = OptionFuture::from(system_audio.map(|system_audio| {
        OutputPipeline::builder(dir.join("system_audio.ogg"))
            .with_audio_source::<screen_capture::SystemAudioSource>(system_audio)
            .with_timestamps(start_time)
            .build::<OggMuxer>(())
            .instrument(error_span!("system-audio-out"))
    }))
    .await
    .transpose()
    .context("microphone pipeline setup")?;

    let cursor = custom_cursor_capture
        .then(move || {
            let cursor_crop_bounds = base_inputs
                .capture_target
                .cursor_crop()
                .ok_or(CreateSegmentPipelineError::NoBounds)?;

            let cursor = spawn_cursor_recorder(
                cursor_crop_bounds,
                display,
                cursors_dir.to_path_buf(),
                prev_cursors,
                next_cursors_id,
                start_time,
            );

            Ok::<_, CreateSegmentPipelineError>(CursorPipeline {
                output_path: dir.join("cursor.json"),
                actor: cursor,
            })
        })
        .transpose()?;

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
