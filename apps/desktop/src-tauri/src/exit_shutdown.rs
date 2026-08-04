use tokio::task::JoinHandle;

// The .app bundle for a relaunch via LaunchServices, derived from the running
// executable (…/Cap.app/Contents/MacOS/<binary>). None outside a bundle (dev
// runs) — callers must NOT hand a bare Mach-O to open(1), which would route it
// to Terminal and re-attribute TCC to Terminal.
pub(crate) fn relaunch_target(current_exe: &std::path::Path) -> Option<std::path::PathBuf> {
    current_exe
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .map(std::path::Path::to_path_buf)
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
}

pub(crate) fn handle_exit_requested<FPrevent>(
    is_exiting: bool,
    export_active: bool,
    runtime_exit_requested: bool,
    prevent_exit: FPrevent,
) -> ExitRequestDecision
where
    FPrevent: FnOnce(),
{
    if is_exiting && runtime_exit_requested {
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

#[cfg(test)]
mod relaunch_target_tests {
    use super::relaunch_target;
    use std::path::Path;

    #[test]
    fn bundle_layouts_resolve_to_the_app() {
        for (exe, want) in [
            (
                "/Applications/Cap.app/Contents/MacOS/Cap",
                "/Applications/Cap.app",
            ),
            (
                "/Applications/Cap.app/Contents/MacOS/Cap - Development",
                "/Applications/Cap.app",
            ),
            (
                "/Volumes/Cap 0.5.7/Cap.app/Contents/MacOS/Cap",
                "/Volumes/Cap 0.5.7/Cap.app",
            ),
        ] {
            assert_eq!(
                relaunch_target(Path::new(exe)).as_deref(),
                Some(Path::new(want)),
                "exe: {exe}"
            );
        }
    }

    #[test]
    fn non_bundle_layouts_are_refused() {
        for exe in [
            "/repo/src-tauri/target/debug/cap-desktop",
            "/usr/local/bin/cap",
            "/a/b",
            "/",
        ] {
            assert_eq!(relaunch_target(Path::new(exe)), None, "exe: {exe}");
        }
    }
}
