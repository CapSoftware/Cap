#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::multipart::{Form, Part};
use sentry_tracing::EventFilter;
use specta_typescript::Typescript;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use std::vec;
use std::{path::PathBuf, sync::atomic::AtomicBool};
use atomic_float::AtomicF64;

use tauri::{
    tray::{MouseButton, MouseButtonState},
    Emitter, Manager,
};
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

static UPLOAD_SPEED: AtomicF64 = AtomicF64::new(0.0);
static HEALTH_CHECK: AtomicBool = AtomicBool::new(false);

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

    async fn perform_health_check_and_calculate_upload_speed() -> Result<(), Box<dyn std::error::Error>> {
        let client = reqwest::Client::new();
        let sample_screen_recording = vec![0u8; 1_000_000];

        let health_check_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
        let health_check_url = format!("{}/api/health-check", health_check_url_base);

        let form = Form::new().part(
            "file",
            Part::bytes(sample_screen_recording.clone())
                .file_name("sample_screen_recording.webm")
                .mime_str("video/webm")?,
        );
        let start_time = Instant::now();
        let resp = client.post(health_check_url).multipart(form).send().await?;
        let time_elapsed = start_time.elapsed();

        let is_success = resp.status().is_success();
        HEALTH_CHECK.store(is_success, Ordering::Relaxed);

        if is_success {
            let upload_speed = (sample_screen_recording.len() as f64 / time_elapsed.as_secs_f64()) / 1250000.0;
            UPLOAD_SPEED.store(upload_speed, Ordering::Relaxed);
            tracing::debug!("Health check successful. Upload speed: {} Mbps", upload_speed);
        } else {
            tracing::debug!("Health check failed.");
        }

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
        close_webview,
        make_webview_transparent,
        get_health_check_status,
        get_upload_speed
    ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(Typescript::default(), "../src/utils/commands.ts")
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            tracing::info!("Setting up application...");

            tauri::async_runtime::spawn(async {
                if let Err(error) = perform_health_check_and_calculate_upload_speed().await {
                    tracing::error!("Health check and upload speed calculation failed: {}", error);
                }
            });

            let handle = app.handle();

            if let Some(main_window) = app.get_webview_window("main") {
                use tauri_plugin_decorum::WebviewWindowExt;

                #[cfg(target_os = "macos")]
                main_window
                    .make_transparent()
                    .expect("Failed to set transparency on main webview");
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

            if let Some(main_tray) = app.tray_by_id("cap_main") {
                main_tray.on_tray_icon_event(move |tray, event| match event {
                    tauri::tray::TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } => {
                        if button == MouseButton::Left && button_state == MouseButtonState::Down {
                            if let Err(err) = tray.app_handle().emit("cap://tray/clicked", ()) {
                                eprintln!("Failed to emit event for tray {}", err);
                            };
                        }
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(context)
        .expect("Error while running tauri application");
}
