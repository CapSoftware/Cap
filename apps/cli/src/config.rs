use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CliSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_zoom_on_clicks: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_keyboard_events: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_fps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_windows: Option<Vec<String>>,
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cap")
}

pub fn config_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load_cli_settings() -> CliSettings {
    let path = config_path();
    load_cli_settings_from(&path)
}

pub fn load_cli_settings_from(path: &Path) -> CliSettings {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => CliSettings::default(),
    }
}

pub fn save_cli_settings(settings: &CliSettings) -> Result<(), String> {
    let path = config_path();
    save_cli_settings_to(settings, &path)
}

pub fn save_cli_settings_to(settings: &CliSettings, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write config: {e}"))
}

fn tauri_store_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().map(|d| d.join("so.cap.desktop").join("store.json"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::config_dir().map(|d| d.join("so.cap.desktop").join("store.json"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        dirs::config_dir().map(|d| d.join("Cap").join("store.json"))
    }
}

pub fn load_tauri_settings() -> CliSettings {
    tauri_store_path()
        .and_then(|p| load_tauri_settings_from(&p))
        .unwrap_or_default()
}

pub fn load_tauri_settings_from(path: &Path) -> Option<CliSettings> {
    let contents = std::fs::read_to_string(path).ok()?;
    let store: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let general = store.get("general_settings")?;

    Some(CliSettings {
        auto_zoom_on_clicks: general.get("autoZoomOnClicks").and_then(|v| v.as_bool()),
        capture_keyboard_events: general
            .get("captureKeyboardEvents")
            .and_then(|v| v.as_bool()),
        max_fps: general
            .get("maxFps")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        excluded_windows: general.get("excludedWindows").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item.get("windowTitle")
                            .or_else(|| item.get("window_title"))
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
        }),
    })
}

const DEFAULT_EXCLUDED_WINDOWS: &[&str] = &[
    "Cap",
    "Cap Settings",
    "Cap Recording Controls",
    "Cap Camera",
];

#[derive(Debug, Clone)]
pub struct ResolvedSettings {
    pub auto_zoom_on_clicks: bool,
    pub capture_keyboard_events: bool,
    pub max_fps: u32,
    pub excluded_windows: Vec<String>,
}

impl ResolvedSettings {
    pub fn resolve(layers: &[&CliSettings]) -> Self {
        let mut auto_zoom: Option<bool> = None;
        let mut capture_keys: Option<bool> = None;
        let mut fps: Option<u32> = None;
        let mut excluded: Option<Vec<String>> = None;

        for layer in layers {
            if auto_zoom.is_none() {
                auto_zoom = layer.auto_zoom_on_clicks;
            }
            if capture_keys.is_none() {
                capture_keys = layer.capture_keyboard_events;
            }
            if fps.is_none() {
                fps = layer.max_fps;
            }
            if excluded.is_none() {
                excluded = layer.excluded_windows.clone();
            }
        }

        Self {
            auto_zoom_on_clicks: auto_zoom.unwrap_or(false),
            capture_keyboard_events: capture_keys.unwrap_or(true),
            max_fps: fps.unwrap_or(60),
            excluded_windows: excluded.unwrap_or_else(|| {
                DEFAULT_EXCLUDED_WINDOWS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            }),
        }
    }

    pub fn resolve_with_tauri(cli_flags: &CliSettings) -> Self {
        let cli_config = load_cli_settings();
        let tauri_config = load_tauri_settings();
        Self::resolve(&[cli_flags, &cli_config, &tauri_config])
    }
}

#[derive(Args)]
pub struct ConfigArgs {
    #[command(subcommand)]
    command: ConfigCommands,
}

#[derive(Subcommand)]
enum ConfigCommands {
    Get(ConfigGetArgs),
    Set(ConfigSetArgs),
}

#[derive(Args)]
struct ConfigGetArgs {
    #[arg(long)]
    json: Option<bool>,
}

#[derive(Args)]
struct ConfigSetArgs {
    #[arg(long)]
    auto_zoom: Option<bool>,
    #[arg(long)]
    capture_keys: Option<bool>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=240))]
    fps: Option<u32>,
    #[arg(long)]
    exclude_add: Vec<String>,
    #[arg(long)]
    exclude_remove: Vec<String>,
    #[arg(long)]
    exclude_reset: bool,
}

impl ConfigArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            ConfigCommands::Get(args) => config_get(args.json.unwrap_or(json)),
            ConfigCommands::Set(args) => config_set(args, json),
        }
    }
}

fn config_get(json: bool) -> Result<(), String> {
    let resolved = ResolvedSettings::resolve_with_tauri(&CliSettings::default());

    if json {
        let output = serde_json::json!({
            "auto_zoom_on_clicks": resolved.auto_zoom_on_clicks,
            "capture_keyboard_events": resolved.capture_keyboard_events,
            "max_fps": resolved.max_fps,
            "excluded_windows": resolved.excluded_windows,
            "config_path": config_path().display().to_string(),
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        eprintln!("Auto zoom on clicks:    {}", resolved.auto_zoom_on_clicks);
        eprintln!(
            "Capture keyboard:       {}",
            resolved.capture_keyboard_events
        );
        eprintln!("Max FPS:                {}", resolved.max_fps);
        eprintln!(
            "Excluded windows:       {}",
            if resolved.excluded_windows.is_empty() {
                "(none)".to_string()
            } else {
                resolved.excluded_windows.join(", ")
            }
        );
        eprintln!("\nConfig file: {}", config_path().display());
    }
    Ok(())
}

fn config_set(args: ConfigSetArgs, json: bool) -> Result<(), String> {
    let mut settings = load_cli_settings();

    if let Some(val) = args.auto_zoom {
        settings.auto_zoom_on_clicks = Some(val);
    }
    if let Some(val) = args.capture_keys {
        settings.capture_keyboard_events = Some(val);
    }
    if let Some(val) = args.fps {
        settings.max_fps = Some(val);
    }

    if args.exclude_reset {
        settings.excluded_windows = None;
    } else if !args.exclude_add.is_empty() || !args.exclude_remove.is_empty() {
        let mut current = settings.excluded_windows.clone().unwrap_or_else(|| {
            DEFAULT_EXCLUDED_WINDOWS
                .iter()
                .map(|s| s.to_string())
                .collect()
        });

        for window in &args.exclude_add {
            if !current.contains(window) {
                current.push(window.clone());
            }
        }

        for window in &args.exclude_remove {
            current.retain(|w| w != window);
        }

        settings.excluded_windows = Some(current);
    }

    save_cli_settings(&settings)?;

    if json {
        println!("{}", serde_json::json!({"status": "saved"}));
    } else {
        eprintln!("Settings saved to {}", config_path().display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_full_settings() {
        let dir = std::env::temp_dir().join("cap-test-config-rt");
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);

        let settings = CliSettings {
            auto_zoom_on_clicks: Some(true),
            capture_keyboard_events: Some(false),
            max_fps: Some(30),
            excluded_windows: Some(vec!["Terminal".to_string(), "Finder".to_string()]),
        };

        save_cli_settings_to(&settings, &path).unwrap();
        let loaded = load_cli_settings_from(&path);

        assert_eq!(loaded.auto_zoom_on_clicks, Some(true));
        assert_eq!(loaded.capture_keyboard_events, Some(false));
        assert_eq!(loaded.max_fps, Some(30));
        assert_eq!(
            loaded.excluded_windows,
            Some(vec!["Terminal".to_string(), "Finder".to_string()])
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_partial_settings() {
        let dir = std::env::temp_dir().join("cap-test-config-partial");
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);

        let settings = CliSettings {
            max_fps: Some(120),
            ..Default::default()
        };

        save_cli_settings_to(&settings, &path).unwrap();
        let loaded = load_cli_settings_from(&path);

        assert_eq!(loaded.auto_zoom_on_clicks, None);
        assert_eq!(loaded.max_fps, Some(120));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let loaded = load_cli_settings_from(Path::new("/tmp/cap-nonexistent-dir/settings.json"));
        assert_eq!(loaded.auto_zoom_on_clicks, None);
        assert_eq!(loaded.capture_keyboard_events, None);
        assert_eq!(loaded.max_fps, None);
        assert_eq!(loaded.excluded_windows, None);
    }

    #[test]
    fn load_malformed_json_returns_defaults() {
        let dir = std::env::temp_dir().join("cap-test-config-malformed");
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not valid json{{{").unwrap();

        let loaded = load_cli_settings_from(&path);
        assert_eq!(loaded.auto_zoom_on_clicks, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tauri_store_parses_general_settings() {
        let dir = std::env::temp_dir().join("cap-test-tauri-store");
        let path = dir.join("store.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store_json = r#"{
            "general_settings": {
                "autoZoomOnClicks": true,
                "captureKeyboardEvents": false,
                "maxFps": 30,
                "excludedWindows": [
                    {"windowTitle": "Cap", "ownerName": "Cap"},
                    {"windowTitle": "Terminal", "ownerName": "Terminal"}
                ]
            }
        }"#;
        std::fs::write(&path, store_json).unwrap();

        let settings = load_tauri_settings_from(&path).unwrap();
        assert_eq!(settings.auto_zoom_on_clicks, Some(true));
        assert_eq!(settings.capture_keyboard_events, Some(false));
        assert_eq!(settings.max_fps, Some(30));
        assert_eq!(
            settings.excluded_windows,
            Some(vec!["Cap".to_string(), "Terminal".to_string()])
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tauri_store_missing_key_returns_none_fields() {
        let dir = std::env::temp_dir().join("cap-test-tauri-nokey");
        let path = dir.join("store.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"some_other_key": {}}"#).unwrap();

        let result = load_tauri_settings_from(&path);
        assert!(result.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tauri_store_missing_file_returns_none() {
        let result = load_tauri_settings_from(Path::new("/tmp/cap-no-such-store/store.json"));
        assert!(result.is_none());
    }

    #[test]
    fn resolver_cli_flags_win_over_config() {
        let flags = CliSettings {
            max_fps: Some(120),
            ..Default::default()
        };
        let config = CliSettings {
            max_fps: Some(30),
            auto_zoom_on_clicks: Some(true),
            ..Default::default()
        };

        let resolved = ResolvedSettings::resolve(&[&flags, &config]);
        assert_eq!(resolved.max_fps, 120);
        assert!(resolved.auto_zoom_on_clicks);
    }

    #[test]
    fn resolver_falls_through_to_defaults() {
        let empty = CliSettings::default();
        let resolved = ResolvedSettings::resolve(&[&empty]);
        assert!(!resolved.auto_zoom_on_clicks);
        assert!(resolved.capture_keyboard_events);
        assert_eq!(resolved.max_fps, 60);
        assert_eq!(resolved.excluded_windows.len(), 4);
        assert_eq!(resolved.excluded_windows[0], "Cap");
    }

    #[test]
    fn resolver_three_layers() {
        let flags = CliSettings {
            max_fps: Some(30),
            ..Default::default()
        };
        let cli_config = CliSettings {
            auto_zoom_on_clicks: Some(true),
            capture_keyboard_events: Some(false),
            ..Default::default()
        };
        let tauri = CliSettings {
            auto_zoom_on_clicks: Some(false),
            max_fps: Some(120),
            excluded_windows: Some(vec!["Firefox".to_string()]),
            ..Default::default()
        };

        let resolved = ResolvedSettings::resolve(&[&flags, &cli_config, &tauri]);
        assert_eq!(resolved.max_fps, 30);
        assert!(resolved.auto_zoom_on_clicks);
        assert!(!resolved.capture_keyboard_events);
        assert_eq!(resolved.excluded_windows, vec!["Firefox".to_string()]);
    }
}
