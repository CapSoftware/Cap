use cap_enc_ffmpeg::{
    remux::{concatenate_m4s_segments_with_init, probe_video_can_decode, probe_video_seek_points},
    segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig},
};
use cap_media_info::VideoInfo;
use cap_project::{
    Cursors, MultipleSegment, MultipleSegments, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, StudioRecordingStatus, VideoMeta,
};
use cap_recording::recovery::{RecoveryError, RecoveryManager};
use ffmpeg::{Rational, codec as avcodec, format as avformat, media, rescale};
use relative_path::RelativePathBuf;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;

mod test_utils {
    use std::sync::Once;

    static INIT: Once = Once::new();

    pub fn init_tracing() {
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

struct TestRecording {
    temp_dir: TempDir,
    project_path: PathBuf,
}

impl TestRecording {
    fn new() -> std::io::Result<Self> {
        let temp_dir = TempDir::new()?;
        let project_path = temp_dir.path().to_path_buf();
        Ok(Self {
            temp_dir,
            project_path,
        })
    }

    fn create_segments_dir(&self) -> std::io::Result<PathBuf> {
        let segments_dir = self.project_path.join("content/segments");
        std::fs::create_dir_all(&segments_dir)?;
        Ok(segments_dir)
    }

    fn create_segment_dir(&self, index: u32) -> std::io::Result<PathBuf> {
        let segment_dir = self
            .project_path
            .join(format!("content/segments/segment-{index}"));
        std::fs::create_dir_all(&segment_dir)?;
        Ok(segment_dir)
    }

    fn create_display_dir(&self, segment_index: u32) -> std::io::Result<PathBuf> {
        let display_dir = self
            .project_path
            .join(format!("content/segments/segment-{segment_index}/display"));
        std::fs::create_dir_all(&display_dir)?;
        Ok(display_dir)
    }

    fn write_manifest(
        &self,
        segment_index: u32,
        subdir: &str,
        fragments: &[(&str, bool, u64)],
        init_segment: Option<&str>,
    ) -> std::io::Result<()> {
        let dir = self
            .project_path
            .join(format!("content/segments/segment-{segment_index}/{subdir}"));
        std::fs::create_dir_all(&dir)?;

        let manifest_path = dir.join("manifest.json");
        let mut manifest = serde_json::json!({
            "version": 4,
            "type": "m4s_segments",
            "segments": fragments.iter().map(|(path, is_complete, file_size)| {
                serde_json::json!({
                    "path": path,
                    "is_complete": is_complete,
                    "file_size": file_size
                })
            }).collect::<Vec<_>>()
        });

        if let Some(init) = init_segment {
            manifest["init_segment"] = serde_json::json!(init);
        }

        std::fs::write(manifest_path, serde_json::to_string_pretty(&manifest)?)?;
        Ok(())
    }

    fn write_recording_meta(&self, status: StudioRecordingStatus) -> std::io::Result<()> {
        let meta = RecordingMeta {
            platform: None,
            project_path: self.project_path.clone(),
            pretty_name: "Test Recording".to_string(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: vec![MultipleSegment {
                        display: VideoMeta {
                            path: RelativePathBuf::from("content/segments/segment-0/display.mp4"),
                            fps: 30,
                            start_time: None,
                            device_id: None,
                        },
                        camera: None,
                        mic: None,
                        system_audio: None,
                        cursor: None,
                        keyboard: None,
                    }],
                    cursors: Cursors::default(),
                    status: Some(status),
                },
            })),
        };

        let meta_path = self.project_path.join("recording-meta.json");
        std::fs::write(meta_path, serde_json::to_string_pretty(&meta)?)?;
        Ok(())
    }

    fn path(&self) -> &Path {
        &self.project_path
    }
}

fn create_minimal_mp4_data() -> Vec<u8> {
    vec![
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02,
        0x00, 0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6D, 0x70,
        0x34, 0x31, 0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65, 0x00, 0x00, 0x00, 0x00, 0x6D,
        0x64, 0x61, 0x74,
    ]
}

fn create_corrupt_data() -> Vec<u8> {
    vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let destination = dst.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry_path, &destination)?;
        } else {
            fs::copy(&entry_path, &destination)?;
        }
    }

    Ok(())
}

fn performance_fixture_path() -> PathBuf {
    if let Ok(path) = std::env::var("CAP_PERFORMANCE_FIXTURES_DIR") {
        return PathBuf::from(path).join("reference-recording.cap");
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../cap-performance-fixtures/reference-recording.cap")
}

fn decoded_frame_timestamp(
    frame: &ffmpeg::frame::Video,
    input_time_base: Rational,
    previous: Duration,
    fallback_step: Duration,
) -> Duration {
    let candidate = frame
        .pts()
        .map(|pts| {
            let timestamp_us = rescale::Rescale::rescale(&pts, input_time_base, (1, 1_000_000));
            Duration::from_micros(timestamp_us.max(0) as u64)
        })
        .unwrap_or_else(|| previous + fallback_step);

    if candidate > previous || (candidate.is_zero() && previous.is_zero()) {
        candidate
    } else {
        previous + fallback_step
    }
}

fn list_m4s_segments(dir: &Path) -> Vec<PathBuf> {
    let mut segments: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("m4s"))
        })
        .collect();
    segments.sort();
    segments
}

fn create_fragmented_display_from_mp4(
    source: &Path,
    fragment_dir: &Path,
    max_duration: Duration,
) -> Vec<PathBuf> {
    fs::create_dir_all(fragment_dir).unwrap();

    let mut input = avformat::input(source).unwrap();
    let input_stream = input.streams().best(media::Type::Video).unwrap();
    let input_stream_index = input_stream.index();
    let input_time_base = input_stream.time_base();
    let input_frame_rate = input_stream.rate();

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters()).unwrap();
    let mut decoder = decoder_ctx.decoder().video().unwrap();
    decoder.set_packet_time_base(input_time_base);

    let frame_rate = if input_frame_rate.0 > 0 && input_frame_rate.1 > 0 {
        input_frame_rate
    } else {
        Rational(30, 1)
    };

    let fallback_step = Duration::from_secs_f64(frame_rate.1 as f64 / frame_rate.0 as f64);

    let mut encoder = SegmentedVideoEncoder::init(
        fragment_dir.to_path_buf(),
        VideoInfo {
            pixel_format: decoder.format(),
            width: decoder.width(),
            height: decoder.height(),
            time_base: Rational(1, 1_000_000),
            frame_rate,
        },
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();

    let mut decoded_frame = ffmpeg::frame::Video::empty();
    let mut last_timestamp = Duration::ZERO;
    let mut reached_duration_limit = false;

    for (stream, packet) in input.packets() {
        if stream.index() != input_stream_index {
            continue;
        }

        decoder.send_packet(&packet).unwrap();

        loop {
            match decoder.receive_frame(&mut decoded_frame) {
                Ok(()) => {
                    let timestamp = decoded_frame_timestamp(
                        &decoded_frame,
                        input_time_base,
                        last_timestamp,
                        fallback_step,
                    );

                    if timestamp > max_duration {
                        reached_duration_limit = true;
                        break;
                    }

                    encoder
                        .queue_frame(decoded_frame.clone(), timestamp)
                        .unwrap();
                    last_timestamp = timestamp;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => panic!("failed to decode fixture frame: {error}"),
            }
        }

        if reached_duration_limit {
            break;
        }
    }

    if !reached_duration_limit {
        decoder.send_eof().unwrap();

        loop {
            match decoder.receive_frame(&mut decoded_frame) {
                Ok(()) => {
                    let timestamp = decoded_frame_timestamp(
                        &decoded_frame,
                        input_time_base,
                        last_timestamp,
                        fallback_step,
                    );

                    if timestamp > max_duration {
                        break;
                    }

                    encoder
                        .queue_frame(decoded_frame.clone(), timestamp)
                        .unwrap();
                    last_timestamp = timestamp;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => panic!("failed to flush fixture decoder: {error}"),
            }
        }
    }

    encoder.finish_with_timestamp(last_timestamp).unwrap();

    list_m4s_segments(fragment_dir)
}

fn set_fixture_status(project_path: &Path, status: StudioRecordingStatus) -> bool {
    let mut meta = RecordingMeta::load_for_project(project_path).unwrap();
    let studio_meta = meta.studio_meta().unwrap().clone();

    meta.inner = match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::SingleSegment { segment }))
        }
        StudioRecordingMeta::MultipleSegments { mut inner, .. } => {
            inner.status = Some(status);
            RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments { inner }))
        }
    };

    meta.save_for_project().unwrap();
    matches!(
        meta.studio_meta(),
        Some(StudioRecordingMeta::MultipleSegments { .. })
    )
}

fn locate_top_level_box(path: &Path, target: &[u8; 4]) -> std::io::Result<Option<(u64, u64)>> {
    let mut file = fs::File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut offset = 0u64;

    while offset + 8 <= file_size {
        file.seek(SeekFrom::Start(offset))?;

        let mut header = [0u8; 8];
        file.read_exact(&mut header)?;

        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let kind = [header[4], header[5], header[6], header[7]];

        let (box_size, header_size) = if size32 == 1 {
            let mut large = [0u8; 8];
            file.read_exact(&mut large)?;
            (u64::from_be_bytes(large), 16u64)
        } else {
            (size32, 8u64)
        };

        if box_size < header_size {
            break;
        }

        if &kind == target {
            return Ok(Some((offset + header_size, box_size - header_size)));
        }

        if box_size == 0 {
            break;
        }

        offset = offset.saturating_add(box_size);
    }

    Ok(None)
}

fn corrupt_video_sample_data(path: &Path) {
    let (mdat_offset, mdat_len) = locate_top_level_box(path, b"mdat")
        .unwrap()
        .expect("expected mdat box in fixture video");

    let corrupt_offset = mdat_offset + (mdat_len / 10);
    let available = mdat_len.saturating_sub(mdat_len / 10);
    let corrupt_len = available.clamp(512 * 1024, 8 * 1024 * 1024).min(available);

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    file.seek(SeekFrom::Start(corrupt_offset)).unwrap();
    file.write_all(&vec![0u8; corrupt_len as usize]).unwrap();
    file.flush().unwrap();
}

#[test]
fn test_should_check_for_recovery_in_progress() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    let status = studio_meta.status();

    assert!(
        matches!(status, StudioRecordingStatus::InProgress),
        "Status should be InProgress"
    );
}

#[test]
fn test_should_check_for_recovery_needs_remux() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::NeedsRemux)
        .unwrap();

    let meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    let status = studio_meta.status();

    assert!(
        matches!(status, StudioRecordingStatus::NeedsRemux),
        "Status should be NeedsRemux"
    );
}

#[test]
fn test_should_not_check_for_recovery_complete() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::Complete)
        .unwrap();

    let meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    let status = studio_meta.status();

    assert!(
        matches!(status, StudioRecordingStatus::Complete),
        "Status should be Complete"
    );
}

#[test]
fn test_should_check_for_recovery_failed_with_other_error() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::Failed {
            error: "Some other error".to_string(),
        })
        .unwrap();

    let meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    let status = studio_meta.status();

    match status {
        StudioRecordingStatus::Failed { error } => {
            assert_eq!(error, "Some other error");
        }
        _ => panic!("Status should be Failed"),
    }
}

#[test]
fn test_should_not_check_for_recovery_failed_no_recoverable_segments() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::Failed {
            error: "No recoverable segments found".to_string(),
        })
        .unwrap();

    let meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    let status = studio_meta.status();

    match status {
        StudioRecordingStatus::Failed { error } => {
            assert_eq!(error, "No recoverable segments found");
        }
        _ => panic!("Status should be Failed with 'No recoverable segments found'"),
    }
}

#[test]
fn test_find_incomplete_with_no_segments_directory() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let incomplete = RecoveryManager::find_incomplete(recording.temp_dir.path());

    assert!(
        incomplete.is_empty(),
        "Should not find incomplete recordings without segments directory"
    );
}

#[test]
fn test_find_incomplete_with_empty_segments_directory() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();
    recording.create_segments_dir().unwrap();

    let incomplete = RecoveryManager::find_incomplete(recording.temp_dir.path());

    assert!(
        incomplete.is_empty(),
        "Should not find incomplete recordings with empty segments directory"
    );
}

#[test]
fn test_manifest_size_mismatch_detection() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let display_dir = recording.create_display_dir(0).unwrap();
    let segment_path = display_dir.join("segment_001.m4s");
    let actual_data = create_minimal_mp4_data();
    let actual_size = actual_data.len() as u64;
    std::fs::write(&segment_path, &actual_data).unwrap();

    let wrong_size = actual_size + 1000;
    recording
        .write_manifest(0, "display", &[("segment_001.m4s", true, wrong_size)], None)
        .unwrap();

    let manifest_path = display_dir.join("manifest.json");
    assert!(manifest_path.exists(), "Manifest should exist");

    let manifest_content = std::fs::read_to_string(&manifest_path).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content).unwrap();

    let expected_size = manifest["segments"][0]["file_size"].as_u64().unwrap();
    let metadata = std::fs::metadata(&segment_path).unwrap();

    assert_ne!(
        metadata.len(),
        expected_size,
        "File size should not match manifest expected size"
    );

    println!(
        "Manifest expects {} bytes, file has {} bytes",
        expected_size,
        metadata.len()
    );
}

#[test]
fn test_manifest_version_parsing() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    let manifest_v4 = serde_json::json!({
        "version": 4,
        "type": "m4s_segments",
        "init_segment": "init.mp4",
        "segments": []
    });
    std::fs::write(
        display_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest_v4).unwrap(),
    )
    .unwrap();

    let manifest_content = std::fs::read_to_string(display_dir.join("manifest.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&manifest_content).unwrap();

    assert_eq!(parsed["version"], 4);
    assert_eq!(parsed["type"], "m4s_segments");
    assert_eq!(parsed["init_segment"], "init.mp4");
}

#[test]
fn test_manifest_type_fragments_vs_m4s_segments() {
    test_utils::init_tracing();

    let fragments_manifest = serde_json::json!({
        "version": 2,
        "type": "fragments",
        "fragments": [
            {"path": "fragment_001.mp4", "is_complete": true, "file_size": 1000}
        ]
    });

    let m4s_manifest = serde_json::json!({
        "version": 4,
        "type": "m4s_segments",
        "init_segment": "init.mp4",
        "segments": [
            {"path": "segment_001.m4s", "is_complete": true, "file_size": 1000}
        ]
    });

    assert_eq!(fragments_manifest["type"], "fragments");
    assert!(fragments_manifest.get("fragments").is_some());

    assert_eq!(m4s_manifest["type"], "m4s_segments");
    assert!(m4s_manifest.get("segments").is_some());
    assert!(m4s_manifest.get("init_segment").is_some());
}

#[test]
fn test_incomplete_fragment_skipping() {
    test_utils::init_tracing();

    let manifest = serde_json::json!({
        "version": 4,
        "type": "m4s_segments",
        "segments": [
            {"path": "segment_001.m4s", "is_complete": true, "file_size": 1000},
            {"path": "segment_002.m4s", "is_complete": false, "file_size": 500},
            {"path": "segment_003.m4s", "is_complete": true, "file_size": 1200}
        ]
    });

    let segments = manifest["segments"].as_array().unwrap();
    let complete_segments: Vec<_> = segments
        .iter()
        .filter(|s| s["is_complete"].as_bool().unwrap_or(false))
        .collect();

    assert_eq!(complete_segments.len(), 2);
    assert_eq!(complete_segments[0]["path"], "segment_001.m4s");
    assert_eq!(complete_segments[1]["path"], "segment_003.m4s");
}

#[test]
fn test_recovery_error_types() {
    test_utils::init_tracing();

    let io_error = RecoveryError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "File not found",
    ));
    assert!(
        format!("{io_error}").contains("IO error"),
        "IO error should format correctly"
    );

    let no_segments_error = RecoveryError::NoRecoverableSegments;
    assert!(
        format!("{no_segments_error}").contains("No recoverable segments"),
        "NoRecoverableSegments error should format correctly"
    );

    let meta_save_error = RecoveryError::MetaSave;
    assert!(
        format!("{meta_save_error}").contains("Meta save failed"),
        "MetaSave error should format correctly"
    );

    let unplayable_error =
        RecoveryError::UnplayableVideo("Display video has no frames".to_string());
    assert!(
        format!("{unplayable_error}").contains("not playable"),
        "UnplayableVideo error should format correctly"
    );
}

#[test]
fn test_fallback_to_directory_scan_when_no_manifest() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    std::fs::write(
        display_dir.join("fragment_001.mp4"),
        create_minimal_mp4_data(),
    )
    .unwrap();
    std::fs::write(
        display_dir.join("fragment_002.mp4"),
        create_minimal_mp4_data(),
    )
    .unwrap();

    assert!(
        !display_dir.join("manifest.json").exists(),
        "Manifest should not exist"
    );

    let entries: Vec<_> = std::fs::read_dir(&display_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|e| e == "mp4" || e == "m4s")
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(entries.len(), 2, "Should find 2 video files by scanning");
}

#[test]
fn test_inspect_recording_recovers_orphaned_m4s_fragments_with_init() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    recording
        .write_manifest(
            0,
            "display",
            &[("segment_001.m4s", false, 150)],
            Some("init.mp4"),
        )
        .unwrap();
    std::fs::write(display_dir.join("init.mp4"), create_minimal_mp4_data()).unwrap();
    std::fs::write(display_dir.join("segment_001.m4s"), vec![1u8; 150]).unwrap();
    std::fs::write(display_dir.join("segment_002.m4s"), vec![2u8; 175]).unwrap();
    std::fs::write(display_dir.join("segment_003.m4s.tmp"), vec![3u8; 200]).unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::Failed {
            error: "No recoverable segments found".to_string(),
        })
        .unwrap();

    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();

    assert_eq!(incomplete.recoverable_segments.len(), 1);

    let segment = &incomplete.recoverable_segments[0];
    assert_eq!(segment.display_fragments.len(), 2);
    assert_eq!(
        segment
            .display_fragments
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        vec!["segment_001.m4s".to_string(), "segment_002.m4s".to_string()]
    );
    assert_eq!(
        segment
            .display_init_segment
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().to_string()),
        Some("init.mp4".to_string())
    );
}

#[test]
fn test_corrupt_data_detection() {
    test_utils::init_tracing();

    let valid_mp4 = create_minimal_mp4_data();
    let corrupt_data = create_corrupt_data();

    assert!(
        valid_mp4.len() > 8 && &valid_mp4[4..8] == b"ftyp",
        "Valid MP4 should have ftyp box"
    );

    assert!(
        corrupt_data.len() <= 8 || &corrupt_data[4..8] != b"ftyp",
        "Corrupt data should not have valid ftyp box"
    );
}

#[test]
fn test_recording_meta_status_serialization() {
    test_utils::init_tracing();

    let statuses = vec![
        StudioRecordingStatus::InProgress,
        StudioRecordingStatus::NeedsRemux,
        StudioRecordingStatus::Complete,
        StudioRecordingStatus::Failed {
            error: "Test error".to_string(),
        },
    ];

    for status in statuses {
        let json = serde_json::to_string(&status).unwrap();
        let parsed: StudioRecordingStatus = serde_json::from_str(&json).unwrap();

        match (&status, &parsed) {
            (StudioRecordingStatus::InProgress, StudioRecordingStatus::InProgress) => {}
            (StudioRecordingStatus::NeedsRemux, StudioRecordingStatus::NeedsRemux) => {}
            (StudioRecordingStatus::Complete, StudioRecordingStatus::Complete) => {}
            (
                StudioRecordingStatus::Failed { error: e1 },
                StudioRecordingStatus::Failed { error: e2 },
            ) => {
                assert_eq!(e1, e2, "Failed status error message should match");
            }
            _ => panic!("Status serialization round-trip failed"),
        }
    }
}

#[test]
fn test_segment_directory_ordering() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording.create_segment_dir(2).unwrap();
    recording.create_segment_dir(0).unwrap();
    recording.create_segment_dir(1).unwrap();
    recording.create_segment_dir(10).unwrap();

    let segments_dir = recording.project_path.join("content/segments");
    let mut segment_dirs: Vec<_> = std::fs::read_dir(&segments_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    segment_dirs.sort_by_key(|e| e.file_name());

    let names: Vec<_> = segment_dirs
        .iter()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    assert_eq!(
        names,
        vec!["segment-0", "segment-1", "segment-10", "segment-2"]
    );
}

#[test]
fn test_audio_fragment_extension_detection() {
    test_utils::init_tracing();

    let extensions = ["ogg", "m4a", "mp3"];

    for ext in extensions {
        let path = PathBuf::from(format!("audio-input.{ext}"));
        let actual_ext = path.extension().and_then(|e| e.to_str()).unwrap();
        assert_eq!(actual_ext, ext, "Extension detection should work for {ext}");
    }
}

#[test]
fn test_video_file_extension_check() {
    test_utils::init_tracing();

    let video_paths = vec![
        (PathBuf::from("display.mp4"), true),
        (PathBuf::from("segment_001.m4s"), true),
        (PathBuf::from("display.MP4"), true),
        (PathBuf::from("segment.M4S"), true),
        (PathBuf::from("audio.ogg"), false),
        (PathBuf::from("cursor.json"), false),
        (PathBuf::from("manifest.json"), false),
    ];

    for (path, expected_is_video) in video_paths {
        let is_video = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("mp4") || e.eq_ignore_ascii_case("m4s"))
            .unwrap_or(false);

        assert_eq!(
            is_video, expected_is_video,
            "Path {path:?} video check failed"
        );
    }
}

#[test]
fn test_tiny_segment_threshold() {
    test_utils::init_tracing();

    let threshold: u64 = 100;

    let sizes_and_expected = vec![
        (50u64, true),
        (99u64, true),
        (100u64, false),
        (101u64, false),
        (1000u64, false),
    ];

    for (size, should_skip) in sizes_and_expected {
        let is_tiny = size < threshold;
        assert_eq!(
            is_tiny,
            should_skip,
            "Size {} should {}be skipped as tiny",
            size,
            if should_skip { "" } else { "not " }
        );
    }
}

#[test]
fn test_cursor_path_existence_check() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let segment_dir = recording.create_segment_dir(0).unwrap();

    let cursor_path = segment_dir.join("cursor.json");

    assert!(
        !cursor_path.exists(),
        "Cursor file should not exist initially"
    );

    std::fs::write(&cursor_path, "{}").unwrap();

    assert!(cursor_path.exists(), "Cursor file should exist after write");
}

#[test]
fn test_manifest_init_segment_optional() {
    test_utils::init_tracing();

    let manifest_with_init = serde_json::json!({
        "version": 4,
        "type": "m4s_segments",
        "init_segment": "init.mp4",
        "segments": []
    });

    let manifest_without_init = serde_json::json!({
        "version": 2,
        "type": "fragments",
        "fragments": []
    });

    assert!(
        manifest_with_init.get("init_segment").is_some(),
        "M4S manifest should have init_segment"
    );
    assert!(
        manifest_without_init.get("init_segment").is_none(),
        "Fragments manifest should not have init_segment"
    );
}

#[test]
fn test_multiple_segment_recovery_structure() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();

    for i in 0..3 {
        let segment_dir = recording.create_segment_dir(i).unwrap();
        std::fs::write(segment_dir.join("display.mp4"), create_minimal_mp4_data()).unwrap();
    }

    let segments_dir = recording.project_path.join("content/segments");
    let segment_count = std::fs::read_dir(&segments_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .count();

    assert_eq!(segment_count, 3, "Should have 3 segment directories");

    for i in 0..3 {
        let display_path = segments_dir
            .join(format!("segment-{i}"))
            .join("display.mp4");
        assert!(
            display_path.exists(),
            "Display video should exist for segment {i}"
        );
    }
}

#[test]
fn test_find_incomplete_requires_meta_file() {
    test_utils::init_tracing();

    let temp_dir = TempDir::new().unwrap();
    let project_dir = temp_dir.path().join("test-project");
    std::fs::create_dir_all(&project_dir).unwrap();

    let segments_dir = project_dir.join("content/segments/segment-0");
    std::fs::create_dir_all(&segments_dir).unwrap();

    let incomplete = RecoveryManager::find_incomplete(temp_dir.path());

    assert!(
        incomplete.is_empty(),
        "Should not find recordings without recording-meta.json"
    );
}

#[test]
fn test_status_transition_logic() {
    test_utils::init_tracing();

    let should_check = |status: &StudioRecordingStatus| -> bool {
        match status {
            StudioRecordingStatus::InProgress | StudioRecordingStatus::NeedsRemux => true,
            StudioRecordingStatus::Failed { error } => error != "No recoverable segments found",
            StudioRecordingStatus::Complete => false,
        }
    };

    assert!(
        should_check(&StudioRecordingStatus::InProgress),
        "InProgress should be checked"
    );
    assert!(
        should_check(&StudioRecordingStatus::NeedsRemux),
        "NeedsRemux should be checked"
    );
    assert!(
        !should_check(&StudioRecordingStatus::Complete),
        "Complete should not be checked"
    );
    assert!(
        should_check(&StudioRecordingStatus::Failed {
            error: "Some error".to_string()
        }),
        "Failed with other error should be checked"
    );
    assert!(
        !should_check(&StudioRecordingStatus::Failed {
            error: "No recoverable segments found".to_string()
        }),
        "Failed with 'No recoverable segments found' should not be checked"
    );
}

#[test]
#[ignore = "requires local cap-performance-fixtures checkout"]
fn fixture_corruption_is_rejected_or_normalized_during_recovery() {
    test_utils::init_tracing();

    let fixture = performance_fixture_path();
    assert!(fixture.exists(), "fixture missing at {}", fixture.display());

    let recording = TestRecording::new().unwrap();
    copy_dir_recursive(&fixture, recording.path()).unwrap();
    assert!(
        set_fixture_status(recording.path(), StudioRecordingStatus::NeedsRemux),
        "fixture must use multi-segment recording metadata"
    );

    let segment_dir = recording.path().join("content/segments/segment-0");
    let display_path = segment_dir.join("display.mp4");
    let display_dir = segment_dir.join("display");
    let display_fragments =
        create_fragmented_display_from_mp4(&display_path, &display_dir, Duration::from_secs(5));
    assert!(
        display_fragments.len() >= 3,
        "fragmented fixture should produce multiple m4s segments"
    );
    fs::remove_file(&display_path).unwrap();

    let corrupt_fragment_index = (display_fragments.len() / 2).max(1);
    for fragment in display_fragments.iter().skip(corrupt_fragment_index) {
        corrupt_video_sample_data(fragment);
    }

    let init_path = display_dir.join("init.mp4");
    let pre_recovery_output = segment_dir.join("pre-recovery-display.mp4");
    concatenate_m4s_segments_with_init(&init_path, &display_fragments, &pre_recovery_output)
        .unwrap();

    assert!(
        probe_video_can_decode(&pre_recovery_output).unwrap_or(false),
        "corrupted fragment remux should still have at least one decodable frame"
    );
    assert!(
        probe_video_seek_points(&pre_recovery_output, 8).is_err(),
        "corrupted fragment remux should fail seek validation before recovery"
    );
    fs::remove_file(&pre_recovery_output).unwrap();

    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let recovered_segment = incomplete
        .recoverable_segments
        .iter()
        .find(|segment| segment.index == 0)
        .unwrap();
    assert!(
        recovered_segment.display_init_segment.is_some(),
        "fixture should recover through the fragmented display path"
    );
    assert!(
        recovered_segment.display_fragments.len() >= 3,
        "fixture should expose multiple display fragments to recovery"
    );

    match RecoveryManager::recover(&incomplete) {
        Ok(_) => {
            assert!(
                probe_video_seek_points(&display_path, 8).is_ok(),
                "recovered fixture should pass seek validation if recovery succeeds"
            );
        }
        Err(RecoveryError::UnplayableVideo(_)) => {}
        Err(other) => panic!("unexpected recovery error: {other}"),
    }
}

#[test]
fn test_orphaned_segment_minimum_size() {
    test_utils::init_tracing();

    let min_valid_size: u64 = 100;

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    std::fs::write(display_dir.join("tiny_segment.m4s"), vec![0u8; 50]).unwrap();
    std::fs::write(display_dir.join("valid_segment.m4s"), vec![0u8; 150]).unwrap();

    let tiny_meta = std::fs::metadata(display_dir.join("tiny_segment.m4s")).unwrap();
    let valid_meta = std::fs::metadata(display_dir.join("valid_segment.m4s")).unwrap();

    assert!(
        tiny_meta.len() < min_valid_size,
        "Tiny segment should be below threshold"
    );
    assert!(
        valid_meta.len() >= min_valid_size,
        "Valid segment should be at or above threshold"
    );
}
