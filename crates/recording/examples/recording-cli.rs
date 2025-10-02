use cap_recording::{screen_capture::ScreenCaptureTarget, *};
use kameo::prelude::*;
use scap_targets::Display;
use std::time::Duration;
use tracing::info;

#[tokio::main]
pub async fn main() {
    unsafe { std::env::set_var("RUST_LOG", "trace") };
    unsafe { std::env::set_var("RUST_BACKTRACE", "1") };

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

    let camera_info = cap_camera::list_cameras().next().unwrap();

    let camera_feed = CameraFeed::spawn(CameraFeed::default());

    camera_feed
        .ask(feeds::camera::SetInput {
            id: feeds::camera::DeviceOrModelID::from_info(&camera_info),
        })
        .await
        .unwrap()
        .await
        .unwrap();

    // let (error_tx, _) = flume::bounded(1);
    // let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));

    // mic_feed
    //     .ask(microphone::SetInput {
    //         label:
    //         // MicrophoneFeed::list()
    //         //     .into_iter()
    //         //     .find(|(k, _)| k.contains("Focusrite"))
    //         MicrophoneFeed::default()
    //             .map(|v| v.0)
    //             .unwrap(),
    //     })
    //     .await
    //     .unwrap()
    //     .await
    //     .unwrap();

    tokio::time::sleep(Duration::from_millis(10)).await;

    let handle = instant_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    // .with_system_audio(true)
    // .with_camera_feed(std::sync::Arc::new(
    //     camera_feed.ask(feeds::camera::Lock).await.unwrap(),
    // ))
    .build()
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_secs(5)).await;

    handle.stop().await.unwrap();

    info!("Recording finished");

    std::mem::forget(dir);
}
