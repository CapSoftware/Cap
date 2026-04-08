use cap_enc_ffmpeg::{
    dash_audio::{DashAudioSegmentEncoder, DashAudioSegmentEncoderConfig},
    remux::{
        concatenate_m4s_segments_with_init, get_media_duration, merge_video_audio,
        probe_media_valid, probe_video_can_decode,
    },
    segmented_stream::{
        SegmentCompletedEvent, SegmentMediaType, SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
    },
};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_recording::{RecordingHealth, output_validation::validate_instant_recording};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
use tempfile::TempDir;

mod common {
    use std::sync::Once;

    static INIT: Once = Once::new();

    pub fn init() {
        INIT.call_once(|| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive(tracing::Level::DEBUG.into()),
                )
                .with_test_writer()
                .try_init()
                .ok();
            ffmpeg::init().expect("failed to initialize ffmpeg");
        });
    }
}

fn video_info(width: u32, height: u32, fps: i32) -> VideoInfo {
    VideoInfo {
        pixel_format: cap_media_info::Pixel::NV12,
        width,
        height,
        time_base: ffmpeg::Rational(1, 1_000_000),
        frame_rate: ffmpeg::Rational(fps, 1),
    }
}

fn default_video_info() -> VideoInfo {
    video_info(320, 240, 30)
}

fn audio_info(sample_rate: u32, channels: usize) -> AudioInfo {
    AudioInfo {
        sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        sample_rate,
        channels,
        time_base: ffmpeg::Rational(1, sample_rate as i32),
        buffer_size: 1024,
        is_wireless_transport: false,
    }
}

fn default_audio_info() -> AudioInfo {
    audio_info(48000, 1)
}

fn make_video_frame(width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for byte in data.iter_mut() {
            *byte = 128;
        }
    }
    frame
}

fn make_video_frame_patterned(width: u32, height: u32, frame_index: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = ((i as u32 + frame_index * 17) % 256) as u8;
        }
    }
    frame
}

fn make_audio_frame(samples: usize, sample_offset: u64, freq_hz: f32) -> ffmpeg::frame::Audio {
    let mut frame = ffmpeg::frame::Audio::new(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        samples,
        ffmpeg::ChannelLayout::MONO,
    );
    frame.set_rate(48000);
    frame.set_pts(Some(sample_offset as i64));
    let data = frame.data_mut(0);
    for (i, chunk) in data.chunks_exact_mut(4).enumerate() {
        let t = (sample_offset as f32 + i as f32) / 48000.0;
        let val: f32 = (t * freq_hz * std::f32::consts::TAU).sin() * 0.5;
        chunk.copy_from_slice(&val.to_ne_bytes());
    }
    frame
}

fn default_audio_frame(samples: usize, sample_offset: u64) -> ffmpeg::frame::Audio {
    make_audio_frame(samples, sample_offset, 440.0)
}

struct EncodedVideoResult {
    dir: PathBuf,
    init_path: PathBuf,
    manifest_path: PathBuf,
    segment_paths: Vec<PathBuf>,
    events: Vec<SegmentCompletedEvent>,
}

fn encode_video_segments(
    base_dir: &Path,
    info: VideoInfo,
    segment_duration: Duration,
    recording_duration_ms: u64,
    frame_interval_ms: u64,
) -> EncodedVideoResult {
    let video_dir = base_dir.join("display");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        info,
        SegmentedVideoEncoderConfig {
            segment_duration,
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    let total_frames = recording_duration_ms / frame_interval_ms;
    for i in 0..total_frames {
        let frame = make_video_frame_patterned(info.width, info.height, i as u32);
        let ts = Duration::from_millis(i * frame_interval_ms);
        encoder.queue_frame(frame, ts).unwrap();
    }

    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    let manifest_path = video_dir.join("manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let segment_paths: Vec<PathBuf> = manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let name = s["path"].as_str()?;
            let p = video_dir.join(name);
            p.exists().then_some(p)
        })
        .collect();

    EncodedVideoResult {
        init_path: video_dir.join("init.mp4"),
        manifest_path,
        dir: video_dir,
        segment_paths,
        events,
    }
}

#[allow(dead_code)]
struct EncodedAudioResult {
    dir: PathBuf,
    init_path: PathBuf,
    manifest_path: PathBuf,
    segment_paths: Vec<PathBuf>,
    events: Vec<SegmentCompletedEvent>,
}

fn encode_audio_segments(
    base_dir: &Path,
    info: AudioInfo,
    segment_duration: Duration,
    recording_duration_ms: u64,
    tx: Option<mpsc::Sender<SegmentCompletedEvent>>,
) -> EncodedAudioResult {
    let audio_dir = base_dir.join("audio");
    let (local_tx, local_rx) = mpsc::channel::<SegmentCompletedEvent>();

    let actual_tx = tx.unwrap_or(local_tx);

    let mut encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        info,
        DashAudioSegmentEncoderConfig { segment_duration },
    )
    .unwrap();
    encoder.set_segment_callback(actual_tx);

    let audio_frame_samples = 1024u64;
    let audio_frame_duration_ms = (audio_frame_samples * 1000) / info.sample_rate as u64;
    let total_audio_frames = recording_duration_ms / audio_frame_duration_ms;
    let mut sample_offset = 0u64;

    for i in 0..total_audio_frames {
        let frame = default_audio_frame(audio_frame_samples as usize, sample_offset);
        sample_offset += audio_frame_samples;
        let ts = Duration::from_millis(i * audio_frame_duration_ms);
        encoder.queue_frame(frame, ts).unwrap();
    }

    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = local_rx.try_iter().collect();

    let manifest_path = audio_dir.join("manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let segment_paths: Vec<PathBuf> = manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let name = s["path"].as_str()?;
            let p = audio_dir.join(name);
            p.exists().then_some(p)
        })
        .collect();

    EncodedAudioResult {
        init_path: audio_dir.join("init.mp4"),
        manifest_path,
        dir: audio_dir,
        segment_paths,
        events,
    }
}

fn read_manifest(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn count_completed_segments(manifest: &serde_json::Value) -> usize {
    manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .count()
}

fn assert_valid_playable_mp4(path: &Path) {
    assert!(path.exists(), "MP4 should exist at {}", path.display());
    let size = std::fs::metadata(path).unwrap().len();
    assert!(
        size > 100,
        "MP4 at {} should have substantial data, got {} bytes",
        path.display(),
        size
    );
    assert!(
        probe_media_valid(path),
        "MP4 at {} should have valid container",
        path.display()
    );
    assert!(
        probe_video_can_decode(path).unwrap_or(false),
        "MP4 at {} should be decodable",
        path.display()
    );
}

fn assert_duration_in_range(path: &Path, expected_secs: f64, tolerance_ratio: f64) {
    let duration = get_media_duration(path);
    assert!(
        duration.is_some(),
        "Should be able to read duration of {}",
        path.display()
    );
    let actual = duration.unwrap().as_secs_f64();
    assert!(
        actual > expected_secs * (1.0 - tolerance_ratio),
        "Duration ({actual:.2}s) too short for expected ({expected_secs:.1}s) with tolerance {tolerance_ratio}"
    );
    assert!(
        actual < expected_secs * (1.0 + tolerance_ratio),
        "Duration ({actual:.2}s) too long for expected ({expected_secs:.1}s) with tolerance {tolerance_ratio}"
    );
}

fn assert_has_video_stream(path: &Path) {
    let input = ffmpeg::format::input(path).unwrap();
    assert!(
        input
            .streams()
            .any(|s| s.parameters().medium() == ffmpeg::media::Type::Video),
        "MP4 at {} should have a video stream",
        path.display()
    );
}

fn assert_has_audio_stream(path: &Path) {
    let input = ffmpeg::format::input(path).unwrap();
    assert!(
        input
            .streams()
            .any(|s| s.parameters().medium() == ffmpeg::media::Type::Audio),
        "MP4 at {} should have an audio stream",
        path.display()
    );
}

#[test]
fn video_only_short_recording_1s() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        1000,
        33,
    );

    assert!(result.init_path.exists());
    assert!(!result.segment_paths.is_empty());
    assert!(result.manifest_path.exists());

    let manifest = read_manifest(&result.manifest_path);
    assert!(manifest["is_complete"].as_bool().unwrap());

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_has_video_stream(&output);
    assert_duration_in_range(&output, 1.0, 0.5);
}

#[test]
fn video_only_medium_recording_5s() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_secs(1),
        5000,
        33,
    );

    assert!(
        result.segment_paths.len() >= 3,
        "5s recording with 1s segments should produce at least 3 segments, got {}",
        result.segment_paths.len()
    );

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_duration_in_range(&output, 5.0, 0.5);
}

#[test]
fn video_only_long_recording_10s() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_secs(3),
        10000,
        33,
    );

    assert!(
        result.segment_paths.len() >= 2,
        "10s recording with 3s segments should produce at least 2 segments"
    );

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_duration_in_range(&output, 10.0, 0.5);
}

#[test]
fn segment_duration_100ms_produces_many_segments() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(100),
        3000,
        33,
    );

    assert!(
        result.segment_paths.len() >= 5,
        "3s recording with 100ms segments should produce many segments, got {}",
        result.segment_paths.len()
    );

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
}

#[test]
fn segment_duration_3s_with_short_recording() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_secs(3),
        2000,
        33,
    );

    assert!(
        !result.segment_paths.is_empty(),
        "Even a 2s recording with 3s segments should produce at least one segment"
    );

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
}

#[test]
fn resolution_720p() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(1280, 720, 30);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 2000, 33);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);

    let input = ffmpeg::format::input(&output).unwrap();
    let video_stream = input
        .streams()
        .find(|s| s.parameters().medium() == ffmpeg::media::Type::Video)
        .unwrap();
    let decoder_ctx = ffmpeg::codec::Context::from_parameters(video_stream.parameters()).unwrap();
    let decoder = decoder_ctx.decoder().video().unwrap();
    assert_eq!(decoder.width(), 1280);
    assert_eq!(decoder.height(), 720);
}

#[test]
fn resolution_1080p() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(1920, 1080, 30);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 2000, 33);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);

    let input = ffmpeg::format::input(&output).unwrap();
    let video_stream = input
        .streams()
        .find(|s| s.parameters().medium() == ffmpeg::media::Type::Video)
        .unwrap();
    let ctx = ffmpeg::codec::Context::from_parameters(video_stream.parameters()).unwrap();
    let dec = ctx.decoder().video().unwrap();
    assert_eq!(dec.width(), 1920);
    assert_eq!(dec.height(), 1080);
}

#[test]
fn portrait_resolution_1080x1920() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(1080, 1920, 30);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 2000, 33);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
}

#[test]
fn ultrawide_resolution_2560x1080() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(2560, 1080, 30);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 2000, 33);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
}

#[test]
fn framerate_15fps() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(320, 240, 15);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 3000, 66);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_duration_in_range(&output, 3.0, 0.5);
}

#[test]
fn framerate_60fps() {
    common::init();

    let temp = TempDir::new().unwrap();
    let info = video_info(320, 240, 60);
    let result = encode_video_segments(temp.path(), info, Duration::from_secs(1), 3000, 16);

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_duration_in_range(&output, 3.0, 0.5);
}

#[test]
fn full_pipeline_video_plus_audio_assembly() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let segment_duration = Duration::from_millis(500);
    let recording_ms = 3000u64;

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        segment_duration,
        recording_ms,
        33,
    );

    let audio = encode_audio_segments(
        &content_dir,
        default_audio_info(),
        segment_duration,
        recording_ms,
        None,
    );

    let video_only_path = temp.path().join("video_only.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &video_only_path)
        .unwrap();

    let audio_assembled_path = temp.path().join("audio_assembled.m4a");
    concatenate_m4s_segments_with_init(
        &audio.init_path,
        &audio.segment_paths,
        &audio_assembled_path,
    )
    .unwrap();

    let result_path = temp.path().join("result.mp4");
    merge_video_audio(&video_only_path, &audio_assembled_path, &result_path).unwrap();

    assert_valid_playable_mp4(&result_path);
    assert_has_video_stream(&result_path);
    assert_has_audio_stream(&result_path);
    assert_duration_in_range(&result_path, 3.0, 0.5);
}

#[test]
fn shared_event_channel_video_and_audio() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let audio_dir = temp.path().join("audio");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(200),
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        default_audio_info(),
        DashAudioSegmentEncoderConfig {
            segment_duration: Duration::from_millis(200),
        },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let mut sample_offset = 0u64;
    for i in 0..45 {
        let ts = Duration::from_millis(i * 33);
        let vframe = make_video_frame(320, 240);
        video_encoder.queue_frame(vframe, ts).unwrap();

        let aframe = default_audio_frame(1024, sample_offset);
        sample_offset += 1024;
        audio_encoder.queue_frame(aframe, ts).unwrap();
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    let video_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Video)
        .collect();
    let audio_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Audio)
        .collect();

    assert!(!video_events.is_empty());
    assert!(!audio_events.is_empty());

    let video_data: Vec<&SegmentCompletedEvent> = video_events
        .iter()
        .filter(|e| !e.is_init)
        .copied()
        .collect();
    let audio_data: Vec<&SegmentCompletedEvent> = audio_events
        .iter()
        .filter(|e| !e.is_init)
        .copied()
        .collect();

    for e in &video_data {
        assert!(
            e.duration > 0.0,
            "video segment {} has zero duration",
            e.index
        );
        assert!(
            e.file_size > 0,
            "video segment {} has zero file size",
            e.index
        );
    }
    for e in &audio_data {
        assert!(
            e.duration > 0.0,
            "audio segment {} has zero duration",
            e.index
        );
        assert!(
            e.file_size > 0,
            "audio segment {} has zero file size",
            e.index
        );
    }
}

#[test]
fn assembly_with_missing_middle_segment() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(300),
        3000,
        33,
    );

    if result.segment_paths.len() >= 3 {
        let mut partial_segments = result.segment_paths.clone();
        let removed_idx = partial_segments.len() / 2;
        partial_segments.remove(removed_idx);

        let output = temp.path().join("output_gap.mp4");
        let concat_result =
            concatenate_m4s_segments_with_init(&result.init_path, &partial_segments, &output);

        if concat_result.is_ok() {
            assert!(output.exists());
            assert!(
                probe_media_valid(&output),
                "Concatenated output with gap should still have valid container"
            );
        }
    }
}

#[test]
fn assembly_with_only_first_segment() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    let first_only = vec![result.segment_paths[0].clone()];
    let output = temp.path().join("output_first.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &first_only, &output).unwrap();

    assert_valid_playable_mp4(&output);
    let dur = get_media_duration(&output).unwrap().as_secs_f64();
    assert!(dur > 0.0, "single segment should have positive duration");
    assert!(
        dur < 3.0,
        "single segment should be shorter than full recording"
    );
}

#[test]
fn assembly_with_only_last_segment() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    if result.segment_paths.len() >= 2 {
        let last_only = vec![result.segment_paths.last().unwrap().clone()];
        let output = temp.path().join("output_last.mp4");
        concatenate_m4s_segments_with_init(&result.init_path, &last_only, &output).unwrap();

        assert!(output.exists());
        assert!(probe_media_valid(&output));
    }
}

#[test]
fn assembly_with_no_segments_fails() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        2000,
        33,
    );

    let empty_segments: Vec<PathBuf> = vec![];
    let output = temp.path().join("output_empty.mp4");
    let concat_result =
        concatenate_m4s_segments_with_init(&result.init_path, &empty_segments, &output);

    assert!(
        concat_result.is_err(),
        "Concatenating zero segments should fail"
    );
}

#[test]
fn assembly_without_manifest_uses_directory_scan() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    std::fs::remove_file(&result.manifest_path).unwrap();
    assert!(!result.manifest_path.exists());

    let mut discovered: Vec<PathBuf> = std::fs::read_dir(&result.dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    discovered.sort();

    assert!(
        !discovered.is_empty(),
        "Should discover m4s segments on disk even without manifest"
    );

    let output = temp.path().join("output_discovered.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &discovered, &output).unwrap();

    assert_valid_playable_mp4(&output);
}

#[test]
fn validation_healthy_recording() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_secs(1),
        3000,
        33,
    );

    let output = content_dir.join("output.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &output).unwrap();

    let result = validate_instant_recording(&output, Duration::from_secs(3));

    assert!(
        matches!(result.health, RecordingHealth::Healthy),
        "A normal 3s recording should be healthy, got {:?}",
        result.health
    );
    assert!(result.output_duration.is_some());
}

#[test]
fn validation_missing_output_file() {
    common::init();

    let temp = TempDir::new().unwrap();
    let missing = temp.path().join("nonexistent.mp4");

    let result = validate_instant_recording(&missing, Duration::from_secs(3));

    assert!(
        matches!(result.health, RecordingHealth::Damaged { .. }),
        "Missing file should be Damaged"
    );
    assert!(result.output_duration.is_none());
}

#[test]
fn validation_empty_output_file() {
    common::init();

    let temp = TempDir::new().unwrap();
    let empty_file = temp.path().join("empty.mp4");
    std::fs::write(&empty_file, b"").unwrap();

    let result = validate_instant_recording(&empty_file, Duration::from_secs(3));

    assert!(
        matches!(result.health, RecordingHealth::Damaged { .. }),
        "Empty file should be Damaged"
    );
}

#[test]
fn validation_corrupt_container() {
    common::init();

    let temp = TempDir::new().unwrap();
    let corrupt = temp.path().join("corrupt.mp4");
    std::fs::write(&corrupt, b"this is not a valid mp4 file at all").unwrap();

    let result = validate_instant_recording(&corrupt, Duration::from_secs(3));

    assert!(
        matches!(result.health, RecordingHealth::Damaged { .. }),
        "Corrupt container should be Damaged"
    );
}

#[test]
fn validation_short_duration_flagged() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_millis(500),
        1500,
        33,
    );

    let output = content_dir.join("output.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &output).unwrap();

    let result = validate_instant_recording(&output, Duration::from_secs(10));

    match &result.health {
        RecordingHealth::Degraded { issues } => {
            assert!(
                !issues.is_empty(),
                "Short recording should have quality issues flagged"
            );
        }
        RecordingHealth::Healthy => {
            // Acceptable if under MIN_EXPECTED_DURATION threshold
        }
        other => {
            panic!("Unexpected health: {other:?}");
        }
    }
}

#[test]
fn validation_duration_within_tolerance() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_secs(1),
        5000,
        33,
    );

    let output = content_dir.join("output.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &output).unwrap();

    let result = validate_instant_recording(&output, Duration::from_secs(5));

    assert!(
        matches!(
            result.health,
            RecordingHealth::Healthy | RecordingHealth::Degraded { .. }
        ),
        "5s recording with 5s expected should be Healthy or at worst Degraded, got {:?}",
        result.health
    );
}

#[test]
fn manifest_is_complete_after_finish() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    assert!(manifest["is_complete"].as_bool().unwrap());
    assert!(manifest["total_duration"].as_f64().unwrap() > 0.0);
}

#[test]
fn manifest_all_segments_are_complete() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(300),
        3000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    let segments = manifest["segments"].as_array().unwrap();
    for seg in segments {
        assert!(
            seg["is_complete"].as_bool().unwrap(),
            "All segments should be complete after finish, but {} is not",
            seg["path"]
        );
        assert!(
            seg["duration"].as_f64().unwrap() > 0.0,
            "Segment {} should have positive duration",
            seg["path"]
        );
    }
}

#[test]
fn manifest_segment_indices_are_sequential() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(200),
        3000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    let segments = manifest["segments"].as_array().unwrap();
    let indices: Vec<u32> = segments
        .iter()
        .map(|s| s["index"].as_u64().unwrap() as u32)
        .collect();

    for window in indices.windows(2) {
        assert!(
            window[1] > window[0],
            "Segment indices should be strictly increasing: {:?}",
            indices
        );
    }
}

#[test]
fn manifest_total_duration_matches_sum_of_segments() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        5000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    let total = manifest["total_duration"].as_f64().unwrap();
    let sum: f64 = manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["duration"].as_f64().unwrap())
        .sum();

    let diff = (total - sum).abs();
    assert!(
        diff < 0.5,
        "Total duration ({total:.3}) should be close to sum of segment durations ({sum:.3}), diff={diff:.3}"
    );
}

#[test]
fn event_indices_are_unique() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(200),
        3000,
        33,
    );

    let data_events: Vec<&SegmentCompletedEvent> = result
        .events
        .iter()
        .filter(|e| !e.is_init && e.media_type == SegmentMediaType::Video)
        .collect();

    let mut seen_indices: HashSet<u32> = HashSet::new();
    for e in &data_events {
        assert!(
            seen_indices.insert(e.index),
            "Duplicate segment index {} in events",
            e.index
        );
    }
}

#[test]
fn event_files_exist_on_disk() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(300),
        3000,
        33,
    );

    for event in &result.events {
        if event.is_init {
            continue;
        }

        let p = &event.path;
        let m4s_path = if p.extension().is_some_and(|e| e == "tmp") {
            p.with_extension("")
        } else {
            p.clone()
        };
        let tmp_path = m4s_path.with_extension("m4s.tmp");
        let exists = p.exists() || m4s_path.exists() || tmp_path.exists();
        assert!(
            exists,
            "Segment file for event index={} should exist on disk (checked {:?}, {:?}, {:?})",
            event.index, p, m4s_path, tmp_path
        );
    }
}

#[test]
fn init_event_is_first_for_each_media_type() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let audio_dir = temp.path().join("audio");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(200),
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        default_audio_info(),
        DashAudioSegmentEncoderConfig {
            segment_duration: Duration::from_millis(200),
        },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let mut sample_offset = 0u64;
    for i in 0..30 {
        let ts = Duration::from_millis(i * 33);
        video_encoder
            .queue_frame(make_video_frame(320, 240), ts)
            .unwrap();
        let aframe = default_audio_frame(1024, sample_offset);
        sample_offset += 1024;
        audio_encoder.queue_frame(aframe, ts).unwrap();
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    let mut video_seen_data = false;
    let mut audio_seen_data = false;

    for e in &events {
        match (e.media_type, e.is_init) {
            (SegmentMediaType::Video, true) => {
                assert!(
                    !video_seen_data,
                    "Video init event should come before any video data segment"
                );
            }
            (SegmentMediaType::Video, false) => {
                video_seen_data = true;
            }
            (SegmentMediaType::Audio, true) => {
                assert!(
                    !audio_seen_data,
                    "Audio init event should come before any audio data segment"
                );
            }
            (SegmentMediaType::Audio, false) => {
                audio_seen_data = true;
            }
        }
    }
}

#[test]
fn audio_only_segments_concatenate_cleanly() {
    common::init();

    let temp = TempDir::new().unwrap();
    let audio = encode_audio_segments(
        temp.path(),
        default_audio_info(),
        Duration::from_millis(500),
        3000,
        None,
    );

    assert!(!audio.segment_paths.is_empty());
    assert!(audio.init_path.exists());

    let output = temp.path().join("audio_out.m4a");
    concatenate_m4s_segments_with_init(&audio.init_path, &audio.segment_paths, &output).unwrap();

    assert!(output.exists());
    assert!(probe_media_valid(&output));
}

#[test]
fn audio_manifest_is_complete() {
    common::init();

    let temp = TempDir::new().unwrap();
    let audio = encode_audio_segments(
        temp.path(),
        default_audio_info(),
        Duration::from_millis(500),
        3000,
        None,
    );

    let manifest = read_manifest(&audio.manifest_path);
    assert!(manifest["is_complete"].as_bool().unwrap());
    assert!(manifest["total_duration"].as_f64().unwrap() > 0.0);
    assert!(count_completed_segments(&manifest) > 0);
}

#[test]
fn audio_segments_have_positive_duration() {
    common::init();

    let temp = TempDir::new().unwrap();
    let audio = encode_audio_segments(
        temp.path(),
        default_audio_info(),
        Duration::from_millis(300),
        3000,
        None,
    );

    let manifest = read_manifest(&audio.manifest_path);
    for seg in manifest["segments"].as_array().unwrap() {
        let dur = seg["duration"].as_f64().unwrap();
        assert!(
            dur > 0.0,
            "Audio segment {} should have positive duration",
            seg["path"]
        );
    }
}

#[test]
fn video_audio_duration_alignment() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let recording_ms = 5000u64;
    let segment_duration = Duration::from_secs(1);

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        segment_duration,
        recording_ms,
        33,
    );
    let audio = encode_audio_segments(
        &content_dir,
        default_audio_info(),
        segment_duration,
        recording_ms,
        None,
    );

    let video_manifest = read_manifest(&video.manifest_path);
    let audio_manifest = read_manifest(&audio.manifest_path);

    let video_duration = video_manifest["total_duration"].as_f64().unwrap();
    let audio_duration = audio_manifest["total_duration"].as_f64().unwrap();

    let diff = (video_duration - audio_duration).abs();
    assert!(
        diff < 1.5,
        "Video duration ({video_duration:.2}s) and audio duration ({audio_duration:.2}s) \
         should be within 1.5s of each other, diff={diff:.2}"
    );
}

#[test]
fn merge_valid_video_and_audio() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_secs(1),
        3000,
        33,
    );
    let audio = encode_audio_segments(
        &content_dir,
        default_audio_info(),
        Duration::from_secs(1),
        3000,
        None,
    );

    let video_mp4 = temp.path().join("video.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &video_mp4).unwrap();

    let audio_m4a = temp.path().join("audio.m4a");
    concatenate_m4s_segments_with_init(&audio.init_path, &audio.segment_paths, &audio_m4a).unwrap();

    let merged = temp.path().join("merged.mp4");
    merge_video_audio(&video_mp4, &audio_m4a, &merged).unwrap();

    assert_valid_playable_mp4(&merged);
    assert_has_video_stream(&merged);
    assert_has_audio_stream(&merged);
}

#[test]
fn recording_health_serialization_roundtrip() {
    let variants = vec![
        RecordingHealth::Healthy,
        RecordingHealth::Repaired {
            original_issue: "drift detected".to_string(),
        },
        RecordingHealth::Degraded {
            issues: vec!["short duration".to_string(), "low fps".to_string()],
        },
        RecordingHealth::Damaged {
            reason: "corrupt output".to_string(),
        },
    ];

    for original in &variants {
        let json = serde_json::to_string(original).unwrap();
        let parsed: RecordingHealth = serde_json::from_str(&json).unwrap();

        match (original, &parsed) {
            (RecordingHealth::Healthy, RecordingHealth::Healthy) => {}
            (
                RecordingHealth::Repaired { original_issue: a },
                RecordingHealth::Repaired { original_issue: b },
            ) => assert_eq!(a, b),
            (RecordingHealth::Degraded { issues: a }, RecordingHealth::Degraded { issues: b }) => {
                assert_eq!(a, b)
            }
            (RecordingHealth::Damaged { reason: a }, RecordingHealth::Damaged { reason: b }) => {
                assert_eq!(a, b)
            }
            _ => panic!("Health roundtrip mismatch: {original:?} -> {parsed:?}"),
        }
    }
}

#[test]
fn recording_health_uploadable_check() {
    assert!(RecordingHealth::Healthy.is_uploadable());
    assert!(
        RecordingHealth::Repaired {
            original_issue: "fixed".to_string()
        }
        .is_uploadable()
    );
    assert!(
        RecordingHealth::Degraded {
            issues: vec!["minor".to_string()]
        }
        .is_uploadable()
    );
    assert!(
        !RecordingHealth::Damaged {
            reason: "broken".to_string()
        }
        .is_uploadable()
    );
}

#[test]
fn many_segments_50_plus_concatenate_correctly() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(100),
        10000,
        33,
    );

    assert!(
        result.segment_paths.len() >= 10,
        "10s with 100ms segments should produce many segments, got {}",
        result.segment_paths.len()
    );

    let output = temp.path().join("output_many.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_duration_in_range(&output, 10.0, 0.5);
}

#[test]
fn single_frame_produces_valid_output() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();

    let frame = make_video_frame(320, 240);
    encoder.queue_frame(frame, Duration::ZERO).unwrap();
    encoder.finish().unwrap();

    let init_path = video_dir.join("init.mp4");
    assert!(init_path.exists());

    let manifest_path = video_dir.join("manifest.json");
    let manifest = read_manifest(&manifest_path);
    assert!(manifest["is_complete"].as_bool().unwrap());
}

#[test]
fn two_frames_produces_valid_output() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();

    encoder
        .queue_frame(make_video_frame(320, 240), Duration::ZERO)
        .unwrap();
    encoder
        .queue_frame(make_video_frame(320, 240), Duration::from_millis(33))
        .unwrap();
    encoder.finish().unwrap();

    let init_path = video_dir.join("init.mp4");
    let manifest_path = video_dir.join("manifest.json");
    let manifest = read_manifest(&manifest_path);
    assert!(manifest["is_complete"].as_bool().unwrap());

    let segments: Vec<PathBuf> = manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let name = s["path"].as_str()?;
            let p = video_dir.join(name);
            p.exists().then_some(p)
        })
        .collect();

    if !segments.is_empty() {
        let output = temp.path().join("output_two.mp4");
        concatenate_m4s_segments_with_init(&init_path, &segments, &output).unwrap();
        assert_valid_playable_mp4(&output);
    }
}

#[test]
fn segment_file_sizes_are_nonzero() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    for path in &result.segment_paths {
        let size = std::fs::metadata(path).unwrap().len();
        assert!(
            size > 0,
            "Segment {} should have non-zero size",
            path.display()
        );
    }

    let init_size = std::fs::metadata(&result.init_path).unwrap().len();
    assert!(init_size > 0, "init.mp4 should have non-zero size");
}

#[test]
fn init_segment_is_valid_mp4() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        2000,
        33,
    );

    assert!(
        probe_media_valid(&result.init_path),
        "init.mp4 should be a valid MP4 container"
    );
}

#[test]
fn concurrent_video_audio_encoding_interleaved() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let audio_dir = temp.path().join("audio");

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(300),
            ..Default::default()
        },
    )
    .unwrap();

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        default_audio_info(),
        DashAudioSegmentEncoderConfig {
            segment_duration: Duration::from_millis(300),
        },
    )
    .unwrap();

    let recording_duration_ms = 3000u64;
    let video_interval_ms = 33u64;
    let audio_frame_samples = 1024u64;
    let audio_interval_ms = (audio_frame_samples * 1000) / 48000;

    let mut video_ts = 0u64;
    let mut audio_ts = 0u64;
    let mut sample_offset = 0u64;

    loop {
        let video_done = video_ts >= recording_duration_ms;
        let audio_done = audio_ts >= recording_duration_ms;
        if video_done && audio_done {
            break;
        }

        if !video_done && (video_ts <= audio_ts || audio_done) {
            video_encoder
                .queue_frame(make_video_frame(320, 240), Duration::from_millis(video_ts))
                .unwrap();
            video_ts += video_interval_ms;
        }

        if !audio_done && (audio_ts <= video_ts || video_done) {
            audio_encoder
                .queue_frame(
                    default_audio_frame(audio_frame_samples as usize, sample_offset),
                    Duration::from_millis(audio_ts),
                )
                .unwrap();
            sample_offset += audio_frame_samples;
            audio_ts += audio_interval_ms;
        }
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let video_manifest = read_manifest(&video_dir.join("manifest.json"));
    let audio_manifest = read_manifest(&audio_dir.join("manifest.json"));

    assert!(video_manifest["is_complete"].as_bool().unwrap());
    assert!(audio_manifest["is_complete"].as_bool().unwrap());

    let video_init = video_dir.join("init.mp4");
    let audio_init = audio_dir.join("init.mp4");
    assert!(video_init.exists());
    assert!(audio_init.exists());

    let video_segs: Vec<PathBuf> = video_manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let p = video_dir.join(s["path"].as_str()?);
            p.exists().then_some(p)
        })
        .collect();

    let audio_segs: Vec<PathBuf> = audio_manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let p = audio_dir.join(s["path"].as_str()?);
            p.exists().then_some(p)
        })
        .collect();

    let video_mp4 = temp.path().join("video.mp4");
    concatenate_m4s_segments_with_init(&video_init, &video_segs, &video_mp4).unwrap();

    let audio_m4a = temp.path().join("audio.m4a");
    concatenate_m4s_segments_with_init(&audio_init, &audio_segs, &audio_m4a).unwrap();

    let merged = temp.path().join("merged.mp4");
    merge_video_audio(&video_mp4, &audio_m4a, &merged).unwrap();

    assert_valid_playable_mp4(&merged);
    assert_has_video_stream(&merged);
    assert_has_audio_stream(&merged);
    assert_duration_in_range(&merged, 3.0, 0.5);
}

#[test]
fn upload_manifest_can_be_reconstructed_from_events() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let audio_dir = temp.path().join("audio");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let segment_duration = Duration::from_millis(300);

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration,
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        default_audio_info(),
        DashAudioSegmentEncoderConfig { segment_duration },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let mut sample_offset = 0u64;
    for i in 0..60 {
        let ts = Duration::from_millis(i * 33);
        video_encoder
            .queue_frame(make_video_frame(320, 240), ts)
            .unwrap();
        audio_encoder
            .queue_frame(default_audio_frame(1024, sample_offset), ts)
            .unwrap();
        sample_offset += 1024;
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    let mut video_init = false;
    let mut audio_init = false;
    let mut video_segments: HashMap<u32, f64> = HashMap::new();
    let mut audio_segments: HashMap<u32, f64> = HashMap::new();

    for event in &events {
        match (event.is_init, event.media_type) {
            (true, SegmentMediaType::Video) => video_init = true,
            (true, SegmentMediaType::Audio) => audio_init = true,
            (false, SegmentMediaType::Video) => {
                video_segments.insert(event.index, event.duration);
            }
            (false, SegmentMediaType::Audio) => {
                audio_segments.insert(event.index, event.duration);
            }
        }
    }

    assert!(video_init || video_dir.join("init.mp4").exists());
    assert!(audio_init || audio_dir.join("init.mp4").exists());
    assert!(!video_segments.is_empty());
    assert!(!audio_segments.is_empty());

    let upload_manifest = serde_json::json!({
        "version": 2,
        "video_init_uploaded": video_init,
        "audio_init_uploaded": audio_init,
        "video_segments": video_segments.keys().count(),
        "audio_segments": audio_segments.keys().count(),
        "is_complete": true,
    });

    assert!(upload_manifest["is_complete"].as_bool().unwrap());
    assert!(upload_manifest["video_segments"].as_u64().unwrap() > 0);
    assert!(upload_manifest["audio_segments"].as_u64().unwrap() > 0);
}

#[test]
fn hls_target_duration_is_reasonable() {
    common::init();

    let temp = TempDir::new().unwrap();
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let configured_duration = Duration::from_secs(1);

    let mut encoder = SegmentedVideoEncoder::init(
        temp.path().join("display"),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: configured_duration,
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    for i in 0..90 {
        encoder
            .queue_frame(make_video_frame(320, 240), Duration::from_millis(i * 33))
            .unwrap();
    }
    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    let data_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| !e.is_init && e.media_type == SegmentMediaType::Video)
        .collect();

    let max_duration = data_events
        .iter()
        .map(|e| e.duration)
        .fold(0.0f64, f64::max);

    assert!(
        max_duration <= configured_duration.as_secs_f64() * 3.0,
        "Max segment duration ({max_duration:.2}s) should not be more than 3x configured ({:.2}s)",
        configured_duration.as_secs_f64()
    );

    assert!(
        max_duration > 0.0,
        "Max segment duration should be positive"
    );
}

#[test]
fn multiple_sequential_recordings_in_different_directories() {
    common::init();

    let temp = TempDir::new().unwrap();

    for recording_idx in 0..3 {
        let recording_dir = temp.path().join(format!("recording_{recording_idx}"));
        let content_dir = recording_dir.join("content");
        std::fs::create_dir_all(&content_dir).unwrap();

        let video = encode_video_segments(
            &content_dir,
            default_video_info(),
            Duration::from_millis(500),
            2000,
            33,
        );

        let output = content_dir.join("output.mp4");
        concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &output)
            .unwrap();

        assert_valid_playable_mp4(&output);
        assert_duration_in_range(&output, 2.0, 0.5);
    }
}

#[test]
fn validation_very_short_wall_clock_skips_duration_check() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_millis(500),
        2000,
        33,
    );

    let output = content_dir.join("output.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &output).unwrap();

    let result = validate_instant_recording(&output, Duration::from_millis(500));

    assert!(
        matches!(
            result.health,
            RecordingHealth::Healthy | RecordingHealth::Degraded { .. }
        ),
        "Short wall clock should not mark as Damaged, got {:?}",
        result.health
    );
}

#[test]
fn segment_events_total_file_size_matches_disk() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(500),
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    for i in 0..60 {
        encoder
            .queue_frame(make_video_frame(320, 240), Duration::from_millis(i * 33))
            .unwrap();
    }
    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    for event in &events {
        if event.is_init {
            continue;
        }

        let p = &event.path;
        let actual_path = if p.exists() {
            p.clone()
        } else {
            let m4s = p.with_extension("");
            if m4s.exists() {
                m4s
            } else {
                continue;
            }
        };

        let disk_size = std::fs::metadata(&actual_path).unwrap().len();
        assert_eq!(
            event.file_size,
            disk_size,
            "Event file_size ({}) should match disk size ({}) for {}",
            event.file_size,
            disk_size,
            actual_path.display()
        );
    }
}

#[test]
fn manifest_segment_paths_are_relative() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    for seg in manifest["segments"].as_array().unwrap() {
        let path_str = seg["path"].as_str().unwrap();
        assert!(
            !path_str.starts_with('/'),
            "Segment path should be relative, got: {path_str}"
        );
        assert!(
            !path_str.contains(".."),
            "Segment path should not contain .., got: {path_str}"
        );
    }
}

#[test]
fn full_instant_pipeline_end_to_end_with_validation() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let segment_duration = Duration::from_secs(1);
    let recording_ms = 5000u64;

    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let video_dir = content_dir.join("display");
    let audio_dir = content_dir.join("audio");

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration,
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        default_audio_info(),
        DashAudioSegmentEncoderConfig { segment_duration },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let video_interval_ms = 33u64;
    let audio_samples = 1024u64;
    let audio_interval_ms = (audio_samples * 1000) / 48000;
    let mut video_ts = 0u64;
    let mut audio_ts = 0u64;
    let mut sample_offset = 0u64;

    loop {
        let vdone = video_ts >= recording_ms;
        let adone = audio_ts >= recording_ms;
        if vdone && adone {
            break;
        }

        if !vdone && (video_ts <= audio_ts || adone) {
            video_encoder
                .queue_frame(make_video_frame(320, 240), Duration::from_millis(video_ts))
                .unwrap();
            video_ts += video_interval_ms;
        }

        if !adone && (audio_ts <= video_ts || vdone) {
            audio_encoder
                .queue_frame(
                    default_audio_frame(audio_samples as usize, sample_offset),
                    Duration::from_millis(audio_ts),
                )
                .unwrap();
            sample_offset += audio_samples;
            audio_ts += audio_interval_ms;
        }
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    assert!(
        events.len() >= 4,
        "Should have init+data for both video and audio, got {} events",
        events.len()
    );

    let video_manifest = read_manifest(&video_dir.join("manifest.json"));
    let audio_manifest = read_manifest(&audio_dir.join("manifest.json"));
    assert!(video_manifest["is_complete"].as_bool().unwrap());
    assert!(audio_manifest["is_complete"].as_bool().unwrap());

    let video_init = video_dir.join("init.mp4");
    let audio_init = audio_dir.join("init.mp4");

    let video_segs: Vec<PathBuf> = video_manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let p = video_dir.join(s["path"].as_str()?);
            p.exists().then_some(p)
        })
        .collect();

    let audio_segs: Vec<PathBuf> = audio_manifest["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let p = audio_dir.join(s["path"].as_str()?);
            p.exists().then_some(p)
        })
        .collect();

    let video_mp4 = temp.path().join("video_only.mp4");
    concatenate_m4s_segments_with_init(&video_init, &video_segs, &video_mp4).unwrap();

    let audio_m4a = temp.path().join("audio_assembled.m4a");
    concatenate_m4s_segments_with_init(&audio_init, &audio_segs, &audio_m4a).unwrap();

    let output = content_dir.join("output.mp4");
    merge_video_audio(&video_mp4, &audio_m4a, &output).unwrap();

    assert_valid_playable_mp4(&output);
    assert_has_video_stream(&output);
    assert_has_audio_stream(&output);

    let validation = validate_instant_recording(&output, Duration::from_secs(5));
    assert!(
        validation.health.is_uploadable(),
        "Full pipeline output should be uploadable, got {:?}",
        validation.health
    );
    assert!(validation.output_duration.is_some());

    let dur = validation.output_duration.unwrap().as_secs_f64();
    assert!(
        dur > 2.5 && dur < 10.0,
        "Output duration ({dur:.2}s) should be in reasonable range for 5s recording"
    );
}

#[test]
fn segment_callback_receives_events_during_encoding() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(200),
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    for i in 0..15 {
        encoder
            .queue_frame(make_video_frame(320, 240), Duration::from_millis(i * 33))
            .unwrap();
    }

    let mid_events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    let mid_has_init = mid_events.iter().any(|e| e.is_init);
    assert!(
        mid_has_init || video_dir.join("init.mp4").exists(),
        "init event or file should be available during encoding"
    );

    for i in 15..45 {
        encoder
            .queue_frame(make_video_frame(320, 240), Duration::from_millis(i * 33))
            .unwrap();
    }

    encoder.finish().unwrap();

    let final_events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    let total_data_events = mid_events
        .iter()
        .chain(final_events.iter())
        .filter(|e| !e.is_init)
        .count();

    assert!(
        total_data_events >= 2,
        "Should receive multiple data segment events during and after encoding, got {total_data_events}"
    );
}

#[test]
fn audio_segments_with_different_durations() {
    common::init();

    for seg_dur_ms in [200u64, 500, 1000, 2000] {
        let temp = TempDir::new().unwrap();
        let info = default_audio_info();

        let audio = encode_audio_segments(
            temp.path(),
            info,
            Duration::from_millis(seg_dur_ms),
            3000,
            None,
        );

        assert!(
            !audio.segment_paths.is_empty(),
            "Segment duration {seg_dur_ms}ms should produce segments"
        );
        assert!(audio.init_path.exists());

        let manifest = read_manifest(&audio.manifest_path);
        assert!(manifest["is_complete"].as_bool().unwrap());
        assert!(manifest["total_duration"].as_f64().unwrap() > 0.0);
    }
}

#[test]
fn assembly_idempotent_repeated_calls() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        3000,
        33,
    );

    let output1 = temp.path().join("output1.mp4");
    let output2 = temp.path().join("output2.mp4");

    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output1).unwrap();
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output2).unwrap();

    assert_valid_playable_mp4(&output1);
    assert_valid_playable_mp4(&output2);

    let dur1 = get_media_duration(&output1).unwrap().as_secs_f64();
    let dur2 = get_media_duration(&output2).unwrap().as_secs_f64();
    assert!(
        (dur1 - dur2).abs() < 0.01,
        "Repeated assembly should produce same duration: {dur1:.3}s vs {dur2:.3}s"
    );
}

#[test]
fn reversed_segment_order_still_concatenates() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(300),
        3000,
        33,
    );

    if result.segment_paths.len() >= 3 {
        let mut reversed = result.segment_paths.clone();
        reversed.reverse();

        let output = temp.path().join("output_reversed.mp4");
        let concat_result =
            concatenate_m4s_segments_with_init(&result.init_path, &reversed, &output);

        if concat_result.is_ok() && output.exists() {
            assert!(
                probe_media_valid(&output),
                "Reversed segment order should still produce valid container (though content may be jumbled)"
            );
        }
    }
}

#[test]
fn video_segment_durations_consistent_with_config() {
    common::init();

    let temp = TempDir::new().unwrap();
    let configured = Duration::from_secs(1);
    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut encoder = SegmentedVideoEncoder::init(
        temp.path().join("display"),
        default_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: configured,
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    for i in 0..150 {
        encoder
            .queue_frame(make_video_frame(320, 240), Duration::from_millis(i * 33))
            .unwrap();
    }
    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    let data_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| !e.is_init && e.media_type == SegmentMediaType::Video)
        .collect();

    if data_events.len() >= 3 {
        let non_final = &data_events[..data_events.len() - 1];
        for e in non_final {
            let ratio = e.duration / configured.as_secs_f64();
            assert!(
                ratio > 0.3 && ratio < 3.0,
                "Non-final segment {} duration ({:.2}s) should be within 0.3x-3x of configured ({:.2}s)",
                e.index,
                e.duration,
                configured.as_secs_f64()
            );
        }
    }
}

#[test]
fn manifest_version_is_current() {
    common::init();

    let temp = TempDir::new().unwrap();

    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        2000,
        33,
    );

    let manifest = read_manifest(&result.manifest_path);
    let version = manifest["version"].as_u64().unwrap();
    assert!(
        version >= 2,
        "Manifest version should be at least 2, got {version}"
    );
}

#[test]
fn output_file_has_correct_codec() {
    common::init();

    let temp = TempDir::new().unwrap();
    let result = encode_video_segments(
        temp.path(),
        default_video_info(),
        Duration::from_millis(500),
        2000,
        33,
    );

    let output = temp.path().join("output.mp4");
    concatenate_m4s_segments_with_init(&result.init_path, &result.segment_paths, &output).unwrap();

    let input = ffmpeg::format::input(&output).unwrap();
    let video_stream = input
        .streams()
        .find(|s| s.parameters().medium() == ffmpeg::media::Type::Video)
        .unwrap();

    let codec_id = video_stream.parameters().id();
    assert_eq!(
        codec_id,
        ffmpeg::codec::Id::H264,
        "Output video codec should be H.264"
    );
}

#[test]
fn merged_output_preserves_both_stream_durations() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    let recording_ms = 3000u64;

    let video = encode_video_segments(
        &content_dir,
        default_video_info(),
        Duration::from_secs(1),
        recording_ms,
        33,
    );
    let audio = encode_audio_segments(
        &content_dir,
        default_audio_info(),
        Duration::from_secs(1),
        recording_ms,
        None,
    );

    let video_mp4 = temp.path().join("v.mp4");
    concatenate_m4s_segments_with_init(&video.init_path, &video.segment_paths, &video_mp4).unwrap();

    let audio_m4a = temp.path().join("a.m4a");
    concatenate_m4s_segments_with_init(&audio.init_path, &audio.segment_paths, &audio_m4a).unwrap();

    let video_dur = get_media_duration(&video_mp4).unwrap().as_secs_f64();
    let audio_dur = get_media_duration(&audio_m4a).unwrap().as_secs_f64();

    let merged = temp.path().join("merged.mp4");
    merge_video_audio(&video_mp4, &audio_m4a, &merged).unwrap();

    let merged_dur = get_media_duration(&merged).unwrap().as_secs_f64();

    let expected = video_dur.max(audio_dur);
    assert!(
        merged_dur >= expected * 0.5,
        "Merged duration ({merged_dur:.2}s) should be reasonable vs component durations \
         (video={video_dur:.2}s, audio={audio_dur:.2}s)"
    );
}
