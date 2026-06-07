//! Continuous instant-mode screen + system-audio recording for the A/V sync
//! hardware test (`scripts/av-sync/`). Records the primary display for a fixed
//! duration with no pause, so `av-sync-check` can measure drift against a
//! flash+beep stimulus playing on screen.
//!
//! Usage: av-sync-record [--duration <secs>] [--out <dir>]

use cap_recording::{screen_capture::ScreenCaptureTarget, *};
use scap_targets::Display;
use std::time::Duration;
use tracing::*;

#[tokio::main]
pub async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("warn,cap_recording=info")
        .init();

    let mut duration_secs = 45u64;
    let mut out = std::path::PathBuf::from("/tmp/avsync_rec");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--duration" => {
                duration_secs = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--duration <secs>")
            }
            "--out" => out = args.next().expect("--out <dir>").into(),
            other => panic!("unexpected argument: {other}"),
        }
    }

    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("create output dir");

    info!(
        "Recording {duration_secs}s of screen + system audio to '{}'",
        out.display()
    );

    let handle = instant_recording::Actor::builder(
        out.clone(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(true)
    .build(
        #[cfg(target_os = "macos")]
        Some(cap_recording::SendableShareableContent::from(
            cidre::sc::ShareableContent::current().await.unwrap(),
        )),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_secs(duration_secs)).await;

    handle.stop().await.unwrap();
    info!("Recording finished: {}", out.display());
}
