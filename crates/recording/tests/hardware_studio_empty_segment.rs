#![cfg(target_os = "macos")]

//! A resumed Studio segment whose screen capture delivers no frames. The
//! AVFoundation writer never starts, so its finish used to fail with
//! `NotWriting` and the pause failed the whole recording. Lives in its own
//! test binary because `cap_fail` switches are process-wide.
//!
//! Set `CAP_EMPTY_SEGMENT_OUT` to keep the recordings for an export check.

use cap_enc_ffmpeg::remux::{probe_media_valid, probe_video_can_decode};
use cap_project::{RecordingMeta, StudioRecordingMeta, StudioRecordingStatus};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use cap_recording::{SendableShareableContent, studio_recording};
use std::{path::PathBuf, time::Duration};
use tempfile::TempDir;

const SKIP_SCREEN_FRAMES: &str = "cap-recording::screen_capture video frame skip";

fn init() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .with_test_writer()
        .try_init()
        .ok();
    ffmpeg::init().expect("failed to initialize ffmpeg");
}

/// What the app does after Stop: remux a fragmented recording, then every
/// saved segment's display must open. Returns the number of saved segments.
fn finalize_and_open(recording_dir: &std::path::Path, fragmented: bool) -> usize {
    cap_recording::recovery::RecoveryManager::remux_if_needed(recording_dir).unwrap_or_else(
        |error| panic!("fragmented {fragmented}: finalizing the recording failed: {error}"),
    );
    let meta = RecordingMeta::load_for_project(recording_dir).unwrap();
    let studio = meta.studio_meta().unwrap();
    let status = studio.status();
    assert!(
        matches!(status, StudioRecordingStatus::Complete),
        "fragmented {fragmented}: status after finalizing {status:?}"
    );
    let StudioRecordingMeta::MultipleSegments { inner } = studio else {
        panic!("fragmented {fragmented}: not a multi-segment Studio recording");
    };
    for segment in &inner.segments {
        let display = segment.display.path.to_path(recording_dir);
        assert!(probe_media_valid(&display), "{}", display.display());
        assert!(
            probe_video_can_decode(&display).unwrap_or(false),
            "{}",
            display.display()
        );
    }
    inner.segments.len()
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn studio_segment_without_screen_frames_keeps_the_recording_with_real_screen() {
    init();
    let shareable_content: SendableShareableContent = cidre::sc::ShareableContent::current()
        .await
        .expect("Screen Recording permission is required")
        .into();
    let temp = TempDir::new().unwrap();
    let root = std::env::var_os("CAP_EMPTY_SEGMENT_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| temp.path().to_path_buf());

    // No fail point: Pause straight after Resume can beat the first frame of
    // the new capture stream. Every pause must still succeed.
    for fragmented in [false, true] {
        let recording_dir = root.join(format!("quick-pause-fragmented-{fragmented}.cap"));
        let _ = std::fs::remove_dir_all(&recording_dir);
        std::fs::create_dir_all(&recording_dir).unwrap();
        let handle = studio_recording::Actor::builder(
            recording_dir.clone(),
            ScreenCaptureTarget::Display {
                id: scap_targets::Display::primary().id(),
            },
        )
        .with_fragmented(fragmented)
        .with_system_audio(true)
        .with_max_fps(30)
        .with_keyboard_capture(false)
        .build(Some(shareable_content.clone()))
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        const QUICK_PAUSES: usize = 8;
        for attempt in 0..QUICK_PAUSES {
            handle.pause().await.unwrap_or_else(|error| {
                panic!("fragmented {fragmented}: pause {attempt} failed the recording: {error:#}")
            });
            handle.resume().await.unwrap();
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        handle.stop().await.unwrap_or_else(|error| {
            panic!("fragmented {fragmented}: stop after quick pauses failed: {error:#}")
        });
        let meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
        let studio = meta.studio_meta().unwrap();
        let status = studio.status();
        let StudioRecordingMeta::MultipleSegments { inner } = studio else {
            panic!("fragmented {fragmented}: not a multi-segment Studio recording");
        };
        assert!(
            !matches!(status, StudioRecordingStatus::Failed { .. }),
            "fragmented {fragmented}: status {status:?}"
        );
        let saved = inner.segments.len();
        let opened = finalize_and_open(&recording_dir, fragmented);
        assert_eq!(opened, saved, "fragmented {fragmented}");
        eprintln!(
            "quick pauses, fragmented {fragmented}: kept {saved} of {} segments, status {status:?}",
            QUICK_PAUSES + 1
        );
    }

    for fragmented in [false, true] {
        let recording_dir = root.join(format!("empty-segment-fragmented-{fragmented}.cap"));
        let _ = std::fs::remove_dir_all(&recording_dir);
        std::fs::create_dir_all(&recording_dir).unwrap();
        let handle = studio_recording::Actor::builder(
            recording_dir.clone(),
            ScreenCaptureTarget::Display {
                id: scap_targets::Display::primary().id(),
            },
        )
        .with_fragmented(fragmented)
        .with_system_audio(true)
        .with_max_fps(30)
        .with_keyboard_capture(false)
        .build(Some(shareable_content.clone()))
        .await
        .unwrap();

        tokio::time::sleep(Duration::from_secs(2)).await;
        handle.pause().await.unwrap();

        cap_fail::set_fail(SKIP_SCREEN_FRAMES, true);
        let resumed = handle.resume().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let pause_started = std::time::Instant::now();
        let paused = handle.pause().await;
        let pause_ms = pause_started.elapsed().as_secs_f64() * 1000.0;
        cap_fail::set_fail(SKIP_SCREEN_FRAMES, false);
        eprintln!("fragmented {fragmented}: empty pause took {pause_ms:.0} ms");
        resumed.unwrap();
        paused.unwrap_or_else(|error| {
            panic!(
                "fragmented {fragmented}: pausing a segment with no screen frames failed: {error:#}"
            )
        });

        handle.resume().await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        handle.stop().await.unwrap_or_else(|error| {
            panic!("fragmented {fragmented}: stop after an empty segment failed: {error:#}")
        });

        let meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
        let studio = meta.studio_meta().unwrap();
        let status = studio.status();
        let StudioRecordingMeta::MultipleSegments { inner } = studio else {
            panic!("fragmented {fragmented}: not a multi-segment Studio recording");
        };
        assert!(
            !matches!(status, StudioRecordingStatus::Failed { .. }),
            "fragmented {fragmented}: status {status:?}"
        );
        let kept: Vec<_> = inner
            .segments
            .iter()
            .map(|segment| segment.display.path.as_str().to_string())
            .collect();
        assert_eq!(
            kept,
            if fragmented {
                [
                    "content/segments/segment-0/display",
                    "content/segments/segment-1/display",
                ]
            } else {
                [
                    "content/segments/segment-0/display.mp4",
                    "content/segments/segment-1/display.mp4",
                ]
            },
            "fragmented {fragmented}: the two recorded segments are kept and the empty one is left out"
        );
        for segment in &inner.segments {
            assert!(
                segment.system_audio.is_some(),
                "fragmented {fragmented}: a kept segment lost its audio"
            );
        }
        assert!(
            recording_dir
                .join("content/empty-segments/segment-1-0")
                .is_dir(),
            "fragmented {fragmented}: the empty segment's files are kept aside"
        );
        assert!(
            !recording_dir.join("content/segments/segment-2").exists(),
            "fragmented {fragmented}: the next segment took the empty one's index"
        );
        assert_eq!(finalize_and_open(&recording_dir, fragmented), 2);
        eprintln!("fragmented {fragmented}: kept {kept:?}, status {status:?}");
    }
}
