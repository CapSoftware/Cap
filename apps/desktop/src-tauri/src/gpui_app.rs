//! Handing this app off to the experimental gpui-native app (`cap-gpui`).
//!
//! The two apps already share one settings store and recordings library
//! (`apps/desktop-gpui/src/store.rs` reads this app's), so the `enable_gpui_app`
//! setting is not "run both": whichever app is enabled owns the session. Turning
//! it on spawns `cap-gpui` and exits this app; turning it off inside `cap-gpui`
//! reopens this one. Startup honours the same flag, so the handoff survives a
//! relaunch.
//!
//! The binary is discovered in order: `CAP_GPUI_BIN` (explicit override), the
//! bundled `gpui/` resource dir (staged by the release pipeline; absent in
//! builds that don't ship it), and -- in debug builds only -- the sibling
//! `apps/desktop-gpui` target dir, so the toggle works from a source checkout.
//!
//! ## The handoff marker
//!
//! A handoff that spawns a `cap-gpui` which then dies immediately would leave
//! the user with no app at all, and with a setting that keeps redirecting away
//! from the app that does work. So this side writes `cap-gpui.handoff` next to
//! the shared store before spawning, and `cap-gpui` deletes it once it has been
//! alive for ~10 seconds (`store::handoff_marker_path`, `main.rs`). A marker
//! still present at startup therefore means the last handoff never reached a
//! healthy instance: clear the flag, tell the user, and start normally.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tracing::{info, warn};

use crate::{App, MutableState, general_settings::GeneralSettingsStore, request_app_exit};

#[cfg(windows)]
const BINARY_NAME: &str = "cap-gpui.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "cap-gpui";

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

fn binary_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CAP_GPUI_BIN").map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }

    if let Ok(resources) = app.path().resource_dir()
        && let Some(path) = existing_file(resources.join("gpui").join(BINARY_NAME))
    {
        return Some(path);
    }

    #[cfg(debug_assertions)]
    {
        // Whichever profile was built most recently: a fixed preference here
        // hands off to a days-old binary the moment the other profile is the
        // one being actively rebuilt.
        let target =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-gpui/target");
        let newest = ["release", "debug"]
            .into_iter()
            .filter_map(|profile| {
                let path = target.join(profile).join(BINARY_NAME);
                let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
                Some((modified, path))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path);
        if newest.is_some() {
            return newest;
        }
    }

    None
}

/// Mirror of `store::app_data_dir` in `apps/desktop-gpui`: the pidfile and the
/// handoff marker live under the shared production identifier
/// (`so.cap.desktop`), not this app's possibly-`.dev` one.
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

fn gpui_pidfile() -> PathBuf {
    shared_data_dir().join("cap-gpui.pid")
}

/// Whether this app's own store IS the shared one. It is for the production
/// bundle (`so.cap.desktop`), but a dev build stores under a `.dev` identifier
/// while `cap-gpui` always reads and writes the shared file -- two stores that
/// silently disagree. The handoff flag therefore lives in the shared store,
/// and this app's own copy of the setting is just what its settings page
/// displays.
fn own_store_is_shared(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .is_ok_and(|dir| dir == shared_data_dir())
}

fn shared_store_path() -> PathBuf {
    // The store plugin's file for the production identifier -- the same file
    // `store::set_store_setting` in apps/desktop-gpui operates on.
    shared_data_dir().join("store")
}

fn shared_store_flag() -> Option<bool> {
    let raw = std::fs::read_to_string(shared_store_path()).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    doc.get("general_settings")?.get("enableGpuiApp")?.as_bool()
}

/// Single-key replace with everything else preserved, temp+rename atomic --
/// the same contract as the gpui app's `set_store_setting`. A missing file is
/// created with just this key; an unparseable one is refused rather than
/// replaced. Only ever called when the shared store is NOT this app's own
/// (`own_store_is_shared` false): writing the file directly under the store
/// plugin's feet would race its in-memory copy.
fn write_shared_store_flag(value: bool) {
    let path = shared_store_path();
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(doc) => doc,
            Err(error) => {
                warn!(%error, "shared store is unparseable; leaving it untouched");
                return;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => {
            warn!(%error, "could not read the shared store");
            return;
        }
    };
    let Some(root) = doc.as_object_mut() else {
        warn!("shared store is not a JSON object; leaving it untouched");
        return;
    };
    root.entry("general_settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .map(|section| section.insert("enableGpuiApp".into(), serde_json::Value::Bool(value)));
    let pretty = serde_json::to_string_pretty(&doc).unwrap_or_else(|_| doc.to_string());
    let tmp = path.with_extension("tmp");
    let write = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&tmp, pretty))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(error) = write {
        warn!(%error, "could not write the shared store flag");
    }
}

fn handoff_marker() -> PathBuf {
    shared_data_dir().join("cap-gpui.handoff")
}

/// The dev switch-back's readiness handshake (`store::classic_pending_path`
/// in apps/desktop-gpui): `cap-gpui` writes this and stays on screen until the
/// classic app deletes it, so a minutes-long dev rebuild never leaves the user
/// with no app at all.
fn classic_pending() -> PathBuf {
    shared_data_dir().join("cap-classic.pending")
}

/// The pid of the live `cap-gpui` that owns the pidfile, if there is one.
/// Spawning over a live instance would not stack: its single-instance guard
/// kills the previous process, so a handoff that relaunched unconditionally
/// would restart a session the user may be recording in.
fn running_instance_pid() -> Option<u32> {
    #[cfg(unix)]
    {
        let pid = std::fs::read_to_string(gpui_pidfile())
            .ok()?
            .trim()
            .parse::<u32>()
            .ok()?;
        let alive = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("cap-gpui")
            });
        alive.then_some(pid)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn activate_instance(pid: u32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    if let Some(instance) =
        unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid as _) }
    {
        unsafe {
            instance.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn activate_instance(_pid: u32) {}

fn write_handoff_marker() {
    let path = handoff_marker();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    if let Err(error) = std::fs::write(&path, stamp.to_string()) {
        warn!(%error, "could not write the Cap GPUI handoff marker");
    }
}

/// The child must never inherit this process's stdio. The handoff exits this
/// app, and whatever was reading those pipes (`pnpm tauri dev`'s tooling chain)
/// goes with it; `cap-gpui`'s next log line then hits EPIPE, the write panics
/// inside an ObjC run-loop callback, and the process aborts about a tenth of a
/// second after launch. Its output goes to a file instead of `/dev/null`
/// because a handoff launch has no terminal, and a startup failure there is
/// only ever diagnosable from that file.
fn spawn_detached(path: &std::path::Path) -> Result<(), String> {
    use std::process::Stdio;

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
            warn!(%error, "could not open the Cap GPUI log; discarding its output");
            (Stdio::null(), Stdio::null())
        }
    };

    let mut command = std::process::Command::new(path);
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    // Its own process group, so signals aimed at the terminal this app was
    // started from never reach the app that outlives it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch Cap GPUI: {error}"))?;
    // Reap the child when it exits so it never lingers as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn gpui_app_available(app: AppHandle) -> bool {
    binary_path(&app).is_some()
}

/// Close this app and open the native one. The setting has already been written
/// by the caller, so a failure here has to be reported rather than swallowed:
/// the page reverts it.
#[tauri::command]
#[specta::specta]
pub async fn switch_to_gpui_app(
    app: AppHandle,
    state: MutableState<'_, App>,
) -> Result<(), String> {
    if state.read().await.is_recording_active_or_pending() {
        return Err("Stop your recording before switching to the native app.".to_string());
    }
    if crate::export::export_session_active() {
        return Err(
            "Wait for your export to finish before switching to the native app.".to_string(),
        );
    }

    let path =
        binary_path(&app).ok_or_else(|| "Cap GPUI isn't included in this build".to_string())?;

    // The caller wrote this app's own store; a dev build must also set the
    // flag where `cap-gpui` and the next startup's redirect actually read it.
    if !own_store_is_shared(&app) {
        write_shared_store_flag(true);
    }

    match running_instance_pid() {
        Some(pid) => {
            info!(pid, "Cap GPUI is already running; bringing it forward");
            activate_instance(pid);
        }
        None => {
            write_handoff_marker();
            info!(path = %path.display(), "handing off to Cap GPUI");
            if let Err(error) = spawn_detached(&path) {
                let _ = std::fs::remove_file(handoff_marker());
                if !own_store_is_shared(&app) {
                    write_shared_store_flag(false);
                }
                return Err(error);
            }
        }
    }

    request_app_exit(app).await;
    Ok(())
}

/// Whether this app should hand over to `cap-gpui` instead of starting.
///
/// `true` means the caller must exit before any window is created.
pub fn redirect_at_startup_if_enabled(app: &AppHandle) -> bool {
    let redirect = redirect_decision(app);
    if !redirect {
        // Staying up IS the readiness signal the waiting `cap-gpui` needs --
        // and the wait can begin while this app is ALREADY running (switching
        // back with both apps up), so the signal has to keep firing, not just
        // fire once at startup.
        tauri::async_runtime::spawn(async {
            loop {
                let _ = std::fs::remove_file(classic_pending());
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }
    redirect
}

fn redirect_decision(app: &AppHandle) -> bool {
    let own = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.enable_gpui_app);
    // In a dev build the shared store is the authority: `cap-gpui`'s
    // switch-back writes false THERE, and honouring this app's own `.dev`
    // copy instead would bounce the user straight back after every
    // switch-back (the loop this replaced).
    let enabled = if own_store_is_shared(app) {
        own
    } else {
        shared_store_flag().unwrap_or(false)
    };
    if !enabled {
        if own {
            // The stale display copy: without this the Experimental page
            // shows the toggle on while the classic app owns the session.
            if let Err(error) = GeneralSettingsStore::update(app, |settings| {
                settings.enable_gpui_app = false;
            }) {
                warn!(%error, "could not reconcile the Cap GPUI setting");
            }
        }
        return false;
    }

    // A live instance is checked before the marker: within ten seconds of a
    // successful handoff the marker is still legitimately on disk, and healing
    // then would clear the flag and open this app next to a healthy native one.
    // The marker's lifecycle stays with `cap-gpui` -- if that instance dies
    // before proving itself, the marker survives it and the next launch heals.
    if let Some(pid) = running_instance_pid() {
        info!(pid, "Cap GPUI is already running; handing over to it");
        activate_instance(pid);
        return true;
    }

    let marker = handoff_marker();
    if marker.exists() {
        warn!("the last hand-off to Cap GPUI never reported a healthy instance; taking back over");
        let _ = std::fs::remove_file(&marker);
        if let Err(error) = GeneralSettingsStore::update(app, |settings| {
            settings.enable_gpui_app = false;
        }) {
            warn!(%error, "could not clear the Cap GPUI setting");
        }
        if !own_store_is_shared(app) {
            write_shared_store_flag(false);
        }
        app.dialog()
            .message(
                "The native Cap app didn't start correctly last time, so the classic app has been restored.",
            )
            .show(|_| {});
        return false;
    }

    let Some(path) = binary_path(app) else {
        warn!("Cap GPUI is enabled but its binary was not found; starting this app instead");
        return false;
    };

    write_handoff_marker();
    info!(path = %path.display(), "handing off to Cap GPUI at startup");
    if let Err(error) = spawn_detached(&path) {
        warn!("{error}");
        let _ = std::fs::remove_file(handoff_marker());
        return false;
    }
    true
}
