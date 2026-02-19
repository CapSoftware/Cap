#[cfg(target_os = "macos")]
use crate::SendableShareableContent;
#[cfg(target_os = "macos")]
use crate::output_pipeline::{
    AVFoundationCameraMuxer, AVFoundationCameraMuxerConfig, MacOSFragmentedM4SCameraMuxer,
    MacOSFragmentedM4SCameraMuxerConfig,
};
use crate::{
    ActorError, H264_MAX_DIMENSION, MediaError, RecordingBaseInputs, RecordingError,
    SharedPauseState, calculate_gpu_compatible_size,
    capture_pipeline::{
        MakeCapturePipeline, ScreenCaptureMethod, Stop, target_to_display_and_crop,
    },
    cursor::{CursorActor, Cursors, spawn_cursor_recorder},
    feeds::{camera::CameraFeedLock, microphone::MicrophoneFeedLock},
    ffmpeg::{FragmentedAudioMuxer, FragmentedAudioMuxerConfig, OggMuxer},
    output_pipeline::{DoneFut, FinishedOutputPipeline, OutputPipeline, PipelineDoneError},
    screen_capture::ScreenCaptureConfig,
    sources::{self, screen_capture},
};

#[cfg(windows)]
use crate::output_pipeline::{
    WindowsCameraMuxer, WindowsCameraMuxerConfig, WindowsFragmentedM4SCameraMuxer,
    WindowsFragmentedM4SCameraMuxerConfig,
};
use anyhow::{Context as _, anyhow, bail};
use cap_media_info::VideoInfo;
use cap_project::{
    CursorEvents, MultipleSegments, Platform, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, StudioRecordingStatus,
};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{FutureExt, StreamExt, future::OptionFuture, stream::FuturesUnordered};
use kameo::{Actor as _, prelude::*};
use relative_path::RelativePathBuf;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use tracing::{Instrument, debug, error_span, info, trace, warn};

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
    state: Option<ActorState>,
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

        let camera_device_id = self.segment_factory.camera_device_id();
        let mic_device_id = self.segment_factory.mic_device_id();

        self.segments.push(RecordingSegment {
            start: segment_start_time,
            end: segment_stop_time,
            pipeline,
            camera_device_id,
            mic_device_id,
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
            self.segment_factory.fragmented,
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
                let (cursors, next_cursor_id) = self
                    .stop_pipeline(pipeline, segment_start_time)
                    .await
                    .context("stop_pipeline")?;

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

                let new_segment_start_time = current_time_f64();

                Some(ActorState::Recording {
                    pipeline,
                    index: next_index,
                    segment_start_time: new_segment_start_time,
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
            if let Err(e) = pipeline.stop().await {
                warn!("Pipeline stop error during cancel: {e:#}");
            }

            self.notify_completion_ok();
        }

        Ok(())
    }
}

struct SetMicFeed {
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
}

impl Message<SetMicFeed> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, msg: SetMicFeed, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        match self.state.as_ref() {
            Some(ActorState::Recording { .. }) => {
                bail!("Pause the recording before changing microphone input")
            }
            Some(ActorState::Paused { .. }) => {
                self.segment_factory.set_mic_feed(msg.mic_feed);
                Ok(())
            }
            None => Err(anyhow!("Recording no longer active")),
        }
    }
}

struct SetCameraFeed {
    camera_feed: Option<Arc<CameraFeedLock>>,
}

impl Message<SetCameraFeed> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(
        &mut self,
        msg: SetCameraFeed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        match self.state.as_ref() {
            Some(ActorState::Recording { .. }) => {
                bail!("Pause the recording before changing camera input")
            }
            Some(ActorState::Paused { .. }) => {
                self.segment_factory.set_camera_feed(msg.camera_feed);
                Ok(())
            }
            None => Err(anyhow!("Recording no longer active")),
        }
    }
}

pub struct IsPaused;

impl Message<IsPaused> for Actor {
    type Reply = bool;

    async fn handle(&mut self, _: IsPaused, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        matches!(self.state, Some(ActorState::Paused { .. }))
    }
}

pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
    pipeline: FinishedPipeline,
    pub camera_device_id: Option<String>,
    pub mic_device_id: Option<String>,
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

        let system_audio = match system_audio.transpose() {
            Ok(value) => value,
            Err(err) => {
                warn!("system audio pipeline failed during stop: {err:#}");
                None
            }
        };

        Ok(FinishedPipeline {
            start_time: self.start_time,
            screen: screen.context("screen")?,
            microphone: microphone.transpose().context("microphone")?,
            camera: camera.transpose().context("camera")?,
            system_audio,
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

        // Ensure non-video pipelines stop promptly when the video pipeline completes
        {
            let mic_cancel = self.microphone.as_ref().map(|p| p.cancel_token());
            let cam_cancel = self.camera.as_ref().map(|p| p.cancel_token());
            let sys_cancel = self.system_audio.as_ref().map(|p| p.cancel_token());

            let screen_done = self.screen.done_fut();
            tokio::spawn(async move {
                // When screen (video) finishes, cancel the other pipelines
                let _ = screen_done.await;
                if let Some(token) = mic_cancel.as_ref() {
                    token.cancel();
                }
                if let Some(token) = cam_cancel.as_ref() {
                    token.cancel();
                }
                if let Some(token) = sys_cancel.as_ref() {
                    token.cancel();
                }
            });
        }

        tokio::spawn(async move {
            while let Some(res) = futures.next().await {
                if let Err(err) = res
                    && completion_tx.borrow().is_none()
                {
                    let _ = completion_tx.send(Some(Err(err)));
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

    pub async fn set_mic_feed(
        &self,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
    ) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(SetMicFeed { mic_feed }).await?)
    }

    pub async fn set_camera_feed(
        &self,
        camera_feed: Option<Arc<CameraFeedLock>>,
    ) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(SetCameraFeed { camera_feed }).await?)
    }

    pub async fn is_paused(&self) -> anyhow::Result<bool> {
        Ok(self.actor_ref.ask(IsPaused).await?)
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
    fragmented: bool,
    max_fps: u32,
    #[cfg(target_os = "macos")]
    excluded_windows: Vec<scap_targets::WindowId>,
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
            fragmented: false,
            max_fps: 60,
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

    pub fn with_fragmented(mut self, fragmented: bool) -> Self {
        self.fragmented = fragmented;
        self
    }

    pub fn with_max_fps(mut self, max_fps: u32) -> Self {
        self.max_fps = max_fps.clamp(1, 120);
        self
    }

    #[cfg(target_os = "macos")]
    pub fn with_excluded_windows(mut self, excluded_windows: Vec<scap_targets::WindowId>) -> Self {
        self.excluded_windows = excluded_windows;
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: Option<SendableShareableContent>,
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
            self.fragmented,
            self.max_fps,
        )
        .await
    }
}

#[tracing::instrument("studio_recording", skip_all)]
async fn spawn_studio_recording_actor(
    recording_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
    fragmented: bool,
    max_fps: u32,
) -> anyhow::Result<ActorHandle> {
    ensure_dir(&recording_dir)?;

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let segments_dir = ensure_dir(&content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(&content_dir.join("cursors"))?;

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
        fragmented,
        max_fps,
        completion_tx.clone(),
    );

    if fragmented {
        write_in_progress_meta(&recording_dir)?;
    }

    let index = 0;
    let pipeline = segment_pipeline_factory
        .create_next(Default::default(), 0)
        .await?;

    let done_fut = completion_rx_to_done_fut(completion_rx);

    let segment_start_time = current_time_f64();

    trace!("spawning recording actor");

    let base_inputs = base_inputs.clone();

    let actor_ref = Actor::spawn(Actor {
        recording_dir,
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
    fragmented: bool,
) -> Result<CompletedRecording, RecordingError> {
    use cap_project::*;

    const DEFAULT_FPS: u32 = 30;

    let make_relative = |path: &PathBuf| -> RelativePathBuf {
        match path.strip_prefix(&recording_dir) {
            Ok(stripped) => RelativePathBuf::from_path(stripped).unwrap_or_else(|_| {
                tracing::warn!(
                    "Failed to convert path to relative: {:?}, using filename only",
                    path
                );
                RelativePathBuf::from(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                )
            }),
            Err(_) => {
                tracing::warn!(
                    "Path {:?} is not inside recording_dir {:?}, using filename only",
                    path,
                    recording_dir
                );
                RelativePathBuf::from(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                )
            }
        }
    };

    let segment_metas: Vec<_> = futures::stream::iter(segments)
        .then(async |s| {
            let to_start_time =
                |timestamp: Timestamp| timestamp.signed_duration_since_secs(s.pipeline.start_time);

            let mic_start_time = s
                .pipeline
                .microphone
                .as_ref()
                .map(|mic| to_start_time(mic.first_timestamp));

            let camera_start_time = s.pipeline.camera.as_ref().map(|camera| {
                let raw_camera_start = to_start_time(camera.first_timestamp);
                if let Some(mic_start) = mic_start_time {
                    let sync_offset = raw_camera_start - mic_start;
                    if sync_offset.abs() > 0.030 {
                        mic_start
                    } else {
                        raw_camera_start
                    }
                } else {
                    raw_camera_start
                }
            });

            let raw_display_start = to_start_time(s.pipeline.screen.first_timestamp);
            let display_start_time = if let Some(cam_start) = camera_start_time {
                let sync_offset = raw_display_start - cam_start;
                if sync_offset.abs() > 0.030 {
                    cam_start
                } else {
                    raw_display_start
                }
            } else if let Some(mic_start) = mic_start_time {
                let sync_offset = raw_display_start - mic_start;
                if sync_offset.abs() > 0.030 {
                    mic_start
                } else {
                    raw_display_start
                }
            } else {
                raw_display_start
            };

            MultipleSegment {
                display: VideoMeta {
                    path: make_relative(&s.pipeline.screen.path),
                    fps: s
                        .pipeline
                        .screen
                        .video_info
                        .map(|v| v.fps())
                        .unwrap_or_else(|| {
                            tracing::warn!(
                                "Screen video_info missing, using default fps: {}",
                                DEFAULT_FPS
                            );
                            DEFAULT_FPS
                        }),
                    start_time: Some(display_start_time),
                    device_id: None,
                },
                camera: s.pipeline.camera.map(|camera| VideoMeta {
                    path: make_relative(&camera.path),
                    fps: camera.video_info.map(|v| v.fps()).unwrap_or_else(|| {
                        tracing::warn!(
                            "Camera video_info missing, using default fps: {}",
                            DEFAULT_FPS
                        );
                        DEFAULT_FPS
                    }),
                    start_time: camera_start_time,
                    device_id: s.camera_device_id.clone(),
                }),
                mic: s.pipeline.microphone.map(|mic| AudioMeta {
                    path: make_relative(&mic.path),
                    start_time: mic_start_time,
                    device_id: s.mic_device_id.clone(),
                }),
                system_audio: s.pipeline.system_audio.map(|audio| {
                    let raw_sys_start = to_start_time(audio.first_timestamp);
                    let sys_start_time = if let Some(mic_start) = mic_start_time {
                        let sync_offset = raw_sys_start - mic_start;
                        if sync_offset.abs() > 0.030 {
                            mic_start
                        } else {
                            raw_sys_start
                        }
                    } else {
                        let sync_offset = raw_sys_start - display_start_time;
                        if sync_offset.abs() > 0.030 {
                            display_start_time
                        } else {
                            raw_sys_start
                        }
                    };
                    AudioMeta {
                        path: make_relative(&audio.path),
                        start_time: Some(sys_start_time),
                        device_id: None,
                    }
                }),
                cursor: s
                    .pipeline
                    .cursor
                    .as_ref()
                    .map(|cursor| make_relative(&cursor.output_path)),
            }
        })
        .collect::<Vec<_>>()
        .await;

    let needs_remux = if fragmented {
        segment_metas.iter().any(|seg| {
            let display_path = seg.display.path.to_path(&recording_dir);
            display_path.is_dir()
        })
    } else {
        false
    };

    let status = if needs_remux {
        Some(StudioRecordingStatus::NeedsRemux)
    } else {
        Some(StudioRecordingStatus::Complete)
    };

    let meta = StudioRecordingMeta::MultipleSegments {
        inner: MultipleSegments {
            segments: segment_metas,
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
            status,
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
    fragmented: bool,
    max_fps: u32,
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
        fragmented: bool,
        max_fps: u32,
        completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    ) -> Self {
        Self {
            segments_dir,
            cursors_dir,
            base_inputs,
            custom_cursor_capture,
            fragmented,
            max_fps,
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
        let segment_start_time = Timestamps::now();
        let pipeline = create_segment_pipeline(
            &self.segments_dir,
            &self.cursors_dir,
            self.index,
            self.base_inputs.clone(),
            cursors,
            next_cursors_id,
            self.custom_cursor_capture,
            self.fragmented,
            self.max_fps,
            segment_start_time,
            #[cfg(windows)]
            self.encoder_preferences.clone(),
        )
        .await?;

        self.index += 1;

        pipeline.spawn_watcher(self.completion_tx.clone());

        Ok(pipeline)
    }

    pub fn set_mic_feed(&mut self, mic_feed: Option<Arc<MicrophoneFeedLock>>) {
        self.base_inputs.mic_feed = mic_feed;
    }

    pub fn set_camera_feed(&mut self, camera_feed: Option<Arc<CameraFeedLock>>) {
        self.base_inputs.camera_feed = camera_feed;
    }

    pub fn camera_device_id(&self) -> Option<String> {
        self.base_inputs
            .camera_feed
            .as_ref()
            .map(|f| f.camera_info().device_id().to_string())
    }

    pub fn mic_device_id(&self) -> Option<String> {
        self.base_inputs
            .mic_feed
            .as_ref()
            .map(|f| f.device_name().to_string())
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
    segments_dir: &Path,
    cursors_dir: &Path,
    index: u32,
    base_inputs: RecordingBaseInputs,
    prev_cursors: Cursors,
    next_cursors_id: u32,
    custom_cursor_capture: bool,
    fragmented: bool,
    max_fps: u32,
    start_time: Timestamps,
    #[cfg(windows)] encoder_preferences: crate::capture_pipeline::EncoderPreferences,
) -> anyhow::Result<Pipeline> {
    #[cfg(windows)]
    let d3d_device = crate::capture_pipeline::create_d3d_device()
        .context("D3D11 device creation failed - this may happen in VMs, RDP sessions, or systems without GPU drivers")?;

    let dir = ensure_dir(&segments_dir.join(format!("segment-{index}")))?;

    let screen_output_path = dir.join("display.mp4");

    trace!("preparing segment pipeline {index}");

    #[cfg(target_os = "macos")]
    let shared_pause_state = if fragmented {
        Some(SharedPauseState::new(Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        )))
    } else {
        None
    };

    #[cfg(windows)]
    let shared_pause_state = if fragmented {
        Some(SharedPauseState::new(Arc::new(
            std::sync::atomic::AtomicBool::new(false),
        )))
    } else {
        None
    };

    let camera_only = matches!(
        base_inputs.capture_target,
        screen_capture::ScreenCaptureTarget::CameraOnly
    );

    let (screen, system_audio, cursor_display) = if camera_only {
        let camera_feed = base_inputs.camera_feed.clone().ok_or_else(|| {
            anyhow!(
                "Camera-only recording requires a camera, but no camera is currently available. \
                Please select a camera in the recording settings before starting. \
                If you have already selected a camera, it may have been disconnected or \
                failed to initialize. Try reconnecting your camera or selecting a different one."
            )
        })?;

        #[cfg(target_os = "macos")]
        let screen = OutputPipeline::builder(screen_output_path.clone())
            .with_video::<sources::NativeCamera>(camera_feed.clone())
            .with_timestamps(start_time)
            .build::<AVFoundationCameraMuxer>(AVFoundationCameraMuxerConfig::default())
            .instrument(error_span!("screen-out"))
            .await
            .context("camera-only screen pipeline setup")?;

        #[cfg(windows)]
        let screen = OutputPipeline::builder(screen_output_path.clone())
            .with_video::<sources::NativeCamera>(camera_feed.clone())
            .with_timestamps(start_time)
            .build::<WindowsCameraMuxer>(WindowsCameraMuxerConfig {
                encoder_preferences: encoder_preferences.clone(),
                ..Default::default()
            })
            .instrument(error_span!("screen-out"))
            .await
            .context("camera-only screen pipeline setup")?;

        (screen, None, None)
    } else {
        let capture_target = base_inputs.capture_target.clone();

        #[cfg(windows)]
        let d3d_device = d3d_device;

        let (display, crop) =
            target_to_display_and_crop(&capture_target).context("target_display_crop")?;

        let screen_config = ScreenCaptureConfig::<ScreenCaptureMethod>::init(
            display,
            crop,
            !custom_cursor_capture,
            max_fps,
            start_time.system_time(),
            base_inputs.capture_system_audio,
            #[cfg(windows)]
            d3d_device,
            #[cfg(target_os = "macos")]
            base_inputs
                .shareable_content
                .clone()
                .ok_or_else(|| anyhow!("Missing shareable content"))?,
            #[cfg(target_os = "macos")]
            base_inputs.excluded_windows.clone(),
        )
        .await
        .context("screen capture init")?;

        let screen_info = screen_config.info();
        let output_size = calculate_gpu_compatible_size(
            screen_info.width,
            screen_info.height,
            H264_MAX_DIMENSION,
        );

        let (capture_source, system_audio) = screen_config.to_sources().await?;

        let screen = ScreenCaptureMethod::make_studio_mode_pipeline(
            capture_source,
            screen_output_path.clone(),
            start_time,
            fragmented,
            shared_pause_state.clone(),
            output_size,
            #[cfg(windows)]
            encoder_preferences.clone(),
        )
        .instrument(error_span!("screen-out"))
        .await
        .context("screen pipeline setup")?;

        (screen, system_audio, Some(display))
    };

    #[cfg(target_os = "macos")]
    let camera = if camera_only {
        None
    } else if let Some(camera_feed) = base_inputs.camera_feed {
        let pipeline = if fragmented {
            let fragments_dir = dir.join("camera");
            OutputPipeline::builder(fragments_dir)
                .with_video::<sources::NativeCamera>(camera_feed)
                .with_timestamps(start_time)
                .build::<MacOSFragmentedM4SCameraMuxer>(MacOSFragmentedM4SCameraMuxerConfig {
                    shared_pause_state: shared_pause_state.clone(),
                    ..Default::default()
                })
                .instrument(error_span!("camera-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("camera.mp4"))
                .with_video::<sources::NativeCamera>(camera_feed)
                .with_timestamps(start_time)
                .build::<AVFoundationCameraMuxer>(AVFoundationCameraMuxerConfig::default())
                .instrument(error_span!("camera-out"))
                .await
        };
        Some(pipeline.context("camera pipeline setup")?)
    } else {
        None
    };

    #[cfg(windows)]
    let camera = if camera_only {
        None
    } else if let Some(camera_feed) = base_inputs.camera_feed {
        let pipeline = if fragmented {
            let fragments_dir = dir.join("camera");
            OutputPipeline::builder(fragments_dir)
                .with_video::<sources::NativeCamera>(camera_feed)
                .with_timestamps(start_time)
                .build::<WindowsFragmentedM4SCameraMuxer>(WindowsFragmentedM4SCameraMuxerConfig {
                    shared_pause_state: shared_pause_state.clone(),
                    ..Default::default()
                })
                .instrument(error_span!("camera-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("camera.mp4"))
                .with_video::<sources::NativeCamera>(camera_feed)
                .with_timestamps(start_time)
                .build::<WindowsCameraMuxer>(WindowsCameraMuxerConfig {
                    encoder_preferences: encoder_preferences.clone(),
                    ..Default::default()
                })
                .instrument(error_span!("camera-out"))
                .await
        };
        Some(pipeline.context("camera pipeline setup")?)
    } else {
        None
    };

    let microphone = if let Some(mic_feed) = base_inputs.mic_feed {
        let pipeline = if fragmented {
            let output_path = dir.join("audio-input.m4a");
            OutputPipeline::builder(output_path)
                .with_audio_source::<sources::Microphone>(mic_feed)
                .with_timestamps(start_time)
                .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
                    shared_pause_state: shared_pause_state.clone(),
                })
                .instrument(error_span!("mic-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("audio-input.ogg"))
                .with_audio_source::<sources::Microphone>(mic_feed)
                .with_timestamps(start_time)
                .build::<OggMuxer>(())
                .instrument(error_span!("mic-out"))
                .await
        };
        Some(pipeline.context("microphone pipeline setup")?)
    } else {
        None
    };

    let system_audio = if let Some(system_audio_source) = system_audio {
        let pipeline = if fragmented {
            let output_path = dir.join("system_audio.m4a");
            OutputPipeline::builder(output_path)
                .with_audio_source::<screen_capture::SystemAudioSource>(system_audio_source)
                .with_timestamps(start_time)
                .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
                    shared_pause_state: shared_pause_state.clone(),
                })
                .instrument(error_span!("system-audio-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("system_audio.ogg"))
                .with_audio_source::<screen_capture::SystemAudioSource>(system_audio_source)
                .with_timestamps(start_time)
                .build::<OggMuxer>(())
                .instrument(error_span!("system-audio-out"))
                .await
        };
        Some(pipeline.context("system audio pipeline setup")?)
    } else {
        None
    };

    let cursor = if camera_only {
        None
    } else {
        custom_cursor_capture
            .then(move || {
                let cursor_crop_bounds = base_inputs
                    .capture_target
                    .cursor_crop()
                    .ok_or(CreateSegmentPipelineError::NoBounds)?;

                let cursor_output_path = dir.join("cursor.json");
                let incremental_output = if fragmented {
                    Some(cursor_output_path.clone())
                } else {
                    None
                };

                let cursor_display = cursor_display.ok_or(CreateSegmentPipelineError::NoDisplay)?;

                let cursor = spawn_cursor_recorder(
                    cursor_crop_bounds,
                    cursor_display,
                    cursors_dir.to_path_buf(),
                    prev_cursors,
                    next_cursors_id,
                    start_time,
                    incremental_output,
                );

                Ok::<_, CreateSegmentPipelineError>(CursorPipeline {
                    output_path: cursor_output_path,
                    actor: cursor,
                })
            })
            .transpose()?
    };

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

fn write_in_progress_meta(recording_dir: &Path) -> anyhow::Result<()> {
    use chrono::Local;

    let pretty_name = Local::now().format("Cap %Y-%m-%d at %H.%M.%S").to_string();

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.to_path_buf(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: Vec::new(),
                cursors: cap_project::Cursors::default(),
                status: Some(StudioRecordingStatus::InProgress),
            },
        })),
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| anyhow!("Failed to save in-progress meta: {:?}", e))
}
