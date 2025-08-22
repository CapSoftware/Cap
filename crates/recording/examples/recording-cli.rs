use std::time::Duration;

use cap_displays::Display;
use cap_recording::{
    RecordingBaseInputs, screen_capture::ScreenCaptureTarget, sources::list_windows,
};

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

    println!("Recording to directory '{}'", dir.path().display());

    dbg!(
        list_windows()
            .into_iter()
            .map(|(v, _)| v)
            .collect::<Vec<_>>()
    );

    return;

    let (handle, _ready_rx) = cap_recording::spawn_studio_recording_actor(
        "test".to_string(),
        dir.path().into(),
        RecordingBaseInputs {
            capture_target: ScreenCaptureTarget::Display {
                id: Display::list()[1].id(),
            },
            // ScreenCaptureTarget::Window {
            //     id: Window::list()
            //         .into_iter()
            //         .find(|w| w.owner_name().unwrap_or_default().contains("Brave"))
            //         .unwrap()
            //         .id(),
            // },
            capture_system_audio: true,
            mic_feed: &None,
        },
        None,
        true,
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_secs(10)).await;

    let _ = handle.stop().await;

    std::mem::forget(dir);
}
