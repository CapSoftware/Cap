#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use cpal::Devices;
use regex::Regex;
use std::collections::LinkedList;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::vec;
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTraySubmenu, Window,
};
use tauri_plugin_oauth::start;
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::sync::Mutex;
use window_shadows::set_shadow;
use window_vibrancy::{apply_blur, apply_vibrancy, NSVisualEffectMaterial};

mod media;
mod recording;
mod upload;
mod utils;

use media::enumerate_audio_devices;
use recording::{start_dual_recording, stop_all_recordings, RecordingState};
use utils::has_screen_capture_access;

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

use winit::monitor::{MonitorHandle, VideoMode};

macro_rules! generate_handler {
  ($($command:ident),*) => {{
    #[cfg(debug_assertions)]
    tauri_specta::ts::export(
      specta::collect_types![$($command),*],
      "../src/utils/commands.ts"
    ).unwrap();

    tauri::generate_handler![$($command),*]
  }}
}

fn main() {
    let _ = fix_path_env::fix();

    std::panic::set_hook(Box::new(|info| {
        eprintln!("Thread panicked: {:?}", info);
    }));

    fn handle_ffmpeg_installation() -> FfmpegResult<()> {
        if ffmpeg_is_installed() {
            println!("FFmpeg is already installed! 🎉");
            return Ok(());
        }

        match check_latest_version() {
            Ok(version) => println!("Latest available version: {}", version),
            Err(_) => println!("Skipping version check on this platform."),
        }

        let download_url = ffmpeg_download_url()?;
        let destination = sidecar_dir()?;

        println!("Downloading from: {:?}", download_url);
        let archive_path = download_ffmpeg_package(download_url, &destination)?;
        println!("Downloaded package: {:?}", archive_path);

        println!("Extracting...");
        unpack_ffmpeg(&archive_path, &destination)?;

        let version = ffmpeg_version()?;
        println!("FFmpeg version: {}", version);

        println!("Done! 🏁");
        Ok(())
    }

    handle_ffmpeg_installation().expect("Failed to install FFmpeg");

    #[tauri::command]
    #[specta::specta]
    async fn start_server(window: Window) -> Result<u16, String> {
        start(move |url| {
            let _ = window.emit("redirect_uri", url);
        })
        .map_err(|err| err.to_string())
    }

    #[tauri::command]
    #[specta::specta]
    fn open_screen_capture_preferences() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .expect("failed to open system preferences");
    }

    #[tauri::command]
    #[specta::specta]
    fn open_mic_preferences() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .expect("failed to open system preferences");
    }

    #[tauri::command]
    #[specta::specta]
    fn open_camera_preferences() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
            .spawn()
            .expect("failed to open system preferences");
    }

    #[tauri::command]
    #[specta::specta]
    fn reset_screen_permissions() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("tccutil")
            .arg("reset")
            .arg("ScreenCapture")
            .arg("so.cap.desktop")
            .spawn()
            .expect("failed to reset screen permissions");
    }

    #[tauri::command]
    #[specta::specta]
    fn reset_microphone_permissions() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("tccutil")
            .arg("reset")
            .arg("Microphone")
            .arg("so.cap.desktop")
            .spawn()
            .expect("failed to reset microphone permissions");
    }

    #[tauri::command]
    #[specta::specta]
    fn reset_camera_permissions() {
        #[cfg(target_os = "macos")]
        std::process::Command::new("tccutil")
            .arg("reset")
            .arg("Camera")
            .arg("so.cap.desktop")
            .spawn()
            .expect("failed to reset camera permissions");
    }

    let _guard = sentry::init(("https://efd3156d9c0a8a49bee3ee675bec80d8@o4506859771527168.ingest.us.sentry.io/4506859844403200", sentry::ClientOptions {
      release: sentry::release_name!(),
      ..Default::default()
    }));

    let event_loop = winit::event_loop::EventLoop::new().expect("Failed to create event loop");
    let monitor: MonitorHandle = event_loop
        .primary_monitor()
        .expect("No primary monitor found");
    let video_modes: Vec<VideoMode> = monitor.video_modes().collect();

    let max_mode = video_modes
        .iter()
        .max_by_key(|mode| mode.size().width * mode.size().height);

    let (max_width, max_height) = if let Some(max_mode) = max_mode {
        println!("Maximum resolution: {:?}", max_mode.size());
        (max_mode.size().width, max_mode.size().height)
    } else {
        println!("Failed to determine maximum resolution.");
        (0, 0)
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

    let tray = SystemTray::new()
        .with_menu(create_tray_menu(None))
        .with_menu_on_left_click(false)
        .with_title("Cap");

    tauri::Builder::default()
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_positioner::init())
        .setup(move |app| {
            let handle = app.handle();

            if let Some(options_window) = app.get_window("main") {
              let _ = options_window.move_window(Position::Center);
              #[cfg(target_os = "macos")]
              apply_vibrancy(&options_window, NSVisualEffectMaterial::MediumLight, None, Some(16.0)).expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

              #[cfg(target_os = "windows")]
              apply_blur(&options_window, Some((255, 255, 255, 255))).expect("Unsupported platform! 'apply_blur' is only supported on Windows");

              set_shadow(&options_window, true).expect("Unsupported platform!");
            }

            let data_directory = handle.path_resolver().app_data_dir().unwrap_or_else(|| PathBuf::new());
            let recording_state = RecordingState {
                media_process: None,
                recording_options: None,
                shutdown_flag: Arc::new(AtomicBool::new(false)),
                uploading_finished: Arc::new(AtomicBool::new(false)),
                data_dir: Some(data_directory),
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
                                    eprintln!("Error while setting tray icon: {}", e);
                                }
                            }
                            Err(e) => {
                                eprintln!("Error while deserializing recording state from event payload: {}", e);
                            }
                        }
                    }
                    None => {
                        eprintln!("Error while opening event payload");
                    }
                }
            });

            let tray_handle = app.tray_handle();
            app.listen_global("media-devices-set", move|event| {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Payload {
                    media_devices: Vec<MediaDevice>,
                    selected_video: Option<MediaDevice>,
                    selected_audio: Option<MediaDevice>
                }
                let payload: Payload = serde_json::from_str(event.payload().expect("Error wile openning event payload")).expect("Error while deserializing media devices from event payload");

                fn create_submenu_items(devices: &Vec<MediaDevice>, selected_device: &Option<MediaDevice>, kind: DeviceKind) -> SystemTrayMenu {
                    let id_prefix = if kind == DeviceKind::Video {
                        "video"
                    } else {
                        "audio"
                    };
                    let mut none_item = CustomMenuItem::new(format!("in_{}_none", id_prefix), "None");
                    if selected_device.is_none() {
                        none_item = none_item.selected();
                    }
                    let initial = SystemTrayMenu::new().add_item(none_item);
                    devices
                        .iter()
                        .filter(|device| device.kind == kind)
                        .fold(initial, |tray_items, device| {
                            let mut menu_item = CustomMenuItem::new(format!("in_{}_{}", id_prefix, device.id), &device.label);

                            if let Some(selected) = selected_device {
                                if selected.label == device.label {
                                    menu_item = menu_item.selected();
                                }
                            }

                            tray_items.add_item(menu_item)
                        })
                }

                let new_menu = create_tray_menu(Some(
                    vec![
                        SystemTraySubmenu::new("Camera", create_submenu_items(&payload.media_devices, &payload.selected_video, DeviceKind::Video)),
                        SystemTraySubmenu::new("Microphone", create_submenu_items(&payload.media_devices, &payload.selected_audio, DeviceKind::Audio))
                    ]
                ));

                tray_handle.set_menu(new_menu).expect("Error while updating the tray menu items");
            });

            Ok(())
        })
        .invoke_handler(generate_handler![
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
            reset_camera_permissions
        ])
        .plugin(tauri_plugin_context_menu::init())
        .system_tray(tray)
        .on_system_tray_event(move |app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show-window" => {
                    let window = app.get_window("main").expect("Error while trying to get the main window.");
                    window.show().expect("Error while trying to show main window");
                    if !window.is_focused().unwrap_or(false) {
                        window.set_focus().expect("Error while trying to set focus on main window");
                    }
                    if(window.is_minimized().unwrap_or(false)) {
                        window.unminimize().expect("Error while trying to unminimize main window");
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                item_id => {
                    if !item_id.starts_with("in") {
                        return;
                    }
                    let pattern = Regex::new(r"^in_(video|audio)_").expect("Failed to create regex for checking tray item events");

                    if pattern.is_match(item_id) {
                        #[derive(Clone, serde::Serialize)]
                        struct SetDevicePayload {
                            #[serde(rename(serialize="type"))]
                            device_type: String,
                            id: Option<String>
                        }

                        let device_id = pattern.replace_all(item_id, "").into_owned();
                        let kind = if item_id.contains("video") { "videoinput" } else { "audioinput" };

                        app.emit_all("tray-set-device-id", SetDevicePayload {
                            device_type: kind.to_string(),
                            id: if device_id == "none" { None } else { Some(device_id) }
                        }).expect("Failed to emit tray set media device event to windows");
                    }
                }
            },
            SystemTrayEvent::LeftClick { position: _, size: _, .. } => {
                app.emit_all("tray-on-left-click", Some(())).expect("Failed to emit tray left click event to windows");
            },
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}
