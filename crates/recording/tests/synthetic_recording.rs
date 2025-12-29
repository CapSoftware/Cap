use cap_recording::test_sources::{
    AudioGenerator, AudioTestConfig, OutputFormat, RecordingValidator, SyncDetector, SyncMarker,
    SyncMarkerType, SyncTestConfig, TestConfig, TestPattern, VideoTestConfig,
};
use std::time::Duration;

#[test]
fn test_video_config_creation() {
    let video_config = VideoTestConfig {
        width: 1920,
        height: 1080,
        frame_rate: 30,
        pixel_format: ffmpeg::format::Pixel::NV12,
        pattern: TestPattern::SmpteColorBars,
    };

    assert_eq!(video_config.width, 1920);
    assert_eq!(video_config.height, 1080);
    assert_eq!(video_config.frame_rate, 30);
}

#[test]
fn test_video_config_builder_pattern() {
    let config = VideoTestConfig::default()
        .with_resolution(1280, 720)
        .with_frame_rate(60)
        .with_pixel_format(ffmpeg::format::Pixel::BGRA)
        .with_pattern(TestPattern::Checkerboard);

    assert_eq!(config.width, 1280);
    assert_eq!(config.height, 720);
    assert_eq!(config.frame_rate, 60);
}

#[test]
fn test_video_patterns_enum() {
    let patterns = [
        TestPattern::SmpteColorBars,
        TestPattern::ColorGradient,
        TestPattern::FrameCounter,
        TestPattern::Checkerboard,
        TestPattern::SolidColor { r: 255, g: 0, b: 0 },
        TestPattern::Random,
    ];

    for pattern in patterns {
        let config = VideoTestConfig::default().with_pattern(pattern);
        assert!(config.frame_rate > 0);
    }
}

#[test]
fn test_sync_event_generation() {
    let config = SyncTestConfig {
        video_fps: 30,
        audio_sample_rate: 48000,
        sync_interval_ms: 1000,
        duration: Duration::from_secs(5),
    };

    let events = config.generate_sync_events();

    assert_eq!(events.len(), 5);
    assert_eq!(events[0].expected_time_ms, 0.0);
    assert_eq!(events[1].expected_time_ms, 1000.0);
    assert_eq!(events[2].expected_time_ms, 2000.0);

    assert_eq!(events[0].frame_number, 0);
    assert_eq!(events[1].frame_number, 30);
    assert_eq!(events[2].frame_number, 60);

    assert_eq!(events[0].audio_sample, 0);
    assert_eq!(events[1].audio_sample, 48000);
}

#[test]
fn test_sync_detector_flash_detection() {
    let detector = SyncDetector::new(30, 48000);

    let bright_frame: Vec<u8> = vec![255; 1920 * 1080];
    assert!(detector.detect_flash_in_frame(&bright_frame, 1920, 1080));

    let dark_frame: Vec<u8> = vec![16; 1920 * 1080];
    assert!(!detector.detect_flash_in_frame(&dark_frame, 1920, 1080));

    let medium_frame: Vec<u8> = vec![128; 1920 * 1080];
    assert!(!detector.detect_flash_in_frame(&medium_frame, 1920, 1080));
}

#[test]
fn test_sync_detector_beep_detection() {
    let detector = SyncDetector::new(30, 48000);

    let loud_samples: Vec<f32> = vec![0.5; 4800];
    assert!(
        detector
            .detect_beep_in_audio(&loud_samples, 48000)
            .is_some()
    );

    let silent_samples: Vec<f32> = vec![0.0; 4800];
    assert!(
        detector
            .detect_beep_in_audio(&silent_samples, 48000)
            .is_none()
    );

    let quiet_samples: Vec<f32> = vec![0.1; 4800];
    assert!(
        detector
            .detect_beep_in_audio(&quiet_samples, 48000)
            .is_none()
    );
}

#[test]
fn test_sync_analysis() {
    use cap_recording::test_sources::{DetectedSyncEvent, SyncAnalysisResult};

    let events = vec![
        DetectedSyncEvent {
            expected_time_ms: 0.0,
            video_detected_ms: Some(0.0),
            audio_detected_ms: Some(5.0),
            offset_ms: 5.0,
        },
        DetectedSyncEvent {
            expected_time_ms: 1000.0,
            video_detected_ms: Some(1000.0),
            audio_detected_ms: Some(1010.0),
            offset_ms: 10.0,
        },
        DetectedSyncEvent {
            expected_time_ms: 2000.0,
            video_detected_ms: Some(2000.0),
            audio_detected_ms: Some(2015.0),
            offset_ms: 15.0,
        },
    ];

    let result = SyncAnalysisResult::new(events, 50.0);

    assert_eq!(result.average_offset_ms, 10.0);
    assert_eq!(result.max_offset_ms, 15.0);
    assert_eq!(result.min_offset_ms, 5.0);
    assert!(result.sync_ok);
    assert!(result.is_within_tolerance(50.0));
    assert!(!result.is_within_tolerance(10.0));
}

#[test]
fn test_validator_frame_sequence() {
    let config = TestConfig::default();
    let validator = RecordingValidator::new(&config);

    let sequential = vec![0, 1, 2, 3, 4, 5];
    let result = validator.verify_frame_sequence(&sequential);
    assert!(result.is_sequential);
    assert_eq!(result.dropped_count, 0);
    assert_eq!(result.duplicate_count, 0);

    let with_gap = vec![0, 1, 2, 5, 6, 7];
    let result = validator.verify_frame_sequence(&with_gap);
    assert!(!result.is_sequential);
    assert_eq!(result.dropped_count, 2);
    assert_eq!(result.gaps, vec![(3, 4)]);

    let with_duplicate = vec![0, 1, 2, 2, 3, 4];
    let result = validator.verify_frame_sequence(&with_duplicate);
    assert!(!result.is_sequential);
    assert_eq!(result.duplicate_count, 1);
}

#[test]
fn test_validator_expected_frame_count() {
    let config = TestConfig {
        video: Some(VideoTestConfig {
            width: 1920,
            height: 1080,
            frame_rate: 30,
            pixel_format: ffmpeg::format::Pixel::NV12,
            pattern: TestPattern::FrameCounter,
        }),
        audio: None,
        duration: Duration::from_secs(5),
        output_format: OutputFormat::Mp4,
    };

    let validator = RecordingValidator::new(&config);
    assert_eq!(validator.expected_frame_count(), 150);
}

#[test]
fn test_validation_result_summary() {
    use cap_recording::test_sources::ValidationResult;

    let result = ValidationResult {
        frame_count_ok: true,
        expected_frames: 150,
        actual_frames: 148,
        duration_ok: true,
        expected_duration: Duration::from_secs(5),
        actual_duration: Duration::from_secs_f64(4.93),
        av_sync_offset_ms: 12.5,
        av_sync_ok: true,
        dropped_frames: 2,
        fragment_integrity: true,
        fragments_checked: 2,
        fragments_valid: 2,
        errors: vec![],
    };

    assert!(result.is_valid());

    let summary = result.summary();
    assert!(summary.contains("148/150"));
    assert!(summary.contains("12.5ms"));
    assert!(summary.contains("Dropped frames: 2"));
}

#[test]
fn test_test_config_presets() {
    let common = cap_recording::test_sources::common_test_configs();
    assert!(!common.is_empty());

    for config in &common {
        assert!(config.video.is_some() || config.audio.is_some());
        assert!(config.duration.as_millis() > 0);
    }
}

#[test]
fn test_video_config_presets() {
    let fhd = VideoTestConfig::fhd_1080p();
    assert_eq!(fhd.width, 1920);
    assert_eq!(fhd.height, 1080);
    assert_eq!(fhd.frame_rate, 30);

    let uhd = VideoTestConfig::uhd_4k();
    assert_eq!(uhd.width, 3840);
    assert_eq!(uhd.height, 2160);
    assert_eq!(uhd.frame_rate, 30);

    let ultrawide = VideoTestConfig::ultrawide_1440();
    assert_eq!(ultrawide.width, 3440);
    assert_eq!(ultrawide.height, 1440);

    let macbook = VideoTestConfig::macbook_pro_16_promotion();
    assert_eq!(macbook.width, 3456);
    assert_eq!(macbook.height, 2234);
    assert_eq!(macbook.frame_rate, 120);
}

#[test]
fn test_audio_config_presets() {
    let mono = AudioTestConfig::broadcast_mono();
    assert_eq!(mono.sample_rate, 48000);
    assert_eq!(mono.channels, 1);

    let stereo = AudioTestConfig::broadcast_stereo();
    assert_eq!(stereo.sample_rate, 48000);
    assert_eq!(stereo.channels, 2);

    let surround = AudioTestConfig::surround_5_1();
    assert_eq!(surround.sample_rate, 48000);
    assert_eq!(surround.channels, 6);
}

#[test]
fn test_audio_generators() {
    let generators = [
        AudioGenerator::SineWave { frequency: 440.0 },
        AudioGenerator::Chirp {
            start_freq: 100.0,
            end_freq: 1000.0,
        },
        AudioGenerator::WhiteNoise,
        AudioGenerator::Silence,
        AudioGenerator::TimestampBeeps {
            beep_interval_ms: 1000,
        },
        AudioGenerator::Square { frequency: 440.0 },
    ];

    for generator in generators {
        let config = AudioTestConfig {
            sample_rate: 48000,
            channels: 2,
            sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            generator,
        };

        assert_eq!(config.sample_rate, 48000);
    }
}

#[test]
fn test_output_formats() {
    let formats = [
        OutputFormat::Mp4,
        OutputFormat::FragmentedM4s {
            segment_duration: Duration::from_secs(3),
        },
        OutputFormat::OggOpus,
    ];

    for format in formats {
        let config = TestConfig {
            video: Some(VideoTestConfig::default()),
            audio: Some(AudioTestConfig::default()),
            duration: Duration::from_secs(1),
            output_format: format,
        };

        assert!(config.video.is_some());
    }
}

#[test]
fn test_sync_marker_types() {
    let video_marker = SyncMarker {
        marker_type: SyncMarkerType::VideoFlash,
        time_ms: 1000.0,
        frame_number: Some(30),
        sample_number: None,
    };
    assert_eq!(video_marker.marker_type, SyncMarkerType::VideoFlash);

    let audio_marker = SyncMarker {
        marker_type: SyncMarkerType::AudioBeep,
        time_ms: 1000.0,
        frame_number: None,
        sample_number: Some(48000),
    };
    assert_eq!(audio_marker.marker_type, SyncMarkerType::AudioBeep);

    let combined = SyncMarker {
        marker_type: SyncMarkerType::Combined,
        time_ms: 1000.0,
        frame_number: Some(30),
        sample_number: Some(48000),
    };
    assert_eq!(combined.marker_type, SyncMarkerType::Combined);
}

#[test]
fn test_time_conversions() {
    use cap_recording::test_sources::{
        frame_number_to_time_ms, sample_number_to_time_ms, time_ms_to_frame_number,
        time_ms_to_sample_number,
    };

    assert_eq!(frame_number_to_time_ms(30, 30), 1000.0);
    assert_eq!(frame_number_to_time_ms(60, 60), 1000.0);
    assert_eq!(frame_number_to_time_ms(0, 30), 0.0);

    assert_eq!(sample_number_to_time_ms(48000, 48000), 1000.0);
    assert_eq!(sample_number_to_time_ms(44100, 44100), 1000.0);

    assert_eq!(time_ms_to_frame_number(1000.0, 30), 30);
    assert_eq!(time_ms_to_frame_number(1000.0, 60), 60);

    assert_eq!(time_ms_to_sample_number(1000.0, 48000), 48000);
    assert_eq!(time_ms_to_sample_number(1000.0, 44100), 44100);
}

#[test]
fn test_sync_config_helpers() {
    let config = SyncTestConfig {
        video_fps: 30,
        audio_sample_rate: 48000,
        sync_interval_ms: 1000,
        duration: Duration::from_secs(5),
    };

    assert_eq!(config.frames_per_sync_interval(), 30);
    assert_eq!(config.samples_per_sync_interval(), 48000);
}

#[test]
fn test_file_size_estimation() {
    use cap_recording::test_sources::calculate_expected_file_size;

    let config = TestConfig {
        video: Some(VideoTestConfig::fhd_1080p()),
        audio: Some(AudioTestConfig::broadcast_stereo()),
        duration: Duration::from_secs(5),
        output_format: OutputFormat::Mp4,
    };

    let size = calculate_expected_file_size(&config);
    assert!(size > 0);
    assert!(size < 100_000_000);
}

#[test]
fn test_video_only_config() {
    let config = TestConfig {
        video: Some(VideoTestConfig::fhd_1080p()),
        audio: None,
        duration: Duration::from_secs(1),
        output_format: OutputFormat::Mp4,
    };

    let validator = RecordingValidator::new(&config);
    assert!(validator.expected_frame_count() > 0);
}

#[test]
fn test_audio_only_config() {
    let config = TestConfig {
        video: None,
        audio: Some(AudioTestConfig::broadcast_stereo()),
        duration: Duration::from_secs(1),
        output_format: OutputFormat::OggOpus,
    };

    let validator = RecordingValidator::new(&config);
    assert_eq!(validator.expected_frame_count(), 0);
}

#[test]
fn test_comprehensive_config_matrix() {
    let configs = cap_recording::test_sources::comprehensive_test_configs();

    assert!(configs.len() > 20, "Should have many comprehensive configs");

    let has_4k = configs.iter().any(|c| {
        c.video
            .as_ref()
            .map_or(false, |v| v.width == 3840 && v.height == 2160)
    });
    assert!(has_4k, "Should include 4K resolution");

    let has_ultrawide = configs.iter().any(|c| {
        c.video
            .as_ref()
            .map_or(false, |v| v.width == 3440 && v.height == 1440)
    });
    assert!(has_ultrawide, "Should include ultrawide resolution");

    let has_60fps = configs
        .iter()
        .any(|c| c.video.as_ref().map_or(false, |v| v.frame_rate >= 60));
    assert!(has_60fps, "Should include 60fps or higher");
}

#[test]
fn test_resolution_presets() {
    let hd = VideoTestConfig::hd_720p();
    assert_eq!(hd.width, 1280);
    assert_eq!(hd.height, 720);

    let qhd = VideoTestConfig::qhd_1440p();
    assert_eq!(qhd.width, 2560);
    assert_eq!(qhd.height, 1440);

    let webcam_hd = VideoTestConfig::webcam_hd();
    assert_eq!(webcam_hd.width, 1280);
    assert_eq!(webcam_hd.height, 720);
    assert_eq!(webcam_hd.frame_rate, 30);

    let webcam_4k = VideoTestConfig::webcam_4k();
    assert_eq!(webcam_4k.width, 3840);
    assert_eq!(webcam_4k.height, 2160);
}

#[test]
fn test_sync_detector_with_threshold() {
    let detector = SyncDetector::new(30, 48000)
        .with_flash_threshold(180)
        .with_beep_threshold(0.2);

    let borderline_frame: Vec<u8> = vec![190; 1920 * 1080];
    assert!(detector.detect_flash_in_frame(&borderline_frame, 1920, 1080));

    let below_threshold_frame: Vec<u8> = vec![170; 1920 * 1080];
    assert!(!detector.detect_flash_in_frame(&below_threshold_frame, 1920, 1080));
}

#[test]
fn test_empty_sync_analysis() {
    use cap_recording::test_sources::SyncAnalysisResult;

    let result = SyncAnalysisResult::new(vec![], 50.0);
    assert!(!result.sync_ok || result.events.is_empty());
}

#[test]
fn test_validation_result_with_errors() {
    use cap_recording::test_sources::ValidationResult;

    let result = ValidationResult {
        frame_count_ok: true,
        expected_frames: 150,
        actual_frames: 150,
        duration_ok: true,
        expected_duration: Duration::from_secs(5),
        actual_duration: Duration::from_secs(5),
        av_sync_offset_ms: 0.0,
        av_sync_ok: true,
        dropped_frames: 0,
        fragment_integrity: true,
        fragments_checked: 2,
        fragments_valid: 2,
        errors: vec!["Test error".to_string()],
    };

    assert!(!result.is_valid());
}

#[test]
fn test_frame_sequence_empty() {
    let config = TestConfig::default();
    let validator = RecordingValidator::new(&config);

    let empty: Vec<u64> = vec![];
    let result = validator.verify_frame_sequence(&empty);
    assert_eq!(result.total_frames, 0);
}

#[test]
fn test_frame_sequence_single() {
    let config = TestConfig::default();
    let validator = RecordingValidator::new(&config);

    let single = vec![0];
    let result = validator.verify_frame_sequence(&single);
    assert!(result.is_sequential);
    assert_eq!(result.total_frames, 1);
}
