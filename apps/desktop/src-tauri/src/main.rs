#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use tauri::{Manager, Window};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

mod recorder;
use recorder::ScreenRecorder;

#[tauri::command]
fn start_screen_recording(window: Window, recorder: tauri::State<'_, Arc<Mutex<ScreenRecorder>>>) {
    let window = window.clone();
    let recorder = recorder.inner().clone();
    std::thread::spawn(move || {
        let recorder = recorder.lock().expect("Failed to lock recorder.");
        if let Err(e) = recorder.start_recording() {
            window.emit("recording-error", &e.to_string()).expect("Failed to send recording-error event.");
        }
    });
}


#[tauri::command]
fn stop_screen_recording(recorder: tauri::State<'_, Arc<Mutex<ScreenRecorder>>>) {
    let recorder = recorder.lock().expect("Failed to lock recorder.");
    if let Err(e) = recorder.stop_recording() {
        eprintln!("Failed to stop recording: {}", e);
    }
}

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
        .setup(|app| {  
            // Fetch the full path to the FFmpeg binary
            let ffmpeg_binary_path = sidecar_dir()?.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
  
            // Create an instance of ScreenRecorder with the ffmpeg_binary_path
            let recorder = ScreenRecorder::new(
                ffmpeg_binary_path,
            );
  
            let shared_recorder = Arc::new(Mutex::new(recorder));
            app.manage(shared_recorder);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_screen_recording,
            stop_screen_recording
        ])
        .plugin(tauri_plugin_context_menu::init())
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}