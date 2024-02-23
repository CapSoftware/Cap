use log::info;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::{App, Manager};
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::sync::Mutex;
use window_shadows::set_shadow;
use window_vibrancy::apply_blur;

use crate::app::recording::RecordingState;

pub fn init(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    info!("setup");

    let handle = app.handle();

    if let Some(options_window) = app.get_window("main") {
        let _ = options_window.move_window(Position::Center);
        #[cfg(target_os = "macos")]
        apply_vibrancy(
            &options_window,
            NSVisualEffectMaterial::MediumLight,
            None,
            Some(16.0),
        )
        .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

        #[cfg(target_os = "windows")]
        apply_blur(&options_window, Some((255, 255, 255, 255)))
            .expect("Unsupported platform! 'apply_blur' is only supported on Windows");

        set_shadow(&options_window, true).expect("Unsupported platform!");
    }

    let data_directory = handle
        .path_resolver()
        .app_data_dir()
        .unwrap_or_else(|| PathBuf::new());
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
}
