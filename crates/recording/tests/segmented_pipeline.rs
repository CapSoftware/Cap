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
use std::{collections::HashMap, collections::HashSet, path::PathBuf, sync::mpsc, time::Duration};
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

fn test_video_info() -> VideoInfo {
    VideoInfo {
        pixel_format: cap_media_info::Pixel::NV12,
        width: 320,
        height: 240,
        time_base: ffmpeg::Rational(1, 1_000_000),
        frame_rate: ffmpeg::Rational(30, 1),
    }
}

fn test_audio_info() -> AudioInfo {
    AudioInfo {
        sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        sample_rate: 48000,
        channels: 1,
        time_base: ffmpeg::Rational(1, 48000),
        buffer_size: 1024,
        is_wireless_transport: false,
    }
}

fn create_test_video_frame(width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for byte in data.iter_mut() {
            *byte = 128;
        }
    }
    frame
}

fn create_test_audio_frame(samples: usize, sample_num: u64) -> ffmpeg::frame::Audio {
    let mut frame = ffmpeg::frame::Audio::new(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        samples,
        ffmpeg::ChannelLayout::MONO,
    );
    frame.set_rate(48000);
    frame.set_pts(Some(sample_num as i64));
    let data = frame.data_mut(0);
    for (i, chunk) in data.chunks_exact_mut(4).enumerate() {
        let val: f32 = (i as f32 * 0.01).sin() * 0.5;
        chunk.copy_from_slice(&val.to_ne_bytes());
    }
    frame
}

#[test]
fn video_and_audio_segments_share_event_channel() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");
    let audio_dir = temp.path().join("audio");

    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        test_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(200),
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        test_audio_info(),
        DashAudioSegmentEncoderConfig {
            segment_duration: Duration::from_millis(200),
        },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let mut audio_sample_offset: u64 = 0;
    for i in 0..30 {
        let ts = Duration::from_millis(i * 33);

        let vframe = create_test_video_frame(320, 240);
        video_encoder.queue_frame(vframe, ts).unwrap();

        let aframe = create_test_audio_frame(1024, audio_sample_offset);
        audio_sample_offset += 1024;
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

    assert!(!video_events.is_empty(), "should have video segment events");
    assert!(!audio_events.is_empty(), "should have audio segment events");

    let video_inits: Vec<&&SegmentCompletedEvent> =
        video_events.iter().filter(|e| e.is_init).collect();
    let audio_inits: Vec<&&SegmentCompletedEvent> =
        audio_events.iter().filter(|e| e.is_init).collect();

    assert!(
        !video_inits.is_empty() || video_dir.join("init.mp4").exists(),
        "video init.mp4 should exist"
    );
    assert!(
        !audio_inits.is_empty() || audio_dir.join("init.mp4").exists(),
        "audio init.mp4 should exist"
    );

    let video_manifests = video_dir.join("manifest.json");
    let audio_manifests = audio_dir.join("manifest.json");
    assert!(video_manifests.exists(), "video manifest should exist");
    assert!(audio_manifests.exists(), "audio manifest should exist");

    let video_manifest_content = std::fs::read_to_string(&video_manifests).unwrap();
    let video_manifest: serde_json::Value = serde_json::from_str(&video_manifest_content).unwrap();
    assert!(video_manifest["is_complete"].as_bool().unwrap());

    let audio_manifest_content = std::fs::read_to_string(&audio_manifests).unwrap();
    let audio_manifest: serde_json::Value = serde_json::from_str(&audio_manifest_content).unwrap();
    assert!(audio_manifest["is_complete"].as_bool().unwrap());
}

#[test]
fn segment_events_can_build_upload_manifest() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");

    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        test_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(100),
            ..Default::default()
        },
    )
    .unwrap();
    encoder.set_segment_callback(tx);

    for i in 0..45 {
        let frame = create_test_video_frame(320, 240);
        let ts = Duration::from_millis(i * 33);
        encoder.queue_frame(frame, ts).unwrap();
    }

    encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

    let mut video_init_uploaded = false;
    let mut uploaded_video_segments: HashSet<u32> = HashSet::new();

    for event in &events {
        assert_eq!(event.media_type, SegmentMediaType::Video);

        if event.is_init {
            video_init_uploaded = true;
            assert!(event.file_size > 0, "init segment should have data");
        } else {
            uploaded_video_segments.insert(event.index);
            assert!(
                event.duration > 0.0,
                "segment should have positive duration"
            );
        }

        if !event.is_init {
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
                "segment file should exist on disk (checking {:?}, {:?}, {:?})",
                p, m4s_path, tmp_path
            );
        }
    }

    assert!(video_init_uploaded || video_dir.join("init.mp4").exists());
    assert!(
        !uploaded_video_segments.is_empty(),
        "should have some segments"
    );

    let mut sorted: Vec<u32> = uploaded_video_segments.iter().copied().collect();
    sorted.sort();
    for i in 1..sorted.len() {
        assert!(
            sorted[i] > sorted[i - 1],
            "indices should be unique and sorted"
        );
    }
}

#[test]
fn segments_are_playable_after_concatenation() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().join("display");

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        test_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(200),
            ..Default::default()
        },
    )
    .unwrap();

    for i in 0..30 {
        let frame = create_test_video_frame(320, 240);
        let ts = Duration::from_millis(i * 33);
        encoder.queue_frame(frame, ts).unwrap();
    }

    encoder.finish().unwrap();

    let init_path = video_dir.join("init.mp4");
    assert!(init_path.exists(), "init.mp4 must exist");

    let manifest_path = video_dir.join("manifest.json");
    let manifest_content = std::fs::read_to_string(&manifest_path).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content).unwrap();

    let segments = manifest["segments"].as_array().unwrap();
    assert!(
        !segments.is_empty(),
        "manifest should contain at least one segment"
    );

    let mut segment_paths: Vec<PathBuf> = Vec::new();
    for seg in segments {
        assert!(seg["is_complete"].as_bool().unwrap());
        let seg_name = seg["path"].as_str().unwrap();
        let seg_path = video_dir.join(seg_name);
        if seg_path.exists() {
            segment_paths.push(seg_path);
        }
    }

    assert!(
        !segment_paths.is_empty(),
        "at least some segment files should exist after finish()"
    );

    let output_path = temp.path().join("output.mp4");
    cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
        &init_path,
        &segment_paths,
        &output_path,
    )
    .unwrap();

    assert!(output_path.exists(), "concatenated output should exist");
    assert!(
        std::fs::metadata(&output_path).unwrap().len() > 100,
        "output should have substantial data"
    );

    assert!(cap_enc_ffmpeg::remux::probe_video_can_decode(&output_path).unwrap_or(false));
}

#[test]
fn manifest_tracks_segment_completion_incrementally() {
    common::init();

    let temp = TempDir::new().unwrap();
    let video_dir = temp.path().to_path_buf();

    let mut encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        test_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(100),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = video_dir.join("manifest.json");

    let initial_content = std::fs::read_to_string(&manifest_path).unwrap();
    let initial: serde_json::Value = serde_json::from_str(&initial_content).unwrap();
    assert!(!initial["is_complete"].as_bool().unwrap());
    let initial_seg_count = initial["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap())
        .count();

    for i in 0..15 {
        let frame = create_test_video_frame(320, 240);
        let ts = Duration::from_millis(i * 33);
        encoder.queue_frame(frame, ts).unwrap();
    }

    let mid_content = std::fs::read_to_string(&manifest_path).unwrap();
    let mid: serde_json::Value = serde_json::from_str(&mid_content).unwrap();
    let mid_complete_count = mid["segments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap())
        .count();

    assert!(
        mid_complete_count >= initial_seg_count,
        "should have same or more complete segments after encoding"
    );
    assert!(!mid["is_complete"].as_bool().unwrap());

    encoder.finish().unwrap();

    let final_content = std::fs::read_to_string(&manifest_path).unwrap();
    let final_manifest: serde_json::Value = serde_json::from_str(&final_content).unwrap();
    assert!(final_manifest["is_complete"].as_bool().unwrap());
    assert!(final_manifest["total_duration"].is_number());
    assert!(final_manifest["total_duration"].as_f64().unwrap() > 0.0);
}

#[test]
fn end_to_end_instant_record_with_mic_stop_assemble_and_validate() {
    common::init();

    let temp = TempDir::new().unwrap();
    let content_dir = temp.path().join("content");
    let video_dir = content_dir.join("display");
    let audio_dir = content_dir.join("audio");
    std::fs::create_dir_all(&content_dir).unwrap();

    let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

    let segment_duration = Duration::from_millis(500);

    let mut video_encoder = SegmentedVideoEncoder::init(
        video_dir.clone(),
        test_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration,
            ..Default::default()
        },
    )
    .unwrap();
    video_encoder.set_segment_callback(tx.clone());

    let mut audio_encoder = DashAudioSegmentEncoder::init(
        audio_dir.clone(),
        test_audio_info(),
        DashAudioSegmentEncoderConfig { segment_duration },
    )
    .unwrap();
    audio_encoder.set_segment_callback(tx);

    let recording_duration_ms = 3000u64;
    let video_frame_interval_ms = 33u64;
    let audio_frame_samples = 1024u64;
    let audio_frame_duration_ms = (audio_frame_samples * 1000) / 48000;

    let total_video_frames = recording_duration_ms / video_frame_interval_ms;
    let total_audio_frames = recording_duration_ms / audio_frame_duration_ms;

    let mut audio_sample_offset: u64 = 0;
    let mut video_ts_ms = 0u64;
    let mut audio_ts_ms = 0u64;
    let mut video_frame_count = 0u64;
    let mut audio_frame_count = 0u64;

    loop {
        let video_done = video_frame_count >= total_video_frames;
        let audio_done = audio_frame_count >= total_audio_frames;
        if video_done && audio_done {
            break;
        }

        if !video_done && (video_ts_ms <= audio_ts_ms || audio_done) {
            let vframe = create_test_video_frame(320, 240);
            video_encoder
                .queue_frame(vframe, Duration::from_millis(video_ts_ms))
                .unwrap();
            video_ts_ms += video_frame_interval_ms;
            video_frame_count += 1;
        }

        if !audio_done && (audio_ts_ms <= video_ts_ms || video_done) {
            let aframe = create_test_audio_frame(audio_frame_samples as usize, audio_sample_offset);
            audio_sample_offset += audio_frame_samples;
            audio_encoder
                .queue_frame(aframe, Duration::from_millis(audio_ts_ms))
                .unwrap();
            audio_ts_ms += audio_frame_duration_ms;
            audio_frame_count += 1;
        }
    }

    video_encoder.finish().unwrap();
    audio_encoder.finish().unwrap();

    let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
    assert!(
        events.len() >= 4,
        "should have at least video init + audio init + 1 video seg + 1 audio seg, got {}",
        events.len()
    );

    let video_init_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Video && e.is_init)
        .collect();
    let audio_init_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Audio && e.is_init)
        .collect();
    let video_seg_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Video && !e.is_init)
        .collect();
    let audio_seg_events: Vec<&SegmentCompletedEvent> = events
        .iter()
        .filter(|e| e.media_type == SegmentMediaType::Audio && !e.is_init)
        .collect();

    assert!(
        !video_init_events.is_empty() || video_dir.join("init.mp4").exists(),
        "video init.mp4 must exist"
    );
    assert!(
        !audio_init_events.is_empty() || audio_dir.join("init.mp4").exists(),
        "audio init.mp4 must exist"
    );
    assert!(
        !video_seg_events.is_empty(),
        "should have video segment events"
    );
    assert!(
        !audio_seg_events.is_empty(),
        "should have audio segment events"
    );

    let mut video_init_uploaded = false;
    let mut audio_init_uploaded = false;
    let mut video_segments: HashMap<u32, f64> = HashMap::new();
    let mut audio_segments: HashMap<u32, f64> = HashMap::new();

    for event in &events {
        match (event.is_init, event.media_type) {
            (true, SegmentMediaType::Video) => video_init_uploaded = true,
            (true, SegmentMediaType::Audio) => audio_init_uploaded = true,
            (false, SegmentMediaType::Video) => {
                video_segments.insert(event.index, event.duration);
            }
            (false, SegmentMediaType::Audio) => {
                audio_segments.insert(event.index, event.duration);
            }
        }
    }

    assert!(video_init_uploaded || video_dir.join("init.mp4").exists());
    assert!(audio_init_uploaded || audio_dir.join("init.mp4").exists());

    let mut sorted_video: Vec<u32> = video_segments.keys().copied().collect();
    sorted_video.sort();
    let mut sorted_audio: Vec<u32> = audio_segments.keys().copied().collect();
    sorted_audio.sort();

    for seg in &sorted_video {
        let dur = video_segments[seg];
        assert!(
            dur > 0.0,
            "video segment {seg} should have positive duration"
        );
    }
    for seg in &sorted_audio {
        let dur = audio_segments[seg];
        assert!(
            dur > 0.0,
            "audio segment {seg} should have positive duration"
        );
    }

    let upload_manifest = serde_json::json!({
        "version": 2,
        "video_init_uploaded": video_init_uploaded,
        "audio_init_uploaded": audio_init_uploaded,
        "video_segments": sorted_video.iter().map(|&idx| {
            serde_json::json!({ "index": idx, "duration": video_segments[&idx] })
        }).collect::<Vec<_>>(),
        "audio_segments": sorted_audio.iter().map(|&idx| {
            serde_json::json!({ "index": idx, "duration": audio_segments[&idx] })
        }).collect::<Vec<_>>(),
        "is_complete": true,
    });

    let manifest_str = serde_json::to_string_pretty(&upload_manifest).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&manifest_str).unwrap();
    assert!(parsed["video_init_uploaded"].as_bool().unwrap());
    assert!(parsed["audio_init_uploaded"].as_bool().unwrap());
    assert!(parsed["is_complete"].as_bool().unwrap());
    assert_eq!(parsed["version"].as_u64().unwrap(), 2);

    let video_segs_arr = parsed["video_segments"].as_array().unwrap();
    for seg in video_segs_arr {
        assert!(seg["index"].is_number());
        assert!(seg["duration"].is_number());
        assert!(seg["duration"].as_f64().unwrap() > 0.0);
    }

    let video_manifest_path = video_dir.join("manifest.json");
    assert!(video_manifest_path.exists());
    let video_manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&video_manifest_path).unwrap()).unwrap();
    assert!(video_manifest["is_complete"].as_bool().unwrap());

    let audio_manifest_path = audio_dir.join("manifest.json");
    assert!(audio_manifest_path.exists());
    let audio_manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&audio_manifest_path).unwrap()).unwrap();
    assert!(audio_manifest["is_complete"].as_bool().unwrap());

    let video_init = video_dir.join("init.mp4");
    let video_segment_paths: Vec<PathBuf> = video_manifest["segments"]
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

    assert!(
        !video_segment_paths.is_empty(),
        "should have completed video segments on disk"
    );

    let video_only_path = temp.path().join("video_only.mp4");
    concatenate_m4s_segments_with_init(&video_init, &video_segment_paths, &video_only_path)
        .expect("video segment concatenation should succeed");

    assert!(video_only_path.exists());
    assert!(
        std::fs::metadata(&video_only_path).unwrap().len() > 500,
        "video-only MP4 should have substantial data"
    );
    assert!(
        probe_media_valid(&video_only_path),
        "video-only MP4 should have valid container"
    );
    assert!(
        probe_video_can_decode(&video_only_path).unwrap_or(false),
        "video-only MP4 should be decodable"
    );

    let audio_init = audio_dir.join("init.mp4");
    let audio_segment_paths: Vec<PathBuf> = audio_manifest["segments"]
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

    assert!(
        !audio_segment_paths.is_empty(),
        "should have completed audio segments on disk"
    );

    let audio_assembled_path = temp.path().join("audio_assembled.m4a");
    concatenate_m4s_segments_with_init(&audio_init, &audio_segment_paths, &audio_assembled_path)
        .expect("audio segment concatenation should succeed");

    assert!(audio_assembled_path.exists());
    assert!(
        std::fs::metadata(&audio_assembled_path).unwrap().len() > 100,
        "audio assembled file should have data"
    );
    assert!(
        probe_media_valid(&audio_assembled_path),
        "assembled audio should have valid container"
    );

    let result_path = temp.path().join("result.mp4");
    merge_video_audio(&video_only_path, &audio_assembled_path, &result_path)
        .expect("video+audio merge should succeed");

    assert!(result_path.exists(), "result.mp4 must exist");
    let result_size = std::fs::metadata(&result_path).unwrap().len();
    assert!(
        result_size > 1000,
        "result.mp4 should have substantial data, got {result_size} bytes"
    );

    assert!(
        probe_media_valid(&result_path),
        "result.mp4 should have valid container"
    );
    assert!(
        probe_video_can_decode(&result_path).unwrap_or(false),
        "result.mp4 video stream should be decodable"
    );

    let result_duration = get_media_duration(&result_path);
    assert!(
        result_duration.is_some(),
        "should be able to determine result.mp4 duration"
    );
    let dur_secs = result_duration.unwrap().as_secs_f64();
    let expected_secs = recording_duration_ms as f64 / 1000.0;
    assert!(
        dur_secs > expected_secs * 0.5,
        "result.mp4 duration ({dur_secs:.2}s) should be at least 50% of recording time ({expected_secs:.1}s)"
    );
    assert!(
        dur_secs < expected_secs * 2.0,
        "result.mp4 duration ({dur_secs:.2}s) should be less than 2x recording time ({expected_secs:.1}s)"
    );

    let input = ffmpeg::format::input(&result_path).expect("should open result.mp4 for probing");
    let has_video = input
        .streams()
        .any(|s| s.parameters().medium() == ffmpeg::media::Type::Video);
    let has_audio = input
        .streams()
        .any(|s| s.parameters().medium() == ffmpeg::media::Type::Audio);

    assert!(has_video, "result.mp4 must have a video stream");
    assert!(has_audio, "result.mp4 must have an audio stream");

    let hls_target_duration: f64 = video_segments.values().copied().fold(0.0f64, f64::max);
    assert!(
        hls_target_duration > 0.0,
        "HLS target duration should be positive"
    );
    let hls_target_duration_ceil = hls_target_duration.ceil() as u32;
    assert!(
        hls_target_duration_ceil >= 1,
        "HLS target duration ceil should be at least 1"
    );
}
