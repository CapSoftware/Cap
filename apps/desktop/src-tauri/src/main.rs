#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use sentry_tracing::EventFilter;
use specta_typescript::Typescript;
use std::path::PathBuf;
use std::sync::Arc;
use std::vec;
use tauri::Manager;
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_specta::{collect_commands, Builder};
use tokio::sync::Mutex;
use tracing::Level;
use tracing_subscriber::prelude::*;

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

    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![
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
        close_webview
    ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(Typescript::default(), "../src/utils/commands.ts")
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle();

            if let Some(main_window) = app.get_webview_window("main") {
                main_window
                    .create_overlay_titlebar()
                    .expect("Failed to create titlebar for main window");

                #[cfg(target_os = "macos")]
                {
                    let inset_x = 11.0;
                    let inset_y = 24.0;
                    let _ = main_window.set_traffic_lights_inset(inset_x, inset_y);
                    main_window
                        .make_transparent()
                        .expect("Failed to set transparency on main webview");

                    let win_clone = main_window.clone();
                    main_window.on_window_event(move |event| match event {
                        tauri::WindowEvent::ThemeChanged(_theme) => {
                            let _ = win_clone.set_traffic_lights_inset(inset_x, inset_y);
                        }
                        _ => {}
                    })
                }
            }

            let data_directory = handle
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::new());

            let recording_state = RecordingState {
                active_recording: None,
                data_dir: data_directory,
                max_screen_width: max_width as usize,
                max_screen_height: max_height as usize,
            };

            app.manage(Arc::new(Mutex::new(recording_state)));

            // let tray_handle = app.tray_handle();
            // app.listen_global("toggle-recording", move |event| {
            //     let tray_handle = tray_handle.clone();
            //     match event.payload() {
            //         Some(payload) => {
            //             match serde_json::from_str::<bool>(payload) {
            //                 Ok(is_recording) => {
            //                     let icon_bytes = if is_recording {
            //                         include_bytes!("../icons/tray-stop-icon.png").to_vec()
            //                     } else {
            //                         include_bytes!("../icons/tray-default-icon.png").to_vec()
            //                     };

            //                     if let Err(e) = tray_handle.set_icon(tauri::Icon::Raw(icon_bytes)) {
            //                         tracing::warn!("Error while setting tray icon: {}", e);
            //                     }
            //                 }
            //                 Err(e) => {
            //                     tracing::warn!("Error while deserializing recording state from event payload: {}", e);
            //                 }
            //             }
            //         }
            //         None => {
            //             tracing::warn!("Error while opening event payload");
            //         }
            //     }
            // });
            Ok(())
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .run(context)
        .expect("Error while running tauri application");
}
