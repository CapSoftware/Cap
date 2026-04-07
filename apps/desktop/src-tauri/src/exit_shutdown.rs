use tokio::task::JoinHandle;

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
