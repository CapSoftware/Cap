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
        Self::write_recording_meta_at(&self.project_path, status)
    }

    fn write_recording_meta_at(
        project_path: &Path,
        status: StudioRecordingStatus,
    ) -> std::io::Result<()> {
        let meta = RecordingMeta {
            platform: None,
            project_path: project_path.to_path_buf(),
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
                        display_notch: None,
                    }],
                    cursors: Cursors::default(),
                    status: Some(status),
                },
            })),
        };

        let meta_path = project_path.join("recording-meta.json");
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
fn test_failed_recording_is_terminal_for_startup_recovery() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();
    write_synthetic_fragments(&display_dir, 180, Duration::from_secs(2));
    assert_valid_synthetic_fragments(&display_dir);
    recording
        .write_recording_meta(StudioRecordingStatus::Failed {
            error: "Some other error".to_string(),
        })
        .unwrap();

    let inspected = RecoveryManager::inspect_recording(recording.path()).unwrap();
    assert_eq!(inspected.recoverable_segments.len(), 1);

    assert!(
        RecoveryManager::find_incomplete_single(recording.path()).is_none(),
        "Failed recordings should not be startup recovery candidates"
    );
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
fn test_find_incomplete_preserves_failed_error_without_segments() {
    test_utils::init_tracing();

    let recordings_dir = TempDir::new().unwrap();
    let project_path = recordings_dir.path().join("failed-start.cap");
    std::fs::create_dir_all(&project_path).unwrap();
    let original_error =
        "RefreshShareableContent: The user declined TCCs for application, window, display capture";

    TestRecording::write_recording_meta_at(
        &project_path,
        StudioRecordingStatus::Failed {
            error: original_error.to_string(),
        },
    )
    .unwrap();

    let incomplete = RecoveryManager::find_incomplete(recordings_dir.path());

    assert!(
        incomplete.is_empty(),
        "Should not find incomplete recordings without segments directory"
    );

    let meta = RecordingMeta::load_for_project(&project_path).unwrap();
    let studio_meta = meta.studio_meta().unwrap();
    match studio_meta.status() {
        StudioRecordingStatus::Failed { error } => assert_eq!(error, original_error),
        _ => panic!("Status should preserve original failed-start error"),
    }
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

    write_synthetic_fragments(&display_dir, 180, Duration::from_secs(2));
    let expected_fragments = assert_valid_synthetic_fragments(&display_dir);
    let first = &expected_fragments[0];
    let first_name = first.file_name().unwrap().to_str().unwrap();
    let first_size = std::fs::metadata(first).unwrap().len();
    recording
        .write_manifest(
            0,
            "display",
            &[(first_name, true, first_size)],
            Some("init.mp4"),
        )
        .unwrap();
    std::fs::write(display_dir.join("segment_999.m4s.tmp"), vec![3u8; 200]).unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::Failed {
            error: "No recoverable segments found".to_string(),
        })
        .unwrap();

    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();

    assert_eq!(incomplete.recoverable_segments.len(), 1);

    let segment = &incomplete.recoverable_segments[0];
    assert_eq!(segment.display_fragments, expected_fragments);
    assert!(display_dir.join("segment_999.m4s.tmp").exists());
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
            StudioRecordingStatus::Failed { .. } | StudioRecordingStatus::Complete => false,
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
        !should_check(&StudioRecordingStatus::Failed {
            error: "Some error".to_string()
        }),
        "Failed with other error should not be checked"
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

fn make_synthetic_video_frame(width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for byte in data.iter_mut() {
            *byte = 128;
        }
    }
    frame
}

fn synthetic_video_info() -> cap_media_info::VideoInfo {
    cap_media_info::VideoInfo {
        pixel_format: cap_media_info::Pixel::NV12,
        width: 320,
        height: 240,
        time_base: ffmpeg::Rational(1, 1_000_000),
        frame_rate: ffmpeg::Rational(30, 1),
    }
}

fn write_synthetic_fragments(display_dir: &Path, total_frames: u64, segment_duration: Duration) {
    let mut encoder = SegmentedVideoEncoder::init(
        display_dir.to_path_buf(),
        synthetic_video_info(),
        SegmentedVideoEncoderConfig {
            segment_duration,
            ..Default::default()
        },
    )
    .expect("synthetic encoder init");

    for i in 0..total_frames {
        let frame = make_synthetic_video_frame(320, 240);
        let ts = Duration::from_nanos(i * 1_000_000_000 / 30);
        encoder.queue_frame(frame, ts).expect("queue frame");
    }

    drop(encoder);
}

fn assert_valid_synthetic_fragments(display_dir: &Path) -> Vec<PathBuf> {
    let fragments = list_m4s_segments(display_dir);
    assert!(fragments.len() >= 2);
    let control = TempDir::new().unwrap();
    let output = control.path().join("fixture-control.mp4");
    concatenate_m4s_segments_with_init(&display_dir.join("init.mp4"), &fragments, &output).unwrap();
    assert!(probe_video_can_decode(&output).unwrap());
    probe_video_seek_points(&output, 8).unwrap();
    assert!(cap_enc_ffmpeg::remux::get_media_duration(&output).unwrap() >= Duration::from_secs(4));
    fragments
}

#[test]
fn recover_after_simulated_crash_produces_playable_mp4_with_preserved_duration() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    let total_frames = 180u64;
    write_synthetic_fragments(&display_dir, total_frames, Duration::from_secs(2));

    let m4s_segments: Vec<_> = std::fs::read_dir(&display_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    assert!(
        m4s_segments.len() >= 2,
        "expected at least 2 complete segments before crash, got {}",
        m4s_segments.len()
    );
    let init_path = display_dir.join("init.mp4");
    assert!(
        init_path.exists(),
        "init.mp4 must exist after simulated crash"
    );

    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let incomplete = RecoveryManager::inspect_recording(recording.path())
        .expect("inspect should find recoverable fragments");
    assert!(!incomplete.recoverable_segments.is_empty());

    RecoveryManager::recover(&incomplete).expect("recovery should succeed");

    let display_mp4 = recording
        .path()
        .join("content/segments/segment-0/display.mp4");
    assert!(
        display_mp4.exists(),
        "display.mp4 must exist after recovery"
    );

    assert!(
        probe_video_can_decode(&display_mp4).unwrap_or(false),
        "recovered display.mp4 must be decodable"
    );

    let duration = cap_enc_ffmpeg::remux::get_media_duration(&display_mp4)
        .expect("recovered display.mp4 must expose a duration");
    assert!(
        duration >= Duration::from_secs(4),
        "recovered duration {duration:?} below 4s (wrote ~6s)"
    );

    assert!(
        !display_dir.exists() || std::fs::read_dir(&display_dir).unwrap().next().is_none(),
        "display/ fragment dir should be emptied or removed after successful recovery"
    );
}

#[test]
fn recover_preserves_fragments_when_progressive_mp4_validation_fails() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    write_synthetic_fragments(&display_dir, 180, Duration::from_secs(2));

    let init_path = display_dir.join("init.mp4");
    std::fs::write(&init_path, vec![0u8; 2048]).unwrap();

    let fragment_count_before = std::fs::read_dir(&display_dir).unwrap().count();
    assert!(
        fragment_count_before > 1,
        "expected multiple files before recovery"
    );

    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let incomplete = RecoveryManager::inspect_recording(recording.path())
        .expect("inspect should still detect fragments");

    let result = RecoveryManager::recover(&incomplete);
    assert!(
        result.is_err(),
        "recovery must propagate failure when progressive MP4 is unplayable"
    );
    assert!(
        matches!(
            result,
            Err(RecoveryError::UnplayableVideo(_))
                | Err(RecoveryError::VideoConcat(_))
                | Err(RecoveryError::Validation(_))
        ),
        "failure should be UnplayableVideo or VideoConcat, got {result:?}"
    );

    assert!(
        display_dir.exists(),
        "display/ fragment dir must remain after validation failure"
    );
    let fragment_count_after = std::fs::read_dir(&display_dir).unwrap().count();
    assert_eq!(
        fragment_count_after, fragment_count_before,
        "no fragments should be deleted after validation failure"
    );

    let display_mp4 = recording
        .path()
        .join("content/segments/segment-0/display.mp4");
    assert!(
        !display_mp4.exists(),
        "invalid concatenated display.mp4 should be removed on failure"
    );
}

#[test]
fn finalize_to_progressive_mp4_includes_respawn_fragments() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    write_synthetic_fragments(&display_dir, 300, Duration::from_secs(2));

    let original_segments: Vec<_> = std::fs::read_dir(&display_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    let original_count = original_segments.len();
    assert!(
        original_count >= 2,
        "expected at least 2 original segments, got {original_count}"
    );

    let respawn_dir = display_dir.join("respawn-1");
    std::fs::create_dir_all(&respawn_dir).unwrap();
    write_synthetic_fragments(&respawn_dir, 300, Duration::from_secs(2));

    let respawn_segments: Vec<_> = std::fs::read_dir(&respawn_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    let respawn_count = respawn_segments.len();
    assert!(
        respawn_count >= 2,
        "expected at least 2 respawn fragments, got {respawn_count}"
    );

    let output = recording.path().join("finalized.mp4");
    RecoveryManager::finalize_to_progressive_mp4(&display_dir, &output)
        .expect("finalize_to_progressive_mp4 should succeed with respawn fragments");

    let duration = cap_enc_ffmpeg::remux::get_media_duration(&output).expect("read duration");

    let single_dir_output = recording.path().join("single_dir_baseline.mp4");
    let baseline_dir = recording.path().join("baseline_dir");
    std::fs::create_dir_all(&baseline_dir).unwrap();
    write_synthetic_fragments(&baseline_dir, 300, Duration::from_secs(2));
    RecoveryManager::finalize_to_progressive_mp4(&baseline_dir, &single_dir_output)
        .expect("baseline finalize should succeed");
    let baseline_duration =
        cap_enc_ffmpeg::remux::get_media_duration(&single_dir_output).expect("baseline duration");

    assert!(
        duration.as_secs_f64() > baseline_duration.as_secs_f64() * 1.5,
        "finalized duration {duration:?} must be substantially longer than single-dir baseline \
         {baseline_duration:?} when respawn fragments exist"
    );

    assert!(
        probe_video_can_decode(&output).unwrap_or(false),
        "finalized MP4 with respawn fragments must be decodable"
    );
}

#[test]
fn finalize_to_progressive_mp4_rescues_pending_tmp_fragments_in_respawn_dir() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();
    write_synthetic_fragments(&display_dir, 300, Duration::from_secs(2));

    let respawn_dir = display_dir.join("respawn-1");
    std::fs::create_dir_all(&respawn_dir).unwrap();
    write_synthetic_fragments(&respawn_dir, 300, Duration::from_secs(2));

    let respawn_entries: Vec<_> = std::fs::read_dir(&respawn_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|ext| ext == "m4s")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("segment_"))
        })
        .collect();

    let to_disguise = respawn_entries
        .last()
        .expect("respawn dir should have at least one .m4s");
    let tmp_target = to_disguise.with_extension("m4s.tmp");
    let file_size_before = std::fs::metadata(to_disguise).unwrap().len();
    std::fs::rename(to_disguise, &tmp_target).unwrap();
    assert!(tmp_target.exists(), "renamed .tmp should exist");
    assert!(
        !to_disguise.exists(),
        "original .m4s should no longer exist"
    );

    let output = recording.path().join("finalized_with_tmp.mp4");
    RecoveryManager::finalize_to_progressive_mp4(&display_dir, &output)
        .expect("finalize should succeed and rescue the .tmp");

    assert!(
        to_disguise.exists() || !tmp_target.exists(),
        "either the .tmp was rescued into .m4s ({}) or still present as .tmp ({})",
        to_disguise.display(),
        tmp_target.display()
    );

    if to_disguise.exists() {
        let size_after = std::fs::metadata(to_disguise).unwrap().len();
        assert_eq!(
            size_after, file_size_before,
            "rescued .m4s should have same byte count as the original .m4s.tmp"
        );
    }

    assert!(
        probe_video_can_decode(&output).unwrap_or(false),
        "output MP4 should decode cleanly even after rescuing a .tmp fragment"
    );
}

#[test]
fn finalize_to_progressive_mp4_rejects_truncated_tmp_fragments_in_respawn_dir() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();
    write_synthetic_fragments(&display_dir, 300, Duration::from_secs(2));

    let respawn_dir = display_dir.join("respawn-1");
    std::fs::create_dir_all(&respawn_dir).unwrap();
    write_synthetic_fragments(&respawn_dir, 300, Duration::from_secs(2));

    let respawn_entries: Vec<_> = std::fs::read_dir(&respawn_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|ext| ext == "m4s")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("segment_"))
        })
        .collect();

    let to_disguise = respawn_entries
        .last()
        .expect("respawn dir should have at least one .m4s");
    let tmp_target = to_disguise.with_extension("m4s.tmp");
    std::fs::rename(to_disguise, &tmp_target).unwrap();

    let original_len = std::fs::metadata(&tmp_target).unwrap().len();
    let truncated_len = original_len.saturating_sub(12);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&tmp_target)
        .unwrap()
        .set_len(truncated_len)
        .unwrap();

    let output = recording.path().join("finalized_with_truncated_tmp.mp4");
    RecoveryManager::finalize_to_progressive_mp4(&display_dir, &output)
        .expect("finalize should succeed while skipping truncated tmp");

    let corrupt_marker = respawn_dir.join(format!(
        "{}.corrupt",
        tmp_target.file_name().unwrap().to_string_lossy()
    ));

    assert!(tmp_target.exists(), "truncated tmp must remain quarantined");
    assert!(
        corrupt_marker.exists(),
        "truncated tmp must get a .corrupt marker for future retries"
    );
    assert!(
        probe_video_can_decode(&output).unwrap_or(false),
        "output MP4 should decode cleanly after skipping truncated tmp"
    );
}

#[test]
fn finalize_to_progressive_mp4_public_api_produces_playable_output() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    let display_dir = recording.create_display_dir(0).unwrap();

    write_synthetic_fragments(&display_dir, 120, Duration::from_secs(2));

    let output = recording.path().join("finalized.mp4");
    let produced = RecoveryManager::finalize_to_progressive_mp4(&display_dir, &output)
        .expect("finalize_to_progressive_mp4 should succeed on valid fragments");

    assert_eq!(produced, output);
    assert!(output.exists(), "progressive MP4 must exist");
    assert!(
        probe_video_can_decode(&output).unwrap_or(false),
        "finalized MP4 must be decodable"
    );

    assert!(
        display_dir.join("init.mp4").exists(),
        "finalize_to_progressive_mp4 must not delete fragments - that's the caller's responsibility"
    );
}

fn recovery_input_bytes(project: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, result: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".recovery")
            {
                continue;
            }
            if path.is_dir() {
                visit(root, &path, result);
            } else {
                let _ = result.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = std::collections::BTreeMap::new();
    visit(project, project, &mut result);
    result
}

fn set_recovery_optional_tracks(project: &Path) {
    let mut meta = RecordingMeta::load_for_project(project).unwrap();
    let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
        panic!("studio");
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        panic!("segments");
    };
    let segment = &mut inner.segments[0];
    segment.camera = Some(VideoMeta {
        path: RelativePathBuf::from("content/segments/segment-0/camera.mp4"),
        fps: 30,
        start_time: Some(0.0),
        device_id: None,
    });
    segment.mic = Some(cap_project::AudioMeta {
        path: RelativePathBuf::from("content/segments/segment-0/audio-input.ogg"),
        start_time: Some(0.0),
        device_id: None,
        gap_summary: None,
    });
    segment.system_audio = Some(cap_project::AudioMeta {
        path: RelativePathBuf::from("content/segments/segment-0/system_audio.ogg"),
        start_time: Some(0.0),
        device_id: None,
        gap_summary: None,
    });
    meta.save_for_project().unwrap();
}

fn write_recovery_wav(path: &Path) {
    let samples = vec![0_u8; 48000 * 2 * 3];
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&48000_u32.to_le_bytes());
    bytes.extend_from_slice(&96000_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&samples);
    std::fs::write(path, bytes).unwrap();
}

fn complete_recovery_fixture() -> TestRecording {
    let recording = TestRecording::new().unwrap();
    let display = recording.create_display_dir(0).unwrap();
    let camera = recording.create_segment_dir(0).unwrap().join("camera");
    std::fs::create_dir(&camera).unwrap();
    write_synthetic_fragments(&display, 180, Duration::from_secs(2));
    write_synthetic_fragments(&camera, 180, Duration::from_secs(2));
    let segment = recording.path().join("content/segments/segment-0");
    write_recovery_wav(&segment.join("audio-input.m4a"));
    write_recovery_wav(&segment.join("system_audio.m4a"));
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();
    set_recovery_optional_tracks(recording.path());
    recording
}

#[test]
fn recovery_and_finalize_retain_every_known_track_on_success() {
    test_utils::init_tracing();
    for (finalize, status) in [
        (false, StudioRecordingStatus::InProgress),
        (false, StudioRecordingStatus::NeedsRemux),
        (true, StudioRecordingStatus::InProgress),
        (true, StudioRecordingStatus::NeedsRemux),
    ] {
        let recording = complete_recovery_fixture();
        assert!(set_fixture_status(recording.path(), status));
        let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
        let recovered = if finalize {
            RecoveryManager::finalize(&incomplete)
        } else {
            RecoveryManager::recover(&incomplete)
        }
        .unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = recovered.meta else {
            panic!("segments");
        };
        assert!(matches!(
            inner.status,
            Some(StudioRecordingStatus::Complete)
        ));
        assert_eq!(inner.segments.len(), 1);
        let segment = &inner.segments[0];
        assert!(segment.camera.is_some());
        assert!(segment.mic.is_some());
        assert!(segment.system_audio.is_some());
        for path in [
            &segment.display.path,
            &segment.camera.as_ref().unwrap().path,
            &segment.mic.as_ref().unwrap().path,
            &segment.system_audio.as_ref().unwrap().path,
        ] {
            assert!(path.to_path(recording.path()).is_file());
        }
        cap_project::ProjectConfiguration::load(recording.path())
            .unwrap()
            .validate()
            .unwrap();
        assert!(recording.path().join(".recovery.lock").is_file());
    }
}

#[test]
fn recovery_and_finalize_missing_known_optional_tracks_preserve_all_original_bytes() {
    test_utils::init_tracing();
    for target in ["camera", "audio-input.m4a", "system_audio.m4a"] {
        let recording = complete_recovery_fixture();
        let target = recording
            .path()
            .join("content/segments/segment-0")
            .join(target);
        if target.is_dir() {
            std::fs::remove_dir_all(target).unwrap();
        } else {
            std::fs::remove_file(target).unwrap();
        }
        let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
        let before = recovery_input_bytes(recording.path());
        assert!(RecoveryManager::recover(&incomplete).is_err());
        assert_eq!(recovery_input_bytes(recording.path()), before);
        assert!(RecoveryManager::finalize(&incomplete).is_err());
        assert_eq!(recovery_input_bytes(recording.path()), before);
    }
}

#[test]
fn recovery_rejects_missing_whole_known_segment_without_mutation() {
    test_utils::init_tracing();
    let recording = complete_recovery_fixture();
    let mut meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
        panic!("studio");
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        panic!("segments");
    };
    inner.segments.push(inner.segments[0].clone());
    meta.save_for_project().unwrap();
    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::recover(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
}

#[test]
fn recovery_invalid_camera_audio_and_configuration_leave_raw_and_status_unchanged() {
    test_utils::init_tracing();
    for name in [
        "content/segments/segment-0/camera/init.mp4",
        "content/segments/segment-0/audio-input.m4a",
        "content/segments/segment-0/system_audio.m4a",
        "project-config.json",
    ] {
        let recording = complete_recovery_fixture();
        std::fs::write(recording.path().join(name), b"corrupt input").unwrap();
        let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
        let before = recovery_input_bytes(recording.path());
        assert!(RecoveryManager::recover(&incomplete).is_err());
        assert_eq!(recovery_input_bytes(recording.path()), before);
        assert!(RecoveryManager::finalize(&incomplete).is_err());
        assert_eq!(recovery_input_bytes(recording.path()), before);
    }
}

#[test]
fn recovery_rejects_a_present_unlisted_invalid_track_and_a_stale_snapshot() {
    test_utils::init_tracing();
    let recording = TestRecording::new().unwrap();
    write_synthetic_fragments(
        &recording.create_display_dir(0).unwrap(),
        180,
        Duration::from_secs(2),
    );
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();
    std::fs::write(
        recording
            .path()
            .join("content/segments/segment-0/audio-input.m4a"),
        b"invalid unlisted audio",
    )
    .unwrap();
    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::recover(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
    let mut meta = RecordingMeta::load_for_project(recording.path()).unwrap();
    meta.pretty_name = "changed after inspection".into();
    meta.save_for_project().unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::finalize(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
}

#[test]
fn recovery_rejects_video_only_container_used_as_required_audio() {
    test_utils::init_tracing();
    let recording = complete_recovery_fixture();
    let video = recording.path().join("audio-container.mp4");
    RecoveryManager::finalize_to_progressive_mp4(
        &recording.path().join("content/segments/segment-0/display"),
        &video,
    )
    .unwrap();
    let audio = recording
        .path()
        .join("content/segments/segment-0/audio-input.m4a");
    std::fs::copy(video, &audio).unwrap();
    assert!(cap_enc_ffmpeg::remux::probe_media_valid(&audio));
    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::recover(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
}

#[test]
fn recovery_rejects_later_corrupt_video_even_when_first_frame_decodes() {
    test_utils::init_tracing();
    let recording = complete_recovery_fixture();
    let display = recording.path().join("content/segments/segment-0/display");
    let mut fragments: Vec<_> = std::fs::read_dir(&display)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
        .collect();
    fragments.sort();
    assert!(fragments.len() >= 2);
    let target = &fragments[1];
    let mut bytes = std::fs::read(target).unwrap();
    let mdat = bytes.windows(4).position(|value| value == b"mdat").unwrap() + 4;
    let end = (mdat + 64).min(bytes.len());
    bytes[mdat..end].fill(0xff);
    std::fs::write(target, bytes).unwrap();
    let combined = recording.path().join("first-frame-control.mp4");
    let mut control = std::fs::read(display.join("init.mp4")).unwrap();
    for fragment in &fragments {
        control.extend(std::fs::read(fragment).unwrap());
    }
    std::fs::write(&combined, control).unwrap();
    assert!(probe_video_can_decode(&combined).unwrap());
    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::recover(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
    assert!(RecoveryManager::finalize(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);

    assert!(set_fixture_status(
        recording.path(),
        StudioRecordingStatus::NeedsRemux
    ));
    let incomplete = RecoveryManager::inspect_recording(recording.path()).unwrap();
    let before = recovery_input_bytes(recording.path());
    assert!(RecoveryManager::recover(&incomplete).is_err());
    assert_eq!(recovery_input_bytes(recording.path()), before);
}

fn write_recovery_dash_audio(directory: &Path) {
    let info = cap_media_info::AudioInfo::new_raw(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        48000,
        1,
    );
    let mut encoder = cap_enc_ffmpeg::dash_audio::DashAudioSegmentEncoder::init(
        directory.to_path_buf(),
        info,
        cap_enc_ffmpeg::dash_audio::DashAudioSegmentEncoderConfig {
            segment_duration: Duration::from_secs(1),
        },
    )
    .unwrap();
    for index in 0..150_u64 {
        let mut frame = info.empty_frame(1024);
        frame.data_mut(0).fill(0);
        encoder
            .queue_frame(
                frame,
                Duration::from_secs_f64(index as f64 * 1024.0 / 48000.0),
            )
            .unwrap();
    }
    encoder.finish().unwrap();
}

#[test]
fn instant_recovery_preserves_valid_audio_and_legitimate_video_only_recordings() {
    test_utils::init_tracing();
    for with_audio in [false, true] {
        let recording = TestRecording::new().unwrap();
        let display = recording.path().join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        write_synthetic_fragments(&display, 180, Duration::from_secs(2));
        let audio = recording.path().join("content/audio");
        if with_audio {
            write_recovery_dash_audio(&audio);
        }
        let before = recovery_input_bytes(recording.path());
        let output = recording.path().join("content/output.mp4");
        RecoveryManager::finalize_instant_output(&display, &audio, &output).unwrap();
        let input = ffmpeg::format::input(&output).unwrap();
        assert!(input.streams().best(ffmpeg::media::Type::Video).is_some());
        assert_eq!(
            input.streams().best(ffmpeg::media::Type::Audio).is_some(),
            with_audio
        );
        for (relative, bytes) in before {
            assert_eq!(
                std::fs::read(recording.path().join(relative)).unwrap(),
                bytes
            );
        }
    }
}

#[test]
fn instant_recovery_empty_or_invalid_expected_audio_cannot_replace_existing_output() {
    test_utils::init_tracing();
    for corrupt in [false, true] {
        let recording = TestRecording::new().unwrap();
        let display = recording.path().join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        write_synthetic_fragments(&display, 180, Duration::from_secs(2));
        let output = recording.path().join("content/output.mp4");
        RecoveryManager::finalize_to_progressive_mp4(&display, &output).unwrap();
        let audio = recording.path().join("content/audio");
        if corrupt {
            write_recovery_dash_audio(&audio);
            std::fs::write(audio.join("init.mp4"), b"corrupt audio init").unwrap();
        } else {
            std::fs::create_dir(&audio).unwrap();
        }
        let before = recovery_input_bytes(recording.path());
        assert!(RecoveryManager::finalize_instant_output(&display, &audio, &output).is_err());
        assert_eq!(recovery_input_bytes(recording.path()), before);
    }
}

#[test]
fn instant_recovery_refuses_known_failed_and_known_missing_audio_without_mutation() {
    test_utils::init_tracing();
    for inner in [
        cap_project::InstantRecordingMeta::Failed {
            error: "required microphone failed".into(),
        },
        cap_project::InstantRecordingMeta::Complete {
            fps: 30,
            sample_rate: Some(48000),
        },
    ] {
        let recording = TestRecording::new().unwrap();
        let display = recording.path().join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        write_synthetic_fragments(&display, 180, Duration::from_secs(2));
        recording
            .write_recording_meta(StudioRecordingStatus::InProgress)
            .unwrap();
        let mut meta = RecordingMeta::load_for_project(recording.path()).unwrap();
        meta.inner = RecordingMetaInner::Instant(inner);
        meta.save_for_project().unwrap();
        let before = recovery_input_bytes(recording.path());
        assert!(
            RecoveryManager::finalize_instant_output(
                &display,
                &recording.path().join("content/audio"),
                &recording.path().join("content/output.mp4")
            )
            .is_err()
        );
        assert_eq!(recovery_input_bytes(recording.path()), before);
    }
}

#[test]
fn repeated_instant_finalization_does_not_retain_staging_copies() {
    test_utils::init_tracing();
    let recording = TestRecording::new().unwrap();
    let display = recording.path().join("content/display");
    std::fs::create_dir_all(&display).unwrap();
    write_synthetic_fragments(&display, 180, Duration::from_secs(2));
    let audio = recording.path().join("content/audio");
    write_recovery_dash_audio(&audio);
    let before = recovery_input_bytes(recording.path());
    let output = recording.path().join("content/output.mp4");
    for _ in 0..3 {
        RecoveryManager::finalize_instant_output(&display, &audio, &output).unwrap();
        let mut after = recovery_input_bytes(recording.path());
        assert!(after.remove(Path::new("content/output.mp4")).is_some());
        assert_eq!(after, before);
        assert!(std::fs::read_dir(recording.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".recovery-")
        }));
        let input = ffmpeg::format::input(&output).unwrap();
        assert!(input.streams().best(ffmpeg::media::Type::Video).is_some());
        assert!(input.streams().best(ffmpeg::media::Type::Audio).is_some());
    }
}

#[test]
fn instant_recovery_rebuilds_corrupt_prior_output_only_from_valid_required_raw() {
    test_utils::init_tracing();
    for invalid_audio in [false, true] {
        let recording = TestRecording::new().unwrap();
        let display = recording.path().join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        write_synthetic_fragments(&display, 180, Duration::from_secs(2));
        let audio = recording.path().join("content/audio");
        write_recovery_dash_audio(&audio);
        if invalid_audio {
            std::fs::write(audio.join("init.mp4"), b"invalid required audio").unwrap();
        }
        let output = recording.path().join("content/output.mp4");
        std::fs::write(&output, b"interrupted MP4 header").unwrap();
        let before = recovery_input_bytes(recording.path());
        let result = RecoveryManager::finalize_instant_output(&display, &audio, &output);
        if invalid_audio {
            assert!(result.is_err());
            assert_eq!(recovery_input_bytes(recording.path()), before);
        } else {
            result.unwrap();
            for (relative, bytes) in before {
                if relative != Path::new("content/output.mp4") {
                    assert_eq!(
                        std::fs::read(recording.path().join(relative)).unwrap(),
                        bytes
                    );
                }
            }
            let input = ffmpeg::format::input(&output).unwrap();
            assert!(input.streams().best(ffmpeg::media::Type::Video).is_some());
            assert!(input.streams().best(ffmpeg::media::Type::Audio).is_some());
            assert!(std::fs::read_dir(recording.path()).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".recovery-")
            }));
        }
    }
}
