#![cfg(target_os = "macos")]

//! Real ScreenCaptureKit start failure for a Studio recording. It lives in its
//! own test binary because `cap_fail` switches are process-wide, so a sibling
//! hardware test running in parallel would hit the same failure point.

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use cap_recording::{SendableShareableContent, studio_recording};
use tempfile::TempDir;

/// A start that fails once the metadata is written is marked `Failed` with its
/// error, as on Windows and Linux, instead of staying `InProgress` forever
/// (#3948). The debug build's failure point fails macOS screen capture setup.
#[cfg(debug_assertions)]
#[tokio::test]
async fn studio_start_failure_marks_the_recording_failed_with_real_screen() {
    ffmpeg::init().expect("failed to initialize ffmpeg");
    let shareable_content: SendableShareableContent = cidre::sc::ShareableContent::current()
        .await
        .expect("Screen Recording permission is required")
        .into();
    let temp = TempDir::new().unwrap();
    let recording_dir = temp.path().join("failed-start.cap");
    std::fs::create_dir_all(&recording_dir).unwrap();

    cap_fail::set_fail("cap-recording::macos::ScreenCaptureActor::new", true);
    let result = studio_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display {
            id: scap_targets::Display::primary().id(),
        },
    )
    .with_fragmented(true)
    .with_max_fps(30)
    .with_keyboard_capture(false)
    .build(Some(shareable_content))
    .await;
    cap_fail::set_fail("cap-recording::macos::ScreenCaptureActor::new", false);

    let Err(error) = result else {
        panic!("the injected screen capture failure did not fail the start");
    };
    let meta = cap_project::RecordingMeta::load_for_project(&recording_dir).unwrap();
    match meta.studio_meta().unwrap().status() {
        cap_project::StudioRecordingStatus::Failed { error: saved } => {
            assert_eq!(saved, format!("{error:#}"));
        }
        status => panic!("a failed start left the recording {status:?}"),
    }
}
