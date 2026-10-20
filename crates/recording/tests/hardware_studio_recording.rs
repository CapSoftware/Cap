#![cfg(target_os = "macos")]

//! Real-hardware validation of the studio-mode NON-fragmented pipeline: the
//! AVFoundation MP4 writer path that produced the 0.5.8 field failures
//! (-11800/-16364 InvalidTimestamp). Requires Screen Recording permission on
//! the terminal running the test, exactly like `hardware_instant_recording`.
//!
//! Records the primary display through the real studio actor with
//! `fragmented(false)` (the shape a studio recording takes when a camera is
//! active), pauses and resumes mid-recording (which finalizes segment-0 and
//! opens segment-1), then verifies every segment's display.mp4 is a plain
//! finalized MP4 with the expected content duration.

use cap_enc_ffmpeg::remux::{get_media_duration, probe_media_valid, probe_video_can_decode};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use cap_recording::{SendableShareableContent, studio_recording};
use std::{path::PathBuf, time::Duration};
use tempfile::TempDir;

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

#[tokio::test]
async fn studio_failed_second_resume_can_save_or_retry_with_real_screen() {
    init();
    let shareable_content: SendableShareableContent = cidre::sc::ShareableContent::current()
        .await
        .expect("Screen Recording permission is required")
        .into();

    for (retry, fail_after_screen_start) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let temp = TempDir::new().unwrap();
        let recording_dir = temp.path().join("failed-resume.cap");
        let handle = studio_recording::Actor::builder(
            recording_dir.clone(),
            ScreenCaptureTarget::Display {
                id: scap_targets::Display::primary().id(),
            },
        )
        .with_fragmented(false)
        .with_system_audio(fail_after_screen_start)
        .with_max_fps(30)
        .with_keyboard_capture(false)
        .build(Some(shareable_content.clone()))
        .await
        .unwrap();

        tokio::time::sleep(Duration::from_secs(2)).await;
        handle.pause().await.unwrap();
        handle.resume().await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        handle.pause().await.unwrap();

        let segments = recording_dir.join("content/segments");
        let original_bytes: Vec<_> = (0..2)
            .map(|index| {
                std::fs::read(segments.join(format!("segment-{index}/display.mp4"))).unwrap()
            })
            .collect();
        let obstruction = if fail_after_screen_start {
            let path = segments.join("segment-2/system_audio.ogg");
            std::fs::create_dir_all(&path).unwrap();
            path
        } else {
            let path = segments.join("segment-2");
            std::fs::write(&path, b"failed segment creation").unwrap();
            path
        };
        for _ in 0..2 {
            let failure = tokio::time::timeout(Duration::from_secs(5), handle.resume())
                .await
                .expect("resume must return its error")
                .unwrap_err();
            assert!(failure.to_string().contains("still paused"));
            if fail_after_screen_start {
                assert!(failure.to_string().contains("system audio pipeline setup"));
                assert!(segments.join("segment-2/display.mp4").exists());
            }
            assert!(handle.is_paused().await.unwrap());
        }
        if fail_after_screen_start {
            std::fs::remove_dir(&obstruction).unwrap();
        } else {
            std::fs::remove_file(&obstruction).unwrap();
        }
        if retry {
            handle.resume().await.unwrap();
            assert!(!handle.is_paused().await.unwrap());
            tokio::time::sleep(Duration::from_secs(2)).await;
        }

        let report = tokio::time::timeout(
            Duration::from_secs(15),
            handle.stop_with_intent(studio_recording::StudioStopIntent::Preserve),
        )
        .await
        .expect("Stop must complete after failed resume");
        assert!(report.accepted_intent && report.stop_acknowledged);
        let completed = report.result.unwrap();
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = completed.meta else {
            panic!("expected multiple segments");
        };
        assert_eq!(inner.segments.len(), if retry { 3 } else { 2 });
        for (index, original) in original_bytes.iter().enumerate() {
            let path = segments.join(format!("segment-{index}/display.mp4"));
            assert_eq!(&std::fs::read(&path).unwrap(), original);
        }
        for segment in inner.segments {
            let path = segment.display.path.to_path(&recording_dir);
            assert!(probe_media_valid(&path));
            assert!(probe_video_can_decode(&path).unwrap());
            let duration = get_media_duration(&path).unwrap().as_secs_f64();
            assert!(
                (1.0..3.0).contains(&duration),
                "segment duration {duration}"
            );
        }
    }
}

#[tokio::test]
async fn studio_nonfragmented_record_pause_resume_with_real_screen() {
    init();

    let primary = scap_targets::Display::primary();
    let display_id = primary.id();
    eprintln!(
        "Using primary display: {:?}",
        primary.name().unwrap_or_default(),
    );

    let shareable_content: SendableShareableContent = cidre::sc::ShareableContent::current()
        .await
        .expect(
            "Failed to get SCShareableContent. \
             Grant Screen Recording permission to your terminal in \
             System Settings > Privacy & Security > Screen Recording",
        )
        .into();

    let temp = TempDir::new().unwrap();
    let recording_dir = temp.path().join("test_studio_recording.cap");

    let record_before_pause = Duration::from_secs(6);
    let pause_duration = Duration::from_secs(3);
    let record_after_resume = Duration::from_secs(6);
    let segment_expected_secs = [
        record_before_pause.as_secs_f64(),
        record_after_resume.as_secs_f64(),
    ];

    eprintln!(
        "Starting studio (non-fragmented) recording: {}s, pause {}s, {}s...",
        record_before_pause.as_secs(),
        pause_duration.as_secs(),
        record_after_resume.as_secs(),
    );

    let actor_handle = studio_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display { id: display_id },
    )
    .with_fragmented(false)
    .with_max_fps(30)
    .with_keyboard_capture(false)
    .build(Some(shareable_content))
    .await
    .expect("Failed to spawn studio recording actor");

    tokio::time::sleep(record_before_pause).await;

    eprintln!(
        "Pausing for {}s (finalizes segment-0)...",
        pause_duration.as_secs()
    );
    actor_handle.pause().await.expect("Failed to pause");
    assert!(
        actor_handle.is_paused().await.expect("is_paused failed"),
        "actor should report paused"
    );
    tokio::time::sleep(pause_duration).await;

    eprintln!("Resuming (opens segment-1)...");
    actor_handle.resume().await.expect("Failed to resume");
    tokio::time::sleep(record_after_resume).await;

    eprintln!("Stopping recording...");
    let completed = actor_handle.stop().await.expect("Failed to stop recording");
    eprintln!("Recording stopped at {}", completed.project_path.display());

    let segments_dir = recording_dir.join("content").join("segments");
    let mut segment_dirs: Vec<PathBuf> = std::fs::read_dir(&segments_dir)
        .expect("segments dir should exist")
        .filter_map(|e| {
            let path = e.ok()?.path();
            path.is_dir().then_some(path)
        })
        .collect();
    segment_dirs.sort();

    assert_eq!(
        segment_dirs.len(),
        2,
        "pause/resume must produce exactly two segments, got {segment_dirs:?}"
    );

    let mut total_duration = 0.0f64;
    for (i, segment_dir) in segment_dirs.iter().enumerate() {
        let display_path = segment_dir.join("display.mp4");
        assert!(
            display_path.is_file(),
            "segment {i} display.mp4 must be a plain finalized MP4 file \
             (non-fragmented studio path), missing at {}",
            display_path.display()
        );

        assert!(
            probe_media_valid(&display_path),
            "segment {i} display.mp4 must be a valid container"
        );
        assert!(
            probe_video_can_decode(&display_path).unwrap_or(false),
            "segment {i} display.mp4 must be decodable"
        );

        let duration = get_media_duration(&display_path)
            .expect("segment display duration should be readable")
            .as_secs_f64();
        let expected = segment_expected_secs[i];
        eprintln!("  Segment {i}: {duration:.2}s (expected ~{expected:.0}s)");
        assert!(
            duration > expected * 0.6,
            "segment {i} duration ({duration:.2}s) should be at least 60% of its recording \
             window ({expected:.0}s)"
        );
        assert!(
            duration < expected * 1.4,
            "segment {i} duration ({duration:.2}s) should be under 140% of its recording \
             window ({expected:.0}s) — a larger value means paused time leaked in"
        );
        total_duration += duration;
    }

    let expected_content = segment_expected_secs.iter().sum::<f64>();
    eprintln!(
        "  Total content: {total_duration:.2}s (expected ~{expected_content:.0}s, \
         pause excised across segments)"
    );
    assert!(
        (total_duration - expected_content).abs() < expected_content * 0.4,
        "total recorded content ({total_duration:.2}s) should be within 40% of \
         {expected_content:.0}s"
    );

    let meta_path = recording_dir.join("recording-meta.json");
    assert!(
        meta_path.exists(),
        "recording meta should be persisted at {}",
        meta_path.display()
    );

    eprintln!("\n=== ALL CHECKS PASSED ===");
}
