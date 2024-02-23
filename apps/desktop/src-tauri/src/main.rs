#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

mod app;
mod utils;

use app::{audio, recording, setup, upload};

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_context_menu::init())
        .invoke_handler(tauri::generate_handler![
            recording::start_dual_recording,
            recording::stop_all_recordings,
            audio::enumerate_audio_devices,
            upload::upload_file
        ])
        .setup(setup::init)
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}
