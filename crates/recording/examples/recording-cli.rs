use std::time::Duration;

use cap_displays::{Display, bounds::{LogicalBounds, LogicalSize, LogicalPosition}};
use cap_recording::{RecordingBaseInputs, screen_capture::ScreenCaptureTarget};

#[tokio::main]
pub async fn main() {
    tracing_subscriber::fmt::init();

    let _ = std::fs::remove_dir_all("/tmp/bruh");
    let _ = std::fs::create_dir("/tmp/bruh");

    let dir = tempfile::tempdir().unwrap();

    println!("Recording to directory '{}'", dir.path().display());

    let (handle, _ready_rx) = cap_recording::spawn_studio_recording_actor(
        "test".to_string(),
        dir.path().into(),
        RecordingBaseInputs {
            capture_target: ScreenCaptureTarget::Area {
                screen: Display::primary().id(),
                bounds: LogicalBounds::new(
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(450.0, 400.0)
                )
            },
            capture_system_audio: false,
            mic_feed: &None,
        },
        None,
        false,
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_secs(10)).await;

    let _ = handle.stop().await;

    std::mem::forget(dir);
}
