use cap_enc_ffmpeg::remux::{
    concatenate_m4s_segments_with_init, get_media_duration, merge_video_audio,
    probe_m4s_can_decode_with_init, probe_media_valid, probe_video_can_decode,
};
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
                settings: None,
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

    let recording_seconds = 15;
    eprintln!("Starting {recording_seconds}s instant recording...");

    let mut builder = instant_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display { id: display_id },
    )
    .with_system_audio(false);

    if let Some((mic, _)) = mic_feed {
        builder = builder.with_mic_feed(mic);
    }

    let actor_handle = builder
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

    let segments_dir = content_dir.join("display");
    let init_path = segments_dir.join("init.mp4");
    assert!(
        init_path.exists(),
        "init.mp4 should exist in segments dir after stop"
    );

    let mut segment_files: Vec<_> = std::fs::read_dir(&segments_dir)
        .expect("should read segments dir")
        .filter_map(|e| {
            let path = e.ok()?.path();
            if path.extension().is_some_and(|ext| ext == "m4s") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    segment_files.sort();
    assert!(
        !segment_files.is_empty(),
        "at least one .m4s segment should exist after recording"
    );
    eprintln!("  Video segment files on disk: {}", segment_files.len());

    let total_segment_size: u64 = segment_files
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
    eprintln!("  Total video segment size: {} bytes", total_segment_size);
    assert!(
        total_segment_size > 1000,
        "segments should have substantial data, got {total_segment_size} bytes"
    );

    assert!(
        probe_media_valid(&init_path),
        "init.mp4 should have a valid container"
    );

    eprintln!("\n--- Segment decode verification ---");
    let first_decode = probe_m4s_can_decode_with_init(&init_path, &segment_files[0]);
    assert!(
        first_decode.as_ref().copied().unwrap_or(false),
        "First video segment should be decodable with init: {first_decode:?}"
    );
    eprintln!("  First segment decodable: OK");

    let last_segment = segment_files.last().unwrap();
    if last_segment != &segment_files[0] {
        let last_decode = probe_m4s_can_decode_with_init(&init_path, last_segment);
        assert!(
            last_decode.as_ref().copied().unwrap_or(false),
            "Last video segment should be decodable with init: {last_decode:?}"
        );
        eprintln!("  Last segment decodable: OK");
    }

    eprintln!("\n--- Full video assembly & playback verification ---");
    let assembled_video = content_dir.join("test_assembled_video.mp4");
    concatenate_m4s_segments_with_init(&init_path, &segment_files, &assembled_video)
        .expect("Video segment concatenation should succeed");
    assert!(assembled_video.exists(), "Assembled video MP4 should exist");
    let video_size = std::fs::metadata(&assembled_video).unwrap().len();
    eprintln!("  Assembled video size: {} bytes", video_size);
    assert!(
        video_size > 1000,
        "Assembled video should have substantial data"
    );

    assert!(
        probe_media_valid(&assembled_video),
        "Assembled video should be a valid container"
    );
    assert!(
        probe_video_can_decode(&assembled_video).unwrap_or(false),
        "Assembled video should be decodable"
    );
    eprintln!("  Assembled video: valid container, decodable");

    let video_duration = get_media_duration(&assembled_video);
    assert!(
        video_duration.is_some(),
        "Should be able to read assembled video duration"
    );
    let video_dur_secs = video_duration.unwrap().as_secs_f64();
    eprintln!("  Video duration: {video_dur_secs:.2}s (expected ~{recording_seconds}s)");
    assert!(
        video_dur_secs > (recording_seconds as f64) * 0.5,
        "Video duration ({video_dur_secs:.2}s) should be at least 50% of recording time ({recording_seconds}s)"
    );
    assert!(
        video_dur_secs < (recording_seconds as f64) * 2.0,
        "Video duration ({video_dur_secs:.2}s) should be less than 2x recording time ({recording_seconds}s)"
    );

    let input_ctx =
        ffmpeg::format::input(&assembled_video).expect("Should open assembled video for probing");
    let has_video = input_ctx
        .streams()
        .any(|s| s.parameters().medium() == ffmpeg::media::Type::Video);
    assert!(has_video, "Assembled video must contain a video stream");

    if has_mic {
        eprintln!("\n--- Audio assembly & A/V sync verification ---");
        let audio_dir = content_dir.join("audio");
        let audio_init = audio_dir.join("init.mp4");
        assert!(
            audio_init.exists(),
            "Audio init.mp4 should exist when mic is connected"
        );

        let mut audio_segments: Vec<_> = std::fs::read_dir(&audio_dir)
            .expect("should read audio dir")
            .filter_map(|e| {
                let path = e.ok()?.path();
                if path.extension().is_some_and(|ext| ext == "m4s") {
                    Some(path)
                } else {
                    None
                }
            })
            .collect();
        audio_segments.sort();
        eprintln!("  Audio segment files: {}", audio_segments.len());

        let assembled_audio = content_dir.join("test_assembled_audio.m4a");
        concatenate_m4s_segments_with_init(&audio_init, &audio_segments, &assembled_audio)
            .expect("Audio segment concatenation should succeed");
        assert!(
            probe_media_valid(&assembled_audio),
            "Assembled audio should be a valid container"
        );

        let audio_duration = get_media_duration(&assembled_audio);
        assert!(
            audio_duration.is_some(),
            "Should be able to read assembled audio duration"
        );
        let audio_dur_secs = audio_duration.unwrap().as_secs_f64();
        eprintln!("  Audio duration: {audio_dur_secs:.2}s (expected ~{recording_seconds}s)");
        assert!(
            audio_dur_secs > (recording_seconds as f64) * 0.5,
            "Audio duration ({audio_dur_secs:.2}s) should be at least 50% of recording time"
        );

        let av_drift = (video_dur_secs - audio_dur_secs).abs();
        eprintln!("  A/V duration drift: {av_drift:.3}s");
        assert!(
            av_drift < 1.0,
            "A/V drift ({av_drift:.3}s) should be less than 1 second"
        );

        let merged_output = content_dir.join("test_merged_av.mp4");
        merge_video_audio(&assembled_video, &assembled_audio, &merged_output)
            .expect("Video + audio merge should succeed");
        assert!(
            probe_media_valid(&merged_output),
            "Merged A/V file should be a valid container"
        );
        assert!(
            probe_video_can_decode(&merged_output).unwrap_or(false),
            "Merged A/V file should be decodable"
        );

        let merged_ctx =
            ffmpeg::format::input(&merged_output).expect("Should open merged file for probing");
        let has_merged_video = merged_ctx
            .streams()
            .any(|s| s.parameters().medium() == ffmpeg::media::Type::Video);
        let has_merged_audio = merged_ctx
            .streams()
            .any(|s| s.parameters().medium() == ffmpeg::media::Type::Audio);
        assert!(has_merged_video, "Merged file must have video stream");
        assert!(has_merged_audio, "Merged file must have audio stream");
        eprintln!("  Merged A/V: valid, decodable, both streams present");
        eprintln!("  A/V sync: PASS (drift {av_drift:.3}s < 1.0s)");
    }

    match &completed.health {
        cap_recording::RecordingHealth::Healthy => {
            eprintln!("\nRecording health: HEALTHY");
        }
        cap_recording::RecordingHealth::Repaired { original_issue } => {
            eprintln!("\nRecording health: REPAIRED (was: {original_issue})");
        }
        cap_recording::RecordingHealth::Degraded { issues } => {
            eprintln!("\nRecording health: DEGRADED - {issues:?}");
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
    eprintln!("  Video duration: {video_dur_secs:.2}s");
    eprintln!("  Video segments: {}", segment_files.len());
    eprintln!("  Total segment size: {} bytes", total_segment_size);
    eprintln!("  Health: {:?}", completed.health);
}
