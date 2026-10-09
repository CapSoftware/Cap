//! Cap Classic's half of switching between it and Cap.
//!
//! Cap is installed separately and shares this app's settings store and
//! recordings library under the `so.cap.desktop` data directory. When the user
//! switches here from Cap, Cap writes `cap-classic.pending` before opening this
//! app and quits only once the marker is gone, so this side deletes it as soon
//! as one of its windows is visible. `enableGpuiApp` in the shared store
//! records which app owns the session; the GPUI dev loop reads it to decide
//! whether to launch.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::general_settings::GeneralSettingsStore;

#[cfg(target_os = "macos")]
const CAP_BUNDLE_NAME: &str = "Cap.app";
#[cfg(windows)]
const CAP_EXECUTABLE_NAME: &str = "Cap.exe";
#[cfg(all(debug_assertions, windows))]
const DEV_BINARY_NAME: &str = "cap-gpui.exe";
#[cfg(all(debug_assertions, not(windows)))]
const DEV_BINARY_NAME: &str = "cap-gpui";

/// Mirror of `store::app_data_dir` in `apps/desktop-gpui`: Cap always reads
/// the production identifier's directory, even when this is a `.dev` build.
fn shared_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join("Library/Application Support/so.cap.desktop");
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into()))
                .join(".local/share")
        })
        .join("so.cap.desktop");
    base
}

fn classic_pending() -> PathBuf {
    shared_data_dir().join("cap-classic.pending")
}

/// A dev build stores under a `.dev` identifier while Cap always reads the
/// production one, so the session flag has to be written to the shared file.
fn own_store_is_shared(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .is_ok_and(|dir| dir == shared_data_dir())
}

/// Single-key replace with everything else preserved, temp+rename atomic --
/// the same contract as Cap's `set_store_setting`. Only called when the
/// shared store is not this app's own, so it never races the store plugin's
/// in-memory copy.
fn write_shared_store_flag(value: bool) -> Result<(), String> {
    let path = shared_data_dir().join("store");
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|error| format!("The shared store is unreadable: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("Could not read the shared store: {error}")),
    };
    let root = doc
        .as_object_mut()
        .ok_or_else(|| "The shared store is not a JSON object".to_string())?;
    let section = root
        .entry("general_settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "The shared store's general settings are not an object".to_string())?;
    section.insert("enableGpuiApp".into(), serde_json::Value::Bool(value));
    let pretty = serde_json::to_string_pretty(&doc).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&tmp, pretty))
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|error| format!("Could not write the shared store: {error}"))
}

fn set_gpui_owns_session(app: &AppHandle, owns: bool) -> Result<(), String> {
    if own_store_is_shared(app) {
        GeneralSettingsStore::update(app, |settings| settings.enable_gpui_app = owns)
    } else {
        write_shared_store_flag(owns)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CapInstall {
    #[cfg(target_os = "macos")]
    Bundle(PathBuf),
    Executable(PathBuf),
}

impl CapInstall {
    fn path(&self) -> &Path {
        match self {
            #[cfg(target_os = "macos")]
            Self::Bundle(path) => path,
            Self::Executable(path) => path,
        }
    }
}

#[cfg(target_os = "macos")]
fn installed_candidates(executable: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = executable
        .and_then(|executable| {
            executable
                .ancestors()
                .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        })
        .and_then(Path::parent)
    {
        candidates.push(parent.join(CAP_BUNDLE_NAME));
    }
    candidates.push(Path::new("/Applications").join(CAP_BUNDLE_NAME));
    if let Some(home) = home {
        candidates.push(home.join("Applications").join(CAP_BUNDLE_NAME));
    }
    candidates.dedup();
    candidates
}

#[cfg(target_os = "macos")]
fn installed_cap() -> Option<CapInstall> {
    let executable = std::env::current_exe().ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    installed_candidates(executable.as_deref(), home.as_deref())
        .into_iter()
        .find(|bundle| bundle.join("Contents/MacOS/Cap").is_file())
        .map(CapInstall::Bundle)
}

#[cfg(windows)]
fn installed_cap() -> Option<CapInstall> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    };

    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|root| {
            RegKey::predef(root)
                .open_subkey("Software\\cap\\Cap")
                .and_then(|key| key.get_value::<String, _>(""))
                .ok()
                .map(|directory| PathBuf::from(directory.trim().trim_matches('"')))
        })
        .chain(
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|directory| directory.join("Cap")),
        )
        .map(|directory| directory.join(CAP_EXECUTABLE_NAME))
        .find(|executable| executable.is_file())
        .map(CapInstall::Executable)
}

#[cfg(target_os = "linux")]
fn installed_cap() -> Option<CapInstall> {
    let executable = PathBuf::from("/usr/bin/Cap");
    executable
        .is_file()
        .then_some(CapInstall::Executable(executable))
}

#[cfg(debug_assertions)]
fn development_cap() -> Option<CapInstall> {
    let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-gpui/target");
    ["release", "debug"]
        .into_iter()
        .filter_map(|profile| {
            let path = target.join(profile).join(DEV_BINARY_NAME);
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| CapInstall::Executable(path))
}

fn cap_install() -> Option<CapInstall> {
    if let Some(path) = std::env::var_os("CAP_GPUI_BIN").map(PathBuf::from)
        && path.is_file()
    {
        return Some(CapInstall::Executable(path));
    }
    #[cfg(debug_assertions)]
    if let Some(install) = development_cap() {
        return Some(install);
    }
    installed_cap()
}

fn launch_command(install: &CapInstall) -> std::process::Command {
    match install {
        #[cfg(target_os = "macos")]
        CapInstall::Bundle(bundle) => {
            let mut command = std::process::Command::new("/usr/bin/open");
            command.arg("-n").arg(bundle);
            command
        }
        CapInstall::Executable(executable) => std::process::Command::new(executable),
    }
}

/// A launched Cap outlives this app, so it must never inherit this process's
/// stdio: `bun run tauri dev`'s pipes close when this app exits and the next
/// log line would abort Cap. Its output goes to a file instead, because a
/// launch with no terminal is only ever diagnosable from there.
fn launch(install: &CapInstall) -> Result<(), String> {
    use std::process::Stdio;

    let mut command = launch_command(install);
    let log_path = shared_data_dir().join("cap-gpui.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (stdout, stderr) = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(error) => {
            warn!(%error, "could not open the Cap launch log; discarding its output");
            (Stdio::null(), Stdio::null())
        }
    };
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Couldn't open Cap: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn retire_foreground_parent_for_handoff(app: &AppHandle) {
    if app
        .webview_windows()
        .values()
        .any(|window| !window.is_fullscreen().is_ok_and(|fullscreen| !fullscreen))
    {
        warn!(
            "Keeping the handoff parent's activation policy because fullscreen state is active or unavailable"
        );
        return;
    }

    // A foreground parent exiting with a surviving child leaves a macOS background Dock tile.
    match app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        Ok(()) => info!("Requested retirement of Cap Classic's Dock presence for the switch"),
        Err(error) => warn!(%error, "Could not retire Cap Classic's Dock presence for the switch"),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn gpui_app_available() -> bool {
    cap_install().is_some()
}

/// Close this app and open Cap. A failure has to be reported rather than
/// swallowed: the Experimental page shows it on its overlay.
#[tauri::command]
#[specta::specta]
pub async fn switch_to_gpui_app(app: AppHandle) -> Result<(), String> {
    let install =
        cap_install().ok_or_else(|| "Cap isn't installed on this computer".to_string())?;
    crate::prepare_app_exit(&app, || {
        info!(path = %install.path().display(), "switching to Cap");
        set_gpui_owns_session(&app, true)?;
        launch(&install).inspect_err(|_| {
            if let Err(error) = set_gpui_owns_session(&app, false) {
                warn!(%error, "Could not restore the session owner after a failed switch");
            }
        })
    })?;
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        match app.run_on_main_thread(move || {
            retire_foreground_parent_for_handoff(&handle);
            let _ = sender.send(());
        }) {
            Ok(()) => {
                if !matches!(
                    tokio::time::timeout(std::time::Duration::from_secs(2), receiver).await,
                    Ok(Ok(()))
                ) {
                    warn!("The switch's Dock transition was not acknowledged before shutdown");
                }
            }
            Err(error) => warn!(%error, "Could not schedule the switch's Dock transition"),
        }
    }
    crate::complete_admitted_app_exit(app).await;
    Ok(())
}

/// Acknowledge Cap's switch here once a window is visible, for as long as
/// this app runs: Cap may switch to an already-running Cap Classic.
pub fn watch_for_switches(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if classic_pending().try_exists().unwrap_or(false) {
                let handle = app.clone();
                let (sender, receiver) = tokio::sync::oneshot::channel();
                if app
                    .run_on_main_thread(move || {
                        acknowledge_classic_window(&handle);
                        let _ = sender.send(());
                    })
                    .is_ok()
                {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), receiver).await;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}

fn acknowledge_classic_window(app: &AppHandle) {
    if crate::app_is_exiting(app) {
        return;
    }
    let ready = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("onboarding"))
        .is_some_and(|window| {
            let frontend_ready = window.label() == "onboarding"
                || window.url().is_ok_and(|url| url.path() == "/update")
                || app
                    .try_state::<crate::MainWindowReadyState>()
                    .is_some_and(|state| state.is_ready());
            frontend_ready && window.is_visible().unwrap_or(false)
        });
    if ready {
        match std::fs::remove_file(classic_pending()) {
            Ok(()) => info!("Acknowledged the switch from Cap"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!(%error, "Could not acknowledge the switch from Cap"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CapInstall;

    #[test]
    fn executables_launch_directly_with_no_arguments() {
        let path = std::path::PathBuf::from("/opt/Cap ' \" $/Cap");
        let command = super::launch_command(&CapInstall::Executable(path.clone()));
        assert_eq!(command.get_program(), path.as_os_str());
        assert_eq!(command.get_args().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundles_open_as_a_new_instance_with_the_path_as_a_literal_argument() {
        let bundle = std::path::PathBuf::from("/Applications/Cap ' \" $.app");
        let command = super::launch_command(&CapInstall::Bundle(bundle.clone()));
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("-n"), bundle.as_os_str()]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cap_is_found_beside_classic_and_in_both_application_folders() {
        use std::path::{Path, PathBuf};

        assert_eq!(
            super::installed_candidates(
                Some(Path::new(
                    "/Volumes/Work/Apps/Cap Classic.app/Contents/MacOS/Cap Classic"
                )),
                Some(Path::new("/Users/x")),
            ),
            vec![
                PathBuf::from("/Volumes/Work/Apps/Cap.app"),
                PathBuf::from("/Applications/Cap.app"),
                PathBuf::from("/Users/x/Applications/Cap.app"),
            ]
        );
    }
}
