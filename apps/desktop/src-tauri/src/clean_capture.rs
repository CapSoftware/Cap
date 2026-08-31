use std::{path::PathBuf, sync::Mutex, time::Duration};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_specta::Event;
use tokio::sync::Notify;

use crate::{CurrentRecordingChanged, windows::CapWindowId};

pub const STOP_SHORTCUT: &str = "Ctrl+Shift+F9";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    AwaitingShortcut,
    Starting,
    Recording,
    Pausing,
    Paused,
    Resuming,
    ResumeFailed,
    Restarting,
    Stopping,
    Restoring,
}

impl Phase {
    fn can_stop(self) -> bool {
        matches!(
            self,
            Self::Recording | Self::Paused | Self::Resuming | Self::ResumeFailed
        )
    }
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub generation: u32,
    pub phase: Option<Phase>,
    pub mode: Option<cap_recording::RecordingMode>,
    pub shortcut: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct SavedWindow {
    label: String,
    native_id: u64,
    visible: bool,
}

impl SavedWindow {
    fn visibility_for(&self, native_id: u64) -> Option<bool> {
        (self.native_id == native_id).then_some(self.visible)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopRoute {
    #[cfg(any(target_os = "linux", test))]
    Tray,
    #[cfg(any(target_os = "linux", test))]
    Portal,
}

struct Lease {
    mode: cap_recording::RecordingMode,
    generation: u32,
    phase: Phase,
    pressed: bool,
    stop_requested: bool,
    registered_shortcut: bool,
    wayland: bool,
    stop_route: Option<StopRoute>,
    stop_description: Option<String>,
    stop_error: Option<String>,
    lost_stop_routes: [bool; 2],
    recording_dir: Option<PathBuf>,
    windows: Vec<SavedWindow>,
}

impl StopRoute {
    fn index(self) -> usize {
        match self {
            #[cfg(any(target_os = "linux", test))]
            Self::Tray => 0,
            #[cfg(any(target_os = "linux", test))]
            Self::Portal => 1,
        }
    }
}

impl Lease {
    fn accept_stop_input(&mut self, route: Option<(u32, StopRoute)>, pressed: bool) -> bool {
        match route {
            Some((generation, route))
                if self.wayland
                    && self.generation == generation
                    && !self.lost_stop_routes[route.index()] =>
            {
                if self.phase == Phase::AwaitingShortcut {
                    if pressed {
                        self.stop_route = Some(route);
                    } else if self.stop_route != Some(route) {
                        return false;
                    }
                }
                true
            }
            None if !self.wayland => true,
            _ => false,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    fn lose_stop_route(&mut self, route: StopRoute) -> bool {
        self.lost_stop_routes[route.index()] = true;
        let lost = self.stop_route == Some(route) || self.lost_stop_routes.iter().all(|lost| *lost);
        if lost {
            self.stop_requested = true;
        }
        lost && self.phase.can_stop()
    }
}

struct ControlError {
    generation: u32,
    dir: PathBuf,
    message: String,
}

struct RestorationReceipt {
    generation: u32,
    result: Result<(), String>,
    #[cfg(target_os = "linux")]
    stop_requested: bool,
}

impl RestorationReceipt {
    #[cfg(target_os = "linux")]
    fn restart_result(&self) -> Result<(), String> {
        self.result.clone()?;
        if self.stop_requested {
            Err("Recording restart was cancelled by Stop".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct Inner {
    generation: u32,
    lease: Option<Lease>,
    control_error: Option<ControlError>,
    restored: Option<RestorationReceipt>,
    #[cfg(target_os = "linux")]
    x11_cleanup_sequence: u64,
    #[cfg(target_os = "linux")]
    x11_cleanup: Option<X11StudioCleanup>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct X11StudioCleanup {
    generation: u32,
    sequence: u64,
    registered_shortcut: bool,
}

#[derive(Default)]
pub struct State {
    #[cfg(target_os = "linux")]
    pub(crate) instant: Mutex<Option<crate::recording::linux_instant::Attempt>>,
    #[cfg(target_os = "linux")]
    pub(crate) portal_stop: tokio::sync::Mutex<Option<crate::hotkeys::WaylandStop>>,
    inner: Mutex<Inner>,
    changed: Notify,
}

impl Inner {
    #[cfg(target_os = "linux")]
    fn reserve_x11_studio_cleanup(
        &mut self,
        generation: u32,
        windows: Result<(), String>,
    ) -> Option<X11StudioCleanup> {
        if self.x11_cleanup.is_some()
            || self
                .restored
                .as_ref()
                .is_some_and(|receipt| receipt.generation == generation)
        {
            return None;
        }
        let lease = self.lease.as_ref().filter(|lease| {
            self.generation == generation
                && lease.generation == generation
                && lease.phase == Phase::Restoring
                && lease.mode == cap_recording::RecordingMode::Studio
                && !lease.wayland
        })?;
        let registered_shortcut = lease.registered_shortcut;
        if let Err(error) = windows {
            let _ = self.complete_instant_restoration(generation, Err(error));
            return None;
        }
        self.x11_cleanup_sequence = self.x11_cleanup_sequence.wrapping_add(1);
        let cleanup = X11StudioCleanup {
            generation,
            sequence: self.x11_cleanup_sequence,
            registered_shortcut,
        };
        self.x11_cleanup = Some(cleanup);
        Some(cleanup)
    }

    #[cfg(target_os = "linux")]
    fn complete_x11_studio_restoration(
        &mut self,
        cleanup: X11StudioCleanup,
        result: Result<(), String>,
    ) -> bool {
        if self.x11_cleanup != Some(cleanup)
            || self.generation != cleanup.generation
            || self.lease.as_ref().is_none_or(|lease| {
                lease.generation != cleanup.generation
                    || lease.phase != Phase::Restoring
                    || lease.mode != cap_recording::RecordingMode::Studio
                    || lease.wayland
                    || lease.registered_shortcut != cleanup.registered_shortcut
            })
        {
            return false;
        }
        self.x11_cleanup = None;
        self.complete_instant_restoration(cleanup.generation, result)
            .is_some()
    }

    #[cfg(target_os = "linux")]
    fn begin_x11_studio_restore_retry(&mut self, pressed: bool) -> Option<u32> {
        if !pressed || self.x11_cleanup.is_some() {
            return None;
        }
        let generation = self.generation;
        let lease = self.lease.as_mut().filter(|lease| {
            lease.generation == generation
                && lease.phase == Phase::Restoring
                && lease.mode == cap_recording::RecordingMode::Studio
                && !lease.wayland
        })?;
        if !self.restored.as_ref().is_some_and(|receipt| {
            receipt.generation == lease.generation && receipt.result.is_err()
        }) {
            return None;
        }
        lease.stop_requested = true;
        self.restored = None;
        Some(lease.generation)
    }

    #[cfg(target_os = "linux")]
    fn complete_instant_restoration(
        &mut self,
        generation: u32,
        result: Result<(), String>,
    ) -> Option<bool> {
        if self
            .lease
            .as_ref()
            .is_none_or(|lease| lease.generation != generation || lease.phase != Phase::Restoring)
        {
            return None;
        }
        let succeeded = result.is_ok();
        self.restored = Some(RestorationReceipt {
            generation,
            result,
            stop_requested: self.lease.as_ref().unwrap().stop_requested,
        });
        if succeeded {
            let owned = self.lease.take().unwrap().registered_shortcut;
            self.generation = self.generation.wrapping_add(1);
            Some(owned)
        } else {
            None
        }
    }

    fn owner(&self, dir: &std::path::Path) -> Option<u32> {
        self.lease.as_ref().and_then(|lease| {
            (lease.recording_dir.as_deref() == Some(dir)).then_some(lease.generation)
        })
    }
    fn queue_stop(&mut self) -> bool {
        let Some(lease) = self.lease.as_mut() else {
            return false;
        };
        lease.stop_requested = true;
        let deferred = !lease.phase.can_stop();
        if !deferred {
            lease.phase = Phase::Stopping;
        }
        deferred
    }

    fn control_current(&self, generation: u32, dir: &std::path::Path, resume: bool) -> bool {
        let transition = if resume {
            Phase::Resuming
        } else {
            Phase::Pausing
        };
        self.generation == generation
            && self.lease.as_ref().is_some_and(|lease| {
                lease.generation == generation
                    && lease.phase == transition
                    && lease.recording_dir.as_deref() == Some(dir)
            })
    }

    fn complete_control(
        &mut self,
        generation: u32,
        dir: &std::path::Path,
        resume: bool,
        outcome: &ControlOutcome,
    ) -> bool {
        if !self.control_current(generation, dir, resume) {
            return false;
        }
        self.control_error = match outcome {
            ControlOutcome::Succeeded | ControlOutcome::StoppedBeforeResume => None,
            ControlOutcome::HideFailed(message)
            | ControlOutcome::ActorFailed { error: message, .. } => Some(ControlError {
                generation,
                dir: dir.to_path_buf(),
                message: message.clone(),
            }),
        };
        self.lease.as_mut().unwrap().phase = match (resume, outcome) {
            (true, ControlOutcome::Succeeded) | (false, ControlOutcome::ActorFailed { .. }) => {
                Phase::Recording
            }
            (true, ControlOutcome::ActorFailed { paused: false, .. }) => Phase::ResumeFailed,
            _ => Phase::Paused,
        };
        true
    }

    fn may_restore_paused_main(&self, generation: u32, dir: &std::path::Path) -> bool {
        self.owner(dir) == Some(generation)
            && self
                .lease
                .as_ref()
                .is_some_and(|lease| lease.phase == Phase::Paused && !lease.stop_requested)
            && self.may_reveal(generation, "main")
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            generation: self.generation,
            phase: self.lease.as_ref().map(|lease| lease.phase),
            mode: self.lease.as_ref().map(|lease| lease.mode),
            shortcut: self.lease.as_ref().map(|lease| {
                lease.stop_description.clone().unwrap_or_else(|| {
                    if lease.wayland {
                        "the Cap Stop tray icon".to_string()
                    } else {
                        STOP_SHORTCUT.to_string()
                    }
                })
            }),
            error: self
                .control_error
                .as_ref()
                .filter(|error| {
                    error.generation == self.generation
                        && self
                            .lease
                            .as_ref()
                            .is_none_or(|lease| lease.recording_dir.as_ref() == Some(&error.dir))
                })
                .map(|error| error.message.clone())
                .or_else(|| {
                    self.lease
                        .as_ref()
                        .and_then(|lease| lease.stop_error.clone())
                })
                .or_else(|| {
                    self.restored.as_ref().and_then(|receipt| {
                        self.lease
                            .as_ref()
                            .filter(|lease| lease.generation == receipt.generation)
                            .and_then(|_| receipt.result.as_ref().err().cloned())
                    })
                }),
        }
    }

    fn may_reveal(&self, generation: u32, label: &str) -> bool {
        if generation != self.generation {
            return false;
        }
        let Some(lease) = &self.lease else {
            return true;
        };
        if lease.wayland && wayland_blocks_mapping(lease.phase) {
            return false;
        }
        match label.parse::<CapWindowId>() {
            Ok(CapWindowId::Main) => {
                matches!(
                    lease.phase,
                    Phase::AwaitingShortcut | Phase::Paused | Phase::Restoring
                ) && (!lease.stop_requested || lease.phase == Phase::Restoring)
            }
            Ok(
                CapWindowId::Camera
                | CapWindowId::RecordingControls
                | CapWindowId::TargetSelectOverlay { .. },
            ) => false,
            _ => true,
        }
    }

    fn shortcut(&mut self, pressed: bool) -> bool {
        let Some(lease) = self.lease.as_mut() else {
            return false;
        };
        if lease.phase == Phase::AwaitingShortcut {
            if pressed {
                lease.pressed = true;
            } else if lease.pressed {
                lease.phase = Phase::Starting;
                lease.pressed = false;
            }
        } else if pressed {
            lease.stop_requested = true;
        }
        true
    }
}

pub fn generation(app: &AppHandle) -> u32 {
    app.try_state::<State>()
        .map(|state| state.inner.lock().unwrap().generation)
        .unwrap_or(0)
}

pub fn phase(app: &AppHandle) -> Option<Phase> {
    app.try_state::<State>()
        .and_then(|state| state.inner.lock().unwrap().lease.as_ref().map(|l| l.phase))
}

pub fn blocks_idle_cleanup(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    if crate::recording::linux_instant::current(app).is_some() {
        return true;
    }
    phase(app).is_some_and(|phase| phase != Phase::Restoring)
}

pub fn cancel_closed_preflight(app: &AppHandle) {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let Some(lease) = inner
        .lease
        .as_mut()
        .filter(|lease| lease.phase == Phase::AwaitingShortcut)
    else {
        return;
    };
    lease.stop_requested = true;
    for saved in &mut lease.windows {
        if saved.label == CapWindowId::Main.label() {
            saved.visible = false;
        }
    }
    drop(inner);
    notify(app);
}

pub fn is_current(app: &AppHandle, generation: u32) -> bool {
    app.state::<State>()
        .inner
        .lock()
        .unwrap()
        .lease
        .as_ref()
        .is_some_and(|lease| lease.generation == generation)
}

pub fn stop_requested(app: &AppHandle, generation: u32) -> bool {
    app.state::<State>()
        .inner
        .lock()
        .unwrap()
        .lease
        .as_ref()
        .filter(|lease| lease.generation == generation)
        .is_none_or(|lease| lease.stop_requested)
}

fn notify(app: &AppHandle) {
    app.state::<State>().changed.notify_waiters();
    let _ = CurrentRecordingChanged.emit(app);
}

pub fn set_phase(app: &AppHandle, generation: u32, phase: Phase) -> bool {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let Some(lease) = inner.lease.as_mut().filter(|l| l.generation == generation) else {
        return false;
    };
    lease.phase = phase;
    drop(inner);
    notify(app);
    true
}

pub fn publish(app: &AppHandle, generation: u32, dir: PathBuf) -> bool {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let Some(lease) = inner.lease.as_mut().filter(|l| l.generation == generation) else {
        return false;
    };
    if lease.phase != Phase::Starting {
        return false;
    }
    lease.recording_dir = Some(dir);
    lease.phase = Phase::Recording;
    true
}

pub fn set_start_directory(app: &AppHandle, generation: u32, dir: PathBuf) -> Result<(), String> {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let lease = inner
        .lease
        .as_mut()
        .filter(|lease| lease.generation == generation && lease.phase == Phase::Starting)
        .ok_or("Recording startup was superseded")?;
    lease.recording_dir = Some(dir);
    Ok(())
}

pub fn owner(app: &AppHandle, dir: &std::path::Path) -> Option<u32> {
    let state = app.state::<State>();
    let inner = state.inner.lock().unwrap();
    inner.owner(dir)
}

pub fn queue_stop(app: &AppHandle) -> bool {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    if inner.lease.is_none() {
        return false;
    }
    let deferred = inner.queue_stop();
    drop(inner);
    notify(app);
    deferred
}

pub fn handle_shortcut(app: &AppHandle, pressed: bool) -> bool {
    handle_stop_input(app, pressed, None)
}

#[cfg(target_os = "linux")]
pub(crate) fn handle_wayland_stop(
    app: &AppHandle,
    generation: u32,
    route: StopRoute,
    pressed: bool,
) -> bool {
    handle_stop_input(app, pressed, Some((generation, route)))
}

fn handle_stop_input(app: &AppHandle, pressed: bool, route: Option<(u32, StopRoute)>) -> bool {
    let Some(state) = app.try_state::<State>() else {
        return false;
    };
    let mut inner = state.inner.lock().unwrap();
    if !inner
        .lease
        .as_mut()
        .is_some_and(|lease| lease.accept_stop_input(route, pressed))
    {
        return false;
    }
    #[cfg(target_os = "linux")]
    if let Some(generation) = inner.begin_x11_studio_restore_retry(pressed) {
        drop(inner);
        spawn_x11_studio_restore(app.clone(), generation, true);
        return true;
    }
    #[cfg(target_os = "linux")]
    if pressed
        && inner.lease.as_ref().is_some_and(|lease| {
            (lease.mode == cap_recording::RecordingMode::Instant || lease.wayland)
                && lease.phase == Phase::Restoring
        })
        && inner
            .restored
            .as_ref()
            .is_some_and(|receipt| receipt.result.is_err())
    {
        let generation = inner.lease.as_ref().unwrap().generation;
        inner.restored = None;
        drop(inner);
        spawn_instant_restore(app.clone(), generation, true);
        return true;
    }
    #[cfg(target_os = "linux")]
    let instant_stop = pressed
        && crate::recording::linux_instant::current(app).is_some()
        && inner
            .lease
            .as_ref()
            .is_some_and(|lease| lease.phase != Phase::AwaitingShortcut);
    let handled = inner.shortcut(pressed);
    let stop = handled
        && pressed
        && inner
            .lease
            .as_ref()
            .is_some_and(|lease| lease.phase.can_stop());
    #[cfg(target_os = "linux")]
    let stop = stop || (handled && instant_stop);
    drop(inner);
    if handled {
        notify(app);
    }
    if stop {
        let app = app.clone();
        drop(tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::recording::stop_recording(app.clone(), app.state()).await {
                tracing::error!(%error, "Clean capture shortcut could not stop recording");
            }
        }));
    }
    handled
}

pub fn reveal_now(window: &WebviewWindow, expected_generation: u32) -> tauri::Result<bool> {
    reveal_now_with_options(window, expected_generation, false, false)
}

pub fn schedule_overlay_reveal(window: &WebviewWindow, generation: u32, focus: bool) {
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let result = reveal_now_with_options(&handle, generation, focus, false);
        if matches!(result, Ok(true)) {
            let _ = handle.set_ignore_cursor_events(false);
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn schedule_overlay_focus(window: &WebviewWindow, generation: u32) {
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let allowed = handle
            .app_handle()
            .state::<State>()
            .inner
            .lock()
            .unwrap()
            .may_reveal(generation, handle.label());
        if allowed {
            let _ = handle.set_focus();
        }
    });
}

fn reveal_now_with_options(
    window: &WebviewWindow,
    expected_generation: u32,
    focus: bool,
    unminimize: bool,
) -> tauri::Result<bool> {
    let app = window.app_handle();
    #[cfg(target_os = "linux")]
    if crate::recording::linux_instant::current(app)
        .is_some_and(|attempt| attempt.has_capture() && !attempt.ui_ready())
    {
        return Ok(false);
    }
    let Some(state) = app.try_state::<State>() else {
        window.show()?;
        return Ok(true);
    };
    let inner = state.inner.lock().unwrap();
    if !inner.may_reveal(expected_generation, window.label()) {
        #[cfg(target_os = "linux")]
        let deferred_editor = inner.lease.as_ref().is_some_and(|lease| {
            lease.wayland
                && lease.generation == expected_generation
                && lease.phase == Phase::Stopping
                && matches!(window.label().parse(), Ok(CapWindowId::Editor { .. }))
        });
        drop(inner);
        #[cfg(target_os = "linux")]
        if deferred_editor {
            use gtk::prelude::*;
            let native = window.gtk_window()?;
            remember_wayland_window(app, expected_generation, native.upcast_ref(), true);
        }
        return Ok(false);
    }
    // Mapping runs on the UI thread; a new capture must acknowledge its queued hide
    // before starting. Do not retain this mutex across synchronous GTK callbacks.
    drop(inner);
    set_native_visibility(window, true)
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    if unminimize {
        window.unminimize()?;
    }
    if focus {
        window.set_focus()?;
    }
    Ok(true)
}

pub async fn reveal(window: WebviewWindow, expected_generation: u32) -> Result<bool, String> {
    reveal_with_options(window, expected_generation, false, false).await
}

async fn reveal_with_options(
    window: WebviewWindow,
    expected_generation: u32,
    focus: bool,
    unminimize: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    if window.label() == CapWindowId::Main.label()
        && let Some(attempt) = crate::recording::linux_instant::current(window.app_handle())
        && attempt.has_capture()
        && !attempt.ui_ready()
    {
        crate::recording::linux_instant::control(window.app_handle().clone(), attempt, false)
            .await?;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(
                reveal_now_with_options(&handle, expected_generation, focus, unminimize)
                    .map_err(|e| e.to_string()),
            );
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Timed out revealing recording window".to_string())?
        .map_err(|_| "Recording window closed before it could be shown".to_string())?
}

pub async fn guarded_show(
    window: WebviewWindow,
    generation: u32,
    focus: bool,
    unminimize: bool,
) -> tauri::Result<()> {
    reveal_with_options(window, generation, focus, unminimize)
        .await
        .map(|_| ())
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))
}

async fn finish_main_controls<I, S>(
    phase: Option<Phase>,
    instant_stop: Option<I>,
    studio_pause: S,
) -> Result<(), String>
where
    I: std::future::Future<Output = Result<(), String>>,
    S: std::future::Future<Output = Result<(), String>>,
{
    if phase != Some(Phase::AwaitingShortcut)
        && let Some(stop) = instant_stop
    {
        return stop.await;
    }
    match phase {
        Some(Phase::Recording) => studio_pause.await,
        None | Some(Phase::AwaitingShortcut | Phase::Paused | Phase::Restoring) => Ok(()),
        _ => Err("Recording is changing state. Use Ctrl+Shift+F9 to stop.".into()),
    }
}

pub async fn show_main_controls(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let instant_stop = crate::recording::linux_instant::current(app)
        .filter(|attempt| !attempt.ui_ready())
        .map(|attempt| crate::recording::linux_instant::control(app.clone(), attempt, false));
    #[cfg(not(target_os = "linux"))]
    let instant_stop = None::<std::future::Ready<Result<(), String>>>;
    finish_main_controls(phase(app), instant_stop, control(app, false)).await
}

pub fn control(
    app: &AppHandle,
    resume: bool,
) -> futures::future::BoxFuture<'_, Result<(), String>> {
    Box::pin(async move {
        let app_state = app.state::<crate::ArcLock<crate::App>>();
        let (handle, dir, generation) = {
            let app_state = app_state.read().await;
            let Some(crate::recording::InProgressRecording::Studio { handle, common, .. }) =
                app_state.current_recording()
            else {
                return Err("No Studio recording is available".into());
            };
            let generation = owner(app, &common.recording_dir).ok_or("Recording was superseded")?;
            (handle.clone(), common.recording_dir.clone(), generation)
        };
        let expected = if resume {
            Phase::Paused
        } else {
            Phase::Recording
        };
        let transition = if resume {
            Phase::Resuming
        } else {
            Phase::Pausing
        };
        {
            let state = app.state::<State>();
            let mut inner = state.inner.lock().unwrap();
            let lease = inner
                .lease
                .as_mut()
                .filter(|lease| {
                    lease.generation == generation
                        && lease.phase == expected
                        && lease.recording_dir.as_deref() == Some(dir.as_path())
                })
                .ok_or("Recording is already changing state. Use Ctrl+Shift+F9 to stop.")?;
            lease.phase = transition;
            inner.control_error = None;
        }
        notify(app);
        let state = app.state::<State>();
        ControlOperation {
            resume,
            generation,
            dir: &dir,
            hide: hide(app, generation),
            change: async {
                if resume {
                    handle.resume().await.map_err(|error| error.to_string())
                } else {
                    handle.pause().await.map_err(|error| error.to_string())
                }
            },
            paused: async {
                matches!(
                    tokio::time::timeout(Duration::from_secs(2), handle.is_paused()).await,
                    Ok(Ok(true))
                )
            },
            restore: restore_paused_main(app, generation, dir.clone()),
            stop: async {
                Box::pin(crate::recording::stop_recording(app.clone(), app.state())).await
            },
            notify: || notify(app),
        }
        .run(&state.inner)
        .await?;
        let event = if resume {
            crate::recording::RecordingEvent::Resumed
        } else {
            crate::recording::RecordingEvent::Paused
        };
        let _ = event.emit(app);
        Ok(())
    })
}

#[derive(Debug)]
enum ControlOutcome {
    Succeeded,
    StoppedBeforeResume,
    HideFailed(String),
    ActorFailed { error: String, paused: bool },
}

struct ControlOperation<'a, H, C, P, R, S, N> {
    resume: bool,
    generation: u32,
    dir: &'a std::path::Path,
    hide: H,
    change: C,
    paused: P,
    restore: R,
    stop: S,
    notify: N,
}

impl<H, C, P, R, S, N> ControlOperation<'_, H, C, P, R, S, N>
where
    H: std::future::Future<Output = Result<(), String>>,
    C: std::future::Future<Output = Result<(), String>>,
    P: std::future::Future<Output = bool>,
    R: std::future::Future<Output = Result<(), String>>,
    S: std::future::Future<Output = Result<(), String>>,
    N: Fn(),
{
    async fn run(self, state: &Mutex<Inner>) -> Result<(), String> {
        let hide_result = if self.resume { self.hide.await } else { Ok(()) };
        let outcome = match hide_result {
            Err(error) => ControlOutcome::HideFailed(error),
            Ok(()) => {
                let stop_requested = {
                    let inner = state.lock().unwrap();
                    if !inner.control_current(self.generation, self.dir, self.resume) {
                        return Err("Recording stopped or changed during the operation".into());
                    }
                    inner.lease.as_ref().unwrap().stop_requested
                };
                if self.resume && stop_requested {
                    ControlOutcome::StoppedBeforeResume
                } else {
                    match self.change.await {
                        Ok(()) => ControlOutcome::Succeeded,
                        Err(error) => ControlOutcome::ActorFailed {
                            error,
                            // This acknowledgement relies on Studio's transactional Resume teardown.
                            paused: self.resume && self.paused.await,
                        },
                    }
                }
            }
        };
        let stop_requested = {
            let mut inner = state.lock().unwrap();
            if !inner.complete_control(self.generation, self.dir, self.resume, &outcome) {
                return Err("Recording stopped or changed during the operation".into());
            }
            inner.lease.as_ref().unwrap().stop_requested
        };
        (self.notify)();
        if stop_requested {
            self.stop.await?;
            return Err("Recording stopped".into());
        }
        match outcome {
            ControlOutcome::Succeeded => Ok(()),
            ControlOutcome::StoppedBeforeResume => Err("Recording stopped".into()),
            ControlOutcome::HideFailed(error)
            | ControlOutcome::ActorFailed {
                error,
                paused: true,
            } => {
                if let Err(reveal_error) = self.restore.await {
                    return Err(format!(
                        "{error}. Could not restore controls: {reveal_error}. Use {STOP_SHORTCUT} to stop."
                    ));
                }
                Err(error)
            }
            ControlOutcome::ActorFailed {
                error,
                paused: false,
            } if self.resume => Err(format!(
                "{error}. Recording pause could not be confirmed. Controls remain hidden; use {STOP_SHORTCUT} to stop."
            )),
            ControlOutcome::ActorFailed { error, .. } => Err(error),
        }
    }
}

async fn restore_paused_main(app: &AppHandle, generation: u32, dir: PathBuf) -> Result<(), String> {
    let main = CapWindowId::Main
        .get(app)
        .ok_or("Recording controls window is unavailable")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let window = main.clone();
    main.run_on_main_thread(move || {
        let allowed = window
            .app_handle()
            .state::<State>()
            .inner
            .lock()
            .unwrap()
            .may_restore_paused_main(generation, &dir);
        let result = if allowed {
            reveal_now_with_options(&window, generation, true, true)
                .map_err(|error| error.to_string())
        } else {
            Ok(false)
        };
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    let revealed = tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Timed out restoring paused controls".to_string())?
        .map_err(|_| "Paused controls restore was cancelled".to_string())??;
    if !revealed {
        return Err("Recording stopped or changed before controls could be restored".into());
    }
    Ok(())
}

pub async fn is_paused(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::ArcLock<crate::App>>();
    let handle = {
        let state = state.read().await;
        match state.current_recording() {
            Some(crate::recording::InProgressRecording::Studio { handle, .. }) => handle.clone(),
            _ => return Err("No Studio recording is available".into()),
        }
    };
    handle.is_paused().await.map_err(|error| error.to_string())
}

pub fn begin_restart(app: &AppHandle, dir: &std::path::Path) -> Result<Option<u32>, String> {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let Some(lease) = inner.lease.as_mut() else {
        return Ok(None);
    };
    if lease.recording_dir.as_deref() != Some(dir)
        || !matches!(lease.phase, Phase::Recording | Phase::Paused)
        || lease.stop_requested
    {
        return Err("Recording is changing state. Use Ctrl+Shift+F9 to stop.".into());
    }
    lease.phase = Phase::Restarting;
    lease.recording_dir = None;
    Ok(Some(lease.generation))
}

#[cfg(target_os = "linux")]
fn native_id(window: &WebviewWindow) -> Result<u64, String> {
    use wgpu::rwh::{HasWindowHandle, RawWindowHandle};
    if cap_recording::screenshot::uses_wayland_portal() {
        use gtk::prelude::*;
        return window
            .gtk_window()
            .map(|window| window.as_ptr() as u64)
            .map_err(|error| error.to_string());
    }
    match window.window_handle().map_err(|e| e.to_string())?.as_raw() {
        RawWindowHandle::Xlib(handle) => Ok(handle.window),
        RawWindowHandle::Xcb(handle) => Ok(u64::from(handle.window.get())),
        RawWindowHandle::Wayland(_) => {
            use gtk::prelude::*;
            let gtk = window.gtk_window().map_err(|error| error.to_string())?;
            Ok(gtk.as_ptr() as u64)
        }
        _ => Err("Clean capture requires an X11 or Wayland window".into()),
    }
}

#[cfg(not(target_os = "linux"))]
fn native_id(_window: &WebviewWindow) -> Result<u64, String> {
    Err("Clean Studio capture is only available on X11".into())
}

fn x11_environment(display: bool, wayland: bool, session: Option<&str>) -> bool {
    display && !wayland && session.is_some_and(|session| session.eq_ignore_ascii_case("x11"))
}

pub(crate) async fn wait_for_shortcut(state: &State, generation: u32) -> Result<(), String> {
    loop {
        let notified = state.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let inner = state.inner.lock().unwrap();
            let lease = inner
                .lease
                .as_ref()
                .filter(|lease| lease.generation == generation)
                .ok_or("Recording cancelled")?;
            if lease.stop_requested {
                return Err(
                    if lease.wayland && lease.lost_stop_routes.iter().any(|lost| *lost) {
                        lease.stop_error.clone().unwrap_or_else(|| {
                            "The recording Stop control became unavailable".into()
                        })
                    } else {
                        "Recording cancelled".into()
                    },
                );
            }
            if lease.phase == Phase::Starting {
                return Ok(());
            }
        }
        notified.await;
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn await_instant_shortcut(
    state: &State,
    generation: u32,
    attempt: &crate::recording::linux_instant::Attempt,
) -> Result<(), String> {
    attempt
        .while_active(wait_for_shortcut(state, generation))
        .await
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn instant_preflight_fixture(generation: u32) -> State {
    State {
        instant: Mutex::new(None),
        portal_stop: tokio::sync::Mutex::new(None),
        inner: Mutex::new(Inner {
            generation,
            lease: Some(Lease {
                mode: cap_recording::RecordingMode::Instant,
                generation,
                phase: Phase::AwaitingShortcut,
                pressed: false,
                stop_requested: false,
                registered_shortcut: true,
                wayland: false,
                stop_route: None,
                stop_description: None,
                stop_error: None,
                lost_stop_routes: [false; 2],
                recording_dir: None,
                windows: Vec::new(),
            }),
            ..Inner::default()
        }),
        changed: Notify::new(),
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn deliver_preflight_shortcut(state: &State) {
    let mut inner = state.inner.lock().unwrap();
    assert!(inner.shortcut(true));
    assert!(inner.shortcut(false));
    drop(inner);
    state.changed.notify_waiters();
}

fn capture_environment_is_x11(
    mode: cap_recording::RecordingMode,
    strict_x11: bool,
    uses_wayland_portal: bool,
) -> bool {
    if mode == cap_recording::RecordingMode::Instant {
        !uses_wayland_portal
    } else {
        strict_x11
    }
}

fn validate_capture_visibility(
    mode: cap_recording::RecordingMode,
    target: &cap_recording::screen_capture::ScreenCaptureTarget,
    camera_requested: bool,
    uses_wayland_portal: bool,
    supported: bool,
) -> Result<bool, String> {
    use cap_recording::{RecordingMode, screen_capture::ScreenCaptureTarget};
    let needs_visibility = match target {
        ScreenCaptureTarget::Display { .. } | ScreenCaptureTarget::Area { .. } => {
            matches!(mode, RecordingMode::Studio | RecordingMode::Instant)
        }
        ScreenCaptureTarget::Window { .. } => {
            mode == RecordingMode::Instant && camera_requested && !uses_wayland_portal
        }
        ScreenCaptureTarget::CameraOnly => false,
    };
    if !needs_visibility {
        return Ok(false);
    }
    if !supported {
        return Err("This display backend cannot acknowledge hidden recording windows. Recording has not started and selected inputs are unchanged.".into());
    }
    Ok(true)
}

pub async fn prepare(
    app: &AppHandle,
    inputs: &crate::recording::StartRecordingInputs,
    restart: Option<u32>,
) -> Result<Option<u32>, String> {
    if !cfg!(target_os = "linux") {
        return Ok(None);
    }
    if let Some(generation) = restart {
        if phase(app) != Some(Phase::Restarting) || stop_requested(app, generation) {
            return Err("Recording restart was cancelled".into());
        }
        set_phase(app, generation, Phase::Starting);
        return Ok(Some(generation));
    }
    if phase(app).is_some() {
        return Err("Finish or cancel the current recording before starting another".into());
    }
    #[cfg(target_os = "linux")]
    let uses_wayland_portal = cap_recording::screenshot::uses_wayland_portal();
    #[cfg(not(target_os = "linux"))]
    let uses_wayland_portal = false;
    if !validate_capture_visibility(
        inputs.mode,
        &inputs.capture_target,
        app.state::<crate::RequestedInputsState>()
            .snapshot()
            .camera
            .value
            .is_some(),
        uses_wayland_portal,
        capture_environment_is_x11(
            inputs.mode,
            x11_environment(
                std::env::var_os("DISPLAY").is_some(),
                std::env::var_os("WAYLAND_DISPLAY").is_some(),
                std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            ),
            uses_wayland_portal,
        ) || uses_wayland_portal,
    )? {
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    let instant_attempt = if inputs.mode == cap_recording::RecordingMode::Instant {
        let attempt = crate::recording::linux_instant::current(app)
            .ok_or("Instant preflight owner was lost")?;
        attempt.checked(Ok(()))?;
        Some(attempt)
    } else {
        None
    };
    let main = CapWindowId::Main
        .get(app)
        .ok_or("Open Cap before starting this recording")?;

    let app_state = app.state::<crate::ArcLock<crate::App>>();
    let mut app_state = app_state.write().await;
    if !matches!(app_state.recording_state, crate::RecordingState::None) {
        return Err("Recording already in progress".into());
    }
    let state = app.state::<State>();
    let generation = {
        let mut inner = state.inner.lock().unwrap();
        if inner.lease.is_some() {
            return Err("Recording preflight already in progress".into());
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.control_error = None;
        let generation = inner.generation;
        inner.restored = None;
        inner.lease = Some(Lease {
            mode: inputs.mode,
            generation,
            phase: Phase::AwaitingShortcut,
            pressed: false,
            stop_requested: false,
            registered_shortcut: false,
            wayland: uses_wayland_portal,
            stop_route: None,
            stop_description: None,
            stop_error: None,
            lost_stop_routes: [false; 2],
            recording_dir: None,
            windows: Vec::new(),
        });
        generation
    };
    app_state.set_pending_recording(inputs.mode, inputs.capture_target.clone())?;
    drop(app_state);
    let result = async {
        let saved = save_windows(app, generation).await?;
        state.inner.lock().unwrap().lease.as_mut().unwrap().windows = saved;
        #[cfg(target_os = "linux")]
        if uses_wayland_portal {
            crate::hotkeys::reserve_wayland_stop(app, generation).await?;
        } else {
            let registered = crate::hotkeys::reserve_clean_capture_stop(app)?;
            state
                .inner
                .lock()
                .unwrap()
                .lease
                .as_mut()
                .unwrap()
                .registered_shortcut = registered;
        }
        crate::target_select_overlay::close_target_select_overlay_windows(app);
        if stop_requested(app, generation) {
            return Err("Recording cancelled".into());
        }
        guarded_show(main, generation, true, true)
            .await
            .map_err(|error| error.to_string())?;
        notify(app);
        #[cfg(target_os = "linux")]
        if let Some(attempt) = &instant_attempt {
            await_instant_shortcut(&state, generation, attempt).await?;
        } else {
            wait_for_shortcut(&state, generation).await?;
        }
        #[cfg(not(target_os = "linux"))]
        wait_for_shortcut(&state, generation).await?;
        #[cfg(target_os = "linux")]
        if uses_wayland_portal {
            crate::tray::set_clean_stop_mode(app, generation, true).await?;
        }
        if inputs.mode == cap_recording::RecordingMode::Studio {
            hide(app, generation).await?;
        }
        Ok(Some(generation))
    }
    .await;
    if result.is_err() {
        app.state::<crate::ArcLock<crate::App>>()
            .write()
            .await
            .clear_pending_recording();
        release(app, generation, false);
    }
    result
}

fn hide_windows(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(generation) = wayland_generation(app) {
        return hide_wayland_windows(app, generation);
    }
    for (label, window) in app.webview_windows() {
        if matches!(
            label.parse::<CapWindowId>(),
            Ok(CapWindowId::Main
                | CapWindowId::Camera
                | CapWindowId::RecordingControls
                | CapWindowId::TargetSelectOverlay { .. })
        ) {
            native_id(&window)?;
            set_native_visibility(&window, false)?;
            if window.is_visible().map_err(|e| e.to_string())? {
                return Err("Cap could not hide its recording windows safely".into());
            }
        }
    }
    Ok(())
}

pub async fn hide(app: &AppHandle, generation: u32) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if !is_current(&handle, generation) {
                return Err("Recording preflight was superseded".to_string());
            }
            hide_windows(&handle)?;
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Timed out hiding Cap windows".to_string())?
        .map_err(|_| "Cap window hide task was cancelled".to_string())??;
    #[cfg(target_os = "linux")]
    if wayland_generation(app) == Some(generation) {
        wayland_fence(app, generation, true).await?;
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    if stop_requested(app, generation) {
        return Err("Recording cancelled".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) struct InstantSeal {
    pub generation: u32,
    pub attempt: crate::recording::linux_instant::Attempt,
    pub requested: crate::RequestedInputs,
    pub target: cap_recording::screen_capture::ScreenCaptureTarget,
    pub capture: crate::linux_instant_camera::PhysicalRect,
    pub presentation: Option<crate::linux_instant_camera::PreparedPresentation>,
}

#[cfg(target_os = "linux")]
fn validate_instant_seal(app: &AppHandle, seal: &InstantSeal) -> Result<(), String> {
    let requested = app.state::<crate::RequestedInputsState>();
    requested.ready_snapshot()?;
    if !is_current(app, seal.generation)
        || phase(app) != Some(Phase::Starting)
        || stop_requested(app, seal.generation)
        || !requested.is_current(&seal.requested)
        || crate::recording::linux_instant::current(app)
            .is_none_or(|attempt| !attempt.same(&seal.attempt))
    {
        return Err("Instant preparation was cancelled or changed".into());
    }
    seal.attempt.checked(Ok(()))?;
    if crate::recording::linux_instant::capture_rect(&seal.target)? != seal.capture {
        return Err("Capture bounds changed while preparing Instant recording".into());
    }
    if let Some(presentation) = &seal.presentation {
        let window = CapWindowId::Camera
            .get(app)
            .ok_or("Camera window disappeared")?;
        presentation.validate_before_hide(&window)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn instant_ui_seal(
    app: &AppHandle,
    seal: InstantSeal,
    hide: bool,
) -> Result<InstantSeal, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let attempt = seal.attempt.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            validate_instant_seal(&handle, &seal)?;
            if hide {
                hide_windows(&handle)?;
            }
            Ok(seal)
        })();
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Instant camera hide acknowledgement timed out".to_string())
        .and_then(|result| {
            result.map_err(|_| "Instant camera hide acknowledgement was lost".to_string())
        })
        .and_then(|result| result);
    if result.is_err() {
        attempt.cancel();
    }
    result
}

#[cfg(target_os = "linux")]
async fn seal_then_settle<T, H, S, V, F>(hide: H, settle: S, validate: V) -> Result<T, String>
where
    H: std::future::Future<Output = Result<T, String>>,
    S: std::future::Future<Output = Result<(), String>>,
    V: FnOnce(T) -> F,
    F: std::future::Future<Output = Result<T, String>>,
{
    let sealed = hide.await?;
    settle.await?;
    validate(sealed).await
}

#[cfg(target_os = "linux")]
pub(crate) async fn seal_instant(
    app: &AppHandle,
    seal: InstantSeal,
) -> Result<InstantSeal, String> {
    let attempt = seal.attempt.clone();
    let generation = seal.generation;
    seal_then_settle(
        instant_ui_seal(app, seal, true),
        attempt.while_active(async {
            #[cfg(target_os = "linux")]
            if wayland_generation(app) == Some(generation) {
                wayland_fence(app, generation, true).await?;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            Ok(())
        }),
        |seal| instant_ui_seal(app, seal, false),
    )
    .await
}

#[cfg(target_os = "linux")]
async fn restore_instant_windows(
    app: &AppHandle,
    generation: u32,
    main_only: bool,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if crate::recording::linux_instant::current(&handle)
                .is_some_and(|attempt| attempt.has_capture() && !attempt.ui_ready())
            {
                return Err("Instant capture cleanup is unconfirmed".to_string());
            }
            if wayland_generation(&handle) == Some(generation) {
                return restore_wayland_windows(&handle, generation, main_only);
            }
            let windows = {
                let state = handle.state::<State>();
                let inner = state.inner.lock().unwrap();
                inner
                    .lease
                    .as_ref()
                    .filter(|lease| {
                        lease.generation == generation && lease.phase == Phase::Restoring
                    })
                    .ok_or("Instant restoration was superseded")?
                    .windows
                    .clone()
            };
            let requested = handle
                .state::<crate::RequestedInputsState>()
                .ready_snapshot();
            if !main_only {
                requested.as_ref().map_err(Clone::clone)?;
            }
            for saved in windows {
                let main = saved.label == CapWindowId::Main.label();
                if main != main_only {
                    continue;
                }
                if !main
                    && requested
                        .as_ref()
                        .is_ok_and(|snapshot| snapshot.camera.value.is_none())
                {
                    continue;
                }
                let window = match handle.get_webview_window(&saved.label) {
                    Some(window) => window,
                    None if wayland_generation(&handle) == Some(generation) && !saved.visible => {
                        continue;
                    }
                    None => return Err("Recording restoration window disappeared".into()),
                };
                let visible = saved
                    .visibility_for(native_id(&window)?)
                    .ok_or("Instant restoration window identity changed")?;
                if !main
                    && !handle
                        .state::<crate::RequestedInputsState>()
                        .is_current(requested.as_ref().map_err(Clone::clone)?)
                {
                    return Err("Requested inputs changed during Instant restoration".into());
                }
                set_native_visibility(&window, visible)?;
                if window.is_visible().map_err(|error| error.to_string())? != visible {
                    return Err("Instant window restoration was not acknowledged".into());
                }
            }
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Instant restore acknowledgement timed out".to_string())?
        .map_err(|_| "Instant restore acknowledgement was lost".to_string())?
}

#[cfg(target_os = "linux")]
async fn restore_instant_sequence<M, I, IF, C, CF>(
    main: M,
    inputs: I,
    camera: C,
) -> Result<(), String>
where
    M: std::future::Future<Output = Result<(), String>>,
    I: FnOnce() -> IF,
    IF: std::future::Future<Output = ()>,
    C: FnOnce() -> CF,
    CF: std::future::Future<Output = Result<(), String>>,
{
    main.await?;
    inputs().await;
    camera().await
}

#[cfg(target_os = "linux")]
fn finish_x11_studio_restoration(
    inner: &Mutex<Inner>,
    generation: u32,
    windows: Result<(), String>,
    release_shortcut: impl FnOnce() -> Result<(), String>,
) -> bool {
    let cleanup = {
        let mut inner = inner.lock().unwrap();
        inner.reserve_x11_studio_cleanup(generation, windows)
    };
    let Some(cleanup) = cleanup else {
        return false;
    };
    let result = if cleanup.registered_shortcut {
        release_shortcut()
    } else {
        Ok(())
    };
    inner
        .lock()
        .unwrap()
        .complete_x11_studio_restoration(cleanup, result)
}

#[cfg(target_os = "linux")]
fn spawn_x11_studio_restore(app: AppHandle, generation: u32, restore_inputs: bool) {
    drop(tauri::async_runtime::spawn(async move {
        let result = restore_instant_sequence(
            restore_instant_windows(&app, generation, true),
            || async {
                if restore_inputs {
                    crate::restore_requested_inputs(&app).await;
                }
            },
            || restore_instant_windows(&app, generation, false),
        )
        .await;
        let handle = app.clone();
        let scheduled = app.run_on_main_thread(move || {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            {
                let state = handle.state::<State>();
                finish_x11_studio_restoration(&state.inner, generation, result, || {
                    handle
                        .global_shortcut()
                        .unregister(STOP_SHORTCUT)
                        .map_err(|error| {
                            format!("Recording Stop shortcut cleanup is unconfirmed: {error}")
                        })
                });
            }
            notify(&handle);
        });
        if let Err(error) = scheduled {
            {
                let state = app.state::<State>();
                finish_x11_studio_restoration(
                    &state.inner,
                    generation,
                    Err(format!(
                        "Recording restoration completion could not be scheduled: {error}"
                    )),
                    || Ok(()),
                );
            }
            notify(&app);
        }
    }));
}

#[cfg(target_os = "linux")]
fn spawn_instant_restore(app: AppHandle, generation: u32, restore_inputs: bool) {
    drop(tauri::async_runtime::spawn(async move {
        let result = restore_instant_sequence(
            restore_instant_windows(&app, generation, true),
            || async {
                if restore_inputs {
                    crate::restore_requested_inputs(&app).await;
                }
            },
            || restore_instant_windows(&app, generation, false),
        )
        .await;
        let result = if wayland_generation(&app) == Some(generation) {
            match result {
                Ok(()) => {
                    async {
                        wayland_fence(&app, generation, false).await?;
                        crate::tray::set_clean_stop_mode(&app, generation, false).await?;
                        crate::hotkeys::release_wayland_stop(&app, generation).await
                    }
                    .await
                }
                Err(error) => Err(error),
            }
        } else {
            result
        };
        let owned = {
            let state = app.state::<State>();
            let mut inner = state.inner.lock().unwrap();
            inner.complete_instant_restoration(generation, result)
        };
        if let Some(owned) = owned {
            crate::hotkeys::release_clean_capture_stop(&app, owned);
            let _ = app.run_on_main_thread(move || {
                WAYLAND_WINDOWS.with_borrow_mut(|windows| {
                    windows.remove(&generation);
                });
                WAYLAND_CAPTURE_WINDOWS.with_borrow_mut(|windows| {
                    windows.remove(&generation);
                });
            });
        }
        notify(&app);
    }));
}

#[cfg(target_os = "linux")]
pub(crate) async fn wait_restored(app: &AppHandle, generation: u32) -> Result<(), String> {
    let state = app.state::<State>();
    wait_for_restoration(&state, generation).await
}

#[cfg(target_os = "linux")]
async fn wait_for_restoration(state: &State, generation: u32) -> Result<(), String> {
    loop {
        let changed = state.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        {
            let inner = state.inner.lock().unwrap();
            if let Some(receipt) = &inner.restored
                && receipt.generation == generation
            {
                return receipt.restart_result();
            }
            if inner
                .lease
                .as_ref()
                .is_none_or(|lease| lease.generation != generation)
            {
                return Err("Instant restoration ownership changed without acknowledgement".into());
            }
        }
        changed.await;
    }
}

pub fn release(app: &AppHandle, generation: u32, editor_took_foreground: bool) {
    release_inner(app, generation, editor_took_foreground, false);
}

pub fn release_after_recording(app: &AppHandle, generation: u32, editor_took_foreground: bool) {
    release_inner(app, generation, editor_took_foreground, true);
}

async fn restore_pass_acknowledged(
    scheduled: bool,
    acknowledgement: tokio::sync::oneshot::Receiver<Result<(), String>>,
) -> bool {
    scheduled && matches!(acknowledgement.await, Ok(Ok(())))
}

fn release_inner(
    app: &AppHandle,
    generation: u32,
    editor_took_foreground: bool,
    restore_inputs: bool,
) {
    #[cfg(target_os = "linux")]
    if crate::recording::linux_instant::current(app)
        .is_some_and(|attempt| attempt.has_capture() && !attempt.ui_ready())
    {
        return;
    }
    {
        let state = app.state::<State>();
        let mut inner = state.inner.lock().unwrap();
        let Some(lease) = inner
            .lease
            .as_mut()
            .filter(|lease| lease.generation == generation && lease.phase != Phase::Restoring)
        else {
            return;
        };
        if editor_took_foreground
            && (lease.wayland || lease.mode == cap_recording::RecordingMode::Studio)
        {
            for window in &mut lease.windows {
                if window.label == CapWindowId::Main.label() {
                    window.visible = false;
                }
            }
        }
        lease.phase = Phase::Restoring;
    }
    notify(app);
    #[cfg(target_os = "linux")]
    if app
        .state::<State>()
        .inner
        .lock()
        .unwrap()
        .lease
        .as_ref()
        .is_some_and(|lease| {
            lease.generation == generation
                && (lease.mode == cap_recording::RecordingMode::Instant || lease.wayland)
        })
    {
        spawn_instant_restore(app.clone(), generation, restore_inputs);
        return;
    }
    #[cfg(target_os = "linux")]
    if app
        .state::<State>()
        .inner
        .lock()
        .unwrap()
        .lease
        .as_ref()
        .is_some_and(|lease| {
            lease.generation == generation
                && lease.mode == cap_recording::RecordingMode::Studio
                && !lease.wayland
        })
    {
        spawn_x11_studio_restore(app.clone(), generation, restore_inputs);
        return;
    }
    let app = app.clone();
    drop(tauri::async_runtime::spawn(async move {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let handle = app.clone();
        let scheduled = app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            if crate::recording::linux_instant::current(&handle)
                .is_some_and(|attempt| attempt.has_capture() && !attempt.ui_ready())
            {
                let _ = tx.send(Err("Instant cleanup is unconfirmed".to_string()));
                return;
            }
            let saved = {
                let state = handle.state::<State>();
                let mut inner = state.inner.lock().unwrap();
                inner
                    .lease
                    .as_mut()
                    .filter(|lease| lease.generation == generation)
                    .map(|lease| {
                        let owned = std::mem::take(&mut lease.registered_shortcut);
                        (
                            lease
                                .windows
                                .iter()
                                .find(|saved| saved.label == CapWindowId::Main.label())
                                .cloned(),
                            owned,
                        )
                    })
            };
            if let Some((saved, owned)) = saved {
                crate::hotkeys::release_clean_capture_stop(&handle, owned);
                if !editor_took_foreground
                    && let Some(saved) = saved
                    && let Some(window) = handle.get_webview_window(&saved.label)
                    && let Some(visible) = native_id(&window)
                        .ok()
                        .and_then(|id| saved.visibility_for(id))
                {
                    let result = set_native_visibility(&window, visible);
                    if let Err(error) = result {
                        tracing::warn!(%error, "Could not restore Main after recording");
                    }
                }
            }
            let _ = tx.send(Ok(()));
        });
        if !restore_pass_acknowledged(scheduled.is_ok(), rx).await {
            return;
        }
        if restore_inputs {
            crate::restore_requested_inputs(&app).await;
        }
        let requested = app.state::<crate::RequestedInputsState>().snapshot();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            if crate::recording::linux_instant::current(&handle)
                .is_some_and(|attempt| attempt.has_capture() && !attempt.ui_ready())
            {
                return;
            }
            let state = handle.state::<State>();
            let windows = {
                let inner = state.inner.lock().unwrap();
                let Some(lease) = inner.lease.as_ref().filter(|lease| {
                    lease.generation == generation && lease.phase == Phase::Restoring
                }) else {
                    return;
                };
                lease.windows.clone()
            };
            for saved in windows {
                if saved.label == CapWindowId::Main.label() {
                    continue;
                }
                if matches!(saved.label.parse::<CapWindowId>(), Ok(CapWindowId::Camera))
                    && (requested.camera.value.is_none()
                        || requested.camera.pending
                        || requested.camera.error.is_some()
                        || !handle
                            .state::<crate::RequestedInputsState>()
                            .is_current(&requested))
                {
                    continue;
                }
                if let Some(window) = handle.get_webview_window(&saved.label)
                    && let Some(visible) = native_id(&window)
                        .ok()
                        .and_then(|id| saved.visibility_for(id))
                {
                    let result = set_native_visibility(&window, visible);
                    if let Err(error) = result {
                        tracing::warn!(%error, "Could not restore clean capture window");
                    }
                }
            }
            {
                let mut inner = state.inner.lock().unwrap();
                inner.lease = None;
                inner.generation = inner.generation.wrapping_add(1);
            }
            notify(&handle);
        });
    }));
}

#[tauri::command]
#[specta::specta]
pub fn get_clean_capture_state(app: AppHandle) -> Snapshot {
    app.state::<State>().inner.lock().unwrap().snapshot()
}

#[tauri::command]
#[specta::specta]
pub async fn reveal_capture_window(
    window: WebviewWindow,
    generation: u32,
    target_overlay: Option<String>,
) -> Result<bool, String> {
    if let Some(label) = target_overlay {
        if window.label() != CapWindowId::Main.label()
            || !matches!(
                label.parse::<CapWindowId>(),
                Ok(CapWindowId::TargetSelectOverlay { .. })
            )
        {
            return Err("Only Main can restore a target selection overlay".into());
        }
        let target = window
            .app_handle()
            .get_webview_window(&label)
            .ok_or("Target selection overlay no longer exists")?;
        return reveal(target, generation).await;
    }
    if !matches!(
        window.label().parse::<CapWindowId>(),
        Ok(CapWindowId::Main | CapWindowId::Camera | CapWindowId::RecordingControls)
    ) {
        return Err("Only Cap recording windows can use this command".into());
    }
    if matches!(
        window.label().parse::<CapWindowId>(),
        Ok(CapWindowId::RecordingControls)
    ) && window
        .app_handle()
        .state::<crate::ArcLock<crate::App>>()
        .read()
        .await
        .current_recording()
        .is_none()
    {
        return Ok(false);
    }
    let main = matches!(window.label().parse::<CapWindowId>(), Ok(CapWindowId::Main));
    reveal_with_options(window, generation, main, main).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_blocks_all_floating_labels_while_capture_can_run() {
        for mode in [
            cap_recording::RecordingMode::Studio,
            cap_recording::RecordingMode::Instant,
        ] {
            for phase in [
                Phase::Starting,
                Phase::Recording,
                Phase::Pausing,
                Phase::Resuming,
                Phase::ResumeFailed,
                Phase::Restarting,
                Phase::Stopping,
            ] {
                let mut inner = fixture();
                let lease = inner.lease.as_mut().unwrap();
                lease.mode = mode;
                lease.wayland = true;
                lease.phase = phase;
                for label in [
                    "main",
                    "camera",
                    "teleprompter",
                    "settings",
                    "editor-4",
                    "unknown-js-window",
                ] {
                    assert!(!inner.may_reveal(1, label), "{phase:?}: {label}");
                }
            }
        }
    }

    #[test]
    fn x11_floating_admission_is_unchanged() {
        let mut inner = fixture();
        inner.lease.as_mut().unwrap().phase = Phase::Recording;
        assert!(!inner.lease.as_ref().unwrap().wayland);
        assert!(inner.may_reveal(1, "teleprompter"));
        assert!(inner.may_reveal(1, "settings"));
        assert!(!inner.may_reveal(1, "camera"));
    }

    #[test]
    fn wayland_restore_keeps_non_camera_window_intent() {
        for label in ["teleprompter", "settings", "editor-4", "unknown-js-window"] {
            assert!(restore_floating_window(Some(label)));
        }
        assert!(restore_floating_window(None));
        for label in [
            "capture-area",
            "in-progress-recording",
            "target-select-overlay-1",
            "window-capture-occluder-1",
        ] {
            assert!(!restore_floating_window(Some(label)));
        }
    }

    #[test]
    fn wayland_safe_ui_phases_allow_mapping_but_old_generation_does_not() {
        for phase in [Phase::AwaitingShortcut, Phase::Paused, Phase::Restoring] {
            assert!(!wayland_blocks_mapping(phase));
            let mut inner = fixture();
            let lease = inner.lease.as_mut().unwrap();
            lease.wayland = true;
            lease.phase = phase;
            assert!(inner.may_reveal(1, "teleprompter"));
            assert!(!inner.may_reveal(0, "teleprompter"));
        }
    }

    #[tokio::test]
    async fn restore_pass_waits_for_successful_ack_before_following_work() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let work = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = work.clone();
        let task = tokio::spawn(async move {
            if restore_pass_acknowledged(true, rx).await {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        assert_eq!(work.load(std::sync::atomic::Ordering::SeqCst), 0);
        tx.send(Ok(())).unwrap();
        task.await.unwrap();
        assert_eq!(work.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rejected_restore_pass_does_not_authorize_following_work() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(Err("Instant cleanup is unconfirmed".into()))
            .unwrap();
        assert!(!restore_pass_acknowledged(true, rx).await);
    }

    #[tokio::test]
    async fn dropped_restore_ack_does_not_authorize_following_work() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(tx);
        assert!(!restore_pass_acknowledged(true, rx).await);
    }

    #[tokio::test]
    async fn unscheduled_restore_pass_does_not_wait_for_an_ack() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        assert!(
            !tokio::time::timeout(
                std::time::Duration::from_millis(100),
                restore_pass_acknowledged(false, rx),
            )
            .await
            .unwrap()
        );
        assert!(tx.is_closed());
    }

    #[cfg(target_os = "linux")]
    fn x11_studio_restoring_fixture() -> Mutex<Inner> {
        let mut inner = fixture();
        inner.lease.as_mut().unwrap().phase = Phase::Restoring;
        Mutex::new(inner)
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn x11_studio_restore_waits_for_windows_before_stop_cleanup_and_receipt() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let inner = Arc::new(x11_studio_restoring_fixture());
        let inputs = Arc::new(AtomicUsize::new(0));
        let cleanup = Arc::new(AtomicUsize::new(0));
        let (main_tx, main_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let (camera_tx, camera_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let (inputs_tx, inputs_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn({
            let inner = inner.clone();
            let inputs = inputs.clone();
            let cleanup = cleanup.clone();
            async move {
                let result = restore_instant_sequence(
                    async { main_rx.await.unwrap() },
                    || async move {
                        inputs.fetch_add(1, Ordering::SeqCst);
                        inputs_tx.send(()).unwrap();
                    },
                    || async { camera_rx.await.unwrap() },
                )
                .await;
                assert!(finish_x11_studio_restoration(&inner, 1, result, || {
                    cleanup.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }));
            }
        });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        assert_eq!(inputs.load(Ordering::SeqCst), 0);
        assert_eq!(cleanup.load(Ordering::SeqCst), 0);
        assert!(inner.lock().unwrap().restored.is_none());
        main_tx.send(Ok(())).unwrap();
        inputs_rx.await.unwrap();
        assert!(!task.is_finished());
        assert_eq!(inputs.load(Ordering::SeqCst), 1);
        assert_eq!(cleanup.load(Ordering::SeqCst), 0);
        assert!(inner.lock().unwrap().lease.is_some());
        assert!(inner.lock().unwrap().restored.is_none());
        camera_tx.send(Ok(())).unwrap();
        task.await.unwrap();
        let inner = inner.lock().unwrap();
        assert!(inner.lease.is_none());
        assert_eq!(inner.generation, 2);
        let receipt = inner.restored.as_ref().unwrap();
        assert_eq!(receipt.generation, 1);
        assert_eq!(receipt.restart_result(), Ok(()));
        assert_eq!(cleanup.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_restore_failures_retain_ownership_and_report_failure_until_retry() {
        for (windows, cleanup, error, cleanup_calls) in [
            (
                Err("window restoration failed".to_string()),
                Ok(()),
                "window restoration failed",
                0,
            ),
            (
                Ok(()),
                Err("Stop cleanup failed".to_string()),
                "Stop cleanup failed",
                1,
            ),
        ] {
            let state = x11_studio_restoring_fixture();
            let calls = std::cell::Cell::new(0);
            assert!(!finish_x11_studio_restoration(&state, 1, windows, || {
                calls.set(calls.get() + 1);
                cleanup
            }));
            assert_eq!(calls.get(), cleanup_calls);
            {
                let inner = state.lock().unwrap();
                assert_eq!(inner.generation, 1);
                let lease = inner.lease.as_ref().unwrap();
                assert_eq!(lease.phase, Phase::Restoring);
                assert!(lease.registered_shortcut);
                assert!(inner.x11_cleanup.is_none());
                assert_eq!(inner.snapshot().error.as_deref(), Some(error));
                let receipt = inner.restored.as_ref().unwrap();
                assert_eq!(receipt.generation, 1);
                assert_eq!(receipt.restart_result(), Err(error.to_string()));
            }
            assert!(!finish_x11_studio_restoration(&state, 1, Ok(()), || {
                panic!("a duplicate completion cannot retry cleanup")
            }));
            {
                let mut inner = state.lock().unwrap();
                assert_eq!(inner.begin_x11_studio_restore_retry(false), None);
                assert_eq!(inner.begin_x11_studio_restore_retry(true), Some(1));
                assert!(inner.lease.as_ref().unwrap().stop_requested);
            }
            assert!(finish_x11_studio_restoration(&state, 1, Ok(()), || Ok(())));
            let inner = state.lock().unwrap();
            assert!(inner.lease.is_none());
            assert_eq!(inner.generation, 2);
            assert_eq!(
                inner.restored.as_ref().unwrap().restart_result(),
                Err("Recording restart was cancelled by Stop".into())
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_stale_and_duplicate_restore_cannot_release_another_owner() {
        let state = x11_studio_restoring_fixture();
        assert!(!finish_x11_studio_restoration(&state, 0, Ok(()), || {
            panic!("a stale generation must not release the shortcut")
        }));
        assert!(state.lock().unwrap().restored.is_none());
        state.lock().unwrap().lease.as_mut().unwrap().phase = Phase::Starting;
        assert!(!finish_x11_studio_restoration(&state, 1, Ok(()), || {
            panic!("a live recording must not release the shortcut")
        }));
        state.lock().unwrap().lease.as_mut().unwrap().phase = Phase::Restoring;
        assert!(finish_x11_studio_restoration(&state, 1, Ok(()), || Ok(())));
        assert!(!finish_x11_studio_restoration(&state, 1, Ok(()), || {
            panic!("a duplicate completion must not release the shortcut")
        }));
        assert_eq!(state.lock().unwrap().generation, 2);
        let next = x11_studio_restoring_fixture();
        {
            let mut inner = next.lock().unwrap();
            inner.generation = 2;
            inner.lease.as_mut().unwrap().generation = 2;
        }
        assert!(!finish_x11_studio_restoration(&next, 1, Ok(()), || {
            panic!("an old completion must not release the new shortcut")
        }));
        let inner = next.lock().unwrap();
        assert_eq!(inner.generation, 2);
        assert!(inner.lease.as_ref().unwrap().registered_shortcut);
        assert!(inner.restored.is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_restore_keeps_the_users_existing_stop_shortcut() {
        let state = x11_studio_restoring_fixture();
        state
            .lock()
            .unwrap()
            .lease
            .as_mut()
            .unwrap()
            .registered_shortcut = false;
        assert!(finish_x11_studio_restoration(&state, 1, Ok(()), || {
            panic!("the user shortcut is not owned by this restoration")
        }));
        let inner = state.lock().unwrap();
        assert_eq!(inner.restored.as_ref().unwrap().restart_result(), Ok(()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_stop_during_restoration_prevents_restart_after_cleanup() {
        let state = x11_studio_restoring_fixture();
        assert!(state.lock().unwrap().shortcut(true));
        assert!(finish_x11_studio_restoration(&state, 1, Ok(()), || Ok(())));
        let inner = state.lock().unwrap();
        assert!(inner.lease.is_none());
        assert_eq!(
            inner.restored.as_ref().unwrap().restart_result(),
            Err("Recording restart was cancelled by Stop".into())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_completion_does_not_accept_instant_or_wayland_leases() {
        for (mode, wayland) in [
            (cap_recording::RecordingMode::Instant, false),
            (cap_recording::RecordingMode::Studio, true),
        ] {
            let state = x11_studio_restoring_fixture();
            {
                let mut inner = state.lock().unwrap();
                let lease = inner.lease.as_mut().unwrap();
                lease.mode = mode;
                lease.wayland = wayland;
                assert_eq!(inner.begin_x11_studio_restore_retry(true), None);
            }
            assert!(!finish_x11_studio_restoration(&state, 1, Ok(()), || {
                panic!("another restoration path owns this shortcut")
            }));
            let inner = state.lock().unwrap();
            assert!(inner.restored.is_none());
            assert!(inner.lease.is_some());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_unregister_allows_the_f9_callback_to_lock_and_latch_stop() {
        let state = x11_studio_restoring_fixture();
        let (request_tx, request_rx) = std::sync::mpsc::channel();
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let callback_state = &state;
            let callback = scope.spawn(move || {
                request_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                let mut inner = callback_state.lock().unwrap();
                assert!(inner.x11_cleanup.is_some());
                assert!(inner.lease.as_ref().unwrap().registered_shortcut);
                assert!(inner.reserve_x11_studio_cleanup(1, Ok(())).is_none());
                assert!(inner.shortcut(true));
                drop(inner);
                reply_tx.send(()).unwrap();
            });
            assert!(finish_x11_studio_restoration(&state, 1, Ok(()), || {
                request_tx.send(()).unwrap();
                reply_rx
                    .recv_timeout(Duration::from_secs(1))
                    .map_err(|_| "F9 callback could not acquire restoration state".into())
            }));
            callback.join().unwrap();
        });
        let inner = state.lock().unwrap();
        assert!(inner.x11_cleanup.is_none());
        assert!(inner.lease.is_none());
        assert_eq!(
            inner.restored.as_ref().unwrap().restart_result(),
            Err("Recording restart was cancelled by Stop".into())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn x11_studio_old_cleanup_completion_cannot_finish_a_retry() {
        let state = x11_studio_restoring_fixture();
        let mut inner = state.lock().unwrap();
        let first = inner.reserve_x11_studio_cleanup(1, Ok(())).unwrap();
        assert!(inner.reserve_x11_studio_cleanup(1, Ok(())).is_none());
        assert!(!inner.complete_x11_studio_restoration(first, Err("unregister failed".into())));
        assert_eq!(inner.begin_x11_studio_restore_retry(true), Some(1));
        let retry = inner.reserve_x11_studio_cleanup(1, Ok(())).unwrap();
        assert_ne!(first.sequence, retry.sequence);
        assert!(!inner.complete_x11_studio_restoration(first, Ok(())));
        assert!(inner.x11_cleanup == Some(retry));
        assert!(inner.lease.as_ref().unwrap().registered_shortcut);
        assert!(inner.complete_x11_studio_restoration(retry, Ok(())));
        assert!(!inner.complete_x11_studio_restoration(retry, Ok(())));
        assert_eq!(inner.generation, 2);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn x11_studio_pending_waiter_rejects_restart_after_error_f9_and_retry_success() {
        let state = State {
            inner: x11_studio_restoring_fixture(),
            ..State::default()
        };
        let mut waiter = Box::pin(wait_for_restoration(&state, 1));
        assert!(futures::poll!(&mut waiter).is_pending());
        assert!(!finish_x11_studio_restoration(
            &state.inner,
            1,
            Err("window acknowledgement failed".into()),
            || panic!("window failure must retain the Stop shortcut"),
        ));
        state.changed.notify_waiters();
        {
            let mut inner = state.inner.lock().unwrap();
            assert_eq!(inner.begin_x11_studio_restore_retry(true), Some(1));
            assert!(inner.restored.is_none());
            assert!(inner.lease.as_ref().unwrap().stop_requested);
        }
        assert!(finish_x11_studio_restoration(
            &state.inner,
            1,
            Ok(()),
            || Ok(())
        ));
        state.changed.notify_waiters();
        assert_eq!(
            waiter.await,
            Err("Recording restart was cancelled by Stop".into())
        );
    }

    fn fixture() -> Inner {
        Inner {
            generation: 1,
            control_error: None,
            restored: None,
            #[cfg(target_os = "linux")]
            x11_cleanup_sequence: 0,
            #[cfg(target_os = "linux")]
            x11_cleanup: None,
            lease: Some(Lease {
                mode: cap_recording::RecordingMode::Studio,
                generation: 1,
                phase: Phase::AwaitingShortcut,
                pressed: false,
                stop_requested: false,
                registered_shortcut: true,
                wayland: false,
                stop_route: None,
                stop_description: None,
                stop_error: None,
                lost_stop_routes: [false; 2],
                recording_dir: None,
                windows: Vec::new(),
            }),
        }
    }

    #[test]
    fn requires_delivered_press_then_release() {
        let mut state = fixture();
        assert!(state.shortcut(false));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::AwaitingShortcut);
        assert!(state.shortcut(true));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::AwaitingShortcut);
        assert!(state.shortcut(false));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Starting);
        assert!(!state.lease.as_ref().unwrap().stop_requested);
        assert!(state.shortcut(true));
        assert!(state.lease.as_ref().unwrap().stop_requested);
    }

    #[test]
    fn delayed_reveal_cannot_cross_generation() {
        let mut state = fixture();
        assert!(state.may_reveal(1, "main"));
        state.generation = 2;
        state.lease = None;
        assert!(!state.may_reveal(1, "main"));
        assert!(!state.may_reveal(1, "camera"));
        assert!(state.may_reveal(2, "main"));
    }

    #[test]
    fn wayland_requires_delivered_current_stop_input() {
        let mut state = fixture();
        let lease = state.lease.as_mut().unwrap();
        lease.wayland = true;
        assert!(!lease.accept_stop_input(None, true));
        assert!(!lease.accept_stop_input(Some((2, StopRoute::Tray)), true));
        assert!(!lease.accept_stop_input(Some((1, StopRoute::Portal)), false));
        assert_eq!(lease.phase, Phase::AwaitingShortcut);
        assert!(lease.accept_stop_input(Some((1, StopRoute::Portal)), true));
        assert!(state.shortcut(true));
        assert!(
            !state
                .lease
                .as_mut()
                .unwrap()
                .accept_stop_input(Some((1, StopRoute::Tray)), false)
        );
        assert!(
            state
                .lease
                .as_mut()
                .unwrap()
                .accept_stop_input(Some((1, StopRoute::Portal)), false)
        );
        assert!(state.shortcut(false));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Starting);
    }

    #[test]
    fn wayland_tray_activation_starts_and_next_activation_stops() {
        let mut state = fixture();
        state.lease.as_mut().unwrap().wayland = true;
        for pressed in [true, false] {
            assert!(
                state
                    .lease
                    .as_mut()
                    .unwrap()
                    .accept_stop_input(Some((1, StopRoute::Tray)), pressed)
            );
            assert!(state.shortcut(pressed));
        }
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Starting);
        state.lease.as_mut().unwrap().phase = Phase::Recording;
        assert!(
            state
                .lease
                .as_mut()
                .unwrap()
                .accept_stop_input(Some((1, StopRoute::Tray)), true)
        );
        assert!(state.shortcut(true));
        assert!(state.lease.as_ref().unwrap().stop_requested);
    }

    #[test]
    fn wayland_loss_cannot_start_or_silently_switch_control() {
        let mut state = fixture();
        let lease = state.lease.as_mut().unwrap();
        lease.wayland = true;
        assert!(!lease.lose_stop_route(StopRoute::Portal));
        assert!(!lease.stop_requested);
        assert!(!lease.accept_stop_input(Some((1, StopRoute::Portal)), true));
        assert!(lease.accept_stop_input(Some((1, StopRoute::Tray)), true));
        lease.phase = Phase::Recording;
        assert!(lease.lose_stop_route(StopRoute::Tray));
        assert!(lease.stop_requested);
        assert!(!lease.accept_stop_input(Some((1, StopRoute::Tray)), true));
    }

    #[test]
    fn wayland_both_missing_controls_cancel_visible_preflight() {
        let mut state = fixture();
        let lease = state.lease.as_mut().unwrap();
        lease.wayland = true;
        assert!(!lease.lose_stop_route(StopRoute::Tray));
        assert!(!lease.lose_stop_route(StopRoute::Portal));
        assert!(lease.stop_requested);
        assert_eq!(lease.phase, Phase::AwaitingShortcut);
    }

    #[test]
    fn wayland_control_loss_during_start_is_retained_until_cleanup() {
        let mut state = fixture();
        let lease = state.lease.as_mut().unwrap();
        lease.wayland = true;
        lease.stop_route = Some(StopRoute::Tray);
        lease.phase = Phase::Starting;
        assert!(!lease.lose_stop_route(StopRoute::Tray));
        assert!(lease.stop_requested);
        assert_eq!(lease.phase, Phase::Starting);
    }

    #[test]
    fn only_acknowledged_pause_allows_main() {
        let mut state = fixture();
        for phase in [
            Phase::Starting,
            Phase::Recording,
            Phase::Pausing,
            Phase::Resuming,
            Phase::Restarting,
            Phase::Stopping,
        ] {
            state.lease.as_mut().unwrap().phase = phase;
            assert!(!state.may_reveal(1, "main"));
            assert!(!state.may_reveal(1, "camera"));
            assert!(!state.may_reveal(1, "in-progress-recording"));
        }
        state.lease.as_mut().unwrap().phase = Phase::Paused;
        assert!(state.may_reveal(1, "main"));
        assert!(!state.may_reveal(1, "camera"));
    }

    #[test]
    fn instant_uses_capture_backend_without_loosening_studio_environment() {
        use cap_recording::RecordingMode;
        for strict_x11 in [false, true] {
            assert!(capture_environment_is_x11(
                RecordingMode::Instant,
                strict_x11,
                false
            ));
            assert!(!capture_environment_is_x11(
                RecordingMode::Instant,
                strict_x11,
                true
            ));
            for uses_wayland_portal in [false, true] {
                assert_eq!(
                    capture_environment_is_x11(
                        RecordingMode::Studio,
                        strict_x11,
                        uses_wayland_portal
                    ),
                    strict_x11
                );
            }
        }
        assert!(!x11_environment(true, false, None));
        assert!(capture_environment_is_x11(
            RecordingMode::Instant,
            x11_environment(true, false, None),
            false
        ));
        assert!(!x11_environment(true, true, Some("x11")));
        assert!(capture_environment_is_x11(
            RecordingMode::Instant,
            x11_environment(true, true, Some("x11")),
            false
        ));
    }

    #[test]
    fn monitor_visibility_requires_x11_for_both_recording_modes() {
        use cap_recording::{RecordingMode, screen_capture::ScreenCaptureTarget};
        let display = ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        };
        let area = ScreenCaptureTarget::Area {
            screen: "1".parse().unwrap(),
            bounds: scap_targets::bounds::LogicalBounds::new(
                scap_targets::bounds::LogicalPosition::new(0.0, 0.0),
                scap_targets::bounds::LogicalSize::new(100.0, 100.0),
            ),
        };
        let window = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for target in [&display, &area] {
                assert_eq!(
                    validate_capture_visibility(mode, target, false, false, true),
                    Ok(true)
                );
                assert!(validate_capture_visibility(mode, target, false, false, false).is_err());
            }
            for target in [&window, &ScreenCaptureTarget::CameraOnly] {
                assert_eq!(
                    validate_capture_visibility(mode, target, false, false, true),
                    Ok(false)
                );
                assert_eq!(
                    validate_capture_visibility(mode, target, false, false, false),
                    Ok(false)
                );
            }
        }
        assert_eq!(
            validate_capture_visibility(RecordingMode::Screenshot, &display, false, false, false),
            Ok(false)
        );
    }

    #[test]
    fn window_camera_visibility_is_required_only_for_x11_instant() {
        use cap_recording::{RecordingMode, screen_capture::ScreenCaptureTarget};
        let target = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };
        for mode in [
            RecordingMode::Studio,
            RecordingMode::Instant,
            RecordingMode::Screenshot,
        ] {
            for camera in [false, true] {
                for wayland in [false, true] {
                    let required = mode == RecordingMode::Instant && camera && !wayland;
                    assert_eq!(
                        validate_capture_visibility(mode, &target, camera, wayland, true),
                        Ok(required)
                    );
                    let unsupported =
                        validate_capture_visibility(mode, &target, camera, wayland, false);
                    if required {
                        assert!(unsupported.is_err());
                    } else {
                        assert_eq!(unsupported, Ok(false));
                    }
                }
            }
        }
    }

    #[test]
    fn refuses_wayland_and_ambiguous_sessions() {
        assert!(x11_environment(true, false, Some("x11")));
        assert!(!x11_environment(true, true, Some("x11")));
        assert!(!x11_environment(true, false, Some("wayland")));
        assert!(!x11_environment(true, false, None));
        assert!(!x11_environment(false, false, Some("x11")));
    }

    #[test]
    fn cancel_preflight_never_starts() {
        let mut state = fixture();
        assert!(state.queue_stop());
        assert!(state.shortcut(true));
        assert!(state.shortcut(false));
        assert!(state.lease.as_ref().unwrap().stop_requested);
    }

    #[test]
    fn stop_is_retained_through_start_restart_and_control_transitions() {
        for phase in [Phase::Starting, Phase::Restarting, Phase::Pausing] {
            let mut state = fixture();
            state.lease.as_mut().unwrap().phase = phase;
            assert!(state.queue_stop());
            assert!(state.lease.as_ref().unwrap().stop_requested);
            assert_eq!(state.lease.as_ref().unwrap().phase, phase);
        }
    }

    #[test]
    fn active_stop_claims_cleanup_once() {
        let mut state = fixture();
        state.lease.as_mut().unwrap().phase = Phase::Recording;
        assert!(!state.queue_stop());
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Stopping);
        assert!(state.queue_stop());
        assert!(state.lease.as_ref().unwrap().stop_requested);
    }

    #[test]
    fn unconfirmed_resume_failure_keeps_main_hidden_and_stop_actionable() {
        let mut state = fixture();
        let dir = PathBuf::from("recording-a");
        let lease = state.lease.as_mut().unwrap();
        lease.recording_dir = Some(dir.clone());
        lease.phase = Phase::Resuming;
        assert!(state.complete_control(
            1,
            &dir,
            true,
            &ControlOutcome::ActorFailed {
                error: "actor transport failed".into(),
                paused: false,
            }
        ));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::ResumeFailed);
        assert!(state.shortcut(true));
        assert!(state.lease.as_ref().unwrap().phase.can_stop());
        assert!(!state.may_reveal(1, "main"));
        assert!(!state.queue_stop());
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Stopping);
    }

    #[test]
    fn old_control_acknowledgement_cannot_publish_into_new_recording() {
        let mut state = fixture();
        let lease = state.lease.as_mut().unwrap();
        lease.phase = Phase::Pausing;
        lease.recording_dir = Some(PathBuf::from("recording-b"));
        lease.generation = 2;
        state.generation = 2;
        assert!(!state.complete_control(
            1,
            std::path::Path::new("recording-a"),
            false,
            &ControlOutcome::Succeeded
        ));
        assert!(!state.complete_control(
            2,
            std::path::Path::new("recording-a"),
            false,
            &ControlOutcome::Succeeded
        ));
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::Pausing);
    }

    #[test]
    fn target_overlays_stay_hidden_even_during_preflight_and_pause() {
        let mut state = fixture();
        for phase in [
            Phase::AwaitingShortcut,
            Phase::Recording,
            Phase::Paused,
            Phase::Restarting,
            Phase::Restoring,
        ] {
            state.lease.as_mut().unwrap().phase = phase;
            assert!(!state.may_reveal(1, "target-select-overlay-1"));
        }
    }

    #[test]
    fn restore_preserves_hidden_camera_and_rejects_replaced_native_window() {
        for visible in [false, true] {
            let saved = SavedWindow {
                label: "camera".into(),
                native_id: 42,
                visible,
            };
            assert_eq!(saved.visibility_for(42), Some(visible));
            assert_eq!(saved.visibility_for(43), None);
        }
    }

    #[test]
    fn startup_failure_cannot_own_a_different_pending_recording() {
        let mut state = fixture();
        let old = PathBuf::from("failed-start-a");
        let new = PathBuf::from("pending-start-b");
        state.lease.as_mut().unwrap().phase = Phase::Starting;
        state.lease.as_mut().unwrap().recording_dir = Some(old.clone());
        assert_eq!(state.owner(&old), Some(1));
        assert_eq!(state.owner(&new), None);
        state.lease.as_mut().unwrap().recording_dir = Some(new.clone());
        state.lease.as_mut().unwrap().generation = 2;
        state.generation = 2;
        assert_eq!(state.owner(&old), None);
        assert_eq!(state.owner(&new), Some(2));
    }

    #[tokio::test]
    async fn pending_pause_does_not_reveal_main_and_retains_queued_stop_after_ack() {
        let state = std::sync::Arc::new(Mutex::new(fixture()));
        let dir = PathBuf::from("recording-a");
        {
            let mut state = state.lock().unwrap();
            let lease = state.lease.as_mut().unwrap();
            lease.phase = Phase::Pausing;
            lease.recording_dir = Some(dir.clone());
        }
        let (acknowledge, received) = tokio::sync::oneshot::channel();
        let pending = {
            let state = state.clone();
            tokio::spawn(async move {
                received.await.unwrap();
                state
                    .lock()
                    .unwrap()
                    .complete_control(1, &dir, false, &ControlOutcome::Succeeded)
            })
        };
        {
            let mut state = state.lock().unwrap();
            assert!(!state.may_reveal(1, "main"));
            assert!(state.queue_stop());
        }
        acknowledge.send(()).unwrap();
        assert!(pending.await.unwrap());
        let mut state = state.lock().unwrap();
        assert!(state.lease.as_ref().unwrap().stop_requested);
        assert!(!state.queue_stop());
        assert!(!state.may_reveal(1, "main"));
    }

    #[tokio::test]
    async fn stopped_owner_rejects_delayed_resume_acknowledgement() {
        let state = std::sync::Arc::new(Mutex::new(fixture()));
        let dir = PathBuf::from("recording-a");
        {
            let mut state = state.lock().unwrap();
            let lease = state.lease.as_mut().unwrap();
            lease.phase = Phase::Resuming;
            lease.recording_dir = Some(dir.clone());
        }
        let (acknowledge, received) = tokio::sync::oneshot::channel();
        let pending = {
            let state = state.clone();
            tokio::spawn(async move {
                received.await.unwrap();
                state
                    .lock()
                    .unwrap()
                    .complete_control(1, &dir, true, &ControlOutcome::Succeeded)
            })
        };
        state.lock().unwrap().lease.as_mut().unwrap().phase = Phase::Restoring;
        acknowledge.send(()).unwrap();
        assert!(!pending.await.unwrap());
        assert_eq!(
            state.lock().unwrap().lease.as_ref().unwrap().phase,
            Phase::Restoring
        );
    }

    struct RunningControl {
        state: std::sync::Arc<Mutex<Inner>>,
        stages: tokio::sync::mpsc::UnboundedReceiver<&'static str>,
        hide: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
        change: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
        paused: Option<tokio::sync::oneshot::Sender<bool>>,
        reveal: Option<tokio::sync::oneshot::Sender<()>>,
        result: tokio::task::JoinHandle<Result<(), String>>,
    }

    impl RunningControl {
        fn start(resume: bool) -> Self {
            let state = std::sync::Arc::new(Mutex::new(fixture()));
            {
                let mut inner = state.lock().unwrap();
                let lease = inner.lease.as_mut().unwrap();
                lease.phase = if resume {
                    Phase::Resuming
                } else {
                    Phase::Pausing
                };
                lease.recording_dir = Some(PathBuf::from("recording-a"));
            }
            let (stages, observed) = tokio::sync::mpsc::unbounded_channel();
            let (hide, hidden) = tokio::sync::oneshot::channel();
            let (change, changed) = tokio::sync::oneshot::channel();
            let (paused, acknowledged) = tokio::sync::oneshot::channel();
            let (reveal, mapping) = tokio::sync::oneshot::channel();
            let control_state = state.clone();
            let result = tokio::spawn(async move {
                let dir = PathBuf::from("recording-a");
                ControlOperation {
                    resume,
                    generation: 1,
                    dir: &dir,
                    hide: async {
                        stages.send("hide").unwrap();
                        hidden.await.unwrap()
                    },
                    change: async {
                        stages.send("actor").unwrap();
                        changed.await.unwrap()
                    },
                    paused: async {
                        stages.send("confirm-paused").unwrap();
                        acknowledged.await.unwrap()
                    },
                    restore: async {
                        stages.send("queue-main").unwrap();
                        mapping.await.unwrap();
                        if control_state
                            .lock()
                            .unwrap()
                            .may_restore_paused_main(1, &dir)
                        {
                            stages.send("show-main").unwrap();
                            Ok(())
                        } else {
                            stages.send("suppress-main").unwrap();
                            Err("Recording changed before mapping".into())
                        }
                    },
                    stop: async {
                        stages.send("stop").unwrap();
                        assert!(!control_state.lock().unwrap().queue_stop());
                        Ok(())
                    },
                    notify: || stages.send("notify").unwrap(),
                }
                .run(&control_state)
                .await
            });
            Self {
                state,
                stages: observed,
                hide: Some(hide),
                change: Some(change),
                paused: Some(paused),
                reveal: Some(reveal),
                result,
            }
        }

        async fn dispatch_stop(
            &self,
        ) -> (
            tokio::sync::oneshot::Sender<()>,
            tokio::task::JoinHandle<()>,
        ) {
            {
                let mut inner = self.state.lock().unwrap();
                assert!(inner.shortcut(true));
                assert!(inner.lease.as_ref().unwrap().phase.can_stop());
                assert!(!inner.queue_stop());
            }
            let (entered, delivered) = tokio::sync::oneshot::channel();
            let (acknowledge, joined) = tokio::sync::oneshot::channel();
            let state = self.state.clone();
            let stop = tokio::spawn(async move {
                entered.send(()).unwrap();
                joined.await.unwrap();
                let mut inner = state.lock().unwrap();
                if inner.owner(std::path::Path::new("recording-a")) == Some(1)
                    && inner.lease.as_ref().unwrap().phase == Phase::Stopping
                {
                    inner.lease.as_mut().unwrap().phase = Phase::Restoring;
                }
            });
            tokio::time::timeout(Duration::from_secs(1), delivered)
                .await
                .unwrap()
                .unwrap();
            (acknowledge, stop)
        }

        async fn expect(&mut self, stage: &'static str) {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), self.stages.recv())
                    .await
                    .unwrap(),
                Some(stage)
            );
        }

        async fn finish(self) -> Result<(), String> {
            tokio::time::timeout(Duration::from_secs(1), self.result)
                .await
                .unwrap()
                .unwrap()
        }
    }

    #[tokio::test]
    async fn resume_hide_failure_restores_main_without_calling_actor() {
        let mut run = RunningControl::start(true);
        run.expect("hide").await;
        run.hide
            .take()
            .unwrap()
            .send(Err("partial unmap failed".into()))
            .unwrap();
        run.expect("notify").await;
        run.expect("queue-main").await;
        {
            let inner = run.state.lock().unwrap();
            assert_eq!(inner.lease.as_ref().unwrap().phase, Phase::Paused);
            assert!(!inner.may_reveal(1, "camera"));
            assert!(!inner.may_reveal(1, "in-progress-recording"));
            assert!(inner.lease.as_ref().unwrap().registered_shortcut);
        }
        run.reveal.take().unwrap().send(()).unwrap();
        run.expect("show-main").await;
        assert_eq!(run.finish().await.unwrap_err(), "partial unmap failed");
    }

    #[tokio::test]
    async fn actor_resume_error_waits_for_quiescent_pause_ack_before_mapping() {
        let mut run = RunningControl::start(true);
        run.expect("hide").await;
        run.hide.take().unwrap().send(Ok(())).unwrap();
        run.expect("actor").await;
        run.change
            .take()
            .unwrap()
            .send(Err("segment setup failed".into()))
            .unwrap();
        run.expect("confirm-paused").await;
        assert!(!run.state.lock().unwrap().may_reveal(1, "main"));
        run.paused.take().unwrap().send(true).unwrap();
        run.expect("notify").await;
        run.expect("queue-main").await;
        run.reveal.take().unwrap().send(()).unwrap();
        run.expect("show-main").await;
        assert_eq!(run.finish().await.unwrap_err(), "segment setup failed");
    }

    #[tokio::test]
    async fn unknown_resume_error_does_not_map_and_stop_remains_executable() {
        let mut run = RunningControl::start(true);
        run.expect("hide").await;
        run.hide.take().unwrap().send(Ok(())).unwrap();
        run.expect("actor").await;
        run.change
            .take()
            .unwrap()
            .send(Err("transport failed".into()))
            .unwrap();
        run.expect("confirm-paused").await;
        run.paused.take().unwrap().send(false).unwrap();
        run.expect("notify").await;
        let state = run.state.clone();
        assert!(
            run.finish()
                .await
                .unwrap_err()
                .contains("pause could not be confirmed")
        );
        let mut state = state.lock().unwrap();
        assert_eq!(state.lease.as_ref().unwrap().phase, Phase::ResumeFailed);
        assert!(state.shortcut(true));
        assert!(state.lease.as_ref().unwrap().phase.can_stop());
        assert!(!state.may_reveal(1, "main"));
        assert!(!state.queue_stop());
    }

    #[tokio::test]
    async fn stop_during_hide_executes_before_resume_and_rejects_late_hide() {
        for hidden in [Ok(()), Err("hide failed".into())] {
            let mut run = RunningControl::start(true);
            run.expect("hide").await;
            let (ack, stopped) = run.dispatch_stop().await;
            assert!(!run.result.is_finished());
            ack.send(()).unwrap();
            stopped.await.unwrap();
            run.hide.take().unwrap().send(hidden).unwrap();
            assert!(run.finish().await.unwrap_err().contains("changed during"));
        }
    }

    #[tokio::test]
    async fn stop_during_pause_confirmation_executes_without_waiting_for_it() {
        for paused in [true, false] {
            let mut run = RunningControl::start(true);
            run.expect("hide").await;
            run.hide.take().unwrap().send(Ok(())).unwrap();
            run.expect("actor").await;
            run.change
                .take()
                .unwrap()
                .send(Err("setup failed".into()))
                .unwrap();
            run.expect("confirm-paused").await;
            let (ack, stopped) = run.dispatch_stop().await;
            assert!(!run.result.is_finished());
            ack.send(()).unwrap();
            stopped.await.unwrap();
            run.paused.take().unwrap().send(paused).unwrap();
            assert!(run.finish().await.unwrap_err().contains("changed during"));
        }
    }

    #[tokio::test]
    async fn pending_resume_does_not_block_stop_and_late_result_cannot_publish() {
        for resumed in [Ok(()), Err("cancelled setup".into())] {
            let mut run = RunningControl::start(true);
            run.expect("hide").await;
            run.hide.take().unwrap().send(Ok(())).unwrap();
            run.expect("actor").await;
            let (ack, stopped) = run.dispatch_stop().await;
            assert!(!run.result.is_finished());
            assert_eq!(
                run.state.lock().unwrap().lease.as_ref().unwrap().phase,
                Phase::Stopping
            );
            ack.send(()).unwrap();
            stopped.await.unwrap();
            assert!(!run.result.is_finished());
            let failed = resumed.is_err();
            run.change.take().unwrap().send(resumed).unwrap();
            if failed {
                run.expect("confirm-paused").await;
                run.paused.take().unwrap().send(true).unwrap();
            }
            let state = run.state.clone();
            assert!(run.finish().await.unwrap_err().contains("changed during"));
            let inner = state.lock().unwrap();
            assert_eq!(inner.lease.as_ref().unwrap().phase, Phase::Restoring);
            assert!(inner.snapshot().error.is_none());
        }
    }

    #[tokio::test]
    async fn delayed_pause_confirmation_cannot_publish_to_new_owner() {
        let mut run = RunningControl::start(true);
        run.expect("hide").await;
        run.hide.take().unwrap().send(Ok(())).unwrap();
        run.expect("actor").await;
        run.change
            .take()
            .unwrap()
            .send(Err("setup failed".into()))
            .unwrap();
        run.expect("confirm-paused").await;
        {
            let mut inner = run.state.lock().unwrap();
            inner.generation = 2;
            let lease = inner.lease.as_mut().unwrap();
            lease.generation = 2;
            lease.recording_dir = Some(PathBuf::from("recording-b"));
        }
        run.paused.take().unwrap().send(true).unwrap();
        let state = run.state.clone();
        assert!(run.finish().await.unwrap_err().contains("changed during"));
        assert_eq!(
            state.lock().unwrap().lease.as_ref().unwrap().phase,
            Phase::Resuming
        );
    }

    #[tokio::test]
    async fn delayed_main_mapping_rechecks_owner_phase_and_stop() {
        for mutation in 0..4 {
            let mut run = RunningControl::start(true);
            run.expect("hide").await;
            run.hide
                .take()
                .unwrap()
                .send(Err("hide failed".into()))
                .unwrap();
            run.expect("notify").await;
            run.expect("queue-main").await;
            {
                let mut inner = run.state.lock().unwrap();
                match mutation {
                    0 => {
                        inner.generation = 2;
                        inner.lease.as_mut().unwrap().generation = 2;
                    }
                    1 => {
                        inner.lease.as_mut().unwrap().recording_dir =
                            Some(PathBuf::from("recording-b"))
                    }
                    2 => inner.lease.as_mut().unwrap().phase = Phase::Resuming,
                    _ => inner.lease.as_mut().unwrap().stop_requested = true,
                }
            }
            run.reveal.take().unwrap().send(()).unwrap();
            run.expect("suppress-main").await;
            assert!(
                run.finish()
                    .await
                    .unwrap_err()
                    .contains("Could not restore controls")
            );
        }
    }

    #[tokio::test]
    async fn ordinary_pause_and_successful_resume_never_use_failure_restore() {
        for resume in [false, true] {
            let mut run = RunningControl::start(resume);
            if resume {
                run.expect("hide").await;
                run.hide.take().unwrap().send(Ok(())).unwrap();
            }
            run.expect("actor").await;
            run.change.take().unwrap().send(Ok(())).unwrap();
            run.expect("notify").await;
            let state = run.state.clone();
            assert!(run.finish().await.is_ok());
            assert_eq!(
                state.lock().unwrap().lease.as_ref().unwrap().phase,
                if resume {
                    Phase::Recording
                } else {
                    Phase::Paused
                }
            );
        }
    }

    #[tokio::test]
    async fn stale_hide_completion_never_invokes_actor_or_restores_main() {
        for success in [false, true] {
            let mut run = RunningControl::start(true);
            run.expect("hide").await;
            run.state.lock().unwrap().lease.as_mut().unwrap().phase = Phase::Restoring;
            run.hide
                .take()
                .unwrap()
                .send(if success {
                    Ok(())
                } else {
                    Err("hide failed".into())
                })
                .unwrap();
            assert!(run.finish().await.unwrap_err().contains("changed during"));
        }
    }

    #[tokio::test]
    async fn failed_pause_does_not_run_resume_probe_or_restore() {
        let mut run = RunningControl::start(false);
        run.expect("actor").await;
        run.change
            .take()
            .unwrap()
            .send(Err("pause failed".into()))
            .unwrap();
        run.expect("notify").await;
        let state = run.state.clone();
        assert_eq!(run.finish().await.unwrap_err(), "pause failed");
        assert_eq!(
            state.lock().unwrap().lease.as_ref().unwrap().phase,
            Phase::Recording
        );
        assert!(!state.lock().unwrap().may_reveal(1, "main"));
    }

    #[test]
    fn control_error_survives_stop_and_release_but_not_a_new_owner() {
        let mut inner = fixture();
        let dir = PathBuf::from("recording-a");
        inner.lease.as_mut().unwrap().recording_dir = Some(dir.clone());
        inner.lease.as_mut().unwrap().phase = Phase::Resuming;
        assert!(inner.complete_control(
            1,
            &dir,
            true,
            &ControlOutcome::ActorFailed {
                error: "capture setup failed".into(),
                paused: false
            }
        ));
        assert_eq!(
            inner.snapshot().error.as_deref(),
            Some("capture setup failed")
        );
        assert!(!inner.queue_stop());
        assert_eq!(
            inner.snapshot().error.as_deref(),
            Some("capture setup failed")
        );
        inner.lease = None;
        assert_eq!(
            inner.snapshot().error.as_deref(),
            Some("capture setup failed")
        );
        inner.generation = 2;
        assert!(inner.snapshot().error.is_none());
    }
}

#[cfg(all(test, target_os = "linux"))]
mod instant_activation_tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn instant_seal_waits_for_hide_ack_then_settle_then_revalidates() {
        let (hide_tx, hide_rx) = tokio::sync::oneshot::channel();
        let (settle_tx, settle_rx) = tokio::sync::oneshot::channel();
        let (settling_tx, settling_rx) = tokio::sync::oneshot::channel();
        let stage = Arc::new(AtomicUsize::new(0));
        let observed = stage.clone();
        let task = tokio::spawn(async move {
            let validated = observed.clone();
            seal_then_settle(
                async { hide_rx.await.map_err(|_| "hide ack lost".to_string()) },
                async {
                    observed.store(1, Ordering::SeqCst);
                    settling_tx.send(()).unwrap();
                    settle_rx.await.map_err(|_| "settle cancelled".to_string())
                },
                |owner| async move {
                    validated.store(2, Ordering::SeqCst);
                    Ok(owner)
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(stage.load(Ordering::SeqCst), 0);
        assert!(!task.is_finished());
        hide_tx.send(7).unwrap();
        settling_rx.await.unwrap();
        assert_eq!(stage.load(Ordering::SeqCst), 1);
        assert!(!task.is_finished());
        settle_tx.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), 7);
        assert_eq!(stage.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn instant_lost_hide_ack_never_settles_or_builds() {
        let (tx, rx) = tokio::sync::oneshot::channel::<u32>();
        drop(tx);
        let result = seal_then_settle(
            async { rx.await.map_err(|_| "hide ack lost".to_string()) },
            async { panic!("settle cannot begin before hide acknowledgement") },
            |_| async { panic!("build validation cannot begin") },
        )
        .await;
        assert_eq!(result.unwrap_err(), "hide ack lost");
    }

    #[tokio::test]
    async fn instant_cancelled_settle_does_not_revalidate_or_build() {
        let result = seal_then_settle(
            async { Ok(7) },
            async { Err("cancelled".into()) },
            |_| async { panic!("cancelled preparation cannot build") },
        )
        .await;
        assert_eq!(result.unwrap_err(), "cancelled");
    }

    #[tokio::test]
    async fn instant_changed_effect_or_geometry_after_settle_rejects_owner() {
        let result = seal_then_settle(async { Ok(7) }, async { Ok(()) }, |owner| async move {
            assert_eq!(owner, 7);
            Err("prepared presentation changed".into())
        })
        .await;
        assert_eq!(result.unwrap_err(), "prepared presentation changed");
    }

    #[tokio::test]
    async fn instant_restore_waits_for_main_and_camera_acknowledgements() {
        let (main_tx, main_rx) = tokio::sync::oneshot::channel();
        let (camera_tx, camera_rx) = tokio::sync::oneshot::channel();
        let (inputs_tx, inputs_rx) = tokio::sync::oneshot::channel();
        let stage = Arc::new(AtomicUsize::new(0));
        let observed = stage.clone();
        let task = tokio::spawn(async move {
            restore_instant_sequence(
                async { main_rx.await.map_err(|_| "main ack lost".to_string()) },
                || async {
                    observed.store(1, Ordering::SeqCst);
                    inputs_tx.send(()).unwrap();
                },
                || async { camera_rx.await.map_err(|_| "camera ack lost".to_string()) },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(stage.load(Ordering::SeqCst), 0);
        main_tx.send(()).unwrap();
        inputs_rx.await.unwrap();
        assert_eq!(stage.load(Ordering::SeqCst), 1);
        assert!(!task.is_finished());
        camera_tx.send(()).unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn instant_restore_rejected_or_lost_main_ack_never_restores_inputs() {
        for rejected in [true, false] {
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
            if rejected {
                tx.send(Err("unsafe cleanup".into())).unwrap();
            } else {
                drop(tx);
            }
            let result = restore_instant_sequence(
                async { rx.await.map_err(|_| "main ack lost".to_string())? },
                || async { panic!("inputs must remain untouched") },
                || async { panic!("camera must remain hidden") },
            )
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn instant_open_cap_waits_for_stop_ack_and_never_polls_studio_pause() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(finish_main_controls(
            Some(Phase::Recording),
            Some(async { rx.await.map_err(|_| "stop ack lost".to_string()) }),
            async { panic!("Instant OpenCap must not pause") },
        ));
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        tx.send(()).unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn instant_open_cap_preserves_stop_failure_without_pause_or_reveal_permission() {
        let result = finish_main_controls(
            Some(Phase::Starting),
            Some(async { Err("capture cleanup unconfirmed".into()) }),
            async { panic!("Instant OpenCap must not pause") },
        )
        .await;
        assert_eq!(result.unwrap_err(), "capture cleanup unconfirmed");
    }

    #[tokio::test]
    async fn studio_open_cap_waits_for_pause_ack_before_allowing_reveal() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
        let reveals = Arc::new(AtomicUsize::new(0));
        let observed = reveals.clone();
        let task = tokio::spawn(async move {
            finish_main_controls(
                Some(Phase::Recording),
                None::<std::future::Ready<Result<(), String>>>,
                async {
                    started_tx.send(()).unwrap();
                    paused_rx.await.map_err(|_| "pause ack lost".to_string())
                },
            )
            .await?;
            observed.fetch_add(1, Ordering::SeqCst);
            Ok::<(), String>(())
        });
        started_rx.await.unwrap();
        assert!(!task.is_finished());
        assert_eq!(reveals.load(Ordering::SeqCst), 0);
        paused_tx.send(()).unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(reveals.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn studio_open_cap_preserves_pause_failure_without_allowing_reveal() {
        let result: Result<(), String> = async {
            finish_main_controls(
                Some(Phase::Recording),
                None::<std::future::Ready<Result<(), String>>>,
                async { Err("pause acknowledgement failed".into()) },
            )
            .await?;
            panic!("a failed pause must not permit controls to be revealed")
        }
        .await;
        assert_eq!(result.unwrap_err(), "pause acknowledgement failed");
    }

    #[tokio::test]
    async fn repeated_studio_open_cap_keeps_the_recording_paused() {
        for _ in 0..3 {
            finish_main_controls(
                Some(Phase::Paused),
                None::<std::future::Ready<Result<(), String>>>,
                async { panic!("an already paused recording must not be changed") },
            )
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn studio_open_cap_rejects_pending_transitions_without_changing_capture() {
        for phase in [
            Phase::Starting,
            Phase::Pausing,
            Phase::Resuming,
            Phase::ResumeFailed,
            Phase::Restarting,
            Phase::Stopping,
        ] {
            let result = finish_main_controls(
                Some(phase),
                None::<std::future::Ready<Result<(), String>>>,
                async { panic!("a pending recording transition must not be changed") },
            )
            .await;
            assert_eq!(
                result.unwrap_err(),
                "Recording is changing state. Use Ctrl+Shift+F9 to stop."
            );
        }
    }

    #[tokio::test]
    async fn open_cap_keeps_preflight_visible_and_studio_pause_semantics() {
        finish_main_controls(
            Some(Phase::AwaitingShortcut),
            Some(async { panic!("preflight must not issue Stop") }),
            async { panic!("preflight must not issue Pause") },
        )
        .await
        .unwrap();
        finish_main_controls(
            Some(Phase::Recording),
            None::<std::future::Ready<Result<(), String>>>,
            async { Ok(()) },
        )
        .await
        .unwrap();
    }

    fn restoring() -> Inner {
        Inner {
            generation: 7,
            lease: Some(Lease {
                mode: cap_recording::RecordingMode::Instant,
                generation: 7,
                phase: Phase::Restoring,
                pressed: false,
                stop_requested: false,
                registered_shortcut: true,
                wayland: false,
                stop_route: None,
                stop_description: None,
                stop_error: None,
                lost_stop_routes: [false; 2],
                recording_dir: None,
                windows: Vec::new(),
            }),
            ..Inner::default()
        }
    }

    #[test]
    fn instant_restore_error_retains_lease_shortcut_and_error_until_successful_retry() {
        let mut inner = restoring();
        assert_eq!(
            inner.complete_instant_restoration(7, Err("camera ack lost".into())),
            None
        );
        assert_eq!(inner.snapshot().error.as_deref(), Some("camera ack lost"));
        assert!(inner.lease.as_ref().unwrap().registered_shortcut);
        assert_eq!(inner.generation, 7);
        assert_eq!(inner.complete_instant_restoration(7, Ok(())), Some(true));
        assert!(inner.lease.is_none());
        assert_eq!(inner.generation, 8);
        let receipt = inner.restored.as_ref().unwrap();
        assert_eq!(receipt.generation, 7);
        assert_eq!(receipt.restart_result(), Ok(()));
    }

    #[test]
    fn instant_stop_during_restoration_prevents_restart_after_successful_window_ack() {
        let mut inner = restoring();
        assert!(inner.shortcut(true));
        assert_eq!(inner.complete_instant_restoration(7, Ok(())), Some(true));
        assert!(inner.lease.is_none());
        assert_eq!(inner.generation, 8);
        assert!(inner.restored.as_ref().unwrap().restart_result().is_err());
    }

    #[test]
    fn instant_stale_restore_receipt_cannot_clear_new_lease_or_error() {
        let mut inner = restoring();
        assert_eq!(inner.complete_instant_restoration(6, Ok(())), None);
        assert!(inner.restored.is_none());
        inner.lease.as_mut().unwrap().phase = Phase::Starting;
        assert_eq!(inner.complete_instant_restoration(7, Ok(())), None);
        assert!(inner.lease.as_ref().unwrap().registered_shortcut);
        assert!(inner.restored.is_none());
    }
}

#[cfg(target_os = "linux")]
thread_local! {
    static WAYLAND_WINDOWS: std::cell::RefCell<std::collections::HashMap<u32, Vec<gtk::ApplicationWindow>>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(target_os = "linux")]
pub(crate) fn wayland_generation(app: &AppHandle) -> Option<u32> {
    let state = app.try_state::<State>()?;
    let inner = state.inner.lock().unwrap();
    inner
        .lease
        .as_ref()
        .filter(|lease| lease.wayland)
        .map(|lease| lease.generation)
}

#[cfg(target_os = "linux")]
pub(crate) fn describe_wayland_stop(app: &AppHandle, generation: u32, description: String) {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    if let Some(lease) = inner
        .lease
        .as_mut()
        .filter(|lease| lease.generation == generation && lease.wayland)
    {
        lease.stop_description = Some(description);
    }
    drop(inner);
    notify(app);
}

async fn save_windows(app: &AppHandle, generation: u32) -> Result<Vec<SavedWindow>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if !is_current(&handle, generation) {
                return Err("Recording preflight was superseded".to_string());
            }
            #[cfg(target_os = "linux")]
            if wayland_generation(&handle) == Some(generation) {
                install_wayland_window_guard(&handle)?;
                remember_wayland_windows(&handle, generation)?;
            }
            #[cfg(target_os = "linux")]
            let save_all = wayland_generation(&handle) == Some(generation);
            #[cfg(not(target_os = "linux"))]
            let save_all = false;
            let mut saved = Vec::new();
            for (label, window) in handle.webview_windows() {
                if save_all
                    || matches!(
                        label.parse::<CapWindowId>(),
                        Ok(CapWindowId::Main | CapWindowId::Camera)
                    )
                {
                    #[cfg(target_os = "linux")]
                    if wayland_generation(&handle) == Some(generation) {
                        let gtk = window.gtk_window().map_err(|error| error.to_string())?;
                        WAYLAND_WINDOWS.with_borrow_mut(|windows| {
                            windows.entry(generation).or_default().push(gtk)
                        });
                    }
                    saved.push(SavedWindow {
                        label,
                        native_id: native_id(&window)?,
                        visible: window.is_visible().map_err(|error| error.to_string())?,
                    });
                }
            }
            Ok(saved)
        })();
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Timed out saving recording windows".to_string())?
        .map_err(|_| "Recording windows could not be saved".to_string())?
}

fn set_native_visibility(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let gtk = window.gtk_window().map_err(|error| error.to_string())?;
        // Tao queues GTK visibility changes even on the UI thread; this gate needs
        // the native change to complete before checking its acknowledgement.
        if visible {
            if cap_recording::screenshot::uses_wayland_portal() {
                gtk.show();
            } else {
                gtk.show_all();
            }
        } else {
            gtk.hide();
        }
        if gtk.is_visible() != visible || (!visible && gtk.is_mapped()) {
            return Err("GTK did not acknowledge the recording window visibility change".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
async fn wayland_fence(app: &AppHandle, generation: u32, hidden: bool) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let display = (|| {
            use gtk::prelude::*;
            if !is_current(&handle, generation) {
                return Err("Recording visibility fence was superseded".to_string());
            }
            let gtk = if let Some(window) = CapWindowId::Main.get(&handle) {
                window.gtk_window().map_err(|error| error.to_string())?
            } else if !hidden && phase(&handle) == Some(Phase::Restoring) {
                WAYLAND_WINDOWS
                    .with_borrow(|windows| {
                        windows
                            .get(&generation)
                            .and_then(|windows| windows.first())
                            .cloned()
                    })
                    .ok_or("Retained recording display disappeared")?
            } else {
                return Err("Main recording window disappeared".into());
            };
            let display = gtk.display();
            if display.type_().name() != "GdkWaylandDisplay" {
                return Err(
                    "The recording window is not connected to the Wayland compositor".into(),
                );
            }
            Ok(display)
        })();
        match display {
            Ok(display) => wayland_ack::start(display, handle, generation, hidden, tx),
            Err(error) => {
                let _ = tx.send(Err(error));
            }
        }
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "Wayland visibility acknowledgement timed out".to_string())?
        .map_err(|_| "Wayland visibility acknowledgement was lost".to_string())??;
    if !is_current(app, generation) {
        return Err("Recording visibility acknowledgement was superseded".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod wayland_ack {
    use gtk::{gdk, prelude::*};
    use std::{
        cell::{Cell, RefCell},
        ffi::c_void,
        rc::Rc,
        time::Duration,
    };
    use wayland_sys::{client::*, common::*};

    type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;
    struct Pending {
        callback: Cell<*mut wl_proxy>,
        reply: RefCell<Option<Reply>>,
        _display: gdk::Display,
        app: tauri::AppHandle,
        generation: u32,
        hidden: bool,
    }
    impl Pending {
        fn finish(&self, result: Result<(), String>) {
            let callback = self.callback.replace(std::ptr::null_mut());
            if !callback.is_null() {
                unsafe {
                    (wayland_client_handle().wl_proxy_destroy)(callback);
                }
            }
            if let Some(reply) = self.reply.borrow_mut().take() {
                let _ = reply.send(result);
            }
        }
    }
    static CALLBACK: wl_interface = wl_interface {
        name: c"wl_callback".as_ptr(),
        version: 1,
        request_count: 0,
        requests: std::ptr::null(),
        event_count: 1,
        events: &wl_message {
            name: c"done".as_ptr(),
            signature: c"u".as_ptr(),
            types: std::ptr::null(),
        },
    };
    unsafe extern "C" fn dispatch(
        _: *const c_void,
        data: *mut c_void,
        opcode: u32,
        _: *const wl_message,
        _: *const wl_argument,
    ) -> i32 {
        let pending = unsafe {
            &*((wayland_client_handle().wl_proxy_get_user_data)(data.cast()).cast::<Pending>())
        };
        pending.finish(if opcode == 0 {
            if pending.hidden {
                super::verify_wayland_hidden(&pending.app, pending.generation)
            } else {
                super::verify_wayland_restored(&pending.app, pending.generation)
            }
        } else {
            Err("Unexpected Wayland visibility acknowledgement".into())
        });
        0
    }
    pub(super) fn start(
        display: gdk::Display,
        app: tauri::AppHandle,
        generation: u32,
        hidden: bool,
        reply: Reply,
    ) {
        let Some(client) = wayland_client_option() else {
            let _ = reply.send(Err("Wayland client library is unavailable".into()));
            return;
        };
        let raw =
            unsafe { gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr().cast()) }
                .cast::<wl_display>();
        if raw.is_null() {
            let _ = reply.send(Err("Wayland display connection is unavailable".into()));
            return;
        }
        let mut args = [wl_argument {
            o: std::ptr::null(),
        }];
        let callback = unsafe {
            (client.wl_proxy_marshal_array_constructor)(raw.cast(), 0, args.as_mut_ptr(), &CALLBACK)
        };
        if callback.is_null() {
            let _ = reply.send(Err(
                "Could not queue Wayland visibility acknowledgement".into()
            ));
            return;
        }
        let pending = Rc::new(Pending {
            callback: Cell::new(callback),
            reply: RefCell::new(Some(reply)),
            _display: display.clone(),
            app,
            generation,
            hidden,
        });
        let result = unsafe {
            (client.wl_proxy_add_dispatcher)(
                callback,
                dispatch,
                std::ptr::null(),
                Rc::as_ptr(&pending).cast_mut().cast(),
            )
        };
        if result != 0 {
            pending.finish(Err(
                "Could not subscribe to Wayland visibility acknowledgement".into(),
            ));
            return;
        }
        // GDK owns dispatch on this connection. The timeout retains listener data until
        // either the callback or timeout destroys the proxy, without reading GDK's queue.
        gtk::glib::timeout_add_local_once(Duration::from_secs(2), move || {
            pending.finish(Err(
                "Wayland compositor did not acknowledge window visibility".into(),
            ))
        });
        display.flush();
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn wayland_stop_lost(app: &AppHandle, generation: u32, route: StopRoute, error: String) {
    let state = app.state::<State>();
    let mut inner = state.inner.lock().unwrap();
    let Some(lease) = inner
        .lease
        .as_mut()
        .filter(|lease| lease.generation == generation && lease.wayland)
    else {
        return;
    };
    let stop = lease.lose_stop_route(route);
    if lease.stop_requested {
        lease.stop_error = Some(error);
    } else if route == StopRoute::Tray {
        lease.stop_description = Some("the portal shortcut shown by your desktop".into());
    }
    drop(inner);
    notify(app);
    if stop {
        let app = app.clone();
        drop(tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::recording::stop_recording(app.clone(), app.state()).await {
                tracing::error!(%error, "Could not stop recording after losing its Stop control");
            }
        }));
    }
}

#[cfg(target_os = "linux")]
fn verify_wayland_hidden(app: &AppHandle, generation: u32) -> Result<(), String> {
    use gtk::prelude::*;
    if !is_current(app, generation) || stop_requested(app, generation) {
        return Err("Recording hide acknowledgement was superseded or cancelled".into());
    }
    let main = CapWindowId::Main
        .get(app)
        .ok_or("Main recording window disappeared")?
        .gtk_window()
        .map_err(|error| error.to_string())?;
    let display = main.display();
    for window in wayland_application(app)?.windows() {
        if window.display() != display || window.is_visible() || window.is_mapped() {
            return Err("A Cap window is visible or uses another display connection".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_wayland_restored(app: &AppHandle, generation: u32) -> Result<(), String> {
    use gtk::prelude::*;
    for (saved, wanted) in wayland_restore_plan(app, generation, true)? {
        if saved.window.is_visible() != wanted || saved.window.is_mapped() != wanted {
            return Err("The compositor restore acknowledgement did not match Cap windows".into());
        }
    }
    Ok(())
}

fn wayland_blocks_mapping(phase: Phase) -> bool {
    !matches!(
        phase,
        Phase::AwaitingShortcut | Phase::Paused | Phase::Restoring
    )
}

#[cfg(any(target_os = "linux", test))]
fn restore_floating_window(label: Option<&str>) -> bool {
    !matches!(
        label.and_then(|label| label.parse::<CapWindowId>().ok()),
        Some(
            CapWindowId::RecordingControls
                | CapWindowId::TargetSelectOverlay { .. }
                | CapWindowId::WindowCaptureOccluder { .. }
                | CapWindowId::CaptureArea
        )
    )
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct RetainedWaylandWindow {
    window: gtk::Window,
    label: Option<String>,
    visible: bool,
    requested_during_stop: bool,
}

#[cfg(target_os = "linux")]
thread_local! {
    static WAYLAND_GUARD_APPLICATION: std::cell::RefCell<Option<gtk::glib::WeakRef<gtk::Application>>> = const { std::cell::RefCell::new(None) };
    static WAYLAND_GUARDED_WINDOWS: std::cell::RefCell<Vec<gtk::glib::WeakRef<gtk::Window>>> = const { std::cell::RefCell::new(Vec::new()) };
    static WAYLAND_CAPTURE_WINDOWS: std::cell::RefCell<std::collections::HashMap<u32, Vec<RetainedWaylandWindow>>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(target_os = "linux")]
fn wayland_application(app: &AppHandle) -> Result<gtk::Application, String> {
    use gtk::prelude::*;
    CapWindowId::Main
        .get(app)
        .ok_or("Main recording window disappeared")?
        .gtk_window()
        .map_err(|error| error.to_string())?
        .application()
        .ok_or("Recording GTK application disappeared".into())
}

#[cfg(target_os = "linux")]
fn wayland_window_label(app: &AppHandle, native: &gtk::Window) -> Option<String> {
    use gtk::prelude::*;
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            window
                .gtk_window()
                .ok()
                .filter(|window| window.upcast_ref::<gtk::Window>() == native)
                .map(|_| label)
        })
}

#[cfg(target_os = "linux")]
fn remember_wayland_window(
    app: &AppHandle,
    generation: u32,
    window: &gtk::Window,
    during_stop: bool,
) {
    use gtk::prelude::*;
    let label = wayland_window_label(app, window);
    WAYLAND_CAPTURE_WINDOWS.with_borrow_mut(|windows| {
        let windows = windows.entry(generation).or_default();
        if let Some(saved) = windows.iter_mut().find(|saved| saved.window == *window) {
            if during_stop {
                saved.requested_during_stop = true;
            }
        } else {
            windows.push(RetainedWaylandWindow {
                window: window.clone(),
                label,
                visible: window.is_visible(),
                requested_during_stop: during_stop,
            });
        }
    });
}

#[cfg(target_os = "linux")]
fn guard_wayland_window(app: &AppHandle, window: &gtk::Window) {
    use gtk::prelude::*;
    let already_guarded = WAYLAND_GUARDED_WINDOWS.with_borrow_mut(|windows| {
        windows.retain(|window| window.upgrade().is_some());
        if windows
            .iter()
            .any(|saved| saved.upgrade().as_ref() == Some(window))
        {
            true
        } else {
            windows.push(window.downgrade());
            false
        }
    });
    if already_guarded {
        return;
    }
    let app = app.clone();
    window.connect_map(move |window| {
        let blocked = {
            let state = app.state::<State>();
            let inner = state.inner.lock().unwrap();
            inner
                .lease
                .as_ref()
                .filter(|lease| lease.wayland && wayland_blocks_mapping(lease.phase))
                .map(|lease| (lease.generation, lease.phase == Phase::Stopping))
        };
        if let Some((generation, during_stop)) = blocked {
            remember_wayland_window(&app, generation, window, during_stop);
            // GTK's map default handler sends an empty Wayland commit with updates frozen
            // until initial configure. This synchronous handler unmaps before that dispatch.
            window.hide();
        }
    });
}

#[cfg(target_os = "linux")]
fn install_wayland_window_guard(app: &AppHandle) -> Result<(), String> {
    use gtk::prelude::*;
    let application = wayland_application(app)?;
    let installed = WAYLAND_GUARD_APPLICATION
        .with_borrow(|saved| saved.as_ref().and_then(gtk::glib::WeakRef::upgrade));
    if let Some(installed) = installed {
        if installed != application {
            return Err("Recording GTK application identity changed".into());
        }
        return Ok(());
    }
    let handle = app.clone();
    application.connect_window_added(move |_, window| guard_wayland_window(&handle, window));
    for window in application.windows() {
        guard_wayland_window(app, &window);
    }
    WAYLAND_GUARD_APPLICATION.with_borrow_mut(|saved| *saved = Some(application.downgrade()));
    Ok(())
}

#[cfg(target_os = "linux")]
fn remember_wayland_windows(app: &AppHandle, generation: u32) -> Result<(), String> {
    use gtk::prelude::*;
    for window in wayland_application(app)?.windows() {
        remember_wayland_window(app, generation, &window, false);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn hide_wayland_windows(app: &AppHandle, generation: u32) -> Result<(), String> {
    use gtk::prelude::*;
    remember_wayland_windows(app, generation)?;
    for window in wayland_application(app)?.windows() {
        window.hide();
        if window.is_visible() || window.is_mapped() {
            return Err("GTK could not hide a Cap window".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn admit_wayland_window_creation(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let inner = state.inner.lock().unwrap();
    if inner.lease.as_ref().is_some_and(|lease| {
        lease.wayland && wayland_blocks_mapping(lease.phase) && lease.phase != Phase::Stopping
    }) {
        return Err("Pause or stop recording before opening another Cap window".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn wayland_restore_plan(
    app: &AppHandle,
    generation: u32,
    require_inputs: bool,
) -> Result<Vec<(RetainedWaylandWindow, bool)>, String> {
    use gtk::prelude::*;
    let saved_main = {
        let state = app.state::<State>();
        let inner = state.inner.lock().unwrap();
        let lease = inner
            .lease
            .as_ref()
            .filter(|lease| lease.generation == generation && lease.phase == Phase::Restoring)
            .ok_or("Wayland restoration was superseded")?;
        lease
            .windows
            .iter()
            .find(|window| window.label == CapWindowId::Main.label())
            .cloned()
    };
    let requested = if require_inputs {
        Some(
            app.state::<crate::RequestedInputsState>()
                .ready_snapshot()?,
        )
    } else {
        None
    };
    let retained = WAYLAND_CAPTURE_WINDOWS
        .with_borrow(|windows| windows.get(&generation).cloned())
        .ok_or("Retained Wayland windows disappeared")?;
    let application = WAYLAND_GUARD_APPLICATION
        .with_borrow(|saved| saved.as_ref().and_then(gtk::glib::WeakRef::upgrade))
        .ok_or("Retained GTK application disappeared")?;
    let current = application.windows();
    let mut result = Vec::new();
    for mut saved in retained {
        let label = wayland_window_label(app, &saved.window);
        let label_changed = saved.label.is_some() && saved.label != label;
        if saved.label.is_none() {
            saved.label = label;
        }
        let camera = saved
            .label
            .as_deref()
            .is_some_and(|label| matches!(label.parse(), Ok(CapWindowId::Camera)));
        let editor = saved
            .label
            .as_deref()
            .is_some_and(|label| matches!(label.parse(), Ok(CapWindowId::Editor { .. })));
        let mut wanted = (saved.visible || (editor && saved.requested_during_stop))
            && restore_floating_window(saved.label.as_deref())
            && (!camera
                || requested
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.camera.value.is_some()));
        if saved.label.as_deref() == Some("main") {
            wanted = saved_main.as_ref().is_some_and(|saved| saved.visible);
        }
        if wanted && label_changed {
            return Err("A retained Cap window changed identity".into());
        }
        if wanted && !current.contains(&saved.window) {
            return Err("A retained Cap window disappeared before restoration".into());
        }
        result.push((saved, wanted));
    }
    if requested.as_ref().is_some_and(|requested| {
        !app.state::<crate::RequestedInputsState>()
            .is_current(requested)
    }) {
        return Err("Requested inputs changed during Wayland restoration".into());
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
fn restore_wayland_windows(
    app: &AppHandle,
    generation: u32,
    main_only: bool,
) -> Result<(), String> {
    use gtk::prelude::*;
    for (saved, wanted) in wayland_restore_plan(app, generation, !main_only)? {
        if (saved.label.as_deref() == Some("main")) != main_only {
            continue;
        }
        if wanted {
            saved.window.show();
            if saved.requested_during_stop
                && saved
                    .label
                    .as_deref()
                    .is_some_and(|label| matches!(label.parse(), Ok(CapWindowId::Editor { .. })))
            {
                saved.window.present();
            }
        } else {
            saved.window.hide();
        }
        if saved.window.is_visible() != wanted || (!wanted && saved.window.is_mapped()) {
            return Err("GTK did not acknowledge Cap window restoration".into());
        }
    }
    Ok(())
}
