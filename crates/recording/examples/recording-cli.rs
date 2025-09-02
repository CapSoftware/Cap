use std::time::Duration;

use cap_recording::{RecordingBaseInputs, screen_capture::ScreenCaptureTarget};
use scap_targets::Display;
use tracing::info;

#[tokio::main]
pub async fn main() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};

        unsafe { SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE).unwrap() };
    }

    tracing_subscriber::fmt::init();

    let _ = std::fs::remove_dir_all("/tmp/bruh");
    let _ = std::fs::create_dir("/tmp/bruh");

    let dir = tempfile::tempdir().unwrap();

    info!("Recording to directory '{}'", dir.path().display());

    let (handle, _ready_rx) = cap_recording::instant_recording::spawn_instant_recording_actor(
        "test".to_string(),
        dir.path().into(),
        RecordingBaseInputs {
            capture_target: ScreenCaptureTarget::Display {
                id: Display::primary().id(),
            },
            capture_system_audio: true,
            camera_feed: None,
            mic_feed: None,
        },
        // true,
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_secs(10)).await;

    let _ = handle.stop().await;

    std::mem::forget(dir);
}
