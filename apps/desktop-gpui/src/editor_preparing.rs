use std::{
    io::{self, BufReader, Read},
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use cap_editor::{
    EditorFrameFormat, EditorFrameOutput, PreparingFrameRequest, PreparingPlaybackExit,
    PreparingPlaybackOptions, PreparingPlaybackSession, PreparingPlaybackStopHandle,
    PreparingPreviewInput, PreparingPreviewOptions, PreparingPreviewSegment,
};
use cap_project::{CursorEvents, XY};

mod audio;
pub(crate) mod presentation;

use cap_recording::recovery::{
    PreparingSidecarKind, PreparingStudioIdentity, PreparingStudioSources, PreparingStudioState,
    PreparingVideoTrack,
};
use cap_rendering::{
    FrameLayout, FrozenRecordedCursorAssets, ManagedSegmentVideoInput, ManagedVideoTrackInput,
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use presentation::PreparingTimelineSeed;
use tokio::sync::watch;

use crate::recording::StudioFinalization;

const MAX_CURSOR_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct PreparingEpoch(Arc<()>);

impl PreparingEpoch {
    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

struct ConsumerControl {
    epoch: PreparingEpoch,
    finalization: StudioFinalization,
    cancelled: watch::Sender<bool>,
    accepts_frames: AtomicBool,
    started: Instant,
    updates: watch::Sender<Option<PreparingUpdate>>,
    commands: tokio::sync::mpsc::Sender<(PreparingCommand, cap_editor::PreparingPlaybackIntent)>,
    completed: Mutex<Option<PreparingPlaybackExit>>,
    discarded: AtomicBool,
    admitted_identity: Mutex<Option<PreparingStudioIdentity>>,
    handoff: watch::Sender<Option<cap_editor::PreparingPlaybackHandoff>>,
}

impl ConsumerControl {
    fn cancel(&self) {
        if let Some(handoff) = &*self.handoff.borrow() {
            handoff.cancel();
        }
        self.accepts_frames.store(false, Ordering::Release);
        self.cancelled.send_replace(true);
    }

    fn discard(&self) {
        self.discarded.store(true, Ordering::Release);
        self.cancel();
        if let Some(exit) = self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            drop(exit.take_completed_audio());
        }
    }

    fn accepts_status(&self, epoch: &PreparingEpoch, identity: &PreparingStudioIdentity) -> bool {
        self.epoch.same(epoch)
            && !*self.cancelled.borrow()
            && ((self.finalization.is_finalizing()
                && self.finalization.matches_preparing_identity(identity))
                || self.finalization.allows_preparing_continuation(identity))
    }

    fn accepts(&self, epoch: &PreparingEpoch, identity: &PreparingStudioIdentity) -> bool {
        self.accepts_frames.load(Ordering::Acquire) && self.accepts_status(epoch, identity)
    }
}

pub(crate) struct PreparingConsumer {
    control: Arc<ConsumerControl>,
}

#[derive(Clone)]
pub(crate) struct PreparingUpdate {
    pub(crate) epoch: PreparingEpoch,
    pub(crate) identity: PreparingStudioIdentity,
    pub(crate) sequence: u64,
    pub(crate) seed: Arc<PreparingTimelineSeed>,
    pub(crate) progress: cap_editor::PreparingEditorProgress,
    pub(crate) playback: cap_editor::PreparingPlaybackState,
}

#[derive(Clone, Copy)]
pub(crate) struct PreparingCommand {
    pub(crate) seek: Option<f64>,
    pub(crate) playing: Option<bool>,
}

impl PreparingConsumer {
    pub(crate) fn can_command(&self) -> bool {
        !*self.control.cancelled.borrow()
            && (self.control.finalization.is_finalizing()
                || self
                    .control
                    .admitted_identity
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .is_some_and(|identity| {
                        self.control
                            .finalization
                            .allows_preparing_continuation(identity)
                    }))
            && !self.control.commands.is_closed()
    }

    pub(crate) fn command(&self, command: PreparingCommand) -> bool {
        if !self.can_command() {
            return false;
        }
        let Some(handoff) = self.control.handoff.borrow().clone() else {
            return false;
        };
        let Ok(intent) = handoff.reserve_command() else {
            return false;
        };
        self.control.commands.try_send((command, intent)).is_ok()
    }

    pub(crate) fn updates(&self) -> watch::Receiver<Option<PreparingUpdate>> {
        self.control.updates.subscribe()
    }

    pub(crate) fn accepts_status(&self, update: &PreparingUpdate) -> bool {
        self.control.accepts_status(&update.epoch, &update.identity)
            || (update.progress.phase == cap_editor::PreparingEditorPhase::Unavailable
                && !self.control.discarded.load(Ordering::Acquire)
                && self.control.epoch.same(&update.epoch)
                && self
                    .control
                    .admitted_identity
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .is_some_and(|identity| identity.same_job(&update.identity)))
    }

    pub(crate) fn accepts(
        &self,
        epoch: &PreparingEpoch,
        identity: &PreparingStudioIdentity,
    ) -> bool {
        self.control.accepts(epoch, identity)
    }
}

impl Drop for PreparingConsumer {
    fn drop(&mut self) {
        if !self
            .control
            .handoff
            .borrow()
            .as_ref()
            .is_some_and(|handoff| handoff.committed())
        {
            self.control.discard();
        }
    }
}

#[derive(Clone)]
pub(crate) struct PreparingJoined {
    epoch: PreparingEpoch,
    pub(crate) exit: Option<PreparingPlaybackExit>,
}

impl PreparingJoined {
    pub(crate) fn matches(&self, consumer: &PreparingConsumer) -> bool {
        self.epoch.same(&consumer.control.epoch)
    }

    pub(crate) fn take_audio(&self) -> Option<cap_editor::CompletedAudioHandoff> {
        self.exit
            .as_ref()
            .and_then(PreparingPlaybackExit::take_completed_audio)
    }
}

#[derive(Clone)]
pub(crate) struct PreparingJoin {
    completion: Shared<BoxFuture<'static, Result<PreparingJoined, String>>>,
    identity: Arc<()>,
    control: std::sync::Weak<ConsumerControl>,
}

impl PreparingJoin {
    fn from_task(
        runtime: &tokio::runtime::Handle,
        task: tokio::task::JoinHandle<Result<PreparingJoined, String>>,
    ) -> Self {
        let completion = async move {
            task.await
                .map_err(|error| format!("Preparing preview task cleanup failed: {error}"))?
        }
        .boxed()
        .shared();
        let retained = completion.clone();
        drop(runtime.spawn(async move {
            let _ = retained.await;
        }));
        Self {
            completion,
            identity: Arc::new(()),
            control: Default::default(),
        }
    }

    pub(crate) async fn continuing_handoff(&self) -> Option<cap_editor::PreparingPlaybackHandoff> {
        let control = self.control.upgrade()?;
        let mut handoff = control.handoff.subscribe();
        loop {
            let value = handoff.borrow_and_update().clone();
            if let Some(value) = value {
                let admitted = control
                    .admitted_identity
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()?;
                return control
                    .finalization
                    .allows_preparing_continuation(&admitted)
                    .then_some(value);
            }
            tokio::select! {
                _ = self.completion.clone() => return None,
                changed = handoff.changed() => if changed.is_err() { return None; },
            }
        }
    }

    pub(crate) async fn wait(&self) -> Result<PreparingJoined, String> {
        self.completion.clone().await
    }

    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.identity, &other.identity)
    }

    fn completed_successfully(&self) -> bool {
        self.completion.peek().is_some_and(Result::is_ok)
    }
}

#[derive(Default)]
pub(crate) struct PreparingCleanupRegistry {
    entries: Vec<(PathBuf, PreparingJoin)>,
}

impl PreparingCleanupRegistry {
    pub(crate) fn prune_completed(&mut self) {
        self.entries
            .retain(|(_, joined)| !joined.completed_successfully());
    }

    pub(crate) fn register(&mut self, path: PathBuf, joined: PreparingJoin) {
        self.entries
            .retain(|(_, joined)| !joined.completed_successfully());
        self.entries.push((path, joined));
    }

    pub(crate) fn pending(&mut self, path: &Path) -> Vec<PreparingJoin> {
        self.entries
            .retain(|(_, joined)| !joined.completed_successfully());
        self.entries
            .iter()
            .filter(|(key, _)| key == path)
            .map(|(_, joined)| joined.clone())
            .collect()
    }
}

pub(crate) struct PreparingFrame {
    pub(crate) epoch: PreparingEpoch,
    pub(crate) identity: PreparingStudioIdentity,
    pub(crate) request: PreparingFrameRequest,
    pub(crate) output: EditorFrameOutput,
    pub(crate) layout: FrameLayout,
}

struct PreparingRunner {
    control: Arc<ConsumerControl>,
    frames: flume::Sender<PreparingFrame>,
    stop: Option<PreparingPlaybackStopHandle>,
    resolution: XY<u32>,
    audio_output: Arc<cap_editor::AudioOutput>,
    commands: Option<
        tokio::sync::mpsc::Receiver<(PreparingCommand, cap_editor::PreparingPlaybackIntent)>,
    >,
    command_task: Option<tokio::task::JoinHandle<()>>,
    frame_discard: flume::Receiver<PreparingFrame>,
}

pub(crate) fn spawn(
    finalization: StudioFinalization,
    resolution: XY<u32>,
    audio_output: Arc<cap_editor::AudioOutput>,
    runtime: &tokio::runtime::Handle,
) -> (
    PreparingConsumer,
    PreparingJoin,
    flume::Receiver<PreparingFrame>,
) {
    let (cancelled, _) = watch::channel(false);
    let (updates, _) = watch::channel(None);
    let (commands, command_rx) = tokio::sync::mpsc::channel(8);
    let control = Arc::new(ConsumerControl {
        epoch: PreparingEpoch(Arc::new(())),
        finalization,
        cancelled,
        accepts_frames: AtomicBool::new(false),
        started: Instant::now(),
        updates,
        commands,
        completed: Mutex::new(None),
        discarded: AtomicBool::new(false),
        admitted_identity: Mutex::new(None),
        handoff: watch::channel(None).0,
    });
    let (frames, frame_rx) = flume::bounded(1);
    let runner = PreparingRunner {
        control: control.clone(),
        frames,
        stop: None,
        resolution,
        audio_output,
        commands: Some(command_rx),
        command_task: None,
        frame_discard: frame_rx.clone(),
    };
    let mut joined = PreparingJoin::from_task(runtime, runtime.spawn(runner.run()));
    joined.control = Arc::downgrade(&control);
    (PreparingConsumer { control }, joined, frame_rx)
}

impl PreparingRunner {
    async fn run(mut self) -> Result<PreparingJoined, String> {
        let result = AssertUnwindSafe(self.run_inner()).catch_unwind().await;
        let adopted = matches!(&result, Ok(Ok(())))
            && self
                .control
                .handoff
                .borrow()
                .as_ref()
                .is_some_and(|handoff| handoff.committed());
        if adopted {
            self.control.accepts_frames.store(false, Ordering::Release);
            self.control.cancelled.send_replace(true);
            self.stop = None;
        } else {
            self.control.cancel();
        }
        match result {
            Ok(Err(error)) => tracing::debug!(%error, "Preparing playback declined"),
            Err(_) => tracing::warn!("Preparing playback adapter panicked"),
            Ok(Ok(())) => {}
        }
        let command_error = if let Some(task) = self.command_task.take() {
            task.await.err().map(|error| error.to_string())
        } else {
            None
        };
        let exit = if let Some(stop) = self.stop.take() {
            Some(stop.stop_and_wait().await)
        } else {
            None
        };
        if let Some(exit) = &exit {
            if exit.snapshot.progress.phase == cap_editor::PreparingEditorPhase::Unavailable {
                let latest = self.control.updates.borrow().clone();
                if let Some(mut update) = latest {
                    update.sequence = progress_sequence(exit.snapshot.sequence)?;
                    update.progress = exit.snapshot.progress.clone();
                    update.playback = exit.snapshot.playback;
                    self.control.updates.send_replace(Some(update));
                }
            }
            let mut completed = self
                .control
                .completed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.control.discarded.load(Ordering::Acquire)
                || exit.cleanup_failed
                || command_error.is_some()
            {
                drop(exit.take_completed_audio());
            } else {
                *completed = Some(exit.clone());
            }
        }
        if exit.as_ref().is_some_and(|exit| exit.cleanup_failed) {
            return Err("Preparing playback workers could not be joined".into());
        }
        if let Some(error) = command_error {
            return Err(format!("Preparing command task cleanup failed: {error}"));
        }
        if adopted {
            self.control.handoff.send_replace(None);
        }
        Ok(PreparingJoined {
            epoch: self.control.epoch.clone(),
            exit,
        })
    }

    async fn run_inner(&mut self) -> Result<(), String> {
        let mut cancel = self.control.cancelled.subscribe();
        if *cancel.borrow() {
            return Ok(());
        }
        let observer = tokio::select! {
            biased;
            _ = cancel.changed() => return Ok(()),
            observer = self.control.finalization.wait_for_preparing() => observer,
        };
        let Some(mut observer) = observer else {
            return Ok(());
        };
        let sources = loop {
            match observer.latest() {
                PreparingStudioState::Available(sources) => break sources,
                PreparingStudioState::Unavailable(reason) => return Err(reason),
                PreparingStudioState::Ended => return Ok(()),
                PreparingStudioState::Waiting => {}
            }
            tokio::select! {
                biased;
                _ = cancel.changed() => return Ok(()),
                _ = observer.changed() => {}
            }
        };
        if !self
            .control
            .accepts_status(&self.control.epoch, observer.identity())
        {
            return Ok(());
        }
        *self
            .control
            .admitted_identity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(observer.identity().clone());
        tracing::info!(
            elapsed_ms = self.control.started.elapsed().as_secs_f64() * 1000.0,
            "GPUI preparing sources available"
        );
        let adapter_control = self.control.clone();
        let (input, audio) = tokio::task::spawn_blocking(move || adapt(sources, &adapter_control))
            .await
            .map_err(|error| error.to_string())??;
        if *cancel.borrow() || !matches!(observer.latest(), PreparingStudioState::Available(_)) {
            return Ok(());
        }
        tracing::info!(
            elapsed_ms = self.control.started.elapsed().as_secs_f64() * 1000.0,
            "GPUI preparing adapter ready"
        );
        let seed = Arc::new(PreparingTimelineSeed {
            project: input.project.clone(),
            pretty_name: input.recording_meta.pretty_name.clone(),
            has_camera: input
                .recording_meta
                .studio_meta()
                .is_some_and(|studio| match studio {
                    cap_project::StudioRecordingMeta::SingleSegment { segment } => {
                        segment.camera.is_some()
                    }
                    cap_project::StudioRecordingMeta::MultipleSegments { inner, .. } => inner
                        .segments
                        .iter()
                        .any(|segment| segment.camera.is_some()),
                }),
            multiple_clips: input.segments.len() > 1,
        });
        let total_duration = input
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.duration())
            .filter(|duration| duration.is_finite() && *duration > 0.0);
        self.control.updates.send_replace(Some(PreparingUpdate {
            epoch: self.control.epoch.clone(),
            identity: observer.identity().clone(),
            sequence: 1,
            seed: seed.clone(),
            progress: cap_editor::PreparingEditorProgress {
                total_duration,
                ..Default::default()
            },
            playback: cap_editor::PreparingPlaybackState::default(),
        }));
        let control = self.control.clone();
        let identity = observer.identity().clone();
        let frame_observer = observer.clone();
        let frames = self.frames.clone();
        let discard = self.frame_discard.clone();
        #[cfg(target_os = "macos")]
        let frame_format = EditorFrameFormat::BgraSurface;
        #[cfg(not(target_os = "macos"))]
        let frame_format = EditorFrameFormat::Rgba;
        self.control.accepts_frames.store(true, Ordering::Release);
        let playback = PreparingPlaybackSession::spawn_with_expected_metadata(
            input,
            audio.tracks,
            PreparingPlaybackOptions {
                preview: PreparingPreviewOptions {
                    use_hardware_decoding: preparing_hardware_decode(),
                    frame_format,
                },
                fps: crate::editor_window::EDITOR_PREVIEW_FPS,
                resolution: self.resolution,
            },
            self.audio_output.clone(),
            Box::new(move |request, output, layout| {
                if accepts_composed_frame(
                    control.accepts(&control.epoch, &identity),
                    frame_observer.latest(),
                    control
                        .finalization
                        .allows_preparing_continuation(&identity),
                ) {
                    tracing::debug!(
                        elapsed_ms = control.started.elapsed().as_secs_f64() * 1000.0,
                        "GPUI preparing composed frame produced"
                    );
                    let frame = PreparingFrame {
                        epoch: control.epoch.clone(),
                        identity: identity.clone(),
                        request,
                        output,
                        layout,
                    };
                    if let Err(flume::TrySendError::Full(frame)) = frames.try_send(frame) {
                        drop(discard.try_recv());
                        let _ = frames.try_send(frame);
                    }
                }
            }),
            audio.expected_metadata,
        )?;
        self.stop = Some(playback.stop_handle());
        let handoff = playback.handoff_handle();
        self.control.handoff.send_replace(Some(handoff.clone()));
        let mut updates = playback.updates();
        let controller = playback.controller();
        let mut commands = self
            .commands
            .take()
            .ok_or("Preparing commands already started")?;
        let mut command_cancel = self.control.cancelled.subscribe();
        self.command_task = Some(tokio::spawn(async move {
            loop {
                if *command_cancel.borrow() {
                    return;
                }
                let (command, _intent) = tokio::select! {
                    biased;
                    _ = command_cancel.changed() => return,
                    command = commands.recv() => match command { Some(command) => command, None => return },
                };
                let applied = async {
                    if command.playing == Some(false) {
                        controller.set_playing(false).await?;
                    }
                    if let Some(seek) = command.seek {
                        controller.seek(seek).await?;
                    }
                    if command.playing == Some(true) {
                        controller.set_playing(true).await?;
                    }
                    Ok::<(), String>(())
                };
                tokio::select! {
                    biased;
                    _ = command_cancel.changed() => return,
                    result = applied => {
                        if let Err(error) = result {
                            tracing::debug!(%error, "Preparing playback command declined");
                        }
                    }
                }
            }
        }));
        let mut observing = true;
        loop {
            let snapshot = updates.borrow_and_update().clone();
            self.control.updates.send_replace(Some(PreparingUpdate {
                epoch: self.control.epoch.clone(),
                identity: observer.identity().clone(),
                sequence: progress_sequence(snapshot.sequence)?,
                seed: seed.clone(),
                progress: snapshot.progress,
                playback: snapshot.playback,
            }));
            tokio::select! {
                biased;
                _ = cancel.changed() => return Ok(()),
                _ = handoff.wait_committed() => return Ok(()),
                state = observer.changed(), if observing => {
                    if !matches!(state, PreparingStudioState::Available(_)) {
                        if !self.control.finalization.allows_preparing_continuation(observer.identity()) { return Ok(()); }
                        observing = false;
                    }
                }
                result = updates.changed() => { if result.is_err() { return Ok(()); } }
            }
        }
    }
}

fn accepts_composed_frame(
    consumer_accepts: bool,
    state: PreparingStudioState,
    publication_continues: bool,
) -> bool {
    consumer_accepts
        && (matches!(state, PreparingStudioState::Available(_)) || publication_continues)
}

fn progress_sequence(sequence: u64) -> Result<u64, String> {
    sequence
        .checked_add(2)
        .ok_or_else(|| "Preparing progress sequence exhausted".into())
}

fn preparing_hardware_decode() -> bool {
    !cfg!(target_os = "windows")
}

fn adapt(
    sources: Arc<PreparingStudioSources>,
    control: &Arc<ConsumerControl>,
) -> Result<(PreparingPreviewInput, audio::AudioAdaptation), String> {
    let ended = || "Preparing sources ended".to_string();
    let live = sources.live().ok_or_else(ended)?;
    let recording_meta = live.metadata().ok_or_else(ended)?.clone();
    let studio = recording_meta.studio_meta().ok_or_else(ended)?;
    let mut project =
        crate::recording::preparing_presentation(live.configuration().ok_or_else(ended)?)?;
    if project.clips.is_empty() {
        project.clips =
            cap_editor::initial_clip_configuration(&recording_meta.project_path, studio);
    }
    let descriptors = live.segments().ok_or_else(ended)?;
    let pointer_ids = studio.pointer_cursor_ids();
    let mut segments = Vec::with_capacity(descriptors.len());
    let mut cursor_budget = MAX_CURSOR_BYTES;
    for descriptor in descriptors {
        if *control.cancelled.borrow() || sources.live().is_none() {
            return Err(ended());
        }
        let display = live
            .video(descriptor.index(), PreparingVideoTrack::Display)
            .ok_or_else(ended)?;
        let (source, paths) = display.input().ok_or_else(ended)?;
        let display = ManagedVideoTrackInput::new(source.clone(), paths.to_vec())
            .map_err(|error| error.to_string())?;
        let camera = if descriptor.camera().is_some() {
            let camera = live
                .video(descriptor.index(), PreparingVideoTrack::Camera)
                .ok_or_else(ended)?;
            let (source, paths) = camera.input().ok_or_else(ended)?;
            Some(
                ManagedVideoTrackInput::new(source.clone(), paths.to_vec())
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        let mut cursor = if descriptor.cursor_path().is_some() {
            let cursor = live
                .sidecar(descriptor.index(), PreparingSidecarKind::Cursor)
                .ok_or_else(ended)?;
            let (source, path) = cursor.input().ok_or_else(ended)?;
            let reader = source.reader(path).map_err(|error| error.to_string())?;
            let mut reader = BufReader::new(CheckedCursorReader {
                reader,
                is_live: || !*control.cancelled.borrow() && sources.live().is_some(),
                remaining: cursor_budget,
            });
            let cursor = CursorEvents::load_from_reader(&mut reader)?;
            cursor_budget = reader.get_ref().remaining;
            cursor
        } else {
            CursorEvents::default()
        };
        cursor.stabilize_short_lived_cursor_shapes(
            (!pointer_ids.is_empty()).then_some(&pointer_ids),
            cap_project::cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
        );
        segments.push(PreparingPreviewSegment {
            video: ManagedSegmentVideoInput::new(
                descriptor.index() as usize,
                studio,
                display,
                camera,
            )
            .map_err(|error| error.to_string())?,
            cursor: Arc::new(cursor),
        });
    }
    let images = descriptors
        .first()
        .ok_or_else(ended)?
        .cursor_images()
        .iter()
        .map(|asset| {
            (
                asset.id().to_string(),
                asset.metadata().clone(),
                Arc::<[u8]>::from(asset.bytes()),
            )
        });
    let cursor_assets =
        FrozenRecordedCursorAssets::new(images).map_err(|error| error.to_string())?;
    if *control.cancelled.borrow() || sources.live().is_none() {
        return Err(ended());
    }
    let audio = audio::adapt_audio(&sources, &recording_meta, control)?;
    Ok((
        PreparingPreviewInput {
            recording_meta,
            project,
            segments,
            cursor_assets,
        },
        audio,
    ))
}

struct CheckedCursorReader<R, F> {
    reader: R,
    is_live: F,
    remaining: u64,
}

impl<R: Read, F: Fn() -> bool> Read for CheckedCursorReader<R, F> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if !(self.is_live)() {
            return Err(io::Error::other("Preparing sources ended"));
        }
        if self.remaining == 0 {
            let mut next = [0];
            return if self.reader.read(&mut next)? == 0 {
                Ok(0)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Cursor sidecar exceeds preparing limit",
                ))
            };
        }
        let length = output.len().min(self.remaining as usize);
        let count = self.reader.read(&mut output[..length])?;
        self.remaining -= count as u64;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn joined() -> PreparingJoined {
        PreparingJoined {
            epoch: PreparingEpoch(Arc::new(())),
            exit: None,
        }
    }

    #[test]
    fn composed_frame_gate_keeps_published_footage_and_rejects_inactive_consumers() {
        let (state, observer) = watch::channel(PreparingStudioState::Waiting);
        assert!(!accepts_composed_frame(
            true,
            observer.borrow().clone(),
            false
        ));
        state.send_replace(PreparingStudioState::Ended);
        assert!(!accepts_composed_frame(
            true,
            observer.borrow().clone(),
            false
        ));
        assert!(accepts_composed_frame(
            true,
            observer.borrow().clone(),
            true
        ));
        assert!(
            !accepts_composed_frame(false, observer.borrow().clone(), true),
            "publication must not bypass cancellation or supersession"
        );
        state.send_replace(PreparingStudioState::Unavailable(
            "finalization failed".into(),
        ));
        assert!(!accepts_composed_frame(
            true,
            observer.borrow().clone(),
            false
        ));
    }

    #[test]
    fn preparing_epochs_do_not_alias_reopened_windows() {
        let first = PreparingEpoch(Arc::new(()));
        let reopened = PreparingEpoch(Arc::new(()));
        assert!(first.same(&first.clone()));
        assert!(!first.same(&reopened));
    }

    #[test]
    fn cursor_reader_preserves_exact_limit_and_rejects_an_extra_byte() {
        let bytes = br#"{"clicks":[],"moves":[]}"#;
        for remaining in [bytes.len() as u64, bytes.len() as u64 - 1] {
            let reader = CheckedCursorReader {
                reader: Cursor::new(bytes),
                is_live: || true,
                remaining,
            };
            let result = CursorEvents::load_from_reader(BufReader::new(reader));
            assert_eq!(result.is_ok(), remaining == bytes.len() as u64);
        }
    }

    #[test]
    fn cursor_cancellation_is_terminal_instead_of_retryable_interrupted() {
        let mut reader = CheckedCursorReader {
            reader: Cursor::new(b"retained"),
            is_live: || false,
            remaining: 100,
        };
        assert_eq!(
            reader.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::Other
        );
        assert_eq!(reader.reader.position(), 0);
        assert_eq!(reader.read(&mut []).unwrap(), 0);
    }

    #[tokio::test]
    async fn close_before_admission_joins_even_when_first_waiter_is_dropped() {
        let (_publisher, finalization) = StudioFinalization::channel("test.cap".into(), 7);
        let (consumer, joined, _frames) = spawn(
            finalization,
            XY::new(320, 240),
            Arc::new(cap_editor::AudioOutput::new_headless(Box::new(|_, _| {}))),
            &tokio::runtime::Handle::current(),
        );
        let retained = joined.clone();
        drop(joined);
        drop(consumer);
        retained.wait().await.unwrap();
    }

    #[tokio::test]
    async fn panicked_cleanup_task_never_allows_ordinary_loading() {
        let runtime = tokio::runtime::Handle::current();
        let joined =
            PreparingJoin::from_task(&runtime, runtime.spawn(async { panic!("cleanup failed") }));
        assert!(joined.wait().await.is_err());
        assert!(!joined.completed_successfully());
    }

    #[tokio::test]
    async fn reopened_window_waits_the_old_windows_actual_task_exit() {
        let runtime = tokio::runtime::Handle::current();
        let (release, stopped) = tokio::sync::oneshot::channel();
        let old = PreparingJoin::from_task(
            &runtime,
            runtime.spawn(async move {
                stopped.await.unwrap();
                Ok(joined())
            }),
        );
        let new = PreparingJoin::from_task(&runtime, runtime.spawn(async { Ok(joined()) }));
        let mut registry = PreparingCleanupRegistry::default();
        registry.register("recording.cap".into(), old.clone());
        registry.register("recording.cap".into(), new.clone());
        new.wait().await.unwrap();
        let pending = registry.pending(Path::new("recording.cap"));
        assert_eq!(pending.len(), 1);
        assert!(pending[0].wait().now_or_never().is_none());
        release.send(()).unwrap();
        pending[0].wait().await.unwrap();
        assert!(registry.pending(Path::new("recording.cap")).is_empty());
    }

    #[tokio::test]
    async fn failed_join_is_retained_for_its_project_only() {
        let runtime = tokio::runtime::Handle::current();
        let failed = PreparingJoin::from_task(
            &runtime,
            runtime.spawn(async { Err("missing join".into()) }),
        );
        assert!(failed.wait().await.is_err());
        let mut registry = PreparingCleanupRegistry::default();
        registry.register("failed.cap".into(), failed);
        assert!(registry.pending(Path::new("other.cap")).is_empty());
        let pending = registry.pending(Path::new("failed.cap"));
        assert_eq!(pending.len(), 1);
        assert!(pending[0].wait().await.is_err());
    }

    #[test]
    fn initial_core_progress_follows_seed_and_cannot_wrap() {
        let mut presentation = presentation::PreparingPresentation::default();
        assert!(presentation.apply(1, Default::default(), Default::default()));
        assert!(presentation.apply(
            progress_sequence(0).unwrap(),
            Default::default(),
            Default::default()
        ));
        assert!(!presentation.apply(1, Default::default(), Default::default()));
        assert_eq!(progress_sequence(u64::MAX - 2).unwrap(), u64::MAX);
        assert!(progress_sequence(u64::MAX - 1).is_err());
    }

    #[tokio::test]
    async fn queued_commands_are_bounded_and_close_joins_without_admission() {
        let (_publisher, finalization) = StudioFinalization::channel("test.cap".into(), 9);
        let (consumer, joined, _frames) = spawn(
            finalization,
            XY::new(320, 240),
            Arc::new(cap_editor::AudioOutput::new_headless(Box::new(|_, _| {}))),
            &tokio::runtime::Handle::current(),
        );
        assert!(!consumer.command(PreparingCommand {
            seek: Some(0.0),
            playing: Some(true)
        }));
        let control = consumer.control.clone();
        let permits = (0..8)
            .map(|_| control.commands.try_reserve().unwrap())
            .collect::<Vec<_>>();
        assert!(control.commands.try_reserve().is_err());
        drop(consumer);
        tokio::time::timeout(std::time::Duration::from_secs(1), joined.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(*control.cancelled.borrow());
        assert!(control.discarded.load(Ordering::Acquire));
        assert!(control.commands.is_closed());
        drop(permits);
    }

    #[test]
    fn preparing_decode_preference_matches_the_ordinary_platform_path() {
        #[cfg(target_os = "windows")]
        assert!(!preparing_hardware_decode());
        #[cfg(not(target_os = "windows"))]
        assert!(preparing_hardware_decode());
    }
}
