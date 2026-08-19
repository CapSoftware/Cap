//! Launching the experimental gpui-native app (`cap-gpui`) alongside this
//! one. The two apps already share one settings store and recordings library
//! (`apps/desktop-gpui/src/store.rs` reads this app's), so "enabling" the
//! native app is just making sure its process exists.
//!
//! The binary is discovered in order: `CAP_GPUI_BIN` (explicit override), the
//! bundled `gpui/` resource dir (staged by the release pipeline; absent in
//! builds that don't ship it), and -- in debug builds only -- the sibling
//! `apps/desktop-gpui` target dir, so the toggle works from a source checkout.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::general_settings::GeneralSettingsStore;

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
        let target =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-gpui/target");
        for profile in ["release", "debug"] {
            if let Some(path) = existing_file(target.join(profile).join(BINARY_NAME)) {
                return Some(path);
            }
        }
    }

    None
}

/// Mirror of `store::app_data_dir` in `apps/desktop-gpui`: the pidfile its
/// new-instance-wins guard writes lives under the shared production
/// identifier (`so.cap.desktop`), not this app's possibly-`.dev` one.
fn gpui_pidfile() -> PathBuf {
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
    base.join("cap-gpui.pid")
}

/// Whether a live `cap-gpui` owns the pidfile. Launching over a live instance
/// would not stack: its single-instance guard kills the previous process, so
/// an unconditional startup launch would restart a session the user may be
/// recording in.
fn instance_running() -> bool {
    #[cfg(unix)]
    {
        let Ok(raw) = std::fs::read_to_string(gpui_pidfile()) else {
            return false;
        };
        let Ok(pid) = raw.trim().parse::<u32>() else {
            return false;
        };
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("cap-gpui")
            })
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn spawn_detached(path: &std::path::Path) -> Result<(), String> {
    let mut child = std::process::Command::new(path)
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

#[tauri::command]
#[specta::specta]
pub async fn launch_gpui_app(app: AppHandle) -> Result<(), String> {
    let path =
        binary_path(&app).ok_or_else(|| "Cap GPUI isn't included in this build".to_string())?;
    info!(path = %path.display(), "launching Cap GPUI");
    spawn_detached(&path)
}

pub fn launch_at_startup_if_enabled(app: &AppHandle) {
    let enabled = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.enable_gpui_app);
    if !enabled {
        return;
    }
    if instance_running() {
        info!("Cap GPUI is already running; not relaunching it");
        return;
    }
    let Some(path) = binary_path(app) else {
        warn!("Cap GPUI is enabled but its binary was not found");
        return;
    };
    info!(path = %path.display(), "launching Cap GPUI at startup");
    if let Err(error) = spawn_detached(&path) {
        warn!("{error}");
    }
}
