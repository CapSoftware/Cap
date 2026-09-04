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
    output_pipeline::{
        AudioAnchor, AudioGapSummary, DoneFut, FinishedOutputPipeline, OutputPipeline,
        PipelineDoneError,
    },
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

const COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_WIDTH: u32 = 1600;
const COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_HEIGHT: u32 = 1000;
const UNCONFIRMED_CAPTURE_CLEANUP: &str =
    "Studio capture cleanup is unconfirmed; local recording preserved";

fn camera_active_max_capture_size(
    quality: crate::StudioQuality,
    camera_active: bool,
) -> Option<(u32, u32)> {
    if !camera_active {
        return None;
    }

    match quality {
        crate::StudioQuality::Compatibility => Some((
            COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_WIDTH,
            COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_HEIGHT,
        )),
        crate::StudioQuality::Balanced | crate::StudioQuality::Ultra => None,
    }
}

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
struct TerminalStopFailure {
    capture_stopped: bool,
    error: String,
}

#[derive(Debug, thiserror::Error)]
#[error("Studio capture stopped with unusable media: {source:#}")]
struct StudioCaptureStoppedError {
    #[source]
    source: anyhow::Error,
}

impl StudioCaptureStoppedError {
    fn new(source: anyhow::Error) -> Self {
        Self { source }
    }
}

fn studio_capture_stopped(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<StudioCaptureStoppedError>().is_some())
}

fn minimum_segment_stop_deadline(discard: bool, segment_start: Instant) -> Option<Instant> {
    (!discard).then(|| segment_start + Duration::from_secs(1))
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StudioQuiescence {
    Pending,
    Joined,
    Unconfirmed,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StudioStopIntent {
    Preserve,
    Discard,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct StudioStopReport {
    pub accepted_intent: bool,
    pub quiescence: StudioQuiescence,
    pub result: Result<CompletedRecording, String>,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct StudioLifecycle(Arc<StudioLifecycleInner>);

#[cfg(target_os = "linux")]
struct StudioLifecycleInner {
    scope: crate::output_pipeline::PipelineBuildScope,
    state: watch::Sender<StudioQuiescence>,
    failure: std::sync::Mutex<Option<String>>,
    terminal: tokio::sync::Mutex<Option<(StudioStopIntent, StudioStopReport)>>,
    terminal_started: std::sync::atomic::AtomicBool,
    runtime: std::sync::Mutex<Option<tokio::runtime::Handle>>,
}

#[cfg(target_os = "linux")]
impl StudioLifecycle {
    fn new() -> Self {
        let (state, _) = watch::channel(StudioQuiescence::Pending);
        Self(Arc::new(StudioLifecycleInner {
            scope: crate::output_pipeline::PipelineBuildScope::new_studio_lifetime(),
            state,
            failure: std::sync::Mutex::new(None),
            terminal: tokio::sync::Mutex::new(None),
            terminal_started: std::sync::atomic::AtomicBool::new(false),
            runtime: std::sync::Mutex::new(tokio::runtime::Handle::try_current().ok()),
        }))
    }

    fn fail(&self, error: String) {
        self.0.failure.lock().unwrap().get_or_insert(error);
    }

    fn failure(&self) -> Option<String> {
        self.0.failure.lock().unwrap().clone()
    }

    pub fn quiescence(&self) -> StudioQuiescence {
        *self.0.state.borrow()
    }

    pub fn terminal_started(&self) -> bool {
        self.0
            .terminal_started
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn same_attempt(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub fn cancel(&self) {
        self.0.scope.cancel();
    }

    pub async fn wait_for_quiescence(&self) -> StudioQuiescence {
        let mut state = self.0.state.subscribe();
        loop {
            let value = *state.borrow_and_update();
            if value != StudioQuiescence::Pending {
                return value;
            }
            if state.changed().await.is_err() {
                return StudioQuiescence::Unconfirmed;
            }
        }
    }

    async fn join(&self) -> StudioQuiescence {
        let report = self.0.scope.cancel_and_join_report().await;
        if let Some(error) = report.error {
            self.fail(error);
        }
        let state = if report.quiescent {
            StudioQuiescence::Joined
        } else {
            StudioQuiescence::Unconfirmed
        };
        self.0.state.send_if_modified(|current| {
            if *current == StudioQuiescence::Unconfirmed {
                return false;
            }
            *current = state;
            true
        });
        self.quiescence()
    }
}

#[cfg(target_os = "linux")]
struct StudioLifetimeOwner {
    lifecycle: StudioLifecycle,
    armed: bool,
}

#[cfg(target_os = "linux")]
impl Drop for StudioLifetimeOwner {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.lifecycle.cancel();
        let lifecycle = self.lifecycle.clone();
        let runtime = lifecycle.0.runtime.lock().unwrap().clone();
        if let Some(runtime) = runtime {
            drop(runtime.spawn(async move {
                lifecycle.join().await;
            }));
        } else {
            lifecycle
                .0
                .state
                .send_replace(StudioQuiescence::Unconfirmed);
        }
    }
}

#[derive(Clone)]
pub struct StudioStopOutcome {
    pub capture_stopped: bool,
    pub result: Result<CompletedRecording, String>,
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Clone)]
pub struct WindowsStudioStopReport {
    pub accepted_intent: bool,
    pub stop_acknowledged: bool,
    pub result: Result<CompletedRecording, String>,
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Default)]
struct WindowsStudioTerminal {
    result: tokio::sync::Mutex<Option<(StudioStopIntent, WindowsStudioStopReport)>>,
    started: std::sync::atomic::AtomicBool,
    acknowledged: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
pub struct ActorHandle {
    #[cfg(target_os = "linux")]
    lifecycle: StudioLifecycle,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    recording_dir: PathBuf,
    #[cfg(any(target_os = "macos", windows))]
    terminal: Arc<WindowsStudioTerminal>,
    actor_ref: kameo::actor::ActorRef<Actor>,
    pub capture_target: screen_capture::ScreenCaptureTarget,
    done_fut: DoneFut,
    // pub bounds: Bounds,
}

#[derive(kameo::Actor)]
pub struct Actor {
    #[cfg(target_os = "linux")]
    lifetime: StudioLifetimeOwner,
    recording_dir: PathBuf,
    state: Option<ActorState>,
    all_tracks_stopped: bool,
    terminal_stop_failure: Option<TerminalStopFailure>,
    #[cfg(windows)]
    cancel_error: Option<String>,
    segment_factory: SegmentPipelineFactory,
    #[cfg(target_os = "linux")]
    resume_attempt: Option<ResumeAttempt>,
    #[cfg(target_os = "linux")]
    resume_generation: u64,
    #[cfg(target_os = "linux")]
    resume_cleanup_error: Option<String>,
    segments: Vec<RecordingSegment>,
    completion_tx: watch::Sender<Option<Result<(), PipelineDoneError>>>,
    // Resolved once at recording start: the display can be disconnected, or its
    // mode changed, by the time the recording stops.
    display_notch: Option<cap_project::DisplayNotch>,
}

impl Actor {
    #[cfg(target_os = "linux")]
    async fn cancel_resume(&mut self) -> anyhow::Result<()> {
        if let Some(mut attempt) = self.resume_attempt.take() {
            attempt.scope.cancel();
            let finished = attempt.finished.clone().await;
            let result = attempt.result.lock().unwrap().take();
            let cleanup = match result {
                Some(Err(error)) if error.quiescent => Ok(()),
                Some(Err(error)) => {
                    let cleanup = attempt.scope.cancel_and_join().await;
                    Err(cleanup.err().map_or(error.message.clone(), |cleanup| {
                        format!("{}; {cleanup}", error.message)
                    }))
                }
                result => {
                    discard_resume_pipeline(
                        result.and_then(Result::ok),
                        &attempt.scope,
                        &attempt.directory,
                    )
                    .await
                }
            };
            attempt.reply(Err("Recording resume was cancelled".into()));
            self.resume_cleanup_error = cleanup.err().or_else(|| finished.err());
        }
        if let Some(error) = &self.resume_cleanup_error {
            bail!("Resume cleanup is unconfirmed: {error}");
        }
        Ok(())
    }

    async fn stop_pipeline(
        &mut self,
        pipeline: Pipeline,
        segment_start_time: f64,
    ) -> anyhow::Result<(Cursors, u32)> {
        tracing::info!("pipeline shutting down");

        let stopped = pipeline.stop().await;
        #[cfg(windows)]
        let stopped = stopped.map_err(|error| self.preserve_windows_stop_failure(error));
        let PipelineStopOutcome {
            mut pipeline,
            media_error,
            all_tracks_stopped,
        } = stopped?;

        tracing::info!("pipeline shutdown");

        let segment_stop_time = current_time_f64();

        let cursor_result = if let Some(cursor) = pipeline.cursor.as_mut() {
            match cursor.actor.rx.clone().await {
                Ok(result) => Some((cursor, result)),
                Err(_error) => {
                    #[cfg(windows)]
                    return Err(self.preserve_windows_stop_failure(anyhow!(
                        "Cursor shutdown acknowledgement failed: {_error}"
                    )));
                    #[cfg(not(windows))]
                    if media_error.is_some() {
                        return Err(anyhow!(
                            "Cursor shutdown acknowledgement failed after media finalization error: {_error}"
                        ));
                    } else {
                        None
                    }
                }
            }
        } else {
            None
        };
        let cursors = if let Some((cursor, res)) = cursor_result {
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
        self.all_tracks_stopped &= all_tracks_stopped;

        if let Some(error) = media_error {
            if self.all_tracks_stopped {
                return Err(anyhow::Error::new(StudioCaptureStoppedError::new(error)));
            }
            let message = format!("{UNCONFIRMED_CAPTURE_CLEANUP}: {error:#}");
            return Err(error.context(message));
        }

        Ok(cursors)
    }

    #[cfg(windows)]
    fn windows_failure(&self) -> Option<String> {
        self.cancel_error.clone().or_else(|| {
            self.completion_tx
                .borrow()
                .as_ref()
                .and_then(|result| result.as_ref().err().map(ToString::to_string))
        })
    }

    #[cfg(windows)]
    fn preserve_windows_stop_failure(&mut self, error: anyhow::Error) -> anyhow::Error {
        self.preserve_failure_evidence(error)
    }

    fn preserve_failure_evidence(&mut self, error: anyhow::Error) -> anyhow::Error {
        let error = match persist_failed_recording(&self.recording_dir, &format!("{error:#}")) {
            Ok(()) => error,
            Err(persist) => error.context(format!(
                "Could not persist failed Studio metadata: {persist:#}"
            )),
        };
        #[cfg(windows)]
        self.cancel_error
            .get_or_insert_with(|| format!("{error:#}"));
        error
    }

    fn preserve_terminal_stop_failure(
        &mut self,
        error: anyhow::Error,
        capture_stopped: bool,
    ) -> anyhow::Error {
        let error = self.preserve_failure_evidence(error);
        self.terminal_stop_failure = Some(TerminalStopFailure {
            capture_stopped,
            error: format!("{error:#}"),
        });
        error
    }

    fn notify_completion_ok(&self) {
        if self.completion_tx.borrow().is_none() {
            let _ = self.completion_tx.send(Some(Ok(())));
        }
    }

    async fn handle_stop(
        &mut self,
        discard: bool,
        ctx: &mut Context<Self, anyhow::Result<CompletedRecording>>,
    ) -> anyhow::Result<CompletedRecording> {
        #[cfg(target_os = "linux")]
        self.cancel_resume().await?;
        if let Some(failure) = self.terminal_stop_failure.as_ref() {
            let error = anyhow!(failure.error.clone());
            if failure.capture_stopped && self.all_tracks_stopped {
                let error = anyhow::Error::new(StudioCaptureStoppedError::new(error));
                let error = match ctx.actor_ref().stop_gracefully().await {
                    Ok(()) => error,
                    Err(stop_error) => error.context(format!(
                        "Studio actor stop acknowledgement failed: {stop_error}"
                    )),
                };
                return Err(error);
            }
            return Err(error);
        }
        let cursors = match self.state.take() {
            Some(ActorState::Recording {
                pipeline,
                segment_start_time,
                segment_start_instant,
                ..
            }) => {
                if let Some(deadline) =
                    minimum_segment_stop_deadline(discard, segment_start_instant)
                {
                    tokio::time::sleep_until(deadline.into()).await;
                }

                match self.stop_pipeline(pipeline, segment_start_time).await {
                    Ok((cursors, _)) => cursors,
                    Err(error) if studio_capture_stopped(&error) => {
                        let error = self.preserve_failure_evidence(error);
                        let error = match ctx.actor_ref().stop_gracefully().await {
                            Ok(()) => error,
                            Err(stop_error) => error.context(format!(
                                "Studio actor stop acknowledgement failed: {stop_error}"
                            )),
                        };
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                }
            }
            Some(ActorState::Paused { cursors, .. }) => cursors,
            _ => return Err(anyhow!("Not recording")),
        };

        if let Err(stop_error) = ctx.actor_ref().stop_gracefully().await {
            let error = anyhow!("Studio actor stop acknowledgement failed: {stop_error}");
            let error = if self.all_tracks_stopped {
                anyhow::Error::new(StudioCaptureStoppedError::new(error))
            } else {
                error
            };
            return Err(self.preserve_failure_evidence(error));
        }

        #[cfg(target_os = "linux")]
        let known_failure = {
            if self.lifetime.lifecycle.join().await != StudioQuiescence::Joined {
                bail!("Studio capture cleanup is unconfirmed; recording preserved");
            }
            self.lifetime.lifecycle.failure()
        };
        #[cfg(windows)]
        let known_failure = self.windows_failure();
        #[cfg(not(any(target_os = "linux", windows)))]
        let known_failure = None;
        let known_failure = if self.all_tracks_stopped {
            known_failure
        } else {
            Some(match known_failure {
                Some(error) => format!("{UNCONFIRMED_CAPTURE_CLEANUP}: {error}"),
                None => UNCONFIRMED_CAPTURE_CLEANUP.to_string(),
            })
        };

        let recording = stop_recording(
            self.recording_dir.clone(),
            std::mem::take(&mut self.segments),
            cursors,
            self.segment_factory.fragmented,
            self.display_notch,
            known_failure,
        )
        .await;
        let recording = match recording {
            Ok(recording) => recording,
            Err(error) => {
                let error = if self.all_tracks_stopped {
                    anyhow::Error::new(StudioCaptureStoppedError::new(error))
                } else {
                    error
                };
                return Err(self.preserve_failure_evidence(error));
            }
        };

        if !self.all_tracks_stopped {
            return Err(self.preserve_failure_evidence(anyhow!(UNCONFIRMED_CAPTURE_CLEANUP)));
        }

        self.notify_completion_ok();

        Ok(recording)
    }
}

impl Message<Stop> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(&mut self, _: Stop, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.handle_stop(false, ctx).await
    }
}

struct StopWithIntent {
    discard: bool,
}

impl Message<StopWithIntent> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(
        &mut self,
        message: StopWithIntent,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.handle_stop(message.discard, ctx).await
    }
}

struct Pause;

impl Message<Pause> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Pause, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        #[cfg(target_os = "linux")]
        self.cancel_resume().await?;
        match self.state.take() {
            Some(ActorState::Recording {
                pipeline,
                segment_start_time,
                index,
                ..
            }) => {
                let stopped = self
                    .stop_pipeline(pipeline, segment_start_time)
                    .await
                    .context("stop_pipeline");
                match stopped {
                    Ok((cursors, next_cursor_id)) if self.all_tracks_stopped => {
                        self.state = Some(ActorState::Paused {
                            next_index: index + 1,
                            cursors,
                            next_cursor_id,
                        });
                    }
                    Ok(_) => {
                        let error = anyhow!(UNCONFIRMED_CAPTURE_CLEANUP);
                        return Err(self.preserve_terminal_stop_failure(error, false));
                    }
                    Err(error) => {
                        let capture_stopped = studio_capture_stopped(&error);
                        let error = self.preserve_terminal_stop_failure(error, capture_stopped);
                        return Err(error);
                    }
                }
            }
            state => self.state = state,
        }

        Ok(())
    }
}

#[cfg(target_os = "linux")]
type ResumeCompletion =
    futures::future::Shared<futures::future::BoxFuture<'static, Result<(), String>>>;

#[cfg(target_os = "linux")]
struct ResumeBuildError {
    message: String,
    quiescent: bool,
}

#[cfg(target_os = "linux")]
struct ResumeAttempt {
    generation: u64,
    scope: crate::output_pipeline::PipelineBuildScope,
    directory: PathBuf,
    result: Arc<std::sync::Mutex<Option<Result<Pipeline, ResumeBuildError>>>>,
    finished: ResumeCompletion,
    ready: ResumeCompletion,
    reply: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
}

#[cfg(target_os = "linux")]
struct ResumeWaiterGuard(crate::output_pipeline::PipelineBuildScope);

#[cfg(target_os = "linux")]
impl Drop for ResumeWaiterGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(target_os = "linux")]
impl ResumeAttempt {
    fn ready_future(&self) -> futures::future::BoxFuture<'static, anyhow::Result<()>> {
        let ready = self.ready.clone();
        let cancellation = ResumeWaiterGuard(self.scope.clone());
        async move {
            let _cancellation = cancellation;
            ready.await.map_err(anyhow::Error::msg)
        }
        .boxed()
    }

    fn reply(&mut self, result: Result<(), String>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(result);
        }
    }
}

#[cfg(target_os = "linux")]
async fn discard_resume_pipeline(
    pipeline: Option<Pipeline>,
    scope: &crate::output_pipeline::PipelineBuildScope,
    directory: &Path,
) -> Result<(), String> {
    scope.cancel();
    let mut cursor_error = None;
    if let Some(mut pipeline) = pipeline {
        if let Some(mut cursor) = pipeline.cursor.take() {
            cursor_error = tokio::task::spawn_blocking(move || cursor.actor.stop())
                .await
                .err()
                .map(|error| format!("Cursor setup cleanup failed: {error}"));
        }
        drop(pipeline);
    }
    scope.cancel_and_join().await?;
    if let Some(error) = cursor_error {
        return Err(error);
    }
    match tokio::fs::remove_dir_all(directory).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove discarded resume segment: {error}"
        )),
    }
}

#[cfg(target_os = "linux")]
async fn prepare_resume_pipeline(
    factory: &mut SegmentPipelineFactory,
    cursors: Cursors,
    next_cursor_id: u32,
    scope: &crate::output_pipeline::PipelineBuildScope,
    directory: &Path,
) -> Result<Pipeline, ResumeBuildError> {
    let cancellation = scope.cancellation();
    let prepared = scope.run(async {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("Recording resume was cancelled".to_string()),
            result = std::panic::AssertUnwindSafe(factory.prepare_next(cursors, next_cursor_id)).catch_unwind() => {
                match result {
                    Ok(result) => result.map_err(|error| format!("{error:#}")),
                    Err(_) => Err("Recording resume setup panicked".to_string()),
                }
            }
        }
    }).await;
    let (pipeline, message) = match prepared {
        Ok(pipeline) if !cancellation.is_cancelled() => return Ok(pipeline),
        Ok(pipeline) => (Some(pipeline), "Recording resume was cancelled".to_string()),
        Err(message) => (None, message),
    };
    let cleanup = discard_resume_pipeline(pipeline, scope, directory).await;
    Err(ResumeBuildError {
        message: cleanup.as_ref().err().map_or(message.clone(), |cleanup| {
            format!("{message}; cleanup unconfirmed: {cleanup}")
        }),
        quiescent: cleanup.is_ok(),
    })
}

#[cfg(target_os = "linux")]
struct ResumeFinished(u64);

#[cfg(target_os = "linux")]
impl Message<ResumeFinished> for Actor {
    type Reply = ();

    async fn handle(&mut self, msg: ResumeFinished, _: &mut Context<Self, Self::Reply>) {
        if self
            .resume_attempt
            .as_ref()
            .is_none_or(|attempt| attempt.generation != msg.0)
        {
            return;
        }
        let mut attempt = self.resume_attempt.take().unwrap();
        let result = attempt.result.lock().unwrap().take();
        match result {
            Some(Ok(mut pipeline)) if !attempt.scope.cancellation().is_cancelled() => {
                if let Some(error) = pipeline.completed_before_resume() {
                    let cleanup =
                        discard_resume_pipeline(Some(pipeline), &attempt.scope, &attempt.directory)
                            .await;
                    self.resume_cleanup_error = cleanup.err();
                    attempt.reply(Err(error));
                    return;
                }
                if let Some(ActorState::Paused { next_index, .. }) = self.state.as_ref()
                    && attempt.scope.commit()
                {
                    let index = *next_index;
                    self.segment_factory.commit_next(&mut pipeline);
                    self.state = Some(ActorState::Recording {
                        pipeline,
                        index,
                        segment_start_time: current_time_f64(),
                        segment_start_instant: Instant::now(),
                    });
                    attempt.reply(Ok(()));
                } else {
                    let cleanup =
                        discard_resume_pipeline(Some(pipeline), &attempt.scope, &attempt.directory)
                            .await;
                    self.resume_cleanup_error = cleanup.err();
                    attempt.reply(Err("Recording changed during resume".into()));
                }
            }
            Some(Err(error)) => {
                if !error.quiescent {
                    self.resume_cleanup_error = Some(error.message.clone());
                }
                attempt.reply(Err(error.message));
            }
            result => {
                let pipeline = result.and_then(Result::ok);
                let cleanup =
                    discard_resume_pipeline(pipeline, &attempt.scope, &attempt.directory).await;
                self.resume_cleanup_error = cleanup.err();
                attempt.reply(Err("Recording resume was cancelled".into()));
            }
        }
    }
}

struct Resume;

#[cfg(target_os = "linux")]
impl Message<Resume> for Actor {
    type Reply = anyhow::Result<futures::future::BoxFuture<'static, anyhow::Result<()>>>;

    async fn handle(&mut self, _: Resume, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if !self.all_tracks_stopped {
            bail!(UNCONFIRMED_CAPTURE_CLEANUP);
        }
        if self
            .completion_tx
            .borrow()
            .as_ref()
            .is_some_and(Result::is_err)
        {
            bail!("A requested recording track failed; stop and preserve this recording");
        }
        if let Some(error) = &self.resume_cleanup_error {
            bail!("Previous resume cleanup is unconfirmed: {error}");
        }
        if let Some(attempt) = &self.resume_attempt {
            return Ok(attempt.ready_future());
        }
        let (cursors, next_cursor_id) = match &self.state {
            Some(ActorState::Paused {
                cursors,
                next_cursor_id,
                ..
            }) => (cursors.clone(), *next_cursor_id),
            Some(ActorState::Recording { .. }) => return Ok(async { Ok(()) }.boxed()),
            None => bail!("Recording is no longer active"),
        };
        let mut factory = self.segment_factory.clone();
        let directory = factory
            .segments_dir
            .join(format!("segment-{}", factory.index));
        if directory.try_exists()? {
            bail!(
                "Resume segment directory already exists; stop and recover the recording before retrying"
            );
        }
        self.resume_generation = self.resume_generation.wrapping_add(1);
        let generation = self.resume_generation;
        let scope = self.lifetime.lifecycle.0.scope.child_transaction();
        let lifetime_completion = self.lifetime.lifecycle.0.scope.task_completion();
        let result = Arc::new(std::sync::Mutex::new(None));
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let (reply, ready) = tokio::sync::oneshot::channel();
        let attempt = ResumeAttempt {
            generation,
            scope: scope.clone(),
            directory: directory.clone(),
            result: result.clone(),
            finished: async move {
                finished_rx
                    .await
                    .map_err(|_| "Resume setup task exited unexpectedly".to_string())
            }
            .boxed()
            .shared(),
            ready: async move {
                ready
                    .await
                    .map_err(|_| "Resume acknowledgement was lost".to_string())?
            }
            .boxed()
            .shared(),
            reply: Some(reply),
        };
        let ready = attempt.ready_future();
        self.resume_attempt = Some(attempt);
        let actor = ctx.actor_ref().clone();
        drop(tokio::spawn(async move {
            let prepared = std::panic::AssertUnwindSafe(prepare_resume_pipeline(
                &mut factory,
                cursors,
                next_cursor_id,
                &scope,
                &directory,
            ))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                scope.cancel();
                Err(ResumeBuildError {
                    message: "Resume setup or cleanup panicked; capture quiescence is unconfirmed"
                        .into(),
                    quiescent: false,
                })
            });
            *result.lock().unwrap() = Some(prepared);
            let _ = finished_tx.send(());
            let _ = notify_after_capture_publication(
                lifetime_completion,
                actor.tell(ResumeFinished(generation)),
            )
            .await;
        }));
        Ok(ready)
    }
}

#[cfg(target_os = "linux")]
async fn notify_after_capture_publication<T>(
    completion: crate::output_pipeline::BuildTaskCompletion,
    notification: impl std::future::IntoFuture<Output = T>,
) -> T {
    drop(completion);
    notification.await
}

#[cfg(not(target_os = "linux"))]
impl Message<Resume> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Resume, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if !self.all_tracks_stopped {
            bail!(UNCONFIRMED_CAPTURE_CLEANUP);
        }
        self.state = match self.state.take() {
            Some(ActorState::Paused {
                next_index,
                cursors,
                next_cursor_id,
            }) => {
                let pipeline = self
                    .segment_factory
                    .create_next(cursors, next_cursor_id)
                    .await;
                #[cfg(windows)]
                let pipeline = pipeline.map_err(|error| self.preserve_windows_stop_failure(error));
                let pipeline = pipeline?;

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
        #[cfg(target_os = "linux")]
        self.cancel_resume().await?;
        if let Some(failure) = self.terminal_stop_failure.as_ref() {
            bail!("Previous Studio stop failed: {}", failure.error);
        }
        #[cfg(windows)]
        if let Some(error) = &self.cancel_error {
            bail!("Previous capture cancellation failed: {error}");
        }
        if let Some(ActorState::Recording { pipeline, .. }) = self.state.take() {
            let stopped = match pipeline.stop().await {
                Ok(stopped) => stopped,
                Err(error) => {
                    let error = error.context("Pipeline stop failed during Studio cancellation");
                    return Err(self.preserve_terminal_stop_failure(error, false));
                }
            };
            let PipelineStopOutcome {
                mut media_error,
                all_tracks_stopped,
                ..
            } = stopped;
            self.all_tracks_stopped &= all_tracks_stopped;
            if !self.all_tracks_stopped {
                let error = match media_error.take() {
                    Some(error) => {
                        let message = format!("{UNCONFIRMED_CAPTURE_CLEANUP}: {error:#}");
                        error.context(message)
                    }
                    None => anyhow!(UNCONFIRMED_CAPTURE_CLEANUP),
                };
                return Err(self.preserve_terminal_stop_failure(error, false));
            }
            if let Some(error) = media_error {
                let error = error.context("Studio cancellation found unusable media");
                return Err(self.preserve_terminal_stop_failure(error, false));
            }

            #[cfg(windows)]
            if let Some(error) = self.windows_failure() {
                return Err(self.preserve_windows_stop_failure(anyhow!(error)));
            }
            self.notify_completion_ok();
        }

        #[cfg(windows)]
        if let Some(error) = self.windows_failure() {
            return Err(self.preserve_windows_stop_failure(anyhow!(error)));
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
        #[cfg(target_os = "linux")]
        if self.resume_attempt.is_some() || self.resume_cleanup_error.is_some() {
            bail!("Recording resume or its cleanup is still pending");
        }
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
        #[cfg(target_os = "linux")]
        if self.resume_attempt.is_some() || self.resume_cleanup_error.is_some() {
            bail!("Recording resume or its cleanup is still pending");
        }
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
        #[cfg(target_os = "linux")]
        if self.resume_attempt.is_some() || self.resume_cleanup_error.is_some() {
            return false;
        }
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
    #[cfg(any(target_os = "linux", windows))]
    stopping: Arc<std::sync::atomic::AtomicBool>,
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

struct PipelineStopOutcome {
    pipeline: FinishedPipeline,
    media_error: Option<anyhow::Error>,
    all_tracks_stopped: bool,
}

fn classify_pipeline_stop_errors(
    stop_errors: &[String],
    media_errors: &[String],
) -> anyhow::Result<Option<anyhow::Error>> {
    if !media_errors.is_empty() && !stop_errors.is_empty() {
        bail!(
            "Studio media failed after one producer stopped, but other capture cleanup is unconfirmed: {}; media errors: {}",
            stop_errors.join("; "),
            media_errors.join("; ")
        );
    }

    Ok((!media_errors.is_empty()).then(|| {
        anyhow!(
            "Studio media finalization failed after all capture producers stopped: {}",
            media_errors.join("; ")
        )
    }))
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
    duration: f64,
}

fn to_project_gap_summary(
    summary: Option<AudioGapSummary>,
) -> Option<cap_project::AudioGapSummary> {
    summary.map(|s| cap_project::AudioGapSummary {
        total_overlap_trimmed_ms: s.total_overlap_trimmed_ms,
        startup_overlap_trimmed_ms: s.startup_overlap_trimmed_ms,
        overlap_dropped_frames: s.overlap_dropped_frames,
        startup_overlap_drops: s.startup_overlap_drops,
    })
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
            version: 2,
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
    #[cfg(target_os = "linux")]
    fn completed_before_resume(&self) -> Option<String> {
        [
            ("display", Some(&self.screen)),
            ("microphone", self.microphone.as_ref()),
            ("camera", self.camera.as_ref()),
            ("system audio", self.system_audio.as_ref()),
        ]
        .into_iter()
        .find_map(|(track, pipeline)| {
            pipeline
                .and_then(|pipeline| pipeline.done_fut().now_or_never())
                .map(|result| match result {
                    Ok(()) => format!("{track} capture ended before resume was committed"),
                    Err(error) => {
                        format!("{track} capture failed before resume was committed: {error}")
                    }
                })
        })
    }

    pub async fn stop(mut self) -> anyhow::Result<PipelineStopOutcome> {
        #[cfg(any(target_os = "linux", windows))]
        self.stopping
            .store(true, std::sync::atomic::Ordering::Release);
        #[cfg(target_os = "macos")]
        let (screen, microphone, camera, system_audio) = {
            let (microphone, camera, (screen, system_audio)) = futures::join!(
                OptionFuture::from(self.microphone.map(|s| s.stop_with_outcome())),
                OptionFuture::from(self.camera.map(|s| s.stop_with_outcome())),
                async {
                    // These sources share a capturer; only the first stop awaits its native acknowledgement.
                    let system_audio =
                        OptionFuture::from(self.system_audio.map(|s| s.stop_with_outcome())).await;
                    (self.screen.stop_with_outcome().await, system_audio)
                }
            );
            (screen, microphone, camera, system_audio)
        };
        #[cfg(not(target_os = "macos"))]
        let (screen, microphone, camera, system_audio) = futures::join!(
            self.screen.stop_with_outcome(),
            OptionFuture::from(self.microphone.map(|s| s.stop_with_outcome())),
            OptionFuture::from(self.camera.map(|s| s.stop_with_outcome())),
            OptionFuture::from(self.system_audio.map(|s| s.stop_with_outcome()))
        );

        if let Some(cursor) = self.cursor.as_mut() {
            cursor.actor.stop();
        }

        if let Some(watcher_task) = self.watcher_task.take()
            && let Err(error) = watcher_task.await
        {
            warn!(error = %error, "Studio recording watcher task ended unexpectedly");
            return Err(anyhow!(
                "Studio recording watcher acknowledgement failed: {error}"
            ));
        }

        let stop_errors = [
            ("display", screen.as_ref().err()),
            (
                "microphone",
                microphone.as_ref().and_then(|result| result.as_ref().err()),
            ),
            (
                "camera",
                camera.as_ref().and_then(|result| result.as_ref().err()),
            ),
            (
                "system audio",
                system_audio
                    .as_ref()
                    .and_then(|result| result.as_ref().err()),
            ),
        ]
        .into_iter()
        .filter_map(|(track, error)| error.map(|error| format!("{track}: {error:#}")))
        .collect::<Vec<_>>();

        let media_errors = [
            (
                "display",
                screen
                    .as_ref()
                    .ok()
                    .and_then(|outcome| outcome.media_error.as_ref()),
            ),
            (
                "microphone",
                microphone
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|outcome| outcome.media_error.as_ref()),
            ),
            (
                "camera",
                camera
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|outcome| outcome.media_error.as_ref()),
            ),
            (
                "system audio",
                system_audio
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|outcome| outcome.media_error.as_ref()),
            ),
        ]
        .into_iter()
        .filter_map(|(track, error)| error.map(|error| format!("{track}: {error:#}")))
        .collect::<Vec<_>>();

        let media_error = classify_pipeline_stop_errors(&stop_errors, &media_errors)?;

        #[cfg(windows)]
        if !stop_errors.is_empty() {
            bail!(
                "Requested Studio track stop failed; capture cleanup is unconfirmed: {}",
                stop_errors.join("; ")
            );
        }

        let microphone = microphone
            .transpose()
            .map(|outcome| outcome.map(|outcome| outcome.finished));
        let camera = camera
            .transpose()
            .map(|outcome| outcome.map(|outcome| outcome.finished));
        let system_audio = system_audio
            .transpose()
            .map(|outcome| outcome.map(|outcome| outcome.finished));

        Ok(PipelineStopOutcome {
            pipeline: FinishedPipeline {
                start_time: self.start_time,
                screen: screen.context("display")?.finished,
                microphone: finalize_optional_track(
                    RecordingTrackKind::Microphone,
                    microphone,
                    &self.track_failures,
                ),
                camera: finalize_optional_track(
                    RecordingTrackKind::Camera,
                    camera,
                    &self.track_failures,
                ),
                system_audio: finalize_optional_track(
                    RecordingTrackKind::SystemAudio,
                    system_audio,
                    &self.track_failures,
                ),
                cursor: self.cursor,
                track_failures: take_track_failures(&self.track_failures),
            },
            media_error,
            all_tracks_stopped: stop_errors.is_empty(),
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
        #[cfg(not(any(target_os = "linux", windows)))]
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

        #[cfg(any(target_os = "linux", windows))]
        let cancel_tokens = [
            Some(self.screen.cancel_token()),
            self.microphone.as_ref().map(OutputPipeline::cancel_token),
            self.camera.as_ref().map(OutputPipeline::cancel_token),
            self.system_audio.as_ref().map(OutputPipeline::cancel_token),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        #[cfg(any(target_os = "linux", windows))]
        let stopping = self.stopping.clone();
        let track_failures = self.track_failures.clone();
        self.watcher_task = Some(tokio::spawn(async move {
            while let Some((track, required, res)) = futures.next().await {
                #[cfg(any(target_os = "linux", windows))]
                let res = match res {
                    Ok(()) if !stopping.load(std::sync::atomic::Ordering::Acquire) => {
                        Err(PipelineDoneError::from_message(format!(
                            "Requested {track:?} track ended before Stop"
                        )))
                    }
                    result => result,
                };
                if let Err(err) = res {
                    let required = required || cfg!(any(target_os = "linux", windows));
                    if required {
                        record_track_failure(
                            &track_failures,
                            track,
                            TrackFailureStage::Runtime,
                            err.to_string(),
                        );
                        #[cfg(any(target_os = "linux", windows))]
                        {
                            stopping.store(true, std::sync::atomic::Ordering::Release);
                            for token in &cancel_tokens {
                                token.cancel();
                            }
                        }
                        completion_tx.send_if_modified(|current| {
                            if current.is_none() {
                                *current = Some(Err(err.clone()));
                                true
                            } else {
                                false
                            }
                        });
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
        self.stop_with_outcome()
            .await
            .result
            .map_err(anyhow::Error::msg)
    }

    pub async fn stop_with_outcome(&self) -> StudioStopOutcome {
        #[cfg(target_os = "linux")]
        {
            let report = self.stop_with_report().await;
            let capture_stopped =
                report.accepted_intent && report.quiescence == StudioQuiescence::Joined;
            let result = if capture_stopped {
                report.result
            } else {
                Err(report.result.err().unwrap_or_else(|| {
                    "Studio capture cleanup is unconfirmed; local recording preserved".into()
                }))
            };
            StudioStopOutcome {
                capture_stopped,
                result,
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let report = self.stop_with_intent(StudioStopIntent::Preserve).await;
            let capture_stopped = report.accepted_intent && report.stop_acknowledged;
            let result = if capture_stopped {
                report.result
            } else {
                Err(report.result.err().unwrap_or_else(|| {
                    "Studio stop is unconfirmed; terminal acknowledgement missing".into()
                }))
            };
            StudioStopOutcome {
                capture_stopped,
                result,
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            let result = self.actor_ref.ask(Stop).await;
            let capture_stopped = match &result {
                Ok(_) => true,
                Err(kameo::error::SendError::HandlerError(error)) => studio_capture_stopped(error),
                Err(_) => false,
            };
            StudioStopOutcome {
                capture_stopped,
                result: result.map_err(|error| format!("{error:#}")),
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub fn lifecycle(&self) -> StudioLifecycle {
        self.lifecycle.clone()
    }

    #[cfg(target_os = "linux")]
    pub async fn stop_with_report(&self) -> StudioStopReport {
        self.stop_with_intent(StudioStopIntent::Preserve).await
    }

    #[cfg(target_os = "linux")]
    pub async fn stop_with_intent(&self, intent: StudioStopIntent) -> StudioStopReport {
        let lifecycle = self.lifecycle.clone();
        let actor = self.actor_ref.clone();
        let recording_dir = self.recording_dir.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        drop(tokio::spawn(async move {
            let mut terminal = lifecycle.0.terminal.lock().await;
            let report = match terminal.as_ref() {
                Some((previous, report)) if *previous == intent => report.clone(),
                Some((_, report)) => StudioStopReport {
                    accepted_intent: false,
                    quiescence: report.quiescence,
                    result: Err(
                        "A different Studio terminal action already owns this attempt".into(),
                    ),
                },
                None => {
                    lifecycle
                        .0
                        .terminal_started
                        .store(true, std::sync::atomic::Ordering::Release);
                    let result = actor
                        .ask(StopWithIntent {
                            discard: intent == StudioStopIntent::Discard,
                        })
                        .await
                        .map_err(|error| format!("{error:#}"));
                    if let Err(error) = &result {
                        lifecycle.fail(error.clone());
                    }
                    let quiescence = lifecycle.join().await;
                    let result = match lifecycle.failure() {
                        Some(error) => {
                            if let Err(persist_error) =
                                persist_failed_recording(&recording_dir, &error)
                            {
                                Err(format!(
                                    "{error}; failed to persist failure metadata: {persist_error:#}"
                                ))
                            } else {
                                Err(error)
                            }
                        }
                        None => result,
                    };
                    let report = StudioStopReport {
                        accepted_intent: true,
                        quiescence,
                        result,
                    };
                    *terminal = Some((intent, report.clone()));
                    report
                }
            };
            let _ = sender.send(report);
        }));
        receiver.await.unwrap_or_else(|_| StudioStopReport {
            accepted_intent: false,
            quiescence: StudioQuiescence::Unconfirmed,
            result: Err("Studio terminal cleanup acknowledgement lost".into()),
        })
    }

    #[cfg(any(target_os = "macos", windows))]
    pub fn same_attempt(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.terminal, &other.terminal)
    }

    #[cfg(any(target_os = "macos", windows))]
    pub fn terminal_started(&self) -> bool {
        self.terminal
            .started
            .load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(any(target_os = "macos", windows))]
    pub fn stop_acknowledged(&self) -> bool {
        self.terminal
            .acknowledged
            .load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(any(target_os = "macos", windows))]
    pub async fn stop_with_intent(&self, intent: StudioStopIntent) -> WindowsStudioStopReport {
        let terminal = self.terminal.clone();
        let actor = self.actor_ref.clone();
        let recording_dir = self.recording_dir.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        drop(tokio::spawn(async move {
            let mut cached = terminal.result.lock().await;
            let report = match cached.as_ref() {
                Some((previous, report)) if *previous == intent => report.clone(),
                Some((_, report)) => WindowsStudioStopReport {
                    accepted_intent: false,
                    stop_acknowledged: report.stop_acknowledged,
                    result: Err("Another Studio terminal action owns this attempt".into()),
                },
                None => {
                    terminal
                        .started
                        .store(true, std::sync::atomic::Ordering::Release);
                    let result = actor
                        .ask(StopWithIntent {
                            discard: intent == StudioStopIntent::Discard,
                        })
                        .await;
                    let stop_acknowledged = match &result {
                        Ok(_) => true,
                        Err(kameo::error::SendError::HandlerError(error)) => {
                            studio_capture_stopped(error)
                        }
                        Err(_) => false,
                    };
                    let result = result.map_err(|error| format!("{error:#}"));
                    let result = match result {
                        Err(error) => match persist_failed_recording(&recording_dir, &error) {
                            Ok(()) => Err(error),
                            Err(persist) => Err(format!(
                                "{error}; failed to preserve Failed metadata: {persist:#}"
                            )),
                        },
                        result => result,
                    };
                    let report = WindowsStudioStopReport {
                        accepted_intent: true,
                        stop_acknowledged,
                        result,
                    };
                    terminal.acknowledged.store(
                        report.stop_acknowledged,
                        std::sync::atomic::Ordering::Release,
                    );
                    *cached = Some((intent, report.clone()));
                    report
                }
            };
            let _ = sender.send(report);
        }));
        receiver.await.unwrap_or_else(|_| WindowsStudioStopReport {
            accepted_intent: false,
            stop_acknowledged: false,
            result: Err("Studio terminal acknowledgement lost; local files preserved".into()),
        })
    }

    pub fn done_fut(&self) -> DoneFut {
        self.done_fut.clone()
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        #[cfg(any(target_os = "macos", windows))]
        if self.terminal_started() {
            bail!("Studio terminal cleanup already owns this attempt");
        }
        Ok(self.actor_ref.ask(Pause).await?)
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        #[cfg(windows)]
        if self.terminal_started() {
            bail!("Studio terminal cleanup already owns this attempt");
        }
        #[cfg(target_os = "linux")]
        {
            self.actor_ref.ask(Resume).await?.await
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(self.actor_ref.ask(Resume).await?)
        }
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        #[cfg(target_os = "linux")]
        {
            let report = self.stop_with_intent(StudioStopIntent::Discard).await;
            if !report.accepted_intent || report.quiescence != StudioQuiescence::Joined {
                bail!("Studio cancellation cleanup is unconfirmed");
            }
            report.result.map(|_| ()).map_err(anyhow::Error::msg)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(self.actor_ref.ask(Cancel).await?)
        }
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
    #[cfg(target_os = "linux")]
    lifetime: StudioLifetimeOwner,
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
            #[cfg(target_os = "linux")]
            lifetime: StudioLifetimeOwner {
                lifecycle: StudioLifecycle::new(),
                armed: true,
            },
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

    #[cfg(target_os = "linux")]
    pub fn lifecycle(&self) -> StudioLifecycle {
        self.lifetime.lifecycle.clone()
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: Option<SendableShareableContent>,
    ) -> anyhow::Result<ActorHandle> {
        #[cfg(any(target_os = "linux", windows))]
        let recording_dir = self.output_path.clone();
        #[cfg(target_os = "linux")]
        let lifecycle = self.lifetime.lifecycle.clone();
        #[cfg(target_os = "linux")]
        {
            *lifecycle.0.runtime.lock().unwrap() = Some(tokio::runtime::Handle::current());
        }
        let startup = spawn_studio_recording_actor(
            #[cfg(target_os = "linux")]
            self.lifetime,
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
        );
        #[cfg(windows)]
        {
            let scope = crate::output_pipeline::PipelineBuildScope::new();
            let result =
                crate::output_pipeline::finish_windows_pipeline_startup(&scope, startup).await;
            match result {
                Err(error) if recording_dir.join("recording-meta.json").exists() => {
                    match persist_failed_recording(&recording_dir, &format!("{error:#}")) {
                        Ok(()) => Err(error),
                        Err(persist) => Err(error.context(format!(
                            "Could not preserve failed Studio startup: {persist:#}"
                        ))),
                    }
                }
                result => result,
            }
        }
        #[cfg(target_os = "linux")]
        {
            let result = lifecycle.0.scope.run(startup).await;
            if let Err(error) = &result {
                lifecycle.fail(format!("{error:#}"));
                lifecycle.join().await;
                if recording_dir.join("recording-meta.json").exists()
                    && let Err(persist_error) =
                        persist_failed_recording(&recording_dir, &format!("{error:#}"))
                {
                    warn!(%persist_error, "Failed to persist Studio startup failure");
                }
            }
            result
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        startup.await
    }
}

#[tracing::instrument("studio_recording", skip_all)]
#[allow(clippy::too_many_arguments)]
async fn spawn_studio_recording_actor(
    #[cfg(target_os = "linux")] lifetime: StudioLifetimeOwner,
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

    #[cfg(target_os = "linux")]
    let lifecycle = lifetime.lifecycle.clone();
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

    if fragmented || cfg!(any(target_os = "linux", windows)) {
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

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    let actor_recording_dir = recording_dir.clone();
    let actor_ref = Actor::spawn(Actor {
        #[cfg(target_os = "linux")]
        lifetime,
        #[cfg(windows)]
        cancel_error: None,
        recording_dir,
        state: Some(ActorState::Recording {
            pipeline,
            /*pipeline_done_rx,*/
            index,
            segment_start_time,
            segment_start_instant: Instant::now(),
        }),
        all_tracks_stopped: true,
        terminal_stop_failure: None,
        segment_factory: segment_pipeline_factory,
        #[cfg(target_os = "linux")]
        resume_attempt: None,
        #[cfg(target_os = "linux")]
        resume_generation: 0,
        #[cfg(target_os = "linux")]
        resume_cleanup_error: None,
        segments: Vec::new(),
        completion_tx: completion_tx.clone(),
        display_notch: crate::capture_pipeline::resolve_display_notch(&base_inputs.capture_target),
    });

    Ok(ActorHandle {
        #[cfg(target_os = "linux")]
        lifecycle,
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        recording_dir: actor_recording_dir,
        #[cfg(any(target_os = "macos", windows))]
        terminal: Arc::new(WindowsStudioTerminal::default()),
        actor_ref,
        capture_target: base_inputs.capture_target,
        done_fut,
    })
}

#[derive(Clone)]
pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
    pub cursor_data: cap_project::CursorImages,
}

fn snap_nearby_start_time(
    raw_start: f64,
    reference_start: Option<f64>,
    threshold_secs: f64,
) -> f64 {
    match reference_start {
        Some(reference_start) if (raw_start - reference_start).abs() <= threshold_secs => {
            reference_start
        }
        _ => raw_start,
    }
}

async fn stop_recording(
    recording_dir: PathBuf,
    segments: Vec<RecordingSegment>,
    cursors: Cursors,
    fragmented: bool,
    display_notch: Option<cap_project::DisplayNotch>,
    known_failure: Option<String>,
) -> anyhow::Result<CompletedRecording> {
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
                snap_nearby_start_time(raw_camera_start, mic_start_time, CROSS_TRACK_SNAP_SECS)
            });

            let raw_display_start = to_start_time(s.pipeline.screen.first_timestamp);
            let display_start_time = if camera_start_time.is_some() {
                snap_nearby_start_time(raw_display_start, camera_start_time, CROSS_TRACK_SNAP_SECS)
            } else {
                snap_nearby_start_time(raw_display_start, mic_start_time, CROSS_TRACK_SNAP_SECS)
            };

            let diagnostics =
                (!s.pipeline.track_failures.is_empty()).then(|| SegmentFailureDiagnostics {
                    segment_index: segment_index as u32,
                    start: s.start,
                    end: s.end,
                    track_failures: s.pipeline.track_failures.clone(),
                });

            let display_fps = s
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
                });
            // Use the encoded display-media span (first to last muxed timestamp plus one
            // nominal frame), not the wall-clock recording span which includes
            // pipeline-drain latency, and not frame_count / fps, which under-reports VFR
            // content by the length of every capture gap (static screens, dropped frames).
            // This is the timeline the recorder persists to project-config.json, so it is
            // what un-edited recordings use.
            let display_media_duration = match s.pipeline.screen.video_timestamp_span {
                Some((first, last)) if display_fps > 0 => {
                    last.saturating_sub(first).as_secs_f64() + 1.0 / f64::from(display_fps)
                }
                _ if display_fps > 0 => {
                    s.pipeline.screen.video_frame_count as f64 / f64::from(display_fps)
                }
                _ => 0.0,
            };

            // Non-fragmented recordings have their final display file already;
            // verify the muxed container matches the timestamps we sent it.
            // Fragmented recordings get the same check after remux in recovery.
            if s.pipeline
                .screen
                .path
                .extension()
                .is_some_and(|e| e == "mp4")
                && s.pipeline.screen.path.is_file()
                && display_media_duration > 0.0
            {
                crate::output_validation::check_display_sync_span(
                    &s.pipeline.screen.path,
                    Duration::from_secs_f64(display_media_duration),
                );
            }

            SegmentOutput {
                meta: MultipleSegment {
                    display: VideoMeta {
                        path: make_relative(&s.pipeline.screen.path),
                        fps: display_fps,
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
                        gap_summary: to_project_gap_summary(mic.audio_gap_summary),
                    }),
                    system_audio: s.pipeline.system_audio.map(|audio| {
                        let raw_sys_start = to_start_time(audio.first_timestamp);
                        let sys_start_time = if let Some(mic_start) = mic_start_time {
                            snap_nearby_start_time(
                                raw_sys_start,
                                Some(mic_start),
                                CROSS_TRACK_SNAP_SECS,
                            )
                        } else {
                            snap_nearby_start_time(
                                raw_sys_start,
                                Some(display_start_time),
                                CROSS_TRACK_SNAP_SECS,
                            )
                        };
                        AudioMeta {
                            path: make_relative(&audio.path),
                            start_time: Some(sys_start_time),
                            device_id: None,
                            gap_summary: to_project_gap_summary(audio.audio_gap_summary),
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
                    display_notch,
                },
                diagnostics,
                duration: display_media_duration,
            }
        })
        .collect();
    let timeline_segments: Vec<_> = segment_outputs
        .iter()
        .enumerate()
        .filter_map(|(i, segment)| {
            (segment.duration > 0.0).then_some(TimelineSegment {
                recording_clip: i as u32,
                start: 0.0,
                end: segment.duration,
                timescale: 1.0,
                name: None,
                speed_audio_mode: None,
                audio_muted: false,
            })
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
    let clip_configs = segment_metas
        .iter()
        .all(|segment| segment.camera.is_none())
        .then(|| {
            segment_metas
                .iter()
                .enumerate()
                .map(|(i, segment)| ClipConfiguration {
                    index: i as u32,
                    offsets: segment.calculate_audio_offsets(),
                    offsets_auto_calculated: true,
                })
                .collect::<Vec<_>>()
        });

    let needs_remux = if fragmented {
        segment_metas.iter().any(|seg| {
            let display_path = seg.display.path.to_path(&recording_dir);
            display_path.is_dir()
        })
    } else {
        false
    };

    let required_track_failure = known_failure.or_else(|| {
        segment_failure_diagnostics.first().map(|segment| {
            let failure = &segment.track_failures[0];
            format!(
                "Requested {:?} track failed in segment {}: {}",
                failure.track, segment.segment_index, failure.error
            )
        })
    });
    let status = if let Some(error) = required_track_failure.as_ref() {
        Some(StudioRecordingStatus::Failed {
            error: error.clone(),
        })
    } else if needs_remux {
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

    if let Some(diagnostics) = build_recording_failure_diagnostics(&segment_failure_diagnostics)
        && let Err(error) = write_recording_failure_diagnostics(&recording_dir, &diagnostics)
    {
        warn!(
            error = %error,
            path = %recording_dir.join("recording-diagnostics.json").display(),
            "Failed to persist recording diagnostics sidecar"
        );
    }

    persist_final_recording_meta(&recording_dir, &meta)?;

    let mut project_config = cap_project::ProjectConfiguration::default();
    if !timeline_segments.is_empty() {
        project_config.timeline = Some(TimelineConfiguration {
            segments: timeline_segments,
            transitions: Vec::new(),
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
        });
    }
    if let Some(clips) = clip_configs {
        project_config.clips = clips;
    }
    project_config
        .write(&recording_dir)
        .map_err(RecordingError::from)?;

    if let Some(error) = required_track_failure {
        bail!(error);
    }

    Ok(CompletedRecording {
        project_path: recording_dir,
        meta,
        cursor_data: Default::default(),
        // display_source: actor.options.capture_target,
        // segments: actor.segments,
    })
}

#[cfg(all(test, target_os = "linux"))]
type ResumeTestFactory = Arc<
    dyn Fn(Cursors, u32) -> futures::future::BoxFuture<'static, anyhow::Result<Pipeline>>
        + Send
        + Sync,
>;

#[derive(Clone)]
struct SegmentPipelineFactory {
    #[cfg(all(test, target_os = "linux"))]
    prepare_override: Option<ResumeTestFactory>,
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
            #[cfg(all(test, target_os = "linux"))]
            prepare_override: None,
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

    #[cfg(target_os = "linux")]
    pub async fn create_next(
        &mut self,
        cursors: Cursors,
        next_cursors_id: u32,
    ) -> anyhow::Result<Pipeline> {
        let mut pipeline = self.prepare_next(cursors, next_cursors_id).await?;
        self.commit_next(&mut pipeline);
        Ok(pipeline)
    }

    #[cfg(target_os = "linux")]
    async fn prepare_next(
        &mut self,
        cursors: Cursors,
        next_cursors_id: u32,
    ) -> anyhow::Result<Pipeline> {
        #[cfg(test)]
        if let Some(prepare) = &self.prepare_override {
            return prepare(cursors, next_cursors_id).await;
        }
        let segment_start_time = Timestamps::now();
        create_segment_pipeline(
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
        .await
    }

    #[cfg(target_os = "linux")]
    fn commit_next(&mut self, pipeline: &mut Pipeline) {
        self.index += 1;
        pipeline.spawn_watcher(self.completion_tx.clone());
    }

    #[cfg(not(target_os = "linux"))]
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
                #[cfg(target_os = "linux")]
                return Err(PipelineDoneError::from_message(
                    "Studio completion acknowledgement was lost".into(),
                ));
                #[cfg(not(target_os = "linux"))]
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

    let camera_active = base_inputs.camera_feed.is_some();
    #[cfg(target_os = "macos")]
    let segment_fragmented = fragmented && !camera_active;
    #[cfg(not(target_os = "macos"))]
    let segment_fragmented = fragmented;

    let shared_pause_state = if segment_fragmented {
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
    #[cfg(target_os = "linux")]
    let custom_cursor_capture = custom_cursor_capture && !screen_capture::prefers_wayland_portal();
    #[cfg(target_os = "linux")]
    let mut start_time = start_time;

    let (screen, system_audio, cursor_display) = if camera_only {
        #[cfg(target_os = "linux")]
        {
            let camera_feed = base_inputs.camera_feed.clone().ok_or_else(|| {
                anyhow!(
                    "Camera-only recording requires a camera, but no camera is currently available. \
                    Please select a camera in the recording settings before starting. \
                    If you have already selected a camera, it may have been disconnected or \
                    failed to initialize. Try reconnecting your camera or selecting a different one."
                )
            })?;

            let builder = if segment_fragmented {
                OutputPipeline::builder(dir.join("display"))
            } else {
                OutputPipeline::builder(screen_output_path.clone())
            }
            .with_video::<sources::Camera>(camera_feed)
            .with_timestamps(start_time);

            let screen = if segment_fragmented {
                builder
                    .build::<crate::ffmpeg::SegmentedVideoMuxer>(
                        crate::ffmpeg::SegmentedVideoMuxerConfig {
                            segment_duration: Duration::from_secs(2),
                            shared_pause_state: shared_pause_state.clone(),
                            ..Default::default()
                        },
                    )
                    .instrument(error_span!("screen-out"))
                    .await
            } else {
                builder
                    .build::<crate::ffmpeg::Mp4Muxer>(())
                    .instrument(error_span!("screen-out"))
                    .await
            }
            .context("camera-only screen pipeline setup")?;

            (screen, None, None)
        }

        #[cfg(any(target_os = "macos", windows))]
        {
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
        }
    } else {
        let capture_target = base_inputs.capture_target.clone();

        #[cfg(windows)]
        let d3d_device = d3d_device;

        let (display, crop) =
            target_to_display_and_crop(&capture_target).context("target_display_crop")?;
        let compatibility_quality = matches!(quality, crate::StudioQuality::Compatibility);
        let max_capture_size = camera_active_max_capture_size(quality, camera_active);
        let effective_max_fps = if compatibility_quality && camera_active {
            max_fps.min(24)
        } else {
            max_fps
        };

        let screen_config = ScreenCaptureConfig::<ScreenCaptureMethod>::init(
            display,
            crop,
            !custom_cursor_capture,
            effective_max_fps,
            max_capture_size,
            start_time.system_time(),
            base_inputs.capture_system_audio,
            #[cfg(target_os = "linux")]
            sources::screen_capture::LinuxCaptureSource::from_target(&capture_target),
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
        #[cfg(target_os = "linux")]
        {
            start_time = Timestamps::now();
        }

        let screen = ScreenCaptureMethod::make_studio_mode_pipeline(
            capture_source,
            screen_output_path.clone(),
            start_time,
            segment_fragmented,
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
        let pipeline = if segment_fragmented {
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
                .build::<AVFoundationCameraMuxer>(AVFoundationCameraMuxerConfig {
                    compatibility_quality: matches!(quality, crate::StudioQuality::Compatibility),
                    ..Default::default()
                })
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
        let pipeline = if segment_fragmented {
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

    #[cfg(target_os = "linux")]
    let camera = if camera_only {
        None
    } else if let Some(camera_feed) = base_inputs.camera_feed {
        let pipeline = if segment_fragmented {
            OutputPipeline::builder(dir.join("camera"))
                .with_video::<sources::Camera>(camera_feed)
                .with_timestamps(start_time)
                .build::<crate::ffmpeg::SegmentedVideoMuxer>(
                    crate::ffmpeg::SegmentedVideoMuxerConfig {
                        segment_duration: Duration::from_secs(2),
                        shared_pause_state: shared_pause_state.clone(),
                        ..Default::default()
                    },
                )
                .instrument(error_span!("camera-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("camera.mp4"))
                .with_video::<sources::Camera>(camera_feed)
                .with_timestamps(start_time)
                .build::<crate::ffmpeg::Mp4Muxer>(())
                .instrument(error_span!("camera-out"))
                .await
        };
        Some(pipeline.context("camera pipeline setup")?)
    } else {
        None
    };

    let microphone = if let Some(mic_feed) = base_inputs.mic_feed {
        let pipeline = if segment_fragmented {
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
        // System audio is intermittent (WASAPI loopback only delivers while
        // sound plays), so its first packet is not a "source ready" marker:
        // anchor the track at the recording epoch. This keeps a late first
        // sound from becoming the latest start_time and cutting the head off
        // the display/mic/camera tracks at playback.
        let pipeline = if segment_fragmented {
            let output_path = dir.join("system_audio.m4a");
            OutputPipeline::builder(output_path)
                .with_audio_source::<screen_capture::SystemAudioSource>(system_audio_source)
                .with_timestamps(start_time)
                .with_audio_anchor(AudioAnchor::PipelineEpoch)
                .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
                    shared_pause_state: shared_pause_state.clone(),
                })
                .instrument(error_span!("system-audio-out"))
                .await
        } else {
            OutputPipeline::builder(dir.join("system_audio.ogg"))
                .with_audio_source::<screen_capture::SystemAudioSource>(system_audio_source)
                .with_timestamps(start_time)
                .with_audio_anchor(AudioAnchor::PipelineEpoch)
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
                    crate::cursor::CursorCaptureTarget {
                        crop_bounds: cursor_crop_bounds,
                        display: cursor_display,
                        #[cfg(target_os = "linux")]
                        window: base_inputs.capture_target.window(),
                    },
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
        #[cfg(any(target_os = "linux", windows))]
        stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

fn persist_failed_recording(recording_dir: &Path, error: &str) -> anyhow::Result<()> {
    let mut meta = RecordingMeta::load_for_project(recording_dir)
        .map_err(|error| anyhow!("load failed Studio recording metadata: {error}"))?;
    let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
        bail!("Failed Studio recording has incompatible metadata");
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        bail!("Failed Studio recording has incompatible segment metadata");
    };
    inner.status = Some(StudioRecordingStatus::Failed {
        error: error.to_string(),
    });
    meta.save_for_project()
        .context("persist failed Studio metadata")
}

fn persist_final_recording_meta(
    recording_dir: &Path,
    studio_meta: &StudioRecordingMeta,
) -> anyhow::Result<()> {
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

    recording_meta
        .save_for_project()
        .context("persist final recording metadata")
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
        AudioMuxer, AudioSource, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
        ChannelVideoSourceConfig, Muxer, SetupCtx, TaskPool, VideoFrame, VideoMuxer,
    };

    #[test]
    fn media_failure_requires_every_producer_stop_to_be_confirmed() {
        let error = classify_pipeline_stop_errors(
            &["microphone: stop timed out".into()],
            &["display: subprocess exited".into()],
        )
        .expect_err("one stopped producer cannot acknowledge the whole Studio pipeline");

        assert!(error.to_string().contains("cleanup is unconfirmed"));
    }

    #[test]
    fn media_failure_remains_visible_after_every_producer_stops() {
        let error = classify_pipeline_stop_errors(&[], &["display: subprocess exited".into()])
            .expect("confirmed producer stops should return the media result")
            .expect("unusable media must remain an error");

        assert!(error.to_string().contains("all capture producers stopped"));
    }

    #[test]
    fn discard_skips_the_minimum_segment_deadline() {
        let segment_start = Instant::now();

        assert_eq!(minimum_segment_stop_deadline(true, segment_start), None);
        assert_eq!(
            minimum_segment_stop_deadline(false, segment_start),
            Some(segment_start + Duration::from_secs(1))
        );
    }

    #[cfg(any(target_os = "macos", windows))]
    fn terminal_failure_handle(path: &Path) -> ActorHandle {
        let (completion_tx, completion_rx) = watch::channel(None);
        let target = screen_capture::ScreenCaptureTarget::CameraOnly;
        let segment_factory = SegmentPipelineFactory::new(
            path.join("content/segments"),
            path.join("content/cursors"),
            RecordingBaseInputs {
                capture_target: target.clone(),
                capture_system_audio: false,
                mic_feed: None,
                camera_feed: None,
                #[cfg(target_os = "macos")]
                shareable_content: None,
                #[cfg(target_os = "macos")]
                excluded_windows: Vec::new(),
            },
            false,
            false,
            false,
            false,
            30,
            crate::StudioQuality::Balanced,
            completion_tx.clone(),
        );
        let mut actor = Actor {
            recording_dir: path.to_path_buf(),
            state: None,
            all_tracks_stopped: true,
            terminal_stop_failure: None,
            #[cfg(windows)]
            cancel_error: None,
            segment_factory,
            segments: Vec::new(),
            completion_tx,
            display_notch: None,
        };
        let error = anyhow::Error::new(StudioCaptureStoppedError::new(anyhow!(
            "pause found unusable media"
        )));
        let error = actor.preserve_terminal_stop_failure(error, true);
        assert!(studio_capture_stopped(&error));
        let actor_ref = Actor::spawn(actor);
        ActorHandle {
            recording_dir: path.to_path_buf(),
            terminal: Arc::new(WindowsStudioTerminal::default()),
            actor_ref,
            capture_target: target,
            done_fut: completion_rx_to_done_fut(completion_rx),
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn pause_media_failure_replays_as_acknowledged_terminal_error() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("content")).unwrap();
        write_in_progress_meta(temp.path()).unwrap();
        std::fs::write(temp.path().join("content/partial.m4s"), b"partial").unwrap();
        let handle = terminal_failure_handle(temp.path());
        assert!(matches!(
            RecordingMeta::load_for_project(temp.path())
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Failed { .. }
        ));

        let report = handle.stop_with_intent(StudioStopIntent::Preserve).await;
        assert!(report.accepted_intent);
        assert!(report.stop_acknowledged);
        let error = report
            .result
            .err()
            .expect("media failure must remain visible");
        assert!(handle.stop_acknowledged());
        assert!(matches!(
            RecordingMeta::load_for_project(temp.path())
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Failed { .. }
        ));
        assert_eq!(
            std::fs::read(temp.path().join("content/partial.m4s")).unwrap(),
            b"partial"
        );

        let replay = handle.stop_with_intent(StudioStopIntent::Preserve).await;
        assert!(replay.accepted_intent);
        assert!(replay.stop_acknowledged);
        assert_eq!(replay.result.err().expect("cached media failure"), error);
    }

    #[cfg(target_os = "macos")]
    fn prior_unconfirmed_optional_stop_handle(path: &Path) -> ActorHandle {
        let (completion_tx, completion_rx) = watch::channel(None);
        let target = screen_capture::ScreenCaptureTarget::CameraOnly;
        let segment_factory = SegmentPipelineFactory::new(
            path.join("content/segments"),
            path.join("content/cursors"),
            RecordingBaseInputs {
                capture_target: target.clone(),
                capture_system_audio: false,
                mic_feed: None,
                camera_feed: None,
                shareable_content: None,
                excluded_windows: Vec::new(),
            },
            false,
            false,
            true,
            false,
            30,
            crate::StudioQuality::Balanced,
            completion_tx.clone(),
        );
        let timestamps = Timestamps::now();
        let actor_ref = Actor::spawn(Actor {
            recording_dir: path.to_path_buf(),
            state: Some(ActorState::Paused {
                next_index: 1,
                cursors: Default::default(),
                next_cursor_id: 0,
            }),
            all_tracks_stopped: false,
            terminal_stop_failure: None,
            segment_factory,
            segments: vec![RecordingSegment {
                start: 0.0,
                end: 1.0,
                pipeline: FinishedPipeline {
                    start_time: timestamps,
                    screen: test_finished_output_pipeline_at(
                        path.join("content/partial.m4s"),
                        Timestamp::Instant(timestamps.instant()),
                        Some(test_video_info()),
                        1,
                    ),
                    microphone: None,
                    camera: None,
                    system_audio: None,
                    cursor: None,
                    track_failures: vec![TrackFailureRecord {
                        track: RecordingTrackKind::Camera,
                        stage: TrackFailureStage::Stop,
                        error: "camera encoder join timed out".into(),
                    }],
                },
                camera_device_id: None,
                mic_device_id: None,
            }],
            completion_tx,
            display_notch: None,
        });
        ActorHandle {
            recording_dir: path.to_path_buf(),
            terminal: Arc::new(WindowsStudioTerminal::default()),
            actor_ref,
            capture_target: target,
            done_fut: completion_rx_to_done_fut(completion_rx),
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn prior_optional_join_timeout_cannot_ack_after_final_metadata() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("content")).unwrap();
        write_in_progress_meta(temp.path()).unwrap();
        std::fs::write(temp.path().join("content/partial.m4s"), b"partial").unwrap();
        let handle = prior_unconfirmed_optional_stop_handle(temp.path());

        let report = handle.stop_with_intent(StudioStopIntent::Preserve).await;
        assert!(report.accepted_intent);
        assert!(!report.stop_acknowledged);
        let error = report.result.err().expect("unconfirmed optional stop");
        assert!(error.contains(UNCONFIRMED_CAPTURE_CLEANUP));
        assert!(matches!(
            RecordingMeta::load_for_project(temp.path())
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Failed { .. }
        ));
        assert_eq!(
            std::fs::read(temp.path().join("content/partial.m4s")).unwrap(),
            b"partial"
        );

        let replay = handle.stop_with_intent(StudioStopIntent::Preserve).await;
        assert!(replay.accepted_intent);
        assert!(!replay.stop_acknowledged);
        assert_eq!(replay.result.err().expect("cached unconfirmed stop"), error);
    }

    #[cfg(target_os = "linux")]
    mod resume_transaction_tests {
        use super::*;
        struct ResumeStateSnapshot;

        impl Message<ResumeStateSnapshot> for Actor {
            type Reply = (bool, u32, u32, usize, usize, u32);

            async fn handle(
                &mut self,
                _: ResumeStateSnapshot,
                _: &mut Context<Self, Self::Reply>,
            ) -> Self::Reply {
                let (paused, index, cursor_id, cursors) = match &self.state {
                    Some(ActorState::Paused {
                        next_index,
                        next_cursor_id,
                        cursors,
                    }) => (true, *next_index, *next_cursor_id, cursors.len()),
                    _ => (false, 0, 0, 0),
                };
                (
                    paused,
                    index,
                    cursor_id,
                    cursors,
                    self.segments.len(),
                    self.segment_factory.index,
                )
            }
        }

        fn paused_resume_actor(path: &Path, prepare: ResumeTestFactory) -> ActorHandle {
            let (completion_tx, completion_rx) = watch::channel(None);
            let target = screen_capture::ScreenCaptureTarget::CameraOnly;
            let mut factory = SegmentPipelineFactory::new(
                path.join("content/segments"),
                path.join("content/cursors"),
                RecordingBaseInputs {
                    capture_target: target.clone(),
                    capture_system_audio: false,
                    mic_feed: None,
                    camera_feed: None,
                    #[cfg(target_os = "macos")]
                    shareable_content: None,
                    #[cfg(target_os = "macos")]
                    excluded_windows: Vec::new(),
                },
                false,
                false,
                false,
                false,
                30,
                crate::StudioQuality::Balanced,
                completion_tx.clone(),
            );
            factory.index = 1;
            factory.prepare_override = Some(prepare);
            let cursors = [(
                17,
                crate::cursor::Cursor {
                    id: 12,
                    file_name: "retained.png".into(),
                    hotspot: cap_project::XY { x: 0.25, y: 0.75 },
                    shape: None,
                },
            )]
            .into_iter()
            .collect();
            let start_time = Timestamps::now();
            let prior_segment = RecordingSegment {
                start: 0.0,
                end: 1.0,
                camera_device_id: None,
                mic_device_id: None,
                pipeline: FinishedPipeline {
                    start_time,
                    screen: FinishedOutputPipeline {
                        path: path.join("content/segments/segment-0/display.mp4"),
                        first_timestamp: Timestamp::Instant(start_time.instant()),
                        video_info: Some(test_video_info()),
                        video_frame_count: 30,
                        video_timestamp_span: Some((Duration::ZERO, Duration::from_millis(967))),
                        audio_gap_summary: None,
                    },
                    microphone: None,
                    camera: None,
                    system_audio: None,
                    cursor: None,
                    track_failures: Vec::new(),
                },
            };
            let lifecycle = StudioLifecycle::new();
            ActorHandle {
                lifecycle: lifecycle.clone(),
                recording_dir: path.to_path_buf(),
                actor_ref: Actor::spawn(Actor {
                    lifetime: StudioLifetimeOwner {
                        lifecycle,
                        armed: true,
                    },
                    recording_dir: path.to_path_buf(),
                    state: Some(ActorState::Paused {
                        next_index: 1,
                        cursors,
                        next_cursor_id: 13,
                    }),
                    all_tracks_stopped: true,
                    terminal_stop_failure: None,
                    segment_factory: factory,
                    resume_attempt: None,
                    resume_generation: 0,
                    resume_cleanup_error: None,
                    segments: vec![prior_segment],
                    completion_tx,
                    display_notch: None,
                }),
                capture_target: target,
                done_fut: completion_rx_to_done_fut(completion_rx),
            }
        }

        #[tokio::test]
        async fn dropped_stop_waiter_does_not_abort_owned_studio_shutdown() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| async { Err(anyhow!("not resumed")) }.boxed()),
            );
            let scope = handle.lifecycle.0.scope.clone();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            scope
                .run(async {
                    let completion = scope.task_completion();
                    drop(tokio::spawn(async move {
                        let _completion = completion;
                        let _ = entered_tx.send(());
                        let _ = release_rx.await;
                    }));
                })
                .await;
            entered_rx.await.unwrap();
            let waiter = tokio::spawn({
                let handle = handle.clone();
                async move { handle.stop_with_report().await }
            });
            tokio::task::yield_now().await;
            waiter.abort();
            assert_eq!(handle.lifecycle.quiescence(), StudioQuiescence::Pending);
            release_tx.send(()).unwrap();
            let report = handle.stop_with_report().await;
            assert_eq!(report.quiescence, StudioQuiescence::Joined);
            assert!(report.result.is_ok());
            let replay = handle.stop_with_report().await;
            assert!(replay.result.is_ok());
        }

        #[tokio::test]
        async fn queued_discard_cannot_replay_a_successful_preserving_stop() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| async { Err(anyhow!("not resumed")) }.boxed()),
            );
            let first = handle.stop_with_report().await;
            assert_eq!(first.quiescence, StudioQuiescence::Joined);
            assert!(first.result.is_ok());
            let discarded = handle.stop_with_intent(StudioStopIntent::Discard).await;
            assert_eq!(discarded.quiescence, StudioQuiescence::Joined);
            assert!(discarded.result.is_err());
            assert!(!discarded.accepted_intent);
            assert!(directory.path().join("recording-meta.json").exists());
        }

        #[tokio::test]
        async fn queued_preserve_cannot_take_a_successful_discard_terminal_action() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| async { Err(anyhow!("not resumed")) }.boxed()),
            );
            let first = handle.stop_with_intent(StudioStopIntent::Discard).await;
            assert!(first.accepted_intent);
            assert_eq!(first.quiescence, StudioQuiescence::Joined);
            assert!(first.result.is_ok());
            let preserving = handle.stop_with_report().await;
            assert!(!preserving.accepted_intent);
            assert_eq!(preserving.quiescence, StudioQuiescence::Joined);
            assert!(preserving.result.is_err());
        }

        #[derive(kameo::Actor)]
        struct BlockedCompletionMailbox {
            entered: Option<tokio::sync::oneshot::Sender<()>>,
            release: Option<tokio::sync::oneshot::Receiver<()>>,
        }

        impl Message<u8> for BlockedCompletionMailbox {
            type Reply = ();

            async fn handle(&mut self, message: u8, _: &mut Context<Self, Self::Reply>) {
                if message == 0 {
                    self.entered.take().unwrap().send(()).unwrap();
                    self.release.take().unwrap().await.unwrap();
                }
            }
        }

        #[tokio::test]
        async fn full_actor_mailbox_cannot_retain_published_capture_completion() {
            let (entered, entry) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let actor = BlockedCompletionMailbox::spawn(BlockedCompletionMailbox {
                entered: Some(entered),
                release: Some(released),
            });
            actor.tell(0u8).await.unwrap();
            entry.await.unwrap();
            for _ in 0..64 {
                actor.tell(1u8).try_send().unwrap();
            }
            let scope = crate::output_pipeline::PipelineBuildScope::new_studio_lifetime();
            let completion = scope.task_completion();
            let notifying = tokio::spawn({
                let actor = actor.clone();
                async move { notify_after_capture_publication(completion, actor.tell(2u8)).await }
            });
            let report =
                tokio::time::timeout(Duration::from_secs(1), scope.cancel_and_join_report())
                    .await
                    .unwrap();
            assert!(report.quiescent);
            assert!(!notifying.is_finished());
            release.send(()).unwrap();
            notifying.await.unwrap().unwrap();
            actor.kill();
            actor.wait_for_stop().await;
        }

        #[tokio::test]
        async fn source_stop_scope_failure_is_failed_before_actor_completion() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| async { Err(anyhow!("not resumed")) }.boxed()),
            );
            handle
                .lifecycle
                .0
                .scope
                .fail_required("unresolved backend error at source Stop".into());
            let report = handle.stop_with_report().await;
            assert!(report.accepted_intent);
            assert_eq!(report.quiescence, StudioQuiescence::Joined);
            assert!(report.result.is_err());
            assert!(handle.done_fut().await.is_err());
            let meta = RecordingMeta::load_for_project(directory.path()).unwrap();
            assert!(matches!(
                meta.studio_meta().unwrap().status(),
                StudioRecordingStatus::Failed { .. }
            ));
        }

        #[tokio::test]
        async fn joined_studio_failure_remains_error_for_queued_stop() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| async { Err(anyhow!("not resumed")) }.boxed()),
            );
            handle.lifecycle.fail("requested microphone failed".into());
            let (first, second) =
                futures::join!(handle.stop_with_report(), handle.stop_with_report());
            for report in [first, second] {
                assert_eq!(report.quiescence, StudioQuiescence::Joined);
                assert!(
                    report
                        .result
                        .err()
                        .unwrap()
                        .contains("requested microphone failed")
                );
            }
            let meta = RecordingMeta::load_for_project(directory.path()).unwrap();
            assert!(matches!(
                meta.studio_meta().unwrap().status(),
                StudioRecordingStatus::Failed { .. }
            ));
        }

        #[tokio::test]
        async fn resume_failure_waits_for_owned_cleanup_and_preserves_paused_cursor_state() {
            let directory = tempfile::tempdir().unwrap();
            let started = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new({
                    let started = started.clone();
                    let release = release.clone();
                    let stopped = stopped.clone();
                    let calls = calls.clone();
                    move |cursors, next_id| {
                        assert_eq!(next_id, 13);
                        assert_eq!(cursors[&17].id, 12);
                        let started = started.clone();
                        let release = release.clone();
                        let stopped = stopped.clone();
                        let calls = calls.clone();
                        async move {
                            if calls.fetch_add(1, std::sync::atomic::Ordering::AcqRel) == 0 {
                                drop(crate::output_pipeline::spawn_capture_task(async move {
                                    started.notify_one();
                                    release.notified().await;
                                    stopped.store(true, std::sync::atomic::Ordering::Release);
                                }));
                            }
                            bail!("late segment setup failure")
                        }
                        .boxed()
                    }
                }),
            );
            let ready = handle.actor_ref.ask(Resume).await.unwrap();
            started.notified().await;
            assert!(!handle.is_paused().await.unwrap());
            tokio::pin!(ready);
            assert!(
                tokio::time::timeout(Duration::from_millis(20), &mut ready)
                    .await
                    .is_err()
            );
            assert!(handle.done_fut().now_or_never().is_none());
            release.notify_one();
            assert!(ready.await.is_err());
            assert!(stopped.load(std::sync::atomic::Ordering::Acquire));
            assert!(handle.is_paused().await.unwrap());
            assert_eq!(
                handle.actor_ref.ask(ResumeStateSnapshot).await.unwrap(),
                (true, 1, 13, 1, 1, 1)
            );
            assert!(handle.resume().await.is_err());
            assert_eq!(calls.load(std::sync::atomic::Ordering::Acquire), 2);
            assert_eq!(
                handle.actor_ref.ask(ResumeStateSnapshot).await.unwrap(),
                (true, 1, 13, 1, 1, 1)
            );
            handle.actor_ref.stop_gracefully().await.unwrap();
        }

        #[tokio::test]
        async fn stop_cancels_pending_resume_and_joins_before_finalizing_only_prior_segments() {
            let directory = tempfile::tempdir().unwrap();
            let started = Arc::new(tokio::sync::Notify::new());
            let cancelled = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let failed_dir = directory.path().join("content/segments/segment-1");
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new({
                    let started = started.clone();
                    let cancelled = cancelled.clone();
                    let release = release.clone();
                    let failed_dir = failed_dir.clone();
                    move |_, _| {
                        let started = started.clone();
                        let cancelled = cancelled.clone();
                        let release = release.clone();
                        let failed_dir = failed_dir.clone();
                        async move {
                            tokio::fs::create_dir_all(&failed_dir).await.unwrap();
                            let scope =
                                crate::output_pipeline::PipelineBuildScope::current().unwrap();
                            drop(crate::output_pipeline::spawn_capture_task(async move {
                                scope.cancellation().cancelled().await;
                                cancelled.notify_one();
                                release.notified().await;
                            }));
                            started.notify_one();
                            std::future::pending::<anyhow::Result<Pipeline>>().await
                        }
                        .boxed()
                    }
                }),
            );
            let ready = handle.actor_ref.ask(Resume).await.unwrap();
            started.notified().await;
            let stopping = handle.stop();
            tokio::pin!(stopping);
            tokio::select! {
                _ = cancelled.notified() => {},
                _ = &mut stopping => panic!("Stop acknowledged before setup cleanup"),
                _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("Stop did not reach pending resume"),
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(20), &mut stopping)
                    .await
                    .is_err()
            );
            assert!(handle.done_fut().now_or_never().is_none());
            release.notify_one();
            let completed = tokio::time::timeout(Duration::from_secs(2), stopping)
                .await
                .unwrap()
                .unwrap();
            assert!(ready.await.is_err());
            let StudioRecordingMeta::MultipleSegments { inner } = completed.meta else {
                panic!("wrong metadata")
            };
            assert_eq!(inner.segments.len(), 1);
            assert_eq!(
                inner.segments[0].display.path.as_str(),
                "content/segments/segment-0/display.mp4"
            );
            assert!(!failed_dir.exists());
        }

        #[tokio::test]
        async fn dropped_resume_waiter_cancels_owned_setup_without_late_commit() {
            let directory = tempfile::tempdir().unwrap();
            let started = Arc::new(tokio::sync::Notify::new());
            let finished = Arc::new(tokio::sync::Notify::new());
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new({
                    let started = started.clone();
                    let finished = finished.clone();
                    move |_, _| {
                        let started = started.clone();
                        let finished = finished.clone();
                        async move {
                            let scope =
                                crate::output_pipeline::PipelineBuildScope::current().unwrap();
                            drop(crate::output_pipeline::spawn_capture_task(async move {
                                scope.cancellation().cancelled().await;
                                finished.notify_one();
                            }));
                            started.notify_one();
                            std::future::pending::<anyhow::Result<Pipeline>>().await
                        }
                        .boxed()
                    }
                }),
            );
            let ready = handle.actor_ref.ask(Resume).await.unwrap();
            started.notified().await;
            drop(ready);
            tokio::time::timeout(Duration::from_secs(2), finished.notified())
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while !handle.is_paused().await.unwrap() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            handle.actor_ref.tell(ResumeFinished(0)).await.unwrap();
            assert_eq!(
                handle.actor_ref.ask(ResumeStateSnapshot).await.unwrap(),
                (true, 1, 13, 1, 1, 1)
            );
            assert!(handle.done_fut().now_or_never().is_none());
            handle.actor_ref.stop_gracefully().await.unwrap();
        }

        #[tokio::test]
        async fn unconfirmed_resume_cleanup_never_acknowledges_paused_retry_or_complete() {
            let directory = tempfile::tempdir().unwrap();
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new(|_, _| {
                    async {
                        crate::output_pipeline::PipelineBuildScope::current()
                            .unwrap()
                            .spawn_cleanup(async { bail!("native stop failed") });
                        bail!("setup failed")
                    }
                    .boxed()
                }),
            );
            assert!(handle.resume().await.is_err());
            assert!(!handle.is_paused().await.unwrap());
            assert!(handle.resume().await.is_err());
            assert!(handle.stop().await.is_err());
            assert!(handle.done_fut().now_or_never().is_none());
            assert_eq!(
                handle.actor_ref.ask(ResumeStateSnapshot).await.unwrap(),
                (true, 1, 13, 1, 1, 1)
            );
            handle.actor_ref.stop_gracefully().await.unwrap();
        }

        struct ResumeVideo {
            sender: Option<futures::channel::mpsc::Sender<TestVideoFrame>>,
        }

        impl crate::output_pipeline::VideoSource for ResumeVideo {
            type Config = Arc<std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>>;
            type Frame = TestVideoFrame;

            async fn setup(
                stop: Self::Config,
                sender: futures::channel::mpsc::Sender<Self::Frame>,
                ctx: &mut SetupCtx,
            ) -> anyhow::Result<Self> {
                *stop.lock().unwrap() = Some(ctx.stop_token());
                Ok(Self {
                    sender: Some(sender),
                })
            }

            fn video_info(&self) -> VideoInfo {
                test_video_info()
            }

            fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
                async move {
                    self.sender.as_mut().unwrap().try_send(TestVideoFrame {
                        timestamp: Timestamp::Instant(Instant::now()),
                    })?;
                    Ok(())
                }
                .boxed()
            }

            fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
                drop(self.sender.take());
                async { Ok(()) }.boxed()
            }
        }

        #[tokio::test]
        async fn successful_resume_commits_once_and_stop_handles_the_committed_race() {
            let directory = tempfile::tempdir().unwrap();
            let stop = Arc::new(std::sync::Mutex::new(None));
            let next_path = directory
                .path()
                .join("content/segments/segment-1/display.mp4");
            let handle = paused_resume_actor(
                directory.path(),
                Arc::new({
                    let stop = stop.clone();
                    move |_, _| {
                        let stop = stop.clone();
                        let next_path = next_path.clone();
                        async move {
                            let start_time = Timestamps::now();
                            let screen = OutputPipeline::builder(next_path)
                                .with_video::<ResumeVideo>(stop)
                                .with_timestamps(start_time)
                                .build::<SuccessfulVideoMuxer>(())
                                .await?;
                            Ok(Pipeline {
                                start_time,
                                screen,
                                microphone: None,
                                camera: None,
                                system_audio: None,
                                cursor: None,
                                track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
                                watcher_task: None,
                                #[cfg(target_os = "linux")]
                                stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                            })
                        }
                        .boxed()
                    }
                }),
            );
            handle.resume().await.unwrap();
            assert!(!handle.is_paused().await.unwrap());
            assert!(!stop.lock().unwrap().as_ref().unwrap().is_cancelled());
            handle.resume().await.unwrap();
            assert_eq!(
                handle.actor_ref.ask(ResumeStateSnapshot).await.unwrap().5,
                2
            );
            let completed = tokio::time::timeout(Duration::from_secs(3), handle.stop())
                .await
                .unwrap()
                .unwrap();
            let StudioRecordingMeta::MultipleSegments { inner } = completed.meta else {
                panic!("wrong metadata")
            };
            assert_eq!(inner.segments.len(), 2);
            assert!(stop.lock().unwrap().as_ref().unwrap().is_cancelled());
        }
    }

    struct DelayedStopAudioSource {
        tx: Option<futures::channel::mpsc::Sender<crate::output_pipeline::AudioFrame>>,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl AudioSource for DelayedStopAudioSource {
        type Config = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

        fn setup(
            (started, release): Self::Config,
            mut tx: futures::channel::mpsc::Sender<crate::output_pipeline::AudioFrame>,
            _: &mut SetupCtx,
        ) -> impl std::future::Future<Output = anyhow::Result<Self>> + Send + 'static {
            let result = (|| {
                tx.try_send(crate::output_pipeline::AudioFrame::new(
                    test_audio_info().empty_frame(960),
                    Timestamp::Instant(Instant::now()),
                ))?;
                Ok(Self {
                    tx: Some(tx),
                    started,
                    release,
                })
            })();
            futures::future::ready(result)
        }

        fn audio_info(&self) -> cap_media_info::AudioInfo {
            test_audio_info()
        }

        async fn stop(&mut self) -> anyhow::Result<()> {
            self.started.notify_one();
            self.release.notified().await;
            drop(self.tx.take());
            Ok(())
        }
    }

    #[tokio::test]
    async fn screen_stop_does_not_wait_for_optional_audio_shutdown() {
        let temp_dir = tempfile::tempdir().unwrap();
        let timestamps = Timestamps::now();
        let (screen_tx, screen_rx) = flume::bounded(4);
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        let screen = OutputPipeline::builder(temp_dir.path().join("display.mp4"))
            .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                test_video_info(),
                screen_rx,
            ))
            .with_timestamps(timestamps)
            .build::<SuccessfulVideoMuxer>(())
            .await
            .unwrap();
        let screen_stop = screen.cancel_token();
        let microphone = OutputPipeline::builder(temp_dir.path().join("audio-input.ogg"))
            .with_audio_source::<DelayedStopAudioSource>((started.clone(), release.clone()))
            .with_timestamps(timestamps)
            .build::<SuccessfulVideoMuxer>(())
            .await
            .unwrap();
        screen_tx
            .send_async(TestVideoFrame {
                timestamp: Timestamp::Instant(timestamps.instant()),
            })
            .await
            .unwrap();
        let pipeline = Pipeline {
            start_time: timestamps,
            screen,
            microphone: Some(microphone),
            camera: None,
            system_audio: None,
            cursor: None,
            track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
            watcher_task: None,
            #[cfg(any(target_os = "linux", windows))]
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };

        let stopping = tokio::spawn(pipeline.stop());
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        let screen_stopped_while_audio_waited = screen_stop.is_cancelled();
        release.notify_one();
        drop(screen_tx);
        let finished = stopping.await.unwrap().unwrap();

        assert!(screen_stopped_while_audio_waited);
        assert!(finished.media_error.is_none());
        assert!(finished.pipeline.microphone.is_some());
    }

    #[cfg(target_os = "macos")]
    mod macos_stop_order_tests {
        use super::*;

        struct AudioFinalizer(bool);

        impl Muxer for AudioFinalizer {
            type Config = bool;

            async fn setup(
                fail: bool,
                _: PathBuf,
                _: Option<VideoInfo>,
                _: Option<cap_media_info::AudioInfo>,
                _: Arc<std::sync::atomic::AtomicBool>,
                _: &mut TaskPool,
            ) -> anyhow::Result<Self> {
                Ok(Self(fail))
            }

            fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
                Ok(if self.0 {
                    Err(anyhow!("system audio finalization failed"))
                } else {
                    Ok(())
                })
            }
        }

        impl AudioMuxer for AudioFinalizer {
            fn send_audio_frame(
                &mut self,
                _: crate::output_pipeline::AudioFrame,
                _: Duration,
            ) -> anyhow::Result<()> {
                Ok(())
            }
        }

        async fn assert_stop_order(fail_system_audio: bool) -> FinishedPipeline {
            let directory = tempfile::tempdir().unwrap();
            let timestamps = Timestamps::now();
            let (screen_tx, screen_rx) = flume::bounded(4);
            let (camera_tx, camera_rx) = flume::bounded(4);
            let screen = OutputPipeline::builder(directory.path().join("display.mp4"))
                .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                    test_video_info(),
                    screen_rx,
                ))
                .with_timestamps(timestamps)
                .build::<SuccessfulVideoMuxer>(())
                .await
                .unwrap();
            let camera = OutputPipeline::builder(directory.path().join("camera.mp4"))
                .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                    test_video_info(),
                    camera_rx,
                ))
                .with_timestamps(timestamps)
                .build::<SuccessfulVideoMuxer>(())
                .await
                .unwrap();
            let screen_stop = screen.cancel_token();
            let camera_stop = camera.cancel_token();
            for sender in [&screen_tx, &camera_tx] {
                sender
                    .send_async(TestVideoFrame {
                        timestamp: Timestamp::Instant(timestamps.instant()),
                    })
                    .await
                    .unwrap();
            }

            let microphone_started = Arc::new(tokio::sync::Notify::new());
            let microphone_release = Arc::new(tokio::sync::Notify::new());
            let microphone = OutputPipeline::builder(directory.path().join("microphone.ogg"))
                .with_audio_source::<DelayedStopAudioSource>((
                    microphone_started.clone(),
                    microphone_release.clone(),
                ))
                .with_timestamps(timestamps)
                .build::<SuccessfulVideoMuxer>(())
                .await
                .unwrap();
            let system_audio_started = Arc::new(tokio::sync::Notify::new());
            let system_audio_release = Arc::new(tokio::sync::Notify::new());
            let system_audio = OutputPipeline::builder(directory.path().join("system-audio.ogg"))
                .with_audio_source::<DelayedStopAudioSource>((
                    system_audio_started.clone(),
                    system_audio_release.clone(),
                ))
                .with_timestamps(timestamps)
                .build::<AudioFinalizer>(fail_system_audio)
                .await
                .unwrap();
            let pipeline = Pipeline {
                start_time: timestamps,
                screen,
                microphone: Some(microphone),
                camera: Some(camera),
                system_audio: Some(system_audio),
                cursor: None,
                track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
                watcher_task: None,
            };

            let stopping = tokio::spawn(pipeline.stop());
            tokio::time::timeout(Duration::from_secs(2), async {
                futures::join!(
                    system_audio_started.notified(),
                    microphone_started.notified(),
                    camera_stop.cancelled()
                );
            })
            .await
            .unwrap();
            drop(camera_tx);
            assert!(!screen_stop.is_cancelled());
            assert!(!stopping.is_finished());

            system_audio_release.notify_one();
            tokio::time::timeout(Duration::from_secs(2), screen_stop.cancelled())
                .await
                .unwrap();
            drop(screen_tx);
            assert!(!stopping.is_finished());
            microphone_release.notify_one();
            let stopped = tokio::time::timeout(Duration::from_secs(2), stopping)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(stopped.all_tracks_stopped, !fail_system_audio);
            assert!(stopped.media_error.is_none());
            let finished = stopped.pipeline;
            assert!(finished.microphone.is_some());
            assert!(finished.camera.is_some());
            finished
        }

        #[tokio::test]
        async fn system_audio_stop_precedes_screen_without_blocking_other_tracks() {
            let finished = assert_stop_order(false).await;
            assert!(finished.system_audio.is_some());
            assert!(finished.track_failures.is_empty());
        }

        #[tokio::test]
        async fn failed_system_audio_stop_still_stops_screen_and_preserves_failure() {
            let finished = assert_stop_order(true).await;
            assert!(finished.system_audio.is_none());
            assert_eq!(finished.track_failures.len(), 1);
            let failure = &finished.track_failures[0];
            assert_eq!(failure.track, RecordingTrackKind::SystemAudio);
            assert_eq!(failure.stage, TrackFailureStage::Stop);
            assert!(failure.error.contains("system audio finalization failed"));
        }
    }

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
            video_timestamp_span: None,
            audio_gap_summary: None,
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
    fn snap_nearby_start_time_keeps_far_track_start() {
        assert_eq!(snap_nearby_start_time(0.2, Some(0.0), 0.04), 0.2);
    }

    #[test]
    fn snap_nearby_start_time_aligns_near_track_start() {
        assert_eq!(snap_nearby_start_time(0.02, Some(0.0), 0.04), 0.0);
    }

    #[tokio::test]
    async fn stop_recording_preserves_far_display_start_time() {
        let temp_dir = tempfile::tempdir().expect("temp dir should be created");
        let recording_dir = temp_dir.path().join("recording");
        let start_time = Timestamps::now();
        std::fs::create_dir_all(recording_dir.join("content"))
            .expect("recording content dir should be created");

        let segment = RecordingSegment {
            start: 0.0,
            end: 1.0,
            pipeline: FinishedPipeline {
                start_time,
                screen: test_finished_output_pipeline_at(
                    recording_dir.join("content/display.mp4"),
                    Timestamp::Instant(start_time.instant() + Duration::from_millis(200)),
                    Some(test_video_info()),
                    60,
                ),
                microphone: Some(test_finished_output_pipeline_at(
                    recording_dir.join("content/mic.ogg"),
                    Timestamp::Instant(start_time.instant()),
                    None,
                    0,
                )),
                camera: None,
                system_audio: None,
                cursor: None,
                track_failures: Vec::new(),
            },
            camera_device_id: None,
            mic_device_id: Some("mic".to_string()),
        };

        let completed = stop_recording(
            recording_dir.clone(),
            vec![segment],
            Default::default(),
            false,
            None,
            None,
        )
        .await
        .expect("recording should stop");

        let StudioRecordingMeta::MultipleSegments { inner } = completed.meta else {
            panic!("expected multiple segments meta");
        };
        let segment = inner.segments.first().expect("segment should be present");

        assert_eq!(segment.display.start_time, Some(0.2));
        assert_eq!(
            segment.mic.as_ref().and_then(|mic| mic.start_time),
            Some(0.0)
        );
    }

    #[test]
    fn camera_active_capture_size_leaves_non_compatibility_native() {
        for quality in [crate::StudioQuality::Balanced, crate::StudioQuality::Ultra] {
            assert!(camera_active_max_capture_size(quality, true).is_none());
        }
    }

    #[test]
    fn camera_active_capture_size_keeps_guardrail_for_compatibility() {
        assert_eq!(
            camera_active_max_capture_size(crate::StudioQuality::Compatibility, true),
            Some((
                COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_WIDTH,
                COMPATIBILITY_CAMERA_ACTIVE_MAX_SCREEN_HEIGHT,
            ))
        );
    }

    #[test]
    fn inactive_camera_capture_size_is_unbounded() {
        for quality in [
            crate::StudioQuality::Compatibility,
            crate::StudioQuality::Balanced,
            crate::StudioQuality::Ultra,
        ] {
            assert!(camera_active_max_capture_size(quality, false).is_none());
        }
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
                version: 2,
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
    async fn failed_requested_track_remains_failed_when_diagnostics_sidecar_write_fails() {
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

        let result = stop_recording(
            recording_dir.clone(),
            vec![segment],
            Default::default(),
            false,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
        let meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
        assert!(matches!(
            meta.studio_meta().unwrap().status(),
            StudioRecordingStatus::Failed { .. }
        ));

        assert!(
            recording_dir.join("project-config.json").is_file(),
            "project config should still be written"
        );
        assert!(
            recording_dir.join("recording-diagnostics.json").is_dir(),
            "the pre-existing diagnostics directory should remain, proving the sidecar write failed"
        );
    }

    #[tokio::test]
    async fn requested_track_failure_never_finalizes_complete_or_needs_remux() {
        for track in [
            RecordingTrackKind::Microphone,
            RecordingTrackKind::Camera,
            RecordingTrackKind::SystemAudio,
        ] {
            for fragmented in [false, true] {
                let temp_dir = tempfile::tempdir().unwrap();
                let recording_dir = temp_dir.path().join("recording");
                std::fs::create_dir_all(recording_dir.join("content")).unwrap();
                let display_path = recording_dir.join("content/display");
                if fragmented {
                    std::fs::create_dir(&display_path).unwrap();
                    std::fs::write(display_path.join("preserved-fragment"), b"partial").unwrap();
                } else {
                    std::fs::write(&display_path, b"preserved-display").unwrap();
                }
                let timestamps = Timestamps::now();
                let segment = RecordingSegment {
                    start: 0.0,
                    end: 1.0,
                    pipeline: FinishedPipeline {
                        start_time: timestamps,
                        screen: test_finished_output_pipeline_at(
                            display_path.clone(),
                            Timestamp::Instant(timestamps.instant()),
                            Some(test_video_info()),
                            1,
                        ),
                        microphone: None,
                        camera: None,
                        system_audio: None,
                        cursor: None,
                        track_failures: vec![TrackFailureRecord {
                            track,
                            stage: TrackFailureStage::Stop,
                            error: "required output failed".to_string(),
                        }],
                    },
                    camera_device_id: None,
                    mic_device_id: None,
                };
                let result = stop_recording(
                    recording_dir.clone(),
                    vec![segment],
                    Default::default(),
                    fragmented,
                    None,
                    None,
                )
                .await;
                assert!(result.is_err());
                let meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
                assert!(matches!(
                    meta.studio_meta().unwrap().status(),
                    StudioRecordingStatus::Failed { .. }
                ));
                assert!(display_path.exists());
                assert!(recording_dir.join("recording-diagnostics.json").is_file());
            }
        }
    }

    #[cfg(windows)]
    struct HeldEncoderMuxer(Option<std::thread::JoinHandle<anyhow::Result<()>>>);

    #[cfg(windows)]
    impl Muxer for HeldEncoderMuxer {
        type Config = (
            std::sync::mpsc::Receiver<()>,
            tokio::sync::oneshot::Sender<()>,
        );
        async fn setup(
            (release, exited): Self::Config,
            _output_path: PathBuf,
            _video_config: Option<VideoInfo>,
            _audio_config: Option<cap_media_info::AudioInfo>,
            _pause_flag: Arc<std::sync::atomic::AtomicBool>,
            _tasks: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(Some(std::thread::spawn(move || {
                release.recv().map_err(|error| anyhow!("{error}"))?;
                let _ = exited.send(());
                Ok(())
            }))))
        }
        fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
            use crate::output_pipeline::{BlockingThreadFinish, wait_for_blocking_thread_finish};
            let handle = self.0.take().unwrap();
            Ok(
                match wait_for_blocking_thread_finish(handle, Duration::ZERO, "held-test-encoder") {
                    BlockingThreadFinish::Clean => Ok(()),
                    BlockingThreadFinish::Failed(error) | BlockingThreadFinish::TimedOut(error) => {
                        Err(error)
                    }
                },
            )
        }
    }

    #[cfg(windows)]
    impl AudioMuxer for HeldEncoderMuxer {
        fn send_audio_frame(
            &mut self,
            _frame: crate::output_pipeline::AudioFrame,
            _timestamp: Duration,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[cfg(windows)]
    impl VideoMuxer for HeldEncoderMuxer {
        type VideoFrame = TestVideoFrame;
        fn send_video_frame(
            &mut self,
            _frame: TestVideoFrame,
            _timestamp: Duration,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_actual_encoder_join_timeout_preserves_failed_without_acknowledgement() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("content")).unwrap();
        write_in_progress_meta(temp.path()).unwrap();
        std::fs::write(temp.path().join("content/partial.m4s"), b"partial").unwrap();
        let (release, held) = std::sync::mpsc::channel();
        let (exited, mut joined) = tokio::sync::oneshot::channel();
        let (frames, receiver) = flume::bounded(4);
        let timestamps = Timestamps::now();
        let screen = OutputPipeline::builder(temp.path().join("content/display.mp4"))
            .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                test_video_info(),
                receiver,
            ))
            .with_timestamps(timestamps)
            .build::<HeldEncoderMuxer>((held, exited))
            .await
            .unwrap();
        let mut actor = super::windows_cancel_tests::cancelled_actor(None);
        actor.recording_dir = temp.path().to_owned();
        actor.state = Some(ActorState::Recording {
            pipeline: Pipeline {
                start_time: timestamps,
                screen,
                microphone: None,
                camera: None,
                system_audio: None,
                cursor: None,
                track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
                watcher_task: None,
                stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
            index: 0,
            segment_start_time: 0.0,
            segment_start_instant: Instant::now().checked_sub(Duration::from_secs(2)).unwrap(),
        });
        let done_fut = completion_rx_to_done_fut(actor.completion_tx.subscribe());
        let actor_ref = Actor::spawn(actor);
        let handle = ActorHandle {
            recording_dir: temp.path().to_owned(),
            terminal: Arc::new(WindowsStudioTerminal::default()),
            actor_ref: actor_ref.clone(),
            capture_target: screen_capture::ScreenCaptureTarget::CameraOnly,
            done_fut,
        };
        let report = handle.stop_with_intent(StudioStopIntent::Preserve).await;
        assert!(!report.stop_acknowledged);
        assert!(report.result.err().unwrap().contains("held-test-encoder"));
        assert!(matches!(
            joined.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            RecordingMeta::load_for_project(temp.path())
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Failed { .. }
        ));
        assert_eq!(
            std::fs::read(temp.path().join("content/partial.m4s")).unwrap(),
            b"partial"
        );
        release.send(()).unwrap();
        joined.await.unwrap();
        drop(frames);
        actor_ref.kill();
        actor_ref.wait_for_stop().await;
    }

    #[cfg(windows)]
    async fn failing_requested_actor(
        recording_dir: &Path,
        role: RecordingTrackKind,
    ) -> (Actor, flume::Sender<TestVideoFrame>) {
        std::fs::create_dir_all(recording_dir.join("content")).unwrap();
        write_in_progress_meta(recording_dir).unwrap();
        std::fs::write(
            recording_dir.join("content/partial.m4s"),
            b"retained-real-output",
        )
        .unwrap();
        let timestamps = Timestamps::now();
        let (screen_tx, screen_rx) = flume::bounded(4);
        let (completion_tx, _completion_rx) = watch::channel(None);
        let (mut microphone_tx, microphone_rx) = futures::channel::mpsc::channel(4);
        let screen = OutputPipeline::builder(recording_dir.join("content/display.mp4"))
            .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                test_video_info(),
                screen_rx,
            ))
            .with_timestamps(timestamps)
            .build::<SuccessfulVideoMuxer>(())
            .await
            .unwrap();
        let microphone = OutputPipeline::builder(recording_dir.join("content/audio-input.ogg"))
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                test_audio_info(),
                microphone_rx,
            ))
            .with_timestamps(timestamps)
            .build::<FailingAudioMuxer>(FailingAudioMuxerConfig {
                fail_after_frame: 1,
            })
            .await
            .unwrap();
        let microphone_done = microphone.done_fut();
        let mut pipeline = Pipeline {
            start_time: timestamps,
            screen,
            microphone: None,
            camera: None,
            system_audio: None,
            cursor: None,
            track_failures: Arc::new(std::sync::Mutex::new(Vec::new())),
            watcher_task: None,
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        match role {
            RecordingTrackKind::Microphone => pipeline.microphone = Some(microphone),
            RecordingTrackKind::Camera => pipeline.camera = Some(microphone),
            RecordingTrackKind::SystemAudio => pipeline.system_audio = Some(microphone),
            _ => panic!("requested-role fixture only"),
        }
        pipeline.spawn_watcher(completion_tx.clone());
        screen_tx
            .send_async(TestVideoFrame {
                timestamp: Timestamp::Instant(timestamps.instant()),
            })
            .await
            .unwrap();
        microphone_tx
            .try_send(crate::output_pipeline::AudioFrame::new(
                test_audio_info().empty_frame(960),
                Timestamp::Instant(timestamps.instant()),
            ))
            .unwrap();
        drop(microphone_tx);
        assert!(microphone_done.await.is_err());
        let segment_factory = SegmentPipelineFactory::new(
            recording_dir.join("content/segments"),
            recording_dir.join("content/cursors"),
            RecordingBaseInputs {
                capture_target: screen_capture::ScreenCaptureTarget::CameraOnly,
                capture_system_audio: false,
                mic_feed: None,
                camera_feed: None,
            },
            false,
            false,
            true,
            false,
            30,
            crate::StudioQuality::Balanced,
            completion_tx.clone(),
        );
        (
            Actor {
                recording_dir: recording_dir.to_owned(),
                cancel_error: None,
                state: Some(ActorState::Recording {
                    pipeline,
                    index: 0,
                    segment_start_time: 0.0,
                    segment_start_instant: Instant::now()
                        .checked_sub(Duration::from_secs(2))
                        .unwrap(),
                }),
                all_tracks_stopped: true,
                terminal_stop_failure: None,
                segment_factory,
                segments: Vec::new(),
                completion_tx,
                display_notch: None,
            },
            screen_tx,
        )
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_required_failure_stop_and_cancel_preserve_failed_raw_data() {
        for (cancel, role) in [false, true].into_iter().flat_map(|cancel| {
            [
                RecordingTrackKind::Microphone,
                RecordingTrackKind::Camera,
                RecordingTrackKind::SystemAudio,
            ]
            .into_iter()
            .map(move |role| (cancel, role))
        }) {
            let temp = tempfile::tempdir().unwrap();
            let (actor, screen_tx) = failing_requested_actor(temp.path(), role).await;
            let completion = actor.completion_tx.subscribe();
            let actor = Actor::spawn(actor);
            if cancel {
                assert!(actor.ask(Cancel).await.is_err());
            } else {
                assert!(actor.ask(Stop).await.is_err());
            }
            assert!(completion.borrow().as_ref().is_some_and(Result::is_err));
            assert!(matches!(
                RecordingMeta::load_for_project(temp.path())
                    .unwrap()
                    .studio_meta()
                    .unwrap()
                    .status(),
                StudioRecordingStatus::Failed { .. }
            ));
            assert_eq!(
                std::fs::read(temp.path().join("content/partial.m4s")).unwrap(),
                b"retained-real-output"
            );
            assert!(actor.ask(Cancel).await.is_err());
            drop(screen_tx);
            actor.kill();
            actor.wait_for_stop().await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_terminal_failure_is_cached_and_conflicting_intent_is_rejected() {
        for first in [StudioStopIntent::Preserve, StudioStopIntent::Discard] {
            let temp = tempfile::tempdir().unwrap();
            let (actor, screen_tx) =
                failing_requested_actor(temp.path(), RecordingTrackKind::Microphone).await;
            let done_fut = completion_rx_to_done_fut(actor.completion_tx.subscribe());
            let actor_ref = Actor::spawn(actor);
            let handle = ActorHandle {
                recording_dir: temp.path().to_owned(),
                terminal: Arc::new(WindowsStudioTerminal::default()),
                actor_ref: actor_ref.clone(),
                capture_target: screen_capture::ScreenCaptureTarget::CameraOnly,
                done_fut,
            };
            let report = handle.stop_with_intent(first).await;
            assert!(report.accepted_intent);
            assert!(!report.stop_acknowledged);
            assert!(report.result.is_err());
            assert!(handle.terminal_started());
            assert!(!handle.stop_acknowledged());
            assert!(handle.same_attempt(&handle.clone()));
            let repeated = handle.stop_with_intent(first).await;
            assert_eq!(repeated.result.err(), report.result.err());
            let other = match first {
                StudioStopIntent::Preserve => StudioStopIntent::Discard,
                StudioStopIntent::Discard => StudioStopIntent::Preserve,
            };
            let rejected = handle.stop_with_intent(other).await;
            assert!(!rejected.accepted_intent);
            assert!(!rejected.stop_acknowledged);
            assert!(temp.path().join("content/partial.m4s").exists());
            drop(screen_tx);
            actor_ref.kill();
            actor_ref.wait_for_stop().await;
        }
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
            #[cfg(any(target_os = "linux", windows))]
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        pipeline.spawn_watcher(completion_tx);

        screen_tx
            .send_async(TestVideoFrame {
                timestamp: Timestamp::Instant(timestamps.instant() + Duration::from_millis(33)),
            })
            .await
            .expect("display frame should send");

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

        let stopped = pipeline.stop().await;
        #[cfg(windows)]
        {
            assert!(stopped.is_err());
            assert!(completion_rx.borrow().as_ref().is_some_and(Result::is_err));
            drop(screen_tx);
        }
        #[cfg(not(windows))]
        let finished = stopped
            .expect("display success should still allow the recording to stop cleanly")
            .pipeline;

        #[cfg(not(windows))]
        drop(screen_tx);
        #[cfg(not(windows))]
        {
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
            #[cfg(target_os = "linux")]
            assert!(completion_rx.borrow().as_ref().is_some_and(Result::is_err));
            #[cfg(not(target_os = "linux"))]
            assert!(completion_rx.borrow().is_none());
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
}

#[cfg(all(test, windows))]
mod windows_cancel_tests {
    use super::*;

    pub(super) fn cancelled_actor(error: Option<String>) -> Actor {
        let (completion_tx, _completion_rx) = watch::channel(None);
        let segment_factory = SegmentPipelineFactory::new(
            PathBuf::new(),
            PathBuf::new(),
            RecordingBaseInputs {
                capture_target: screen_capture::ScreenCaptureTarget::CameraOnly,
                capture_system_audio: false,
                mic_feed: None,
                camera_feed: None,
            },
            false,
            false,
            true,
            false,
            30,
            crate::StudioQuality::Balanced,
            completion_tx.clone(),
        );
        Actor {
            recording_dir: PathBuf::new(),
            state: None,
            all_tracks_stopped: true,
            terminal_stop_failure: None,
            cancel_error: error,
            segment_factory,
            segments: Vec::new(),
            completion_tx,
            display_notch: None,
        }
    }

    #[tokio::test]
    async fn cancel_error_stays_observable_after_pipeline_was_taken() {
        let actor = Actor::spawn(cancelled_actor(Some("display shutdown failed".into())));
        for _ in 0..2 {
            assert!(
                actor
                    .ask(Cancel)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("display shutdown failed")
            );
        }
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn clean_cancelled_actor_can_acknowledge_cancel() {
        let actor = Actor::spawn(cancelled_actor(None));
        actor.ask(Cancel).await.unwrap();
        actor.kill();
        actor.wait_for_stop().await;
    }
}
