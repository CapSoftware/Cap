//! Real-hardware engagement check for the zero-copy VideoToolbox encoder
//! input: records a 1920x1080 area of the primary display through the real
//! instant-recording pipeline (ScreenCaptureKit -> MacOSFragmentedM4SMuxer)
//! and verifies the recording is valid. Run with RUST_LOG=info and look for
//! "Selected hardware H264 encoder with zero-copy VideoToolbox input" — on
//! displays wider than 4096 the full-display path falls back to software,
//! which is why this uses an area capture.
//!
//! Run: RUST_LOG=info cargo run -p cap-recording --example vt-hwframe-real-capture-check --release

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() {
    use cap_enc_ffmpeg::remux::{concatenate_m4s_segments_with_init, probe_video_can_decode};
    use cap_recording::{
        SendableShareableContent, instant_recording, sources::screen_capture::ScreenCaptureTarget,
    };
    use scap_targets::bounds::{LogicalBounds, LogicalPosition, LogicalSize};
    use std::{path::PathBuf, time::Duration};

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();
    ffmpeg::init().expect("ffmpeg init");

    let primary = scap_targets::Display::primary();
    let display_id = primary.id();

    let shareable_content: SendableShareableContent = cidre::sc::ShareableContent::current()
        .await
        .expect("SCShareableContent (grant Screen Recording permission)")
        .into();

    let temp = tempfile::TempDir::new().unwrap();
    let recording_dir = temp.path().join("hw_check.cap");

    let actor_handle = instant_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Area {
            screen: display_id,
            bounds: LogicalBounds::new(
                LogicalPosition::new(100.0, 100.0),
                LogicalSize::new(1920.0, 1080.0),
            ),
        },
    )
    .with_system_audio(false)
    .build(Some(shareable_content))
    .await
    .expect("spawn instant recording");

    eprintln!("Recording 1920x1080 area for 8s...");
    tokio::time::sleep(Duration::from_secs(8)).await;

    let completed = actor_handle.stop().await.expect("stop recording");
    eprintln!("Recording stopped: {:?}", completed.project_path);

    let display_dir = recording_dir.join("content/display");
    let mut segments: Vec<PathBuf> = std::fs::read_dir(&display_dir)
        .expect("segments dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    segments.sort();
    assert!(!segments.is_empty(), "no media segments produced");

    let assembled = display_dir.join("assembled-check.mp4");
    concatenate_m4s_segments_with_init(&display_dir.join("init.mp4"), &segments, &assembled)
        .expect("assemble");
    assert!(
        probe_video_can_decode(&assembled).unwrap_or(false),
        "assembled recording must decode"
    );

    let mut input = ffmpeg::format::input(&assembled).expect("open assembled");
    let stream_index = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .expect("video stream")
        .index();
    let frame_count = input
        .packets()
        .filter(|(stream, _)| stream.index() == stream_index)
        .count();
    eprintln!(
        "Recorded {} segments, {frame_count} encoded frames",
        segments.len()
    );
    assert!(
        frame_count > 100,
        "8s at 30fps should encode well over 100 frames, got {frame_count}"
    );
    eprintln!("vt-hwframe-real-capture-check: PASS");
}
