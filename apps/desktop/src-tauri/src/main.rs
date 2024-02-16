#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc};
use std::path::PathBuf;
use tokio::sync::Mutex;
use std::sync::atomic::{AtomicBool};
use std::env;
use tauri::{Manager};
use window_vibrancy::{apply_blur, apply_vibrancy, NSVisualEffectMaterial};
use window_shadows::set_shadow;
use tauri_plugin_positioner::{WindowExt, Position};

mod recording;
mod upload;
mod devices;
mod utils;
mod audio;

use recording::{RecordingState, start_dual_recording, stop_all_recordings};
use upload::upload_file;
use audio::{enumerate_audio_devices};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

fn main() {    
    std::panic::set_hook(Box::new(|info| {
        eprintln!("Thread panicked: {:?}", info);
    }));

    if which::which("ffmpeg").is_err() {
        if let Err(e) = handle_ffmpeg_installation() {
            eprintln!("Failed to handle FFmpeg installation: {}", e);
        }
    }

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
                screen_process: None,
                screen_process_stdin: None,
                video_process: None,
                audio_process: None,
                upload_handles: Mutex::new(vec![]),
                recording_options: None,
                shutdown_flag: Arc::new(AtomicBool::new(false)),
                video_uploading_finished: Arc::new(AtomicBool::new(false)),
                audio_uploading_finished: Arc::new(AtomicBool::new(false)),
                data_dir: Some(data_directory),
            };

            app.manage(Arc::new(Mutex::new(recording_state)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_dual_recording,
            stop_all_recordings,
            enumerate_audio_devices,
            upload_file
        ])
        .plugin(tauri_plugin_context_menu::init())
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}