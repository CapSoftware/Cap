use crate::window_exclusion::WindowExclusion;
use scap_targets::DisplayId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf};
#[cfg(target_os = "macos")]
use tauri::Listener;
use tauri::{AppHandle, Wry};
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

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PostScreenshotCaptureBehaviour {
    #[default]
    OpenEditor,
    DoNothing,
    AskEveryTime,
    ShowOverlay,
    CopyToClipboard,
    CopyFilePath,
    CopyMarkdownImage,
    Save,
    SaveToFolder,
    RevealInFinder,
    Upload,
}

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotSaveDestination {
    #[default]
    Desktop,
    ChosenFolder,
    AppLibraryOnly,
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
            Self::Close => window.hide(),
            Self::Minimise => window.minimize(),
        }
    }
}

const DEFAULT_EXCLUDED_WINDOW_TITLES: &[&str] = &[
    "Cap",
    "Cap Settings",
    "Cap Recording Controls",
    "Cap Camera",
    "Cap Target Select",
    "Cap Window Capture Occluder",
    "Cap Capture Area",
    "Cap Mode Selection",
    "Cap Recordings Overlay",
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
    pub post_screenshot_capture_behaviour: PostScreenshotCaptureBehaviour,
    #[serde(default)]
    pub screenshot_save_destination: ScreenshotSaveDestination,
    #[serde(default)]
    pub screenshot_save_directory: Option<PathBuf>,
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
}

fn default_enable_native_camera_preview() -> bool {
    cfg!(all(debug_assertions, target_os = "macos"))
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
            post_screenshot_capture_behaviour: PostScreenshotCaptureBehaviour::OpenEditor,
            screenshot_save_destination: ScreenshotSaveDestination::Desktop,
            screenshot_save_directory: None,
            main_window_recording_start_behaviour: MainWindowRecordingStartBehaviour::Close,
            custom_cursor_capture: cap_recording::DEFAULT_CUSTOM_CURSOR_CAPTURE,
            server_url: default_server_url(),
            recording_countdown: Some(3),
            enable_native_camera_preview: default_enable_native_camera_preview(),
            auto_zoom_on_clicks: false,
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
    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get("general_settings")) {
            Ok(Some(store)) => {
                // Handle potential deserialization errors gracefully
                match serde_json::from_value::<Self>(store.clone()) {
                    Ok(mut settings) => {
                        settings.normalize_legacy_screenshot_settings(&store);
                        Ok(Some(settings))
                    }
                    Err(e) => Err(format!("Failed to deserialize general settings store: {e}")),
                }
            }
            _ => Ok(None),
        }
    }

    fn normalize_legacy_screenshot_settings(&mut self, store: &serde_json::Value) {
        let Some(post_capture_behaviour) = store
            .get("postScreenshotCaptureBehaviour")
            .and_then(|value| value.as_str())
        else {
            return;
        };

        let has_save_destination = store.get("screenshotSaveDestination").is_some();

        match post_capture_behaviour {
            "save" => {
                if !has_save_destination {
                    self.screenshot_save_destination = ScreenshotSaveDestination::Desktop;
                }
                self.post_screenshot_capture_behaviour = PostScreenshotCaptureBehaviour::DoNothing;
            }
            "saveToFolder" => {
                if !has_save_destination {
                    self.screenshot_save_destination = ScreenshotSaveDestination::ChosenFolder;
                }
                self.post_screenshot_capture_behaviour = PostScreenshotCaptureBehaviour::DoNothing;
            }
            _ => {}
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
    crate::posthog::set_telemetry_enabled(store.enable_telemetry);
    register_bundled_muxer_binary(app);

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

    #[test]
    fn normalizes_legacy_screenshot_save_to_desktop_destination() {
        let store = json!({
            "postScreenshotCaptureBehaviour": "save",
        });
        let mut settings: GeneralSettingsStore = serde_json::from_value(store.clone()).unwrap();

        settings.normalize_legacy_screenshot_settings(&store);

        assert_eq!(
            settings.post_screenshot_capture_behaviour,
            PostScreenshotCaptureBehaviour::DoNothing
        );
        assert_eq!(
            settings.screenshot_save_destination,
            ScreenshotSaveDestination::Desktop
        );
    }

    #[test]
    fn normalizes_legacy_screenshot_save_to_folder_destination() {
        let store = json!({
            "postScreenshotCaptureBehaviour": "saveToFolder",
        });
        let mut settings: GeneralSettingsStore = serde_json::from_value(store.clone()).unwrap();

        settings.normalize_legacy_screenshot_settings(&store);

        assert_eq!(
            settings.post_screenshot_capture_behaviour,
            PostScreenshotCaptureBehaviour::DoNothing
        );
        assert_eq!(
            settings.screenshot_save_destination,
            ScreenshotSaveDestination::ChosenFolder
        );
    }

    #[test]
    fn legacy_screenshot_save_normalization_preserves_existing_destination() {
        let store = json!({
            "postScreenshotCaptureBehaviour": "save",
            "screenshotSaveDestination": "appLibraryOnly",
        });
        let mut settings: GeneralSettingsStore = serde_json::from_value(store.clone()).unwrap();

        settings.normalize_legacy_screenshot_settings(&store);

        assert_eq!(
            settings.post_screenshot_capture_behaviour,
            PostScreenshotCaptureBehaviour::DoNothing
        );
        assert_eq!(
            settings.screenshot_save_destination,
            ScreenshotSaveDestination::AppLibraryOnly
        );
    }

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
