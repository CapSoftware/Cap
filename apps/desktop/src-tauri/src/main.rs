#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::Regex;
use sentry_tracing::EventFilter;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::vec;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTraySubmenu,
};
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::sync::{oneshot, Mutex};
use tracing::Level;
use tracing_subscriber::prelude::*;
use window_shadows::set_shadow;
use window_vibrancy::{apply_blur, apply_vibrancy, NSVisualEffectMaterial};

#[macro_use]
mod app;
mod media;
mod recording;
mod upload;
mod utils;

use app::commands::*;
use media::enumerate_audio_devices;
use recording::{start_dual_recording, stop_all_recordings, RecordingState};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};

use winit::monitor::{MonitorHandle, VideoMode};

fn main() {
    let _ = fix_path_env::fix();

    let context = tauri::generate_context!();
    let rolling_log = app::get_log_file(&context);
    let (log_writer, _log_guard) = tracing_appender::non_blocking(rolling_log);

    let sentry_guard = sentry::init(sentry::ClientOptions {
        dsn: app::config::sentry_dsn(),
        release: sentry::release_name!(),
        ..Default::default()
    });
    let maybe_sentry_subscriber =
        sentry_guard
            .is_enabled()
            .then_some(
                sentry_tracing::layer().event_filter(|metadata| match metadata.level() {
                    &Level::WARN => EventFilter::Event,
                    _ => EventFilter::Ignore,
                }),
            );

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stdout.with_max_level(app::config::logging_level()))
                .pretty(),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(log_writer.with_max_level(Level::DEBUG))
                .with_ansi(false),
        )
        .with(maybe_sentry_subscriber)
        .init();

    std::panic::set_hook(Box::new(app::panic_hook));

    fn handle_ffmpeg_installation() -> Result<(), String> {
        if ffmpeg_is_installed() {
            tracing::info!("FFmpeg is already installed! 🎉");
            return Ok(());
        }

        tracing::info!("FFmpeg not found. Attempting to install...");
        match check_latest_version() {
            Ok(version) => tracing::debug!("Latest available version: {}", version),
            Err(e) => tracing::debug!("Skipping version check due to error: {e}"),
        }

        let download_url = ffmpeg_download_url().map_err(|e| e.to_string())?;
        let destination = sidecar_dir().map_err(|e| e.to_string())?;

        tracing::debug!("Downloading from: {:?}", download_url);
        let archive_path =
            download_ffmpeg_package(download_url, &destination).map_err(|e| e.to_string())?;
        tracing::debug!("Downloaded package: {:?}", archive_path);

        tracing::debug!("Extracting...");
        unpack_ffmpeg(&archive_path, &destination).map_err(|e| e.to_string())?;

        let version = ffmpeg_version().map_err(|e| e.to_string())?;

        tracing::info!("Done! Installed FFmpeg version {} 🏁", version);
        Ok(())
    }

    if let Err(error) = handle_ffmpeg_installation() {
        tracing::error!(error);
        // TODO: UI message instead
        panic!("Failed to install FFmpeg, which is required for Cap to function. Shutting down now")
    };

    let event_loop = winit::event_loop::EventLoop::new().expect("Failed to create event loop");
    let monitor: MonitorHandle = event_loop
        .primary_monitor()
        .expect("No primary monitor found");
    let video_modes: Vec<VideoMode> = monitor.video_modes().collect();

    let max_mode = video_modes
        .iter()
        .max_by_key(|mode| mode.size().width * mode.size().height);

    let (max_width, max_height) = match max_mode {
        Some(max_mode) => {
            tracing::debug!("Maximum resolution: {:?}", max_mode.size());
            (max_mode.size().width, max_mode.size().height)
        }
        None => {
            tracing::debug!("Failed to determine maximum resolution.");
            (0, 0)
        }
    };

    #[derive(serde::Deserialize, PartialEq)]
    enum DeviceKind {
        #[serde(alias = "videoinput")]
        Video,
        #[serde(alias = "audioinput")]
        Audio,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MediaDevice {
        id: String,
        kind: DeviceKind,
        label: String,
    }

    fn create_tray_menu(submenus: Option<Vec<SystemTraySubmenu>>) -> SystemTrayMenu {
        let mut tray_menu = SystemTrayMenu::new();

        if let Some(items) = submenus {
            for submenu in items {
                tray_menu = tray_menu.add_submenu(submenu);
            }
            tray_menu = tray_menu.add_native_item(tauri::SystemTrayMenuItem::Separator);
        }

        tray_menu
            .add_item(CustomMenuItem::new("show-window".to_string(), "Show Cap"))
            .add_item(CustomMenuItem::new("quit".to_string(), "Quit").accelerator("CmdOrControl+Q"))
    }

    #[cfg(target_os = "macos")]
    let tray = SystemTray::new()
        .with_menu(create_tray_menu(None))
        .with_menu_on_left_click(false)
        .with_title("Cap");
    
    #[cfg(target_os = "windows")]
    let tray = SystemTray::new()
        .with_menu(create_tray_menu(None))
        .with_id("Cap");
    
    tauri::Builder
        ::default()
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_positioner::init())
        .setup(move |app| {
            let handle = app.handle();

            if let Some(options_window) = app.get_window("main") {
                let _ = options_window.move_window(Position::Center);
                #[cfg(target_os = "macos")]
                apply_vibrancy(
                    &options_window,
                    NSVisualEffectMaterial::MediumLight,
                    None,
                    Some(16.0)
                ).expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

                #[cfg(target_os = "windows")]
                apply_blur(&options_window, Some((255, 255, 255, 128))).expect(
                    "Unsupported platform! 'apply_blur' is only supported on Windows"
                );

                set_shadow(&options_window, true).expect("Unsupported platform!");
            }

            let data_directory = handle
                .path_resolver()
                .app_data_dir()
                .unwrap_or_else(|| PathBuf::new());

            let recording_state = RecordingState {
            active_recording: None,
                data_dir: data_directory,
                max_screen_width: max_width as usize,
                max_screen_height: max_height as usize,
            };

            app.manage(Arc::new(Mutex::new(recording_state)));

            let tray_handle = app.tray_handle();
            app.listen_global("toggle-recording", move |event| {
                let tray_handle = tray_handle.clone();
                match event.payload() {
                    Some(payload) => {
                        match serde_json::from_str::<bool>(payload) {
                            Ok(is_recording) => {
                                let icon_bytes = if is_recording {
                                    include_bytes!("../icons/tray-stop-icon.png").to_vec()
                                } else {
                                    include_bytes!("../icons/tray-default-icon.png").to_vec()
                                };

                                if let Err(e) = tray_handle.set_icon(tauri::Icon::Raw(icon_bytes)) {
                                    tracing::warn!("Error while setting tray icon: {}", e);
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Error while deserializing recording state from event payload: {}", e);
                            }
                        }
                    }
                    None => {
                        tracing::warn!("Error while opening event payload");
                    }
                }
            });

            let tray_handle = app.tray_handle();
            app.listen_global("media-devices-set", move |event| {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Payload {
                    media_devices: Vec<MediaDevice>,
                    selected_video: Option<MediaDevice>,
                    selected_audio: Option<MediaDevice>,
                }
                let payload: Payload = serde_json
                    ::from_str(event.payload().expect("Error wile openning event payload"))
                    .expect("Error while deserializing media devices from event payload");

                fn create_submenu_items(
                    devices: &Vec<MediaDevice>,
                    selected_device: &Option<MediaDevice>,
                    kind: DeviceKind
                ) -> SystemTrayMenu {
                    let id_prefix = if kind == DeviceKind::Video { "video" } else { "audio" };
                    let mut none_item = CustomMenuItem::new(
                        format!("in_{}_none", id_prefix),
                        "None"
                    );
                    if selected_device.is_none() {
                        none_item = none_item.selected();
                    }
                    let initial = SystemTrayMenu::new().add_item(none_item);
                    devices
                        .iter()
                        .filter(|device| device.kind == kind)
                        .fold(initial, |tray_items, device| {
                            let mut menu_item = CustomMenuItem::new(
                                format!("in_{}_{}", id_prefix, device.id),
                                &device.label
                            );

                            if let Some(selected) = selected_device {
                                if selected.label == device.label {
                                    menu_item = menu_item.selected();
                                }
                            }

                            tray_items.add_item(menu_item)
                        })
                }

                let new_menu = create_tray_menu(
                    Some(
                        vec![
                            SystemTraySubmenu::new(
                                "Camera",
                                create_submenu_items(
                                    &payload.media_devices,
                                    &payload.selected_video,
                                    DeviceKind::Video
                                )
                            ),
                            SystemTraySubmenu::new(
                                "Microphone",
                                create_submenu_items(
                                    &payload.media_devices,
                                    &payload.selected_audio,
                                    DeviceKind::Audio
                                )
                            )
                        ]
                    )
                );

                tray_handle.set_menu(new_menu).expect("Error while updating the tray menu items");
            });

            Ok(())
        })
        .invoke_handler(
            generate_handler![
                start_dual_recording,
                stop_all_recordings,
                enumerate_audio_devices,
                start_server,
                open_screen_capture_preferences,
                open_mic_preferences,
                open_camera_preferences,
                has_screen_capture_access,
                reset_screen_permissions,
                reset_microphone_permissions,
                reset_camera_permissions,
                close_webview,
                set_webview_shadow
            ]
        )
        .plugin(tauri_plugin_context_menu::init())
        .system_tray(tray)
        .on_system_tray_event(move |app, event| {
            match event {
                SystemTrayEvent::MenuItemClick { id, .. } =>
                    match id.as_str() {
                        "show-window" => {
                            let window = app
                                .get_window("main")
                                .expect("Error while trying to get the main window.");
                            window.show().expect("Error while trying to show main window");
                            if !window.is_focused().unwrap_or(false) {
                                window
                                    .set_focus()
                                    .expect("Error while trying to set focus on main window");
                            }
                            if window.is_minimized().unwrap_or(false) {
                                window
                                    .unminimize()
                                    .expect("Error while trying to unminimize main window");
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        item_id => {
                            if !item_id.starts_with("in") {
                                return;
                            }
                            let pattern = Regex::new(r"^in_(video|audio)_").expect(
                                "Failed to create regex for checking tray item events"
                            );

                            if pattern.is_match(item_id) {
                                #[derive(Clone, serde::Serialize)]
                                struct SetDevicePayload {
                                    #[serde(rename(serialize = "type"))]
                                    device_type: String,
                                    id: Option<String>,
                                }

                                let device_id = pattern.replace_all(item_id, "").into_owned();
                                let kind = if item_id.contains("video") {
                                    "videoinput"
                                } else {
                                    "audioinput"
                                };

                                app.emit_all("tray-set-device-id", SetDevicePayload {
                                    device_type: kind.to_string(),
                                    id: if device_id == "none" {
                                        None
                                    } else {
                                        Some(device_id)
                                    },
                                }).expect("Failed to emit tray set media device event to windows");
                            }
                        }
                    }
                SystemTrayEvent::LeftClick { position: _, size: _, .. } => {
                    app.emit_all("tray-on-left-click", Some(())).expect(
                        "Failed to emit tray left click event to windows"
                    );
                }
                _ => {}
            }
        })
        .run(context)
        .expect("Error while running tauri application");
}
