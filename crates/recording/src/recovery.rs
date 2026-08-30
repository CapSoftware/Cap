use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_enc_ffmpeg::fragmented_mp4::tail_is_complete;
use cap_enc_ffmpeg::remux::{
    concatenate_audio_to_ogg, concatenate_m4s_segments_with_init, concatenate_video_fragments,
    get_media_duration, get_video_fps, merge_video_audio, probe_media_valid,
    probe_video_can_decode, probe_video_seek_points, remux_file,
};
use cap_project::{
    AudioMeta, Cursors, MultipleSegment, MultipleSegments, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration,
    TimelineSegment, VideoMeta,
};
use relative_path::RelativePathBuf;
use tracing::{debug, warn};

use crate::output_pipeline::{HealthSender, PipelineHealthEvent, emit_health};

macro_rules! finalization_info {
    ($($arg:tt)*) => {
        tracing::info!(target: "cap_recording::recording_finalization", $($arg)*)
    };
}

#[derive(Debug, Clone)]
pub struct IncompleteRecording {
    pub project_path: PathBuf,
    pub meta: RecordingMeta,
    pub recoverable_segments: Vec<RecoverableSegment>,
    pub estimated_duration: Duration,
}

#[derive(Debug, Clone)]
pub struct RecoverableSegment {
    pub index: u32,
    pub display_fragments: Vec<PathBuf>,
    pub display_init_segment: Option<PathBuf>,
    pub camera_fragments: Option<Vec<PathBuf>>,
    pub camera_init_segment: Option<PathBuf>,
    pub mic_fragments: Option<Vec<PathBuf>>,
    pub system_audio_fragments: Option<Vec<PathBuf>>,
    pub cursor_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct RecoveredRecording {
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
}

#[derive(Debug, Clone)]
struct FragmentsInfo {
    fragments: Vec<PathBuf>,
    init_segment: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
enum RecoveryPurpose {
    Recover,
    Finalize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VideoValidation {
    Full,
    Bounded,
}

impl RecoveryPurpose {
    fn video_validation(self, status: Option<StudioRecordingStatus>) -> VideoValidation {
        match (self, status) {
            (Self::Finalize, Some(StudioRecordingStatus::NeedsRemux)) => VideoValidation::Bounded,
            _ => VideoValidation::Full,
        }
    }

    fn success_message(self) -> &'static str {
        match self {
            Self::Recover => "Successfully recovered recording",
            Self::Finalize => "Successfully finalized fragmented recording",
        }
    }

    fn timeline_message(self) -> &'static str {
        match self {
            Self::Recover => "Created project configuration with timeline for recovered recording",
            Self::Finalize => "Created project configuration with timeline for finalized recording",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to concatenate video fragments: {0}")]
    VideoConcat(cap_enc_ffmpeg::remux::RemuxError),
    #[error("Failed to concatenate audio fragments: {0}")]
    AudioConcat(cap_enc_ffmpeg::remux::RemuxError),
    #[error("Failed to merge media streams: {0}")]
    MediaMerge(cap_enc_ffmpeg::remux::RemuxError),
    #[error("Failed to serialize meta: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("No recoverable segments found")]
    NoRecoverableSegments,
    #[error("Meta save failed")]
    MetaSave,
    #[error("Requested recording track failed; partial media preserved: {0}")]
    RequiredTrackFailure(String),
    #[error("Recovery validation failed; original recording preserved: {0}")]
    Validation(String),
    #[error("Recovered video is not playable: {0}")]
    UnplayableVideo(String),
}

pub struct RecoveryManager;

const EXPORT_SEEK_PROBE_SAMPLE_COUNT: usize = 8;

impl RecoveryManager {
    fn require_no_track_failure(project_path: &Path) -> Result<(), RecoveryError> {
        if let Ok(meta) = RecordingMeta::load_for_project(project_path)
            && let Some(studio) = meta.studio_meta()
        {
            return studio
                .ensure_ordinary_media_access(project_path)
                .map_err(RecoveryError::RequiredTrackFailure);
        }
        let path = project_path.join("recording-diagnostics.json");
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let diagnostics: serde_json::Value = serde_json::from_slice(&raw)?;
        let failed = diagnostics
            .get("segments")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|segments| {
                segments.iter().any(|segment| {
                    segment
                        .get("trackFailures")
                        .and_then(serde_json::Value::as_array)
                        .is_none_or(|failures| !failures.is_empty())
                })
            });
        if failed {
            return Err(RecoveryError::RequiredTrackFailure(
                "recording diagnostics retain a required-track failure".into(),
            ));
        }
        Ok(())
    }

    pub fn inspect_recording(project_path: &Path) -> Option<IncompleteRecording> {
        if !project_path.is_dir() {
            return None;
        }

        let _lock = RecoveryLock::acquire(project_path).ok()?;

        if !project_path.join("recording-meta.json").exists() {
            return None;
        }

        let meta = RecordingMeta::load_for_project(project_path).ok()?;

        Self::analyze_incomplete(project_path, &meta)
    }

    pub fn find_incomplete_single(project_path: &Path) -> Option<IncompleteRecording> {
        if !project_path.is_dir() {
            return None;
        }

        let _lock = RecoveryLock::acquire(project_path).ok()?;

        if !project_path.join("recording-meta.json").exists() {
            return None;
        }

        let meta = RecordingMeta::load_for_project(project_path).ok()?;

        if let Some(studio_meta) = meta.studio_meta()
            && Self::should_check_for_recovery(&studio_meta.status())
        {
            Self::analyze_incomplete(project_path, &meta)
        } else {
            None
        }
    }

    pub fn remux_if_needed(project_path: &Path) -> Result<bool, RecoveryError> {
        if !project_path.is_dir() {
            return Ok(false);
        }
        let incomplete = {
            let _lock = RecoveryLock::acquire(project_path)?;
            let Ok(meta) = RecordingMeta::load_for_project(project_path) else {
                return Ok(false);
            };
            meta.studio_meta()
                .filter(|studio| Self::should_check_for_recovery(&studio.status()))
                .and_then(|_| Self::analyze_incomplete(project_path, &meta))
        };
        let Some(incomplete) = incomplete else {
            return Ok(false);
        };

        if incomplete.recoverable_segments.is_empty() {
            return Ok(false);
        }

        Self::finalize(&incomplete)?;
        Ok(true)
    }

    pub fn find_incomplete(recordings_dir: &Path) -> Vec<IncompleteRecording> {
        let mut incomplete = Vec::new();

        let Ok(entries) = std::fs::read_dir(recordings_dir) else {
            return incomplete;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            if !path.join("recording-meta.json").exists() {
                continue;
            }

            let Ok(_lock) = RecoveryLock::acquire(&path) else {
                continue;
            };

            let Ok(meta) = RecordingMeta::load_for_project(&path) else {
                continue;
            };

            if let Some(studio_meta) = meta.studio_meta()
                && Self::should_check_for_recovery(&studio_meta.status())
            {
                match Self::analyze_incomplete(&path, &meta) {
                    Some(incomplete_recording) => {
                        incomplete.push(incomplete_recording);
                    }
                    None => {
                        Self::mark_unrecoverable(&path, &meta);
                    }
                }
            }
        }

        incomplete
    }

    fn should_check_for_recovery(status: &StudioRecordingStatus) -> bool {
        match status {
            StudioRecordingStatus::InProgress | StudioRecordingStatus::NeedsRemux => true,
            StudioRecordingStatus::Failed { .. } | StudioRecordingStatus::Complete => false,
        }
    }

    fn analyze_incomplete(
        project_path: &Path,
        meta: &RecordingMeta,
    ) -> Option<IncompleteRecording> {
        let content_dir = project_path.join("content");
        let segments_dir = content_dir.join("segments");

        if !segments_dir.exists() {
            debug!("No segments directory found at {:?}", segments_dir);
            return None;
        }

        let mut recoverable_segments = Vec::new();
        let mut total_duration = Duration::ZERO;

        let mut segment_dirs: Vec<_> = std::fs::read_dir(&segments_dir)
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();

        segment_dirs.sort_by_key(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("segment-")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(u32::MAX)
        });

        for segment_entry in &segment_dirs {
            let segment_path = segment_entry.path();

            let folder_name = segment_entry.file_name().to_string_lossy().to_string();
            let index: u32 = folder_name
                .strip_prefix("segment-")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            let display_dir = segment_path.join("display");
            let display_info = Self::find_complete_fragments_with_init(&display_dir);
            let mut display_fragments = display_info.fragments;
            let mut display_init_segment = display_info.init_segment;

            if display_fragments.is_empty()
                && let Some(display_mp4) =
                    Self::probe_single_file(&segment_path.join("display.mp4"))
            {
                display_fragments = vec![display_mp4];
                display_init_segment = None;
            }

            if display_fragments.is_empty() {
                debug!(
                    "No display fragments found for segment {} at {:?}",
                    index, segment_path
                );
                continue;
            }

            let camera_dir = segment_path.join("camera");
            let (camera_fragments, camera_init_segment) = {
                let camera_info = Self::find_complete_fragments_with_init(&camera_dir);
                if camera_info.fragments.is_empty() {
                    (
                        Self::probe_single_file(&segment_path.join("camera.mp4")).map(|p| vec![p]),
                        None,
                    )
                } else {
                    (Some(camera_info.fragments), camera_info.init_segment)
                }
            };

            let mic_fragments = Self::find_audio_fragments(&segment_path.join("audio-input"));
            let system_audio_fragments =
                Self::find_audio_fragments(&segment_path.join("system_audio"));

            if let Some(duration) = Self::estimate_fragments_duration(&display_fragments) {
                total_duration += duration;
            }

            let cursor_path = Self::probe_cursor(&segment_path.join("cursor.json"));

            recoverable_segments.push(RecoverableSegment {
                index,
                display_fragments,
                display_init_segment,
                camera_fragments,
                camera_init_segment,
                mic_fragments,
                system_audio_fragments,
                cursor_path,
            });
        }

        if recoverable_segments.is_empty() {
            finalization_info!("No fragmented segments found in {:?}", project_path);
            return None;
        }

        finalization_info!(
            "Found {} fragmented segments in {:?} with estimated duration {:?}",
            recoverable_segments.len(),
            project_path,
            total_duration
        );

        Some(IncompleteRecording {
            project_path: project_path.to_path_buf(),
            meta: meta.clone(),
            recoverable_segments,
            estimated_duration: total_duration,
        })
    }

    fn find_complete_fragments(dir: &Path) -> Vec<PathBuf> {
        Self::find_complete_fragments_with_init(dir).fragments
    }

    fn find_complete_fragments_with_init(dir: &Path) -> FragmentsInfo {
        use crate::fragmentation::CURRENT_MANIFEST_VERSION;

        let manifest_path = dir.join("manifest.json");
        let mut manifest_init_segment = None;

        if manifest_path.exists()
            && let Ok(content) = std::fs::read_to_string(&manifest_path)
            && let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content)
        {
            let manifest_version = manifest
                .get("version")
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as u32;

            let manifest_type = manifest
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("fragments");

            let max_supported_version = if manifest_type == "m4s_segments" {
                5
            } else {
                CURRENT_MANIFEST_VERSION
            };

            if manifest_version > max_supported_version {
                warn!(
                    "Manifest version {} is newer than supported {} for type {}",
                    manifest_version, max_supported_version, manifest_type
                );
            }

            let init_segment = manifest
                .get("init_segment")
                .and_then(|i| i.as_str())
                .and_then(|name| recovery_child_path(dir, name))
                .filter(|p| p.exists());
            manifest_init_segment = init_segment.clone();

            let entries = if manifest_type == "m4s_segments" {
                manifest.get("segments").and_then(|s| s.as_array())
            } else {
                manifest.get("fragments").and_then(|f| f.as_array())
            };

            if let Some(entries) = entries {
                let expected_file_size = |f: &serde_json::Value| -> Option<u64> {
                    f.get("file_size").and_then(|s| s.as_u64())
                };

                let mut result: Vec<PathBuf> = entries
                    .iter()
                    .filter(|f| {
                        f.get("is_complete")
                            .and_then(|c| c.as_bool())
                            .unwrap_or(false)
                    })
                    .filter_map(|f| {
                        let path_str = f.get("path").and_then(|p| p.as_str())?;
                        let path = recovery_child_path(dir, path_str)?;
                        if !path.exists() {
                            return None;
                        }

                        if let Some(expected_size) = expected_file_size(f)
                            && let Ok(metadata) = std::fs::metadata(&path)
                            && metadata.len() != expected_size
                        {
                            warn!(
                                "Fragment {} size mismatch: expected {}, got {}",
                                path.display(),
                                expected_size,
                                metadata.len()
                            );
                            return None;
                        }

                        if path
                            .extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("m4s"))
                            && !Self::is_m4s_complete(&path)
                        {
                            warn!("Fragment {} has an incomplete M4S tail", path.display());
                            return None;
                        }

                        if Self::is_video_file(&path) {
                            if init_segment.is_some() {
                                Some(path)
                            } else {
                                match probe_video_can_decode(&path) {
                                    Ok(true) => Some(path),
                                    Ok(false) => {
                                        warn!(
                                            "Fragment {} has no decodable frames",
                                            path.display()
                                        );
                                        None
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Fragment {} validation failed: {}",
                                            path.display(),
                                            e
                                        );
                                        None
                                    }
                                }
                            }
                        } else if probe_media_valid(&path) {
                            Some(path)
                        } else {
                            warn!("Fragment {} is not valid media", path.display());
                            None
                        }
                    })
                    .collect();

                if manifest_type == "m4s_segments" && init_segment.is_some() {
                    let listed: std::collections::HashSet<_> = entries
                        .iter()
                        .filter_map(|entry| entry.get("path").and_then(|path| path.as_str()))
                        .filter_map(|path| recovery_child_path(dir, path))
                        .collect();
                    result.extend(Self::probe_m4s_fragments_with_init(dir).into_iter().filter(
                        |path| {
                            !listed.contains(path)
                                && Self::m4s_fragment_index(path).is_some()
                                && path
                                    .symlink_metadata()
                                    .is_ok_and(|metadata| metadata.is_file())
                        },
                    ));
                    result.sort_by(|a, b| {
                        Self::m4s_fragment_index(a)
                            .cmp(&Self::m4s_fragment_index(b))
                            .then_with(|| a.cmp(b))
                    });
                }

                if !result.is_empty() {
                    return FragmentsInfo {
                        fragments: result,
                        init_segment,
                    };
                }
            }
        }

        if let Some(init_segment) = manifest_init_segment.or_else(|| {
            let path = dir.join("init.mp4");
            path.is_file().then_some(path)
        }) {
            let fragments = Self::probe_m4s_fragments_with_init(dir);
            if !fragments.is_empty() {
                return FragmentsInfo {
                    fragments,
                    init_segment: Some(init_segment),
                };
            }
        }

        FragmentsInfo {
            fragments: Self::probe_fragments_in_dir(dir),
            init_segment: None,
        }
    }

    fn collect_respawn_groups(
        dir: &Path,
        health_tx: Option<&HealthSender>,
    ) -> Vec<(u32, PathBuf, Vec<PathBuf>)> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut respawn_dirs: Vec<(u32, PathBuf)> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let n: u32 = name.strip_prefix("respawn-")?.parse().ok()?;
                Some((n, e.path()))
            })
            .collect();

        respawn_dirs.sort_by_key(|(n, _)| *n);

        let mut groups = Vec::new();
        for (n, respawn_dir) in respawn_dirs {
            let init_path = respawn_dir.join("init.mp4");
            if !init_path.exists() {
                debug!(
                    "respawn-{} at {} missing init.mp4",
                    n,
                    respawn_dir.display()
                );
                continue;
            }

            Self::rescue_pending_tmp_fragments(&respawn_dir, health_tx);

            let Ok(dir_entries) = std::fs::read_dir(&respawn_dir) else {
                debug!(
                    "respawn-{} at {} could not be read",
                    n,
                    respawn_dir.display()
                );
                continue;
            };

            let mut indexed: Vec<(u32, PathBuf)> = dir_entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter_map(|p| {
                    let name = p.file_name()?.to_str()?;
                    let idx: u32 = name
                        .strip_prefix("segment_")
                        .and_then(|s| s.strip_suffix(".m4s"))
                        .and_then(|s| s.parse().ok())?;
                    if !Self::is_m4s_complete(&p) {
                        debug!("Skipping incomplete respawn fragment {}", p.display());
                        return None;
                    }
                    Some((idx, p))
                })
                .collect();

            if indexed.is_empty() {
                debug!(
                    "respawn-{} at {} has no segment_*.m4s fragments",
                    n,
                    respawn_dir.display()
                );
                continue;
            }

            indexed.sort_by_key(|(idx, _)| *idx);

            finalization_info!(
                "Including {} fragments from respawn-{} at {}",
                indexed.len(),
                n,
                respawn_dir.display()
            );

            let fragments: Vec<PathBuf> = indexed.into_iter().map(|(_, p)| p).collect();
            groups.push((n, init_path, fragments));
        }

        groups
    }

    fn rescue_pending_tmp_fragments(dir: &Path, health_tx: Option<&HealthSender>) {
        const MIN_VALID_TMP_SIZE: u64 = 100;

        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with("segment_") || !name.ends_with(".m4s.tmp") {
                continue;
            }
            let Ok(metadata) = std::fs::metadata(&path) else {
                continue;
            };
            if metadata.len() < MIN_VALID_TMP_SIZE {
                continue;
            }
            let corrupt_marker = dir.join(format!("{name}.corrupt"));
            if corrupt_marker.exists() {
                continue;
            }
            let final_name = name.trim_end_matches(".tmp");
            let final_path = dir.join(final_name);
            if final_path.exists() {
                continue;
            }
            match tail_is_complete(&path) {
                Ok(true) => {}
                Ok(false) => {
                    let reason = "truncated_fragment".to_string();
                    warn!("Refusing to rescue truncated fragment {}", path.display());
                    if let Some(health_tx) = health_tx {
                        emit_health(
                            health_tx,
                            PipelineHealthEvent::RecoveryFragmentCorrupt {
                                path: path.display().to_string(),
                                reason: reason.clone(),
                            },
                        );
                    }
                    let _ = std::fs::write(&corrupt_marker, &reason);
                    continue;
                }
                Err(error) => {
                    let reason = error.to_string();
                    warn!(
                        "Failed to inspect in-progress tmp fragment {}: {}",
                        path.display(),
                        error
                    );
                    if let Some(health_tx) = health_tx {
                        emit_health(
                            health_tx,
                            PipelineHealthEvent::RecoveryFragmentCorrupt {
                                path: path.display().to_string(),
                                reason: reason.clone(),
                            },
                        );
                    }
                    let _ = std::fs::write(&corrupt_marker, reason);
                    continue;
                }
            }
            match std::fs::rename(&path, &final_path) {
                Ok(()) => {
                    finalization_info!(
                        "Rescued in-progress tmp fragment: {} -> {} ({} bytes)",
                        path.display(),
                        final_path.display(),
                        metadata.len()
                    );
                }
                Err(e) => {
                    debug!("Failed to rescue tmp fragment {}: {}", path.display(), e);
                }
            }
        }
    }

    fn is_video_file(path: &Path) -> bool {
        path.extension()
            .map(|e| e.eq_ignore_ascii_case("mp4") || e.eq_ignore_ascii_case("m4s"))
            .unwrap_or(false)
    }

    fn probe_fragments_in_dir(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut fragments: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase());
                match ext.as_deref() {
                    Some("m4s") if !Self::is_m4s_complete(p) => false,
                    Some("mp4") | Some("m4s") => match probe_video_can_decode(p) {
                        Ok(true) => true,
                        Ok(false) => {
                            debug!("Skipping {} - no decodable frames", p.display());
                            false
                        }
                        Err(e) => {
                            debug!("Skipping {} - validation failed: {}", p.display(), e);
                            false
                        }
                    },
                    Some("m4a") | Some("ogg") => probe_media_valid(p),
                    _ => false,
                }
            })
            .collect();

        fragments.sort();
        fragments
    }

    fn probe_m4s_fragments_with_init(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut fragments: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| Self::is_m4s_complete(p))
            .collect();

        fragments.sort_by(|a, b| {
            Self::m4s_fragment_index(a)
                .cmp(&Self::m4s_fragment_index(b))
                .then_with(|| a.cmp(b))
        });
        fragments
    }

    pub fn is_m4s_complete(path: &Path) -> bool {
        const MIN_VALID_FRAGMENT_SIZE: u64 = 100;

        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("m4s"))
            && std::fs::symlink_metadata(path).is_ok_and(|metadata| {
                metadata.is_file() && metadata.len() >= MIN_VALID_FRAGMENT_SIZE
            })
            && tail_is_complete(path).unwrap_or(false)
    }

    fn m4s_fragment_index(path: &Path) -> Option<u64> {
        path.file_name()?
            .to_str()?
            .strip_prefix("segment_")?
            .strip_suffix(".m4s")?
            .parse()
            .ok()
    }

    fn probe_single_file(path: &Path) -> Option<PathBuf> {
        if !path.exists() {
            return None;
        }

        if Self::is_video_file(path) {
            match probe_video_can_decode(path) {
                Ok(true) => Some(path.to_path_buf()),
                Ok(false) => {
                    debug!("Single file {} has no decodable frames", path.display());
                    None
                }
                Err(e) => {
                    debug!("Single file {} validation failed: {}", path.display(), e);
                    None
                }
            }
        } else if probe_media_valid(path) {
            Some(path.to_path_buf())
        } else {
            None
        }
    }

    fn find_audio_fragments(base_path: &Path) -> Option<Vec<PathBuf>> {
        let dir_fragments = Self::find_complete_fragments(base_path);
        if !dir_fragments.is_empty() {
            return Some(dir_fragments);
        }

        let ogg_path = base_path.with_extension("ogg");
        if let Some(p) = Self::probe_single_file(&ogg_path) {
            return Some(vec![p]);
        }

        let m4a_path = base_path.with_extension("m4a");
        if let Some(p) = Self::probe_single_file(&m4a_path) {
            return Some(vec![p]);
        }

        let mp3_path = base_path.with_extension("mp3");
        Self::probe_single_file(&mp3_path).map(|p| vec![p])
    }

    fn probe_cursor(path: &Path) -> Option<PathBuf> {
        if path.exists() {
            Some(path.to_path_buf())
        } else {
            None
        }
    }

    fn estimate_fragments_duration(fragments: &[PathBuf]) -> Option<Duration> {
        let mut total = Duration::ZERO;

        for fragment in fragments {
            if let Some(duration) = get_media_duration(fragment) {
                total += duration;
            }
        }

        if total.is_zero() { None } else { Some(total) }
    }

    /// Reads the display media duration the recorder persisted into the
    /// project's default timeline, used to cross-check the remuxed container.
    fn expected_display_duration_from_config(
        project_path: &Path,
        segment_index: u32,
    ) -> Option<std::time::Duration> {
        let config = std::fs::read_to_string(project_path.join("project-config.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&config).ok()?;
        let segments = value.get("timeline")?.get("segments")?.as_array()?;
        let segment = segments.iter().find(|s| {
            s.get("recordingSegment")
                .and_then(serde_json::Value::as_u64)
                == Some(u64::from(segment_index))
        })?;
        let end = segment.get("end")?.as_f64()?;
        let start = segment
            .get("start")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        (end > start && end.is_finite()).then(|| std::time::Duration::from_secs_f64(end - start))
    }

    pub fn recover(recording: &IncompleteRecording) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_purpose(recording, RecoveryPurpose::Recover)
    }

    pub fn finalize(recording: &IncompleteRecording) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_purpose(recording, RecoveryPurpose::Finalize)
    }

    fn finalize_with_purpose(
        recording: &IncompleteRecording,
        purpose: RecoveryPurpose,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::require_no_track_failure(&recording.project_path)?;
        let project = &recording.project_path;
        let _lock = RecoveryLock::acquire(project)?;
        let before = recovery_snapshot(project)?;
        let current = RecordingMeta::load_for_project(project)
            .map_err(|error| RecoveryError::Validation(error.to_string()))?;
        if serde_json::to_value(&current)? != serde_json::to_value(&recording.meta)? {
            return Err(RecoveryError::Validation(
                "Recording metadata changed".into(),
            ));
        }
        let video_validation =
            purpose.video_validation(current.studio_meta().map(|studio| studio.status()));
        Self::require_recoverable_tracks(recording)?;
        let workspace = project.join(format!(".recovery-{}", uuid::Uuid::new_v4()));
        create_private_recovery_dir(&workspace)?;
        let staged = workspace.join("staged");
        create_private_recovery_dir(&staged)?;
        let prepared = (|| {
            for name in RECOVERY_INPUTS {
                let source = project.join(name);
                if source.try_exists()? {
                    copy_recovery_input(&source, &staged.join(name))?;
                }
            }
            if recovery_snapshot(&staged)? != before || recovery_snapshot(project)? != before {
                return Err(RecoveryError::Validation(
                    "Recording changed while copying".into(),
                ));
            }
            let staged_meta = RecordingMeta::load_for_project(&staged)
                .map_err(|error| RecoveryError::Validation(error.to_string()))?;
            for (index, track) in legacy_omitted_tracks(&staged_meta, &staged)? {
                let segment = staged.join(format!("content/segments/segment-{index}"));
                for suffix in ["", ".mp4", ".m4a", ".ogg", ".mp3"] {
                    let path = segment.join(format!("{track}{suffix}"));
                    let metadata = match path.symlink_metadata() {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.into()),
                    };
                    reject_recovery_link(&metadata)?;
                    if metadata.is_dir() {
                        std::fs::remove_dir_all(&path)?;
                    } else {
                        std::fs::remove_file(&path)?;
                    }
                }
            }
            validate_recovery_manifests(&staged.join("content"))?;
            let staged_recording = Self::analyze_incomplete(&staged, &staged_meta)
                .ok_or(RecoveryError::NoRecoverableSegments)?;
            Self::require_recoverable_tracks(&staged_recording)?;
            Self::require_local_fragments(&staged_recording)?;
            Self::validate_staged_inputs(&staged_recording, video_validation)?;
            let recovered = Self::finalize_staged(&staged_recording, purpose, video_validation)?;
            let config = ProjectConfiguration::load(&staged)?;
            config
                .validate()
                .map_err(|error| RecoveryError::Validation(error.to_string()))?;
            let persisted = RecordingMeta::load_for_project(&staged)
                .map_err(|error| RecoveryError::Validation(error.to_string()))?;
            if serde_json::to_value(persisted.studio_meta())?
                != serde_json::to_value(&recovered.meta)?
            {
                return Err(RecoveryError::Validation("Staged metadata mismatch".into()));
            }
            sync_recovery_input(&staged)?;
            Self::require_no_track_failure(project)?;
            if recovery_snapshot(project)? != before {
                return Err(RecoveryError::Validation(
                    "Recording changed before publication".into(),
                ));
            }
            Ok(recovered.meta)
        })();
        let meta = match prepared {
            Ok(meta) => meta,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&workspace);
                return Err(error);
            }
        };
        publish_recovery(project, &workspace)?;
        finalization_info!(path = %workspace.display(), "Recovered recording retains original media backup");
        Ok(RecoveredRecording {
            project_path: project.clone(),
            meta,
        })
    }

    fn validate_staged_inputs(
        recording: &IncompleteRecording,
        video_validation: VideoValidation,
    ) -> Result<(), RecoveryError> {
        for segment in &recording.recoverable_segments {
            validate_recovery_video_inputs(
                &segment.display_fragments,
                segment.display_init_segment.as_deref(),
                &recording.project_path,
                video_validation,
            )?;
            let display_dir = recording.project_path.join(format!(
                "content/segments/segment-{}/display",
                segment.index
            ));
            for (_, init, fragments) in Self::collect_respawn_groups(&display_dir, None) {
                validate_recovery_video_inputs(
                    &fragments,
                    Some(&init),
                    &recording.project_path,
                    video_validation,
                )?;
            }
            if let Some(fragments) = &segment.camera_fragments {
                validate_recovery_video_inputs(
                    fragments,
                    segment.camera_init_segment.as_deref(),
                    &recording.project_path,
                    video_validation,
                )?;
            }
            for path in segment
                .mic_fragments
                .iter()
                .flatten()
                .chain(segment.system_audio_fragments.iter().flatten())
            {
                validate_recovered_track(path, ffmpeg::media::Type::Audio)?;
            }
        }
        Ok(())
    }

    fn require_local_fragments(recording: &IncompleteRecording) -> Result<(), RecoveryError> {
        let content = recording.project_path.join("content").canonicalize()?;
        for segment in &recording.recoverable_segments {
            for path in segment
                .display_fragments
                .iter()
                .chain(segment.display_init_segment.iter())
                .chain(segment.camera_fragments.iter().flatten())
                .chain(segment.camera_init_segment.iter())
                .chain(segment.mic_fragments.iter().flatten())
                .chain(segment.system_audio_fragments.iter().flatten())
            {
                if !path.canonicalize()?.starts_with(&content) {
                    return Err(RecoveryError::Validation(
                        "Fragment escapes recording content".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn require_recoverable_tracks(recording: &IncompleteRecording) -> Result<(), RecoveryError> {
        let Some(StudioRecordingMeta::MultipleSegments { inner }) = recording.meta.studio_meta()
        else {
            return Err(RecoveryError::Validation(
                "Recovery requires segmented Studio metadata".into(),
            ));
        };
        let legacy_omitted = legacy_omitted_tracks(&recording.meta, &recording.project_path)?;
        let mut indexes = std::collections::BTreeSet::new();
        for segment in &recording.recoverable_segments {
            if !indexes.insert(segment.index) || segment.display_fragments.is_empty() {
                return Err(RecoveryError::Validation(
                    "Missing or duplicate display segment".into(),
                ));
            }
            let original = inner.segments.get(segment.index as usize);
            let dir = recording
                .project_path
                .join(format!("content/segments/segment-{}", segment.index));
            for (name, known, fragments) in [
                (
                    "camera",
                    original.is_some_and(|s| s.camera.is_some()),
                    segment.camera_fragments.as_ref(),
                ),
                (
                    "audio-input",
                    original.is_some_and(|s| s.mic.is_some()),
                    segment.mic_fragments.as_ref(),
                ),
                (
                    "system_audio",
                    original.is_some_and(|s| s.system_audio.is_some()),
                    segment.system_audio_fragments.as_ref(),
                ),
            ] {
                let present = ["", ".mp4", ".m4a", ".ogg", ".mp3"]
                    .iter()
                    .any(|suffix| dir.join(format!("{name}{suffix}")).exists());
                let legacy_discarded = legacy_omitted.contains(&(segment.index as usize, name));
                if (known || (present && !legacy_discarded)) && fragments.is_none_or(Vec::is_empty)
                {
                    return Err(RecoveryError::Validation(format!(
                        "Missing or invalid {name} in segment {}",
                        segment.index
                    )));
                }
            }
        }
        for index in 0..inner.segments.len() {
            if !indexes.contains(&(index as u32)) {
                return Err(RecoveryError::Validation(format!(
                    "Missing display segment {index}"
                )));
            }
        }
        for entry in std::fs::read_dir(recording.project_path.join("content/segments"))? {
            let entry = entry?;
            if let Some(index) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix("segment-"))
                .and_then(|value| value.parse::<u32>().ok())
                && !indexes.contains(&index)
            {
                return Err(RecoveryError::Validation(format!(
                    "Unrecoverable display segment {index}"
                )));
            }
        }
        Ok(())
    }

    fn finalize_staged(
        recording: &IncompleteRecording,
        purpose: RecoveryPurpose,
        video_validation: VideoValidation,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::require_no_track_failure(&recording.project_path)?;
        if recording.recoverable_segments.is_empty() {
            return Err(RecoveryError::NoRecoverableSegments);
        }

        for segment in &recording.recoverable_segments {
            let segment_dir = recording
                .project_path
                .join("content/segments")
                .join(format!("segment-{}", segment.index));

            let display_output = segment_dir.join("display.mp4");
            let display_dir = segment_dir.join("display");

            if segment.display_fragments.len() == 1 && segment.display_init_segment.is_none() {
                let source = &segment.display_fragments[0];
                if source != &display_output {
                    finalization_info!("Moving single display fragment to {:?}", display_output);
                    std::fs::rename(source, &display_output)?;
                }
                Self::validate_required_video(&display_output, "display")?;
                if display_dir.exists()
                    && let Err(e) = std::fs::remove_dir_all(&display_dir)
                {
                    debug!("Failed to clean up display dir {:?}: {e}", display_dir);
                }
            } else if !segment.display_fragments.is_empty() {
                let finalize_result = if display_dir.exists() {
                    Self::finalize_to_progressive_mp4(&display_dir, &display_output).map(|_| ())
                } else {
                    Self::finalize_fragments_to_progressive_mp4(
                        &segment.display_fragments,
                        segment.display_init_segment.as_deref(),
                        &display_output,
                        "display",
                    )
                };

                match finalize_result {
                    Ok(()) => {}
                    Err(err) => {
                        if let Err(e) = std::fs::remove_file(&display_output)
                            && e.kind() != std::io::ErrorKind::NotFound
                        {
                            debug!(
                                "Failed to remove invalid display output {:?}: {e}",
                                display_output
                            );
                        }
                        return Err(err);
                    }
                }

                if display_dir.exists()
                    && let Err(e) = std::fs::remove_dir_all(&display_dir)
                {
                    debug!("Failed to clean up display dir {:?}: {e}", display_dir);
                }
            }

            // Sync invariant: the remuxed display track must match the media
            // span the recorder persisted from its capture timestamps.
            if display_output.is_file()
                && let Some(expected) = Self::expected_display_duration_from_config(
                    &recording.project_path,
                    segment.index,
                )
            {
                crate::output_validation::check_display_sync_span(&display_output, expected);
            }

            if let Some(camera_frags) = &segment.camera_fragments {
                let camera_output = segment_dir.join("camera.mp4");
                if camera_frags.len() == 1 && segment.camera_init_segment.is_none() {
                    if camera_frags[0] != camera_output {
                        std::fs::rename(&camera_frags[0], &camera_output)?;
                    }
                    Self::validate_required_video(&camera_output, "camera")?;
                } else {
                    Self::finalize_fragments_to_progressive_mp4(
                        camera_frags,
                        segment.camera_init_segment.as_deref(),
                        &camera_output,
                        "camera",
                    )?;
                }
                let camera_dir = segment_dir.join("camera");
                if camera_dir.exists() {
                    std::fs::remove_dir_all(camera_dir)?;
                }
            }

            if let Some(mic_frags) = &segment.mic_fragments {
                let mic_output = segment_dir.join("audio-input.ogg");
                if mic_frags.len() == 1 {
                    let source = &mic_frags[0];
                    let is_ogg = source.extension().map(|e| e == "ogg").unwrap_or(false);
                    if source != &mic_output {
                        if is_ogg {
                            finalization_info!("Moving single mic fragment to {:?}", mic_output);
                            std::fs::rename(source, &mic_output)?;
                        } else {
                            finalization_info!(
                                "Transcoding single mic fragment to {:?}",
                                mic_output
                            );
                            concatenate_audio_to_ogg(mic_frags, &mic_output)
                                .map_err(RecoveryError::AudioConcat)?;
                            if let Err(e) = std::fs::remove_file(source) {
                                debug!("Failed to remove mic source {:?}: {e}", source);
                            }
                        }
                        let mic_dir = segment_dir.join("audio-input");
                        if mic_dir.exists()
                            && let Err(e) = std::fs::remove_dir_all(&mic_dir)
                        {
                            debug!("Failed to clean up mic dir {:?}: {e}", mic_dir);
                        }
                    }
                } else if mic_frags.len() > 1 {
                    finalization_info!(
                        "Concatenating {} mic fragments to {:?}",
                        mic_frags.len(),
                        mic_output
                    );
                    concatenate_audio_to_ogg(mic_frags, &mic_output)
                        .map_err(RecoveryError::AudioConcat)?;

                    for fragment in mic_frags {
                        if let Err(e) = std::fs::remove_file(fragment) {
                            debug!("Failed to remove mic fragment {:?}: {e}", fragment);
                        }
                    }
                    let mic_dir = segment_dir.join("audio-input");
                    if mic_dir.exists()
                        && let Err(e) = std::fs::remove_dir_all(&mic_dir)
                    {
                        debug!("Failed to clean up mic dir {:?}: {e}", mic_dir);
                    }
                }
            }

            if let Some(system_frags) = &segment.system_audio_fragments {
                let system_output = segment_dir.join("system_audio.ogg");
                if system_frags.len() == 1 {
                    let source = &system_frags[0];
                    let is_ogg = source.extension().map(|e| e == "ogg").unwrap_or(false);
                    if source != &system_output {
                        if is_ogg {
                            finalization_info!(
                                "Moving single system audio fragment to {:?}",
                                system_output
                            );
                            std::fs::rename(source, &system_output)?;
                        } else {
                            finalization_info!(
                                "Transcoding single system audio fragment to {:?}",
                                system_output
                            );
                            concatenate_audio_to_ogg(system_frags, &system_output)
                                .map_err(RecoveryError::AudioConcat)?;
                            if let Err(e) = std::fs::remove_file(source) {
                                debug!("Failed to remove system audio source {:?}: {e}", source);
                            }
                        }
                        let system_dir = segment_dir.join("system_audio");
                        if system_dir.exists()
                            && let Err(e) = std::fs::remove_dir_all(&system_dir)
                        {
                            debug!("Failed to clean up system audio dir {:?}: {e}", system_dir);
                        }
                    }
                } else if system_frags.len() > 1 {
                    finalization_info!(
                        "Concatenating {} system audio fragments to {:?}",
                        system_frags.len(),
                        system_output
                    );
                    concatenate_audio_to_ogg(system_frags, &system_output)
                        .map_err(RecoveryError::AudioConcat)?;

                    for fragment in system_frags {
                        if let Err(e) = std::fs::remove_file(fragment) {
                            debug!("Failed to remove system audio fragment {:?}: {e}", fragment);
                        }
                    }
                    let system_dir = segment_dir.join("system_audio");
                    if system_dir.exists()
                        && let Err(e) = std::fs::remove_dir_all(&system_dir)
                    {
                        debug!("Failed to clean up system audio dir {:?}: {e}", system_dir);
                    }
                }
            }
        }

        for segment in &recording.recoverable_segments {
            let dir = recording
                .project_path
                .join(format!("content/segments/segment-{}", segment.index));
            validate_recovery_track(
                &dir.join("display.mp4"),
                ffmpeg::media::Type::Video,
                video_validation,
            )?;
            for (fragments, name, kind) in [
                (
                    segment.camera_fragments.as_ref(),
                    "camera.mp4",
                    ffmpeg::media::Type::Video,
                ),
                (
                    segment.mic_fragments.as_ref(),
                    "audio-input.ogg",
                    ffmpeg::media::Type::Audio,
                ),
                (
                    segment.system_audio_fragments.as_ref(),
                    "system_audio.ogg",
                    ffmpeg::media::Type::Audio,
                ),
            ] {
                if fragments.is_some() {
                    validate_recovery_track(&dir.join(name), kind, video_validation)?;
                }
            }
        }
        let meta = Self::build_recovered_meta(recording)?;

        let mut recording_meta = recording.meta.clone();
        recording_meta.inner = RecordingMetaInner::Studio(Box::new(meta.clone()));
        recording_meta
            .save_for_project()
            .map_err(|_| RecoveryError::MetaSave)?;

        Self::create_project_config(recording, &meta, purpose)?;

        finalization_info!(
            "{} at {:?}",
            purpose.success_message(),
            recording.project_path
        );

        Ok(RecoveredRecording {
            project_path: recording.project_path.clone(),
            meta,
        })
    }

    pub fn finalize_to_progressive_mp4(
        fragmented_dir: &Path,
        output: &Path,
    ) -> Result<PathBuf, RecoveryError> {
        Self::finalize_to_progressive_mp4_with_health(fragmented_dir, output, None)
    }

    pub fn finalize_instant_output(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
    ) -> Result<PathBuf, RecoveryError> {
        let content = output
            .parent()
            .ok_or_else(|| RecoveryError::Validation("Instant output has no parent".into()))?;
        if display_dir.parent() != Some(content) || audio_dir.parent() != Some(content) {
            return Err(RecoveryError::Validation(
                "Instant tracks must share the output directory".into(),
            ));
        }
        let project = content
            .parent()
            .ok_or_else(|| RecoveryError::Validation("Instant content has no project".into()))?;
        if content.file_name().is_none_or(|name| name != "content") {
            return Err(RecoveryError::Validation(
                "Instant tracks must be in project content".into(),
            ));
        }
        Self::require_no_track_failure(project)?;
        let _lock = RecoveryLock::acquire(project)?;
        let before = recovery_snapshot(project)?;
        let mut expected_audio = audio_dir.try_exists()?;
        if project.join("recording-meta.json").try_exists()? {
            let meta = RecordingMeta::load_for_project(project)
                .map_err(|error| RecoveryError::Validation(error.to_string()))?;
            match meta.inner {
                RecordingMetaInner::Instant(cap_project::InstantRecordingMeta::Failed {
                    error,
                }) => {
                    return Err(RecoveryError::RequiredTrackFailure(error));
                }
                RecordingMetaInner::Instant(cap_project::InstantRecordingMeta::Complete {
                    sample_rate,
                    ..
                }) => {
                    expected_audio |= sample_rate.is_some();
                }
                RecordingMetaInner::Instant(_) => {}
                _ => {
                    return Err(RecoveryError::Validation(
                        "Instant output requires Instant metadata".into(),
                    ));
                }
            }
        }
        let workspace = project.join(format!(".recovery-{}", uuid::Uuid::new_v4()));
        create_private_recovery_dir(&workspace)?;
        let staged = workspace.join("content");
        let result = (|| {
            copy_recovery_input(content, &staged)?;
            validate_recovery_manifests(&staged)?;
            let display = staged.join(
                display_dir
                    .file_name()
                    .ok_or_else(|| RecoveryError::Validation("Missing display name".into()))?,
            );
            let audio = staged.join(
                audio_dir
                    .file_name()
                    .ok_or_else(|| RecoveryError::Validation("Missing audio name".into()))?,
            );
            let final_output = staged.join(
                output
                    .file_name()
                    .ok_or_else(|| RecoveryError::Validation("Missing output name".into()))?,
            );
            if final_output.is_file()
                && let Ok(input) = ffmpeg::format::input(&final_output)
            {
                expected_audio |= input.streams().best(ffmpeg::media::Type::Audio).is_some();
            }
            if expected_audio && !audio.is_dir() {
                return Err(RecoveryError::Validation(
                    "Missing required Instant audio".into(),
                ));
            }
            Self::rescue_pending_tmp_fragments(&display, None);
            let video = Self::find_complete_fragments_with_init(&display);
            validate_recovery_video_inputs(
                &video.fragments,
                video.init_segment.as_deref(),
                &workspace,
                VideoValidation::Full,
            )?;
            Self::finalize_instant_staged(&display, &audio, &final_output)?;
            validate_recovered_track(&final_output, ffmpeg::media::Type::Video)?;
            if expected_audio {
                validate_recovered_track(&final_output, ffmpeg::media::Type::Audio)?;
            }
            sync_recovery_input(&final_output)?;
            Self::require_no_track_failure(project)?;
            if recovery_snapshot(project)? != before {
                return Err(RecoveryError::Validation(
                    "Instant recording changed during finalization".into(),
                ));
            }
            if output.try_exists()? {
                copy_recovery_input(output, &workspace.join("original-output.mp4"))?;
            }
            std::fs::rename(&final_output, output)?;
            Ok(output.to_path_buf())
        })();
        match result {
            Ok(output) => {
                std::fs::remove_dir_all(&workspace)?;
                Ok(output)
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&workspace);
                Err(error)
            }
        }
    }

    fn finalize_instant_staged(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
    ) -> Result<PathBuf, RecoveryError> {
        if !audio_dir.exists() {
            return Self::finalize_to_progressive_mp4(display_dir, output);
        }

        Self::rescue_pending_tmp_fragments(audio_dir, None);
        let audio_info = Self::find_complete_fragments_with_init(audio_dir);
        if audio_info.fragments.is_empty() {
            return Err(RecoveryError::Validation(
                "Required Instant audio has no recoverable fragments".into(),
            ));
        }

        let parent = output.parent().unwrap_or_else(|| Path::new("."));
        validate_recovery_track_inputs(
            &audio_info.fragments,
            audio_info.init_segment.as_deref(),
            parent,
            ffmpeg::media::Type::Audio,
            VideoValidation::Full,
        )?;
        std::fs::create_dir_all(parent)?;
        let stem = output
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("instant");
        let video_output = parent.join(format!("{stem}.video.mp4"));
        let audio_output = parent.join(format!("{stem}.audio.mp4"));
        let merged_output = parent.join(format!("{stem}.merged.mp4"));

        let result = (|| {
            Self::finalize_to_progressive_mp4(display_dir, &video_output)?;
            Self::finalize_audio_fragments_to_progressive_mp4(
                &audio_info.fragments,
                audio_info.init_segment.as_deref(),
                &audio_output,
                "audio",
            )?;
            merge_video_audio(&video_output, &audio_output, &merged_output)
                .map_err(RecoveryError::MediaMerge)?;
            Self::validate_required_video(&merged_output, "display")?;
            replace_file(&merged_output, output)?;
            Ok(output.to_path_buf())
        })();

        for path in [&video_output, &audio_output, &merged_output] {
            if path.exists() && path != output {
                let _ = std::fs::remove_file(path);
            }
        }

        result
    }

    pub fn finalize_to_progressive_mp4_with_health(
        fragmented_dir: &Path,
        output: &Path,
        health_tx: Option<&HealthSender>,
    ) -> Result<PathBuf, RecoveryError> {
        Self::rescue_pending_tmp_fragments(fragmented_dir, health_tx);

        let info = Self::find_complete_fragments_with_init(fragmented_dir);
        if info.fragments.is_empty() {
            return Err(RecoveryError::NoRecoverableSegments);
        }

        let respawn_groups = Self::collect_respawn_groups(fragmented_dir, health_tx);

        if respawn_groups.is_empty() {
            Self::finalize_fragments_to_progressive_mp4(
                &info.fragments,
                info.init_segment.as_deref(),
                output,
                "display",
            )?;
            return Ok(output.to_path_buf());
        }

        let mut group_outputs: Vec<PathBuf> = Vec::new();
        let mut temp_paths: Vec<PathBuf> = Vec::new();
        let stem = output
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("recovered");
        let parent = output.parent().unwrap_or_else(|| Path::new("."));

        let main_tmp = parent.join(format!("{stem}.main.mp4"));
        Self::finalize_fragments_to_progressive_mp4(
            &info.fragments,
            info.init_segment.as_deref(),
            &main_tmp,
            "display",
        )?;
        temp_paths.push(main_tmp.clone());
        group_outputs.push(main_tmp);

        for (n, init, fragments) in respawn_groups {
            let group_tmp = parent.join(format!("{stem}.respawn-{n}.mp4"));
            Self::finalize_fragments_to_progressive_mp4(
                &fragments,
                Some(init.as_path()),
                &group_tmp,
                &format!("display respawn-{n}"),
            )?;
            temp_paths.push(group_tmp.clone());
            group_outputs.push(group_tmp);
        }

        let concat_result = if group_outputs.len() == 1 {
            std::fs::rename(&group_outputs[0], output)
                .map_err(|e| RecoveryError::VideoConcat(cap_enc_ffmpeg::remux::RemuxError::Io(e)))
        } else {
            concatenate_video_fragments(&group_outputs, output).map_err(RecoveryError::VideoConcat)
        };

        for tmp in &temp_paths {
            if tmp.exists() && tmp != output {
                let _ = std::fs::remove_file(tmp);
            }
        }

        concat_result?;
        Self::validate_required_video(output, "display")?;

        Ok(output.to_path_buf())
    }

    fn finalize_fragments_to_progressive_mp4(
        fragments: &[PathBuf],
        init_segment: Option<&Path>,
        output: &Path,
        label: &str,
    ) -> Result<(), RecoveryError> {
        if fragments.is_empty() {
            return Err(RecoveryError::NoRecoverableSegments);
        }

        if let Some(init_path) = init_segment {
            finalization_info!(
                "Concatenating {} M4S {label} segments with init to {:?}",
                fragments.len(),
                output
            );
            concatenate_m4s_segments_with_init(init_path, fragments, output)
                .map_err(RecoveryError::VideoConcat)?;
        } else {
            finalization_info!(
                "Concatenating {} {label} fragments to {:?}",
                fragments.len(),
                output
            );
            concatenate_video_fragments(fragments, output).map_err(RecoveryError::VideoConcat)?;
        }

        Self::validate_required_video(output, label)?;
        Ok(())
    }

    fn finalize_audio_fragments_to_progressive_mp4(
        fragments: &[PathBuf],
        init_segment: Option<&Path>,
        output: &Path,
        label: &str,
    ) -> Result<(), RecoveryError> {
        if fragments.is_empty() {
            return Err(RecoveryError::NoRecoverableSegments);
        }

        if let Some(init_path) = init_segment {
            finalization_info!(
                "Concatenating {} M4S {label} segments with init to {:?}",
                fragments.len(),
                output
            );
            concatenate_m4s_segments_with_init(init_path, fragments, output)
                .map_err(RecoveryError::AudioConcat)?;
        } else {
            finalization_info!(
                "Concatenating {} {label} fragments to {:?}",
                fragments.len(),
                output
            );
            concatenate_video_fragments(fragments, output).map_err(RecoveryError::AudioConcat)?;
        }

        Ok(())
    }

    fn validate_required_video(path: &Path, label: &str) -> Result<(), RecoveryError> {
        finalization_info!("Validating finalized {} video: {:?}", label, path);

        Self::ensure_video_decodes(path, label)?;

        if let Err(seek_error) = probe_video_seek_points(path, EXPORT_SEEK_PROBE_SAMPLE_COUNT) {
            finalization_info!(
                "Finalized {} video failed seek validation, normalizing via remux: {}",
                label,
                seek_error
            );
            Self::normalize_recovered_video(path, label)?;
        }

        Ok(())
    }

    fn ensure_video_decodes(path: &Path, label: &str) -> Result<(), RecoveryError> {
        match probe_video_can_decode(path) {
            Ok(true) => Ok(()),
            Ok(false) => Err(RecoveryError::UnplayableVideo(format!(
                "{label} video has no decodable frames: {path:?}"
            ))),
            Err(e) => Err(RecoveryError::UnplayableVideo(format!(
                "{label} video validation failed for {path:?}: {e}"
            ))),
        }
    }

    fn normalize_recovered_video(path: &Path, label: &str) -> Result<(), RecoveryError> {
        let normalized_path = path.with_extension("normalized.mp4");

        remux_file(path, &normalized_path).map_err(RecoveryError::VideoConcat)?;

        replace_file(&normalized_path, path)?;

        Self::ensure_video_decodes(path, label)?;

        probe_video_seek_points(path, EXPORT_SEEK_PROBE_SAMPLE_COUNT).map_err(|e| {
            RecoveryError::UnplayableVideo(format!(
                "{label} video seek validation failed for {path:?}: {e}"
            ))
        })?;

        finalization_info!(
            "Finalized {} video validation passed after normalization",
            label
        );

        Ok(())
    }

    fn build_recovered_meta(
        recording: &IncompleteRecording,
    ) -> Result<StudioRecordingMeta, RecoveryError> {
        let original_segments = match recording.meta.studio_meta() {
            Some(StudioRecordingMeta::MultipleSegments { inner, .. }) => Some(&inner.segments),
            _ => None,
        };

        let segments: Vec<MultipleSegment> = recording
            .recoverable_segments
            .iter()
            .map(|seg| {
                let segment_index = seg.index;
                let segment_base = format!("content/segments/segment-{segment_index}");
                let segment_dir = recording.project_path.join(&segment_base);

                let original_segment =
                    original_segments.and_then(|segs| segs.get(segment_index as usize));

                let display_path = segment_dir.join("display.mp4");
                let fps = get_video_fps(&display_path).unwrap_or(30);

                let cursor_path = segment_dir.join("cursor.json");
                let keyboard_path = {
                    let binary = segment_dir.join(cap_project::KEYBOARD_EVENTS_FILE_NAME);
                    if binary.exists() {
                        binary
                    } else {
                        segment_dir.join(cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME)
                    }
                };

                let display_start_time = original_segment.and_then(|s| s.display.start_time);

                let get_start_time_or_fallback = |original_time: Option<f64>| -> Option<f64> {
                    start_time_or_display_fallback(original_time, display_start_time)
                };

                MultipleSegment {
                    display: VideoMeta {
                        path: RelativePathBuf::from(format!("{segment_base}/display.mp4")),
                        fps,
                        start_time: display_start_time,
                        device_id: original_segment.and_then(|s| s.display.device_id.clone()),
                    },
                    camera: if seg.camera_fragments.is_some() {
                        Some(VideoMeta {
                            path: RelativePathBuf::from(format!("{segment_base}/camera.mp4")),
                            fps: original_segment
                                .and_then(|s| s.camera.as_ref())
                                .map(|c| c.fps)
                                .unwrap_or(30),
                            start_time: get_start_time_or_fallback(
                                original_segment
                                    .and_then(|s| s.camera.as_ref())
                                    .and_then(|c| c.start_time),
                            ),
                            device_id: original_segment
                                .and_then(|s| s.camera.as_ref())
                                .and_then(|c| c.device_id.clone()),
                        })
                    } else {
                        None
                    },
                    mic: {
                        if seg.mic_fragments.is_some() {
                            Some(AudioMeta {
                                path: RelativePathBuf::from(format!(
                                    "{segment_base}/audio-input.ogg"
                                )),
                                start_time: get_start_time_or_fallback(
                                    original_segment
                                        .and_then(|s| s.mic.as_ref())
                                        .and_then(|m| m.start_time),
                                ),
                                device_id: original_segment
                                    .and_then(|s| s.mic.as_ref())
                                    .and_then(|m| m.device_id.clone()),
                                gap_summary: None,
                            })
                        } else {
                            None
                        }
                    },
                    system_audio: {
                        if seg.system_audio_fragments.is_some() {
                            Some(AudioMeta {
                                path: RelativePathBuf::from(format!(
                                    "{segment_base}/system_audio.ogg"
                                )),
                                start_time: get_start_time_or_fallback(
                                    original_segment
                                        .and_then(|s| s.system_audio.as_ref())
                                        .and_then(|a| a.start_time),
                                ),
                                device_id: original_segment
                                    .and_then(|s| s.system_audio.as_ref())
                                    .and_then(|a| a.device_id.clone()),
                                gap_summary: None,
                            })
                        } else {
                            None
                        }
                    },
                    cursor: if cursor_path.exists() {
                        Some(RelativePathBuf::from(format!("{segment_base}/cursor.json")))
                    } else {
                        None
                    },
                    keyboard: if keyboard_path.exists() {
                        keyboard_path.file_name().map(|file_name| {
                            RelativePathBuf::from(format!(
                                "{segment_base}/{}",
                                file_name.to_string_lossy()
                            ))
                        })
                    } else {
                        None
                    },
                    display_notch: original_segment.and_then(|s| s.display_notch),
                }
            })
            .collect();

        let existing_cursors = Self::load_existing_cursors(&recording.project_path);

        Ok(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments,
                cursors: existing_cursors,
                status: Some(StudioRecordingStatus::Complete),
            },
        })
    }

    fn create_project_config(
        recording: &IncompleteRecording,
        meta: &StudioRecordingMeta,
        purpose: RecoveryPurpose,
    ) -> Result<(), RecoveryError> {
        let StudioRecordingMeta::MultipleSegments { inner, .. } = meta else {
            return Ok(());
        };

        let timeline_segments: Vec<TimelineSegment> = inner
            .segments
            .iter()
            .enumerate()
            .filter_map(|(i, segment)| {
                let display_path = recording.project_path.join(segment.display.path.as_str());

                let duration = get_media_duration(&display_path)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or_else(|| {
                        let fps = segment.display.fps as f64;
                        if fps > 0.0 {
                            recording.estimated_duration.as_secs_f64()
                                / recording.recoverable_segments.len() as f64
                        } else {
                            5.0
                        }
                    });

                if duration <= 0.0 {
                    return None;
                }

                Some(TimelineSegment {
                    recording_clip: i as u32,
                    start: 0.0,
                    end: duration,
                    timescale: 1.0,
                    name: None,
                    speed_audio_mode: None,
                })
            })
            .collect();

        if timeline_segments.len() != inner.segments.len() || timeline_segments.is_empty() {
            warn!("No valid timeline segments could be created");
            return Err(RecoveryError::Validation(
                "No valid recovery timeline".into(),
            ));
        }

        let mut config = match ProjectConfiguration::load(&recording.project_path) {
            Ok(config) => config,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ProjectConfiguration::default()
            }
            Err(error) => return Err(error.into()),
        };

        config.timeline = Some(TimelineConfiguration {
            segments: timeline_segments,
            transitions: Vec::new(),
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
        });

        config
            .write(&recording.project_path)
            .map_err(RecoveryError::Io)?;

        finalization_info!("{}", purpose.timeline_message());

        Ok(())
    }

    fn load_existing_cursors(project_path: &Path) -> Cursors {
        let cursors_dir = project_path.join("content/cursors");
        if !cursors_dir.exists() {
            return Cursors::default();
        }

        if let Ok(meta) = RecordingMeta::load_for_project(project_path)
            && let Some(StudioRecordingMeta::MultipleSegments { inner, .. }) = meta.studio_meta()
            && !inner.cursors.is_empty()
        {
            return inner.cursors.clone();
        }

        Self::scan_cursor_images(&cursors_dir)
    }

    fn scan_cursor_images(cursors_dir: &Path) -> Cursors {
        let Ok(entries) = std::fs::read_dir(cursors_dir) else {
            return Cursors::default();
        };

        let mut cursors = std::collections::HashMap::new();

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "png").unwrap_or(false)
                && let Some(file_name) = path.file_stem().and_then(|s| s.to_str())
                && let Some(id_str) = file_name.strip_prefix("cursor_")
                && let Some(full_file_name) = path.file_name().and_then(|n| n.to_str())
            {
                let relative_path = RelativePathBuf::from("content/cursors").join(full_file_name);

                cursors.insert(
                    id_str.to_string(),
                    cap_project::CursorMeta {
                        image_path: relative_path,
                        hotspot: cap_project::XY::new(0.0, 0.0),
                        shape: None,
                    },
                );

                finalization_info!(
                    "Loaded cursor {} from image file: {:?}",
                    id_str,
                    path.file_name()
                );
            }
        }

        if cursors.is_empty() {
            Cursors::default()
        } else {
            Cursors::Correct(cursors)
        }
    }

    pub fn discard(recording: &IncompleteRecording) -> std::io::Result<()> {
        warn!(
            "Discarding incomplete recording at {:?}",
            recording.project_path
        );
        std::fs::remove_dir_all(&recording.project_path)
    }

    pub fn mark_needs_remux(project_path: &Path) -> Result<(), RecoveryError> {
        let mut meta =
            RecordingMeta::load_for_project(project_path).map_err(|_| RecoveryError::MetaSave)?;

        if let RecordingMetaInner::Studio(studio) = &mut meta.inner
            && let StudioRecordingMeta::MultipleSegments { inner, .. } = studio.as_mut()
        {
            inner.status = Some(StudioRecordingStatus::NeedsRemux);
            meta.save_for_project()
                .map_err(|_| RecoveryError::MetaSave)?;
        }

        Ok(())
    }

    fn mark_unrecoverable(project_path: &Path, meta: &RecordingMeta) {
        let mut updated_meta = meta.clone();

        let status_updated = match &mut updated_meta.inner {
            RecordingMetaInner::Studio(studio) => {
                if let StudioRecordingMeta::MultipleSegments { inner, .. } = studio.as_mut() {
                    if matches!(inner.status, Some(StudioRecordingStatus::Failed { .. })) {
                        debug!(
                            "Recording already failed before startup cleanup, preserving original status: {:?}",
                            project_path
                        );
                        return;
                    }

                    inner.status = Some(StudioRecordingStatus::Failed {
                        error: "No recoverable segments found".to_string(),
                    });
                    true
                } else {
                    false
                }
            }
            _ => false,
        };

        if status_updated {
            if let Err(e) = updated_meta.save_for_project() {
                warn!(
                    "Failed to mark recording as unrecoverable at {:?}: {}",
                    project_path, e
                );
            } else {
                debug!(
                    "Marked stale recording as failed because no media fragments were present: {:?}",
                    project_path
                );
            }
        }
    }
}

fn create_private_recovery_dir(path: &Path) -> std::io::Result<()> {
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(path)
}

fn recovery_child_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let child = Path::new(name);
    if child.as_os_str().is_empty()
        || !child
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(dir.join(child))
}

fn validate_recovery_manifests(dir: &Path) -> Result<(), RecoveryError> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            validate_recovery_manifests(&path)?;
        } else if path.file_name().is_some_and(|name| name == "manifest.json") {
            let raw = std::fs::read(&path)?;
            let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&raw) else {
                continue;
            };
            let parent = path
                .parent()
                .ok_or_else(|| RecoveryError::Validation("Manifest has no parent".into()))?;
            if let Some(init) = manifest
                .get("init_segment")
                .and_then(serde_json::Value::as_str)
            {
                let init = recovery_child_path(parent, init)
                    .ok_or_else(|| RecoveryError::Validation("Invalid init path".into()))?;
                if !init.is_file() {
                    return Err(RecoveryError::Validation(
                        "Missing declared init segment".into(),
                    ));
                }
            }
            for fragment in manifest
                .get("segments")
                .or_else(|| manifest.get("fragments"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = fragment.get("path").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let path = recovery_child_path(parent, name).ok_or_else(|| {
                    RecoveryError::Validation("Invalid manifest fragment path".into())
                })?;
                if fragment
                    .get("is_complete")
                    .and_then(serde_json::Value::as_bool)
                    != Some(true)
                {
                    continue;
                }
                let metadata = path.symlink_metadata()?;
                if !metadata.is_file()
                    || fragment
                        .get("file_size")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|size| size != metadata.len())
                    || (path.extension().is_some_and(|ext| ext == "m4s")
                        && !RecoveryManager::is_m4s_complete(&path))
                {
                    return Err(RecoveryError::Validation(format!(
                        "Invalid declared complete fragment: {}",
                        path.display()
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_recovery_video_inputs(
    fragments: &[PathBuf],
    init: Option<&Path>,
    workspace: &Path,
    video_validation: VideoValidation,
) -> Result<(), RecoveryError> {
    validate_recovery_track_inputs(
        fragments,
        init,
        workspace,
        ffmpeg::media::Type::Video,
        video_validation,
    )
}

fn legacy_omitted_tracks(
    meta: &RecordingMeta,
    project_path: &Path,
) -> Result<Vec<(usize, &'static str)>, RecoveryError> {
    let raw = match std::fs::read(project_path.join("recording-diagnostics.json")) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let diagnostics = serde_json::from_slice(&raw)?;
    Ok(meta
        .studio_meta()
        .and_then(|studio| studio.legacy_omitted_track_failures(&diagnostics))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(index, track)| {
            let name = match track {
                "microphone" => "audio-input",
                "camera" => "camera",
                "systemAudio" => "system_audio",
                _ => return None,
            };
            Some((index, name))
        })
        .collect())
}

fn validate_recovery_track_inputs(
    fragments: &[PathBuf],
    init: Option<&Path>,
    workspace: &Path,
    kind: ffmpeg::media::Type,
    video_validation: VideoValidation,
) -> Result<(), RecoveryError> {
    if fragments.is_empty() {
        return Err(RecoveryError::NoRecoverableSegments);
    }
    if let Some(init) = init {
        let path = workspace.join(format!(".validate-{}.mp4", uuid::Uuid::new_v4()));
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        for source in std::iter::once(init).chain(fragments.iter().map(PathBuf::as_path)) {
            std::io::copy(&mut std::fs::File::open(source)?, &mut output)?;
        }
        output.sync_all()?;
        drop(output);
        validate_recovery_track(&path, kind, video_validation)?;
        std::fs::remove_file(path)?;
    } else {
        for path in fragments {
            validate_recovery_track(path, kind, video_validation)?;
        }
    }
    Ok(())
}

const RECOVERY_INPUTS: [&str; 4] = [
    "content",
    "recording-meta.json",
    "project-config.json",
    "recording-diagnostics.json",
];

struct RecoveryLock {
    _file: std::fs::File,
}

impl RecoveryLock {
    fn acquire(project: &Path) -> Result<Self, RecoveryError> {
        reject_recovery_link(&project.symlink_metadata()?)?;
        let path = project.join(".recovery.lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(&path)?;
        let metadata = file.metadata()?;
        reject_recovery_link(&metadata)?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err(RecoveryError::Validation(
                "Invalid recovery lock file".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(RecoveryError::Validation(
                    "Recovery lock is not exclusively owned".into(),
                ));
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        let lock = Self { _file: file };
        if let Err(error) = reconcile_recovery_publication(project) {
            warn!(path = %project.display(), %error, "Interrupted recovery publication requires attention; all files retained");
            return Err(error);
        }
        Ok(lock)
    }
}

fn reject_recovery_link(metadata: &std::fs::Metadata) -> Result<(), RecoveryError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(RecoveryError::Validation(
                "Recovery input is a reparse point".into(),
            ));
        }
    }
    if metadata.file_type().is_symlink() {
        return Err(RecoveryError::Validation(
            "Recovery input is a symbolic link".into(),
        ));
    }
    Ok(())
}

fn copy_recovery_input(source: &Path, destination: &Path) -> Result<(), RecoveryError> {
    let metadata = source.symlink_metadata()?;
    reject_recovery_link(&metadata)?;
    if metadata.is_dir() {
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_recovery_input(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    } else {
        return Err(RecoveryError::Validation(format!(
            "Unsupported recovery input: {}",
            source.display()
        )));
    }
    Ok(())
}

fn recovery_snapshot(
    project: &Path,
) -> Result<std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>, RecoveryError> {
    use sha2::Digest;
    fn visit(
        root: &Path,
        path: &Path,
        entries: &mut std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>,
    ) -> Result<(), RecoveryError> {
        let metadata = path.symlink_metadata()?;
        reject_recovery_link(&metadata)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|error| RecoveryError::Validation(error.to_string()))?
            .to_path_buf();
        if metadata.is_dir() {
            let _ = entries.insert(relative, None);
            for entry in std::fs::read_dir(path)? {
                visit(root, &entry?.path(), entries)?;
            }
        } else if metadata.is_file() {
            let mut digest = sha2::Sha256::new();
            use std::io::Read;
            let mut input = std::fs::File::open(path)?;
            let mut buffer = [0_u8; 65536];
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            let _ = entries.insert(relative, Some(digest.finalize().to_vec()));
        } else {
            return Err(RecoveryError::Validation(format!(
                "Unsupported recovery input: {}",
                path.display()
            )));
        }
        Ok(())
    }
    let mut entries = std::collections::BTreeMap::new();
    for name in RECOVERY_INPUTS {
        let path = project.join(name);
        match path.symlink_metadata() {
            Ok(_) => visit(project, &path, &mut entries)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(entries)
}

fn sync_recovery_input(path: &Path) -> Result<(), RecoveryError> {
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            sync_recovery_input(&entry?.path())?;
        }
    } else {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?
            .sync_all()?;
    }
    Ok(())
}

const RECOVERY_PUBLICATION: &str = ".recovery-publication.json";
const RECOVERY_PUBLICATION_RECEIPT: &str = "publication-receipt.json";
const RECOVERY_PUBLICATION_MAX_BYTES: u64 = 8192;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryPublication {
    version: u32,
    project: PathBuf,
    workspace: String,
    original: RecoveryPublicationState,
    staged: RecoveryPublicationState,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecoveryPublicationState {
    segments: Option<[u8; 32]>,
    meta: Option<[u8; 32]>,
    config: Option<[u8; 32]>,
}

fn open_recovery_publication_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || reject_recovery_link(&metadata).is_err() {
        return Err(std::io::Error::other("Invalid recovery publication file"));
    }
    Ok(file)
}

fn recovery_publication_file_digest(path: &Path) -> Result<Option<[u8; 32]>, RecoveryError> {
    use sha2::Digest;
    use std::io::Read;
    let mut file = match open_recovery_publication_file(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut digest = sha2::Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(Some(digest.finalize().into()))
}

fn recovery_publication_segments_stamp(path: &Path) -> Result<Option<[u8; 32]>, RecoveryError> {
    // These stamps locate the interrupted rename; ordinary recovery still validates media content.
    use sha2::Digest;
    #[derive(serde::Serialize)]
    struct Entry {
        directory: bool,
        size: u64,
        modified: Duration,
        created: Option<Duration>,
        #[cfg(unix)]
        identity: (u64, u64),
    }
    fn visit(
        root: &Path,
        path: &Path,
        entries: &mut std::collections::BTreeMap<PathBuf, Entry>,
    ) -> Result<(), RecoveryError> {
        let metadata = path.symlink_metadata()?;
        reject_recovery_link(&metadata)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(RecoveryError::Validation(
                "Invalid publication tree entry".into(),
            ));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let _ = entries.insert(
            path.strip_prefix(root)
                .map_err(|error| RecoveryError::Validation(error.to_string()))?
                .to_path_buf(),
            Entry {
                directory: metadata.is_dir(),
                size: metadata.len(),
                modified: metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| RecoveryError::Validation(error.to_string()))?,
                created: metadata
                    .created()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()),
                #[cfg(unix)]
                identity: (metadata.dev(), metadata.ino()),
            },
        );
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(root, &entry?.path(), entries)?;
            }
        }
        Ok(())
    }
    match path.symlink_metadata() {
        Ok(metadata) => {
            reject_recovery_link(&metadata)?;
            if !metadata.is_dir() {
                return Err(RecoveryError::Validation(
                    "Publication segments are not a directory".into(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut entries = std::collections::BTreeMap::new();
    visit(path, path, &mut entries)?;
    Ok(Some(
        sha2::Sha256::digest(serde_json::to_vec(&entries)?).into(),
    ))
}

fn recovery_publication_state(project: &Path) -> Result<RecoveryPublicationState, RecoveryError> {
    for path in [project.to_path_buf(), project.join("content")] {
        let metadata = path.symlink_metadata()?;
        reject_recovery_link(&metadata)?;
        if !metadata.is_dir() {
            return Err(RecoveryError::Validation(
                "Invalid publication directory".into(),
            ));
        }
    }
    Ok(RecoveryPublicationState {
        segments: recovery_publication_segments_stamp(&project.join("content/segments"))?,
        meta: recovery_publication_file_digest(&project.join("recording-meta.json"))?,
        config: recovery_publication_file_digest(&project.join("project-config.json"))?,
    })
}

fn recovery_publication_workspace(project: &Path, name: &str) -> Result<PathBuf, RecoveryError> {
    let id = name
        .strip_prefix(".recovery-")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .filter(|id| name == format!(".recovery-{id}"))
        .ok_or_else(|| {
            RecoveryError::Validation("Invalid publication workspace generation".into())
        })?;
    let workspace = project.join(format!(".recovery-{id}"));
    let metadata = workspace.symlink_metadata()?;
    reject_recovery_link(&metadata)?;
    if !metadata.is_dir() {
        return Err(RecoveryError::Validation(
            "Invalid publication workspace".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(RecoveryError::Validation(
                "Publication workspace is not privately owned".into(),
            ));
        }
    }
    Ok(workspace)
}

fn read_recovery_publication(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = open_recovery_publication_file(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::other(
                "Recovery publication receipt is not privately owned",
            ));
        }
    }
    let mut bytes = Vec::new();
    file.take(RECOVERY_PUBLICATION_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > RECOVERY_PUBLICATION_MAX_BYTES {
        return Err(std::io::Error::other(
            "Recovery publication receipt is too large",
        ));
    }
    Ok(bytes)
}

fn finish_recovery_publication(
    project: &Path,
    workspace: &Path,
    bytes: &[u8],
) -> Result<(), RecoveryError> {
    if read_recovery_publication(&project.join(RECOVERY_PUBLICATION))? != bytes
        || read_recovery_publication(&workspace.join(RECOVERY_PUBLICATION_RECEIPT))? != bytes
    {
        return Err(RecoveryError::Validation(
            "Publication receipt changed; evidence retained".into(),
        ));
    }
    std::fs::remove_file(project.join(RECOVERY_PUBLICATION))?;
    Ok(())
}

fn begin_recovery_publication(project: &Path, workspace: &Path) -> Result<Vec<u8>, RecoveryError> {
    use std::io::Write;
    let name = workspace
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            RecoveryError::Validation("Missing publication workspace generation".into())
        })?;
    if workspace != recovery_publication_workspace(project, name)?.as_path() {
        return Err(RecoveryError::Validation(
            "Publication workspace is outside the project".into(),
        ));
    }
    let receipt = RecoveryPublication {
        version: 1,
        project: project.canonicalize()?,
        workspace: name.into(),
        original: recovery_publication_state(project)?,
        staged: recovery_publication_state(&workspace.join("staged"))?,
    };
    if receipt.original.segments.is_none()
        || receipt.original.meta.is_none()
        || receipt.staged.segments.is_none()
        || receipt.staged.meta.is_none()
        || receipt.staged.config.is_none()
    {
        return Err(RecoveryError::Validation(
            "Incomplete recovery publication".into(),
        ));
    }
    let bytes = serde_json::to_vec(&receipt)?;
    if bytes.len() as u64 > RECOVERY_PUBLICATION_MAX_BYTES {
        return Err(RecoveryError::Validation(
            "Recovery publication receipt is too large".into(),
        ));
    }
    for path in [
        workspace.join(RECOVERY_PUBLICATION_RECEIPT),
        project.join(RECOVERY_PUBLICATION),
    ] {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    Ok(bytes)
}

fn reconcile_recovery_publication(project: &Path) -> Result<(), RecoveryError> {
    let bytes = match read_recovery_publication(&project.join(RECOVERY_PUBLICATION)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !project.join("content/segments").try_exists()?
                && RecordingMeta::load_for_project(project)
                    .ok()
                    .is_some_and(|meta| meta.studio_meta().is_some())
            {
                for entry in std::fs::read_dir(project)? {
                    if entry?
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".recovery-")
                    {
                        return Err(RecoveryError::Validation("Missing segments with an unbound recovery workspace; evidence retained".into()));
                    }
                }
            }
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    let receipt: RecoveryPublication = serde_json::from_slice(&bytes)?;
    if receipt.version != 1
        || receipt.project != project.canonicalize()?
        || receipt.original.meta.is_none()
        || receipt.original.segments.is_none()
        || receipt.staged.meta.is_none()
        || receipt.staged.segments.is_none()
        || receipt.staged.config.is_none()
    {
        return Err(RecoveryError::Validation(
            "Invalid publication identity; evidence retained".into(),
        ));
    }
    let workspace = recovery_publication_workspace(project, &receipt.workspace)?;
    if read_recovery_publication(&workspace.join(RECOVERY_PUBLICATION_RECEIPT))? != bytes {
        return Err(RecoveryError::Validation(
            "Publication generation does not match its workspace".into(),
        ));
    }
    let current = recovery_publication_state(project)?;
    let staged = recovery_publication_state(&workspace.join("staged"))?;
    let backup = recovery_publication_segments_stamp(&workspace.join("original-segments"))?;
    let backup_config =
        recovery_publication_file_digest(&workspace.join("original-project-config.json"))?;
    if recovery_publication_file_digest(&workspace.join("original-recording-meta.json"))?
        != receipt.original.meta
    {
        return Err(RecoveryError::Validation(
            "Original publication metadata changed".into(),
        ));
    }
    let config_rolled_back = current.meta == receipt.original.meta
        && current.config == receipt.original.config
        && staged.meta == receipt.staged.meta
        && staged.config.is_none()
        && backup_config.is_none();
    let before_move = (current == receipt.original
        && staged == receipt.staged
        && backup.is_none()
        && (backup_config == receipt.original.config || backup_config.is_none()))
        || (config_rolled_back
            && current == receipt.original
            && staged.segments == receipt.staged.segments
            && backup.is_none());
    let missing_segments = (current.segments.is_none()
        && current.meta == receipt.original.meta
        && current.config == receipt.original.config
        && staged == receipt.staged
        && backup == receipt.original.segments
        && backup_config == receipt.original.config)
        || (config_rolled_back
            && current.segments.is_none()
            && staged.segments == receipt.staged.segments
            && backup == receipt.original.segments);
    let installed_segments = (current.segments == receipt.staged.segments
        && current.meta == receipt.original.meta
        && backup == receipt.original.segments
        && backup_config == receipt.original.config
        && staged.segments.is_none()
        && staged.meta == receipt.staged.meta
        && ((current.config == receipt.original.config && staged.config == receipt.staged.config)
            || (current.config == receipt.staged.config && staged.config.is_none())))
        || (config_rolled_back
            && current.segments == receipt.staged.segments
            && staged.segments.is_none()
            && backup == receipt.original.segments);
    let committed = current == receipt.staged
        && backup == receipt.original.segments
        && backup_config == receipt.original.config
        && staged.segments.is_none()
        && staged.meta.is_none()
        && staged.config.is_none();
    if missing_segments {
        let destination = project.join("content/segments");
        match destination.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(RecoveryError::Validation(
                    "Canonical segments appeared during reconciliation".into(),
                ));
            }
            Err(error) => return Err(error.into()),
        }
        std::fs::rename(workspace.join("original-segments"), destination)?;
        if recovery_publication_state(project)? != receipt.original {
            return Err(RecoveryError::Validation(
                "Restored publication state changed; evidence retained".into(),
            ));
        }
    } else if !before_move && !installed_segments && !committed {
        return Err(RecoveryError::Validation(
            "Conflicting recovery publication state; all files retained".into(),
        ));
    }
    finish_recovery_publication(project, &workspace, &bytes)
}

fn publish_recovery(project: &Path, workspace: &Path) -> Result<(), RecoveryError> {
    publish_recovery_with(project, workspace, rename_recovery_path)
}

fn rename_recovery_path(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

fn publish_recovery_with(
    project: &Path,
    workspace: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), RecoveryError> {
    let staged = workspace.join("staged");
    let original_segments = project.join("content/segments");
    let backup_segments = workspace.join("original-segments");
    let config = project.join("project-config.json");
    let backup_config = workspace.join("original-project-config.json");
    let had_config = config.try_exists()?;
    if had_config {
        copy_recovery_input(&config, &backup_config)?;
    }
    copy_recovery_input(
        &project.join("recording-meta.json"),
        &workspace.join("original-recording-meta.json"),
    )?;
    let publication = begin_recovery_publication(project, workspace)?;
    if let Err(error) = rename(&original_segments, &backup_segments) {
        finish_recovery_publication(project, workspace, &publication)?;
        return Err(error.into());
    }
    let mut segments_published = false;
    let mut config_published = false;
    let result = (|| {
        rename(&staged.join("content/segments"), &original_segments)?;
        segments_published = true;
        rename(&staged.join("project-config.json"), &config)?;
        config_published = true;
        rename(
            &staged.join("recording-meta.json"),
            &project.join("recording-meta.json"),
        )?;
        Ok::<_, std::io::Error>(())
    })();
    if let Err(error) = result {
        let rollback = (|| {
            if config_published {
                if had_config {
                    rename(&backup_config, &config)?;
                } else {
                    std::fs::remove_file(&config)?;
                }
            }
            if segments_published {
                rename(&original_segments, &staged.join("content/segments"))?;
            }
            rename(&backup_segments, &original_segments)?;
            Ok::<_, std::io::Error>(())
        })();
        if let Err(rollback_error) = rollback {
            return Err(RecoveryError::Validation(format!(
                "Publication failed: {error}; rollback failed: {rollback_error}; original media and metadata retained at {}",
                workspace.display()
            )));
        }
        finish_recovery_publication(project, workspace, &publication)?;
        return Err(error.into());
    }
    finish_recovery_publication(project, workspace, &publication)?;
    Ok(())
}

fn validate_recovered_track(path: &Path, kind: ffmpeg::media::Type) -> Result<(), RecoveryError> {
    validate_recovery_track(path, kind, VideoValidation::Full)
}

fn validate_recovery_track(
    path: &Path,
    kind: ffmpeg::media::Type,
    video_validation: VideoValidation,
) -> Result<(), RecoveryError> {
    let validate = || -> Result<(), String> {
        let mut input = ffmpeg::format::input(path).map_err(|error| error.to_string())?;
        let stream = input
            .streams()
            .best(kind)
            .ok_or_else(|| format!("Missing {kind:?} stream"))?;
        let index = stream.index();
        let context = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .map_err(|error| error.to_string())?;
        let codec =
            ffmpeg::decoder::find(context.id()).ok_or_else(|| "Decoder unavailable".to_string())?;
        let mut decoder = context.decoder();
        decoder.check(ffmpeg::codec::decoder::Check::EXPLODE | ffmpeg::codec::decoder::Check::CRC);
        let mut decoder = decoder.open_as(codec).map_err(|error| error.to_string())?;
        let mut frame = unsafe { ffmpeg::Frame::empty() };
        let mut decoded = false;
        loop {
            let mut packet = ffmpeg::Packet::empty();
            match packet.read(&mut input) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => return Err(error.to_string()),
            }
            if packet.stream() != index {
                continue;
            }
            if packet.is_corrupt() {
                return Err("Corrupt packet".into());
            }
            if decoded
                && kind == ffmpeg::media::Type::Video
                && video_validation == VideoValidation::Bounded
            {
                continue;
            }
            decoder
                .send_packet(&packet)
                .map_err(|error| error.to_string())?;
            loop {
                match decoder.receive_frame(&mut frame) {
                    Ok(()) if !frame.is_corrupt() => decoded = true,
                    Ok(()) => return Err("Corrupt decoded frame".into()),
                    Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        decoder.send_eof().map_err(|error| error.to_string())?;
        loop {
            match decoder.receive_frame(&mut frame) {
                Ok(()) if !frame.is_corrupt() => decoded = true,
                Ok(()) => return Err("Corrupt decoded frame".into()),
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => return Err(error.to_string()),
            }
        }
        if !decoded {
            return Err("Track contains no decoded frames".into());
        }
        Ok(())
    };
    validate().map_err(|error| RecoveryError::Validation(format!("{}: {error}", path.display())))
}

fn start_time_or_display_fallback(
    original_time: Option<f64>,
    display_start_time: Option<f64>,
) -> Option<f64> {
    original_time.or(display_start_time)
}

#[cfg(test)]
fn valid_recovered_audio(path: &Path) -> bool {
    path.is_file() && validate_recovered_track(path, ffmpeg::media::Type::Audio).is_ok()
}

fn replace_file(src: &Path, dst: &Path) -> Result<(), RecoveryError> {
    if dst.exists() {
        std::fs::remove_file(dst).map_err(RecoveryError::Io)?;
    }

    std::fs::rename(src, dst).map_err(RecoveryError::Io)
}

#[cfg(test)]
mod tests {
    use super::{
        RecoveryManager, RecoveryPurpose, StudioRecordingStatus, VideoValidation, replace_file,
        start_time_or_display_fallback, valid_recovered_audio, validate_recovery_track,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn only_clean_finalization_uses_bounded_video_validation() {
        for status in [
            None,
            Some(StudioRecordingStatus::InProgress),
            Some(StudioRecordingStatus::NeedsRemux),
            Some(StudioRecordingStatus::Complete),
            Some(StudioRecordingStatus::Failed {
                error: "capture failed".into(),
            }),
        ] {
            assert_eq!(
                RecoveryPurpose::Recover.video_validation(status.clone()),
                VideoValidation::Full
            );
            let expected = if matches!(status, Some(StudioRecordingStatus::NeedsRemux)) {
                VideoValidation::Bounded
            } else {
                VideoValidation::Full
            };
            assert_eq!(RecoveryPurpose::Finalize.video_validation(status), expected);
        }
    }

    #[test]
    fn bounded_video_validation_rejects_empty_and_unplayable_media() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("display.mp4");
        for bytes in [b"".as_slice(), b"invalid video".as_slice()] {
            fs::write(&path, bytes).unwrap();
            assert!(
                validate_recovery_track(
                    &path,
                    ffmpeg::media::Type::Video,
                    VideoValidation::Bounded
                )
                .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    fn complete_m4s_fragment() -> Vec<u8> {
        let mut fragment = Vec::new();
        for name in [b"moof", b"mdat"] {
            fragment.extend_from_slice(&72u32.to_be_bytes());
            fragment.extend_from_slice(name);
            fragment.extend_from_slice(&[0; 64]);
        }
        fragment
    }

    #[test]
    fn recovery_includes_complete_fragments_missing_from_the_last_manifest() {
        let dir = tempdir().unwrap();
        let fragment = complete_m4s_fragment();
        fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
        for name in [
            "segment_001.m4s",
            "segment_002.m4s",
            "segment_999.m4s",
            "segment_1000.m4s",
        ] {
            fs::write(dir.path().join(name), &fragment).unwrap();
        }
        fs::write(
            dir.path().join("segment_1001.m4s"),
            &fragment[..fragment.len() - 1],
        )
        .unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 5,
            "type": "m4s_segments",
            "init_segment": "init.mp4",
            "segments": [
                {"path": "segment_001.m4s", "is_complete": true, "file_size": fragment.len()},
                {"path": "segment_002.m4s", "is_complete": true, "file_size": fragment.len() + 1}
            ]
        }))
        .unwrap();
        fs::write(dir.path().join("manifest.json"), &manifest).unwrap();

        let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());
        assert_eq!(
            recovered.fragments,
            ["segment_001.m4s", "segment_999.m4s", "segment_1000.m4s"]
                .map(|name| dir.path().join(name))
        );
        assert_eq!(
            fs::read(dir.path().join("manifest.json")).unwrap(),
            manifest
        );
        assert!(dir.path().join("segment_1001.m4s").is_file());
    }

    #[test]
    fn recovery_reconstructs_only_complete_fragments_when_manifest_has_no_valid_entries() {
        let dir = tempdir().unwrap();
        let fragment = complete_m4s_fragment();
        let partial = &fragment[..fragment.len() - 1];
        fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
        fs::write(dir.path().join("segment_001.m4s"), &fragment).unwrap();
        fs::write(dir.path().join("segment_999.m4s"), &fragment).unwrap();
        fs::write(dir.path().join("segment_1000.m4s"), &fragment).unwrap();
        fs::write(dir.path().join("segment_002.m4s"), partial).unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 5,
            "type": "m4s_segments",
            "init_segment": "init.mp4",
            "segments": [
                {"path": "segment_001.m4s", "is_complete": false, "file_size": fragment.len()},
                {"path": "segment_999.m4s", "is_complete": false, "file_size": fragment.len()},
                {"path": "segment_1000.m4s", "is_complete": false, "file_size": fragment.len()},
                {"path": "segment_002.m4s", "is_complete": false, "file_size": partial.len()}
            ]
        }))
        .unwrap();
        fs::write(dir.path().join("manifest.json"), &manifest).unwrap();

        let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());

        assert_eq!(
            recovered.fragments,
            ["segment_001.m4s", "segment_999.m4s", "segment_1000.m4s"]
                .map(|name| dir.path().join(name))
        );
        assert_eq!(recovered.init_segment, Some(dir.path().join("init.mp4")));
        assert_eq!(
            fs::read(dir.path().join("manifest.json")).unwrap(),
            manifest
        );
        assert!(dir.path().join("segment_002.m4s").is_file());
    }

    #[test]
    fn recovery_rejects_partial_only_fragments_when_manifest_has_no_valid_entries() {
        let dir = tempdir().unwrap();
        let fragment = complete_m4s_fragment();
        let partial = &fragment[..fragment.len() - 1];
        fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
        fs::write(dir.path().join("segment_001.m4s"), partial).unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 5,
            "type": "m4s_segments",
            "init_segment": "init.mp4",
            "segments": [
                {"path": "segment_001.m4s", "is_complete": false, "file_size": partial.len()}
            ]
        }))
        .unwrap();
        fs::write(dir.path().join("manifest.json"), &manifest).unwrap();

        let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());

        assert!(recovered.fragments.is_empty());
        assert_eq!(
            fs::read(dir.path().join("manifest.json")).unwrap(),
            manifest
        );
        assert!(dir.path().join("segment_001.m4s").is_file());
    }

    #[test]
    fn recovery_finds_complete_fragments_without_a_readable_manifest() {
        for manifest in [None, Some("{interrupted")] {
            let dir = tempdir().unwrap();
            let fragment = complete_m4s_fragment();
            fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
            fs::write(dir.path().join("segment_001.m4s"), &fragment).unwrap();
            fs::write(
                dir.path().join("segment_002.m4s"),
                &fragment[..fragment.len() - 1],
            )
            .unwrap();
            if let Some(manifest) = manifest {
                fs::write(dir.path().join("manifest.json"), manifest).unwrap();
            }

            let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());

            assert_eq!(recovered.fragments, [dir.path().join("segment_001.m4s")]);
            assert_eq!(recovered.init_segment, Some(dir.path().join("init.mp4")));
            assert_eq!(
                fs::read_to_string(dir.path().join("manifest.json")).ok(),
                manifest.map(str::to_string)
            );
            assert!(dir.path().join("segment_002.m4s").is_file());
        }
    }

    #[test]
    fn replace_file_overwrites_existing_destination() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("source.tmp");
        let dst = dir.path().join("destination.mp4");

        fs::write(&src, b"new").unwrap();
        fs::write(&dst, b"old").unwrap();

        replace_file(&src, &dst).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), b"new");
        assert!(!src.exists());
    }

    #[test]
    fn recovered_audio_keeps_valid_media_smaller_than_legacy_threshold() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("quiet.wav");
        let samples = [0u8; 32];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8000u32.to_le_bytes());
        bytes.extend_from_slice(&16000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&samples);
        fs::write(&path, &bytes).unwrap();

        assert!(bytes.len() < 500);
        assert!(valid_recovered_audio(&path));
    }

    #[test]
    fn recovered_audio_rejects_large_corrupt_media() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("corrupt.ogg");
        fs::write(&path, [0u8; 1024]).unwrap();

        assert!(!valid_recovered_audio(&path));
    }

    #[test]
    fn start_time_fallback_prefers_original_value() {
        let original = Some(0.8);
        let display = Some(0.4);
        assert_eq!(start_time_or_display_fallback(original, display), Some(0.8),);
    }

    #[test]
    fn start_time_fallback_returns_display_value_when_original_missing() {
        let display = Some(0.4374473);
        assert_eq!(
            start_time_or_display_fallback(None, display),
            Some(0.4374473),
            "mic/system audio start_time must align with display when unknown \
             so the editor's offset calculation (latest - start_time) stays at 0",
        );
    }

    #[test]
    fn start_time_fallback_returns_none_when_display_missing() {
        assert_eq!(start_time_or_display_fallback(None, None), None);
    }
}

#[cfg(test)]
mod required_track_failure_recovery_tests {
    use super::*;

    #[test]
    fn diagnostics_failure_blocks_recovery_without_modifying_partial_media() {
        let directory = tempfile::tempdir().unwrap();
        let media = directory.path().join("partial.m4a");
        std::fs::write(&media, b"preserved").unwrap();
        std::fs::write(directory.path().join("recording-diagnostics.json"),
            br#"{"version":1,"segments":[{"trackFailures":[{"track":"microphone","stage":"runtime","error":"failed"}]}]}"#).unwrap();
        assert!(RecoveryManager::require_no_track_failure(directory.path()).is_err());
        assert_eq!(std::fs::read(media).unwrap(), b"preserved");
    }

    #[test]
    fn unknown_or_unreadable_diagnostics_cannot_authorize_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recording-diagnostics.json");
        for raw in [b"not-json".as_slice(), b"{}".as_slice()] {
            std::fs::write(&path, raw).unwrap();
            assert!(RecoveryManager::require_no_track_failure(directory.path()).is_err());
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(RecoveryManager::require_no_track_failure(directory.path()).is_err());
    }

    #[test]
    fn recording_without_failure_diagnostics_remains_eligible() {
        let directory = tempfile::tempdir().unwrap();
        assert!(RecoveryManager::require_no_track_failure(directory.path()).is_ok());
    }
}

#[cfg(test)]
mod transactional_recovery_tests {
    use super::*;

    fn publication_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let workspace = project.join(format!(".recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(project.join("content/segments")).unwrap();
        create_private_recovery_dir(&workspace).unwrap();
        std::fs::create_dir_all(workspace.join("staged/content/segments")).unwrap();
        std::fs::write(project.join("content/segments/raw.m4s"), b"original raw").unwrap();
        std::fs::write(project.join("recording-meta.json"), b"original status").unwrap();
        std::fs::write(project.join("project-config.json"), b"original config").unwrap();
        std::fs::write(
            workspace.join("staged/content/segments/display.mp4"),
            b"validated output",
        )
        .unwrap();
        std::fs::write(workspace.join("staged/recording-meta.json"), b"complete").unwrap();
        std::fs::write(
            workspace.join("staged/project-config.json"),
            b"validated config",
        )
        .unwrap();
        (temporary, project, workspace)
    }

    fn interrupt_publication(project: &Path, workspace: &Path, after: usize) {
        let _lock = RecoveryLock::acquire(project).unwrap();
        let mut calls = 0;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            publish_recovery_with(project, workspace, |source, destination| {
                assert_ne!(after, 0, "interrupted before the first rename");
                std::fs::rename(source, destination)?;
                calls += 1;
                assert_ne!(calls, after, "interrupted after publication rename");
                Ok(())
            })
        }));
        assert!(result.is_err());
        assert!(project.join(RECOVERY_PUBLICATION).is_file());
        assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
    }

    fn scannable_publication_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (temporary, project, workspace) = publication_fixture();
        let meta = RecordingMeta {
            platform: None,
            project_path: project.clone(),
            pretty_name: "Interrupted publication".into(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: Vec::new(),
                    cursors: Cursors::default(),
                    status: Some(StudioRecordingStatus::NeedsRemux),
                },
            })),
        };
        meta.save_for_project().unwrap();
        let display = project.join("content/segments/segment-0/display");
        std::fs::create_dir_all(&display).unwrap();
        std::fs::write(display.join("init.mp4"), [0; 128]).unwrap();
        let mut fragment = Vec::new();
        for kind in [b"moof", b"mdat"] {
            fragment.extend_from_slice(&72_u32.to_be_bytes());
            fragment.extend_from_slice(kind);
            fragment.extend_from_slice(&[0; 64]);
        }
        std::fs::write(display.join("segment_001.m4s"), fragment).unwrap();
        let staged_segment = workspace.join("staged/content/segments/segment-0");
        std::fs::create_dir_all(&staged_segment).unwrap();
        copy_recovery_input(&display, &staged_segment.join("display")).unwrap();
        (temporary, project, workspace)
    }

    fn interrupt_publication_rollback(
        project: &Path,
        workspace: &Path,
        failure: usize,
        interruption: usize,
        before_rename: bool,
    ) {
        let _lock = RecoveryLock::acquire(project).unwrap();
        let mut calls = 0;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            publish_recovery_with(project, workspace, |source, destination| {
                calls += 1;
                if calls == failure {
                    return Err(std::io::Error::other("injected publication rename failure"));
                }
                assert!(
                    !before_rename || calls != interruption,
                    "interrupted before rollback rename"
                );
                std::fs::rename(source, destination)?;
                assert!(
                    before_rename || calls != interruption,
                    "interrupted after rollback rename"
                );
                Ok(())
            })
        }));
        assert!(result.is_err());
        assert_eq!(calls, interruption);
        assert!(project.join(RECOVERY_PUBLICATION).is_file());
    }

    #[test]
    fn interrupted_rollback_reconciles_and_relaunches_at_every_rename_boundary() {
        use sha2::Digest;

        for had_config in [false, true] {
            for failure in 2..=4 {
                let last_rollback = match failure {
                    2 => 3,
                    3 => 5,
                    4 if had_config => 7,
                    4 => 6,
                    _ => unreachable!(),
                };
                for interruption in (failure + 1)..=last_rollback {
                    for before_rename in [false, true] {
                        let (temporary, project, workspace) = scannable_publication_fixture();
                        if !had_config {
                            std::fs::remove_file(project.join("project-config.json")).unwrap();
                        }
                        let original = recovery_snapshot(&project).unwrap();
                        let original_state = recovery_publication_state(&project).unwrap();
                        let staged_state =
                            recovery_publication_state(&workspace.join("staged")).unwrap();
                        interrupt_publication_rollback(
                            &project,
                            &workspace,
                            failure,
                            interruption,
                            before_rename,
                        );
                        let lock = RecoveryLock::acquire(&project).unwrap();
                        let current = recovery_publication_state(&project).unwrap();
                        assert_eq!(current.meta, original_state.meta);
                        assert!(
                            current.segments == original_state.segments
                                || current.segments == staged_state.segments
                        );
                        let raw = if project.join("content/segments/raw.m4s").is_file() {
                            project.join("content/segments")
                        } else {
                            workspace.join("original-segments")
                        };
                        for (path, bytes) in &original {
                            if let (Ok(relative), Some(bytes)) =
                                (path.strip_prefix("content/segments"), bytes)
                            {
                                let actual_digest = sha2::Sha256::digest(
                                    std::fs::read(raw.join(relative)).unwrap(),
                                )
                                .to_vec();
                                assert_eq!(&actual_digest, bytes);
                            }
                        }
                        assert!(!project.join(RECOVERY_PUBLICATION).exists());
                        assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
                        drop(lock);
                        let before_scan = recovery_snapshot(&project).unwrap();
                        let found = RecoveryManager::find_incomplete(temporary.path());
                        assert_eq!(found.len(), 1);
                        assert!(matches!(
                            found[0].meta.studio_meta().unwrap().status(),
                            StudioRecordingStatus::NeedsRemux
                        ));
                        assert_eq!(recovery_snapshot(&project).unwrap(), before_scan);
                        let _lock = RecoveryLock::acquire(&project).unwrap();
                        assert_eq!(recovery_snapshot(&project).unwrap(), before_scan);
                    }
                }
            }
        }
    }

    #[test]
    fn fully_restored_rollback_finishes_its_journal_without_changing_originals() {
        for had_config in [false, true] {
            let (temporary, project, workspace) = scannable_publication_fixture();
            if !had_config {
                std::fs::remove_file(project.join("project-config.json")).unwrap();
            }
            let original = recovery_snapshot(&project).unwrap();
            interrupt_publication_rollback(
                &project,
                &workspace,
                4,
                if had_config { 7 } else { 6 },
                false,
            );
            assert_eq!(recovery_snapshot(&project).unwrap(), original);
            assert!(!workspace.join("original-segments").exists());
            assert!(!workspace.join("original-project-config.json").exists());
            assert!(!workspace.join("staged/project-config.json").exists());
            assert_eq!(RecoveryManager::find_incomplete(temporary.path()).len(), 1);
            assert_eq!(recovery_snapshot(&project).unwrap(), original);
            assert!(!project.join(RECOVERY_PUBLICATION).exists());
            assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
            assert!(RecoveryManager::inspect_recording(&project).is_some());
            assert!(RecoveryManager::find_incomplete_single(&project).is_some());
            assert_eq!(recovery_snapshot(&project).unwrap(), original);
        }
    }

    #[test]
    fn rollback_layout_still_refuses_conflicts_and_changed_generation_evidence() {
        for had_config in [false, true] {
            for changed in ["canonical", "metadata", "config", "staged", "receipt"] {
                let (temporary, project, workspace) = scannable_publication_fixture();
                if !had_config {
                    std::fs::remove_file(project.join("project-config.json")).unwrap();
                }
                interrupt_publication_rollback(
                    &project,
                    &workspace,
                    4,
                    if had_config { 6 } else { 5 },
                    false,
                );
                match changed {
                    "canonical" => {
                        std::fs::create_dir(project.join("content/segments")).unwrap();
                        std::fs::write(project.join("content/segments/unrelated"), b"unrelated")
                            .unwrap();
                    }
                    "metadata" => {
                        let mut meta = RecordingMeta::load_for_project(&project).unwrap();
                        meta.pretty_name = "Different recording generation".into();
                        meta.save_for_project().unwrap();
                    }
                    "config" => std::fs::write(
                        project.join("project-config.json"),
                        b"different configuration",
                    )
                    .unwrap(),
                    "staged" => std::fs::write(
                        workspace.join("staged/content/segments/display.mp4"),
                        b"different staged data",
                    )
                    .unwrap(),
                    "receipt" => std::fs::write(
                        workspace.join(RECOVERY_PUBLICATION_RECEIPT),
                        b"different receipt",
                    )
                    .unwrap(),
                    _ => unreachable!(),
                }
                let before = recovery_snapshot(&project).unwrap();
                assert!(RecoveryLock::acquire(&project).is_err());
                assert!(RecoveryManager::find_incomplete(temporary.path()).is_empty());
                assert_eq!(recovery_snapshot(&project).unwrap(), before);
                assert_eq!(
                    std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
                    b"original raw"
                );
                assert!(project.join(RECOVERY_PUBLICATION).is_file());
                assert!(matches!(
                    RecordingMeta::load_for_project(&project)
                        .unwrap()
                        .studio_meta()
                        .unwrap()
                        .status(),
                    StudioRecordingStatus::NeedsRemux
                ));
            }
        }
    }

    #[test]
    fn interrupted_publication_reconciles_every_completed_rename_without_inventing_status() {
        for after in 0..=4 {
            let (_temporary, project, workspace) = publication_fixture();
            let original = recovery_snapshot(&project).unwrap();
            interrupt_publication(&project, &workspace, after);
            let _lock = RecoveryLock::acquire(&project).unwrap();
            assert!(!project.join(RECOVERY_PUBLICATION).exists());
            assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
            if after <= 1 {
                assert_eq!(recovery_snapshot(&project).unwrap(), original);
            } else {
                assert_eq!(
                    std::fs::read(project.join("content/segments/display.mp4")).unwrap(),
                    b"validated output"
                );
                assert_eq!(
                    std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
                    b"original raw"
                );
            }
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                if after < 4 {
                    &b"original status"[..]
                } else {
                    &b"complete"[..]
                }
            );
        }
    }

    #[test]
    fn relaunch_scan_restores_first_rename_and_keeps_recording_recoverable() {
        let (temporary, project, workspace) = scannable_publication_fixture();
        let original = recovery_snapshot(&project).unwrap();
        interrupt_publication(&project, &workspace, 1);
        assert!(!project.join("content/segments").exists());
        let found = RecoveryManager::find_incomplete(temporary.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].project_path, project);
        assert!(matches!(
            found[0].meta.studio_meta().unwrap().status(),
            StudioRecordingStatus::NeedsRemux
        ));
        assert_eq!(recovery_snapshot(&project).unwrap(), original);
        assert!(RecoveryManager::inspect_recording(&project).is_some());
        assert!(RecoveryManager::find_incomplete_single(&project).is_some());
    }

    #[test]
    fn relaunch_after_segments_install_retains_canonical_data_and_original_status() {
        for after in [2, 3] {
            let (temporary, project, workspace) = scannable_publication_fixture();
            let original_meta = std::fs::read(project.join("recording-meta.json")).unwrap();
            interrupt_publication(&project, &workspace, after);
            let before_scan = recovery_snapshot(&project).unwrap();
            assert_eq!(RecoveryManager::find_incomplete(temporary.path()).len(), 1);
            assert_eq!(recovery_snapshot(&project).unwrap(), before_scan);
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                original_meta
            );
            assert!(workspace.join("original-segments/raw.m4s").is_file());
            assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
        }
    }

    #[test]
    fn interrupted_restoration_is_idempotent_and_receipt_generation_must_match() {
        let (_temporary, project, workspace) = publication_fixture();
        let original = recovery_snapshot(&project).unwrap();
        interrupt_publication(&project, &workspace, 1);
        std::fs::rename(
            workspace.join("original-segments"),
            project.join("content/segments"),
        )
        .unwrap();
        let receipt = workspace.join(RECOVERY_PUBLICATION_RECEIPT);
        let bytes = std::fs::read(&receipt).unwrap();
        std::fs::write(&receipt, b"different generation").unwrap();
        assert!(RecoveryLock::acquire(&project).is_err());
        assert_eq!(recovery_snapshot(&project).unwrap(), original);
        assert!(project.join(RECOVERY_PUBLICATION).is_file());
        std::fs::write(receipt, bytes).unwrap();
        let _lock = RecoveryLock::acquire(&project).unwrap();
        assert_eq!(recovery_snapshot(&project).unwrap(), original);
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
    }

    #[test]
    fn interrupted_publication_without_original_config_preserves_that_state() {
        for after in 0..=3 {
            let (_temporary, project, workspace) = publication_fixture();
            std::fs::remove_file(project.join("project-config.json")).unwrap();
            interrupt_publication(&project, &workspace, after);
            let _lock = RecoveryLock::acquire(&project).unwrap();
            assert_eq!(project.join("project-config.json").exists(), after == 3);
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                b"original status"
            );
        }
    }

    #[test]
    fn interrupted_publication_never_overwrites_conflicting_canonical_segments() {
        for conflicting_file in [false, true] {
            let (_temporary, project, workspace) = publication_fixture();
            interrupt_publication(&project, &workspace, 1);
            std::fs::create_dir(project.join("content/segments")).unwrap();
            if conflicting_file {
                std::fs::write(project.join("content/segments/unrelated"), b"unrelated").unwrap();
            }
            let before = recovery_snapshot(&project).unwrap();
            assert!(RecoveryLock::acquire(&project).is_err());
            assert_eq!(recovery_snapshot(&project).unwrap(), before);
            assert_eq!(
                std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
                b"original raw"
            );
            assert!(project.join(RECOVERY_PUBLICATION).is_file());
        }
    }

    #[test]
    fn stale_publication_metadata_or_tree_keeps_evidence_and_does_not_mark_failed() {
        for changed in ["recording-meta.json", "original-segments/raw.m4s"] {
            let (temporary, project, workspace) = scannable_publication_fixture();
            interrupt_publication(&project, &workspace, 1);
            let target = if changed == "recording-meta.json" {
                let mut meta = RecordingMeta::load_for_project(&project).unwrap();
                meta.pretty_name = "A later recording generation".into();
                meta.save_for_project().unwrap();
                project.join(changed)
            } else {
                let target = workspace.join(changed);
                std::fs::write(&target, b"changed raw bytes").unwrap();
                target
            };
            let bytes = std::fs::read(&target).unwrap();
            assert!(RecoveryLock::acquire(&project).is_err());
            assert!(RecoveryManager::find_incomplete(temporary.path()).is_empty());
            assert_eq!(std::fs::read(target).unwrap(), bytes);
            assert!(matches!(
                RecordingMeta::load_for_project(&project)
                    .unwrap()
                    .studio_meta()
                    .unwrap()
                    .status(),
                StudioRecordingStatus::NeedsRemux
            ));
            assert!(!project.join("content/segments").exists());
            assert!(project.join(RECOVERY_PUBLICATION).is_file());
        }
    }

    #[test]
    fn invalid_or_wrong_generation_receipts_cannot_select_a_workspace() {
        for value in [
            "invalid-json",
            "version",
            "generation",
            "project",
            "escape",
            "oversized",
        ] {
            let (_temporary, project, workspace) = publication_fixture();
            interrupt_publication(&project, &workspace, 1);
            let path = project.join(RECOVERY_PUBLICATION);
            let mut receipt: RecoveryPublication =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let bytes = match value {
                "invalid-json" => b"{".to_vec(),
                "oversized" => vec![0; RECOVERY_PUBLICATION_MAX_BYTES as usize + 1],
                _ => {
                    match value {
                        "version" => receipt.version = 2,
                        "generation" => {
                            receipt.workspace = format!(".recovery-{}", uuid::Uuid::new_v4())
                        }
                        "project" => receipt.project = project.join("other"),
                        "escape" => receipt.workspace = "../outside".into(),
                        _ => unreachable!(),
                    }
                    serde_json::to_vec(&receipt).unwrap()
                }
            };
            std::fs::write(&path, &bytes).unwrap();
            assert!(RecoveryLock::acquire(&project).is_err());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            assert_eq!(
                std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
                b"original raw"
            );
            assert!(!project.join("content/segments").exists());
        }
    }

    #[test]
    fn legacy_workspaces_without_receipts_are_not_guessed_or_deleted() {
        let (temporary, project, workspace) = scannable_publication_fixture();
        assert_eq!(RecoveryManager::find_incomplete(temporary.path()).len(), 1);
        std::fs::rename(
            project.join("content/segments"),
            workspace.join("original-segments"),
        )
        .unwrap();
        let original_meta = std::fs::read(project.join("recording-meta.json")).unwrap();
        assert!(RecoveryManager::find_incomplete(temporary.path()).is_empty());
        assert_eq!(
            std::fs::read(project.join("recording-meta.json")).unwrap(),
            original_meta
        );
        assert!(workspace.join("original-segments/raw.m4s").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn publication_reconciliation_refuses_symlinked_receipts_and_workspace_entries() {
        use std::os::unix::fs::symlink;
        for target in ["receipt", "workspace", "segments", "metadata", "content"] {
            let (temporary, project, workspace) = publication_fixture();
            interrupt_publication(&project, &workspace, 1);
            let source = match target {
                "receipt" => project.join(RECOVERY_PUBLICATION),
                "workspace" => workspace.clone(),
                "segments" => workspace.join("original-segments"),
                "metadata" => workspace.join("original-recording-meta.json"),
                "content" => project.join("content"),
                _ => unreachable!(),
            };
            let outside = temporary.path().join("outside");
            std::fs::rename(&source, &outside).unwrap();
            symlink(&outside, &source).unwrap();
            assert!(RecoveryLock::acquire(&project).is_err());
            assert!(source.symlink_metadata().unwrap().file_type().is_symlink());
            assert!(outside.exists());
        }
    }

    #[test]
    fn recovery_publication_rolls_back_each_failed_rename() {
        for failure in 1..=4 {
            let (_temporary, project, workspace) = publication_fixture();
            let before = recovery_snapshot(&project).unwrap();
            let mut calls = 0;
            let result = publish_recovery_with(&project, &workspace, |source, destination| {
                calls += 1;
                if calls == failure {
                    return Err(std::io::Error::other("injected publication failure"));
                }
                std::fs::rename(source, destination)
            });
            assert!(result.is_err());
            assert_eq!(recovery_snapshot(&project).unwrap(), before);
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                b"original status"
            );
        }
    }

    #[test]
    fn recovery_scan_cannot_mark_failed_during_publication_rollback() {
        let (temporary, project, workspace) = publication_fixture();
        let meta = RecordingMeta {
            platform: None,
            project_path: project.clone(),
            pretty_name: "Publication scan race".into(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: Vec::new(),
                    cursors: Cursors::default(),
                    status: Some(StudioRecordingStatus::NeedsRemux),
                },
            })),
        };
        meta.save_for_project().unwrap();
        let before = recovery_snapshot(&project).unwrap();
        let _lock = RecoveryLock::acquire(&project).unwrap();
        let mut calls = 0;
        let result = publish_recovery_with(&project, &workspace, |source, destination| {
            calls += 1;
            if calls == 2 {
                assert!(!project.join("content/segments").exists());
                assert!(RecoveryManager::find_incomplete(temporary.path()).is_empty());
                return Err(std::io::Error::other("injected install failure after scan"));
            }
            std::fs::rename(source, destination)
        });
        assert!(result.is_err());
        assert_eq!(recovery_snapshot(&project).unwrap(), before);
        let meta = RecordingMeta::load_for_project(&project).unwrap();
        assert!(matches!(
            meta.studio_meta().unwrap().status(),
            StudioRecordingStatus::NeedsRemux
        ));
    }

    #[test]
    fn recovery_rollback_failure_retains_original_raw_and_status() {
        let (_temporary, project, workspace) = publication_fixture();
        let mut calls = 0;
        let result = publish_recovery_with(&project, &workspace, |source, destination| {
            calls += 1;
            if calls == 4 || calls == 6 {
                return Err(std::io::Error::other(
                    "injected rename and rollback failure",
                ));
            }
            std::fs::rename(source, destination)
        });
        assert!(result.unwrap_err().to_string().contains("rollback failed"));
        assert_eq!(
            std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
            b"original raw"
        );
        assert_eq!(
            std::fs::read(project.join("recording-meta.json")).unwrap(),
            b"original status"
        );
        assert_eq!(
            std::fs::read(workspace.join("original-recording-meta.json")).unwrap(),
            b"original status"
        );
    }

    #[test]
    fn recovery_publication_commits_metadata_last_and_retains_backup_until_success() {
        let (_temporary, project, workspace) = publication_fixture();
        let mut calls = 0;
        publish_recovery_with(&project, &workspace, |source, destination| {
            calls += 1;
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                b"original status"
            );
            if calls > 1 {
                assert_eq!(
                    std::fs::read(workspace.join("original-segments/raw.m4s")).unwrap(),
                    b"original raw"
                );
            }
            if calls == 4 {
                assert_eq!(destination, project.join("recording-meta.json"));
            }
            std::fs::rename(source, destination)
        })
        .unwrap();
        assert_eq!(calls, 4);
        assert_eq!(
            std::fs::read(project.join("recording-meta.json")).unwrap(),
            b"complete"
        );
        assert!(workspace.join("original-segments/raw.m4s").is_file());
        assert!(project.join("content/segments/display.mp4").is_file());
    }

    #[test]
    fn recovery_copy_refuses_existing_destination_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("raw");
        let destination = dir.path().join("occupied");
        std::fs::write(&source, b"original").unwrap();
        std::fs::write(&destination, b"existing").unwrap();
        assert!(copy_recovery_input(&source, &destination).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing");
    }

    #[test]
    fn recovery_lock_refuses_concurrent_attempt_without_touching_first_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock = RecoveryLock::acquire(dir.path()).unwrap();
        assert!(RecoveryLock::acquire(dir.path()).is_err());
        assert!(dir.path().join(".recovery.lock").exists());
        drop(lock);
        assert!(dir.path().join(".recovery.lock").exists());
        let reacquired = RecoveryLock::acquire(dir.path()).unwrap();
        drop(reacquired);
    }

    #[test]
    fn recovery_manifest_paths_cannot_escape_the_track_directory() {
        let dir = Path::new("content/segments/segment-0/display");
        for name in [
            "",
            "../original.mp4",
            "/outside.mp4",
            "nested/../../outside.mp4",
        ] {
            assert!(recovery_child_path(dir, name).is_none());
        }
        assert_eq!(
            recovery_child_path(dir, "segment_0.m4s"),
            Some(dir.join("segment_0.m4s"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovery_rejects_symlinks_and_creates_private_workspace() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"outside").unwrap();
        let project = dir.path().join("project");
        create_private_recovery_dir(&project).unwrap();
        assert_eq!(
            std::fs::metadata(&project).unwrap().permissions().mode() & 0o777,
            0o700
        );
        symlink(&outside, project.join("content")).unwrap();
        assert!(recovery_snapshot(&project).is_err());
        assert!(copy_recovery_input(&project.join("content"), &project.join("copy")).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }
    #[test]
    fn recovery_declared_complete_missing_or_corrupt_fragment_is_not_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("manifest.json");
        std::fs::write(
            &manifest,
            br#"{"fragments":[{"path":"missing.mp4","is_complete":true,"file_size":10}]}"#,
        )
        .unwrap();
        assert!(validate_recovery_manifests(dir.path()).is_err());
        std::fs::write(dir.path().join("missing.mp4"), b"short").unwrap();
        assert!(validate_recovery_manifests(dir.path()).is_err());
        std::fs::write(
            &manifest,
            br#"{"init_segment":"../outside.mp4","fragments":[]}"#,
        )
        .unwrap();
        assert!(validate_recovery_manifests(dir.path()).is_err());
    }

    #[test]
    fn recovery_source_snapshot_detects_bytes_and_whole_segment_changes() {
        let (_temporary, project, _workspace) = publication_fixture();
        let before = recovery_snapshot(&project).unwrap();
        std::fs::write(project.join("content/segments/raw.m4s"), b"different raw").unwrap();
        assert_ne!(recovery_snapshot(&project).unwrap(), before);
        std::fs::write(project.join("content/segments/raw.m4s"), b"original raw").unwrap();
        assert_eq!(recovery_snapshot(&project).unwrap(), before);
        std::fs::create_dir(project.join("content/segments/segment-1")).unwrap();
        assert_ne!(recovery_snapshot(&project).unwrap(), before);
    }
    #[test]
    fn recovery_lock_child_probe() {
        let Some(path) = std::env::var_os("CAP_RECOVERY_LOCK_CHILD") else {
            return;
        };
        let project = PathBuf::from(path);
        let _lock = RecoveryLock::acquire(&project).unwrap();
        std::fs::write(project.join("child-ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(10));
    }

    #[test]
    fn recovery_kernel_lock_releases_after_child_process_death() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "recovery::transactional_recovery_tests::recovery_lock_child_probe",
                    "--nocapture",
                ])
                .env("CAP_RECOVERY_LOCK_CHILD", directory.path())
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !directory.path().join("child-ready").exists() && std::time::Instant::now() < deadline
        {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lock probe exited before acquisition"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(directory.path().join("child-ready").exists());
        assert!(RecoveryLock::acquire(directory.path()).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let recovered = RecoveryLock::acquire(directory.path()).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join(".recovery.lock")).unwrap(),
            b""
        );
        drop(recovered);
    }
}
