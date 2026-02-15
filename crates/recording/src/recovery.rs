use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_enc_ffmpeg::remux::{
    concatenate_audio_to_ogg, concatenate_m4s_segments_with_init, concatenate_video_fragments,
    get_media_duration, get_video_fps, probe_media_valid, probe_video_can_decode,
};
use cap_project::{
    AudioMeta, Cursors, InstantRecordingMeta, MultipleSegment, MultipleSegments,
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus, TimelineConfiguration, TimelineSegment, VideoMeta,
};
use relative_path::RelativePathBuf;
use tracing::{debug, info, warn};

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

impl RecoveryManager {
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

        FragmentsInfo {
            fragments: Self::probe_fragments_in_dir(dir),
            init_segment: None,
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
            if segment.display_fragments.len() == 1 && segment.display_init_segment.is_none() {
                let source = &segment.display_fragments[0];
                if source != &display_output {
                    info!("Moving single display fragment to {:?}", display_output);
                    std::fs::rename(source, &display_output)?;
                    let display_dir = segment_dir.join("display");
                    if display_dir.exists()
                        && let Err(e) = std::fs::remove_dir_all(&display_dir)
                    {
                        debug!("Failed to clean up display dir {:?}: {e}", display_dir);
                    }
                }
            } else if !segment.display_fragments.is_empty() {
                if let Some(init_path) = &segment.display_init_segment {
                    info!(
                        "Concatenating {} M4S display segments with init to {:?}",
                        segment.display_fragments.len(),
                        display_output
                    );
                    concatenate_m4s_segments_with_init(
                        init_path,
                        &segment.display_fragments,
                        &display_output,
                    )
                    .map_err(RecoveryError::VideoConcat)?;
                } else {
                    info!(
                        "Concatenating {} display fragments to {:?}",
                        segment.display_fragments.len(),
                        display_output
                    );
                    concatenate_video_fragments(&segment.display_fragments, &display_output)
                        .map_err(RecoveryError::VideoConcat)?;
                }

                for fragment in &segment.display_fragments {
                    if let Err(e) = std::fs::remove_file(fragment) {
                        debug!("Failed to remove display fragment {:?}: {e}", fragment);
                    }
                }
                if let Some(init_path) = &segment.display_init_segment
                    && let Err(e) = std::fs::remove_file(init_path)
                {
                    debug!("Failed to remove display init segment {:?}: {e}", init_path);
                }
                let display_dir = segment_dir.join("display");
                if display_dir.exists()
                    && let Err(e) = std::fs::remove_dir_all(&display_dir)
                {
                    debug!("Failed to clean up display dir {:?}: {e}", display_dir);
                }
            }

            if let Some(camera_frags) = &segment.camera_fragments {
                let camera_output = segment_dir.join("camera.mp4");
                if camera_frags.len() == 1 && segment.camera_init_segment.is_none() {
                    let source = &camera_frags[0];
                    if source != &camera_output {
                        info!("Moving single camera fragment to {:?}", camera_output);
                        std::fs::rename(source, &camera_output)?;
                        let camera_dir = segment_dir.join("camera");
                        if camera_dir.exists()
                            && let Err(e) = std::fs::remove_dir_all(&camera_dir)
                        {
                            debug!("Failed to clean up camera dir {:?}: {e}", camera_dir);
                        }
                    }
                } else if !camera_frags.is_empty() {
                    if let Some(init_path) = &segment.camera_init_segment {
                        info!(
                            "Concatenating {} M4S camera segments with init to {:?}",
                            camera_frags.len(),
                            camera_output
                        );
                        concatenate_m4s_segments_with_init(init_path, camera_frags, &camera_output)
                            .map_err(RecoveryError::VideoConcat)?;
                    } else {
                        info!(
                            "Concatenating {} camera fragments to {:?}",
                            camera_frags.len(),
                            camera_output
                        );
                        concatenate_video_fragments(camera_frags, &camera_output)
                            .map_err(RecoveryError::VideoConcat)?;
                    }

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
                    let camera_dir = segment_dir.join("camera");
                    if camera_dir.exists()
                        && let Err(e) = std::fs::remove_dir_all(&camera_dir)
                    {
                        debug!("Failed to clean up camera dir {:?}: {e}", camera_dir);
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

        for segment in &recording.recoverable_segments {
            let segment_dir = recording
                .project_path
                .join("content/segments")
                .join(format!("segment-{}", segment.index));

            let display_output = segment_dir.join("display.mp4");
            if display_output.exists() {
                info!("Validating recovered display video: {:?}", display_output);
                match probe_video_can_decode(&display_output) {
                    Ok(true) => {
                        info!("Display video validation passed");
                    }
                    Ok(false) => {
                        return Err(RecoveryError::UnplayableVideo(format!(
                            "Display video has no decodable frames: {display_output:?}"
                        )));
                    }
                    Err(e) => {
                        return Err(RecoveryError::UnplayableVideo(format!(
                            "Display video validation failed for {display_output:?}: {e}"
                        )));
                    }
                }
            }

            let camera_output = segment_dir.join("camera.mp4");
            if camera_output.exists() {
                info!("Validating recovered camera video: {:?}", camera_output);
                match probe_video_can_decode(&camera_output) {
                    Ok(true) => {
                        info!("Camera video validation passed");
                    }
                    Ok(false) => {
                        warn!(
                            "Camera video has no decodable frames, removing: {:?}",
                            camera_output
                        );
                        if let Err(e) = std::fs::remove_file(&camera_output) {
                            debug!(
                                "Failed to remove invalid camera video {:?}: {e}",
                                camera_output
                            );
                        }
                    }
                    Err(e) => {
                        warn!(
                            "Camera video validation failed for {:?}: {}, removing",
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

                let display_start_time = original_segment.and_then(|s| s.display.start_time);

                let get_start_time_or_fallback = |original_time: Option<f64>| -> Option<f64> {
                    original_time.or_else(|| display_start_time.map(|_| 0.0))
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

    pub fn try_recover_instant(project_path: &Path) -> Result<bool, RecoveryError> {
        let meta =
            RecordingMeta::load_for_project(project_path).map_err(|_| RecoveryError::MetaSave)?;

        let is_failed_instant = matches!(
            &meta.inner,
            RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. })
                | RecordingMetaInner::Instant(InstantRecordingMeta::Failed { .. })
        );

        if !is_failed_instant {
            return Ok(false);
        }

        let content_dir = project_path.join("content");
        let output_mp4 = content_dir.join("output.mp4");

        if !output_mp4.exists() {
            info!(
                "No output.mp4 found for instant recording at {:?}",
                project_path
            );
            return Ok(false);
        }

        let file_size = std::fs::metadata(&output_mp4).map(|m| m.len()).unwrap_or(0);

        if file_size < 1024 {
            info!(
                "Instant recording output.mp4 too small ({}B), not recoverable",
                file_size
            );
            return Ok(false);
        }

        match probe_video_can_decode(&output_mp4) {
            Ok(true) => {
                info!(
                    "Instant recording at {:?} has decodable frames, attempting repair",
                    project_path
                );
            }
            Ok(false) => {
                info!(
                    "Instant recording at {:?} has no decodable frames",
                    project_path
                );

                let repaired_path = content_dir.join("output_repaired.mp4");
                let repair_result =
                    concatenate_video_fragments(&[output_mp4.clone()], &repaired_path);

                match repair_result {
                    Ok(()) => match probe_video_can_decode(&repaired_path) {
                        Ok(true) => {
                            info!("Repaired MP4 has decodable frames, replacing original");
                            std::fs::rename(&repaired_path, &output_mp4)?;
                        }
                        _ => {
                            info!("Repaired MP4 still has no decodable frames, not recoverable");
                            let _ = std::fs::remove_file(&repaired_path);
                            return Ok(false);
                        }
                    },
                    Err(e) => {
                        info!("Failed to repair MP4: {e}");
                        let _ = std::fs::remove_file(&repaired_path);
                        return Ok(false);
                    }
                }
            }
            Err(e) => {
                info!(
                    "Failed to probe instant recording at {:?}: {e}",
                    project_path
                );
                return Ok(false);
            }
        }

        let fps = get_video_fps(&output_mp4).unwrap_or(30);

        let mut updated_meta = meta;
        updated_meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
            fps,
            sample_rate: None,
        });

        updated_meta
            .save_for_project()
            .map_err(|_| RecoveryError::MetaSave)?;

        info!(
            "Successfully recovered instant recording at {:?} ({}fps)",
            project_path, fps
        );

        Ok(true)
    }
}
