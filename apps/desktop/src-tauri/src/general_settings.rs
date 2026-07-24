use crate::updates::UpdateChannel;
use crate::window_exclusion::WindowExclusion;
use scap_targets::DisplayId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::collections::BTreeMap;
#[cfg(target_os = "macos")]
use tauri::Listener;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;
use tracing::{error, instrument};
use uuid::Uuid;

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PostStudioRecordingBehaviour {
    #[default]
    OpenEditor,
    ShowOverlay,
}

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum MainWindowRecordingStartBehaviour {
    #[default]
    Close,
    Minimise,
}

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PostDeletionBehaviour {
    #[default]
    DoNothing,
    ReopenRecordingWindow,
}

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum EditorPreviewQuality {
    Quarter,
    #[default]
    Half,
    Full,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StudioRecordingQuality {
    Compatibility,
    Balanced,
    Ultra,
}

impl Default for StudioRecordingQuality {
    fn default() -> Self {
        default_studio_recording_quality()
    }
}

impl From<cap_recording::StudioQuality> for StudioRecordingQuality {
    fn from(value: cap_recording::StudioQuality) -> Self {
        match value {
            cap_recording::StudioQuality::Compatibility => Self::Compatibility,
            cap_recording::StudioQuality::Balanced => Self::Balanced,
            cap_recording::StudioQuality::Ultra => Self::Ultra,
        }
    }
}

impl From<StudioRecordingQuality> for cap_recording::StudioQuality {
    fn from(value: StudioRecordingQuality) -> Self {
        match value {
            StudioRecordingQuality::Compatibility => Self::Compatibility,
            StudioRecordingQuality::Balanced => Self::Balanced,
            StudioRecordingQuality::Ultra => Self::Ultra,
        }
    }
}

pub fn default_studio_recording_quality() -> StudioRecordingQuality {
    cap_recording::default_studio_recording_quality().into()
}

impl MainWindowRecordingStartBehaviour {
    pub fn perform(&self, window: &tauri::WebviewWindow) -> tauri::Result<()> {
        match self {
            Self::Close => {
                // On Windows, hide() leaves the DirectComposition surface composited on screen as
                // a white ghost box. minimize() releases the surface without leaving an artifact.
                #[cfg(windows)]
                return window.minimize();
                #[cfg(not(windows))]
                window.hide()
            }
            Self::Minimise => window.minimize(),
        }
    }
}

// NOTE: Do not add "Cap Target Select" here — on Windows, WDA_EXCLUDEFROMCAPTURE applied to that
// hidden window causes it to reappear as a ghost overlay after recording ends.
const DEFAULT_EXCLUDED_WINDOW_TITLES: &[&str] = &[
    "Cap",
    "Cap Settings",
    "Cap Recording Controls",
    "Cap Camera",
    "Cap Window Capture Occluder",
    "Cap Capture Area",
    "Cap Mode Selection",
    "Cap Recordings Overlay",
    "Cap Teleprompter",
];

pub fn default_excluded_windows() -> Vec<WindowExclusion> {
    DEFAULT_EXCLUDED_WINDOW_TITLES
        .iter()
        .map(|title| WindowExclusion {
            bundle_identifier: None,
            owner_name: None,
            window_title: Some((*title).to_string()),
        })
        .collect()
}

fn append_missing_default_excluded_windows(excluded_windows: &mut Vec<WindowExclusion>) -> bool {
    let mut changed = false;

    for default in default_excluded_windows() {
        if !excluded_windows.contains(&default) {
            excluded_windows.push(default);
            changed = true;
        }
    }

    changed
}

// When adding fields here, #[serde(default)] defines the value to use for existing configurations,
// and `Default::default` defines the value to use for new configurations.
// Things that affect the user experience should only be enabled by default for new configurations.
#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowPosition {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub display_id: Option<DisplayId>,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsStore {
    #[serde(default = "uuid::Uuid::new_v4")]
    pub instance_id: Uuid,
    #[serde(default)]
    pub upload_individual_files: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub auto_create_shareable_link: bool,
    #[serde(default = "default_true")]
    pub enable_notifications: bool,
    #[serde(default)]
    pub disable_auto_open_links: bool,
    #[serde(default = "default_true")]
    pub has_completed_startup: bool,
    #[serde(default)]
    pub theme: AppTheme,
    #[serde(default)]
    pub commercial_license: Option<CommercialLicense>,
    #[serde(default)]
    pub last_version: Option<String>,
    #[serde(default)]
    pub window_transparency: bool,
    #[serde(default)]
    pub post_studio_recording_behaviour: PostStudioRecordingBehaviour,
    #[serde(default)]
    pub main_window_recording_start_behaviour: MainWindowRecordingStartBehaviour,
    #[serde(
        default = "default_custom_cursor_capture",
        rename = "custom_cursor_capture2"
    )]
    pub custom_cursor_capture: bool,
    #[serde(default = "default_server_url")]
    pub server_url: String,
    #[serde(default)]
    pub recording_countdown: Option<u32>,
    #[serde(
        default = "default_enable_native_camera_preview",
        skip_serializing_if = "no"
    )]
    pub enable_native_camera_preview: bool,
    #[serde(default = "default_true")]
    pub auto_zoom_on_clicks: bool,
    #[serde(default = "default_capture_keyboard_events")]
    pub capture_keyboard_events: bool,
    #[serde(default)]
    pub post_deletion_behaviour: PostDeletionBehaviour,
    #[serde(default = "default_excluded_windows")]
    pub excluded_windows: Vec<WindowExclusion>,
    #[serde(default)]
    pub delete_instant_recordings_after_upload: bool,
    #[serde(default = "default_instant_mode_max_resolution")]
    pub instant_mode_max_resolution: u32,
    #[serde(default)]
    pub default_project_name_template: Option<String>,
    #[serde(default = "default_crash_recovery_recording")]
    pub crash_recovery_recording: bool,
    #[serde(default = "default_max_fps")]
    pub max_fps: u32,
    #[serde(default = "default_transcription_hints")]
    pub transcription_hints: Vec<String>,
    #[serde(default)]
    pub editor_preview_quality: EditorPreviewQuality,
    #[serde(default)]
    pub studio_recording_quality: StudioRecordingQuality,
    #[serde(default)]
    pub main_window_position: Option<WindowPosition>,
    #[serde(default)]
    pub camera_window_position: Option<WindowPosition>,
    #[serde(default)]
    pub camera_window_positions_by_monitor_name: BTreeMap<String, WindowPosition>,
    #[serde(default = "default_true")]
    pub has_completed_onboarding: bool,
    #[serde(default = "default_true")]
    pub enable_telemetry: bool,
    #[serde(default)]
    pub out_of_process_muxer: bool,
    #[serde(default)]
    pub recordings_path: Option<String>,
    /// Custom recordings folders that were used before; recordings left in
    /// them stay visible in the library. Most recent last.
    #[serde(default)]
    pub previous_recordings_paths: Vec<String>,
    /// App version at which camera background blur was disabled after a crash
    /// was attributed to the blur pipeline; `None` means blur is allowed.
    /// Cleared automatically when the app version changes (one retry per
    /// update, since a new ort/wgpu/driver stack may have fixed the crash).
    #[serde(default)]
    pub camera_blur_disabled_by_crash: Option<String>,
    #[serde(default)]
    pub update_channel: UpdateChannel,
}

fn default_enable_native_camera_preview() -> bool {
    false
}

fn no(_: &bool) -> bool {
    false
}

fn default_true() -> bool {
    true
}

fn default_instant_mode_max_resolution() -> u32 {
    cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION
}

fn default_max_fps() -> u32 {
    cap_recording::DEFAULT_STUDIO_MAX_FPS
}

fn default_custom_cursor_capture() -> bool {
    cap_recording::DEFAULT_CUSTOM_CURSOR_CAPTURE
}

fn default_capture_keyboard_events() -> bool {
    cap_recording::DEFAULT_CAPTURE_KEYBOARD_EVENTS
}

fn default_crash_recovery_recording() -> bool {
    cap_recording::DEFAULT_CRASH_RECOVERY_RECORDING
}

fn default_transcription_hints() -> Vec<String> {
    vec![
        "Cap".to_string(),
        "TypeScript".to_string(),
        "My Brand Name".to_string(),
        "mywebsite.com".to_string(),
    ]
}

fn default_server_url() -> String {
    std::option_env!("VITE_SERVER_URL")
        .unwrap_or("https://cap.so")
        .to_string()
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommercialLicense {
    license_key: String,
    expiry_date: Option<f64>,
    refresh: f64,
    activated_on: f64,
}

impl Default for GeneralSettingsStore {
    fn default() -> Self {
        Self {
            instance_id: uuid::Uuid::new_v4(),
            upload_individual_files: false,
            hide_dock_icon: false,
            auto_create_shareable_link: false,
            enable_notifications: true,
            disable_auto_open_links: false,
            has_completed_startup: false,
            theme: AppTheme::System,
            commercial_license: None,
            last_version: None,
            window_transparency: false,
            post_studio_recording_behaviour: PostStudioRecordingBehaviour::OpenEditor,
            main_window_recording_start_behaviour: MainWindowRecordingStartBehaviour::Close,
            custom_cursor_capture: cap_recording::DEFAULT_CUSTOM_CURSOR_CAPTURE,
            server_url: default_server_url(),
            recording_countdown: Some(3),
            enable_native_camera_preview: default_enable_native_camera_preview(),
            // Keep aligned with the field's serde `default_true`: auto zooms
            // are on by default, matching configs that never stored the key.
            auto_zoom_on_clicks: true,
            capture_keyboard_events: cap_recording::DEFAULT_CAPTURE_KEYBOARD_EVENTS,
            post_deletion_behaviour: PostDeletionBehaviour::DoNothing,
            excluded_windows: default_excluded_windows(),
            delete_instant_recordings_after_upload: false,
            instant_mode_max_resolution: cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION,
            default_project_name_template: None,
            crash_recovery_recording: cap_recording::DEFAULT_CRASH_RECOVERY_RECORDING,
            max_fps: cap_recording::DEFAULT_STUDIO_MAX_FPS,
            transcription_hints: default_transcription_hints(),
            editor_preview_quality: EditorPreviewQuality::Half,
            studio_recording_quality: default_studio_recording_quality(),
            main_window_position: None,
            camera_window_position: None,
            camera_window_positions_by_monitor_name: BTreeMap::new(),
            has_completed_onboarding: false,
            enable_telemetry: true,
            out_of_process_muxer: cap_recording::DEFAULT_OUT_OF_PROCESS_MUXER,
            recordings_path: None,
            previous_recordings_paths: Vec::new(),
            camera_blur_disabled_by_crash: None,
            update_channel: UpdateChannel::Stable,
        }
    }
}

#[derive(Default, Debug, Copy, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AppTheme {
    #[default]
    System,
    Light,
    Dark,
}

impl GeneralSettingsStore {
    pub fn recordings_dir(app: &AppHandle<Wry>) -> std::path::PathBuf {
        let custom = Self::get(app)
            .map_err(|e| tracing::warn!("Failed to read general settings for recordings_dir: {e}"))
            .ok()
            .flatten()
            .and_then(|s| s.recordings_path)
            .and_then(|p| {
                let path = std::path::PathBuf::from(&p);
                if path.is_absolute() { Some(path) } else { None }
            });

        // A custom folder can become unavailable (unplugged drive, deleted
        // path). Recording must keep working, so fall back to the default
        // location instead of failing; the library lists recordings from
        // every known folder, so nothing goes missing when this happens.
        if let Some(path) = custom {
            match std::fs::create_dir_all(&path) {
                Ok(()) => return path,
                Err(e) => {
                    tracing::warn!(
                        ?path, %e,
                        "Custom recordings directory unavailable; falling back to default"
                    );
                }
            }
        }

        let path = app.path().app_data_dir().unwrap().join("recordings");
        if let Err(e) = std::fs::create_dir_all(&path) {
            tracing::warn!(?path, %e, "Failed to create recordings directory");
        }
        path
    }

    // The effective value: the native preview is macOS-only; it is not
    // reliable on Windows, so the stored setting is ignored there and the
    // websocket preview is always used.
    pub fn native_camera_preview_enabled(app: &AppHandle<Wry>) -> bool {
        if cfg!(not(target_os = "macos")) {
            return false;
        }
        Self::get(app)
            .ok()
            .flatten()
            .map(|settings| settings.enable_native_camera_preview)
            .unwrap_or_else(default_enable_native_camera_preview)
    }

    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get("general_settings")) {
            Ok(Some(store)) => {
                // Handle potential deserialization errors gracefully
                match serde_json::from_value(store) {
                    Ok(settings) => Ok(Some(settings)),
                    Err(e) => Err(format!("Failed to deserialize general settings store: {e}")),
                }
            }
            _ => Ok(None),
        }
    }

    // i don't trust anyone to not overwrite the whole store lols
    pub fn update(app: &AppHandle, update: impl FnOnce(&mut Self)) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        let mut settings = Self::get(app)?.unwrap_or_default();
        update(&mut settings);
        store.set("general_settings", json!(settings));
        store.save().map_err(|e| e.to_string())?;

        crate::posthog::set_telemetry_enabled(settings.enable_telemetry);

        #[cfg(target_os = "macos")]
        crate::permissions::sync_macos_dock_visibility(app);

        Ok(())
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("general_settings", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
struct StoreChangePayload {
    key: String,
}

#[cfg(target_os = "macos")]
fn sync_dock_visibility_on_general_settings_change(app: &AppHandle) {
    let app_for_listener = app.clone();
    app.listen("store://change", move |event| {
        let Ok(payload) = serde_json::from_str::<StoreChangePayload>(event.payload()) else {
            return;
        };

        if payload.key == "general_settings" {
            crate::permissions::schedule_macos_dock_visibility_sync(&app_for_listener);
        }
    });
}

pub fn init(app: &AppHandle) {
    println!("Initializing GeneralSettingsStore");

    let mut store = match GeneralSettingsStore::get(app) {
        Ok(Some(store)) => store,
        Ok(None) => GeneralSettingsStore::default(),
        Err(e) => {
            error!("Failed to deserialize general settings store: {}", e);
            GeneralSettingsStore::default()
        }
    };

    append_missing_default_excluded_windows(&mut store.excluded_windows);

    const REMOVE_TARGET_SELECT_MIGRATION_KEY: &str = "remove_cap_target_select_exclusion_v1";
    if let Ok(raw_store) = app.store("store")
        && raw_store.get(REMOVE_TARGET_SELECT_MIGRATION_KEY).is_none()
    {
        store
            .excluded_windows
            .retain(|w| w.window_title.as_deref() != Some("Cap Target Select"));
        raw_store.set(REMOVE_TARGET_SELECT_MIGRATION_KEY, json!(true));
    }

    crate::posthog::set_telemetry_enabled(store.enable_telemetry);
    register_bundled_muxer_binary(app);

    #[cfg(target_os = "macos")]
    {
        const NATIVE_PREVIEW_MIGRATION_KEY: &str = "native_camera_preview_default_rollback_v1";
        if let Ok(raw_store) = app.store("store")
            && raw_store.get(NATIVE_PREVIEW_MIGRATION_KEY).is_none()
        {
            store.enable_native_camera_preview = false;
            raw_store.set(NATIVE_PREVIEW_MIGRATION_KEY, json!(true));
        }
    }

    if let Err(e) = store.save(app) {
        error!("Failed to save general settings: {}", e);
    }

    #[cfg(target_os = "macos")]
    sync_dock_visibility_on_general_settings_change(app);

    #[cfg(target_os = "macos")]
    crate::permissions::sync_macos_dock_visibility(app);

    println!("GeneralSettingsState managed");
}

fn register_bundled_muxer_binary(_app: &AppHandle) {
    if std::env::var_os(cap_recording::oop_muxer::ENV_BIN_PATH).is_some() {
        return;
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join(bundled_muxer_bin_name());
        if candidate.is_file() {
            match cap_recording::oop_muxer::set_muxer_binary_override(candidate.clone()) {
                Ok(()) => {
                    tracing::info!(
                        path = %candidate.display(),
                        "Registered executable-adjacent cap-muxer binary for out-of-process muxer"
                    );
                }
                Err(existing) => {
                    tracing::debug!(
                        existing = %existing.display(),
                        candidate = %candidate.display(),
                        "cap-muxer override already registered; keeping existing"
                    );
                }
            }
        }
    }
}

fn bundled_muxer_bin_name() -> &'static str {
    if cfg!(windows) {
        "cap-muxer.exe"
    } else {
        "cap-muxer"
    }
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub fn get_default_excluded_windows() -> Vec<WindowExclusion> {
    default_excluded_windows()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title_exclusion(title: &str) -> WindowExclusion {
        WindowExclusion {
            bundle_identifier: None,
            owner_name: None,
            window_title: Some(title.to_string()),
        }
    }

    #[test]
    fn appends_missing_default_excluded_windows() {
        let mut excluded_windows = vec![
            title_exclusion("Cap"),
            WindowExclusion {
                bundle_identifier: None,
                owner_name: Some("Preview".to_string()),
                window_title: Some("Private Preview".to_string()),
            },
        ];

        let changed = append_missing_default_excluded_windows(&mut excluded_windows);

        assert!(changed);
        assert!(
            default_excluded_windows()
                .iter()
                .all(|default| excluded_windows.contains(default))
        );
        assert!(excluded_windows.iter().any(|entry| {
            entry.owner_name.as_deref() == Some("Preview")
                && entry.window_title.as_deref() == Some("Private Preview")
        }));
    }

    #[test]
    fn does_not_duplicate_default_excluded_windows() {
        let mut excluded_windows = default_excluded_windows();
        let len = excluded_windows.len();

        let changed = append_missing_default_excluded_windows(&mut excluded_windows);

        assert!(!changed);
        assert_eq!(excluded_windows.len(), len);
    }
}
