//! Persisted state: this app's own, and the Tauri app's settings store.
//!
//! Two files, both inside `so.cap.desktop`'s app-data dir:
//!
//! - `gpui-state.json` -- ours. The Tauri app keeps the camera window's chrome
//!   state in the webview's `localStorage` (`cameraWindowState`); there is no
//!   webview here, so the same shape lives in a file. Reads happen once at
//!   open; writes are whole-file rewrites on a background thread -- the state
//!   is a handful of scalars, atomicity beyond rename is not worth plumbing.
//! - `store` -- the tauri-plugin-store file the shipping app loads
//!   (`Store.load("store")` in `apps/desktop/src/store.ts`), holding
//!   `general_settings`, `recording_start_safety`, `auth`, `presets` and the
//!   rest. Both apps read and write it, so every write here is a
//!   read-modify-write on the raw JSON that touches exactly one key: see
//!   [`set_store_setting`].

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `CameraPreviewShape` in the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CameraShape {
    #[default]
    Round,
    Square,
    Full,
}

/// `BackgroundBlurMode`. Cycled and persisted for parity; the effects pipeline
/// itself is not wired yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlurMode {
    #[default]
    Off,
    Light,
    Heavy,
}

impl BlurMode {
    pub fn cycle(self) -> Self {
        match self {
            Self::Off => Self::Light,
            Self::Light => Self::Heavy,
            Self::Heavy => Self::Off,
        }
    }

    /// The tiny label under the person glyph: `Light` / `Heavy`, nothing when
    /// off.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Light => Some("Light"),
            Self::Heavy => Some("Heavy"),
        }
    }
}

/// `CameraWindowState` from `CameraPreviewChrome.tsx`, minus `mirrored` (no
/// flip transform exists in this gpui rev; see README).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CameraWindowState {
    pub size: f32,
    pub shape: CameraShape,
    pub mirrored: bool,
    pub background_blur: BlurMode,
}

impl Default for CameraWindowState {
    fn default() -> Self {
        Self {
            size: crate::camera_window::CAMERA_DEFAULT_SIZE,
            shape: CameraShape::Round,
            mirrored: false,
            background_blur: BlurMode::Off,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedState {
    pub camera_window: Option<CameraWindowState>,
}

/// `so.cap.desktop`'s app-data dir -- where both stores live.
pub fn app_data_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join("Library/Application Support/so.cap.desktop")
}

fn state_path() -> PathBuf {
    app_data_dir().join("gpui-state.json")
}

pub fn load() -> PersistedState {
    std::fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Read-modify-write on the caller's thread; callers hand this to the
/// background executor.
pub fn update(mutate: impl FnOnce(&mut PersistedState)) {
    let path = state_path();
    let mut state = load();
    mutate(&mut state);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec_pretty(&state) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&path, bytes) {
                tracing::warn!("persisting gpui state: {error}");
            }
        }
        Err(error) => tracing::warn!("serializing gpui state: {error}"),
    }
}

// ---------------------------------------------------------------------------
// The Tauri settings store
// ---------------------------------------------------------------------------

/// The tauri-plugin-store file, shared with the shipping app.
///
/// `CAP_GPUI_TAURI_STORE` redirects it at a copy, which is how the tests --
/// and any verification run that must not touch the user's real settings --
/// work.
pub fn tauri_store_path() -> PathBuf {
    match std::env::var("CAP_GPUI_TAURI_STORE") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        // `Store.load("store")`: no extension, and the sibling `store.json`
        // is a different (stale) file.
        _ => app_data_dir().join("store"),
    }
}

/// The whole store as raw JSON.
///
/// A missing file is an empty store. A file that exists but does not parse is
/// *not*: it is returned as `None` so no write path can silently replace
/// someone's settings with a fresh object.
fn read_store(path: &std::path::Path) -> Option<Map<String, Value>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Map::new()),
        Err(error) => {
            tracing::warn!("reading the Tauri store: {error}");
            return None;
        }
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Some(map),
        Ok(_) => {
            tracing::error!("the Tauri store is not a JSON object; refusing to write to it");
            None
        }
        Err(error) => {
            tracing::error!("the Tauri store did not parse ({error}); refusing to write to it");
            None
        }
    }
}

/// One section of the store (`general_settings`, `recording_start_safety`,
/// ...) as raw JSON. Empty when absent or the wrong shape.
pub fn store_section(section: &str) -> Map<String, Value> {
    read_store(&tauri_store_path())
        .and_then(|mut store| store.remove(section))
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Write one key of one section, preserving every other byte of meaning in
/// the file.
///
/// This is the whole compatibility contract with the Tauri app. It reads the
/// raw JSON, replaces exactly `store[section][key]`, and writes it back, so
/// keys this app has never heard of -- everything under `auth`, `presets`,
/// `teleprompter`, the migration flags, and the two thirds of
/// `general_settings` no page here renders -- survive untouched. Serializing
/// a typed struct back over the file would drop them all.
///
/// Returns false when the store could not be read or written; the caller has
/// already updated its in-memory copy, which is the same optimistic order
/// `handleChange` uses in `general.tsx`.
pub fn set_store_setting(section: &str, key: &str, value: Value) -> bool {
    let path = tauri_store_path();
    let Some(mut store) = read_store(&path) else {
        return false;
    };

    let entry = store
        .entry(section.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry
        .as_object_mut()
        .expect("just replaced any non-object with an object")
        .insert(key.to_string(), value);

    write_store(&path, &Value::Object(store))
}

/// Pretty JSON, two-space indent, no trailing newline -- byte-shape identical
/// to what tauri-plugin-store writes, so a store the two apps take turns on
/// does not churn.
///
/// Written to a sibling temp file and renamed, so a crash mid-write cannot
/// leave a half-written store behind (the Tauri app would refuse to parse it,
/// and the user would lose every setting).
fn write_store(path: &std::path::Path, store: &Value) -> bool {
    let bytes = match serde_json::to_vec_pretty(store) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!("serializing the Tauri store: {error}");
            return false;
        }
    };

    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        tracing::warn!("creating the store directory: {error}");
        return false;
    }

    let temp = path.with_extension("gpui-tmp");
    if let Err(error) = std::fs::write(&temp, bytes) {
        tracing::warn!("writing the Tauri store: {error}");
        return false;
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        tracing::warn!("replacing the Tauri store: {error}");
        let _ = std::fs::remove_file(&temp);
        return false;
    }
    true
}

// -- Typed reads ------------------------------------------------------------
//
// Field by field rather than `serde::Deserialize` on a struct: one setting
// written by a newer Tauri build with a value this enum does not know would
// fail a whole-struct deserialize and blank the entire page. Here it falls
// back to its default and every other row still shows the user's real value.

fn bool_at(map: &Map<String, Value>, key: &str, default: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn u32_at(map: &Map<String, Value>, key: &str, default: u32) -> u32 {
    map.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(default)
}

fn opt_u32_at(map: &Map<String, Value>, key: &str) -> Option<u32> {
    map.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as u32)
}

fn opt_f32_at(map: &Map<String, Value>, key: &str) -> Option<f32> {
    map.get(key)
        .and_then(Value::as_f64)
        .map(|value| value as f32)
}

fn f32_at(map: &Map<String, Value>, key: &str, default: f32) -> f32 {
    opt_f32_at(map, key).unwrap_or(default)
}

fn opt_string_at(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn string_at(map: &Map<String, Value>, key: &str, default: &str) -> String {
    opt_string_at(map, key).unwrap_or_else(|| default.to_string())
}

fn enum_at<T: SettingsEnum>(map: &Map<String, Value>, key: &str) -> T {
    map.get(key)
        .and_then(Value::as_str)
        .and_then(T::from_json)
        .unwrap_or_default()
}

/// A string-valued setting with a fixed option list -- the shape every
/// `#[serde(rename_all = "camelCase")]` enum in
/// `apps/desktop/src-tauri/src/general_settings.rs` serializes to.
pub trait SettingsEnum: Sized + Default + Copy + PartialEq + 'static {
    const ALL: &'static [Self];
    fn from_json(value: &str) -> Option<Self>;
    fn as_json(self) -> &'static str;
    /// The option's text in the settings UI, which is not derivable from the
    /// JSON name ("openEditor" is shown as "Open editor").
    fn label(self) -> &'static str;
}

macro_rules! settings_enum {
    (
        $(#[$meta:meta])*
        $name:ident {
            $($variant:ident = $json:literal, $label:literal;)+
        }
        default = $default:ident
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant,)+
        }

        impl Default for $name {
            fn default() -> Self {
                Self::$default
            }
        }

        impl SettingsEnum for $name {
            const ALL: &'static [Self] = &[$(Self::$variant,)+];

            fn from_json(value: &str) -> Option<Self> {
                match value {
                    $($json => Some(Self::$variant),)+
                    _ => None,
                }
            }

            fn as_json(self) -> &'static str {
                match self {
                    $(Self::$variant => $json,)+
                }
            }

            fn label(self) -> &'static str {
                match self {
                    $(Self::$variant => $label,)+
                }
            }
        }
    };
}

settings_enum! {
    /// `AppTheme`. The previews are labelled System/Light/Dark in
    /// `AppearanceSection`.
    AppTheme {
        System = "system", "System";
        Light = "light", "Light";
        Dark = "dark", "Dark";
    }
    default = System
}

settings_enum! {
    /// `StudioRecordingQuality`, whose Rust default is `balanced`.
    StudioQuality {
        Compatibility = "compatibility", "Compatibility";
        Balanced = "balanced", "Balanced";
        Ultra = "ultra", "Ultra";
    }
    default = Balanced
}

settings_enum! {
    /// `MainWindowRecordingStartBehaviour`. British spelling in both the JSON
    /// and the label, as shipped.
    MainWindowStartBehaviour {
        Close = "close", "Close";
        Minimise = "minimise", "Minimise";
    }
    default = Close
}

settings_enum! {
    /// `PostStudioRecordingBehaviour`.
    PostStudioBehaviour {
        OpenEditor = "openEditor", "Open editor";
        ShowOverlay = "showOverlay", "Show in overlay";
    }
    default = OpenEditor
}

settings_enum! {
    /// `PostDeletionBehaviour`.
    PostDeletionBehaviour {
        DoNothing = "doNothing", "Do nothing";
        ReopenRecordingWindow = "reopenRecordingWindow", "Reopen recording window";
    }
    default = DoNothing
}

settings_enum! {
    /// `UpdateChannel` from `src-tauri/src/updates.rs`.
    UpdateChannel {
        Stable = "stable", "Stable";
        Nightly = "nightly", "Nightly";
    }
    default = Stable
}

/// One entry of `general_settings.excludedWindows` (`WindowExclusion`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowExclusion {
    pub bundle_identifier: Option<String>,
    pub owner_name: Option<String>,
    pub window_title: Option<String>,
}

impl WindowExclusion {
    fn from_json(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let exclusion = Self {
            bundle_identifier: opt_string_at(map, "bundleIdentifier"),
            owner_name: opt_string_at(map, "ownerName"),
            window_title: opt_string_at(map, "windowTitle"),
        };
        (exclusion != Self::default()).then_some(exclusion)
    }

    fn to_json(&self) -> Value {
        let field = |value: &Option<String>| match value {
            Some(value) => Value::String(value.clone()),
            None => Value::Null,
        };
        Value::Object(Map::from_iter([
            (
                "bundleIdentifier".to_string(),
                field(&self.bundle_identifier),
            ),
            ("ownerName".to_string(), field(&self.owner_name)),
            ("windowTitle".to_string(), field(&self.window_title)),
        ]))
    }

    /// `getExclusionPrimaryLabel` in `general.tsx`.
    pub fn primary_label(&self) -> &str {
        self.owner_name
            .as_deref()
            .or(self.window_title.as_deref())
            .or(self.bundle_identifier.as_deref())
            .unwrap_or("Unknown")
    }

    /// `getExclusionSecondaryLabel`.
    pub fn secondary_label(&self) -> Option<&str> {
        if self.owner_name.is_some() && self.window_title.is_some() {
            return self.window_title.as_deref();
        }
        if self.bundle_identifier.is_some()
            && (self.owner_name.is_some() || self.window_title.is_some())
        {
            return self.bundle_identifier.as_deref();
        }
        self.bundle_identifier.as_deref()
    }
}

/// `DEFAULT_EXCLUDED_WINDOW_TITLES` in `general_settings.rs`, which is what
/// the page's Reset button asks the backend for.
pub const DEFAULT_EXCLUDED_WINDOW_TITLES: &[&str] = &[
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

pub fn excluded_windows_to_json(windows: &[WindowExclusion]) -> Value {
    Value::Array(windows.iter().map(WindowExclusion::to_json).collect())
}

/// `https://cap.so` -- `default_server_url()` in `general_settings.rs`, which
/// is also what `clientEnv.VITE_SERVER_URL` resolves to in a release build.
pub const DEFAULT_SERVER_URL: &str = "https://cap.so";

/// `DEFAULT_FILENAME_TEMPLATE` in `src-tauri/src/recording.rs`, spelled the
/// same way `general.tsx` spells it.
pub const DEFAULT_PROJECT_NAME_TEMPLATE: &str = "{target_name} ({target_kind}) {date} {time}";

/// The `general_settings` section, as the General page reads it.
///
/// The defaults are `createDefaultGeneralSettings()` plus the per-row `??`
/// fallbacks in `general.tsx` -- i.e. what the shipping page *shows* for a key
/// that is not in the file. Two of them disagree with the Rust struct's own
/// `#[serde(default)]`: `autoZoomOnClicks` (Rust `default_true`, the page
/// false) and `enableNativeCameraPreview`. The page is the authority here
/// because this is a page.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneralSettings {
    pub theme: AppTheme,
    pub hide_dock_icon: bool,
    pub enable_notifications: bool,
    pub instant_mode_max_resolution: u32,
    pub disable_auto_open_links: bool,
    pub studio_recording_quality: StudioQuality,
    pub recording_countdown: Option<u32>,
    pub main_window_recording_start_behaviour: MainWindowStartBehaviour,
    pub post_studio_recording_behaviour: PostStudioBehaviour,
    pub post_deletion_behaviour: PostDeletionBehaviour,
    pub delete_instant_recordings_after_upload: bool,
    pub crash_recovery_recording: bool,
    pub custom_cursor_capture: bool,
    pub auto_zoom_on_clicks: bool,
    pub default_zoom_amount: Option<f32>,
    pub capture_keyboard_events: bool,
    pub macbook_notch_overlay: bool,
    pub max_fps: u32,
    pub recordings_path: Option<String>,
    pub default_project_name_template: Option<String>,
    pub excluded_windows: Vec<WindowExclusion>,
    pub update_channel: UpdateChannel,
    pub server_url: String,
    pub enable_telemetry: bool,
    /// Not part of `general_settings` at all: the mic-confirmation toggle
    /// lives in the store's own `recording_start_safety` section
    /// (`RECORDING_START_SAFETY_DEFAULTS`), and the page renders it in the
    /// middle of the Recording card as if it were one of them.
    pub confirm_without_microphone: bool,
}

/// The section names, so the write calls read as the store keys they are.
pub const GENERAL_SETTINGS: &str = "general_settings";
pub const RECORDING_START_SAFETY: &str = "recording_start_safety";

impl Default for GeneralSettings {
    fn default() -> Self {
        Self::from_sections(&Map::new(), &Map::new())
    }
}

impl GeneralSettings {
    pub fn load() -> Self {
        Self::from_sections(
            &store_section(GENERAL_SETTINGS),
            &store_section(RECORDING_START_SAFETY),
        )
    }

    fn from_sections(general: &Map<String, Value>, safety: &Map<String, Value>) -> Self {
        Self {
            theme: enum_at(general, "theme"),
            hide_dock_icon: bool_at(general, "hideDockIcon", false),
            enable_notifications: bool_at(general, "enableNotifications", true),
            instant_mode_max_resolution: u32_at(general, "instantModeMaxResolution", 1920),
            disable_auto_open_links: bool_at(general, "disableAutoOpenLinks", false),
            studio_recording_quality: enum_at(general, "studioRecordingQuality"),
            recording_countdown: opt_u32_at(general, "recordingCountdown"),
            main_window_recording_start_behaviour: enum_at(
                general,
                "mainWindowRecordingStartBehaviour",
            ),
            post_studio_recording_behaviour: enum_at(general, "postStudioRecordingBehaviour"),
            post_deletion_behaviour: enum_at(general, "postDeletionBehaviour"),
            delete_instant_recordings_after_upload: bool_at(
                general,
                "deleteInstantRecordingsAfterUpload",
                false,
            ),
            crash_recovery_recording: bool_at(general, "crashRecoveryRecording", true),
            // The one snake_case key in the store: `#[serde(rename =
            // "custom_cursor_capture2")]` on `custom_cursor_capture`, which
            // is how the setting was re-defaulted without inheriting the old
            // key's values.
            custom_cursor_capture: bool_at(general, "custom_cursor_capture2", true),
            auto_zoom_on_clicks: bool_at(general, "autoZoomOnClicks", false),
            default_zoom_amount: opt_f32_at(general, "defaultZoomAmount"),
            capture_keyboard_events: bool_at(general, "captureKeyboardEvents", true),
            macbook_notch_overlay: bool_at(general, "macbookNotchOverlay", false),
            max_fps: u32_at(general, "maxFps", 60),
            recordings_path: opt_string_at(general, "recordingsPath"),
            default_project_name_template: opt_string_at(general, "defaultProjectNameTemplate"),
            excluded_windows: general
                .get("excludedWindows")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(WindowExclusion::from_json)
                        .collect()
                })
                .unwrap_or_default(),
            update_channel: enum_at(general, "updateChannel"),
            server_url: string_at(general, "serverUrl", DEFAULT_SERVER_URL),
            enable_telemetry: bool_at(general, "enableTelemetry", true),
            confirm_without_microphone: bool_at(
                safety,
                "confirmBeforeRecordingWithoutMicrophone",
                true,
            ),
        }
    }
}

// -- The teleprompter section -----------------------------------------------

/// `teleprompterStore`'s key in the shared store file:
/// `declareStore<TeleprompterStore>("teleprompter")` in
/// `apps/desktop/src/store.ts`. A top-level section of its own, like
/// `general_settings`, not a key inside one.
pub const TELEPROMPTER: &str = "teleprompter";

/// `TeleprompterStore` (`store.ts:17-35`), with `teleprompterDefaults` as the
/// defaults: `{ script: "", fontSize: 30, wordsPerMinute: 150, lineHeight: 1.5,
/// showCueMarkers: true, mirror: false, windowOpacityPercent: 92 }`.
///
/// Read field by field for the same reason `GeneralSettings` is: a value
/// written by a newer build that this app cannot parse costs that one field its
/// value, not the whole script.
#[derive(Debug, Clone, PartialEq)]
pub struct TeleprompterState {
    pub script: String,
    pub font_size: f32,
    pub words_per_minute: u32,
    pub line_height: f32,
    pub show_cue_markers: bool,
    pub mirror: bool,
    pub window_opacity_percent: u32,
}

impl TeleprompterState {
    /// The store keys, so a write call reads as the key it writes.
    pub const SCRIPT: &'static str = "script";
    pub const FONT_SIZE: &'static str = "fontSize";
    pub const WORDS_PER_MINUTE: &'static str = "wordsPerMinute";
    pub const LINE_HEIGHT: &'static str = "lineHeight";
    pub const SHOW_CUE_MARKERS: &'static str = "showCueMarkers";
    pub const MIRROR: &'static str = "mirror";
    pub const WINDOW_OPACITY_PERCENT: &'static str = "windowOpacityPercent";

    pub fn load() -> Self {
        Self::from_section(&store_section(TELEPROMPTER))
    }

    fn from_section(map: &Map<String, Value>) -> Self {
        let defaults = Self::default();
        Self {
            script: opt_string_at(map, Self::SCRIPT).unwrap_or(defaults.script),
            font_size: f32_at(map, Self::FONT_SIZE, defaults.font_size),
            words_per_minute: u32_at(map, Self::WORDS_PER_MINUTE, defaults.words_per_minute),
            line_height: f32_at(map, Self::LINE_HEIGHT, defaults.line_height),
            show_cue_markers: bool_at(map, Self::SHOW_CUE_MARKERS, defaults.show_cue_markers),
            mirror: bool_at(map, Self::MIRROR, defaults.mirror),
            window_opacity_percent: u32_at(
                map,
                Self::WINDOW_OPACITY_PERCENT,
                defaults.window_opacity_percent,
            ),
        }
    }

    /// One field as the JSON the Tauri app would have written, so the debounced
    /// flush can write exactly the keys that changed.
    pub fn value_for(&self, key: &str) -> Value {
        match key {
            Self::SCRIPT => Value::from(self.script.clone()),
            Self::FONT_SIZE => Value::from(self.font_size),
            Self::WORDS_PER_MINUTE => Value::from(self.words_per_minute),
            Self::LINE_HEIGHT => Value::from(self.line_height),
            Self::SHOW_CUE_MARKERS => Value::Bool(self.show_cue_markers),
            Self::MIRROR => Value::Bool(self.mirror),
            Self::WINDOW_OPACITY_PERCENT => Value::from(self.window_opacity_percent),
            _ => Value::Null,
        }
    }
}

impl Default for TeleprompterState {
    fn default() -> Self {
        Self {
            script: String::new(),
            font_size: 30.,
            words_per_minute: 150,
            line_height: 1.5,
            show_cue_markers: true,
            mirror: false,
            window_opacity_percent: 92,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CAP_GPUI_TAURI_STORE` is process-global and `cargo test` runs these in
    /// parallel threads, so the redirect is held under a lock -- without it
    /// one test's store path is read by another's `load()`.
    static STORE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct TempStore(PathBuf, std::sync::MutexGuard<'static, ()>);

    impl TempStore {
        fn new(name: &str, contents: Option<&str>) -> Self {
            let guard = STORE_ENV.lock().unwrap_or_else(|error| error.into_inner());
            let path = std::env::temp_dir().join(format!("cap-gpui-store-test-{name}"));
            match contents {
                Some(contents) => std::fs::write(&path, contents).unwrap(),
                None => {
                    let _ = std::fs::remove_file(&path);
                }
            }
            // SAFETY: the guard above is the only writer of this var, and no
            // other thread in the test binary reads the environment.
            unsafe { std::env::set_var("CAP_GPUI_TAURI_STORE", &path) };
            Self(path, guard)
        }

        fn read(&self) -> Value {
            serde_json::from_slice(&std::fs::read(&self.0).unwrap()).unwrap()
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            unsafe { std::env::remove_var("CAP_GPUI_TAURI_STORE") };
        }
    }

    /// The compatibility contract: writing one setting must leave every key
    /// this app has never heard of exactly where it was -- other sections,
    /// other `general_settings` keys, and nested objects inside them.
    #[test]
    fn writing_one_setting_preserves_unknown_keys() {
        let store = TempStore::new(
            "unknown-keys",
            Some(
                r#"{
  "auth": { "secret": { "token": "keep-me" }, "user_id": "u_1" },
  "presets": { "presets": [], "default": 0 },
  "general_settings": {
    "hideDockIcon": false,
    "instanceId": "fe9cd6a0-fbb0-49b0-b321-5593cb3d4190",
    "cameraWindowPositionsByMonitorName": { "Built-in Retina Display": { "x": 1.0, "y": 2.0 } },
    "someSettingFromANewerBuild": [1, 2, 3]
  },
  "a_migration_flag_v1": true
}"#,
            ),
        );

        assert!(super::set_store_setting(
            GENERAL_SETTINGS,
            "hideDockIcon",
            Value::Bool(true)
        ));

        let after = store.read();
        // The touched key changed...
        assert_eq!(after["general_settings"]["hideDockIcon"], Value::Bool(true));
        // ...and nothing else did.
        assert_eq!(after["auth"]["secret"]["token"], "keep-me");
        assert_eq!(after["auth"]["user_id"], "u_1");
        assert_eq!(after["presets"]["default"], 0);
        assert_eq!(after["a_migration_flag_v1"], Value::Bool(true));
        assert_eq!(
            after["general_settings"]["instanceId"],
            "fe9cd6a0-fbb0-49b0-b321-5593cb3d4190"
        );
        assert_eq!(
            after["general_settings"]["cameraWindowPositionsByMonitorName"]["Built-in Retina Display"]
                ["x"],
            1.0
        );
        assert_eq!(
            after["general_settings"]["someSettingFromANewerBuild"],
            serde_json::json!([1, 2, 3])
        );

        // A second write against a store that already round-tripped once must
        // still see the first one -- i.e. the read half is reading what the
        // write half wrote.
        assert!(super::set_store_setting(
            RECORDING_START_SAFETY,
            "confirmBeforeRecordingWithoutMicrophone",
            Value::Bool(false)
        ));
        let settings = GeneralSettings::load();
        assert!(settings.hide_dock_icon);
        assert!(!settings.confirm_without_microphone);
        // The section it created did not disturb the others.
        assert_eq!(store.read()["auth"]["user_id"], "u_1");
    }

    /// A store that does not parse is someone's settings in a state we do not
    /// understand. Writing a fresh object over it would delete their auth
    /// token and every preset.
    #[test]
    fn a_corrupt_store_is_never_overwritten() {
        let store = TempStore::new("corrupt", Some("{ this is not json"));
        assert!(!super::set_store_setting(
            GENERAL_SETTINGS,
            "hideDockIcon",
            Value::Bool(true)
        ));
        assert_eq!(
            std::fs::read_to_string(&store.0).unwrap(),
            "{ this is not json"
        );
    }

    /// Every value the page can read back has to survive the round trip, and
    /// an unknown enum value must degrade to that one row's default rather
    /// than blanking the page.
    #[test]
    fn typed_reads_match_the_store_shape() {
        let _store = TempStore::new(
            "typed-reads",
            Some(
                r#"{
  "general_settings": {
    "theme": "dark",
    "studioRecordingQuality": "ultra",
    "postDeletionBehaviour": "somethingFromTheFuture",
    "recordingCountdown": 5,
    "custom_cursor_capture2": false,
    "defaultZoomAmount": 2.5,
    "maxFps": 120,
    "serverUrl": "https://cap.example.com",
    "excludedWindows": [{ "bundleIdentifier": null, "ownerName": null, "windowTitle": "Cap" }]
  }
}"#,
            ),
        );

        let settings = GeneralSettings::load();
        assert_eq!(settings.theme, AppTheme::Dark);
        assert_eq!(settings.studio_recording_quality, StudioQuality::Ultra);
        // Unknown value -> this row's default, everything else intact.
        assert_eq!(
            settings.post_deletion_behaviour,
            PostDeletionBehaviour::DoNothing
        );
        assert_eq!(settings.recording_countdown, Some(5));
        assert!(!settings.custom_cursor_capture);
        assert_eq!(settings.default_zoom_amount, Some(2.5));
        assert_eq!(settings.max_fps, 120);
        assert_eq!(settings.server_url, "https://cap.example.com");
        assert_eq!(settings.excluded_windows.len(), 1);
        assert_eq!(settings.excluded_windows[0].primary_label(), "Cap");
        // Absent keys take the page's defaults, not the struct's zero values.
        assert!(settings.enable_notifications);
        assert!(settings.crash_recovery_recording);
        assert!(settings.confirm_without_microphone);
        assert_eq!(settings.instant_mode_max_resolution, 1920);
    }

    /// The teleprompter's own section: defaults when absent, and a per-key
    /// write that leaves the rest of the section (and the rest of the store)
    /// alone -- the window writes only the fields the user touched.
    #[test]
    fn the_teleprompter_section_round_trips_per_key() {
        let store = TempStore::new(
            "teleprompter",
            Some(r#"{ "auth": { "user_id": "u_1" }, "teleprompter": { "script": "hello" } }"#),
        );

        let loaded = TeleprompterState::load();
        assert_eq!(loaded.script, "hello");
        // Everything the section does not carry takes `teleprompterDefaults`.
        assert_eq!(loaded.font_size, 30.);
        assert_eq!(loaded.words_per_minute, 150);
        assert_eq!(loaded.line_height, 1.5);
        assert!(loaded.show_cue_markers);
        assert!(!loaded.mirror);
        assert_eq!(loaded.window_opacity_percent, 92);

        let mut next = loaded.clone();
        next.script = "hello there".into();
        next.font_size = 34.;
        for key in [TeleprompterState::SCRIPT, TeleprompterState::FONT_SIZE] {
            assert!(super::set_store_setting(
                TELEPROMPTER,
                key,
                next.value_for(key)
            ));
        }

        let after = store.read();
        assert_eq!(after["teleprompter"]["script"], "hello there");
        assert_eq!(after["teleprompter"]["fontSize"], 34.0);
        // The two untouched keys were never written, and the rest of the store
        // is where it was.
        assert!(after["teleprompter"].get("mirror").is_none());
        assert_eq!(after["auth"]["user_id"], "u_1");

        let reloaded = TeleprompterState::load();
        assert_eq!(reloaded.script, "hello there");
        assert_eq!(reloaded.font_size, 34.);
        assert!(reloaded.show_cue_markers);
    }

    /// An absent store is an empty one -- a fresh install must not be a write
    /// failure, and the file appears on the first change.
    #[test]
    fn a_missing_store_is_created() {
        let _store = TempStore::new("missing", None);

        assert_eq!(GeneralSettings::load(), GeneralSettings::default());
        assert!(super::set_store_setting(
            GENERAL_SETTINGS,
            "enableTelemetry",
            Value::Bool(false)
        ));
        assert!(!GeneralSettings::load().enable_telemetry);
    }
}
