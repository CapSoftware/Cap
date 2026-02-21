use crate::window_exclusion::WindowExclusion;
use scap_targets::DisplayId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::collections::BTreeMap;
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
    pub disable_update_checks: bool,
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
    #[serde(default = "default_true", rename = "custom_cursor_capture2")]
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
    #[serde(default)]
    pub auto_zoom_on_clicks: bool,
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
    #[serde(default = "default_true")]
    pub crash_recovery_recording: bool,
    #[serde(default = "default_max_fps")]
    pub max_fps: u32,
    #[serde(default)]
    pub editor_preview_quality: EditorPreviewQuality,
    #[serde(default)]
    pub main_window_position: Option<WindowPosition>,
    #[serde(default)]
    pub camera_window_position: Option<WindowPosition>,
    #[serde(default)]
    pub camera_window_positions_by_monitor_name: BTreeMap<String, WindowPosition>,
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
    1920
}

fn default_max_fps() -> u32 {
    60
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
            disable_update_checks: false,
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
            custom_cursor_capture: true,
            server_url: default_server_url(),
            recording_countdown: Some(3),
            enable_native_camera_preview: default_enable_native_camera_preview(),
            auto_zoom_on_clicks: false,
            post_deletion_behaviour: PostDeletionBehaviour::DoNothing,
            excluded_windows: default_excluded_windows(),
            delete_instant_recordings_after_upload: false,
            instant_mode_max_resolution: 1920,
            default_project_name_template: None,
            crash_recovery_recording: true,
            max_fps: 60,
            editor_preview_quality: EditorPreviewQuality::Half,
            main_window_position: None,
            camera_window_position: None,
            camera_window_positions_by_monitor_name: BTreeMap::new(),
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
        store.save().map_err(|e| e.to_string())
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("general_settings", json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

pub fn init(app: &AppHandle) {
    println!("Initializing GeneralSettingsStore");

    let store = match GeneralSettingsStore::get(app) {
        Ok(Some(store)) => store,
        Ok(None) => GeneralSettingsStore::default(),
        Err(e) => {
            error!("Failed to deserialize general settings store: {}", e);
            GeneralSettingsStore::default()
        }
    };

    if let Err(e) = store.save(app) {
        error!("Failed to save general settings: {}", e);
    }

    println!("GeneralSettingsState managed");
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub fn get_default_excluded_windows() -> Vec<WindowExclusion> {
    default_excluded_windows()
}
