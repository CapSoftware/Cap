use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;
use tokio::sync::{Mutex, Notify};
use tracing::{info, warn};

use crate::general_settings::GeneralSettingsStore;

const UPDATE_ENDPOINT: &str =
    "https://cdn.crabnebula.app/update/cap/cap/{{target}}/{{current_version}}";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Nightly,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub version: String,
    pub notes: Option<String>,
    pub channel: UpdateChannel,
}

#[derive(Serialize, Type, tauri_specta::Event, Clone, Debug)]
pub struct UpdateDownloadProgress {
    pub downloaded: u32,
    pub total: Option<u32>,
}

#[derive(Serialize, Type, tauri_specta::Event, Clone, Debug)]
pub struct UpdateReady {
    pub version: String,
    pub installed: bool,
}

#[derive(Clone)]
struct PendingUpdate {
    update: Update,
    version: String,
    installed: bool,
}

#[derive(Default)]
pub struct UpdatesState {
    pending: Mutex<Option<PendingUpdate>>,
    announced_version: Mutex<Option<String>>,
    notify: Notify,
}

fn current_channel(app: &AppHandle) -> UpdateChannel {
    GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|s| s.update_channel)
        .unwrap_or_default()
}

// Mirrors `updaterTarget()` in src/utils/updater.ts; the plugin's built-in
// target reports "macos"/"linux" while CrabNebula releases are keyed on
// "darwin-*" / "linux-*-deb".
fn updater_target() -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };

    if cfg!(target_os = "macos") {
        format!("darwin-{arch}")
    } else if cfg!(target_os = "linux") {
        format!("linux-{arch}-deb")
    } else {
        format!("windows-{arch}")
    }
}

fn endpoint(channel: UpdateChannel) -> Result<Url, String> {
    let url = match channel {
        UpdateChannel::Stable => UPDATE_ENDPOINT.to_string(),
        UpdateChannel::Nightly => format!("{UPDATE_ENDPOINT}?channel=nightly"),
    };
    Url::parse(&url).map_err(|e| e.to_string())
}

async fn check_channel(
    app: &AppHandle,
    channel: UpdateChannel,
    allow_stable_downgrade: bool,
) -> Result<Option<Update>, String> {
    let builder = app
        .updater_builder()
        .target(updater_target())
        .endpoints(vec![endpoint(channel)?])
        .map_err(|e| e.to_string())?;

    // A user on a nightly prerelease who switches back to Stable should land
    // on the newest stable build even though it is semver-lower than their
    // current version, so any differing non-prerelease remote counts as an
    // update (deliberate downgrade-on-channel-switch semantics). This must
    // ONLY apply when the user's configured channel is Stable: a nightly user
    // on the latest nightly would otherwise see the older stable release
    // qualify and flip-flop between the two channels forever.
    let builder = if allow_stable_downgrade {
        builder.version_comparator(|current, remote| {
            remote.version > current
                || (!current.pre.is_empty()
                    && remote.version.pre.is_empty()
                    && remote.version != current)
        })
    } else {
        builder.version_comparator(|current, remote| remote.version > current)
    };

    builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

fn pick_higher_version(a: Option<Update>, b: Option<Update>) -> Option<Update> {
    match (a, b) {
        (Some(a), Some(b)) => {
            match (
                semver::Version::parse(&a.version),
                semver::Version::parse(&b.version),
            ) {
                (Ok(a_version), Ok(b_version)) => Some(if b_version > a_version { b } else { a }),
                (Ok(_), Err(_)) => Some(a),
                _ => Some(b),
            }
        }
        (a, b) => a.or(b),
    }
}

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let channel = current_channel(app);

    let stable = check_channel(app, UpdateChannel::Stable, channel == UpdateChannel::Stable).await;

    let update = if channel == UpdateChannel::Nightly {
        let nightly = check_channel(app, UpdateChannel::Nightly, false).await;

        // Both channels can produce a candidate when a stable release was
        // promoted after the last nightly; the higher version wins.
        match (stable, nightly) {
            (Ok(stable), Ok(nightly)) => pick_higher_version(stable, nightly),
            (Ok(update), Err(err)) | (Err(err), Ok(update)) => {
                warn!("Update check failed for one channel: {err}");
                update
            }
            (Err(err), Err(_)) => return Err(err),
        }
    } else {
        stable?
    };

    let state = app.state::<UpdatesState>();
    let mut pending = state.pending.lock().await;
    *pending = update.as_ref().map(|update| PendingUpdate {
        // Keep the installed flag if the background loop already installed
        // this version silently.
        installed: pending
            .as_ref()
            .is_some_and(|p| p.version == update.version && p.installed),
        version: update.version.clone(),
        update: update.clone(),
    });

    Ok(update)
}

async fn download_with_progress(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let mut downloaded: u32 = 0;
    update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u32);
                let _ = UpdateDownloadProgress {
                    downloaded,
                    total: total.and_then(|t| u32::try_from(t).ok()),
                }
                .emit(app);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

async fn is_busy(app: &AppHandle) -> bool {
    if crate::export::export_session_active() {
        return true;
    }

    let Some(state) = app.try_state::<crate::ArcLock<crate::App>>() else {
        return true;
    };

    state.read().await.is_recording_active_or_pending()
}

#[tauri::command]
#[specta::specta]
pub async fn updates_check(app: AppHandle) -> Result<Option<UpdateCheckResult>, String> {
    let channel = current_channel(&app);
    Ok(check(&app).await?.map(|update| UpdateCheckResult {
        version: update.version.clone(),
        notes: update.body.clone(),
        channel,
    }))
}

#[tauri::command]
#[specta::specta]
pub async fn updates_download_and_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdatesState>();

    let pending = match state.pending.lock().await.clone() {
        Some(pending) => pending,
        None => {
            let Some(update) = check(&app).await? else {
                return Err("No update available".to_string());
            };
            PendingUpdate {
                version: update.version.clone(),
                update,
                installed: false,
            }
        }
    };

    // The macOS background loop may have already installed this version
    // silently; restarting is all that's left to do.
    if pending.installed {
        return Ok(());
    }

    let bytes = download_with_progress(&app, &pending.update).await?;

    info!("Installing update {}", pending.version);
    pending.update.install(bytes).map_err(|e| e.to_string())?;

    let mut guard = state.pending.lock().await;
    if let Some(p) = guard.as_mut()
        && p.version == pending.version
    {
        p.installed = true;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn updates_channel_changed(app: AppHandle) -> Result<(), String> {
    app.state::<UpdatesState>().notify.notify_one();
    Ok(())
}

pub fn spawn_background_loop(app: AppHandle) {
    // Never auto-update dev builds.
    if cfg!(debug_assertions) {
        return;
    }

    tokio::spawn(async move {
        let mut delay = FIRST_CHECK_DELAY;

        loop {
            {
                let state = app.state::<UpdatesState>();
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = state.notify.notified() => {}
                }
            }

            delay = CHECK_INTERVAL;

            // Stable updates stay frontend-driven; this loop only owns nightly.
            if current_channel(&app) != UpdateChannel::Nightly {
                continue;
            }

            if is_busy(&app).await {
                delay = BUSY_RETRY_DELAY;
                continue;
            }

            let update = match check(&app).await {
                Ok(Some(update)) => update,
                Ok(None) => continue,
                Err(err) => {
                    warn!("Nightly update check failed: {err}");
                    continue;
                }
            };

            let version = update.version.clone();
            let state = app.state::<UpdatesState>();

            if state.announced_version.lock().await.as_deref() == Some(version.as_str()) {
                continue;
            }

            let installed = if cfg!(target_os = "macos") {
                let already_installed = state
                    .pending
                    .lock()
                    .await
                    .as_ref()
                    .is_some_and(|p| p.version == version && p.installed);

                if already_installed {
                    true
                } else {
                    let bytes = match update.download(|_, _| {}, || {}).await {
                        Ok(bytes) => bytes,
                        Err(err) => {
                            warn!("Failed to download nightly update {version}: {err}");
                            continue;
                        }
                    };

                    // A recording or export may have started mid-download;
                    // don't touch the install while one is running.
                    if is_busy(&app).await {
                        delay = BUSY_RETRY_DELAY;
                        continue;
                    }

                    // Safe while Cap runs: the .app bundle is swapped in place
                    // and takes effect on relaunch.
                    if let Err(err) = update.install(bytes) {
                        warn!("Failed to install nightly update {version}: {err}");
                        continue;
                    }

                    let mut pending = state.pending.lock().await;
                    if let Some(p) = pending.as_mut()
                        && p.version == version
                    {
                        p.installed = true;
                    }

                    info!("Nightly update {version} installed; restart to apply");
                    true
                }
            } else {
                // Windows (NSIS) install exits the app mid-session and Linux
                // (deb) prompts for privileges, so never auto-install there;
                // announce and let the user trigger the install.
                info!("Nightly update {version} available");
                false
            };

            let _ = UpdateReady {
                version: version.clone(),
                installed,
            }
            .emit(&app);

            *state.announced_version.lock().await = Some(version);
        }
    });
}
