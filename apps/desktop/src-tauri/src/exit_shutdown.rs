use std::sync::atomic::{AtomicU8, Ordering};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitBlocked {
    StateUnavailable,
    RecordingActive,
    FinalizationActive,
    ExportActive,
    UpdateInstalling,
    AlreadyExiting,
}

impl ExitBlocked {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::StateUnavailable => {
                "Cap could not confirm that recording has finished. Wait for any recording to finish, then try again."
            }
            Self::RecordingActive => {
                "Finish or cancel your recording before quitting or restarting Cap. If you already pressed Stop, wait for it to finish."
            }
            Self::FinalizationActive => {
                "Cap is still saving your recording. Wait for it to finish before quitting or restarting."
            }
            Self::ExportActive => "Wait for your export or upload to finish before restarting Cap.",
            Self::UpdateInstalling => "Cap is installing an update. Wait for it to finish.",
            Self::AlreadyExiting => "Cap is already shutting down.",
        }
    }
}

pub(crate) fn with_idle_recording_state<T, R>(
    state: &tokio::sync::RwLock<T>,
    verify_idle: impl FnOnce(&T) -> Result<(), ExitBlocked>,
    begin: impl FnOnce() -> R,
) -> Result<R, ExitBlocked> {
    let state = state
        .try_read()
        .map_err(|_| ExitBlocked::StateUnavailable)?;
    verify_idle(&state)?;
    Ok(begin())
}

pub(crate) fn recording_start_allowed(
    is_exiting: bool,
    update_blocks_recording: bool,
) -> Result<(), &'static str> {
    if is_exiting {
        Err("Cap is shutting down. Recording has not started.")
    } else if update_blocks_recording {
        Err("Cap is installing an update. Finish updating or restart Cap before recording.")
    } else {
        Ok(())
    }
}

pub(crate) fn prepare_then_begin_exit(
    prepare: impl FnOnce() -> Result<(), String>,
    begin: impl FnOnce() -> bool,
) -> Result<(), String> {
    prepare()?;
    if begin() {
        Ok(())
    } else {
        Err(ExitBlocked::AlreadyExiting.message().into())
    }
}

#[derive(Default)]
pub(crate) struct UpdateInstallState(AtomicU8);

impl UpdateInstallState {
    pub(crate) fn is_installing(&self) -> bool {
        self.0.load(Ordering::Acquire) == 1
    }

    pub(crate) fn blocks_recording(&self) -> bool {
        self.0.load(Ordering::Acquire) != 0
    }

    pub(crate) fn begin(&self) -> Option<UpdateInstallGuard<'_>> {
        self.0
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| UpdateInstallGuard {
                state: self,
                completed: false,
            })
    }
}

pub(crate) struct UpdateInstallGuard<'a> {
    state: &'a UpdateInstallState,
    completed: bool,
}

impl UpdateInstallGuard<'_> {
    pub(crate) fn complete(mut self, can_exit_later: bool) {
        self.state
            .0
            .store(if can_exit_later { 2 } else { 0 }, Ordering::Release);
        self.completed = true;
    }
}

impl Drop for UpdateInstallGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self
                .state
                .0
                .compare_exchange(1, 0, Ordering::AcqRel, Ordering::Acquire);
        }
    }
}

pub(crate) fn run_while_active<T, FExit, F>(is_exiting: FExit, operation: F) -> Option<T>
where
    FExit: Fn() -> bool,
    F: FnOnce() -> T,
{
    if is_exiting() {
        None
    } else {
        Some(operation())
    }
}

pub(crate) fn collect_device_inventory<TCamera, TMicrophone, FExit, FCamera, FMicrophone>(
    is_exiting: FExit,
    camera_permitted: bool,
    microphone_permitted: bool,
    list_cameras: FCamera,
    list_microphones: FMicrophone,
) -> Option<(Vec<TCamera>, Vec<TMicrophone>)>
where
    FExit: Fn() -> bool,
    FCamera: FnOnce() -> Vec<TCamera>,
    FMicrophone: FnOnce() -> Vec<TMicrophone>,
{
    if is_exiting() {
        return None;
    }

    let cameras = if camera_permitted {
        if is_exiting() {
            return None;
        }

        list_cameras()
    } else {
        Vec::new()
    };

    if is_exiting() {
        return None;
    }

    let microphones = if microphone_permitted {
        if is_exiting() {
            return None;
        }

        list_microphones()
    } else {
        Vec::new()
    };

    if is_exiting() {
        return None;
    }

    Some((cameras, microphones))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppExitAction {
    #[cfg(target_os = "macos")]
    Process(i32),
    #[cfg(not(target_os = "macos"))]
    Runtime(i32),
}

pub(crate) fn app_exit_action(exit_code: i32) -> AppExitAction {
    #[cfg(target_os = "macos")]
    {
        AppExitAction::Process(exit_code)
    }

    #[cfg(not(target_os = "macos"))]
    {
        AppExitAction::Runtime(exit_code)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitRequestDecision {
    StartCleanup,
    AlreadyExiting,
    ExportActive,
    AllowRuntimeExit,
    AllowRuntimeRestart,
}

pub(crate) fn handle_exit_requested<FPrevent>(
    is_exiting: bool,
    export_active: bool,
    runtime_exit_requested: bool,
    runtime_restart_requested: bool,
    prevent_exit: FPrevent,
) -> ExitRequestDecision
where
    FPrevent: FnOnce(),
{
    if runtime_restart_requested {
        ExitRequestDecision::AllowRuntimeRestart
    } else if is_exiting && runtime_exit_requested {
        ExitRequestDecision::AllowRuntimeExit
    } else if export_active {
        prevent_exit();
        ExitRequestDecision::ExportActive
    } else if is_exiting {
        prevent_exit();
        ExitRequestDecision::AlreadyExiting
    } else {
        prevent_exit();
        ExitRequestDecision::StartCleanup
    }
}

pub(crate) fn read_target_under_cursor<TDisplay, TWindow, FExit, FDisplay, FWindow>(
    is_exiting: FExit,
    display: FDisplay,
    window: FWindow,
) -> Option<(Option<TDisplay>, Option<TWindow>)>
where
    FExit: Fn() -> bool,
    FDisplay: FnOnce() -> Option<TDisplay>,
    FWindow: FnOnce() -> Option<TWindow>,
{
    if is_exiting() {
        return None;
    }

    let display = display();

    if is_exiting() {
        return None;
    }

    let window = window();

    if is_exiting() {
        return None;
    }

    Some((display, window))
}

pub(crate) fn abort_join_handles<T>(
    tasks: impl IntoIterator<Item = JoinHandle<T>>,
    task: Option<JoinHandle<T>>,
) {
    for task in tasks {
        task.abort();
    }

    if let Some(task) = task {
        task.abort();
    }
}
