use cap_enc_ffmpeg::remux::{get_media_duration, probe_media_valid, probe_video_can_decode};
use cap_recording::{
    SendableShareableContent, feeds::microphone::MicrophoneFeed, instant_recording,
    sources::screen_capture::ScreenCaptureTarget,
};
use kameo::Actor as _;
use std::{sync::Arc, time::Duration};
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
async fn instant_record_with_real_mic_and_screen() {
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

    let default_mic = MicrophoneFeed::default_device();
    let mic_feed = if let Some((label, _device, _config)) = &default_mic {
        eprintln!("Found microphone: {label}");

        let (error_tx, _error_rx) = flume::unbounded();
        let mic_actor = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));

        let ready_future = mic_actor
            .ask(cap_recording::feeds::microphone::SetInput {
                label: label.clone(),
            })
            .await
            .expect("SetInput message failed");

        ready_future.await.expect("Mic stream failed to start");

        tokio::time::sleep(Duration::from_millis(200)).await;

        match mic_actor.ask(cap_recording::feeds::microphone::Lock).await {
            Ok(lock) => {
                eprintln!("Microphone locked: {}", lock.device_name());
                Some((Arc::new(lock), mic_actor))
            }
            Err(e) => {
                eprintln!("WARNING: Failed to lock microphone ({e}), recording video-only");
                None
            }
        }
    } else {
        eprintln!("WARNING: No default microphone found, recording video-only");
        None
    };

    let _mic_actor_keepalive = mic_feed.as_ref().map(|(_, actor)| actor.clone());

    let has_mic = mic_feed.is_some();
    let temp = TempDir::new().unwrap();
    let recording_dir = temp.path().join("test_recording.cap");

    let recording_seconds = 3;
    eprintln!("Starting {recording_seconds}s instant recording...");

    let mut builder = instant_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display { id: display_id },
    )
    .with_system_audio(false);

    if let Some((mic, _)) = mic_feed {
        builder = builder.with_mic_feed(mic);
    }

    let mut actor_handle = builder
        .build(Some(shareable_content))
        .await
        .expect("Failed to spawn instant recording actor");

    let segment_rx = actor_handle.take_segment_rx();

    tokio::time::sleep(Duration::from_secs(recording_seconds)).await;

    eprintln!("Stopping recording...");
    let completed = actor_handle.stop().await.expect("Failed to stop recording");

    eprintln!("Recording stopped. Health: {:?}", completed.health);

    let content_dir = recording_dir.join("content");
    let display_dir = content_dir.join("display");
    let audio_dir = content_dir.join("audio");

    let video_init = display_dir.join("init.mp4");
    assert!(
        video_init.exists(),
        "Video init.mp4 should exist at {}",
        video_init.display()
    );

    let video_manifest_path = display_dir.join("manifest.json");
    assert!(video_manifest_path.exists(), "Video manifest should exist");

    let video_manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&video_manifest_path).unwrap()).unwrap();
    assert!(
        video_manifest["is_complete"].as_bool().unwrap(),
        "Video manifest should be marked complete"
    );

    let video_segments = video_manifest["segments"]
        .as_array()
        .expect("manifest should have segments array");
    let complete_segments: Vec<&serde_json::Value> = video_segments
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .collect();
    eprintln!(
        "Video: {} completed segments out of {} total",
        complete_segments.len(),
        video_segments.len()
    );
    assert!(
        !complete_segments.is_empty(),
        "should have at least one completed video segment"
    );

    if has_mic {
        let audio_init = audio_dir.join("init.mp4");
        assert!(
            audio_init.exists(),
            "Audio init.mp4 should exist when mic is connected"
        );

        let audio_manifest_path = audio_dir.join("manifest.json");
        assert!(
            audio_manifest_path.exists(),
            "Audio manifest should exist when mic is connected"
        );

        let audio_manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&audio_manifest_path).unwrap()).unwrap();
        assert!(
            audio_manifest["is_complete"].as_bool().unwrap(),
            "Audio manifest should be marked complete"
        );

        let audio_segments = audio_manifest["segments"]
            .as_array()
            .expect("audio manifest should have segments array");
        let audio_complete: Vec<&serde_json::Value> = audio_segments
            .iter()
            .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
            .collect();
        eprintln!(
            "Audio: {} completed segments out of {} total",
            audio_complete.len(),
            audio_segments.len()
        );
        assert!(
            !audio_complete.is_empty(),
            "should have at least one completed audio segment"
        );
    }

    if let Some(rx) = segment_rx {
        let events: Vec<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent> =
            rx.try_iter().collect();
        eprintln!("Segment events received: {}", events.len());

        let video_events = events
            .iter()
            .filter(|e| {
                e.media_type == cap_enc_ffmpeg::segmented_stream::SegmentMediaType::Video
                    && !e.is_init
            })
            .count();
        let audio_events = events
            .iter()
            .filter(|e| {
                e.media_type == cap_enc_ffmpeg::segmented_stream::SegmentMediaType::Audio
                    && !e.is_init
            })
            .count();
        eprintln!("  Video segment events: {video_events}");
        eprintln!("  Audio segment events: {audio_events}");

        for event in &events {
            if !event.is_init {
                assert!(
                    event.duration > 0.0,
                    "segment {} ({:?}) should have positive duration, got {}",
                    event.index,
                    event.media_type,
                    event.duration
                );
            }
        }
    }

    let output_path = content_dir.join("output.mp4");
    assert!(
        output_path.exists(),
        "output.mp4 should exist after stop (assembled locally)"
    );

    let output_size = std::fs::metadata(&output_path).unwrap().len();
    eprintln!("output.mp4 size: {} bytes", output_size);
    assert!(
        output_size > 1000,
        "output.mp4 should have substantial data, got {output_size} bytes"
    );

    assert!(
        probe_media_valid(&output_path),
        "output.mp4 should have a valid container"
    );
    assert!(
        probe_video_can_decode(&output_path).unwrap_or(false),
        "output.mp4 video stream should be decodable"
    );

    let duration = get_media_duration(&output_path);
    assert!(duration.is_some(), "should be able to read output duration");
    let dur_secs = duration.unwrap().as_secs_f64();
    eprintln!("output.mp4 duration: {dur_secs:.2}s (expected ~{recording_seconds}s)");
    assert!(
        dur_secs > (recording_seconds as f64) * 0.5,
        "duration ({dur_secs:.2}s) should be at least 50% of recording time ({recording_seconds}s)"
    );
    assert!(
        dur_secs < (recording_seconds as f64) * 2.0,
        "duration ({dur_secs:.2}s) should be less than 2x recording time ({recording_seconds}s)"
    );

    let input =
        ffmpeg::format::input(&output_path).expect("should open output.mp4 for stream probing");
    let has_video = input
        .streams()
        .any(|s| s.parameters().medium() == ffmpeg::media::Type::Video);
    let has_audio = input
        .streams()
        .any(|s| s.parameters().medium() == ffmpeg::media::Type::Audio);

    assert!(has_video, "output.mp4 must contain a video stream");
    if has_mic {
        assert!(
            has_audio,
            "output.mp4 must contain an audio stream when mic was connected"
        );
    }
    eprintln!("Streams: video={has_video}, audio={has_audio}");

    match &completed.health {
        cap_recording::RecordingHealth::Healthy => {
            eprintln!("Recording health: HEALTHY");
        }
        cap_recording::RecordingHealth::Repaired { original_issue } => {
            eprintln!("Recording health: REPAIRED (was: {original_issue})");
        }
        cap_recording::RecordingHealth::Degraded { issues } => {
            eprintln!("Recording health: DEGRADED - {issues:?}");
        }
        cap_recording::RecordingHealth::Damaged { reason } => {
            panic!("Recording health is DAMAGED: {reason}");
        }
    }

    eprintln!("\n=== ALL CHECKS PASSED ===");
    eprintln!(
        "  Display: {:?}",
        scap_targets::Display::primary().name().unwrap_or_default()
    );
    eprintln!(
        "  Microphone: {}",
        default_mic
            .map(|(name, _, _)| name)
            .unwrap_or_else(|| "none".to_string())
    );
    eprintln!("  Duration: {dur_secs:.2}s");
    eprintln!("  Video segments: {}", complete_segments.len());
    eprintln!("  Output size: {} bytes", output_size);
    eprintln!("  Has video: {has_video}");
    eprintln!("  Has audio: {has_audio}");
    eprintln!("  Health: {:?}", completed.health);
}
