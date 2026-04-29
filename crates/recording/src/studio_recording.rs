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
    cursor::{CursorActor, Cursors, IncrementalCaptureOutputs, spawn_cursor_recorder},
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
    CursorEvents, KeyboardEvents, MultipleSegment, MultipleSegments, Platform, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus,
};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{FutureExt, StreamExt, future::OptionFuture, stream::FuturesUnordered};
use kameo::{Actor as _, prelude::*};
use relative_path::RelativePathBuf;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::watch, task::JoinHandle};
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
            if let Some(output_path) = cursor.output_path.as_ref() {
                std::fs::write(
                    output_path,
                    serde_json::to_string_pretty(&CursorEvents {
                        clicks: res.clicks,
                        moves: res.moves,
                    })?,
                )?;
            }

            if !res.keyboard_presses.is_empty()
                && let Some(keyboard_output_path) = cursor.keyboard_output_path.as_ref()
            {
                KeyboardEvents {
                    presses: res.keyboard_presses,
                }
                .write_to_file(keyboard_output_path)
                .map_err(anyhow::Error::msg)?;
            }

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
    pub track_failures: SharedTrackFailures,
    pub watcher_task: Option<JoinHandle<()>>,
}

struct FinishedPipeline {
    pub start_time: Timestamps,
    // sources
    pub screen: FinishedOutputPipeline,
    pub microphone: Option<FinishedOutputPipeline>,
    pub camera: Option<FinishedOutputPipeline>,
    pub system_audio: Option<FinishedOutputPipeline>,
    pub cursor: Option<CursorPipeline>,
    pub track_failures: Vec<TrackFailureRecord>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RecordingTrackKind {
    Display,
    Microphone,
    Camera,
    SystemAudio,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TrackFailureStage {
    Runtime,
    Stop,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrackFailureRecord {
    track: RecordingTrackKind,
    stage: TrackFailureStage,
    error: String,
}

type SharedTrackFailures = Arc<std::sync::Mutex<Vec<TrackFailureRecord>>>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RecordingFailureDiagnostics {
    version: u32,
    segments: Vec<SegmentFailureDiagnostics>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SegmentFailureDiagnostics {
    segment_index: u32,
    start: f64,
    end: f64,
    track_failures: Vec<TrackFailureRecord>,
}

struct SegmentOutput {
    meta: MultipleSegment,
    diagnostics: Option<SegmentFailureDiagnostics>,
}

fn record_track_failure(
    failures: &SharedTrackFailures,
    track: RecordingTrackKind,
    stage: TrackFailureStage,
    error: impl Into<String>,
) {
    let error = error.into();
    match failures.lock() {
        Ok(mut failures) => failures.push(TrackFailureRecord {
            track,
            stage,
            error,
        }),
        Err(poisoned) => poisoned.into_inner().push(TrackFailureRecord {
            track,
            stage,
            error,
        }),
    }
}

fn take_track_failures(failures: &SharedTrackFailures) -> Vec<TrackFailureRecord> {
    match failures.lock() {
        Ok(mut failures) => std::mem::take(&mut *failures),
        Err(poisoned) => {
            let mut failures = poisoned.into_inner();
            std::mem::take(&mut *failures)
        }
    }
}

fn has_track_failure(failures: &SharedTrackFailures, track: RecordingTrackKind) -> bool {
    match failures.lock() {
        Ok(failures) => failures.iter().any(|failure| failure.track == track),
        Err(poisoned) => poisoned
            .into_inner()
            .iter()
            .any(|failure| failure.track == track),
    }
}

fn finalize_optional_track(
    track: RecordingTrackKind,
    result: Result<Option<FinishedOutputPipeline>, anyhow::Error>,
    failures: &SharedTrackFailures,
) -> Option<FinishedOutputPipeline> {
    match result {
        Ok(value) => value,
        Err(error) => {
            warn!(?track, error = %error, "Optional recording track failed during stop");
            if !has_track_failure(failures, track) {
                record_track_failure(failures, track, TrackFailureStage::Stop, error.to_string());
            }
            None
        }
    }
}

fn build_recording_failure_diagnostics(
    segments: &[SegmentFailureDiagnostics],
) -> Option<RecordingFailureDiagnostics> {
    if segments.is_empty() {
        None
    } else {
        Some(RecordingFailureDiagnostics {
            version: 1,
            segments: segments.to_vec(),
        })
    }
}

fn write_recording_failure_diagnostics(
    recording_dir: &Path,
    diagnostics: &RecordingFailureDiagnostics,
) -> Result<(), RecordingError> {
    std::fs::write(
        recording_dir.join("recording-diagnostics.json"),
        serde_json::to_string_pretty(diagnostics)?,
    )?;
    Ok(())
}

impl Pipeline {
    pub async fn stop(mut self) -> anyhow::Result<FinishedPipeline> {
        let (microphone, camera, system_audio) = futures::join!(
            OptionFuture::from(self.microphone.map(|s| s.stop())),
            OptionFuture::from(self.camera.map(|s| s.stop())),
            OptionFuture::from(self.system_audio.map(|s| s.stop()))
        );

        let screen = self.screen.stop().await;

        if let Some(cursor) = self.cursor.as_mut() {
            cursor.actor.stop();
        }

        if let Some(watcher_task) = self.watcher_task.take()
            && let Err(error) = watcher_task.await
        {
            warn!(error = %error, "Studio recording watcher task ended unexpectedly");
        }

        Ok(FinishedPipeline {
            start_time: self.start_time,
            screen: screen.context("display")?,
            microphone: finalize_optional_track(
                RecordingTrackKind::Microphone,
                microphone.transpose(),
                &self.track_failures,
            ),
            camera: finalize_optional_track(
                RecordingTrackKind::Camera,
                camera.transpose(),
                &self.track_failures,
            ),
            system_audio: finalize_optional_track(
                RecordingTrackKind::SystemAudio,
                system_audio.transpose(),
                &self.track_failures,
            ),
            cursor: self.cursor,
            track_failures: take_track_failures(&self.track_failures),
        })
    }

    fn spawn_watcher(
        &mut self,
        completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    ) {
        let mut futures = FuturesUnordered::<
            Pin<
                Box<
                    dyn futures::Future<
                            Output = (RecordingTrackKind, bool, Result<(), PipelineDoneError>),
                        > + Send,
                >,
            >,
        >::new();
        futures.push(Box::pin({
            let done_fut = self.screen.done_fut();
            async move { (RecordingTrackKind::Display, true, done_fut.await) }
        }));

        if let Some(ref microphone) = self.microphone {
            futures.push(Box::pin({
                let done_fut = microphone.done_fut();
                async move { (RecordingTrackKind::Microphone, false, done_fut.await) }
            }));
        }

        if let Some(ref camera) = self.camera {
            futures.push(Box::pin({
                let done_fut = camera.done_fut();
                async move { (RecordingTrackKind::Camera, false, done_fut.await) }
            }));
        }

        if let Some(ref system_audio) = self.system_audio {
            futures.push(Box::pin({
                let done_fut = system_audio.done_fut();
                async move { (RecordingTrackKind::SystemAudio, false, done_fut.await) }
            }));
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

        let track_failures = self.track_failures.clone();
        self.watcher_task = Some(tokio::spawn(async move {
            while let Some((track, required, res)) = futures.next().await {
                if let Err(err) = res {
                    if required {
                        if completion_tx.borrow().is_none() {
                            let _ = completion_tx.send(Some(Err(err)));
                        }
                    } else {
                        warn!(?track, error = %err, "Optional recording track failed during runtime");
                        record_track_failure(
                            &track_failures,
                            track,
                            TrackFailureStage::Runtime,
                            err.to_string(),
                        );
                    }
                }
            }
        }));
    }
}

struct CursorPipeline {
    output_path: Option<PathBuf>,
    keyboard_output_path: Option<PathBuf>,
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
    keyboard_capture: bool,
    fragmented: bool,
    use_oop_muxer: bool,
    max_fps: u32,
    quality: crate::StudioQuality,
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
            keyboard_capture: true,
            fragmented: true,
            use_oop_muxer: false,
            max_fps: 60,
            quality: crate::StudioQuality::Balanced,
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

    pub fn with_keyboard_capture(mut self, keyboard_capture: bool) -> Self {
        self.keyboard_capture = keyboard_capture;
        self
    }

    pub fn with_fragmented(mut self, fragmented: bool) -> Self {
        self.fragmented = fragmented;
        self
    }

    pub fn with_out_of_process_muxer(mut self, use_oop_muxer: bool) -> Self {
        self.use_oop_muxer = use_oop_muxer;
        self
    }

    pub fn with_max_fps(mut self, max_fps: u32) -> Self {
        self.max_fps = max_fps.clamp(1, 120);
        self
    }

    pub fn with_quality(mut self, quality: crate::StudioQuality) -> Self {
        self.quality = quality;
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
            self.keyboard_capture,
            self.fragmented,
            self.use_oop_muxer,
            self.max_fps,
            self.quality,
        )
        .await
    }
}

#[tracing::instrument("studio_recording", skip_all)]
#[allow(clippy::too_many_arguments)]
async fn spawn_studio_recording_actor(
    recording_dir: PathBuf,
    base_inputs: RecordingBaseInputs,
    custom_cursor_capture: bool,
    keyboard_capture: bool,
    fragmented: bool,
    use_oop_muxer: bool,
    max_fps: u32,
    quality: crate::StudioQuality,
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
        keyboard_capture,
        fragmented,
        use_oop_muxer,
        max_fps,
        quality,
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
    use cap_timestamp::{AUDIO_OUTPUT_FRAMES, DEFAULT_SAMPLE_RATE};

    const DEFAULT_FPS: u32 = 30;

    const CROSS_TRACK_SNAP_SECS: f64 = AUDIO_OUTPUT_FRAMES as f64 / DEFAULT_SAMPLE_RATE as f64;

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

    let segment_outputs: Vec<_> = segments
        .into_iter()
        .enumerate()
        .map(|(segment_index, s)| {
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
                    if sync_offset.abs() > CROSS_TRACK_SNAP_SECS {
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
                if sync_offset.abs() > CROSS_TRACK_SNAP_SECS {
                    cam_start
                } else {
                    raw_display_start
                }
            } else if let Some(mic_start) = mic_start_time {
                let sync_offset = raw_display_start - mic_start;
                if sync_offset.abs() > CROSS_TRACK_SNAP_SECS {
                    mic_start
                } else {
                    raw_display_start
                }
            } else {
                raw_display_start
            };

            let diagnostics =
                (!s.pipeline.track_failures.is_empty()).then(|| SegmentFailureDiagnostics {
                    segment_index: segment_index as u32,
                    start: s.start,
                    end: s.end,
                    track_failures: s.pipeline.track_failures.clone(),
                });

            SegmentOutput {
                meta: MultipleSegment {
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
                            if sync_offset.abs() > CROSS_TRACK_SNAP_SECS {
                                mic_start
                            } else {
                                raw_sys_start
                            }
                        } else {
                            let sync_offset = raw_sys_start - display_start_time;
                            if sync_offset.abs() > CROSS_TRACK_SNAP_SECS {
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
                        .and_then(|cursor| cursor.output_path.as_ref().map(make_relative)),
                    keyboard: s.pipeline.cursor.as_ref().and_then(|cursor| {
                        cursor
                            .keyboard_output_path
                            .as_ref()
                            .filter(|path| path.exists())
                            .map(make_relative)
                    }),
                },
                diagnostics,
            }
        })
        .collect();
    let segment_failure_diagnostics: Vec<_> = segment_outputs
        .iter()
        .filter_map(|segment| segment.diagnostics.clone())
        .collect();
    let segment_metas: Vec<_> = segment_outputs
        .into_iter()
        .map(|segment| segment.meta)
        .collect();

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

    persist_final_recording_meta(&recording_dir, &meta);

    let project_config = cap_project::ProjectConfiguration::default();
    project_config
        .write(&recording_dir)
        .map_err(RecordingError::from)?;

    if let Some(diagnostics) = build_recording_failure_diagnostics(&segment_failure_diagnostics)
        && let Err(error) = write_recording_failure_diagnostics(&recording_dir, &diagnostics)
    {
        warn!(
            error = %error,
            path = %recording_dir.join("recording-diagnostics.json").display(),
            "Failed to persist recording diagnostics sidecar"
        );
    }

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
    keyboard_capture: bool,
    fragmented: bool,
    use_oop_muxer: bool,
    max_fps: u32,
    quality: crate::StudioQuality,
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
        keyboard_capture: bool,
        fragmented: bool,
        use_oop_muxer: bool,
        max_fps: u32,
        quality: crate::StudioQuality,
        completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    ) -> Self {
        Self {
            segments_dir,
            cursors_dir,
            base_inputs,
            custom_cursor_capture,
            keyboard_capture,
            fragmented,
            use_oop_muxer,
            max_fps,
            quality,
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
        let mut pipeline = create_segment_pipeline(
            &self.segments_dir,
            &self.cursors_dir,
            self.index,
            self.base_inputs.clone(),
            cursors,
            next_cursors_id,
            self.custom_cursor_capture,
            self.keyboard_capture,
            self.fragmented,
            self.use_oop_muxer,
            self.max_fps,
            self.quality,
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
    keyboard_capture: bool,
    fragmented: bool,
    use_oop_muxer: bool,
    max_fps: u32,
    quality: crate::StudioQuality,
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
            use_oop_muxer,
            shared_pause_state.clone(),
            output_size,
            quality,
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
        (custom_cursor_capture || keyboard_capture)
            .then(move || {
                let cursor_crop_bounds = base_inputs
                    .capture_target
                    .cursor_crop()
                    .ok_or(CreateSegmentPipelineError::NoBounds)?;

                let cursor_output_path = dir.join("cursor.json");
                let keyboard_output_path = dir.join(cap_project::KEYBOARD_EVENTS_FILE_NAME);
                let incremental_output = if fragmented && custom_cursor_capture {
                    Some(cursor_output_path.clone())
                } else {
                    None
                };
                let keyboard_incremental_output = if fragmented && keyboard_capture {
                    Some(keyboard_output_path.clone())
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
                    IncrementalCaptureOutputs {
                        cursor: incremental_output,
                        keyboard: keyboard_incremental_output,
                    },
                );

                Ok::<_, CreateSegmentPipelineError>(CursorPipeline {
                    output_path: custom_cursor_capture.then_some(cursor_output_path),
                    keyboard_output_path: keyboard_capture.then_some(keyboard_output_path),
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
        track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
        watcher_task: None,
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

fn persist_final_recording_meta(recording_dir: &Path, studio_meta: &StudioRecordingMeta) {
    use chrono::Local;

    let pretty_name = Local::now().format("Cap %Y-%m-%d at %H.%M.%S").to_string();
    let recording_meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.to_path_buf(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(studio_meta.clone())),
        upload: None,
    };

    if let Err(err) = recording_meta.save_for_project() {
        warn!(
            error = ?err,
            path = %recording_dir.join("recording-meta.json").display(),
            "Failed to persist final recording meta; downstream consumers may see in-progress state"
        );
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output_pipeline::{
        AudioMuxer, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
        ChannelVideoSourceConfig, Muxer, TaskPool, VideoFrame, VideoMuxer,
    };

    fn test_finished_output_pipeline() -> FinishedOutputPipeline {
        let timestamps = Timestamps::now();
        test_finished_output_pipeline_at(
            PathBuf::from("track.mp4"),
            Timestamp::Instant(timestamps.instant()),
            None,
            1,
        )
    }

    fn test_finished_output_pipeline_at(
        path: PathBuf,
        first_timestamp: Timestamp,
        video_info: Option<VideoInfo>,
        video_frame_count: u64,
    ) -> FinishedOutputPipeline {
        FinishedOutputPipeline {
            path,
            first_timestamp,
            video_info,
            video_frame_count,
        }
    }

    #[derive(Clone, Copy)]
    struct TestVideoFrame {
        timestamp: Timestamp,
    }

    impl VideoFrame for TestVideoFrame {
        fn timestamp(&self) -> Timestamp {
            self.timestamp
        }
    }

    struct SuccessfulVideoMuxer;

    impl Muxer for SuccessfulVideoMuxer {
        type Config = ();

        async fn setup(
            _config: Self::Config,
            _output_path: PathBuf,
            _video_config: Option<VideoInfo>,
            _audio_config: Option<cap_media_info::AudioInfo>,
            _pause_flag: Arc<std::sync::atomic::AtomicBool>,
            _tasks: &mut TaskPool,
        ) -> anyhow::Result<Self>
        where
            Self: Sized,
        {
            Ok(Self)
        }

        fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(Ok(()))
        }
    }

    impl AudioMuxer for SuccessfulVideoMuxer {
        fn send_audio_frame(
            &mut self,
            _frame: crate::output_pipeline::AudioFrame,
            _timestamp: Duration,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    impl VideoMuxer for SuccessfulVideoMuxer {
        type VideoFrame = TestVideoFrame;

        fn send_video_frame(
            &mut self,
            _frame: Self::VideoFrame,
            _timestamp: Duration,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct FailingAudioMuxerConfig {
        fail_after_frame: u64,
    }

    struct FailingAudioMuxer {
        fail_after_frame: u64,
        sent_frames: u64,
    }

    impl Muxer for FailingAudioMuxer {
        type Config = FailingAudioMuxerConfig;

        async fn setup(
            config: Self::Config,
            _output_path: PathBuf,
            _video_config: Option<VideoInfo>,
            _audio_config: Option<cap_media_info::AudioInfo>,
            _pause_flag: Arc<std::sync::atomic::AtomicBool>,
            _tasks: &mut TaskPool,
        ) -> anyhow::Result<Self>
        where
            Self: Sized,
        {
            Ok(Self {
                fail_after_frame: config.fail_after_frame,
                sent_frames: 0,
            })
        }

        fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(Ok(()))
        }
    }

    impl AudioMuxer for FailingAudioMuxer {
        fn send_audio_frame(
            &mut self,
            _frame: crate::output_pipeline::AudioFrame,
            _timestamp: Duration,
        ) -> anyhow::Result<()> {
            self.sent_frames += 1;
            if self.sent_frames >= self.fail_after_frame {
                return Err(anyhow!("optional audio mux send failed"));
            }
            Ok(())
        }
    }

    fn test_video_info() -> VideoInfo {
        VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 16, 16, 30)
    }

    fn test_audio_info() -> cap_media_info::AudioInfo {
        cap_media_info::AudioInfo::new_raw(
            cap_media_info::Sample::F32(cap_media_info::Type::Packed),
            48_000,
            2,
        )
    }

    #[test]
    fn finalize_optional_track_records_stop_failure() {
        let failures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = finalize_optional_track(
            RecordingTrackKind::Camera,
            Err(anyhow!("camera stop failed")),
            &failures,
        );

        assert!(output.is_none());

        let recorded = take_track_failures(&failures);
        assert_eq!(
            recorded,
            vec![TrackFailureRecord {
                track: RecordingTrackKind::Camera,
                stage: TrackFailureStage::Stop,
                error: "camera stop failed".to_string(),
            }]
        );
    }

    #[test]
    fn finalize_optional_track_preserves_successful_track() {
        let failures = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = finalize_optional_track(
            RecordingTrackKind::Microphone,
            Ok(Some(test_finished_output_pipeline())),
            &failures,
        );

        assert!(output.is_some());
        assert!(take_track_failures(&failures).is_empty());
    }

    #[test]
    fn finalize_optional_track_does_not_duplicate_runtime_failure() {
        let failures = Arc::new(std::sync::Mutex::new(Vec::new()));
        record_track_failure(
            &failures,
            RecordingTrackKind::SystemAudio,
            TrackFailureStage::Runtime,
            "system audio writer failed",
        );

        let output = finalize_optional_track(
            RecordingTrackKind::SystemAudio,
            Err(anyhow!("system audio writer failed")),
            &failures,
        );

        assert!(output.is_none());
        assert_eq!(
            take_track_failures(&failures),
            vec![TrackFailureRecord {
                track: RecordingTrackKind::SystemAudio,
                stage: TrackFailureStage::Runtime,
                error: "system audio writer failed".to_string(),
            }]
        );
    }

    #[test]
    fn build_recording_failure_diagnostics_skips_clean_recordings() {
        assert!(build_recording_failure_diagnostics(&[]).is_none());
    }

    #[test]
    fn build_recording_failure_diagnostics_keeps_segment_failures() {
        let diagnostics = build_recording_failure_diagnostics(&[SegmentFailureDiagnostics {
            segment_index: 2,
            start: 10.0,
            end: 20.0,
            track_failures: vec![
                TrackFailureRecord {
                    track: RecordingTrackKind::Microphone,
                    stage: TrackFailureStage::Runtime,
                    error: "microphone writer failed".to_string(),
                },
                TrackFailureRecord {
                    track: RecordingTrackKind::SystemAudio,
                    stage: TrackFailureStage::Stop,
                    error: "system audio finalize failed".to_string(),
                },
            ],
        }]);

        assert_eq!(
            diagnostics,
            Some(RecordingFailureDiagnostics {
                version: 1,
                segments: vec![SegmentFailureDiagnostics {
                    segment_index: 2,
                    start: 10.0,
                    end: 20.0,
                    track_failures: vec![
                        TrackFailureRecord {
                            track: RecordingTrackKind::Microphone,
                            stage: TrackFailureStage::Runtime,
                            error: "microphone writer failed".to_string(),
                        },
                        TrackFailureRecord {
                            track: RecordingTrackKind::SystemAudio,
                            stage: TrackFailureStage::Stop,
                            error: "system audio finalize failed".to_string(),
                        },
                    ],
                }],
            })
        );
    }

    #[tokio::test]
    async fn stop_recording_keeps_success_when_diagnostics_sidecar_write_fails() {
        let temp_dir = tempfile::tempdir().expect("temp dir should be created");
        let recording_dir = temp_dir.path().join("recording");
        let start_time = Timestamps::now();
        std::fs::create_dir_all(recording_dir.join("content"))
            .expect("recording content dir should be created");
        std::fs::create_dir_all(recording_dir.join("recording-diagnostics.json"))
            .expect("diagnostics path should be pre-created as a directory");

        let segment = RecordingSegment {
            start: 0.0,
            end: 1.0,
            pipeline: FinishedPipeline {
                start_time,
                screen: test_finished_output_pipeline_at(
                    recording_dir.join("content/display.mp4"),
                    Timestamp::Instant(start_time.instant() + Duration::from_millis(33)),
                    Some(test_video_info()),
                    1,
                ),
                microphone: None,
                camera: None,
                system_audio: None,
                cursor: None,
                track_failures: vec![TrackFailureRecord {
                    track: RecordingTrackKind::Microphone,
                    stage: TrackFailureStage::Runtime,
                    error: "microphone runtime failure".to_string(),
                }],
            },
            camera_device_id: None,
            mic_device_id: None,
        };

        let completed = stop_recording(
            recording_dir.clone(),
            vec![segment],
            Default::default(),
            false,
        )
        .await
        .expect("diagnostics sidecar failure should not abort stop_recording");

        assert_eq!(completed.project_path, recording_dir);
        assert!(
            completed.project_path.join("project-config.json").is_file(),
            "project config should still be written"
        );
        assert!(
            completed
                .project_path
                .join("recording-diagnostics.json")
                .is_dir(),
            "the pre-existing diagnostics directory should remain, proving the sidecar write failed"
        );
    }

    #[tokio::test]
    async fn stop_preserves_display_when_optional_track_fails_during_runtime() {
        let temp_dir = tempfile::tempdir().expect("temp dir should be created");
        let timestamps = Timestamps::now();
        let (screen_tx, screen_rx) = flume::bounded(4);
        let (completion_tx, completion_rx) = watch::channel(None);
        let (mut microphone_tx, microphone_rx) = futures::channel::mpsc::channel(4);

        let screen = OutputPipeline::builder(temp_dir.path().join("display.mp4"))
            .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                test_video_info(),
                screen_rx,
            ))
            .with_timestamps(timestamps)
            .build::<SuccessfulVideoMuxer>(())
            .await
            .expect("display pipeline should build");

        let microphone = OutputPipeline::builder(temp_dir.path().join("audio-input.ogg"))
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                test_audio_info(),
                microphone_rx,
            ))
            .with_timestamps(timestamps)
            .build::<FailingAudioMuxer>(FailingAudioMuxerConfig {
                fail_after_frame: 1,
            })
            .await
            .expect("microphone pipeline should build");
        let microphone_done = microphone.done_fut();

        let mut pipeline = Pipeline {
            start_time: timestamps,
            screen,
            microphone: Some(microphone),
            camera: None,
            system_audio: None,
            cursor: None,
            track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
            watcher_task: None,
        };
        pipeline.spawn_watcher(completion_tx);

        screen_tx
            .send_async(TestVideoFrame {
                timestamp: Timestamp::Instant(timestamps.instant() + Duration::from_millis(33)),
            })
            .await
            .expect("display frame should send");
        drop(screen_tx);

        microphone_tx
            .try_send(crate::output_pipeline::AudioFrame::new(
                test_audio_info().empty_frame(960),
                Timestamp::Instant(timestamps.instant() + Duration::from_millis(20)),
            ))
            .expect("microphone frame should send");
        drop(microphone_tx);

        let microphone_error = microphone_done
            .await
            .expect_err("optional microphone pipeline should fail at runtime");
        assert!(
            microphone_error
                .to_string()
                .contains("Audio muxer stopped accepting frames at frame 1"),
            "runtime error should retain the mux send-failure context"
        );

        let finished = pipeline
            .stop()
            .await
            .expect("display success should still allow the recording to stop cleanly");

        assert_eq!(
            finished.screen.video_frame_count, 1,
            "display output should be preserved"
        );
        assert!(
            finished.microphone.is_none(),
            "optional microphone output should be dropped after runtime failure"
        );
        assert_eq!(
            finished.track_failures.len(),
            1,
            "runtime failure should be recorded exactly once"
        );
        assert!(
            completion_rx.borrow().is_none(),
            "optional runtime failure should not publish a required-track completion error"
        );
        assert_eq!(
            finished.track_failures[0].track,
            RecordingTrackKind::Microphone
        );
        assert_eq!(finished.track_failures[0].stage, TrackFailureStage::Runtime);
        assert!(
            finished.track_failures[0]
                .error
                .contains("Audio muxer stopped accepting frames at frame 1"),
            "recorded runtime failure should preserve the mux send-failure context"
        );
    }
}
