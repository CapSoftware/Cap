#[cfg(target_os = "macos")]
use crate::SendableShareableContent;
#[cfg(target_os = "linux")]
mod linux_camera;
#[cfg(target_os = "linux")]
pub use linux_camera::{
    LINUX_CAMERA_MAX_MASK_AGE, LinuxCameraBlur, LinuxCameraEffect, LinuxCameraMaskReceipt,
    LinuxCameraPresentation, LinuxCameraPresentationError, LinuxCameraProcessing,
    LinuxCameraPublisher, LinuxCameraRect, LinuxCameraShape, LinuxProcessedCameraFrame,
    LinuxProcessedCameraSource,
};

use crate::{
    RecordingBaseInputs,
    capture_pipeline::{
        MakeCapturePipeline, ScreenCaptureMethod, Stop, target_to_display_and_crop,
    },
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::{self, OutputPipeline},
    resolution_limits::ensure_even,
    sources::screen_capture::{ScreenCaptureConfig, ScreenCaptureTarget},
};
use anyhow::Context as _;
use cap_media_info::VideoInfo;
use cap_project::InstantRecordingMeta;
use cap_timestamp::Timestamps;
use cap_utils::ensure_dir;
#[cfg(target_os = "linux")]
use futures::FutureExt as _;
use kameo::{Actor as _, prelude::*};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tracing::*;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Joined covers this attempt's capture/output work, not shared preview feeds or physical device shutdown.
pub enum InstantQuiescence {
    Pending,
    Joined,
    Unconfirmed,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct InstantLifecycle(Arc<InstantLifecycleInner>);

#[cfg(target_os = "linux")]
struct InstantLifecycleInner {
    scope: output_pipeline::PipelineBuildScope,
    state: tokio::sync::watch::Sender<InstantQuiescence>,
    completion: tokio::sync::watch::Sender<Option<Result<(), output_pipeline::PipelineDoneError>>>,
    error: std::sync::Mutex<Option<String>>,
    runtime: std::sync::Mutex<Option<tokio::runtime::Handle>>,
}

#[cfg(target_os = "linux")]
impl InstantLifecycle {
    fn new() -> Self {
        let (state, _) = tokio::sync::watch::channel(InstantQuiescence::Pending);
        let (completion, _) = tokio::sync::watch::channel(None);
        Self(Arc::new(InstantLifecycleInner {
            scope: output_pipeline::PipelineBuildScope::new_lifetime(),
            state,
            completion,
            error: std::sync::Mutex::new(None),
            runtime: std::sync::Mutex::new(None),
        }))
    }

    /// Cancellation requests shutdown; callers must still await quiescence before revealing or deleting.
    pub fn cancel(&self) {
        self.0.scope.cancel();
        if let Some(report) = self.0.scope.idle_report() {
            self.publish_quiescence(report.quiescent);
        }
    }

    fn publish_quiescence(&self, quiescent: bool) {
        self.0.state.send_if_modified(|state| {
            if *state == InstantQuiescence::Unconfirmed {
                return false;
            }
            let next = if quiescent {
                InstantQuiescence::Joined
            } else {
                InstantQuiescence::Unconfirmed
            };
            let changed = *state != next;
            *state = next;
            changed
        });
    }

    pub fn quiescence(&self) -> InstantQuiescence {
        *self.0.state.borrow()
    }

    pub async fn wait_for_quiescence(&self) -> InstantQuiescence {
        let mut state = self.0.state.subscribe();
        loop {
            let value = *state.borrow_and_update();
            if value != InstantQuiescence::Pending {
                return value;
            }
            if state.changed().await.is_err() {
                return InstantQuiescence::Unconfirmed;
            }
        }
    }

    fn done_fut(&self) -> output_pipeline::DoneFut {
        let mut completion = self.0.completion.subscribe();
        async move {
            loop {
                if let Some(result) = completion.borrow_and_update().clone() {
                    return result;
                }
                if completion.changed().await.is_err() {
                    return Err(output_pipeline::PipelineDoneError::from_message(
                        "Instant completion acknowledgement was lost".into(),
                    ));
                }
            }
        }
        .boxed()
        .shared()
    }

    fn complete(
        &self,
        report: output_pipeline::PipelineJoinReport,
        error: Option<String>,
    ) -> anyhow::Result<()> {
        self.publish_quiescence(report.quiescent);
        let quiescent = self.quiescence() == InstantQuiescence::Joined;
        let mut stored = self.0.error.lock().unwrap();
        if stored.is_none() {
            *stored = error.or(report.error).or_else(|| {
                (!quiescent).then(|| "Instant capture quiescence is unconfirmed".into())
            });
        }
        let result = stored.as_ref().map_or(Ok(()), |error| {
            Err(output_pipeline::PipelineDoneError::from_message(
                error.clone(),
            ))
        });
        self.0.completion.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(result.clone());
                true
            } else {
                false
            }
        });
        result.map_err(anyhow::Error::from)
    }

    fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        let runtime = self
            .0
            .runtime
            .lock()
            .unwrap()
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok());
        if let Some(runtime) = runtime {
            drop(runtime.spawn(future));
        } else if self.quiescence() == InstantQuiescence::Pending {
            self.0.state.send_replace(InstantQuiescence::Unconfirmed);
            self.0
                .error
                .lock()
                .unwrap()
                .get_or_insert_with(|| "Capture cleanup runtime is unavailable".into());
        }
    }
}

#[cfg(target_os = "linux")]
struct InstantLifetimeOwner {
    lifecycle: InstantLifecycle,
    armed: bool,
}

#[cfg(target_os = "linux")]
impl InstantLifetimeOwner {
    fn new() -> Self {
        Self {
            lifecycle: InstantLifecycle::new(),
            armed: true,
        }
    }

    async fn failed(mut self, error: String) -> InstantQuiescence {
        let report = self.lifecycle.0.scope.cancel_and_join_report().await;
        let _ = self.lifecycle.complete(report, Some(error));
        self.armed = false;
        self.lifecycle.quiescence()
    }
}

#[cfg(target_os = "linux")]
struct CleanupAcknowledgement {
    lifecycle: InstantLifecycle,
    armed: bool,
}

#[cfg(target_os = "linux")]
impl Drop for CleanupAcknowledgement {
    fn drop(&mut self) {
        if self.armed && self.lifecycle.quiescence() == InstantQuiescence::Pending {
            self.lifecycle
                .0
                .state
                .send_replace(InstantQuiescence::Unconfirmed);
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for InstantLifetimeOwner {
    fn drop(&mut self) {
        if !self.armed || self.lifecycle.quiescence() != InstantQuiescence::Pending {
            return;
        }
        self.lifecycle.0.scope.cancel();
        let message = "Instant recording owner dropped before shutdown acknowledgement".to_string();
        if let Some(report) = self.lifecycle.0.scope.idle_report() {
            let _ = self.lifecycle.complete(report, Some(message));
            return;
        }
        let lifecycle = self.lifecycle.clone();
        let guard = CleanupAcknowledgement {
            lifecycle: lifecycle.clone(),
            armed: true,
        };
        self.lifecycle.spawn(async move {
            let mut guard = guard;
            let report = lifecycle.0.scope.cancel_and_join_report().await;
            let _ = lifecycle.complete(report, Some(message));
            guard.armed = false;
        });
    }
}

#[cfg(target_os = "linux")]
struct BuildWaiter {
    lifecycle: InstantLifecycle,
    armed: bool,
}

#[cfg(target_os = "linux")]
impl Drop for BuildWaiter {
    fn drop(&mut self) {
        if self.armed {
            self.lifecycle.cancel();
        }
    }
}

struct Pipeline {
    video: OutputPipeline,
    audio: Option<OutputPipeline>,
    video_info: VideoInfo,
    segments_dir: PathBuf,
    segment_rx:
        Option<std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>>,
}

enum ActorState {
    Recording {
        pipeline: Pipeline,
        // pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
    Paused {
        pipeline: Pipeline,
        // pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
    Stopped,
}

pub struct ActorHandle {
    #[cfg(target_os = "linux")]
    lifecycle: InstantLifecycle,
    actor_ref: kameo::actor::ActorRef<Actor>,
    pub capture_target: ScreenCaptureTarget,
    done_fut: output_pipeline::DoneFut,
    health_rx: Option<output_pipeline::HealthReceiver>,
    segment_rx: Option<
        std::sync::Mutex<
            Option<
                std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>,
            >,
        >,
    >,
}

impl ActorHandle {
    #[cfg(target_os = "linux")]
    pub fn lifecycle(&self) -> InstantLifecycle {
        self.lifecycle.clone()
    }

    pub async fn stop(&self) -> anyhow::Result<CompletedRecording> {
        Ok(self.actor_ref.ask(Stop).await?)
    }

    pub fn done_fut(&self) -> output_pipeline::DoneFut {
        self.done_fut.clone()
    }

    pub fn take_health_rx(&mut self) -> Option<output_pipeline::HealthReceiver> {
        self.health_rx.take()
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

    pub async fn is_paused(&self) -> anyhow::Result<bool> {
        Ok(self.actor_ref.ask(IsPaused).await?)
    }

    pub fn take_segment_rx(
        &self,
    ) -> Option<std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>>
    {
        self.segment_rx
            .as_ref()
            .and_then(|m| m.lock().ok().and_then(|mut guard| guard.take()))
    }
}

impl Drop for ActorHandle {
    fn drop(&mut self) {
        let actor_ref = self.actor_ref.clone();
        #[cfg(target_os = "linux")]
        {
            if self.lifecycle.quiescence() == InstantQuiescence::Joined {
                return;
            }
            if self.lifecycle.quiescence() == InstantQuiescence::Pending {
                self.lifecycle
                    .0
                    .scope
                    .fail_required("Instant handle dropped before shutdown acknowledgement".into());
            }
            self.lifecycle.cancel();
            self.lifecycle.spawn(async move {
                let _ = actor_ref.ask(Cancel).await;
            });
        }
        #[cfg(not(target_os = "linux"))]
        tokio::spawn(async move {
            let _ = actor_ref.tell(Stop).await;
        });
    }
}

#[derive(kameo::Actor)]
pub struct Actor {
    recording_dir: PathBuf,
    output_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
    video_info: VideoInfo,
    state: ActorState,
    total_pause_duration: std::time::Duration,
    pause_started_at: Option<f64>,
    terminal_stop_error: Option<String>,
    #[cfg(target_os = "linux")]
    lifetime: InstantLifetimeOwner,
}

impl Actor {
    #[cfg(target_os = "linux")]
    async fn stop(&mut self) -> anyhow::Result<()> {
        self.lifetime.lifecycle.0.scope.cancel();
        let pipeline = std::mem::replace(&mut self.state, ActorState::Stopped);
        let mut errors = Vec::new();
        if let ActorState::Recording { pipeline, .. } | ActorState::Paused { pipeline, .. } =
            pipeline
        {
            let video = pipeline.video.stop();
            let audio = async {
                match pipeline.audio {
                    Some(audio) => audio.stop().await.map(|_| ()),
                    None => Ok(()),
                }
            };
            let (video, audio) = tokio::join!(video, audio);
            if let Err(error) = video {
                errors.push(format!("Video pipeline: {error:#}"));
            }
            if let Err(error) = audio {
                errors.push(format!("Audio pipeline: {error:#}"));
            }
        }
        let report = self
            .lifetime
            .lifecycle
            .0
            .scope
            .cancel_and_join_report()
            .await;
        if let Some(error) = &report.error {
            errors.push(error.clone());
        }
        let result = if errors.is_empty() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(errors.join("; ")))
        };
        let result = preserve_terminal_stop_error(&mut self.terminal_stop_error, result);
        let lifecycle_result = self
            .lifetime
            .lifecycle
            .complete(report, self.terminal_stop_error.clone());
        result.and(lifecycle_result)
    }

    #[cfg(not(target_os = "linux"))]
    async fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(error) = &self.terminal_stop_error {
            return Err(anyhow::anyhow!(error.clone()));
        }
        let pipeline = replace_with::replace_with_or_abort_and_return(&mut self.state, |state| {
            (
                match state {
                    ActorState::Recording { pipeline, .. } => Some(pipeline),
                    ActorState::Paused { pipeline, .. } => Some(pipeline),
                    _ => None,
                },
                ActorState::Stopped,
            )
        });

        let result = async {
            if let Some(pipeline) = pipeline {
                if let Some(audio) = pipeline.audio {
                    let (audio_res, video_res) = tokio::join!(audio.stop(), pipeline.video.stop());
                    video_res?;
                    audio_res?;
                } else {
                    pipeline.video.stop().await?;
                }
            }
            Ok(())
        }
        .await;
        preserve_terminal_stop_error(&mut self.terminal_stop_error, result)
    }
}

fn preserve_terminal_stop_error(
    stored: &mut Option<String>,
    result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    if let Some(error) = stored.as_ref() {
        return Err(anyhow::anyhow!(error.clone()));
    }
    if let Err(error) = &result {
        *stored = Some(format!("{error:#}"));
    }
    result
}

impl Message<Stop> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(&mut self, _: Stop, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if let Some(pause_start) = self.pause_started_at.take() {
            let pause_elapsed = current_time_f64() - pause_start;
            if pause_elapsed > 0.0 {
                self.total_pause_duration += std::time::Duration::from_secs_f64(pause_elapsed);
            }
        }

        let segments_dir =
            replace_with::replace_with_or_abort_and_return(&mut self.state, |state| {
                let result = match &state {
                    ActorState::Recording { pipeline, .. }
                    | ActorState::Paused { pipeline, .. } => pipeline.segments_dir.clone(),
                    ActorState::Stopped => self.output_dir.clone(),
                };
                (result, state)
            });

        self.stop().await?;

        let has_init = segments_dir.join("init.mp4").exists();
        let has_segments = has_init
            && match std::fs::read_dir(&segments_dir) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .any(|e| e.path().extension().is_some_and(|ext| ext == "m4s")),
                Err(e) => {
                    warn!(
                        path = %segments_dir.display(),
                        error = %e,
                        "Failed to read segments directory, treating as no segments"
                    );
                    false
                }
            };

        let has_output_mp4 = segments_dir.join("output.mp4").exists()
            && std::fs::metadata(segments_dir.join("output.mp4"))
                .map(|m| m.len() > 0)
                .unwrap_or(false);

        let health = if has_segments || has_output_mp4 {
            crate::RecordingHealth::Healthy
        } else if has_init {
            crate::RecordingHealth::Degraded {
                issues: vec!["Recording too short — no complete segments produced".to_string()],
            }
        } else {
            crate::RecordingHealth::Damaged {
                reason: "No video segments produced".to_string(),
            }
        };

        Ok(CompletedRecording {
            project_path: self.recording_dir.clone(),
            meta: InstantRecordingMeta::Complete {
                fps: self.video_info.fps(),
                sample_rate: None,
            },
            display_source: self.capture_target.clone(),
            health,
        })
    }
}

pub struct Pause;

impl Message<Pause> for Actor {
    type Reply = ();

    async fn handle(&mut self, _: Pause, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.pause_started_at = Some(current_time_f64());
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Recording {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.video.pause();
                if let Some(ref audio) = pipeline.audio {
                    audio.pause();
                }
                return ActorState::Paused {
                    pipeline,
                    segment_start_time,
                };
            }

            state
        });
    }
}

pub struct Resume;

impl Message<Resume> for Actor {
    type Reply = ();

    async fn handle(&mut self, _: Resume, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if let Some(pause_start) = self.pause_started_at.take() {
            let pause_elapsed = current_time_f64() - pause_start;
            if pause_elapsed > 0.0 {
                self.total_pause_duration += std::time::Duration::from_secs_f64(pause_elapsed);
            }
        }
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Paused {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.video.resume();
                if let Some(ref audio) = pipeline.audio {
                    audio.resume();
                }
                return ActorState::Recording {
                    pipeline,
                    segment_start_time,
                };
            }

            state
        });
    }
}

pub struct Cancel;

impl Message<Cancel> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Cancel, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.stop().await
    }
}

pub struct IsPaused;

impl Message<IsPaused> for Actor {
    type Reply = bool;

    async fn handle(&mut self, _: IsPaused, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        matches!(self.state, ActorState::Paused { .. })
    }
}

#[derive(Debug)]
pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
    pub health: crate::RecordingHealth,
}

struct ScreenPipelineInput {
    source: crate::sources::screen_capture::VideoSourceConfig,
    info: VideoInfo,
    #[cfg(target_os = "linux")]
    prepared_camera: Option<linux_camera::PreparedCamera>,
}

async fn create_pipeline(
    content_dir: PathBuf,
    screen: ScreenPipelineInput,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    system_audio_source: Option<crate::sources::screen_capture::SystemAudioSourceConfig>,
    max_output_size: Option<u32>,
    start_time: Timestamps,
) -> anyhow::Result<Pipeline> {
    let ScreenPipelineInput {
        source: screen_capture,
        info: screen_info,
        #[cfg(target_os = "linux")]
        prepared_camera,
    } = screen;
    let output_resolution = max_output_size
        .map(|max_output_size| {
            clamp_size(
                (screen_info.width, screen_info.height),
                (
                    max_output_size,
                    (max_output_size as f64 / 16.0 * 9.0) as u32,
                ),
            )
        })
        .unwrap_or_else(|| {
            (
                ensure_even(screen_info.width),
                ensure_even(screen_info.height),
            )
        });

    let segments_dir = content_dir.join("display");

    let segment_channel = {
        let (tx, rx) =
            std::sync::mpsc::channel::<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>();
        Some((tx, rx))
    };

    let segment_tx_for_video = segment_channel.as_ref().map(|(tx, _)| tx.clone());

    #[cfg(not(target_os = "linux"))]
    let video = ScreenCaptureMethod::make_instant_segmented_video_pipeline(
        screen_capture,
        segments_dir.clone(),
        output_resolution,
        start_time,
        segment_tx_for_video,
    )
    .await?;

    #[cfg(target_os = "linux")]
    let video = if let Some(camera) = prepared_camera {
        OutputPipeline::builder(segments_dir.clone())
            .with_video::<linux_camera::CameraCompositeSource>(linux_camera::Config {
                screen_capture,
                camera,
            })
            .with_timestamps(start_time)
            .build::<crate::ffmpeg::SegmentedVideoMuxer>(crate::ffmpeg::SegmentedVideoMuxerConfig {
                segment_duration: std::time::Duration::from_secs(2),
                preset: cap_enc_ffmpeg::h264::H264Preset::Ultrafast,
                output_size: Some(output_resolution),
                shared_pause_state: None,
                segment_tx: segment_tx_for_video,
            })
            .await?
    } else {
        ScreenCaptureMethod::make_instant_segmented_video_pipeline(
            screen_capture,
            segments_dir.clone(),
            output_resolution,
            start_time,
            segment_tx_for_video,
        )
        .await?
    };

    let has_audio = mic_feed.is_some() || system_audio_source.is_some();
    let audio = if has_audio {
        let audio_dir = content_dir.join("audio");
        let mut builder =
            output_pipeline::OutputPipeline::builder(audio_dir.clone()).with_timestamps(start_time);
        #[cfg(target_os = "linux")]
        {
            builder = builder.with_audio_anchor(output_pipeline::AudioAnchor::PipelineEpoch);
        }

        if let Some(sys_audio) = system_audio_source {
            builder = builder
                .with_audio_source::<crate::sources::screen_capture::SystemAudioSource>(sys_audio);
        }

        if let Some(mic) = mic_feed {
            builder = builder.with_audio_source::<crate::sources::Microphone>(mic);
        }

        let segment_tx_for_audio = segment_channel.as_ref().map(|(tx, _)| tx.clone());

        let audio_pipeline = builder
            .build::<output_pipeline::DashSegmentedAudioMuxer>(
                output_pipeline::DashSegmentedAudioMuxerConfig {
                    shared_pause_state: None,
                    segment_tx: segment_tx_for_audio,
                    ..Default::default()
                },
            )
            .await
            .context("audio pipeline setup")?;

        Some(audio_pipeline)
    } else {
        None
    };

    let segment_rx = segment_channel.map(|(_, rx)| rx);

    Ok(Pipeline {
        video,
        audio,
        video_info: VideoInfo::from_raw_ffmpeg(
            screen_info.pixel_format,
            output_resolution.0,
            output_resolution.1,
            screen_info.fps(),
        ),
        segments_dir,
        segment_rx,
    })
}

impl Actor {
    pub fn builder(output: PathBuf, capture_target: ScreenCaptureTarget) -> ActorBuilder {
        ActorBuilder::new(output, capture_target)
    }
}

pub struct ActorBuilder {
    output_path: PathBuf,
    capture_target: ScreenCaptureTarget,
    system_audio: bool,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    camera_feed: Option<Arc<crate::feeds::camera::CameraFeedLock>>,
    #[cfg(target_os = "linux")]
    composite_camera: bool,
    #[cfg(target_os = "linux")]
    camera_presentation: Option<LinuxCameraPresentation>,
    #[cfg(target_os = "linux")]
    processed_camera: Option<LinuxProcessedCameraSource>,
    #[cfg(target_os = "linux")]
    camera_reference_size: Option<(u32, u32)>,
    max_output_size: Option<u32>,
    max_fps: u32,
    #[cfg(target_os = "macos")]
    excluded_windows: Vec<scap_targets::WindowId>,
    #[cfg(target_os = "linux")]
    lifetime: InstantLifetimeOwner,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            camera_feed: None,
            #[cfg(target_os = "linux")]
            composite_camera: false,
            #[cfg(target_os = "linux")]
            camera_presentation: None,
            #[cfg(target_os = "linux")]
            processed_camera: None,
            #[cfg(target_os = "linux")]
            camera_reference_size: None,
            max_output_size: None,
            max_fps: crate::defaults::DEFAULT_INSTANT_MODE_FPS,
            #[cfg(target_os = "linux")]
            lifetime: InstantLifetimeOwner::new(),
            #[cfg(target_os = "macos")]
            excluded_windows: Vec::new(),
        }
    }

    #[cfg(target_os = "linux")]
    pub fn lifecycle(&self) -> InstantLifecycle {
        self.lifetime.lifecycle.clone()
    }

    pub fn with_system_audio(mut self, system_audio: bool) -> Self {
        self.system_audio = system_audio;
        self
    }

    pub fn with_mic_feed(mut self, mic_feed: Arc<MicrophoneFeedLock>) -> Self {
        self.mic_feed = Some(mic_feed);
        self
    }

    pub fn with_camera_feed(
        mut self,
        camera_feed: Arc<crate::feeds::camera::CameraFeedLock>,
    ) -> Self {
        self.camera_feed = Some(camera_feed);
        self
    }

    pub fn with_max_output_size(mut self, max_output_size: u32) -> Self {
        self.max_output_size = Some(max_output_size);
        self
    }

    #[cfg(target_os = "linux")]
    pub fn with_linux_camera_composition(mut self) -> Self {
        self.composite_camera = true;
        self
    }

    #[cfg(target_os = "linux")]
    pub fn with_linux_camera_presentation(mut self, presentation: LinuxCameraPresentation) -> Self {
        self.composite_camera = true;
        self.camera_presentation = Some(presentation);
        self
    }

    #[cfg(target_os = "linux")]
    pub fn with_linux_processed_camera(
        mut self,
        source: LinuxProcessedCameraSource,
        presentation: LinuxCameraPresentation,
        reference_size: (u32, u32),
    ) -> Self {
        self.composite_camera = true;
        self.camera_presentation = Some(presentation);
        self.processed_camera = Some(source);
        self.camera_reference_size = Some(reference_size);
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
        spawn_instant_recording_actor_inner(
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
            self.max_output_size,
            self.max_fps,
            #[cfg(target_os = "linux")]
            LinuxCameraConfig {
                composite_camera: self.composite_camera,
                camera_presentation: self.camera_presentation,
                processed_camera: self.processed_camera,
                camera_reference_size: self.camera_reference_size,
            },
            #[cfg(target_os = "linux")]
            self.lifetime,
        )
        .await
    }
}

pub async fn spawn_instant_recording_actor(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
    max_output_size: Option<u32>,
    max_fps: u32,
) -> anyhow::Result<ActorHandle> {
    spawn_instant_recording_actor_inner(
        recording_dir,
        inputs,
        max_output_size,
        max_fps,
        #[cfg(target_os = "linux")]
        LinuxCameraConfig::default(),
        #[cfg(target_os = "linux")]
        InstantLifetimeOwner::new(),
    )
    .await
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct LinuxCameraConfig {
    composite_camera: bool,
    camera_presentation: Option<LinuxCameraPresentation>,
    processed_camera: Option<LinuxProcessedCameraSource>,
    camera_reference_size: Option<(u32, u32)>,
}

#[cfg(target_os = "linux")]
async fn run_owned_instant_build<T: Send + 'static>(
    mut owner: InstantLifetimeOwner,
    build: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<T> {
    let lifecycle = owner.lifecycle.clone();
    *lifecycle.0.runtime.lock().unwrap() = Some(tokio::runtime::Handle::current());
    let scope = lifecycle.0.scope.clone();
    let mut waiter = BuildWaiter {
        lifecycle: lifecycle.clone(),
        armed: true,
    };
    let startup = scope.task_completion();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    drop(tokio::spawn(async move {
        let cancel = scope.cancellation();
        let result = scope.run(async {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(anyhow::anyhow!("Instant recording startup cancelled")),
                result = std::panic::AssertUnwindSafe(build).catch_unwind() => {
                    result.unwrap_or_else(|_| Err(anyhow::anyhow!("Instant recording startup panicked")))
                }
            }
        }).await;
        drop(startup);
        let result = match result {
            Ok(value) if !cancel.is_cancelled() => {
                owner.armed = false;
                drop(owner);
                Ok(value)
            }
            result => {
                let message = match result {
                    Ok(value) => {
                        drop(value);
                        "Instant recording startup cancelled".to_string()
                    }
                    Err(error) => format!("{error:#}"),
                };
                let quiescence = owner.failed(message.clone()).await;
                Err(anyhow::anyhow!(
                    "{message}; capture cleanup: {quiescence:?}"
                ))
            }
        };
        let _ = sender.send(result);
    }));
    let result = receiver
        .await
        .context("Instant recording startup acknowledgement lost")?;
    waiter.armed = false;
    result
}

#[cfg(target_os = "linux")]
async fn spawn_instant_recording_actor_inner(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
    max_output_size: Option<u32>,
    max_fps: u32,
    camera: LinuxCameraConfig,
    owner: InstantLifetimeOwner,
) -> anyhow::Result<ActorHandle> {
    let lifecycle = owner.lifecycle.clone();
    run_owned_instant_build(
        owner,
        build_instant_recording_actor(
            recording_dir,
            inputs,
            max_output_size,
            max_fps,
            camera,
            lifecycle,
        ),
    )
    .await
}

#[cfg(not(target_os = "linux"))]
async fn spawn_instant_recording_actor_inner(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
    max_output_size: Option<u32>,
    max_fps: u32,
) -> anyhow::Result<ActorHandle> {
    let startup = build_instant_recording_actor(recording_dir, inputs, max_output_size, max_fps);
    #[cfg(windows)]
    {
        let scope = output_pipeline::PipelineBuildScope::new();
        output_pipeline::finish_windows_pipeline_startup(&scope, startup).await
    }
    #[cfg(not(windows))]
    startup.await
}

#[tracing::instrument("instant_recording", skip_all)]
async fn build_instant_recording_actor(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
    max_output_size: Option<u32>,
    max_fps: u32,
    #[cfg(target_os = "linux")] camera: LinuxCameraConfig,
    #[cfg(target_os = "linux")] lifecycle: InstantLifecycle,
) -> anyhow::Result<ActorHandle> {
    #[cfg(target_os = "linux")]
    anyhow::ensure!(
        !matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly)
            || !inputs.capture_system_audio,
        "System audio is not supported for Linux Instant CameraOnly recordings. Disable system audio or choose a screen target."
    );
    #[cfg(target_os = "linux")]
    let LinuxCameraConfig {
        composite_camera,
        camera_presentation,
        processed_camera,
        camera_reference_size,
    } = camera;
    #[cfg(target_os = "linux")]
    if camera_presentation.is_some() && inputs.camera_feed.is_none() {
        return Err(LinuxCameraPresentationError::MissingCamera.into());
    }
    #[cfg(target_os = "linux")]
    if camera_presentation.is_some()
        && matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly)
    {
        return Err(LinuxCameraPresentationError::UnsupportedTarget.into());
    }
    ensure_dir(&recording_dir)?;

    let timestamps = Timestamps::now();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    #[cfg(windows)]
    cap_mediafoundation_utils::thread_init();

    let (mut pipeline, video_info) = match inputs.capture_target {
        ScreenCaptureTarget::CameraOnly => {
            #[cfg(target_os = "linux")]
            {
                let camera_feed = inputs.camera_feed.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "Camera-only recording requires a camera, but no camera is currently available. \
                        Please select a camera in the recording settings before starting. \
                        If you have already selected a camera, it may have been disconnected or \
                        failed to initialize. Try reconnecting your camera or selecting a different one."
                    )
                })?;

                let output_path = content_dir.join("output.mp4");

                let mut builder = OutputPipeline::builder(output_path.clone())
                    .with_video::<crate::sources::Camera>(camera_feed.clone())
                    .with_timestamps(timestamps);

                if let Some(mic_feed) = inputs.mic_feed.clone() {
                    builder = builder.with_audio_source::<crate::sources::Microphone>(mic_feed);
                }

                let cam_pipeline = builder
                    .build::<output_pipeline::Mp4Muxer>(())
                    .await
                    .context("camera-only pipeline setup")?;

                let video_info = *camera_feed.video_info();
                (
                    Pipeline {
                        video: cam_pipeline,
                        audio: None,
                        video_info,
                        segments_dir: content_dir.clone(),
                        segment_rx: None,
                    },
                    video_info,
                )
            }

            #[cfg(any(target_os = "macos", windows))]
            {
                let camera_feed = inputs.camera_feed.clone().ok_or_else(|| {
                    anyhow::anyhow!(
                        "Camera-only recording requires a camera, but no camera is currently available. \
                        Please select a camera in the recording settings before starting. \
                        If you have already selected a camera, it may have been disconnected or \
                        failed to initialize. Try reconnecting your camera or selecting a different one."
                    )
                })?;

                let output_path = content_dir.join("output.mp4");

                let mut builder = OutputPipeline::builder(output_path.clone())
                    .with_video::<crate::sources::NativeCamera>(camera_feed.clone())
                    .with_timestamps(timestamps);

                if let Some(mic_feed) = inputs.mic_feed.clone() {
                    builder = builder.with_audio_source::<crate::sources::Microphone>(mic_feed);
                }

                #[cfg(target_os = "macos")]
                let cam_pipeline = builder
                    .build::<output_pipeline::AVFoundationCameraMuxer>(
                        output_pipeline::AVFoundationCameraMuxerConfig {
                            instant_mode: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .context("camera-only pipeline setup")?;

                #[cfg(windows)]
                let cam_pipeline = builder
                    .build::<output_pipeline::WindowsCameraMuxer>(
                        output_pipeline::WindowsCameraMuxerConfig {
                            encoder_preferences:
                                crate::capture_pipeline::EncoderPreferences::default(),
                            ..Default::default()
                        },
                    )
                    .await
                    .context("camera-only pipeline setup")?;

                let video_info = *camera_feed.video_info();
                (
                    Pipeline {
                        video: cam_pipeline,
                        audio: None,
                        video_info,
                        segments_dir: content_dir.clone(),
                        segment_rx: None,
                    },
                    video_info,
                )
            }
        }
        _ => {
            #[cfg(windows)]
            let d3d_device = crate::capture_pipeline::create_d3d_device()?;

            let (display, crop_bounds) = target_to_display_and_crop(&inputs.capture_target)
                .context("target_display_crop")?;

            #[cfg(target_os = "macos")]
            let max_capture_size = max_output_size.and_then(|max_output_size| {
                inputs.capture_target.physical_size().map(|size| {
                    capture_size_constraint(
                        (size.width() as u32, size.height() as u32),
                        max_output_size,
                    )
                })
            });
            #[cfg(not(target_os = "macos"))]
            let max_capture_size = None;

            let screen_source = ScreenCaptureConfig::<ScreenCaptureMethod>::init(
                display,
                crop_bounds,
                true,
                max_fps,
                max_capture_size,
                timestamps.system_time(),
                inputs.capture_system_audio,
                #[cfg(target_os = "linux")]
                crate::sources::screen_capture::LinuxCaptureSource::from_target(
                    &inputs.capture_target,
                ),
                #[cfg(windows)]
                d3d_device,
                #[cfg(target_os = "macos")]
                inputs
                    .shareable_content
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("Missing shareable content"))?,
                #[cfg(target_os = "macos")]
                inputs.excluded_windows,
            )
            .await
            .context("screen capture init")?;

            debug!("screen capture: {screen_source:#?}");

            #[cfg(not(target_os = "linux"))]
            let screen_info = screen_source.info();
            let (screen_capture, system_audio_source) = screen_source.to_sources().await?;
            #[cfg(target_os = "linux")]
            let screen_info = screen_capture.video_info();
            #[cfg(target_os = "linux")]
            let (prepared_camera, timestamps) = if let Some(camera_feed) =
                inputs.camera_feed.clone().filter(|_| composite_camera)
            {
                let (camera, timestamps) = linux_camera::PreparedCamera::prepare(
                    camera_feed,
                    camera_presentation,
                    processed_camera,
                    camera_reference_size,
                    screen_info,
                )
                .await?;
                (Some(camera), timestamps)
            } else {
                (None, Timestamps::now())
            };

            let pipeline = create_pipeline(
                content_dir.clone(),
                ScreenPipelineInput {
                    source: screen_capture,
                    info: screen_info,
                    #[cfg(target_os = "linux")]
                    prepared_camera,
                },
                inputs.mic_feed.clone(),
                system_audio_source,
                max_output_size,
                timestamps,
            )
            .await?;

            let video_info = pipeline.video_info;

            (pipeline, video_info)
        }
    };

    let segment_start_time = current_time_f64();

    trace!("spawning recording actor");

    let segment_rx = pipeline.segment_rx.take();
    let output_dir = pipeline.segments_dir.clone();
    #[cfg(not(target_os = "linux"))]
    let done_fut = pipeline.video.done_fut();
    #[cfg(target_os = "linux")]
    let video_done = pipeline.video.done_fut();
    #[cfg(target_os = "linux")]
    let audio_done = pipeline.audio.as_ref().map(OutputPipeline::done_fut);
    #[cfg(target_os = "linux")]
    let done_fut = lifecycle.done_fut();
    let health_rx = pipeline.video.take_health_rx();
    let actor_ref = Actor::spawn(Actor {
        recording_dir,
        output_dir,
        capture_target: inputs.capture_target.clone(),
        video_info,
        state: ActorState::Recording {
            pipeline,
            segment_start_time,
        },
        total_pause_duration: std::time::Duration::ZERO,
        pause_started_at: None,
        terminal_stop_error: None,
        #[cfg(target_os = "linux")]
        lifetime: InstantLifetimeOwner {
            lifecycle: lifecycle.clone(),
            armed: true,
        },
    });

    let actor_handle = ActorHandle {
        #[cfg(target_os = "linux")]
        lifecycle: lifecycle.clone(),
        actor_ref: actor_ref.clone(),
        capture_target: inputs.capture_target,
        done_fut: done_fut.clone(),
        health_rx,
        segment_rx: segment_rx.map(|rx| std::sync::Mutex::new(Some(rx))),
    };

    #[cfg(not(target_os = "linux"))]
    tokio::spawn(async move {
        let _ = done_fut.await;
        let _ = actor_ref.ask(Stop).await;
    });
    #[cfg(target_os = "linux")]
    watch_instant_tracks(lifecycle, actor_ref, video_done, audio_done);

    Ok(actor_handle)
}

#[cfg(target_os = "linux")]
fn watch_instant_tracks(
    lifecycle: InstantLifecycle,
    actor_ref: kameo::actor::ActorRef<Actor>,
    video_done: output_pipeline::DoneFut,
    audio_done: Option<output_pipeline::DoneFut>,
) {
    drop(tokio::spawn(async move {
        let cancel = lifecycle.0.scope.cancellation();
        let audio = async {
            match audio_done {
                Some(done) => done.await,
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => None,
            result = video_done => Some(("Video", result)),
            result = audio => Some(("Audio", result)),
        };
        if let Some((track, result)) = result {
            match result {
                Err(error) => lifecycle
                    .0
                    .scope
                    .fail_required(format!("{track} pipeline failed: {error}")),
                Ok(()) if !cancel.is_cancelled() => lifecycle
                    .0
                    .scope
                    .fail_required(format!("Required {track} pipeline ended before Stop")),
                Ok(()) => {}
            }
        }
        let _ = actor_ref.ask(Cancel).await;
    }));
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

#[cfg(target_os = "macos")]
fn capture_size_constraint(input: (u32, u32), max_output_size: u32) -> (u32, u32) {
    let aspect_ratio = input.0 as f64 / input.1 as f64;
    let max_short_edge = (max_output_size as f64 / 16.0 * 9.0) as u32;

    if input.0 >= input.1 && aspect_ratio <= 16.0 / 9.0 {
        (max_output_size, u32::MAX)
    } else if input.0 <= input.1 && aspect_ratio >= 9.0 / 16.0 {
        (u32::MAX, max_output_size)
    } else if input.0 >= input.1 {
        (u32::MAX, max_short_edge)
    } else {
        (max_short_edge, u32::MAX)
    }
}

fn clamp_size(input: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    // 16/9-ish
    if input.0 >= input.1 && (input.0 as f64 / input.1 as f64) <= 16.0 / 9.0 {
        let width = ensure_even(max.0.min(input.0));

        let height_ratio = input.1 as f64 / input.0 as f64;
        let height = ensure_even((height_ratio * width as f64).round() as u32);

        (width, height)
    }
    // 9/16-ish
    else if input.0 <= input.1 && (input.0 as f64 / input.1 as f64) >= 9.0 / 16.0 {
        let height = ensure_even(max.0.min(input.1));

        let width_ratio = input.0 as f64 / input.1 as f64;
        let width = ensure_even((width_ratio * height as f64).round() as u32);

        (width, height)
    }
    // ultrawide
    else if input.0 >= input.1 && (input.0 as f64 / input.1 as f64) > 16.0 / 9.0 {
        let height = ensure_even(max.1.min(input.1));

        let width_ratio = input.0 as f64 / input.1 as f64;
        let width = ensure_even((width_ratio * height as f64).round() as u32);

        (width, height)
    }
    // ultratall
    else if input.0 < input.1 && (input.0 as f64 / input.1 as f64) <= 9.0 / 16.0 {
        // swapped since max_width/height assume horizontal
        let width = ensure_even(max.1.min(input.0));

        let height_ratio = input.1 as f64 / input.0 as f64;
        let height = ensure_even((height_ratio * width as f64).round() as u32);

        (width, height)
    } else {
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_presentation_builder_preserves_explicit_config_and_cli_default() {
        let request = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 10,
                y: 20,
                width: 40,
                height: 30,
            },
            shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 4 },
            mirrored: true,
            effect: LinuxCameraEffect::None,
        };
        let configured = ActorBuilder::new(PathBuf::new(), ScreenCaptureTarget::CameraOnly)
            .with_linux_camera_presentation(request);
        assert!(configured.composite_camera);
        assert_eq!(configured.camera_presentation, Some(request));
        let default = ActorBuilder::new(PathBuf::new(), ScreenCaptureTarget::CameraOnly)
            .with_linux_camera_composition();
        assert!(default.composite_camera);
        assert!(default.camera_presentation.is_none());
    }

    #[tokio::test]
    async fn actor_retains_terminal_error_after_internal_stop() {
        let mut actor = Actor {
            recording_dir: PathBuf::new(),
            output_dir: PathBuf::new(),
            capture_target: ScreenCaptureTarget::CameraOnly,
            video_info: VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::RGBA, 4, 4, 30),
            state: ActorState::Stopped,
            total_pause_duration: std::time::Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: Some("Required camera disconnected".to_string()),
            #[cfg(target_os = "linux")]
            lifetime: InstantLifetimeOwner::new(),
        };
        for _ in 0..2 {
            assert!(
                actor
                    .stop()
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("Required camera disconnected")
            );
        }
    }

    #[test]
    fn repeated_stop_cannot_turn_pipeline_failure_into_complete() {
        let mut stored = None;
        assert!(
            super::preserve_terminal_stop_error(
                &mut stored,
                Err(anyhow::anyhow!("Required camera disconnected"))
            )
            .is_err()
        );
        assert!(
            super::preserve_terminal_stop_error(&mut stored, Ok(()))
                .unwrap_err()
                .to_string()
                .contains("Required camera disconnected")
        );
        assert!(super::preserve_terminal_stop_error(&mut stored, Ok(())).is_err());
    }

    #[test]
    fn successful_stop_remains_idempotent() {
        let mut stored = None;
        assert!(super::preserve_terminal_stop_error(&mut stored, Ok(())).is_ok());
        assert!(super::preserve_terminal_stop_error(&mut stored, Ok(())).is_ok());
        assert!(stored.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_size_constraint_preserves_instant_output_axis() {
        assert_eq!(
            capture_size_constraint((3024, 1964), 1920),
            (1920, u32::MAX)
        );
        assert_eq!(
            capture_size_constraint((1964, 3024), 1920),
            (u32::MAX, 1920)
        );
        assert_eq!(
            capture_size_constraint((5120, 1440), 1920),
            (u32::MAX, 1080)
        );
        assert_eq!(
            capture_size_constraint((1440, 5120), 1920),
            (1080, u32::MAX)
        );
    }

    #[test]
    fn test_clamp_size_16_9_ish_landscape() {
        assert_eq!(clamp_size((2880, 1800), (1920, 1080)), (1920, 1200));

        // Test 16:9 aspect ratio (boundary case)
        let result = clamp_size((1920, 1080), (1920, 1080));
        assert_eq!(result, (1920, 1080));

        // Test aspect ratio less than 16:9 (wider than tall, but not ultrawide)
        let result = clamp_size((1600, 1200), (1920, 1080)); // 4:3 ratio
        assert_eq!(result, (1600, 1200));

        // Test scaling down when input exceeds max width
        let result = clamp_size((2560, 1440), (1920, 1080)); // 16:9 ratio, needs scaling
        assert_eq!(result, (1920, 1080));
    }

    #[test]
    fn test_clamp_size_9_16_ish_portrait() {
        // Test 9:16 aspect ratio (boundary case)
        let result = clamp_size((1080, 1920), (1920, 1080));
        assert_eq!(result, (1080, 1920));

        // Test aspect ratio greater than 9:16 but still portrait
        let result = clamp_size((1200, 1600), (1920, 1080)); // 3:4 ratio
        assert_eq!(result, (1200, 1600));

        // Test square format (1:1 ratio) - should use portrait path when width <= height
        let result = clamp_size((1080, 1080), (1920, 1080));
        assert_eq!(result, (1080, 1080));
    }

    #[test]
    fn test_clamp_size_ultrawide() {
        // Test ultrawide aspect ratio (> 16:9)
        let result = clamp_size((2560, 1080), (1920, 1080)); // ~2.37:1 ratio
        assert_eq!(result, (2560, 1080));

        // Test very ultrawide
        let result = clamp_size((3440, 1440), (1920, 1080)); // ~2.39:1 ratio
        assert_eq!(result, (2580, 1080));

        // Test when height constraint is the limiting factor
        let result = clamp_size((3840, 1600), (1920, 1080)); // 2.4:1 ratio
        assert_eq!(result, (2592, 1080));

        // Test even number enforcement for height
        let result = clamp_size((2561, 1080), (1920, 1081)); // Odd max height
        assert_eq!(result, (2560, 1080)); // Height should be made even

        // Test even number enforcement for calculated width
        let result = clamp_size((2561, 1080), (1920, 1080)); // Results in odd width calculation
        assert_eq!(result, (2560, 1080)); // Width should be made even
    }

    #[test]
    fn test_clamp_size_ultratall() {
        // Test ultratall aspect ratio (< 9:16)
        let result = clamp_size((1080, 2560), (1920, 1920)); // ~9:21.3 ratio
        assert_eq!(result, (1080, 2560));

        // Test very ultratall that needs scaling
        let result = clamp_size((800, 3200), (1920, 2000)); // 1:4 ratio
        assert_eq!(result, (800, 3200));

        // Test when width constraint is the limiting factor (using max.1 as width limit)
        let result = clamp_size((500, 3000), (1920, 1000)); // Very tall, width limited by max.1
        assert_eq!(result, (500, 3000));

        // Test even number enforcement for width (using max.1)
        let result = clamp_size((500, 3000), (1920, 1001)); // Odd max.1 used as width
        assert_eq!(result, (500, 3000)); // Width should be made even

        // Test even number enforcement for calculated height
        let result = clamp_size((500, 3000), (1920, 1000)); // Results in odd height calculation
        assert_eq!(result, (500, 3000)); // Height should be made even
    }

    #[test]
    fn test_clamp_size_edge_cases() {
        // Test minimum sizes
        let result = clamp_size((2, 2), (1920, 1080));
        assert_eq!(result, (2, 2));

        // Test when input is smaller than max in all dimensions
        let result = clamp_size((800, 600), (1920, 1080));
        assert_eq!(result, (800, 600));

        // Test exact 16:9 boundary
        let sixteen_nine = 16.0 / 9.0;
        let width = 1920;
        let height = (width as f64 / sixteen_nine) as u32; // Should be exactly 1080
        let result = clamp_size((width, height), (1920, 1080));
        assert_eq!(result, (1920, 1080));

        // Test exact 9:16 boundary
        let nine_sixteen = 9.0 / 16.0;
        let height = 1920;
        let width = (height as f64 * nine_sixteen) as u32; // Should be exactly 1080
        let result = clamp_size((width, height), (1920, 1080));
        assert_eq!(result, (1080, 1920));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod quiescence_tests {
    use super::*;
    use crate::output_pipeline::{
        AudioFrame, AudioMuxer, AudioSource, ChannelAudioSource, ChannelAudioSourceConfig,
        ChannelVideoSource, ChannelVideoSourceConfig, Muxer, SetupCtx, TaskPool, VideoFrame,
        VideoMuxer,
    };
    use cap_timestamp::Timestamp;
    use std::{
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    #[derive(Clone, Copy)]
    struct Frame(Timestamp);
    impl VideoFrame for Frame {
        fn timestamp(&self) -> Timestamp {
            self.0
        }
    }

    #[derive(Clone)]
    struct Finalizer {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
        finished: Arc<AtomicBool>,
        fail: bool,
    }
    impl Finalizer {
        fn new(fail: bool) -> Self {
            Self {
                entered: Arc::new(tokio::sync::Notify::new()),
                release: Arc::new(Mutex::new(None)),
                finished: Arc::new(AtomicBool::new(false)),
                fail,
            }
        }
    }
    struct TestMuxer(Finalizer);
    impl Muxer for TestMuxer {
        type Config = Finalizer;
        async fn setup(
            config: Finalizer,
            _: PathBuf,
            _: Option<VideoInfo>,
            _: Option<cap_media_info::AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(config))
        }
        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            self.0.entered.notify_one();
            if let Some(release) = self.0.release.lock().unwrap().take() {
                release.recv().unwrap();
            }
            self.0.finished.store(true, Ordering::Release);
            Ok(if self.0.fail {
                Err(anyhow::anyhow!("required track finalization failed"))
            } else {
                Ok(())
            })
        }
    }
    impl VideoMuxer for TestMuxer {
        type VideoFrame = Frame;
        fn send_video_frame(&mut self, _: Frame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }
    impl AudioMuxer for TestMuxer {
        fn send_audio_frame(&mut self, _: AudioFrame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    struct Fixture {
        handle: ActorHandle,
        audio_cancel: Option<tokio_util::sync::CancellationToken>,
        _video_sender: flume::Sender<Frame>,
        _audio_sender: Option<futures::channel::mpsc::Sender<AudioFrame>>,
    }

    async fn actor_fixture(
        directory: &std::path::Path,
        video_finish: Finalizer,
        audio_finish: Option<Finalizer>,
    ) -> Fixture {
        let owner = InstantLifetimeOwner::new();
        let lifecycle = owner.lifecycle.clone();
        *lifecycle.0.runtime.lock().unwrap() = Some(tokio::runtime::Handle::current());
        let info = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 4, 4, 30);
        let timestamps = Timestamps::now();
        let (video_sender, video_receiver) = flume::bounded(4);
        let video = lifecycle
            .0
            .scope
            .run(
                OutputPipeline::builder(directory.join("display"))
                    .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(
                        info,
                        video_receiver,
                    ))
                    .with_timestamps(timestamps)
                    .build::<TestMuxer>(video_finish),
            )
            .await
            .unwrap();
        video_sender
            .send(Frame(Timestamp::Instant(timestamps.instant())))
            .unwrap();
        let mut audio_sender = None;
        let audio = if let Some(finalizer) = audio_finish {
            let (mut sender, receiver) = futures::channel::mpsc::channel(4);
            let info = cap_media_info::AudioInfo::new_raw(
                cap_media_info::Sample::F32(cap_media_info::Type::Packed),
                48_000,
                2,
            );
            let audio = lifecycle
                .0
                .scope
                .run(
                    OutputPipeline::builder(directory.join("audio"))
                        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                            info, receiver,
                        ))
                        .with_timestamps(timestamps)
                        .build::<TestMuxer>(finalizer),
                )
                .await
                .unwrap();
            sender
                .try_send(AudioFrame::new(
                    info.empty_frame(960),
                    Timestamp::Instant(timestamps.instant()),
                ))
                .unwrap();
            audio_sender = Some(sender);
            Some(audio)
        } else {
            None
        };
        let audio_cancel = audio.as_ref().map(OutputPipeline::cancel_token);
        let video_done = video.done_fut();
        let audio_done = audio.as_ref().map(OutputPipeline::done_fut);
        let actor_ref = Actor::spawn(Actor {
            recording_dir: directory.to_path_buf(),
            output_dir: directory.join("display"),
            capture_target: ScreenCaptureTarget::CameraOnly,
            video_info: info,
            state: ActorState::Recording {
                pipeline: Pipeline {
                    video,
                    audio,
                    video_info: info,
                    segments_dir: directory.join("display"),
                    segment_rx: None,
                },
                segment_start_time: current_time_f64(),
            },
            total_pause_duration: Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: None,
            lifetime: owner,
        });
        watch_instant_tracks(lifecycle.clone(), actor_ref.clone(), video_done, audio_done);
        Fixture {
            handle: ActorHandle {
                actor_ref,
                capture_target: ScreenCaptureTarget::CameraOnly,
                done_fut: lifecycle.done_fut(),
                health_rx: None,
                segment_rx: None,
                lifecycle,
            },
            audio_cancel,
            _video_sender: video_sender,
            _audio_sender: audio_sender,
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CombinedFailure {
        None,
        AudioSend,
        AudioTail,
        FlushInner,
        FlushOuter,
    }

    #[derive(Clone)]
    struct CombinedProbe {
        failure: CombinedFailure,
        finalizer: Finalizer,
        attempts: Arc<Mutex<Vec<f32>>>,
        audio_observed: Arc<tokio::sync::Notify>,
        source_stopped: Arc<AtomicBool>,
    }

    impl CombinedProbe {
        fn new(failure: CombinedFailure) -> Self {
            Self {
                failure,
                finalizer: Finalizer::new(failure == CombinedFailure::FlushInner),
                attempts: Arc::new(Mutex::new(Vec::new())),
                audio_observed: Arc::new(tokio::sync::Notify::new()),
                source_stopped: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    struct CombinedMuxer(CombinedProbe);

    impl Muxer for CombinedMuxer {
        type Config = CombinedProbe;

        async fn setup(
            config: Self::Config,
            output: PathBuf,
            _: Option<VideoInfo>,
            _: Option<cap_media_info::AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            std::fs::write(output, b"preserved partial test video")?;
            Ok(Self(config))
        }

        fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
            let result = TestMuxer(self.0.finalizer.clone()).finish(timestamp);
            if self.0.failure == CombinedFailure::FlushOuter {
                return Err(anyhow::anyhow!("combined audio outer flush failed"));
            }
            result
        }
    }

    impl VideoMuxer for CombinedMuxer {
        type VideoFrame = Frame;

        fn send_video_frame(&mut self, _: Frame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    impl AudioMuxer for CombinedMuxer {
        fn send_audio_frame(&mut self, frame: AudioFrame, _: Duration) -> anyhow::Result<()> {
            let value = f32::from_ne_bytes(frame.inner.data(0)[..4].try_into().unwrap());
            self.0.attempts.lock().unwrap().push(value);
            self.0.audio_observed.notify_one();
            if self.0.failure == CombinedFailure::AudioSend
                || (self.0.failure == CombinedFailure::AudioTail && value == 0.0)
            {
                return Err(anyhow::anyhow!("required combined audio send failed"));
            }
            Ok(())
        }
    }

    struct DirectAudioSource(Arc<AtomicBool>);

    impl AudioSource for DirectAudioSource {
        type Config = (
            tokio::sync::oneshot::Sender<futures::channel::mpsc::Sender<AudioFrame>>,
            Arc<AtomicBool>,
        );

        fn setup(
            config: Self::Config,
            sender: futures::channel::mpsc::Sender<AudioFrame>,
            _: &mut SetupCtx,
        ) -> impl Future<Output = anyhow::Result<Self>> + Send + 'static {
            futures::future::lazy(move |_| {
                config
                    .0
                    .send(sender)
                    .map_err(|_| anyhow::anyhow!("test audio receiver dropped"))?;
                Ok(Self(config.1))
            })
        }

        fn audio_info(&self) -> cap_media_info::AudioInfo {
            combined_audio_info()
        }

        async fn stop(&mut self) -> anyhow::Result<()> {
            self.0.store(true, Ordering::Release);
            Ok(())
        }
    }

    fn combined_audio_info() -> cap_media_info::AudioInfo {
        cap_media_info::AudioInfo::new_raw(
            cap_media_info::Sample::F32(cap_media_info::Type::Packed),
            48_000,
            2,
        )
    }

    fn combined_audio_frame(timestamps: Timestamps, value: f32) -> AudioFrame {
        let mut frame = combined_audio_info().empty_frame(960);
        for sample in frame.data_mut(0).chunks_exact_mut(4) {
            sample.copy_from_slice(&value.to_ne_bytes());
        }
        AudioFrame::new(frame, Timestamp::Instant(timestamps.instant()))
    }

    struct CombinedFixture {
        handle: ActorHandle,
        audio: futures::channel::mpsc::Sender<AudioFrame>,
        additional_audio: Vec<futures::channel::mpsc::Sender<AudioFrame>>,
        pipeline_cancel: tokio_util::sync::CancellationToken,
        _video: flume::Sender<Frame>,
        timestamps: Timestamps,
    }

    async fn combined_actor_fixture(
        directory: &std::path::Path,
        probe: CombinedProbe,
        start_video: bool,
    ) -> CombinedFixture {
        combined_actor_fixture_sources(directory, probe, start_video, 1).await
    }

    async fn combined_actor_fixture_sources(
        directory: &std::path::Path,
        probe: CombinedProbe,
        start_video: bool,
        source_count: usize,
    ) -> CombinedFixture {
        let owner = InstantLifetimeOwner::new();
        let lifecycle = owner.lifecycle.clone();
        *lifecycle.0.runtime.lock().unwrap() = Some(tokio::runtime::Handle::current());
        let info = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 4, 4, 30);
        let timestamps = Timestamps::now();
        let (video_sender, video_receiver) = flume::bounded(4);
        let output = directory.join("output.mp4");
        let mut builder = OutputPipeline::builder(output.clone())
            .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(
                info,
                video_receiver,
            ))
            .with_timestamps(timestamps);
        let mut receivers = Vec::new();
        for _ in 0..source_count {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            builder = builder
                .with_audio_source::<DirectAudioSource>((sender, probe.source_stopped.clone()));
            receivers.push(receiver);
        }
        let video = lifecycle
            .0
            .scope
            .run(builder.build::<CombinedMuxer>(probe))
            .await
            .unwrap();
        let mut audio_sources = Vec::new();
        for receiver in receivers {
            audio_sources.push(receiver.await.unwrap());
        }
        let audio = audio_sources.remove(0);
        let pipeline_cancel = video.cancel_token();
        let done = video.done_fut();
        let actor_ref = Actor::spawn(Actor {
            recording_dir: directory.to_path_buf(),
            output_dir: output.clone(),
            capture_target: ScreenCaptureTarget::CameraOnly,
            video_info: info,
            state: ActorState::Recording {
                pipeline: Pipeline {
                    video,
                    audio: None,
                    video_info: info,
                    segments_dir: directory.to_path_buf(),
                    segment_rx: None,
                },
                segment_start_time: current_time_f64(),
            },
            total_pause_duration: Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: None,
            lifetime: owner,
        });
        watch_instant_tracks(lifecycle.clone(), actor_ref.clone(), done, None);
        let handle = ActorHandle {
            actor_ref,
            capture_target: ScreenCaptureTarget::CameraOnly,
            done_fut: lifecycle.done_fut(),
            health_rx: None,
            segment_rx: None,
            lifecycle,
        };
        if start_video {
            video_sender
                .send(Frame(Timestamp::Instant(timestamps.instant())))
                .unwrap();
        }
        CombinedFixture {
            handle,
            audio,
            additional_audio: audio_sources,
            pipeline_cancel,
            _video: video_sender,
            timestamps,
        }
    }

    async fn assert_combined_error(
        fixture: &CombinedFixture,
        probe: &CombinedProbe,
        message: &str,
    ) {
        let error = tokio::time::timeout(Duration::from_secs(3), fixture.handle.done_fut())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains(message), "{error:#}");
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Joined
        );
        assert!(probe.source_stopped.load(Ordering::Acquire));
        assert!(probe.finalizer.finished.load(Ordering::Acquire));
        for _ in 0..2 {
            let error = fixture.handle.stop().await.unwrap_err();
            assert!(error.to_string().contains(message), "{error:#}");
            assert!(fixture.handle.cancel().await.is_err());
        }
    }

    #[tokio::test]
    async fn camera_only_system_request_fails_inside_joined_startup_without_capture() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("unsupported.cap");
        let builder =
            Actor::builder(output.clone(), ScreenCaptureTarget::CameraOnly).with_system_audio(true);
        let lifecycle = builder.lifecycle();
        let error = builder
            .build()
            .await
            .err()
            .expect("Unsupported system audio must fail");
        assert!(
            error.to_string().contains("System audio is not supported"),
            "{error:#}"
        );
        assert!(!output.exists());
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
        assert!(
            lifecycle
                .done_fut()
                .await
                .unwrap_err()
                .to_string()
                .contains("System audio is not supported")
        );
        let supported = Actor::builder(
            directory.path().join("camera.cap"),
            ScreenCaptureTarget::CameraOnly,
        );
        let lifecycle = supported.lifecycle();
        let error = supported
            .build()
            .await
            .err()
            .expect("Missing camera must still be validated");
        assert!(
            error
                .to_string()
                .contains("Camera-only recording requires a camera"),
            "{error:#}"
        );
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
    }

    #[tokio::test]
    async fn combined_mixer_errors_wait_for_owned_finalization_and_remain_terminal() {
        for (rate, message) in [
            (0, "filter input failed"),
            (u32::MAX, "filter rebuild failed"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let probe = CombinedProbe::new(CombinedFailure::FlushInner);
            let (release, blocked) = std::sync::mpsc::channel();
            *probe.finalizer.release.lock().unwrap() = Some(blocked);
            let mut fixture =
                combined_actor_fixture_sources(directory.path(), probe.clone(), true, 2).await;
            let mut invalid = combined_audio_frame(fixture.timestamps, 0.25);
            invalid.inner.set_rate(rate);
            fixture.audio.try_send(invalid).unwrap();
            fixture.additional_audio[0]
                .try_send(combined_audio_frame(fixture.timestamps, 0.25))
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), probe.finalizer.entered.notified())
                .await
                .unwrap();
            assert_eq!(
                fixture.handle.lifecycle().quiescence(),
                InstantQuiescence::Pending
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(20), fixture.handle.done_fut())
                    .await
                    .is_err()
            );
            release.send(()).unwrap();
            assert_combined_error(&fixture, &probe, message).await;
            assert!(directory.path().join("output.mp4").is_file());
        }
    }

    #[tokio::test]
    async fn combined_closed_requested_mixer_input_cannot_complete() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::FlushInner);
        let (release, blocked) = std::sync::mpsc::channel();
        *probe.finalizer.release.lock().unwrap() = Some(blocked);
        let mut fixture =
            combined_actor_fixture_sources(directory.path(), probe.clone(), true, 2).await;
        drop(fixture.additional_audio.remove(0));
        tokio::time::timeout(Duration::from_secs(3), probe.finalizer.entered.notified())
            .await
            .unwrap();
        assert!(fixture.pipeline_cancel.is_cancelled());
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Pending
        );
        release.send(()).unwrap();
        assert_combined_error(&fixture, &probe, "source 1 closed").await;
        assert!(directory.path().join("output.mp4").is_file());
    }

    #[tokio::test]
    async fn combined_closed_single_audio_input_cannot_complete() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::FlushInner);
        let (release, blocked) = std::sync::mpsc::channel();
        *probe.finalizer.release.lock().unwrap() = Some(blocked);
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
        assert!(!fixture.pipeline_cancel.is_cancelled());
        fixture.audio.close_channel();
        tokio::time::timeout(Duration::from_secs(3), probe.finalizer.entered.notified())
            .await
            .unwrap();
        assert!(fixture.pipeline_cancel.is_cancelled());
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Pending
        );
        release.send(()).unwrap();
        assert_combined_error(&fixture, &probe, "Required audio source closed").await;
        assert!(directory.path().join("output.mp4").is_file());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn combined_pipeline_cancellation_precedes_closed_source_error() {
        for source_count in [1, 2] {
            let directory = tempfile::tempdir().unwrap();
            let probe = CombinedProbe::new(CombinedFailure::None);
            let mut fixture =
                combined_actor_fixture_sources(directory.path(), probe.clone(), true, source_count)
                    .await;
            fixture
                .audio
                .try_send(combined_audio_frame(fixture.timestamps, 0.25))
                .unwrap();
            for source in &mut fixture.additional_audio {
                source
                    .try_send(combined_audio_frame(fixture.timestamps, 0.25))
                    .unwrap();
            }
            tokio::time::timeout(Duration::from_secs(3), probe.audio_observed.notified())
                .await
                .unwrap();
            let actor = fixture.handle.actor_ref.clone();
            let stop = tokio::spawn(async move { actor.ask(Stop).await });
            tokio::time::timeout(Duration::from_secs(3), fixture.pipeline_cancel.cancelled())
                .await
                .unwrap();
            fixture.audio.close_channel();
            fixture.additional_audio.clear();
            tokio::time::timeout(Duration::from_secs(3), stop)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            fixture.handle.done_fut().await.unwrap();
            assert_eq!(
                fixture.handle.lifecycle().quiescence(),
                InstantQuiescence::Joined
            );
            assert!(probe.finalizer.finished.load(Ordering::Acquire));
        }
    }

    #[tokio::test]
    async fn combined_requested_mixed_audio_success_still_completes() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::None);
        let mut fixture =
            combined_actor_fixture_sources(directory.path(), probe.clone(), true, 2).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        fixture.additional_audio[0]
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), probe.audio_observed.notified())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), fixture.handle.stop())
            .await
            .unwrap()
            .unwrap();
        fixture.handle.done_fut().await.unwrap();
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Joined
        );
        assert!(probe.source_stopped.load(Ordering::Acquire));
        assert!(probe.finalizer.finished.load(Ordering::Acquire));
        assert!(!probe.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn combined_audio_send_failure_waits_for_finalizer_and_never_completes() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::AudioSend);
        let (release, blocked) = std::sync::mpsc::channel();
        *probe.finalizer.release.lock().unwrap() = Some(blocked);
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), probe.finalizer.entered.notified())
            .await
            .unwrap();
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Pending
        );
        assert!(fixture.handle.done_fut().now_or_never().is_none());
        assert!(probe.source_stopped.load(Ordering::Acquire));
        release.send(()).unwrap();
        assert_combined_error(&fixture, &probe, "required combined audio send failed").await;
        assert_eq!(
            std::fs::read(directory.path().join("output.mp4")).unwrap(),
            b"preserved partial test video"
        );
    }

    #[tokio::test]
    async fn combined_audio_send_error_survives_later_flush_failure() {
        let directory = tempfile::tempdir().unwrap();
        let mut probe = CombinedProbe::new(CombinedFailure::AudioSend);
        probe.finalizer.fail = true;
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        assert_combined_error(&fixture, &probe, "required combined audio send failed").await;
    }

    #[tokio::test]
    async fn combined_audio_drain_failure_is_retained_by_actor_stop() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::AudioSend);
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), false).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        let mut full = false;
        for _ in 0..256 {
            if let Err(error) = fixture
                .audio
                .try_send(combined_audio_frame(fixture.timestamps, 0.75))
            {
                assert!(error.is_full());
                full = true;
                break;
            }
        }
        assert!(full);
        tokio::time::timeout(
            Duration::from_secs(2),
            futures::future::poll_fn(|cx| fixture.audio.poll_ready(cx)),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(probe.attempts.lock().unwrap().is_empty());
        let error = tokio::time::timeout(Duration::from_secs(3), fixture.handle.stop())
            .await
            .unwrap()
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("required combined audio send failed")
        );
        assert_eq!(*probe.attempts.lock().unwrap(), vec![0.75]);
        assert_combined_error(&fixture, &probe, "required combined audio send failed").await;
    }

    #[tokio::test]
    async fn combined_audio_tail_failure_is_retained_by_actor_stop() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::AudioTail);
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), probe.audio_observed.notified())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let error = fixture.handle.stop().await.unwrap_err();
        assert!(error.to_string().contains("tail padding"), "{error:#}");
        let attempts = probe.attempts.lock().unwrap().clone();
        assert_eq!(attempts.first(), Some(&0.25));
        assert_eq!(attempts.last(), Some(&0.0));
        assert_combined_error(&fixture, &probe, "tail padding").await;
    }

    #[tokio::test]
    async fn combined_audio_flush_failures_never_become_complete() {
        for failure in [CombinedFailure::FlushInner, CombinedFailure::FlushOuter] {
            let directory = tempfile::tempdir().unwrap();
            let probe = CombinedProbe::new(failure);
            let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
            fixture
                .audio
                .try_send(combined_audio_frame(fixture.timestamps, 0.25))
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), probe.audio_observed.notified())
                .await
                .unwrap();
            assert!(fixture.handle.stop().await.is_err());
            let message = if failure == CombinedFailure::FlushInner {
                "required track finalization failed"
            } else {
                "combined audio outer flush failed"
            };
            assert_combined_error(&fixture, &probe, message).await;
        }
    }

    #[tokio::test]
    async fn combined_requested_audio_success_still_completes() {
        let directory = tempfile::tempdir().unwrap();
        let probe = CombinedProbe::new(CombinedFailure::None);
        let mut fixture = combined_actor_fixture(directory.path(), probe.clone(), true).await;
        fixture
            .audio
            .try_send(combined_audio_frame(fixture.timestamps, 0.25))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), probe.audio_observed.notified())
            .await
            .unwrap();
        let completed = fixture.handle.stop().await.unwrap();
        assert!(matches!(
            completed.meta,
            InstantRecordingMeta::Complete { .. }
        ));
        assert!(fixture.handle.done_fut().await.is_ok());
        assert_eq!(
            fixture.handle.lifecycle().quiescence(),
            InstantQuiescence::Joined
        );
        assert!(probe.source_stopped.load(Ordering::Acquire));
        assert!(probe.finalizer.finished.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn stop_waits_for_actual_blocking_finalization_before_joined_or_complete() {
        let directory = tempfile::tempdir().unwrap();
        let finalizer = Finalizer::new(false);
        let (release, blocked) = std::sync::mpsc::channel();
        *finalizer.release.lock().unwrap() = Some(blocked);
        let fixture = actor_fixture(directory.path(), finalizer.clone(), None).await;
        let handle = &fixture.handle;
        let stopping = handle.stop();
        tokio::pin!(stopping);
        tokio::select! { _ = finalizer.entered.notified() => {}, _ = &mut stopping => panic!("Stop completed before finalizer entry") }
        assert_eq!(handle.lifecycle().quiescence(), InstantQuiescence::Pending);
        assert!(handle.done_fut().now_or_never().is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut stopping)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), stopping)
            .await
            .unwrap()
            .unwrap();
        assert!(finalizer.finished.load(Ordering::Acquire));
        assert_eq!(handle.lifecycle().quiescence(), InstantQuiescence::Joined);
        assert!(handle.done_fut().await.is_ok());
    }

    #[tokio::test]
    async fn required_audio_error_stops_video_and_stays_error_for_stop_and_cancel() {
        let directory = tempfile::tempdir().unwrap();
        let video = Finalizer::new(false);
        let audio = Finalizer::new(true);
        let fixture = actor_fixture(directory.path(), video.clone(), Some(audio)).await;
        let handle = &fixture.handle;
        fixture.audio_cancel.as_ref().unwrap().cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), handle.done_fut())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("finalization failed"));
        assert!(video.finished.load(Ordering::Acquire));
        assert_eq!(handle.lifecycle().quiescence(), InstantQuiescence::Joined);
        assert!(handle.stop().await.is_err());
        assert!(handle.cancel().await.is_err());
        assert!(handle.stop().await.is_err());
    }

    #[tokio::test]
    async fn cancel_waits_for_joined_capture_and_retains_finalization_error() {
        let directory = tempfile::tempdir().unwrap();
        let finalizer = Finalizer::new(true);
        let (release, blocked) = std::sync::mpsc::channel();
        *finalizer.release.lock().unwrap() = Some(blocked);
        let fixture = actor_fixture(directory.path(), finalizer.clone(), None).await;
        let handle = &fixture.handle;
        let cancel = handle.cancel();
        tokio::pin!(cancel);
        tokio::select! { _ = finalizer.entered.notified() => {}, _ = &mut cancel => panic!("Cancel returned before encoder exit") }
        assert_eq!(handle.lifecycle().quiescence(), InstantQuiescence::Pending);
        release.send(()).unwrap();
        assert!(cancel.await.is_err());
        assert!(handle.stop().await.is_err());
        assert_eq!(handle.lifecycle().quiescence(), InstantQuiescence::Joined);
    }

    #[tokio::test]
    async fn dropped_build_waiter_keeps_native_cleanup_owned_until_exit() {
        let owner = InstantLifetimeOwner::new();
        let lifecycle = owner.lifecycle.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = finished.clone();
        let task = tokio::spawn(run_owned_instant_build(owner, async move {
            let mut tasks = TaskPool::default();
            tasks.spawn_thread("instant-build-native", move || {
                started.send(()).unwrap();
                blocked.recv().unwrap();
                worker_finished.store(true, Ordering::Release);
                Ok(())
            });
            std::future::pending::<anyhow::Result<()>>().await
        }));
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), lifecycle.wait_for_quiescence())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), lifecycle.wait_for_quiescence())
                .await
                .unwrap(),
            InstantQuiescence::Joined
        );
        assert!(finished.load(Ordering::Acquire));
        assert!(lifecycle.done_fut().await.is_err());
    }

    #[tokio::test]
    async fn build_error_waits_for_partial_native_work_before_returning() {
        let owner = InstantLifetimeOwner::new();
        let lifecycle = owner.lifecycle.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let mut task = tokio::spawn(run_owned_instant_build(owner, async move {
            let mut tasks = TaskPool::default();
            tasks.spawn_thread("instant-failed-build-native", move || {
                started.send(()).unwrap();
                blocked.recv().unwrap();
                Ok(())
            });
            Err::<(), _>(anyhow::anyhow!("later setup stage failed"))
        }));
        started_rx.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut task)
                .await
                .is_err()
        );
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Pending);
        release.send(()).unwrap();
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("later setup stage failed")
        );
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Joined);
    }

    #[tokio::test]
    async fn successful_build_disarms_its_startup_owner_without_cancelling_capture() {
        let owner = InstantLifetimeOwner::new();
        let lifecycle = owner.lifecycle.clone();
        let completion = run_owned_instant_build(owner, async {
            Ok(crate::output_pipeline::PipelineBuildScope::current()
                .unwrap()
                .task_completion())
        })
        .await
        .unwrap();
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Pending);
        assert!(!lifecycle.0.scope.cancellation().is_cancelled());
        drop(completion);
        lifecycle.cancel();
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
    }

    #[tokio::test]
    async fn unused_and_cancelled_before_build_lifetimes_are_joined_without_capture() {
        let builder = Actor::builder(PathBuf::new(), ScreenCaptureTarget::CameraOnly);
        let lifecycle = builder.lifecycle();
        drop(builder);
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
        let builder = Actor::builder(PathBuf::new(), ScreenCaptureTarget::CameraOnly);
        let lifecycle = builder.lifecycle();
        lifecycle.cancel();
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
        assert!(builder.build().await.is_err());
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Joined);
    }
    #[tokio::test]
    async fn dropped_actor_handle_retains_cleanup_until_encoder_has_exited() {
        let directory = tempfile::tempdir().unwrap();
        let finalizer = Finalizer::new(false);
        let (release, blocked) = std::sync::mpsc::channel();
        *finalizer.release.lock().unwrap() = Some(blocked);
        let fixture = actor_fixture(directory.path(), finalizer.clone(), None).await;
        let lifecycle = fixture.handle.lifecycle();
        let done = fixture.handle.done_fut();
        drop(fixture);
        finalizer.entered.notified().await;
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Pending);
        assert!(done.clone().now_or_never().is_none());
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), lifecycle.wait_for_quiescence())
                .await
                .unwrap(),
            InstantQuiescence::Joined
        );
        assert!(finalizer.finished.load(Ordering::Acquire));
        assert!(done.await.is_err());
    }
    #[tokio::test]
    async fn lost_cleanup_acknowledgement_cannot_be_upgraded_to_joined_success() {
        let lifecycle = InstantLifecycle::new();
        drop(CleanupAcknowledgement {
            lifecycle: lifecycle.clone(),
            armed: true,
        });
        lifecycle.cancel();
        assert_eq!(lifecycle.quiescence(), InstantQuiescence::Unconfirmed);
        let report = lifecycle.0.scope.cancel_and_join_report().await;
        assert!(lifecycle.complete(report, None).is_err());
        assert_eq!(
            lifecycle.wait_for_quiescence().await,
            InstantQuiescence::Unconfirmed
        );
        assert!(lifecycle.done_fut().await.is_err());
    }
}

#[cfg(all(test, not(target_os = "linux")))]
mod non_linux_stop_tests {
    use super::*;
    use crate::output_pipeline::{
        AudioFrame, AudioMuxer, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
        ChannelVideoSourceConfig, Muxer, TaskPool, VideoFrame, VideoMuxer,
    };
    use cap_timestamp::Timestamp;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    #[derive(Clone, Copy)]
    struct Frame(Timestamp);

    impl VideoFrame for Frame {
        fn timestamp(&self) -> Timestamp {
            self.0
        }
    }

    struct Finalizer {
        entered: Arc<tokio::sync::Notify>,
        finished: Arc<AtomicBool>,
        release: Option<std::sync::mpsc::Receiver<()>>,
        error: Option<&'static str>,
    }

    struct TestMuxer(Finalizer);

    impl Muxer for TestMuxer {
        type Config = Finalizer;

        async fn setup(
            config: Self::Config,
            _: PathBuf,
            _: Option<VideoInfo>,
            _: Option<cap_media_info::AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(config))
        }

        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            self.0.entered.notify_one();
            if let Some(release) = self.0.release.take() {
                release.recv()?;
            }
            self.0.finished.store(true, Ordering::Release);
            Ok(match self.0.error {
                Some(error) => Err(anyhow::anyhow!(error)),
                None => Ok(()),
            })
        }
    }

    impl VideoMuxer for TestMuxer {
        type VideoFrame = Frame;

        fn send_video_frame(&mut self, _: Frame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    impl AudioMuxer for TestMuxer {
        fn send_audio_frame(&mut self, _: AudioFrame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn stopped_actor(error: Option<String>) -> Actor {
        Actor {
            recording_dir: PathBuf::new(),
            output_dir: PathBuf::new(),
            capture_target: ScreenCaptureTarget::CameraOnly,
            video_info: VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::RGBA, 4, 4, 30),
            state: ActorState::Stopped,
            total_pause_duration: std::time::Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: error,
        }
    }

    #[tokio::test]
    async fn cancel_actor_retains_stop_error_instead_of_reporting_success() {
        let actor = Actor::spawn(stopped_actor(Some("stop cleanup failed".into())));
        for _ in 0..2 {
            assert!(
                actor
                    .ask(Stop)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("stop cleanup failed")
            );
            assert!(
                actor
                    .ask(Cancel)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("stop cleanup failed")
            );
        }
        actor.kill();
        actor.wait_for_stop().await;
    }

    async fn audio_failure_waits_for_video_and_remains_visible(cancel: bool) {
        let directory = tempfile::tempdir().unwrap();
        let timestamps = Timestamps::now();
        let video_info = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 4, 4, 30);
        let video_entered = Arc::new(tokio::sync::Notify::new());
        let video_finished = Arc::new(AtomicBool::new(false));
        let audio_finished = Arc::new(AtomicBool::new(false));
        let (release, blocked) = std::sync::mpsc::channel();
        let (video_sender, video_receiver) = flume::bounded(4);
        let video = OutputPipeline::builder(directory.path().join("display"))
            .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(
                video_info,
                video_receiver,
            ))
            .with_timestamps(timestamps)
            .build::<TestMuxer>(Finalizer {
                entered: video_entered.clone(),
                finished: video_finished.clone(),
                release: Some(blocked),
                error: None,
            })
            .await
            .unwrap();
        video_sender
            .send(Frame(Timestamp::Instant(timestamps.instant())))
            .unwrap();
        let video_cancel = video.cancel_token();

        let audio_info = cap_media_info::AudioInfo::new_raw(
            cap_media_info::Sample::F32(cap_media_info::Type::Packed),
            48_000,
            2,
        );
        let (mut audio_sender, audio_receiver) = futures::channel::mpsc::channel(4);
        let audio = OutputPipeline::builder(directory.path().join("audio"))
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                audio_info,
                audio_receiver,
            ))
            .with_timestamps(timestamps)
            .build::<TestMuxer>(Finalizer {
                entered: Arc::new(tokio::sync::Notify::new()),
                finished: audio_finished.clone(),
                release: None,
                error: Some("audio finalization failed"),
            })
            .await
            .unwrap();
        audio_sender
            .try_send(AudioFrame::new(
                audio_info.empty_frame(960),
                Timestamp::Instant(timestamps.instant()),
            ))
            .unwrap();
        let audio_done = audio.done_fut();
        let actor = Actor::spawn(Actor {
            recording_dir: directory.path().to_path_buf(),
            output_dir: directory.path().join("display"),
            capture_target: ScreenCaptureTarget::CameraOnly,
            video_info,
            state: ActorState::Recording {
                pipeline: Pipeline {
                    video,
                    audio: Some(audio),
                    video_info,
                    segments_dir: directory.path().join("display"),
                    segment_rx: None,
                },
                segment_start_time: current_time_f64(),
            },
            total_pause_duration: Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: None,
        });
        let stop_actor = actor.clone();
        let stop = tokio::spawn(async move {
            if cancel {
                stop_actor.ask(Cancel).await.map_err(|e| e.to_string())
            } else {
                stop_actor
                    .ask(Stop)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        });

        tokio::time::timeout(Duration::from_secs(2), video_cancel.cancelled())
            .await
            .unwrap();
        drop(video_sender);
        tokio::time::timeout(Duration::from_secs(2), video_entered.notified())
            .await
            .unwrap();
        let audio_error = tokio::time::timeout(Duration::from_secs(2), audio_done)
            .await
            .unwrap()
            .unwrap_err();
        assert!(
            audio_error
                .to_string()
                .contains("audio finalization failed")
        );
        assert!(audio_finished.load(Ordering::Acquire));
        assert!(!video_finished.load(Ordering::Acquire));
        assert!(!stop.is_finished());

        release.send(()).unwrap();
        let stop_error = tokio::time::timeout(Duration::from_secs(2), stop)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(stop_error.contains("audio finalization failed"));
        assert!(video_finished.load(Ordering::Acquire));
        assert!(
            actor
                .ask(Stop)
                .await
                .unwrap_err()
                .to_string()
                .contains("audio finalization failed")
        );
        assert!(
            actor
                .ask(Cancel)
                .await
                .unwrap_err()
                .to_string()
                .contains("audio finalization failed")
        );
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn stop_waits_for_video_after_audio_finalization_fails() {
        audio_failure_waits_for_video_and_remains_visible(false).await;
    }

    #[tokio::test]
    async fn cancel_waits_for_video_after_audio_finalization_fails() {
        audio_failure_waits_for_video_and_remains_visible(true).await;
    }

    #[tokio::test]
    async fn cancel_of_clean_stopped_actor_succeeds() {
        let actor = Actor::spawn(stopped_actor(None));
        actor.ask(Cancel).await.unwrap();
        actor.kill();
        actor.wait_for_stop().await;
    }
}
