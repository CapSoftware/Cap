use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;
use tracing::error;
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

impl MainWindowRecordingStartBehaviour {
    pub fn perform(&self, window: &tauri::WebviewWindow) -> tauri::Result<()> {
        match self {
            Self::Close => window.close(),
            Self::Minimise => window.minimize(),
        }
    }
}

// When adding fields here, #[serde(default)] defines the value to use for existing configurations,
// and `Default::default` defines the value to use for new configurations.
// Things that affect the user experience should only be enabled by default for new configurations.
#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsStore {
    #[serde(default = "uuid::Uuid::new_v4")]
    pub instance_id: Uuid,
    #[serde(default)]
    pub upload_individual_files: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default = "true_b")]
    pub haptics_enabled: bool,
    #[serde(default)]
    pub auto_create_shareable_link: bool,
    #[serde(default = "true_b")]
    pub enable_notifications: bool,
    #[serde(default)]
    pub disable_auto_open_links: bool,
    // first launch: store won't exist so show startup
    #[serde(default = "true_b")]
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
    #[serde(default)]
    pub custom_cursor_capture: bool,
    #[serde(default = "default_server_url")]
    pub server_url: String,
    #[serde(default)]
    pub recording_countdown: Option<u32>,
    // #[deprecated = "can be removed when native camera preview is ready"]
    #[serde(
        default = "default_enable_native_camera_preview",
        skip_serializing_if = "no"
    )]
    pub enable_native_camera_preview: bool,
    #[serde(default)]
    pub auto_zoom_on_clicks: bool,
    // #[deprecated = "can be removed when new recording flow is the default"]
    #[serde(
        default = "default_enable_new_recording_flow",
        skip_serializing_if = "no"
    )]
    pub enable_new_recording_flow: bool,
    #[serde(default)]
    pub post_deletion_behaviour: PostDeletionBehaviour,
}

fn default_enable_native_camera_preview() -> bool {
    // This will help us with testing it
    cfg!(all(debug_assertions, target_os = "macos"))
}

fn default_enable_new_recording_flow() -> bool {
    false
    // cfg!(debug_assertions)
}

fn no(_: &bool) -> bool {
    false
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
            haptics_enabled: true,
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
            custom_cursor_capture: false,
            server_url: default_server_url(),
            recording_countdown: Some(3),
            enable_native_camera_preview: default_enable_native_camera_preview(),
            auto_zoom_on_clicks: false,
            enable_new_recording_flow: default_enable_new_recording_flow(),
            post_deletion_behaviour: PostDeletionBehaviour::DoNothing,
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

fn true_b() -> bool {
    true
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

    store.save(app).unwrap();

    println!("GeneralSettingsState managed");
}
