use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_enc_ffmpeg::fragmented_mp4::tail_is_complete;
use cap_enc_ffmpeg::remux::{
    concatenate_audio_to_ogg, concatenate_m4s_segments_with_init, concatenate_video_fragments,
    get_media_duration, get_video_fps, probe_media_valid, probe_video_can_decode,
    probe_video_seek_points, remux_file,
};
use cap_project::{
    AudioMeta, Cursors, MultipleSegment, MultipleSegments, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration,
    TimelineSegment, VideoMeta,
};
use relative_path::RelativePathBuf;
use tracing::{debug, info, warn};

use crate::output_pipeline::{HealthSender, PipelineHealthEvent, emit_health};

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

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to concatenate video fragments: {0}")]
    VideoConcat(cap_enc_ffmpeg::remux::RemuxError),
    #[error("Failed to concatenate audio fragments: {0}")]
    AudioConcat(cap_enc_ffmpeg::remux::RemuxError),
    #[error("Failed to serialize meta: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("No recoverable segments found")]
    NoRecoverableSegments,
    #[error("Meta save failed")]
    MetaSave,
    #[error("Recovered video is not playable: {0}")]
    UnplayableVideo(String),
}

pub struct RecoveryManager;

const EXPORT_SEEK_PROBE_SAMPLE_COUNT: usize = 8;

impl RecoveryManager {
    pub fn inspect_recording(project_path: &Path) -> Option<IncompleteRecording> {
        if !project_path.is_dir() {
            return None;
        }

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
            StudioRecordingStatus::Failed { error } => error != "No recoverable segments found",
            StudioRecordingStatus::Complete => false,
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
            info!("No recoverable segments found in {:?}", project_path);
            return None;
        }

        info!(
            "Found {} recoverable segments in {:?} with estimated duration {:?}",
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
                .map(|name| dir.join(name))
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

                let result: Vec<PathBuf> = entries
                    .iter()
                    .filter(|f| {
                        f.get("is_complete")
                            .and_then(|c| c.as_bool())
                            .unwrap_or(false)
                    })
                    .filter_map(|f| {
                        let path_str = f.get("path").and_then(|p| p.as_str())?;
                        let path = dir.join(path_str);
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

                if !result.is_empty() {
                    return FragmentsInfo {
                        fragments: result,
                        init_segment,
                    };
                }
            }
        }

        if let Some(init_segment) = manifest_init_segment {
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
        const MIN_VALID_FRAGMENT_SIZE: u64 = 100;

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
                    let metadata = std::fs::metadata(&p).ok()?;
                    if metadata.len() < MIN_VALID_FRAGMENT_SIZE {
                        debug!(
                            "Skipping tiny respawn fragment {} ({} bytes)",
                            p.display(),
                            metadata.len()
                        );
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

            info!(
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
                    info!(
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
        const MIN_VALID_FRAGMENT_SIZE: u64 = 100;

        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut fragments: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("m4s")))
            .filter(|p| {
                std::fs::metadata(p)
                    .map(|metadata| metadata.len() >= MIN_VALID_FRAGMENT_SIZE)
                    .unwrap_or(false)
            })
            .collect();

        fragments.sort();
        fragments
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

    pub fn recover(recording: &IncompleteRecording) -> Result<RecoveredRecording, RecoveryError> {
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
                    info!("Moving single display fragment to {:?}", display_output);
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

            if let Some(camera_frags) = &segment.camera_fragments {
                let camera_output = segment_dir.join("camera.mp4");
                let camera_dir = segment_dir.join("camera");

                if camera_frags.len() == 1 && segment.camera_init_segment.is_none() {
                    let source = &camera_frags[0];
                    if source != &camera_output {
                        info!("Moving single camera fragment to {:?}", camera_output);
                        std::fs::rename(source, &camera_output)?;
                    }
                    match Self::validate_required_video(&camera_output, "camera") {
                        Ok(()) => {
                            if camera_dir.exists()
                                && let Err(e) = std::fs::remove_dir_all(&camera_dir)
                            {
                                debug!("Failed to clean up camera dir {:?}: {e}", camera_dir);
                            }
                        }
                        Err(e) => {
                            warn!(
                                "Camera video validation failed for {:?}: {}",
                                camera_output, e
                            );
                            if let Err(remove_err) = std::fs::remove_file(&camera_output) {
                                debug!(
                                    "Failed to remove invalid camera video {:?}: {remove_err}",
                                    camera_output
                                );
                            }
                        }
                    }
                } else if !camera_frags.is_empty() {
                    let camera_ok = match Self::finalize_fragments_to_progressive_mp4(
                        camera_frags,
                        segment.camera_init_segment.as_deref(),
                        &camera_output,
                        "camera",
                    ) {
                        Ok(()) => true,
                        Err(err) => {
                            warn!(
                                "Camera track recovery failed for {:?}: {err}. Preserving fragments for retry.",
                                camera_output
                            );
                            if let Err(e) = std::fs::remove_file(&camera_output)
                                && e.kind() != std::io::ErrorKind::NotFound
                            {
                                debug!(
                                    "Failed to remove invalid camera output {:?}: {e}",
                                    camera_output
                                );
                            }
                            false
                        }
                    };

                    if camera_ok {
                        for fragment in camera_frags {
                            if let Err(e) = std::fs::remove_file(fragment) {
                                debug!("Failed to remove camera fragment {:?}: {e}", fragment);
                            }
                        }
                        if let Some(init_path) = &segment.camera_init_segment
                            && let Err(e) = std::fs::remove_file(init_path)
                        {
                            debug!("Failed to remove camera init segment {:?}: {e}", init_path);
                        }
                        if camera_dir.exists()
                            && let Err(e) = std::fs::remove_dir_all(&camera_dir)
                        {
                            debug!("Failed to clean up camera dir {:?}: {e}", camera_dir);
                        }
                    }
                }
            }

            if let Some(mic_frags) = &segment.mic_fragments {
                let mic_output = segment_dir.join("audio-input.ogg");
                if mic_frags.len() == 1 {
                    let source = &mic_frags[0];
                    let is_ogg = source.extension().map(|e| e == "ogg").unwrap_or(false);
                    if source != &mic_output {
                        if is_ogg {
                            info!("Moving single mic fragment to {:?}", mic_output);
                            std::fs::rename(source, &mic_output)?;
                        } else {
                            info!("Transcoding single mic fragment to {:?}", mic_output);
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
                    info!(
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
                            info!("Moving single system audio fragment to {:?}", system_output);
                            std::fs::rename(source, &system_output)?;
                        } else {
                            info!(
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
                    info!(
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

        let meta = Self::build_recovered_meta(recording)?;

        let mut recording_meta = recording.meta.clone();
        recording_meta.inner = RecordingMetaInner::Studio(Box::new(meta.clone()));
        recording_meta
            .save_for_project()
            .map_err(|_| RecoveryError::MetaSave)?;

        Self::create_project_config(recording, &meta)?;

        info!(
            "Successfully recovered recording at {:?}",
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
            match Self::finalize_fragments_to_progressive_mp4(
                &fragments,
                Some(init.as_path()),
                &group_tmp,
                &format!("display respawn-{n}"),
            ) {
                Ok(()) => {
                    temp_paths.push(group_tmp.clone());
                    group_outputs.push(group_tmp);
                }
                Err(err) => {
                    warn!(
                        "Respawn-{} group remux failed; skipping those fragments: {err}",
                        n
                    );
                }
            }
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
            info!(
                "Concatenating {} M4S {label} segments with init to {:?}",
                fragments.len(),
                output
            );
            concatenate_m4s_segments_with_init(init_path, fragments, output)
                .map_err(RecoveryError::VideoConcat)?;
        } else {
            info!(
                "Concatenating {} {label} fragments to {:?}",
                fragments.len(),
                output
            );
            concatenate_video_fragments(fragments, output).map_err(RecoveryError::VideoConcat)?;
        }

        Self::validate_required_video(output, label)?;
        Ok(())
    }

    fn validate_required_video(path: &Path, label: &str) -> Result<(), RecoveryError> {
        info!("Validating recovered {} video: {:?}", label, path);

        Self::ensure_video_decodes(path, label)?;

        if let Err(seek_error) = probe_video_seek_points(path, EXPORT_SEEK_PROBE_SAMPLE_COUNT) {
            info!(
                "Recovered {} video failed seek validation, normalizing via remux: {}",
                label, seek_error
            );
            Self::normalize_recovered_video(path, label)?;
        }

        Ok(())
    }

    fn ensure_video_decodes(path: &Path, label: &str) -> Result<(), RecoveryError> {
        match probe_video_can_decode(path) {
            Ok(true) => Ok(()),
            Ok(false) => Err(RecoveryError::UnplayableVideo(format!(
                "{} video has no decodable frames: {path:?}",
                label
            ))),
            Err(e) => Err(RecoveryError::UnplayableVideo(format!(
                "{} video validation failed for {path:?}: {e}",
                label
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
                "{} video seek validation failed for {path:?}: {e}",
                label
            ))
        })?;

        info!(
            "Recovered {} video validation passed after normalization",
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

                let camera_path = segment_dir.join("camera.mp4");
                let mic_path = segment_dir.join("audio-input.ogg");
                let system_audio_path = segment_dir.join("system_audio.ogg");
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
                    camera: if camera_path.exists() {
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
                        let mic_size = std::fs::metadata(&mic_path).map(|m| m.len()).unwrap_or(0);
                        const MIN_VALID_AUDIO_SIZE: u64 = 500;
                        if mic_path.exists() && mic_size > MIN_VALID_AUDIO_SIZE {
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
                            })
                        } else {
                            None
                        }
                    },
                    system_audio: {
                        let file_size = std::fs::metadata(&system_audio_path)
                            .map(|m| m.len())
                            .unwrap_or(0);
                        const MIN_VALID_AUDIO_SIZE: u64 = 500;
                        if system_audio_path.exists() && file_size > MIN_VALID_AUDIO_SIZE {
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
                })
            })
            .collect();

        if timeline_segments.is_empty() {
            warn!("No valid timeline segments could be created");
            return Ok(());
        }

        let mut config = ProjectConfiguration::load(&recording.project_path).unwrap_or_default();

        config.timeline = Some(TimelineConfiguration {
            segments: timeline_segments,
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
        });

        config
            .write(&recording.project_path)
            .map_err(RecoveryError::Io)?;

        info!("Created project configuration with timeline for recovered recording");

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

                info!(
                    "Recovered cursor {} from image file: {:?}",
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
                info!(
                    "Marked recording as unrecoverable (no recoverable segments): {:?}",
                    project_path
                );
            }
        }
    }
}

fn start_time_or_display_fallback(
    original_time: Option<f64>,
    display_start_time: Option<f64>,
) -> Option<f64> {
    original_time.or(display_start_time)
}

fn replace_file(src: &Path, dst: &Path) -> Result<(), RecoveryError> {
    if dst.exists() {
        std::fs::remove_file(dst).map_err(RecoveryError::Io)?;
    }

    std::fs::rename(src, dst).map_err(RecoveryError::Io)
}

#[cfg(test)]
mod tests {
    use super::{replace_file, start_time_or_display_fallback};
    use std::fs;
    use tempfile::tempdir;

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
