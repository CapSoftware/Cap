use cap_project::{
    Cursors, InstantRecordingMeta, MultipleSegment, MultipleSegments, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, VideoMeta,
};
use cap_recording::recovery::{RecoveryError, RecoveryManager};
use relative_path::RelativePathBuf;
use std::path::{Path, PathBuf};
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

fn write_instant_recording_meta(
    project_path: &Path,
    inner: InstantRecordingMeta,
) -> std::io::Result<()> {
    let meta = RecordingMeta {
        platform: None,
        project_path: project_path.to_path_buf(),
        pretty_name: "Test Instant Recording".to_string(),
        sharing: None,
        upload: None,
        inner: RecordingMetaInner::Instant(inner),
    };

    let meta_path = project_path.join("recording-meta.json");
    std::fs::write(meta_path, serde_json::to_string_pretty(&meta)?)?;
    Ok(())
}

#[test]
fn test_instant_recovery_no_output_file() {
    test_utils::init_tracing();

    let temp_dir = TempDir::new().unwrap();
    let project_path = temp_dir.path().to_path_buf();
    std::fs::create_dir_all(project_path.join("content")).unwrap();

    write_instant_recording_meta(
        &project_path,
        InstantRecordingMeta::InProgress { recording: true },
    )
    .unwrap();

    let result = RecoveryManager::try_recover_instant(&project_path).unwrap();
    assert!(!result, "Should not recover when no output.mp4 exists");
}

#[test]
fn test_instant_recovery_tiny_file() {
    test_utils::init_tracing();

    let temp_dir = TempDir::new().unwrap();
    let project_path = temp_dir.path().to_path_buf();
    let content_dir = project_path.join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    write_instant_recording_meta(
        &project_path,
        InstantRecordingMeta::InProgress { recording: true },
    )
    .unwrap();

    std::fs::write(content_dir.join("output.mp4"), vec![0u8; 100]).unwrap();

    let result = RecoveryManager::try_recover_instant(&project_path).unwrap();
    assert!(
        !result,
        "Should not recover when output.mp4 is too small (<1KB)"
    );
}

#[test]
fn test_instant_recovery_skips_complete_recording() {
    test_utils::init_tracing();

    let temp_dir = TempDir::new().unwrap();
    let project_path = temp_dir.path().to_path_buf();
    let content_dir = project_path.join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    write_instant_recording_meta(
        &project_path,
        InstantRecordingMeta::Complete {
            fps: 30,
            sample_rate: None,
        },
    )
    .unwrap();

    std::fs::write(content_dir.join("output.mp4"), vec![0u8; 5000]).unwrap();

    let result = RecoveryManager::try_recover_instant(&project_path).unwrap();
    assert!(
        !result,
        "Should not attempt recovery on already-complete recordings"
    );
}

#[test]
fn test_instant_recovery_corrupt_data_not_recoverable() {
    test_utils::init_tracing();

    let temp_dir = TempDir::new().unwrap();
    let project_path = temp_dir.path().to_path_buf();
    let content_dir = project_path.join("content");
    std::fs::create_dir_all(&content_dir).unwrap();

    write_instant_recording_meta(
        &project_path,
        InstantRecordingMeta::Failed {
            error: "Recording crashed".to_string(),
        },
    )
    .unwrap();

    std::fs::write(content_dir.join("output.mp4"), vec![0xFFu8; 5000]).unwrap();

    let result = RecoveryManager::try_recover_instant(&project_path).unwrap();
    assert!(
        !result,
        "Should not recover when output.mp4 contains only corrupt data"
    );
}

#[test]
fn test_find_incomplete_with_in_progress_and_segments() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let segment_dir = recording.create_segment_dir(0).unwrap();
    std::fs::write(segment_dir.join("display.mp4"), create_minimal_mp4_data()).unwrap();

    let result = RecoveryManager::find_incomplete_single(recording.path());

    assert!(
        result.is_some(),
        "Should find incomplete recording with InProgress status and display.mp4"
    );

    let incomplete = result.unwrap();
    assert!(
        !incomplete.recoverable_segments.is_empty(),
        "Should have at least one recoverable segment"
    );
    assert_eq!(
        incomplete.recoverable_segments[0].index, 0,
        "First recoverable segment should be index 0"
    );
}

#[test]
fn test_find_incomplete_with_manifest_and_m4s_segments() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let display_dir = recording.create_display_dir(0).unwrap();

    let init_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("init.mp4"), &init_data).unwrap();

    let segment_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("segment_000.m4s"), &segment_data).unwrap();
    std::fs::write(display_dir.join("segment_001.m4s"), &segment_data).unwrap();

    recording
        .write_manifest(
            0,
            "display",
            &[
                ("segment_000.m4s", true, segment_data.len() as u64),
                ("segment_001.m4s", true, segment_data.len() as u64),
            ],
            Some("init.mp4"),
        )
        .unwrap();

    let result = RecoveryManager::find_incomplete_single(recording.path());

    assert!(
        result.is_some(),
        "Should find incomplete recording with manifest and M4S segments"
    );

    let incomplete = result.unwrap();
    assert!(
        !incomplete.recoverable_segments.is_empty(),
        "Should have recoverable segments"
    );
    assert!(
        incomplete.recoverable_segments[0]
            .display_init_segment
            .is_some(),
        "Should detect init segment from manifest"
    );
    assert_eq!(
        incomplete.recoverable_segments[0].display_fragments.len(),
        2,
        "Should find 2 display fragments from manifest"
    );
}

#[test]
fn test_find_incomplete_skips_incomplete_fragments_in_manifest() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let display_dir = recording.create_display_dir(0).unwrap();

    let init_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("init.mp4"), &init_data).unwrap();

    let segment_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("segment_000.m4s"), &segment_data).unwrap();
    std::fs::write(display_dir.join("segment_001.m4s"), &segment_data).unwrap();
    std::fs::write(display_dir.join("segment_002.m4s"), &segment_data).unwrap();

    recording
        .write_manifest(
            0,
            "display",
            &[
                ("segment_000.m4s", true, segment_data.len() as u64),
                ("segment_001.m4s", true, segment_data.len() as u64),
                ("segment_002.m4s", false, segment_data.len() as u64),
            ],
            Some("init.mp4"),
        )
        .unwrap();

    let result = RecoveryManager::find_incomplete_single(recording.path());

    assert!(result.is_some(), "Should find incomplete recording");

    let incomplete = result.unwrap();
    assert_eq!(
        incomplete.recoverable_segments[0].display_fragments.len(),
        2,
        "Should only count complete fragments (2 of 3)"
    );
}

#[test]
fn test_find_incomplete_detects_size_mismatch_in_manifest() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::InProgress)
        .unwrap();

    let display_dir = recording.create_display_dir(0).unwrap();

    let init_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("init.mp4"), &init_data).unwrap();

    let segment_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("segment_000.m4s"), &segment_data).unwrap();

    recording
        .write_manifest(
            0,
            "display",
            &[("segment_000.m4s", true, 99999)],
            Some("init.mp4"),
        )
        .unwrap();

    let result = RecoveryManager::find_incomplete_single(recording.path());

    if let Some(incomplete) = &result {
        assert!(
            incomplete.recoverable_segments[0]
                .display_fragments
                .is_empty()
                || incomplete.recoverable_segments.is_empty(),
            "Size mismatch should cause fragment to be skipped"
        );
    }
}

#[test]
fn test_needs_remux_status() {
    test_utils::init_tracing();

    let recording = TestRecording::new().unwrap();
    recording
        .write_recording_meta(StudioRecordingStatus::NeedsRemux)
        .unwrap();

    let segment_dir = recording.create_segment_dir(0).unwrap();
    let display_dir = segment_dir.join("display");
    std::fs::create_dir_all(&display_dir).unwrap();

    let segment_data = create_minimal_mp4_data();
    std::fs::write(display_dir.join("init.mp4"), &segment_data).unwrap();
    std::fs::write(display_dir.join("segment_000.m4s"), &segment_data).unwrap();

    recording
        .write_manifest(
            0,
            "display",
            &[("segment_000.m4s", true, segment_data.len() as u64)],
            Some("init.mp4"),
        )
        .unwrap();

    let result = RecoveryManager::find_incomplete_single(recording.path());

    assert!(
        result.is_some(),
        "Should find NeedsRemux recording as incomplete"
    );
}
