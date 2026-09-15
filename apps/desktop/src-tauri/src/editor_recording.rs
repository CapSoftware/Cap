use std::path::{Path, PathBuf};
use std::sync::Mutex;

use cap_project::RecordingMeta;
use cap_recording::RecordingMode;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::recording_settings::RecordingSettingsStore;
use crate::windows::{EditorRecordingTarget, ShowCapWindow, editor_window_for_path};
use crate::{App, ArcLock, tray};

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorRecordingFlowInfo {
    pub project_path: PathBuf,
    pub project_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event, Debug, Clone)]
pub struct EditorRecordingFlowChanged {
    pub target: Option<EditorRecordingFlowInfo>,
}

/// The recording mode the user had selected before "Record a new clip" forced
/// Studio, so the preference survives the flow no matter which path ends it.
#[derive(Default)]
pub struct EditorRecordingFlowState {
    previous_mode: Mutex<Option<RecordingMode>>,
}

fn project_name(project_path: &Path) -> String {
    RecordingMeta::load_for_project(project_path)
        .map(|meta| meta.pretty_name)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            project_path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "this project".into())
}

pub fn current(app: &AppHandle) -> Option<EditorRecordingFlowInfo> {
    let project_path = EditorRecordingTarget::current(app)?;
    Some(EditorRecordingFlowInfo {
        project_name: project_name(&project_path),
        project_path,
    })
}

fn emit_changed(app: &AppHandle) {
    let _ = EditorRecordingFlowChanged {
        target: current(app),
    }
    .emit(app);
}

fn begin(app: &AppHandle, project_path: PathBuf) -> Result<(), String> {
    let current_mode = RecordingSettingsStore::get(app)?
        .and_then(|settings| settings.mode)
        .unwrap_or_default();
    if current_mode != RecordingMode::Studio {
        RecordingSettingsStore::set_mode(app, RecordingMode::Studio)?;
        tray::update_tray_icon_for_mode(app, RecordingMode::Studio);
    }
    if let Some(state) = app.try_state::<EditorRecordingFlowState>() {
        *state.previous_mode.lock().unwrap() = Some(current_mode);
    }
    EditorRecordingTarget::set(app, Some(project_path));
    emit_changed(app);
    Ok(())
}

/// Runs after every path that takes the editor recording target -- clean stop,
/// failed or cancelled recording, failed restart, and an explicit cancel -- so
/// the forced Studio mode is put back and every window learns the flow ended.
pub fn finish(app: &AppHandle) {
    let previous_mode = app
        .try_state::<EditorRecordingFlowState>()
        .and_then(|state| state.previous_mode.lock().unwrap().take());
    if let Some(previous_mode) = previous_mode
        && previous_mode != RecordingMode::Studio
    {
        let still_studio = RecordingSettingsStore::get(app)
            .ok()
            .flatten()
            .and_then(|settings| settings.mode)
            .is_none_or(|mode| mode == RecordingMode::Studio);
        if still_studio {
            if let Err(error) = RecordingSettingsStore::set_mode(app, previous_mode) {
                tracing::warn!(%error, "failed to restore the recording mode after the clip flow");
            } else {
                tray::update_tray_icon_for_mode(app, previous_mode);
            }
        }
    }
    emit_changed(app);
}

/// Takes the target without touching any window. Callers must already know
/// no recording is live or pending, since a live recording owns the target.
pub fn abort(app: &AppHandle) -> Option<PathBuf> {
    let project_path = EditorRecordingTarget::take(app)?;
    finish(app);
    tracing::info!(path = %project_path.display(), "editor recording flow aborted");
    Some(project_path)
}

pub fn reveal_editor(app: &AppHandle, project_path: &Path) -> bool {
    let Some(editor_window) = editor_window_for_path(app, project_path) else {
        return false;
    };
    let _ = editor_window.unminimize();
    let _ = editor_window.show();
    let _ = editor_window.set_focus();
    true
}

#[tauri::command]
#[specta::specta]
pub async fn open_editor_recording_main(
    app: AppHandle,
    state: tauri::State<'_, ArcLock<App>>,
    project_path: PathBuf,
) -> Result<(), String> {
    if state.read().await.is_recording_active_or_pending() {
        return Err("A recording is already in progress".into());
    }
    let editor_window = editor_window_for_path(&app, &project_path)
        .ok_or_else(|| "The editor window is no longer open".to_string())?;

    if let Some(previous) = abort(&app)
        && previous != project_path
    {
        reveal_editor(&app, &previous);
    }
    begin(&app, project_path.clone())?;

    if let Err(error) = (ShowCapWindow::Main {
        init_target_mode: None,
    })
    .show(&app)
    .await
    {
        abort(&app);
        return Err(format!("Could not open the recorder: {error}"));
    }

    let _ = editor_window.hide();
    tracing::info!(path = %project_path.display(), "editor recording flow started");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_editor_recording_flow(
    app: AppHandle,
    state: tauri::State<'_, ArcLock<App>>,
) -> Result<(), String> {
    if state.read().await.is_recording_active_or_pending() {
        return Err("Stop the recording before leaving the recorder".into());
    }
    let Some(project_path) = EditorRecordingTarget::current(&app) else {
        return Ok(());
    };
    if editor_window_for_path(&app, &project_path).is_none() {
        abort(&app);
        return Ok(());
    }
    crate::dismiss_main_window(&app);
    Ok(())
}

/// The editor that armed the flow went away (deleted from the recordings list,
/// say) while nothing was recording: drop the flow so the main window returns
/// to its normal state instead of advertising a clip nobody can receive.
pub fn abort_if_editor_gone(app: &AppHandle) {
    let Some(project_path) = EditorRecordingTarget::current(app) else {
        return;
    };
    if editor_window_for_path(app, &project_path).is_some() {
        return;
    }
    let idle = app
        .try_state::<ArcLock<App>>()
        .and_then(|state| {
            state
                .try_read()
                .ok()
                .map(|state| !state.is_recording_active_or_pending())
        })
        .unwrap_or(false);
    if idle {
        abort(app);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_editor_recording_target(
    app: AppHandle,
) -> Result<Option<EditorRecordingFlowInfo>, String> {
    Ok(current(&app))
}
