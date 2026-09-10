use std::{
    collections::HashMap,
    io::{self, BufReader, Read},
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use cap_editor::{
    EditorFrameFormat, PreparingEditorProgress, PreparingPlaybackController, PreparingPlaybackExit,
    PreparingPlaybackOptions, PreparingPlaybackSession, PreparingPlaybackSnapshot,
    PreparingPlaybackState, PreparingPlaybackStopHandle, PreparingPreviewInput,
    PreparingPreviewOptions, PreparingPreviewSegment,
};
use cap_project::{CursorEvents, ProjectConfiguration};
use cap_recording::recovery::{
    PreparingSidecarKind, PreparingStudioSources, PreparingStudioState, PreparingVideoTrack,
};
use cap_rendering::{FrozenRecordedCursorAssets, ManagedSegmentVideoInput, ManagedVideoTrackInput};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Window};
use tauri_specta::Event;
use tokio::sync::{oneshot, watch};

use crate::frame_ws::{OwnedWatchFrameWs, WSFrame};
use crate::{
    FinalizationProject, FinalizingRecordings,
    preparing_finalization::FinalizationPreparing,
    windows::{CapWindowId, EditorWindowIds},
};

mod audio;

const MAX_CURSOR_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparingEditorSeed {
    title: String,
    tracks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparingEditorChanged {
    request_epoch: u32,
    job_id: String,
    sequence: u32,
    fps: u32,
    progress: PreparingEditorProgress,
    playback: PreparingPlaybackState,
    seed: PreparingEditorSeed,
}

#[derive(Default)]
struct PlaybackBinding {
    latest: Option<PreparingEditorChanged>,
    controller: Option<PreparingPlaybackController>,
    audio_output: Option<Arc<cap_editor::AudioOutput>>,
    exit: Option<PreparingPlaybackExit>,
    handoff: Option<cap_editor::PreparingPlaybackHandoff>,
}

#[derive(Clone)]
struct RetainedJoin(Shared<BoxFuture<'static, Result<(), String>>>);

impl RetainedJoin {
    fn new(task: tokio::task::JoinHandle<Result<(), String>>) -> Self {
        let completion = async move {
            task.await
                .map_err(|error| format!("Preparing cleanup task failed: {error}"))?
        }
        .boxed()
        .shared();
        let retained = completion.clone();
        drop(tokio::spawn(async move {
            let _ = retained.await;
        }));
        Self(completion)
    }

    async fn wait(&self) -> Result<(), String> {
        self.0.clone().await
    }
    fn succeeded(&self) -> bool {
        self.0.peek().is_some_and(Result::is_ok)
    }
}

struct ConsumerControl {
    window_ids: EditorWindowIds,
    window_id: u32,
    request_epoch: u32,
    path: PathBuf,
    finalization: FinalizationPreparing,
    cancelled: watch::Sender<bool>,
    accepts_frames: AtomicBool,
    playback: Mutex<PlaybackBinding>,
    publish: Option<Box<dyn Fn(PreparingEditorChanged) + Send + Sync>>,
}

impl ConsumerControl {
    fn cancel(&self) {
        if let Some(handoff) = &self.playback.lock().unwrap().handoff {
            handoff.cancel();
        }
        self.accepts_frames.store(false, Ordering::Release);
        self.cancelled.send_replace(true);
    }

    fn is_active(&self) -> bool {
        !*self.cancelled.borrow()
            && self
                .window_ids
                .ids
                .lock()
                .unwrap()
                .iter()
                .any(|(path, id)| *id == self.window_id && path == &self.path)
            && (self.finalization.is_pending() || self.finalization.allows_preparing_continuation())
    }

    fn publish_snapshot(&self, snapshot: &PreparingPlaybackSnapshot) {
        let update = {
            let mut binding = self.playback.lock().unwrap();
            let Some(latest) = binding.latest.as_mut() else {
                return;
            };
            latest.sequence = latest.sequence.saturating_add(1);
            latest.progress = snapshot.progress.clone();
            latest.playback = snapshot.playback;
            latest.clone()
        };
        if let Some(publish) = &self.publish {
            publish(update);
        }
    }

    fn accepts(&self) -> bool {
        self.accepts_frames.load(Ordering::Acquire) && self.is_active()
    }

    fn retire_playback(&self) {
        let output = {
            let mut binding = self.playback.lock().unwrap();
            binding.controller = None;
            binding.exit = None;
            if let Some(handoff) = binding.handoff.take() {
                handoff.cancel();
            }
            binding.audio_output.take()
        };
        if let Some(output) = output {
            output.shutdown();
        }
    }
}

struct Entry {
    control: Arc<ConsumerControl>,
    joined: RetainedJoin,
}

#[derive(Default)]
struct ProjectConsumers {
    ordinary_loading: bool,
    entries: Vec<Entry>,
}

#[derive(Default)]
struct Registry {
    projects: HashMap<PathBuf, ProjectConsumers>,
    epochs: HashMap<u32, u32>,
}

#[derive(Clone, Default)]
pub(crate) struct PreparingConsumers(Arc<Mutex<Registry>>);

impl PreparingConsumers {
    pub(crate) async fn dispose_all(&self) -> Result<(), String> {
        let paths = {
            let registry = self.0.lock().unwrap();
            for project in registry.projects.values() {
                for entry in &project.entries {
                    entry.control.cancel();
                }
            }
            registry.projects.keys().cloned().collect::<Vec<_>>()
        };
        let mut failure = None;
        for path in paths {
            if let Err(error) = self.before_ordinary_loading(&path).await {
                failure.get_or_insert(error);
            }
        }
        for project in self.0.lock().unwrap().projects.values() {
            for entry in &project.entries {
                entry.control.retire_playback();
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(crate) fn cancel_window(&self, window_id: u32, epoch: Option<u32>) {
        let registry = self.0.lock().unwrap();
        let mut closed = Vec::new();
        for project in registry.projects.values() {
            for entry in &project.entries {
                if entry.control.window_id == window_id
                    && epoch.is_none_or(|epoch| entry.control.request_epoch == epoch)
                {
                    let adopted = epoch.is_some()
                        && entry
                            .control
                            .playback
                            .lock()
                            .unwrap()
                            .handoff
                            .as_ref()
                            .is_some_and(|handoff| handoff.committed());
                    if adopted {
                        entry.control.accepts_frames.store(false, Ordering::Release);
                        entry.control.cancelled.send_replace(true);
                    } else {
                        entry.control.cancel();
                    }
                    if epoch.is_none() {
                        closed.push((entry.control.clone(), entry.joined.clone()));
                    }
                }
            }
        }
        drop(registry);
        if !closed.is_empty() {
            let registry = self.clone();
            drop(tokio::spawn(async move {
                for (control, joined) in closed {
                    let _ = joined.wait().await;
                    control.retire_playback();
                }
                for project in registry.0.lock().unwrap().projects.values_mut() {
                    project.entries.retain(|entry| {
                        entry.control.window_id != window_id || !entry.joined.succeeded()
                    });
                }
            }));
        }
    }

    fn control_for_window(
        &self,
        window_id: u32,
        epoch: Option<u32>,
    ) -> Option<Arc<ConsumerControl>> {
        self.0
            .lock()
            .unwrap()
            .projects
            .values()
            .flat_map(|project| &project.entries)
            .filter(|entry| {
                entry.control.window_id == window_id
                    && epoch.is_none_or(|epoch| entry.control.request_epoch == epoch)
            })
            .max_by_key(|entry| entry.control.request_epoch)
            .map(|entry| entry.control.clone())
    }

    pub(crate) fn snapshot_for_window(&self, window_id: u32) -> Option<PreparingEditorChanged> {
        self.control_for_window(window_id, None)?
            .playback
            .lock()
            .unwrap()
            .latest
            .clone()
    }

    pub(crate) async fn take_startup(
        &self,
        path: &Path,
    ) -> Result<
        (
            Arc<cap_editor::AudioOutput>,
            cap_editor::EditorStartupInputs,
            Option<cap_editor::PreparingPlaybackHandoff>,
        ),
        String,
    > {
        let latest = {
            let registry = self.0.lock().unwrap();
            registry.projects.get(path).and_then(|project| {
                project
                    .entries
                    .iter()
                    .filter(|entry| {
                        entry.joined.succeeded()
                            || (entry.control.is_active()
                                && entry.control.finalization.allows_preparing_continuation())
                    })
                    .max_by_key(|entry| entry.control.request_epoch)
                    .map(|entry| (entry.control.clone(), entry.joined.clone()))
            })
        };
        if let Some((control, joined)) = latest {
            let handoff = control.playback.lock().unwrap().handoff.clone();
            let mut completed_audio = None;
            let mut continuing = None;
            if let Some(handoff) = handoff {
                match handoff.take_completed_audio().await {
                    Ok(audio) => {
                        completed_audio = Some(audio);
                        continuing = Some(handoff);
                    }
                    Err(_) => {
                        control.cancel();
                        joined.wait().await?;
                    }
                }
            }
            let mut binding = control.playback.lock().unwrap();
            if completed_audio.is_none() {
                completed_audio = binding
                    .exit
                    .take()
                    .and_then(|exit| exit.take_completed_audio());
            }
            let output = binding
                .audio_output
                .take()
                .unwrap_or_else(|| Arc::new(cap_editor::AudioOutput::new()));
            return Ok((
                output,
                cap_editor::EditorStartupInputs {
                    recordings: None,
                    completed_audio,
                },
                continuing,
            ));
        }
        Ok((
            Arc::new(cap_editor::AudioOutput::new()),
            cap_editor::EditorStartupInputs::default(),
            None,
        ))
    }

    pub(crate) async fn before_ordinary_loading(&self, path: &Path) -> Result<(), String> {
        let pending = {
            let mut registry = self.0.lock().unwrap();
            let project = registry.projects.entry(path.to_path_buf()).or_default();
            project.ordinary_loading = true;
            project
                .entries
                .iter()
                .filter_map(|entry| {
                    if entry.control.is_active()
                        && entry.control.finalization.allows_preparing_continuation()
                        && entry.control.playback.lock().unwrap().handoff.is_some()
                    {
                        return None;
                    }
                    entry.control.cancel();
                    Some(entry.joined.clone())
                })
                .collect::<Vec<_>>()
        };
        let mut failure = None;
        for joined in pending {
            if let Err(error) = joined.wait().await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn create_preparing_editor_frame(
    window: Window,
    request_epoch: u32,
) -> Result<Option<String>, String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|error| error.to_string())?
    else {
        return Err("Invalid editor window".into());
    };
    let app = window.app_handle();
    let window_ids = EditorWindowIds::get(app);
    let path = window_ids
        .ids
        .lock()
        .unwrap()
        .iter()
        .find(|(_, current)| *current == id)
        .map(|(path, _)| path.clone())
        .ok_or("Editor window is closed")?;
    let project = FinalizationProject::observe(path.clone()).await?;
    if path != project.work_path() {
        return Ok(None);
    }
    let Some(finalization) = app
        .state::<FinalizingRecordings>()
        .preparing_for_project(&project)
    else {
        return Ok(None);
    };
    let registry = app.state::<PreparingConsumers>().inner().clone();
    let (response, result) = oneshot::channel();
    {
        let ids = window_ids.ids.lock().unwrap();
        if !ids
            .iter()
            .any(|(registered, current)| *current == id && registered == &path)
        {
            return Ok(None);
        }
        let mut registry = registry.0.lock().unwrap();
        if request_epoch == 0
            || registry
                .epochs
                .get(&id)
                .is_some_and(|epoch| *epoch >= request_epoch)
        {
            return Ok(None);
        }
        registry.epochs.insert(id, request_epoch);
        let project = registry.projects.entry(path.clone()).or_default();
        if project.ordinary_loading || !finalization.is_pending() {
            return Ok(None);
        }
        project.entries.retain(|entry| !entry.joined.succeeded());
        let previous = project
            .entries
            .iter()
            .map(|entry| {
                entry.control.cancel();
                (entry.joined.clone(), entry.control.clone())
            })
            .collect();
        let control = Arc::new(ConsumerControl {
            window_ids: window_ids.clone(),
            window_id: id,
            request_epoch,
            path,
            finalization,
            cancelled: watch::channel(false).0,
            accepts_frames: AtomicBool::new(false),
            playback: Mutex::default(),
            publish: Some(Box::new({
                let window = window.clone();
                move |snapshot| {
                    let _ = snapshot.emit_to(&window, window.label());
                }
            })),
        });
        let runner = Runner {
            control: control.clone(),
            previous,
            response: Some(response),
            transport: None,
            stop: None,
            frames: watch::channel(None).0,
        };
        let joined = RetainedJoin::new(tokio::spawn(runner.run()));
        project.entries.push(Entry { control, joined });
    }
    result
        .await
        .map_err(|error| format!("Preparing frame admission failed: {error}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn stop_preparing_editor_frame(
    window: Window,
    request_epoch: u32,
) -> Result<(), String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|error| error.to_string())?
    else {
        return Err("Invalid editor window".into());
    };
    window
        .app_handle()
        .state::<PreparingConsumers>()
        .cancel_window(id, Some(request_epoch));
    Ok(())
}

fn editor_window_id(window: &Window) -> Result<u32, String> {
    match CapWindowId::from_str(window.label()).map_err(|error| error.to_string())? {
        CapWindowId::Editor { id } => Ok(id),
        _ => Err("Invalid editor window".into()),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_preparing_editor_state(
    window: Window,
    request_epoch: u32,
) -> Result<Option<PreparingEditorChanged>, String> {
    let id = editor_window_id(&window)?;
    let state = window.state::<PreparingConsumers>();
    Ok(state
        .control_for_window(id, Some(request_epoch))
        .and_then(|control| control.playback.lock().unwrap().latest.clone()))
}

fn playback_controller(
    window: &Window,
    request_epoch: u32,
    job_id: &str,
) -> Result<PreparingPlaybackController, String> {
    let id = editor_window_id(window)?;
    let control = window
        .state::<PreparingConsumers>()
        .control_for_window(id, Some(request_epoch))
        .ok_or("Preparing editor is closed")?;
    {
        let binding = control.playback.lock().unwrap();
        if binding
            .latest
            .as_ref()
            .is_none_or(|latest| latest.job_id != job_id)
        {
            return Err("Preparing editor identity changed".into());
        }
        if binding
            .handoff
            .as_ref()
            .is_some_and(|handoff| handoff.committed())
        {
            return Err("Preparing playback has been adopted".into());
        }
    }
    if !control.is_active() {
        return Err("Preparing editor has ended".into());
    }
    let binding = control.playback.lock().unwrap();
    binding
        .controller
        .clone()
        .ok_or_else(|| "Preparing playback is not available".into())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn seek_preparing_editor(
    window: Window,
    request_epoch: u32,
    job_id: String,
    seconds: f64,
) -> Result<(), String> {
    playback_controller(&window, request_epoch, &job_id)?
        .seek(seconds)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_preparing_editor_playing(
    window: Window,
    request_epoch: u32,
    job_id: String,
    playing: bool,
) -> Result<(), String> {
    playback_controller(&window, request_epoch, &job_id)?
        .set_playing(playing)
        .await
}

pub(crate) async fn join_before_ordinary(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.state::<PreparingConsumers>()
        .inner()
        .clone()
        .before_ordinary_loading(path)
        .await
}

struct Runner {
    control: Arc<ConsumerControl>,
    previous: Vec<(RetainedJoin, Arc<ConsumerControl>)>,
    response: Option<oneshot::Sender<Option<String>>>,
    transport: Option<OwnedWatchFrameWs>,
    stop: Option<PreparingPlaybackStopHandle>,
    frames: watch::Sender<Option<Arc<WSFrame>>>,
}

impl Runner {
    async fn run(mut self) -> Result<(), String> {
        let result = AssertUnwindSafe(self.run_inner()).catch_unwind().await;
        let adopted = matches!(&result, Ok(Ok(())))
            && self
                .control
                .playback
                .lock()
                .unwrap()
                .handoff
                .as_ref()
                .is_some_and(|handoff| handoff.committed());
        if adopted {
            self.control.accepts_frames.store(false, Ordering::Release);
            self.control.cancelled.send_replace(true);
            self.stop = None;
        } else {
            self.control.cancel();
        }
        self.frames.send_replace(None);
        if let Some(response) = self.response.take() {
            let _ = response.send(None);
        }
        let mut failure = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => {
                tracing::debug!(%error, "Tauri preparing preview declined");
                None
            }
            Err(_) => {
                tracing::warn!("Tauri preparing adapter panicked");
                None
            }
        };
        if let Some(stop) = &self.stop {
            stop.cancel();
        }
        if let Some(transport) = self.transport.take()
            && let Err(error) = transport.stop_and_wait().await
        {
            failure.get_or_insert(error);
        }
        if let Some(stop) = self.stop.take() {
            let exit = stop.stop_and_wait().await;
            self.control.publish_snapshot(&exit.snapshot);
            if exit.cleanup_failed {
                failure.get_or_insert_with(|| {
                    exit.error
                        .clone()
                        .unwrap_or_else(|| "Preparing media cleanup failed".into())
                });
            }
            let mut binding = self.control.playback.lock().unwrap();
            binding.controller = None;
            binding.exit = Some(exit);
        }
        failure.map_or(Ok(()), Err)
    }

    async fn run_inner(&mut self) -> Result<(), String> {
        for (previous, control) in &self.previous {
            let result = previous.wait().await;
            control.retire_playback();
            result?;
        }
        if !self.control.is_active() {
            return Ok(());
        }
        let control = self.control.clone();
        let transport = crate::frame_ws::create_owned_watch_frame_ws(
            self.frames.subscribe(),
            Arc::new(move || control.accepts()),
        )
        .await?;
        let url = transport.url.clone();
        self.transport = Some(transport);
        if let Some(response) = self.response.take()
            && response.send(Some(url)).is_err()
        {
            return Ok(());
        }
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
        let presentation = tokio::select! {
            biased;
            _ = cancel.changed() => return Ok(()),
            presentation = self.control.finalization.wait_for_presentation() => presentation,
        };
        let Some(presentation) = presentation else {
            return Ok(());
        };
        let sources = loop {
            match observer.latest() {
                PreparingStudioState::Available(sources) => break sources,
                PreparingStudioState::Unavailable(error) => return Err(error),
                PreparingStudioState::Ended => return Ok(()),
                PreparingStudioState::Waiting => {}
            }
            tokio::select! {
                biased;
                _ = cancel.changed() => return Ok(()),
                _ = observer.changed() => {},
            }
        };
        let control = self.control.clone();
        let job_id = sources.identity().job_id().to_string();
        let (input, audio) =
            tokio::task::spawn_blocking(move || adapt(sources, &control, &presentation))
                .await
                .map_err(|error| format!("Preparing adapter join failed: {error}"))??;
        if !self.control.is_active()
            || !matches!(observer.latest(), PreparingStudioState::Available(_))
        {
            return Ok(());
        }
        let control = self.control.clone();
        let frame_observer = observer.clone();
        let frames = self.frames.clone();
        let mut tracks = vec!["display".to_string()];
        if let Some(cap_project::StudioRecordingMeta::MultipleSegments { inner }) =
            input.recording_meta.studio_meta()
        {
            if inner
                .segments
                .iter()
                .any(|segment| segment.camera.is_some())
            {
                tracks.push("camera".into());
            }
            if inner.segments.iter().any(|segment| segment.mic.is_some()) {
                tracks.push("microphone".into());
            }
            if inner
                .segments
                .iter()
                .any(|segment| segment.system_audio.is_some())
            {
                tracks.push("systemAudio".into());
            }
        }
        let audio_output = Arc::new(cap_editor::AudioOutput::new());
        {
            let mut binding = self.control.playback.lock().unwrap();
            binding.audio_output = Some(audio_output.clone());
            binding.latest = Some(PreparingEditorChanged {
                request_epoch: self.control.request_epoch,
                job_id,
                sequence: 0,
                fps: crate::EDITOR_PREVIEW_FPS,
                progress: PreparingEditorProgress::default(),
                playback: PreparingPlaybackState::default(),
                seed: PreparingEditorSeed {
                    title: input.recording_meta.pretty_name.clone(),
                    tracks,
                },
            });
        }
        self.control.accepts_frames.store(true, Ordering::Release);
        let session = PreparingPlaybackSession::spawn_with_expected_metadata(
            input,
            audio.tracks,
            PreparingPlaybackOptions {
                preview: PreparingPreviewOptions {
                    use_hardware_decoding: !cfg!(target_os = "windows"),
                    frame_format: EditorFrameFormat::Rgba,
                },
                fps: crate::EDITOR_PREVIEW_FPS,
                resolution: crate::default_editor_preview_resolution(),
            },
            audio_output,
            Box::new(move |_, output, _| {
                if control.accepts()
                    && (matches!(frame_observer.latest(), PreparingStudioState::Available(_))
                        || control.finalization.allows_preparing_continuation())
                    && let Some(frame) = crate::editor_window::frame_for_websocket(output)
                {
                    #[cfg(debug_assertions)]
                    crate::stop_editor_benchmark::capture_ws_frame(
                        crate::stop_editor_benchmark::CaptureKind::Preparing,
                        &control.path,
                        &frame,
                    );
                    frames.send_replace(Some(Arc::new(frame)));
                }
            }),
            audio.expected_metadata,
        )?;
        self.stop = Some(session.stop_handle());
        let handoff = session.handoff_handle();
        {
            let mut binding = self.control.playback.lock().unwrap();
            binding.controller = Some(session.controller());
            binding.handoff = Some(handoff.clone());
        }
        let mut updates = session.updates();
        self.control
            .publish_snapshot(&updates.borrow_and_update().clone());
        let mut health = tokio::time::interval(Duration::from_millis(50));
        let mut observing = true;
        loop {
            tokio::select! {
                biased;
                _ = cancel.changed() => return Ok(()),
                _ = handoff.wait_committed() => return Ok(()),
                state = observer.changed(), if observing => {
                    if !matches!(state, PreparingStudioState::Available(_)) {
                        if !self.control.finalization.allows_preparing_continuation() { return Ok(()); }
                        observing = false;
                    }
                },
                changed = updates.changed() => {
                    if changed.is_err() { return Ok(()); }
                    let snapshot = updates.borrow_and_update().clone();
                    self.control.publish_snapshot(&snapshot);
                    if snapshot.progress.phase != cap_editor::PreparingEditorPhase::Preparing {
                        return Ok(());
                    }
                },
                _ = health.tick() => {
                    if !self.control.is_active() { return Ok(()); }
                    if self.transport.as_ref().is_some_and(OwnedWatchFrameWs::is_finished) {
                        return Ok(());
                    }

                },
            }
        }
    }
}

fn ensure_preparing_stopped_layout(
    timeline: &cap_project::TimelineConfiguration,
    studio: &cap_project::StudioRecordingMeta,
) -> Result<(), String> {
    if timeline.segments.len() != 1 || studio.display_notch().is_some() {
        Err("Tauri preparing requires one screen segment without a recorded notch".into())
    } else {
        Ok(())
    }
}

pub(crate) fn project_from_preparing_presentation(
    presentation: &ProjectConfiguration,
    stopped_timeline: &cap_project::TimelineConfiguration,
) -> ProjectConfiguration {
    let mut project = presentation.clone();
    project.timeline = Some(crate::recording::recording_timeline(
        stopped_timeline.segments.clone(),
        Vec::new(),
    ));
    project
}

fn ensure_preparing_track_presentation<'a>(
    tracks: impl IntoIterator<Item = (Option<&'a cap_project::VideoMeta>, Option<&'a Path>)>,
) -> Result<(), String> {
    if tracks
        .into_iter()
        .any(|(camera, keyboard)| camera.is_some() || keyboard.is_some())
    {
        Err("Camera and keyboard presentation require ordinary editor loading".into())
    } else {
        Ok(())
    }
}

fn ensure_preparing_cursor_presentation(cursor: &CursorEvents) -> Result<(), String> {
    if cursor.clicks.is_empty() {
        Ok(())
    } else {
        Err("Recorded clicks require late ordinary auto-zoom settings".into())
    }
}

fn adapt(
    sources: Arc<PreparingStudioSources>,
    control: &Arc<ConsumerControl>,
    presentation: &ProjectConfiguration,
) -> Result<(PreparingPreviewInput, audio::AudioAdaptation), String> {
    let ended = || "Preparing sources ended".to_string();
    let live = sources.live().ok_or_else(ended)?;
    let recording_meta = live.metadata().ok_or_else(ended)?.clone();
    let studio = recording_meta.studio_meta().ok_or_else(ended)?;

    let timeline = live
        .configuration()
        .ok_or_else(ended)?
        .timeline
        .as_ref()
        .ok_or("Missing stopped timeline")?;
    ensure_preparing_stopped_layout(timeline, studio)?;
    let mut project = project_from_preparing_presentation(presentation, timeline);
    if project.clips.is_empty() {
        project.clips =
            cap_editor::initial_clip_configuration(&recording_meta.project_path, studio);
    }
    let descriptors = live.segments().ok_or_else(ended)?;
    ensure_preparing_track_presentation(descriptors.iter().map(|segment| {
        (
            segment
                .camera()
                .map(cap_recording::recovery::PreparingVideoInput::metadata),
            segment.keyboard_path(),
        )
    }))?;
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
        ensure_preparing_cursor_presentation(&cursor)?;
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
    use crate::FinalizationAccess;

    fn control(
        path: &Path,
        window_id: u32,
        epoch: u32,
    ) -> (crate::FinalizationToken, Arc<ConsumerControl>) {
        let project =
            FinalizationProject::capture(path.to_path_buf(), FinalizationAccess::Write).unwrap();
        let finalizations = FinalizingRecordings::default();
        let token = finalizations.start_finalizing(project).unwrap();
        let window_ids = EditorWindowIds::default();
        window_ids
            .ids
            .lock()
            .unwrap()
            .push((path.to_path_buf(), window_id));
        let control = Arc::new(ConsumerControl {
            window_ids,
            window_id,
            request_epoch: epoch,
            path: path.to_path_buf(),
            finalization: token.preparing(),
            cancelled: watch::channel(false).0,
            accepts_frames: AtomicBool::new(true),
            playback: Mutex::default(),
            publish: None,
        });
        (token, control)
    }

    #[tokio::test]
    async fn abandoned_admission_joins_transport_without_waiting_for_finalization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (token, control) = control(&path, 1, 1);
        let (response, receiver) = oneshot::channel();
        drop(receiver);
        let runner = Runner {
            control: control.clone(),
            previous: Vec::new(),
            response: Some(response),
            transport: None,
            stop: None,
            frames: watch::channel(None).0,
        };
        tokio::time::timeout(Duration::from_secs(2), runner.run())
            .await
            .expect("Abandoned admission waited for recording finalization")
            .unwrap();
        assert!(!control.is_active());
        assert!(control.finalization.is_pending());
        token.finish(Ok(()));
    }

    #[tokio::test]
    async fn loading_barrier_cancels_and_joins_even_when_the_first_waiter_is_dropped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (_token, control) = control(&path, 1, 1);
        let (release, receiver) = oneshot::channel();
        let (completed, mut completion) = watch::channel(false);
        let joined = RetainedJoin::new(tokio::spawn(async move {
            receiver.await.unwrap();
            completed.send_replace(true);
            Ok(())
        }));
        let registry = PreparingConsumers::default();
        registry
            .0
            .lock()
            .unwrap()
            .projects
            .entry(path.clone())
            .or_default()
            .entries
            .push(Entry {
                control: control.clone(),
                joined: joined.clone(),
            });
        let waiter = {
            let registry = registry.clone();
            let path = path.clone();
            tokio::spawn(async move { registry.before_ordinary_loading(&path).await })
        };
        while !*control.cancelled.borrow() {
            tokio::task::yield_now().await;
        }
        assert!(!waiter.is_finished());
        assert!(registry.0.lock().unwrap().projects[&path].ordinary_loading);
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        completion.wait_for(|done| *done).await.unwrap();
        joined.wait().await.unwrap();
        registry.before_ordinary_loading(&path).await.unwrap();
    }

    #[tokio::test]
    async fn replacement_admission_retires_previous_audio_after_join() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (_previous_token, previous) = control(&path, 1, 1);
        let (_next_token, next) = control(&path, 1, 2);
        let output = Arc::new(cap_editor::AudioOutput::new());
        let retained = Arc::downgrade(&output);
        previous.playback.lock().unwrap().audio_output = Some(output);
        let (release, receiver) = oneshot::channel();
        let joined = RetainedJoin::new(tokio::spawn(async move {
            receiver.await.unwrap();
            Ok(())
        }));
        let (response, receiver) = oneshot::channel();
        drop(receiver);
        let runner = Runner {
            control: next,
            previous: vec![(joined, previous)],
            response: Some(response),
            transport: None,
            stop: None,
            frames: watch::channel(None).0,
        };
        let task = tokio::spawn(runner.run());
        tokio::task::yield_now().await;
        assert!(retained.upgrade().is_some());
        assert!(!task.is_finished());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(retained.upgrade().is_none());
    }

    #[tokio::test]
    async fn failed_cleanup_remains_a_barrier_on_reopen_and_retry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (_token, control) = control(&path, 1, 1);
        let joined = RetainedJoin::new(tokio::spawn(async {
            panic!("injected owned cleanup failure");
        }));
        let registry = PreparingConsumers::default();
        registry
            .0
            .lock()
            .unwrap()
            .projects
            .entry(path.clone())
            .or_default()
            .entries
            .push(Entry { control, joined });
        let first = registry.before_ordinary_loading(&path).await.unwrap_err();
        let next = registry.before_ordinary_loading(&path).await.unwrap_err();
        assert_eq!(first, next);
        assert_eq!(registry.0.lock().unwrap().projects[&path].entries.len(), 1);
    }

    #[tokio::test]
    async fn closed_window_retires_audio_only_after_owned_cleanup_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (_token, control) = control(&path, 3, 1);
        let output = Arc::new(cap_editor::AudioOutput::new());
        let retained = Arc::downgrade(&output);
        control.playback.lock().unwrap().audio_output = Some(output);
        let (release, receiver) = oneshot::channel();
        let joined = RetainedJoin::new(tokio::spawn(async move {
            receiver.await.unwrap();
            Ok(())
        }));
        let registry = PreparingConsumers::default();
        registry
            .0
            .lock()
            .unwrap()
            .projects
            .entry(path.clone())
            .or_default()
            .entries
            .push(Entry {
                control: control.clone(),
                joined,
            });
        registry.cancel_window(3, None);
        tokio::task::yield_now().await;
        assert!(retained.upgrade().is_some());
        assert!(!control.is_active());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if registry.0.lock().unwrap().projects[&path]
                    .entries
                    .is_empty()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(retained.upgrade().is_none());
    }

    #[tokio::test]
    async fn old_frontend_stop_does_not_cancel_a_new_window_request() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (_token, control) = control(&path, 8, 2);
        let registry = PreparingConsumers::default();
        let joined = RetainedJoin::new(tokio::spawn(async { Ok(()) }));
        registry
            .0
            .lock()
            .unwrap()
            .projects
            .entry(path)
            .or_default()
            .entries
            .push(Entry {
                control: control.clone(),
                joined,
            });
        registry.cancel_window(8, Some(1));
        registry.cancel_window(7, None);
        assert!(control.accepts());
        registry.cancel_window(8, Some(2));
        assert!(!control.accepts());
    }

    #[test]
    fn native_registration_and_finalization_both_guard_frame_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        let (token, control) = control(&path, 1, 1);
        assert!(control.accepts());
        control.window_ids.ids.lock().unwrap().clear();
        assert!(!control.accepts());
        control.window_ids.ids.lock().unwrap().push((path, 2));
        assert!(!control.accepts());
        token.finish(Ok(()));
        assert!(!control.is_active());
    }

    #[test]
    fn cancelled_cursor_parse_terminates_without_retrying_interrupted_reads() {
        let mut reader = CheckedCursorReader {
            reader: std::io::Cursor::new([1, 2]),
            is_live: || false,
            remaining: 2,
        };
        let error = reader.read(&mut [0; 1]).unwrap_err();
        assert_ne!(error.kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(reader.reader.position(), 0);
    }
}

#[cfg(test)]
mod presentation_guard_tests {
    use super::*;

    fn camera() -> cap_project::VideoMeta {
        serde_json::from_value(serde_json::json!({
            "path": "camera", "fps": 24, "start_time": 0.125
        }))
        .unwrap()
    }

    #[test]
    fn screen_only_descriptors_pass_but_any_recorded_camera_is_declined() {
        let camera = camera();
        ensure_preparing_track_presentation([(None, None)]).unwrap();
        for tracks in [
            vec![(Some(&camera), None)],
            vec![(None, None), (Some(&camera), None)],
        ] {
            assert_eq!(
                ensure_preparing_track_presentation(tracks).unwrap_err(),
                "Camera and keyboard presentation require ordinary editor loading"
            );
        }
    }

    #[test]
    fn keyboard_sidecars_decline_even_without_a_camera_or_visible_overlay() {
        for path in [Path::new("keyboard.json"), Path::new("keyboard.msgpack")] {
            assert_eq!(
                ensure_preparing_track_presentation([(None, Some(path))]).unwrap_err(),
                "Camera and keyboard presentation require ordinary editor loading"
            );
        }
    }

    #[test]
    fn click_up_and_click_down_both_decline_but_pointer_movement_alone_passes() {
        let mut cursor = CursorEvents::default();
        cursor.moves.push(cap_project::CursorMoveEvent {
            active_modifiers: Vec::new(),
            cursor_id: "arrow".into(),
            time_ms: 0.0,
            x: 0.2,
            y: 0.8,
        });
        ensure_preparing_cursor_presentation(&cursor).unwrap();
        for down in [false, true] {
            cursor.clicks = vec![cap_project::CursorClickEvent {
                active_modifiers: Vec::new(),
                cursor_num: 0,
                cursor_id: "arrow".into(),
                time_ms: 0.0,
                down,
            }];
            assert_eq!(
                ensure_preparing_cursor_presentation(&cursor).unwrap_err(),
                "Recorded clicks require late ordinary auto-zoom settings"
            );
        }
    }
    #[test]
    fn stopped_layout_rejects_multiple_or_missing_segments_and_recorded_notches() {
        let segment = cap_project::TimelineSegment {
            recording_clip: 0,
            start: 0.0,
            end: 6.0,
            timescale: 1.0,
            name: None,
            speed_audio_mode: None,
        };
        for notch in [
            None,
            Some(cap_project::DisplayNotch {
                x: 0.4,
                width: 0.2,
                height: 0.03,
            }),
        ] {
            let metadata: cap_project::RecordingMeta = serde_json::from_value(serde_json::json!({
                "pretty_name": "Tauri presentation metadata", "sharing": null,
                "segments": [{"display": {"path": "display", "fps": 30, "start_time": 0.0}, "display_notch": notch}]
            })).unwrap();
            for count in [0, 1, 2] {
                let timeline =
                    crate::recording::recording_timeline(vec![segment.clone(); count], Vec::new());
                let result =
                    ensure_preparing_stopped_layout(&timeline, metadata.studio_meta().unwrap());
                assert_eq!(result.is_ok(), count == 1 && notch.is_none());
                if let Err(error) = result {
                    assert_eq!(
                        error,
                        "Tauri preparing requires one screen segment without a recorded notch"
                    );
                }
            }
        }
    }
}
