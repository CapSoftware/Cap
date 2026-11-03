use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use cap_enc_ffmpeg::RelocatableSource;
use cap_enc_ffmpeg::fragmented_mp4::{read_fragment_prefix, tail_is_complete};
use cap_enc_ffmpeg::remux::{
    concatenate_audio_to_ogg, concatenate_m4s_segments_with_init,
    concatenate_m4s_segments_with_init_validated, concatenate_video_fragments,
    concatenate_video_fragments_on_timeline, get_media_duration, get_video_base_fps,
    merge_video_audio, probe_media_valid, probe_video_can_decode, probe_video_seek_points,
    remux_file,
};
use cap_project::{
    AudioMeta, Cursors, MultipleSegment, MultipleSegments, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration,
    TimelineSegment, VideoMeta,
};
use relative_path::RelativePathBuf;
use tracing::{debug, warn};

use crate::output_pipeline::{HealthSender, PipelineHealthEvent, emit_health};
use crate::studio_recording::CompletedRecording;

mod prefix;
mod preparing_observer;
mod preparing_projection;
mod retirement;

type PreparingRecoveryLock = retirement::RecoveryLease;

pub use preparing_observer::{
    LivePreparingStudioSources, PreparingAudioLease, PreparingAudioTrack, PreparingSidecarKind,
    PreparingSidecarLease, PreparingStudioIdentity, PreparingStudioJob, PreparingStudioObserver,
    PreparingStudioSources, PreparingStudioState, PreparingVideoLease, PreparingVideoTrack,
};
pub use preparing_projection::{
    PreparingAudioInput, PreparingCursorImage, PreparingStudioSegment, PreparingVideoInput,
};

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoveryCopyDurability {
    Durable,
    Deferred,
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

/// Track start times the recorder writes beside an in-progress segment
/// (`crate::studio_recording::SegmentStartTimes`); the in-progress meta has
/// no segments, so this is what recovery aligns the tracks with.
pub const SEGMENT_START_TIMES_FILE: &str = "start-times.json";

fn persisted_start_times(segment_dir: &Path) -> Option<crate::studio_recording::SegmentStartTimes> {
    let raw = std::fs::read(segment_dir.join(SEGMENT_START_TIMES_FILE)).ok()?;
    serde_json::from_slice(&raw)
        .inspect_err(|error| warn!(%error, "Ignoring unreadable segment start times"))
        .ok()
}

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

    pub fn remux_stopped_with_preparing(
        completed: &CompletedRecording,
        mut job: PreparingStudioJob,
    ) -> Result<bool, RecoveryError> {
        let matches = job.claimed().is_some_and(|claim| {
            claim.metadata().project_path == completed.project_path
                && serde_json::to_value(claim.metadata().studio_meta())
                    .ok()
                    .zip(serde_json::to_value(&completed.meta).ok())
                    .is_some_and(|(stopped, supplied)| stopped == supplied)
        });
        if !matches {
            job.unavailable(
                "The completed recording no longer matches its stopped snapshot".into(),
            );
            return Self::remux_if_needed(&completed.project_path);
        }
        Self::remux_with_preparing(&completed.project_path, Some(job))
    }

    pub fn remux_if_needed(project_path: &Path) -> Result<bool, RecoveryError> {
        Self::remux_with_preparing(project_path, None)
    }

    fn remux_with_preparing(
        project_path: &Path,
        preparing: Option<PreparingStudioJob>,
    ) -> Result<bool, RecoveryError> {
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

        // Without a preparing editor nothing reads the originals once they are
        // published, so the backup goes with the stop instead of doubling the
        // recording's size on disk for good -- unless it holds a legacy
        // omitted track, which publication leaves out and only the backup
        // keeps.
        let unread = preparing.is_none()
            && legacy_omitted_tracks(&incomplete.meta, project_path)
                .is_ok_and(|tracks| tracks.is_empty());
        let published_workspace = std::cell::RefCell::new(None);
        Self::finalize_with_publication(
            &incomplete,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |_, _| Ok(()),
            |project, workspace| {
                publish_recovery(project, workspace)?;
                *published_workspace.borrow_mut() = Some(workspace.to_path_buf());
                Ok(())
            },
            RecoveryLock::acquire,
            preparing,
        )?;
        if unread && let Some(workspace) = published_workspace.into_inner() {
            let retired = RecoveryLock::acquire(project_path)
                .and_then(|_lock| retirement::retire_unread_originals(project_path, &workspace));
            if let Err(error) = retired {
                warn!(path = %workspace.display(), %error, "Original media backup retained");
            }
        }
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

            let display_info = Self::segment_track_fragments(&segment_path, "display", true);
            let display_fragments = display_info.fragments;
            let display_init_segment = display_info.init_segment;

            if display_fragments.is_empty() {
                debug!(
                    "No display fragments found for segment {} at {:?}",
                    index, segment_path
                );
                continue;
            }

            let camera_info = Self::segment_track_fragments(&segment_path, "camera", false);
            let camera_init_segment = camera_info.init_segment;
            let camera_fragments =
                (!camera_info.fragments.is_empty()).then_some(camera_info.fragments);

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

    fn find_studio_fragments_with_init(dir: &Path) -> FragmentsInfo {
        let mut info = Self::find_complete_fragments_with_init(dir);
        let Some(init) = info.init_segment.clone().or_else(|| {
            let path = dir.join("init.mp4");
            path.is_file().then_some(path)
        }) else {
            return info;
        };
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                let Some(final_name) = name.strip_suffix(".tmp") else {
                    continue;
                };
                if Self::m4s_fragment_index(&dir.join(final_name)).is_none()
                    || dir.join(final_name).exists()
                    || !entry.file_type().is_ok_and(|kind| kind.is_file())
                {
                    continue;
                }
                // A malformed or empty tail has nothing to recover. Any other
                // read error keeps the fragment listed: staged finalization
                // refuses to publish a recording with a pending `.tmp`, so
                // the recording stays retryable instead of losing it.
                match read_fragment_prefix(&init, &path) {
                    Ok(_) => info.fragments.push(path),
                    Err(error)
                        if !matches!(
                            error.kind(),
                            std::io::ErrorKind::InvalidData | std::io::ErrorKind::UnexpectedEof
                        ) =>
                    {
                        warn!(path = %path.display(), %error, "Fragment prefix unreadable; keeping it for a retry");
                        info.fragments.push(path);
                    }
                    Err(_) => {}
                }
            }
        }
        info.fragments.sort_by_key(|path| {
            let path = if path.extension().is_some_and(|extension| extension == "tmp") {
                path.with_extension("")
            } else {
                path.clone()
            };
            Self::m4s_fragment_index(&path)
        });
        info.init_segment = Some(init);
        info
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
                        .filter(|entry| {
                            entry
                                .get("is_complete")
                                .and_then(|complete| complete.as_bool())
                                .unwrap_or(false)
                        })
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

    /// One track of a segment directory: its fragments, else the single-file
    /// fallback, else (when `respawn` is set) the first respawned muxer
    /// directory holding fragments. Shared by segment collection and by
    /// recovery validation so neither can disagree about what a segment holds.
    fn segment_track_fragments(segment_path: &Path, track: &str, respawn: bool) -> FragmentsInfo {
        let dir = segment_path.join(track);
        let info = Self::find_studio_fragments_with_init(&dir);
        if !info.fragments.is_empty() {
            return info;
        }

        if let Some(file) = Self::probe_single_file(&segment_path.join(format!("{track}.mp4"))) {
            return FragmentsInfo {
                fragments: vec![file],
                init_segment: None,
            };
        }

        if respawn
            && let Some(info) = Self::respawn_directories(&dir)
                .into_iter()
                .map(|(_, directory)| Self::find_studio_fragments_with_init(&directory))
                .find(|info| !info.fragments.is_empty())
        {
            return info;
        }

        FragmentsInfo {
            fragments: Vec::new(),
            init_segment: None,
        }
    }

    /// Whether a segment directory holds any recoverable media at all.
    ///
    /// A directory with nothing in it is the residue of a resume that failed
    /// before it wrote a frame, and recovery can ignore it. One holding any
    /// track at all is a real inconsistency: skipping it would leave that
    /// footage out of the recovered recording, so it has to be surfaced rather
    /// than waved through.
    fn segment_holds_recoverable_media(segment_path: &Path) -> bool {
        ["display", "camera"].iter().any(|track| {
            !Self::segment_track_fragments(segment_path, track, true)
                .fragments
                .is_empty()
        }) || ["audio-input", "system_audio"]
            .iter()
            .any(|track| Self::find_audio_fragments(&segment_path.join(track)).is_some())
    }

    fn respawn_directories(dir: &Path) -> Vec<(u32, PathBuf)> {
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
        respawn_dirs
    }

    fn collect_respawn_groups(
        dir: &Path,
        health_tx: Option<&HealthSender>,
        recover_complete_prefixes: bool,
    ) -> Vec<(u32, PathBuf, Vec<PathBuf>)> {
        let mut groups = Vec::new();
        for (n, respawn_dir) in Self::respawn_directories(dir) {
            let init_path = respawn_dir.join("init.mp4");
            if !init_path.exists() {
                debug!(
                    "respawn-{} at {} missing init.mp4",
                    n,
                    respawn_dir.display()
                );
                continue;
            }

            Self::rescue_pending_tmp_fragments(&respawn_dir, health_tx, recover_complete_prefixes);

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

    fn rescue_pending_tmp_fragments(
        dir: &Path,
        health_tx: Option<&HealthSender>,
        recover_complete_prefixes: bool,
    ) {
        Self::rescue_pending_tmp_fragments_with_copy(
            dir,
            health_tx,
            recover_complete_prefixes,
            Self::copy_recovered_prefix,
        );
    }

    fn rescue_pending_tmp_fragments_with_copy(
        dir: &Path,
        health_tx: Option<&HealthSender>,
        recover_complete_prefixes: bool,
        copy: impl Fn(&Path, &Path, u64) -> std::io::Result<()>,
    ) {
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
            if corrupt_marker.exists()
                && (!recover_complete_prefixes
                    || std::fs::read_to_string(&corrupt_marker).ok().as_deref()
                        != Some("truncated_fragment"))
            {
                continue;
            }
            let final_name = name.trim_end_matches(".tmp");
            let final_path = dir.join(final_name);
            if final_path.exists() {
                continue;
            }
            if recover_complete_prefixes && dir.join("init.mp4").is_file() {
                match read_fragment_prefix(&dir.join("init.mp4"), &path) {
                    Ok(prefix) => match copy(&path, &final_path, prefix.length) {
                        Ok(()) => {
                            finalization_info!(
                                "Recovered complete fragment prefix from {}",
                                path.display()
                            );
                        }
                        Err(error) => {
                            warn!(path = %path.display(), %error, "Could not copy recoverable fragment prefix");
                        }
                    },
                    Err(error) => {
                        if error.kind() == std::io::ErrorKind::InvalidData {
                            let _ = std::fs::write(&corrupt_marker, "truncated_fragment");
                        }
                        warn!(path = %path.display(), %error, "Cannot recover fragment prefix");
                        if let Some(health_tx) = health_tx {
                            emit_health(
                                health_tx,
                                PipelineHealthEvent::RecoveryFragmentCorrupt {
                                    path: path.display().to_string(),
                                    reason: error.to_string(),
                                },
                            );
                        }
                    }
                }
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

    fn copy_recovered_prefix(
        source: &Path,
        destination: &Path,
        length: u64,
    ) -> std::io::Result<()> {
        use std::io::Read;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos();
        let temporary =
            destination.with_extension(format!("recovery-{}-{nonce}", std::process::id()));
        let result = (|| {
            let source = std::fs::File::open(source)?;
            let mut output = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            if std::io::copy(&mut source.take(length), &mut output)? != length {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Fragment changed during recovery",
                ));
            }
            output.sync_all()?;
            drop(output);
            prefix::publish(&temporary, destination)
        })();
        let _ = std::fs::remove_file(&temporary);
        result
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
            let prefix_duration = fragment
                .extension()
                .is_some_and(|extension| extension == "tmp")
                .then(|| {
                    read_fragment_prefix(&fragment.with_file_name("init.mp4"), fragment)
                        .ok()
                        .map(|prefix| prefix.duration)
                })
                .flatten();
            if let Some(duration) = prefix_duration.or_else(|| get_media_duration(fragment)) {
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

    pub fn finalize_with_preparing(
        recording: &IncompleteRecording,
        job: PreparingStudioJob,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_publication(
            recording,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |_, _| Ok(()),
            publish_recovery,
            RecoveryLock::acquire,
            Some(job),
        )
    }

    pub fn finalize_with_relocatable_source(
        recording: &IncompleteRecording,
        source: &RelocatableSource,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_publication(
            recording,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |_, _| Ok(()),
            |project, workspace| publish_recovery_with_source(project, workspace, source),
            RecoveryLock::acquire_for_preparing_preview,
            None,
        )
    }

    fn finalize_with_purpose(
        recording: &IncompleteRecording,
        purpose: RecoveryPurpose,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_operations(
            recording,
            purpose,
            copy_recovery_input_with_durability,
            |_, _| Ok(()),
        )
    }

    fn finalize_with_operations(
        recording: &IncompleteRecording,
        purpose: RecoveryPurpose,
        copy_input: impl FnMut(&Path, &Path, RecoveryCopyDurability) -> Result<(), RecoveryError>,
        before_source_check: impl FnOnce(&Path, &Path) -> Result<(), RecoveryError>,
    ) -> Result<RecoveredRecording, RecoveryError> {
        Self::finalize_with_publication(
            recording,
            purpose,
            copy_input,
            before_source_check,
            publish_recovery,
            RecoveryLock::acquire,
            None,
        )
    }

    fn finalize_with_publication(
        recording: &IncompleteRecording,
        purpose: RecoveryPurpose,
        mut copy_input: impl FnMut(&Path, &Path, RecoveryCopyDurability) -> Result<(), RecoveryError>,
        before_source_check: impl FnOnce(&Path, &Path) -> Result<(), RecoveryError>,
        publish: impl FnOnce(&Path, &Path) -> Result<(), RecoveryError>,
        acquire: impl FnOnce(&Path) -> Result<RecoveryLock, RecoveryError>,
        preparing: Option<PreparingStudioJob>,
    ) -> Result<RecoveredRecording, RecoveryError> {
        let started = Instant::now();
        Self::require_no_track_failure(&recording.project_path)?;
        let project = &recording.project_path;
        let lock = HeldRecoveryLock::new(acquire(project)?, preparing.is_some());
        let mut preparing = preparing;
        let before = recovery_snapshot(project)?;
        debug!(
            elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            "Studio finalization source snapshot ready"
        );
        let current = RecordingMeta::load_for_project(project)
            .map_err(|error| RecoveryError::Validation(error.to_string()))?;
        if serde_json::to_value(&current)? != serde_json::to_value(&recording.meta)? {
            return Err(RecoveryError::Validation(
                "Recording metadata changed".into(),
            ));
        }
        let video_validation =
            purpose.video_validation(current.studio_meta().map(|studio| studio.status()));
        let staging_durability = match video_validation {
            VideoValidation::Full => RecoveryCopyDurability::Durable,
            VideoValidation::Bounded => RecoveryCopyDurability::Deferred,
        };
        Self::require_recoverable_tracks(recording)?;
        let preparing_source = prepare_studio_source(recording, preparing.as_mut(), &lock);
        let workspace = project.join(format!(".recovery-{}", uuid::Uuid::new_v4()));
        create_private_recovery_dir(&workspace)?;
        let staged = workspace.join("staged");
        create_private_recovery_dir(&staged)?;
        let prepared = (|| {
            let copying = Instant::now();
            for name in RECOVERY_INPUTS {
                let source = project.join(name);
                if source.try_exists()? {
                    copy_input(&source, &staged.join(name), staging_durability)?;
                }
            }
            debug!(
                elapsed_ms = copying.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization staging copy ready"
            );
            let checking = Instant::now();
            // Clean finalization mutates only staged bytes and rechecks originals before publication.
            if recovery_snapshot(&staged)? != before
                || (video_validation == VideoValidation::Full
                    && recovery_snapshot(project)? != before)
            {
                return Err(RecoveryError::Validation(
                    "Recording changed while copying".into(),
                ));
            }
            debug!(
                elapsed_ms = checking.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization staging snapshot ready"
            );
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
            let segments = staged.join("content/segments");
            for entry in std::fs::read_dir(segments)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    for track in ["display", "camera"] {
                        let directory = entry.path().join(track);
                        Self::rescue_pending_tmp_fragments(&directory, None, true);
                        for (_, respawn) in Self::respawn_directories(&directory) {
                            Self::rescue_pending_tmp_fragments(&respawn, None, true);
                        }
                    }
                }
            }
            let analyzing = Instant::now();
            let staged_recording = Self::analyze_incomplete(&staged, &staged_meta)
                .ok_or(RecoveryError::NoRecoverableSegments)?;
            if staged_recording.recoverable_segments.iter().any(|segment| {
                segment
                    .display_fragments
                    .iter()
                    .chain(segment.camera_fragments.iter().flatten())
                    .any(|path| path.extension().is_some_and(|extension| extension == "tmp"))
            }) {
                return Err(RecoveryError::Validation(
                    "Failed to stage a complete fragment prefix".into(),
                ));
            }
            debug!(
                elapsed_ms = analyzing.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization staged analysis ready"
            );
            Self::require_recoverable_tracks(&staged_recording)?;
            Self::require_local_fragments(&staged_recording)?;
            let validating = Instant::now();
            Self::validate_staged_inputs(&staged_recording, video_validation)?;
            debug!(
                elapsed_ms = validating.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization staged inputs validated"
            );
            let remuxing = Instant::now();
            let recovered = Self::finalize_staged(&staged_recording, purpose, video_validation)?;
            debug!(
                elapsed_ms = remuxing.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization media ready"
            );
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
            let syncing = Instant::now();
            sync_recovery_input(&staged)?;
            debug!(
                elapsed_ms = syncing.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization staging synced"
            );
            before_source_check(project, &staged)?;
            Self::require_no_track_failure(project)?;
            let rechecking = Instant::now();
            if recovery_snapshot(project)? != before {
                return Err(RecoveryError::Validation(
                    "Recording changed before publication".into(),
                ));
            }
            debug!(
                elapsed_ms = rechecking.elapsed().as_secs_f64() * 1000.0,
                "Studio finalization source rechecked"
            );
            Ok(recovered.meta)
        })();
        let meta = match prepared {
            Ok(meta) => meta,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&workspace);
                return Err(error);
            }
        };
        if let Some(source) = &preparing_source {
            publish_recovery_with_source(project, &workspace, source)?;
            if let Some(job) = &mut preparing {
                job.mark_publication_succeeded();
            }
        } else {
            publish(project, &workspace)?;
        }
        debug!(
            elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            "Studio finalization complete"
        );
        if matches!(purpose, RecoveryPurpose::Finalize)
            && preparing_source.is_some()
            && let HeldRecoveryLock::Shared(lease) = &lock
            && let Err(error) = lease.retire_originals(project, &workspace)
        {
            warn!(path = %workspace.display(), %error, "Original media backup retained");
        }
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
            if video_validation == VideoValidation::Full || segment.display_init_segment.is_none() {
                validate_recovery_video_inputs(
                    &segment.display_fragments,
                    segment.display_init_segment.as_deref(),
                    &recording.project_path,
                    video_validation,
                )?;
            }
            let display_dir = recording.project_path.join(format!(
                "content/segments/segment-{}/display",
                segment.index
            ));
            if video_validation == VideoValidation::Full || segment.display_init_segment.is_none() {
                for (_, init, fragments) in Self::collect_respawn_groups(&display_dir, None, true) {
                    validate_recovery_video_inputs(
                        &fragments,
                        Some(&init),
                        &recording.project_path,
                        video_validation,
                    )?;
                }
            }
            if let Some(fragments) = &segment.camera_fragments
                && (video_validation == VideoValidation::Full
                    || segment.camera_init_segment.is_none())
            {
                validate_recovery_video_inputs(
                    fragments,
                    segment.camera_init_segment.as_deref(),
                    &recording.project_path,
                    video_validation,
                )?;
            }
            let audio = segment
                .mic_fragments
                .iter()
                .flatten()
                .chain(segment.system_audio_fragments.iter().flatten())
                .collect::<Vec<_>>();
            validate_recovered_audio_in_order(&audio)?;
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
            let Some(index) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix("segment-"))
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };

            if indexes.contains(&index) {
                continue;
            }

            // An interrupted resume, a crash or a power loss can leave a segment
            // directory behind that holds no media at all. It contributes
            // nothing to the recording, so ignoring it is what lets the segments
            // that do hold footage be recovered. A directory holding any
            // recoverable track is not that, and stays fatal: recovering around
            // it would silently drop that footage from the recording.
            if !Self::segment_holds_recoverable_media(&entry.path()) {
                warn!(
                    segment = index,
                    path = %entry.path().display(),
                    "Ignoring segment directory without recoverable media"
                );
                continue;
            }

            return Err(RecoveryError::Validation(format!(
                "Unrecoverable display segment {index}"
            )));
        }
        Ok(())
    }

    fn finalize_segment_video(
        recording: &IncompleteRecording,
        segment: &RecoverableSegment,
        segment_dir: &Path,
        video_validation: VideoValidation,
    ) -> Result<(), RecoveryError> {
        let video_started = Instant::now();
        let display_output = segment_dir.join("display.mp4");
        let display_dir = segment_dir.join("display");

        if segment.display_fragments.len() == 1 && segment.display_init_segment.is_none() {
            let source = &segment.display_fragments[0];
            if source != &display_output {
                finalization_info!("Moving single display fragment to {:?}", display_output);
                std::fs::rename(source, &display_output)?;
            }
            Self::validate_required_video(&display_output, "display", video_validation)?;
            if display_dir.exists()
                && let Err(e) = std::fs::remove_dir_all(&display_dir)
            {
                debug!("Failed to clean up display dir {:?}: {e}", display_dir);
            }
        } else if !segment.display_fragments.is_empty() {
            let finalize_result = if display_dir.exists() {
                Self::finalize_to_progressive_mp4_with_validation(
                    &display_dir,
                    &display_output,
                    None,
                    video_validation,
                    true,
                )
                .map(|_| ())
            } else {
                Self::finalize_fragments_to_progressive_mp4(
                    &segment.display_fragments,
                    segment.display_init_segment.as_deref(),
                    &display_output,
                    "display",
                    video_validation,
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
            && let Some(expected) =
                Self::expected_display_duration_from_config(&recording.project_path, segment.index)
        {
            crate::output_validation::check_display_sync_span(&display_output, expected);
        }

        if let Some(camera_frags) = &segment.camera_fragments {
            let camera_output = segment_dir.join("camera.mp4");
            if camera_frags.len() == 1 && segment.camera_init_segment.is_none() {
                if camera_frags[0] != camera_output {
                    std::fs::rename(&camera_frags[0], &camera_output)?;
                }
                Self::validate_required_video(&camera_output, "camera", video_validation)?;
            } else {
                Self::finalize_fragments_to_progressive_mp4(
                    camera_frags,
                    segment.camera_init_segment.as_deref(),
                    &camera_output,
                    "camera",
                    video_validation,
                )?;
            }
            let camera_dir = segment_dir.join("camera");
            if camera_dir.exists() {
                std::fs::remove_dir_all(camera_dir)?;
            }
        }

        debug!(
            segment = segment.index,
            elapsed_ms = video_started.elapsed().as_secs_f64() * 1000.0,
            "Studio finalization segment video ready"
        );
        Ok(())
    }

    fn finalize_segment_audio(
        segment: &RecoverableSegment,
        segment_dir: &Path,
    ) -> Result<(), RecoveryError> {
        let audio_started = Instant::now();

        if let Some(mic_frags) = &segment.mic_fragments {
            let mic_output =
                segment_dir.join(finalized_audio_name(segment_dir, "audio-input", mic_frags));
            if mic_frags.len() == 1 {
                let source = &mic_frags[0];
                let is_ogg = source.extension().map(|e| e == "ogg").unwrap_or(false);
                if mic_output
                    .extension()
                    .is_some_and(|extension| extension == "m4a")
                {
                    finalize_m4a(source, &mic_output)?;
                } else if source != &mic_output {
                    if is_ogg {
                        finalization_info!("Moving single mic fragment to {:?}", mic_output);
                        std::fs::rename(source, &mic_output)?;
                    } else {
                        finalization_info!("Transcoding single mic fragment to {:?}", mic_output);
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
            let system_output = segment_dir.join(finalized_audio_name(
                segment_dir,
                "system_audio",
                system_frags,
            ));
            if system_frags.len() == 1 {
                let source = &system_frags[0];
                let is_ogg = source.extension().map(|e| e == "ogg").unwrap_or(false);
                if system_output
                    .extension()
                    .is_some_and(|extension| extension == "m4a")
                {
                    finalize_m4a(source, &system_output)?;
                } else if source != &system_output {
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
        debug!(
            segment = segment.index,
            elapsed_ms = audio_started.elapsed().as_secs_f64() * 1000.0,
            "Studio finalization segment audio remuxed"
        );
        Ok(())
    }

    fn validate_segment_audio(
        segment: &RecoverableSegment,
        segment_dir: &Path,
        video_validation: VideoValidation,
    ) -> [Option<Result<(), RecoveryError>>; 2] {
        [
            ("audio-input", segment.mic_fragments.as_deref()),
            ("system_audio", segment.system_audio_fragments.as_deref()),
        ]
        .map(|(stem, fragments)| {
            fragments.map(|fragments| {
                validate_recovery_track(
                    &segment_dir.join(finalized_audio_name(segment_dir, stem, fragments)),
                    ffmpeg::media::Type::Audio,
                    video_validation,
                )
            })
        })
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

        let mut audio_validations = Vec::with_capacity(recording.recoverable_segments.len());
        for segment in &recording.recoverable_segments {
            let segment_dir = recording
                .project_path
                .join("content/segments")
                .join(format!("segment-{}", segment.index));

            let (video, audio) = std::thread::scope(|scope| {
                let audio = std::thread::Builder::new()
                    .name("studio-audio-finalize".into())
                    .stack_size(AUDIO_FINALIZE_STACK_SIZE)
                    .spawn_scoped(scope, || {
                        Self::finalize_segment_audio(segment, &segment_dir).map(|()| {
                            Self::validate_segment_audio(segment, &segment_dir, video_validation)
                        })
                    })
                    .ok();
                let video = Self::finalize_segment_video(
                    recording,
                    segment,
                    &segment_dir,
                    video_validation,
                );
                (video, audio.map(|handle| handle.join()))
            });
            video?;
            audio_validations.push(match audio {
                Some(Ok(audio)) => audio?,
                Some(Err(_)) => {
                    return Err(RecoveryError::Validation(
                        "Studio audio finalization panicked".into(),
                    ));
                }
                None => {
                    Self::finalize_segment_audio(segment, &segment_dir)?;
                    Default::default()
                }
            });
        }

        let validating = Instant::now();
        for (segment, [mic_validation, system_validation]) in
            recording.recoverable_segments.iter().zip(audio_validations)
        {
            let dir = recording
                .project_path
                .join(format!("content/segments/segment-{}", segment.index));
            if video_validation == VideoValidation::Full {
                validate_recovery_track(
                    &dir.join("display.mp4"),
                    ffmpeg::media::Type::Video,
                    video_validation,
                )?;
            }
            for (fragments, audio_stem, kind, validated) in [
                (
                    segment.camera_fragments.as_deref(),
                    None,
                    ffmpeg::media::Type::Video,
                    None,
                ),
                (
                    segment.mic_fragments.as_deref(),
                    Some("audio-input"),
                    ffmpeg::media::Type::Audio,
                    mic_validation,
                ),
                (
                    segment.system_audio_fragments.as_deref(),
                    Some("system_audio"),
                    ffmpeg::media::Type::Audio,
                    system_validation,
                ),
            ] {
                if let Some(fragments) = fragments
                    && (kind != ffmpeg::media::Type::Video
                        || video_validation == VideoValidation::Full)
                {
                    match validated {
                        Some(result) => result?,
                        None => {
                            let name = audio_stem.map_or_else(
                                || "camera.mp4".to_string(),
                                |stem| finalized_audio_name(&dir, stem, fragments),
                            );
                            validate_recovery_track(&dir.join(name), kind, video_validation)?;
                        }
                    }
                }
            }
        }
        debug!(
            elapsed_ms = validating.elapsed().as_secs_f64() * 1000.0,
            "Studio finalization output tracks validated"
        );
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

    pub fn validate_instant_output(
        project_path: &Path,
        required_audio: bool,
    ) -> Result<PathBuf, RecoveryError> {
        let content = project_path.join("content");
        let output = content.join("output.mp4");
        for path in [project_path, content.as_path(), output.as_path()] {
            reject_recovery_link(&path.symlink_metadata()?)?;
        }
        Self::require_no_track_failure(project_path)?;
        validate_recovered_track(&output, ffmpeg::media::Type::Video)?;
        probe_video_seek_points(&output, EXPORT_SEEK_PROBE_SAMPLE_COUNT)
            .map_err(RecoveryError::UnplayableVideo)?;
        let input = ffmpeg::format::input(&output)
            .map_err(|error| RecoveryError::Validation(error.to_string()))?;
        let has_audio = input.streams().best(ffmpeg::media::Type::Audio).is_some();
        drop(input);
        if required_audio || has_audio {
            validate_recovered_track(&output, ffmpeg::media::Type::Audio)?;
        }
        Ok(output)
    }

    pub fn finalize_instant_output(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
    ) -> Result<PathBuf, RecoveryError> {
        Self::finalize_instant_output_with_completion(display_dir, audio_dir, output, None)
    }

    pub fn finalize_completed_instant_output(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
        completion: crate::instant_recording::CleanInstantRecording,
    ) -> Result<PathBuf, RecoveryError> {
        Self::finalize_instant_output_with_completion(
            display_dir,
            audio_dir,
            output,
            Some(completion.into_parts()),
        )
    }

    fn finalize_instant_output_with_completion(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
        completion: Option<(PathBuf, bool)>,
    ) -> Result<PathBuf, RecoveryError> {
        Self::finalize_instant_output_with(
            display_dir,
            audio_dir,
            output,
            completion,
            |source, destination| std::fs::rename(source, destination),
            |workspace| std::fs::remove_dir_all(workspace),
        )
    }

    fn finalize_instant_output_with(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
        completion: Option<(PathBuf, bool)>,
        publish: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
        cleanup: impl FnOnce(&Path) -> std::io::Result<()>,
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
        let (video_validation, completed_audio) = match completion {
            Some((completed_project, expected_audio)) => {
                if completed_project != project {
                    return Err(RecoveryError::Validation(
                        "Instant completion belongs to another recording".into(),
                    ));
                }
                if display_dir != content.join("display")
                    || audio_dir != content.join("audio")
                    || output != content.join("output.mp4")
                {
                    return Err(RecoveryError::Validation(
                        "Instant completion must use the recorded track and output paths".into(),
                    ));
                }
                (VideoValidation::Bounded, expected_audio)
            }
            None => (VideoValidation::Full, false),
        };
        let staging_durability = match video_validation {
            VideoValidation::Full => RecoveryCopyDurability::Durable,
            VideoValidation::Bounded => RecoveryCopyDurability::Deferred,
        };
        Self::require_no_track_failure(project)?;
        let _lock = RecoveryLock::acquire(project)?;
        let before = recovery_snapshot(project)?;
        let mut expected_audio = completed_audio || audio_dir.try_exists()?;
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
            copy_recovery_input_with_durability(content, &staged, staging_durability)?;
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
            Self::rescue_pending_tmp_fragments(&display, None, false);
            let video = Self::find_complete_fragments_with_init(&display);
            if video_validation == VideoValidation::Full || video.init_segment.is_none() {
                validate_recovery_video_inputs(
                    &video.fragments,
                    video.init_segment.as_deref(),
                    &workspace,
                    video_validation,
                )?;
            }
            let final_audio_validation = Self::finalize_instant_staged(
                &display,
                &audio,
                &final_output,
                video_validation,
                expected_audio,
            )?;
            if video_validation == VideoValidation::Full {
                validate_recovery_track(
                    &final_output,
                    ffmpeg::media::Type::Video,
                    video_validation,
                )?;
            }
            if expected_audio {
                match final_audio_validation {
                    Some(result) => result?,
                    None => validate_recovered_track(&final_output, ffmpeg::media::Type::Audio)?,
                }
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
            publish(&final_output, output)?;
            Ok(output.to_path_buf())
        })();
        if let Err(error) = cleanup(&workspace) {
            warn!(path = %workspace.display(), %error, "Could not remove temporary Instant finalization workspace");
        }
        result
    }

    fn finalize_instant_staged(
        display_dir: &Path,
        audio_dir: &Path,
        output: &Path,
        video_validation: VideoValidation,
        validate_output_audio: bool,
    ) -> Result<Option<Result<(), RecoveryError>>, RecoveryError> {
        if !audio_dir.exists() {
            Self::finalize_to_progressive_mp4_with_validation(
                display_dir,
                output,
                None,
                video_validation,
                false,
            )?;
            return Ok(None);
        }

        Self::rescue_pending_tmp_fragments(audio_dir, None, false);
        let audio_info = Self::find_complete_fragments_with_init(audio_dir);
        if audio_info.fragments.is_empty() {
            return Err(RecoveryError::Validation(
                "Required Instant audio has no recoverable fragments".into(),
            ));
        }

        let parent = output.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let stem = output
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("instant");
        let video_output = parent.join(format!("{stem}.video.mp4"));
        let audio_output = parent.join(format!("{stem}.audio.mp4"));
        let merged_output = parent.join(format!("{stem}.merged.mp4"));

        let result = (|| {
            let finalize_audio = || {
                let validated = validate_recovery_track_inputs(
                    &audio_info.fragments,
                    audio_info.init_segment.as_deref(),
                    parent,
                    ffmpeg::media::Type::Audio,
                    VideoValidation::Full,
                );
                validated.map(|()| {
                    Self::finalize_audio_fragments_to_progressive_mp4(
                        &audio_info.fragments,
                        audio_info.init_segment.as_deref(),
                        &audio_output,
                        "audio",
                    )
                })
            };
            let (audio, video) = std::thread::scope(|scope| {
                let audio = std::thread::Builder::new()
                    .name("instant-audio-finalize".into())
                    .stack_size(AUDIO_FINALIZE_STACK_SIZE)
                    .spawn_scoped(scope, finalize_audio)
                    .ok();
                let video = Self::finalize_to_progressive_mp4_with_validation(
                    display_dir,
                    &video_output,
                    None,
                    video_validation,
                    false,
                );
                let audio = match audio {
                    Some(handle) => handle.join().unwrap_or_else(|_| {
                        Err(RecoveryError::Validation(
                            "Instant audio finalization panicked".into(),
                        ))
                    }),
                    None => finalize_audio(),
                };
                (audio, video)
            });
            let audio_concat = audio?;
            video?;
            audio_concat?;
            merge_video_audio(&video_output, &audio_output, &merged_output)
                .map_err(RecoveryError::MediaMerge)?;
            let (video, audio) = std::thread::scope(|scope| {
                let audio = validate_output_audio
                    .then(|| {
                        std::thread::Builder::new()
                            .name("instant-audio-validate".into())
                            .stack_size(AUDIO_FINALIZE_STACK_SIZE)
                            .spawn_scoped(scope, || {
                                validate_recovered_track(&merged_output, ffmpeg::media::Type::Audio)
                            })
                            .ok()
                    })
                    .flatten();
                let video = Self::check_required_video(&merged_output, "display", video_validation);
                (video, audio.and_then(|handle| handle.join().ok()))
            });
            let audio = match video? {
                Ok(()) => audio,
                Err(seek_error) => {
                    Self::normalize_required_video(
                        &merged_output,
                        "display",
                        video_validation,
                        &seek_error,
                    )?;
                    None
                }
            };
            replace_file(&merged_output, output)?;
            Ok(audio)
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
        Self::finalize_to_progressive_mp4_with_validation(
            fragmented_dir,
            output,
            health_tx,
            VideoValidation::Full,
            true,
        )
    }

    fn finalize_to_progressive_mp4_with_validation(
        fragmented_dir: &Path,
        output: &Path,
        health_tx: Option<&HealthSender>,
        video_validation: VideoValidation,
        recover_complete_prefixes: bool,
    ) -> Result<PathBuf, RecoveryError> {
        Self::rescue_pending_tmp_fragments(fragmented_dir, health_tx, recover_complete_prefixes);

        let info = Self::find_complete_fragments_with_init(fragmented_dir);
        let respawn_groups =
            Self::collect_respawn_groups(fragmented_dir, health_tx, recover_complete_prefixes);

        if respawn_groups.is_empty() {
            Self::finalize_fragments_to_progressive_mp4(
                &info.fragments,
                info.init_segment.as_deref(),
                output,
                "display",
                video_validation,
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

        if !info.fragments.is_empty() {
            let main_tmp = parent.join(format!("{stem}.main.mp4"));
            Self::finalize_fragments_to_progressive_mp4(
                &info.fragments,
                info.init_segment.as_deref(),
                &main_tmp,
                "display",
                video_validation,
            )?;
            temp_paths.push(main_tmp.clone());
            group_outputs.push(main_tmp);
        }

        for (n, init, fragments) in respawn_groups {
            let group_tmp = parent.join(format!("{stem}.respawn-{n}.mp4"));
            Self::finalize_fragments_to_progressive_mp4(
                &fragments,
                Some(init.as_path()),
                &group_tmp,
                &format!("display respawn-{n}"),
                video_validation,
            )?;
            temp_paths.push(group_tmp.clone());
            group_outputs.push(group_tmp);
        }

        let concat_result = if group_outputs.len() == 1 {
            std::fs::rename(&group_outputs[0], output)
                .map_err(|e| RecoveryError::VideoConcat(cap_enc_ffmpeg::remux::RemuxError::Io(e)))
        } else {
            concatenate_video_fragments_on_timeline(&group_outputs, output)
                .map_err(RecoveryError::VideoConcat)
        };

        for tmp in &temp_paths {
            if tmp.exists() && tmp != output {
                let _ = std::fs::remove_file(tmp);
            }
        }

        concat_result?;
        Self::validate_required_video(output, "display", video_validation)?;

        Ok(output.to_path_buf())
    }

    fn finalize_fragments_to_progressive_mp4(
        fragments: &[PathBuf],
        init_segment: Option<&Path>,
        output: &Path,
        label: &str,
        video_validation: VideoValidation,
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
            match video_validation {
                VideoValidation::Bounded => {
                    concatenate_m4s_segments_with_init_validated(init_path, fragments, output)
                }
                VideoValidation::Full => {
                    concatenate_m4s_segments_with_init(init_path, fragments, output)
                }
            }
            .map_err(RecoveryError::VideoConcat)?;
        } else {
            finalization_info!(
                "Concatenating {} {label} fragments to {:?}",
                fragments.len(),
                output
            );
            concatenate_video_fragments(fragments, output).map_err(RecoveryError::VideoConcat)?;
        }

        Self::validate_required_video(output, label, video_validation)?;
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

    fn validate_required_video(
        path: &Path,
        label: &str,
        video_validation: VideoValidation,
    ) -> Result<(), RecoveryError> {
        if let Err(seek_error) = Self::check_required_video(path, label, video_validation)? {
            Self::normalize_required_video(path, label, video_validation, &seek_error)?;
        }
        Ok(())
    }

    fn check_required_video(
        path: &Path,
        label: &str,
        video_validation: VideoValidation,
    ) -> Result<Result<(), String>, RecoveryError> {
        finalization_info!("Validating finalized {} video: {:?}", label, path);

        if video_validation == VideoValidation::Full {
            Self::ensure_video_decodes(path, label)?;
        }

        let (seek_result, track_result) = std::thread::scope(|scope| {
            let track = (video_validation == VideoValidation::Bounded).then(|| {
                scope.spawn(|| {
                    validate_recovery_track(path, ffmpeg::media::Type::Video, video_validation)
                })
            });
            let seek = probe_video_seek_points(path, EXPORT_SEEK_PROBE_SAMPLE_COUNT);
            let track = track.map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(RecoveryError::Validation(format!(
                        "{label} video track validation panicked"
                    )))
                })
            });
            (seek, track)
        });

        match seek_result {
            Ok(()) => {
                if let Some(track_result) = track_result {
                    track_result?;
                }
                Ok(Ok(()))
            }
            Err(seek_error) => Ok(Err(seek_error)),
        }
    }

    fn normalize_required_video(
        path: &Path,
        label: &str,
        video_validation: VideoValidation,
        seek_error: &str,
    ) -> Result<(), RecoveryError> {
        finalization_info!(
            "Finalized {} video failed seek validation, normalizing via remux: {}",
            label,
            seek_error
        );
        Self::normalize_recovered_video(path, label)?;
        if video_validation == VideoValidation::Bounded {
            validate_recovery_track(path, ffmpeg::media::Type::Video, video_validation)?;
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
                // Decoders number frames on this rate. The file's average rate
                // is far lower for a mostly static screen (11 fps for a 120 fps
                // capture), and on that coarse grid playback and export drop
                // every picture shorter than one step.
                let fps = original_segment
                    .map(|s| s.display.fps)
                    .filter(|fps| *fps > 0)
                    .or_else(|| get_video_base_fps(&display_path))
                    .unwrap_or(30);

                let cursor_path = segment_dir.join("cursor.json");
                let keyboard_path = {
                    let binary = segment_dir.join(cap_project::KEYBOARD_EVENTS_FILE_NAME);
                    if binary.exists() {
                        binary
                    } else {
                        segment_dir.join(cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME)
                    }
                };

                let persisted = persisted_start_times(&segment_dir);
                let display_start_time = original_segment
                    .and_then(|s| s.display.start_time)
                    .or(persisted.map(|times| times.display));

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
                                    .and_then(|c| c.start_time)
                                    .or(persisted.and_then(|times| times.camera)),
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
                                    "{segment_base}/{}",
                                    finalized_audio_name(
                                        &segment_dir,
                                        "audio-input",
                                        seg.mic_fragments.as_deref().unwrap_or_default()
                                    )
                                )),
                                start_time: get_start_time_or_fallback(
                                    original_segment
                                        .and_then(|s| s.mic.as_ref())
                                        .and_then(|m| m.start_time)
                                        .or(persisted.and_then(|times| times.mic)),
                                ),
                                device_id: original_segment
                                    .and_then(|s| s.mic.as_ref())
                                    .and_then(|m| m.device_id.clone()),
                                gap_summary: None,
                                digital_silence_ms: original_segment
                                    .and_then(|s| s.mic.as_ref())
                                    .and_then(|m| m.digital_silence_ms),
                            })
                        } else {
                            None
                        }
                    },
                    system_audio: {
                        if seg.system_audio_fragments.is_some() {
                            Some(AudioMeta {
                                path: RelativePathBuf::from(format!(
                                    "{segment_base}/{}",
                                    finalized_audio_name(
                                        &segment_dir,
                                        "system_audio",
                                        seg.system_audio_fragments.as_deref().unwrap_or_default()
                                    )
                                )),
                                start_time: get_start_time_or_fallback(
                                    original_segment
                                        .and_then(|s| s.system_audio.as_ref())
                                        .and_then(|a| a.start_time)
                                        .or(persisted.and_then(|times| times.system_audio)),
                                ),
                                device_id: original_segment
                                    .and_then(|s| s.system_audio.as_ref())
                                    .and_then(|a| a.device_id.clone()),
                                gap_summary: None,
                                digital_silence_ms: None,
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
                    hide_cursor: None,
                    volume: None,
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
            style_segments: Vec::new(),
            image_segments: Vec::new(),
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
        if video_validation == VideoValidation::Full {
            output.sync_all()?;
        }
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

enum HeldRecoveryLock {
    Owned { _lock: RecoveryLock },
    Shared(Arc<PreparingRecoveryLock>),
}

impl HeldRecoveryLock {
    fn new(lock: RecoveryLock, preparing: bool) -> Self {
        if preparing {
            let lock = retirement::RecoveryLease::new(lock);
            Self::Shared(Arc::new(lock))
        } else {
            Self::Owned { _lock: lock }
        }
    }
}

fn prepare_studio_source(
    recording: &IncompleteRecording,
    preparing: Option<&mut PreparingStudioJob>,
    lock: &HeldRecoveryLock,
) -> Option<RelocatableSource> {
    let job = preparing?;
    let HeldRecoveryLock::Shared(lock) = lock else {
        job.unavailable("The finalizer does not own a preparing source lease".into());
        return None;
    };
    let projected = job
        .claimed()
        .ok_or_else(|| "The stopped recording was already claimed".to_string())
        .and_then(|claim| preparing_projection::project(recording, claim))
        .and_then(|projection| {
            let source = RelocatableSource::new_with_owner(
                recording.project_path.join("content/segments"),
                lock.clone(),
            )
            .map_err(|error| error.to_string())?;
            Ok((source, projection))
        });
    match projected {
        Ok((source, projection)) => job.publish(source.clone(), projection).then_some(source),
        Err(error) => {
            job.unavailable(error);
            None
        }
    }
}

struct RecoveryLock {
    _file: std::fs::File,
    #[cfg(unix)]
    owner_pid: libc::pid_t,
}

impl RecoveryLock {
    fn acquire(project: &Path) -> Result<Self, RecoveryError> {
        Self::acquire_with(project, reconcile_recovery_publication)
    }

    fn acquire_for_preparing_preview(project: &Path) -> Result<Self, RecoveryError> {
        Self::acquire_with(project, |project| {
            match project.join(RECOVERY_PUBLICATION).symlink_metadata() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
                Ok(_) => Err(RecoveryError::Validation(
                    "Interrupted publication must be reconciled after preparing preview readers stop"
                        .into(),
                )),
            }
        })
    }

    fn acquire_with(
        project: &Path,
        reconcile: impl FnOnce(&Path) -> Result<(), RecoveryError>,
    ) -> Result<Self, RecoveryError> {
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
        let lock = Self {
            _file: file,
            #[cfg(unix)]
            owner_pid: unsafe { libc::getpid() },
        };
        if let Err(error) = reconcile(project) {
            warn!(path = %project.display(), %error, "Interrupted recovery publication requires attention; all files retained");
            return Err(error);
        }
        Ok(lock)
    }
}

impl RecoveryLock {
    /// Whether this process took the lock: on unix a forked child inherits the
    /// descriptor but not the lock's ownership. Windows has no fork.
    fn owned_by_this_process(&self) -> bool {
        #[cfg(unix)]
        {
            self.owner_pid == unsafe { libc::getpid() }
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}

#[cfg(unix)]
impl Drop for RecoveryLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        // CLOEXEC still leaves a fork-to-exec window that can outlive this guard.
        if self.owner_pid == unsafe { libc::getpid() }
            && unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) } != 0
        {
            warn!(error = %std::io::Error::last_os_error(), "Failed to release recovery lock");
        }
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

/// On exFAT/FAT volumes macOS keeps each file's extended attributes (every
/// file Cap writes gets `com.apple.provenance`) in a visible `._<name>`
/// AppleDouble sibling, and creates the destination's own sibling as soon as a
/// copy creates `<name>`. Copying the source's sibling then fails with EEXIST,
/// every time: https://github.com/CapSoftware/Cap/issues/2386. Cap never
/// writes `._` names, so these entries are filesystem bookkeeping, not
/// recording data.
fn is_apple_double(name: &std::ffi::OsStr) -> bool {
    name.as_encoded_bytes().starts_with(b"._")
}

fn copy_recovery_input(source: &Path, destination: &Path) -> Result<(), RecoveryError> {
    copy_recovery_input_with_durability(source, destination, RecoveryCopyDurability::Durable)
}

fn copy_recovery_input_with_durability(
    source: &Path,
    destination: &Path,
    durability: RecoveryCopyDurability,
) -> Result<(), RecoveryError> {
    let metadata = source.symlink_metadata()?;
    reject_recovery_link(&metadata)?;
    if metadata.is_dir() {
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            if is_apple_double(&entry.file_name()) {
                continue;
            }
            copy_recovery_input_with_durability(
                &entry.path(),
                &destination.join(entry.file_name()),
                durability,
            )?;
        }
    } else if metadata.is_file() {
        let mut input = std::fs::File::open(source)?;
        #[cfg(target_os = "macos")]
        if clone_recovery_file(&input, destination) {
            if durability == RecoveryCopyDurability::Durable {
                std::fs::File::open(destination)?.sync_all()?;
            }
            return Ok(());
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
        if durability == RecoveryCopyDurability::Durable {
            output.sync_all()?;
        }
    } else {
        return Err(RecoveryError::Validation(format!(
            "Unsupported recovery input: {}",
            source.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clone_recovery_file(input: &std::fs::File, destination: &Path) -> bool {
    use std::{os::fd::AsRawFd, os::unix::ffi::OsStrExt};

    let Ok(destination) = std::ffi::CString::new(destination.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::fclonefileat(input.as_raw_fd(), libc::AT_FDCWD, destination.as_ptr(), 0) == 0 }
}

type RecoverySnapshot = std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>;

fn hash_recovery_file(root: &Path, path: &Path) -> Result<(PathBuf, Vec<u8>), RecoveryError> {
    use std::io::Read;

    let metadata = path.symlink_metadata()?;
    reject_recovery_link(&metadata)?;
    if !metadata.is_file() {
        return Err(RecoveryError::Validation(format!(
            "Unsupported recovery input: {}",
            path.display()
        )));
    }
    let mut input = std::fs::File::open(path)?;
    let mut digest = blake3::Hasher::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|error| RecoveryError::Validation(error.to_string()))?
        .to_path_buf();
    Ok((relative, digest.finalize().as_bytes().to_vec()))
}

fn hash_recovery_files(root: &Path, paths: &[PathBuf]) -> Result<RecoverySnapshot, RecoveryError> {
    let mut entries = RecoverySnapshot::new();
    for path in paths {
        let (relative, hash) = hash_recovery_file(root, path)?;
        let _ = entries.insert(relative, Some(hash));
    }
    Ok(entries)
}

const MAX_RECOVERY_HASH_WORKERS: usize = 8;

fn hash_recovery_files_parallel(
    root: &Path,
    paths: &[PathBuf],
    workers: usize,
) -> Result<RecoverySnapshot, RecoveryError> {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let drain = || -> Result<Vec<(PathBuf, Vec<u8>)>, RecoveryError> {
        let mut hashes = Vec::new();
        while !failed.load(Ordering::Relaxed) {
            let Some(path) = paths.get(next.fetch_add(1, Ordering::Relaxed)) else {
                break;
            };
            match hash_recovery_file(root, path) {
                Ok(hash) => hashes.push(hash),
                Err(error) => {
                    failed.store(true, Ordering::Relaxed);
                    return Err(error);
                }
            }
        }
        Ok(hashes)
    };
    std::thread::scope(|scope| {
        let helpers: Vec<_> = (1..workers)
            .filter_map(|_| {
                std::thread::Builder::new()
                    .name("studio-integrity-check".into())
                    .spawn_scoped(scope, drain)
                    .ok()
            })
            .collect();
        let own = drain();
        let results: Vec<_> = std::iter::once(Ok(own))
            .chain(helpers.into_iter().map(|helper| {
                helper.join().map_err(|_| {
                    RecoveryError::Validation("Recovery integrity worker panicked".into())
                })
            }))
            .collect();
        let mut first_error = None;
        let mut entries = RecoverySnapshot::new();
        for hashes in results {
            match hashes? {
                Ok(hashes) => {
                    entries.extend(hashes.into_iter().map(|(path, hash)| (path, Some(hash))))
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(entries),
        }
    })
}

fn recovery_snapshot(project: &Path) -> Result<RecoverySnapshot, RecoveryError> {
    fn visit(
        root: &Path,
        path: &Path,
        entries: &mut RecoverySnapshot,
        files: &mut Vec<PathBuf>,
        bytes: &mut u64,
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
                let entry = entry?;
                if !is_apple_double(&entry.file_name()) {
                    visit(root, &entry.path(), entries, files, bytes)?;
                }
            }
        } else if metadata.is_file() {
            files.push(path.to_path_buf());
            *bytes = bytes.saturating_add(metadata.len());
        } else {
            return Err(RecoveryError::Validation(format!(
                "Unsupported recovery input: {}",
                path.display()
            )));
        }
        Ok(())
    }
    let mut entries = RecoverySnapshot::new();
    let mut files = Vec::new();
    let mut bytes = 0;
    for name in RECOVERY_INPUTS {
        let path = project.join(name);
        match path.symlink_metadata() {
            Ok(_) => visit(project, &path, &mut entries, &mut files, &mut bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let workers = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_RECOVERY_HASH_WORKERS)
        .min(files.len());
    let hashes = if bytes >= 32 * 1024 * 1024 && workers > 1 {
        hash_recovery_files_parallel(project, &files, workers)?
    } else {
        hash_recovery_files(project, &files)?
    };
    entries.extend(hashes);
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

#[derive(Clone, Copy)]
enum RecoveryPublicationStampVersion {
    V1,
    V2,
    /// Leaves `._` AppleDouble entries out of the segments stamp. Receipts
    /// written as V1/V2 keep hashing them, so publications those builds
    /// interrupted still reconcile.
    V3,
}

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

fn recovery_publication_segments_stamp(
    path: &Path,
    version: RecoveryPublicationStampVersion,
) -> Result<Option<[u8; 32]>, RecoveryError> {
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
        version: RecoveryPublicationStampVersion,
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
                // V1 persists allocation sizes; some filesystems change directory sizes on rename.
                size: if metadata.is_dir()
                    && matches!(
                        version,
                        RecoveryPublicationStampVersion::V2 | RecoveryPublicationStampVersion::V3
                    ) {
                    0
                } else {
                    metadata.len()
                },
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
                let entry = entry?;
                if matches!(version, RecoveryPublicationStampVersion::V3)
                    && is_apple_double(&entry.file_name())
                {
                    continue;
                }
                visit(root, &entry.path(), entries, version)?;
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
    visit(path, path, &mut entries, version)?;
    Ok(Some(
        sha2::Sha256::digest(serde_json::to_vec(&entries)?).into(),
    ))
}

fn recovery_publication_state(project: &Path) -> Result<RecoveryPublicationState, RecoveryError> {
    recovery_publication_state_for_version(project, RecoveryPublicationStampVersion::V3)
}

fn recovery_publication_state_for_version(
    project: &Path,
    version: RecoveryPublicationStampVersion,
) -> Result<RecoveryPublicationState, RecoveryError> {
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
        segments: recovery_publication_segments_stamp(&project.join("content/segments"), version)?,
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
        version: 3,
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
    let version = match receipt.version {
        1 => RecoveryPublicationStampVersion::V1,
        2 => RecoveryPublicationStampVersion::V2,
        3 => RecoveryPublicationStampVersion::V3,
        _ => {
            return Err(RecoveryError::Validation(
                "Invalid publication identity; evidence retained".into(),
            ));
        }
    };
    if receipt.project != project.canonicalize()?
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
    let current = recovery_publication_state_for_version(project, version)?;
    let staged = recovery_publication_state_for_version(&workspace.join("staged"), version)?;
    let backup =
        recovery_publication_segments_stamp(&workspace.join("original-segments"), version)?;
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
        if recovery_publication_state_for_version(project, version)? != receipt.original {
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

fn publish_recovery_with_source(
    project: &Path,
    workspace: &Path,
    source: &RelocatableSource,
) -> Result<(), RecoveryError> {
    let original = project.join("content/segments");
    let backup = workspace.join("original-segments");
    publish_recovery_with(project, workspace, |from, to| {
        rename_recovery_path_with_source(from, to, &original, &backup, source)
    })
}

fn rename_recovery_path_with_source(
    from: &Path,
    to: &Path,
    original: &Path,
    backup: &Path,
    source: &RelocatableSource,
) -> std::io::Result<()> {
    if (from == original && to == backup) || (from == backup && to == original) {
        source.relocate_from(from, to.to_path_buf())
    } else {
        rename_recovery_path(from, to)
    }
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

fn finalized_audio_name(segment_dir: &Path, stem: &str, fragments: &[PathBuf]) -> String {
    let m4a = format!("{stem}.m4a");
    if let [source] = fragments
        && source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("m4a"))
    {
        let output = segment_dir.join(&m4a);
        let source = if source.is_file() {
            source.as_path()
        } else {
            output.as_path()
        };
        if ffmpeg::format::input(source).is_ok_and(|input| {
            input.streams().best(ffmpeg::media::Type::Video).is_none()
                && input
                    .streams()
                    .best(ffmpeg::media::Type::Audio)
                    .is_some_and(|stream| stream.parameters().id() == ffmpeg::codec::Id::AAC)
        }) {
            return m4a;
        }
    }
    format!("{stem}.ogg")
}

fn finalize_m4a(source: &Path, output: &Path) -> Result<(), RecoveryError> {
    let temporary = output.with_extension(format!("{}.m4a", uuid::Uuid::new_v4()));
    remux_file(source, &temporary).map_err(RecoveryError::AudioConcat)?;
    replace_file(&temporary, output)?;
    if source != output {
        std::fs::remove_file(source)?;
    }
    Ok(())
}

fn validate_recovered_track(path: &Path, kind: ffmpeg::media::Type) -> Result<(), RecoveryError> {
    validate_recovery_track(path, kind, VideoValidation::Full)
}

const MAX_AUDIO_VALIDATION_WORKERS: usize = 4;

const AUDIO_FINALIZE_STACK_SIZE: usize = 16 * 1024 * 1024;

fn validate_recovered_audio_in_order(paths: &[&PathBuf]) -> Result<(), RecoveryError> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let workers = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_AUDIO_VALIDATION_WORKERS)
        .min(paths.len());
    if workers <= 1 {
        for path in paths {
            validate_recovered_track(path, ffmpeg::media::Type::Audio)?;
        }
        return Ok(());
    }
    let next = AtomicUsize::new(0);
    let drain = || {
        let mut results = Vec::new();
        loop {
            let index = next.fetch_add(1, Ordering::Relaxed);
            let Some(path) = paths.get(index) else {
                break;
            };
            results.push((
                index,
                validate_recovered_track(path, ffmpeg::media::Type::Audio),
            ));
        }
        results
    };
    let mut results = std::thread::scope(|scope| {
        let helpers = (1..workers)
            .filter_map(|_| {
                std::thread::Builder::new()
                    .name("studio-audio-validate".into())
                    .stack_size(AUDIO_FINALIZE_STACK_SIZE)
                    .spawn_scoped(scope, drain)
                    .ok()
            })
            .collect::<Vec<_>>();
        let mut results = drain();
        for helper in helpers {
            match helper.join() {
                Ok(helper_results) => results.extend(helper_results),
                Err(_) => {
                    return Err(RecoveryError::Validation(
                        "Studio audio validation panicked".into(),
                    ));
                }
            }
        }
        Ok(results)
    })?;
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().try_for_each(|(_, result)| result)
}

fn full_validation_decode_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |count| count.get().min(8))
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
        let mut context = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .map_err(|error| error.to_string())?;
        if kind == ffmpeg::media::Type::Video && video_validation == VideoValidation::Full {
            context.set_threading(ffmpeg::threading::Config {
                kind: ffmpeg::threading::Type::Frame,
                count: full_validation_decode_threads(),
            });
        }
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
mod instant_cleanup_tests {
    use super::*;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
    use std::{cell::Cell, fs, io};

    fn playable_instant_project() -> tempfile::TempDir {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let display = directory.path().join("content/display");
        let mut encoder = SegmentedVideoEncoder::init(
            display,
            cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 320,
                height: 240,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            },
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_secs(1),
                ..Default::default()
            },
        )
        .unwrap();
        for index in 0..60 {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
            frame.data_mut(0).fill(32 + index as u8);
            frame.data_mut(1).fill(128);
            encoder
                .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
                .unwrap();
        }
        encoder.finish().unwrap();
        assert!(!encoder.completed_segments().is_empty());
        drop(encoder);
        directory
    }

    fn refuse_workspace_cleanup(workspace: &Path) -> io::Result<()> {
        assert!(workspace.is_dir());
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "injected workspace cleanup failure",
        ))
    }

    #[test]
    fn existing_instant_validation_is_read_only_and_requires_requested_audio() {
        let directory = playable_instant_project();
        let project = directory.path();
        let output = project.join("content/output.mp4");
        RecoveryManager::finalize_instant_output(
            &project.join("content/display"),
            &project.join("content/audio"),
            &output,
        )
        .unwrap();
        let before = recovery_snapshot(project).unwrap();
        assert_eq!(
            RecoveryManager::validate_instant_output(project, false).unwrap(),
            output
        );
        assert!(RecoveryManager::validate_instant_output(project, true).is_err());
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        fs::write(&output, b"invalid media retained for repair").unwrap();
        let before = recovery_snapshot(project).unwrap();
        assert!(RecoveryManager::validate_instant_output(project, false).is_err());
        assert_eq!(recovery_snapshot(project).unwrap(), before);
    }

    fn retained_workspace(project: &Path) -> PathBuf {
        let workspaces: Vec<_> = fs::read_dir(project)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.is_dir()
                    && path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".recovery-")
            })
            .collect();
        assert_eq!(workspaces.len(), 1);
        workspaces.into_iter().next().unwrap()
    }

    #[test]
    fn cleanup_failure_does_not_fail_published_instant_output() {
        for completed in [false, true] {
            let directory = playable_instant_project();
            let project = directory.path();
            let output = project.join("content/output.mp4");
            let before = recovery_snapshot(project).unwrap();
            let cleanup_attempted = Cell::new(false);
            let result = RecoveryManager::finalize_instant_output_with(
                &project.join("content/display"),
                &project.join("content/audio"),
                &output,
                completed.then(|| (project.to_path_buf(), false)),
                |source, destination| fs::rename(source, destination),
                |workspace| {
                    cleanup_attempted.set(true);
                    refuse_workspace_cleanup(workspace)
                },
            )
            .unwrap();

            assert_eq!(result, output);
            assert!(cleanup_attempted.get());
            validate_recovered_track(&output, ffmpeg::media::Type::Video).unwrap();
            assert!(
                !retained_workspace(project)
                    .join("content/output.mp4")
                    .exists()
            );
            let mut after = recovery_snapshot(project).unwrap();
            assert!(after.remove(Path::new("content/output.mp4")).is_some());
            assert_eq!(after, before);
        }
    }

    #[test]
    fn cleanup_failure_preserves_instant_validation_error() {
        for completed in [false, true] {
            let directory = playable_instant_project();
            let project = directory.path();
            let audio = project.join("content/audio");
            fs::create_dir(&audio).unwrap();
            let before = recovery_snapshot(project).unwrap();
            let output = project.join("content/output.mp4");
            let cleanup_attempted = Cell::new(false);
            let error = RecoveryManager::finalize_instant_output_with(
                &project.join("content/display"),
                &audio,
                &output,
                completed.then(|| (project.to_path_buf(), true)),
                |_, _| panic!("invalid recording must not reach publication"),
                |workspace| {
                    cleanup_attempted.set(true);
                    refuse_workspace_cleanup(workspace)
                },
            )
            .unwrap_err();

            assert!(cleanup_attempted.get());
            assert!(matches!(error, RecoveryError::Validation(message)
                if message == "Required Instant audio has no recoverable fragments"));
            assert!(!output.exists());
            assert!(retained_workspace(project).is_dir());
            assert_eq!(recovery_snapshot(project).unwrap(), before);
        }
    }

    #[test]
    fn cleanup_failure_preserves_instant_publication_error() {
        for completed in [false, true] {
            let directory = playable_instant_project();
            let project = directory.path();
            let output = project.join("content/output.mp4");
            let before = recovery_snapshot(project).unwrap();
            let publication_attempted = Cell::new(false);
            let cleanup_attempted = Cell::new(false);
            let error = RecoveryManager::finalize_instant_output_with(
                &project.join("content/display"),
                &project.join("content/audio"),
                &output,
                completed.then(|| (project.to_path_buf(), false)),
                |source, destination| {
                    assert_eq!(destination, output);
                    validate_recovered_track(source, ffmpeg::media::Type::Video).unwrap();
                    publication_attempted.set(true);
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "injected publication failure",
                    ))
                },
                |workspace| {
                    cleanup_attempted.set(true);
                    refuse_workspace_cleanup(workspace)
                },
            )
            .unwrap_err();

            assert!(publication_attempted.get());
            assert!(cleanup_attempted.get());
            assert!(matches!(error, RecoveryError::Io(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    && error.to_string() == "injected publication failure"));
            assert!(!output.exists());
            assert!(
                retained_workspace(project)
                    .join("content/output.mp4")
                    .is_file()
            );
            assert_eq!(recovery_snapshot(project).unwrap(), before);
        }
    }
}

#[cfg(test)]
mod clean_studio_snapshot_tests {
    use super::*;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
    use std::{cell::Cell, cell::RefCell, fs, io};

    fn wait_for_recovery_lock(project: &Path) -> RecoveryLock {
        let started = Instant::now();
        loop {
            match RecoveryLock::acquire(project) {
                Ok(lock) => return lock,
                Err(error) => {
                    assert!(started.elapsed() < Duration::from_secs(5), "{error}");
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    const DISPLAY: &str = "content/segments/segment-0/display";
    const FRAGMENT: &str = "content/segments/segment-0/display/segment_001.m4s";
    const OUTPUT: &str = "content/segments/segment-0/display.mp4";

    fn playable_studio_project(status: StudioRecordingStatus) -> tempfile::TempDir {
        studio_project_with_frames(status, 30, (0..60).map(|index| index * 1_000_000 / 30))
    }

    fn studio_project_with_frames(
        status: StudioRecordingStatus,
        frame_rate: u32,
        frame_times_us: impl IntoIterator<Item = u64>,
    ) -> tempfile::TempDir {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();
        let mut encoder = SegmentedVideoEncoder::init(
            project.join(DISPLAY),
            cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 320,
                height: 240,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(frame_rate as i32, 1),
            },
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_secs(1),
                ..Default::default()
            },
        )
        .unwrap();
        for (index, time_us) in frame_times_us.into_iter().enumerate() {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
            frame.data_mut(0).fill(32 + index as u8);
            frame.data_mut(1).fill(128);
            encoder
                .queue_frame(frame, Duration::from_micros(time_us))
                .unwrap();
        }
        encoder.finish().unwrap();
        drop(encoder);
        assert!(project.join(FRAGMENT).is_file());
        RecordingMeta {
            platform: None,
            project_path: project.to_path_buf(),
            pretty_name: "Snapshot finalization fixture".into(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: vec![MultipleSegment {
                        display: VideoMeta {
                            path: OUTPUT.into(),
                            fps: frame_rate,
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
        }
        .save_for_project()
        .unwrap();
        ProjectConfiguration::default().write(project).unwrap();
        fs::write(
            project.join("recording-diagnostics.json"),
            br#"{"version":2,"segments":[{"trackFailures":[]}]}"#,
        )
        .unwrap();
        directory
    }

    fn add_fragmented_audio(project: &Path, name: &str, blocks: i64) -> PathBuf {
        use cap_enc_ffmpeg::fragmented_audio::FragmentedAudioFile;
        use ffmpeg::{ChannelLayout, format::Sample, format::sample::Type};

        let path = project.join(format!("content/segments/segment-0/{name}.m4a"));
        let mut encoder = FragmentedAudioFile::init(
            path.clone(),
            cap_media_info::AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1),
        )
        .unwrap();
        for block in 0..blocks {
            let mut frame =
                ffmpeg::frame::Audio::new(Sample::F32(Type::Packed), 1024, ChannelLayout::MONO);
            frame.set_rate(48_000);
            frame.set_pts(Some(block * 1024));
            for (index, value) in frame.data_mut(0)[..4096].chunks_exact_mut(4).enumerate() {
                let position = (block * 1024) as f32 + index as f32;
                let sample = (position * std::f32::consts::TAU * 440.0 / 48_000.0).sin() * 0.25;
                value.copy_from_slice(&sample.to_ne_bytes());
            }
            encoder
                .queue_frame(
                    frame,
                    Duration::from_secs_f64(block as f64 * 1024.0 / 48_000.0),
                )
                .unwrap();
        }
        encoder.finish().unwrap().unwrap();
        path
    }

    fn respawn_only_studio_project() -> tempfile::TempDir {
        let directory = playable_studio_project(StudioRecordingStatus::InProgress);
        let project = directory.path();
        let display = project.join(DISPLAY);
        RecoveryManager::finalize_to_progressive_mp4(
            &display,
            &project.join("content/segments/segment-0/camera.mp4"),
        )
        .unwrap();
        let init = fs::read(display.join("init.mp4")).unwrap();
        let fragment = fs::read(project.join(FRAGMENT)).unwrap();
        let successful = project.join("successful-muxer");
        fs::rename(&display, &successful).unwrap();
        fs::create_dir(&display).unwrap();
        fs::write(display.join("init.mp4"), init).unwrap();
        fs::write(display.join("segment_001.m4s.tmp"), &fragment[..24]).unwrap();
        fs::write(
            display.join("manifest.json"),
            br#"{"version":5,"type":"m4s_segments","init_segment":"init.mp4","segments":[{"path":"segment_001.m4s","is_complete":false}]}"#,
        )
        .unwrap();
        fs::rename(successful, display.join("respawn-1")).unwrap();
        add_fragmented_audio(project, "audio-input", 94);
        directory
    }

    #[test]
    fn respawn_only_studio_recovery_preserves_video_camera_and_audio() {
        let directory = respawn_only_studio_project();
        let project = directory.path();
        let camera = project.join("content/segments/segment-0/camera.mp4");
        let packets = |path: &Path| {
            ffmpeg::format::input(path)
                .unwrap()
                .packets()
                .map(|(_, packet)| packet.data().unwrap().to_vec())
                .collect::<Vec<_>>()
        };
        let expected = packets(&camera);
        assert_eq!(expected.len(), 60);
        let audio = project.join("content/segments/segment-0/audio-input.m4a");
        let expected_audio = packets(&audio);
        assert!(!expected_audio.is_empty());
        let before = recovery_snapshot(project).unwrap();
        let recording = RecoveryManager::inspect_recording(project)
            .expect("Completed respawn footage must be offered for recovery");
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        let recovered = RecoveryManager::recover(&recording).unwrap();
        assert_eq!(packets(&project.join(OUTPUT)), expected);
        assert_eq!(packets(&camera), expected);
        assert_eq!(packets(&audio), expected_audio);
        assert!(valid_recovered_audio(&audio));
        assert!(matches!(
            recovered.meta.status(),
            StudioRecordingStatus::Complete
        ));
        let StudioRecordingMeta::MultipleSegments { inner } = recovered.meta else {
            panic!("Expected segmented Studio metadata");
        };
        assert!(inner.segments[0].camera.is_some());
        assert!(inner.segments[0].mic.is_some());
        ProjectConfiguration::load(project)
            .unwrap()
            .validate()
            .unwrap();
    }

    #[test]
    fn respawn_only_video_finalization_keeps_every_complete_packet() {
        let directory = respawn_only_studio_project();
        let project = directory.path();
        copy_recovery_input(
            &project.join(format!("{DISPLAY}/respawn-1")),
            &project.join(format!("{DISPLAY}/respawn-2")),
        )
        .unwrap();
        RecoveryManager::finalize_to_progressive_mp4(&project.join(DISPLAY), &project.join(OUTPUT))
            .expect("Completed respawn fragments must not require an initial complete fragment");
        validate_recovered_track(&project.join(OUTPUT), ffmpeg::media::Type::Video).unwrap();
        let packets = ffmpeg::format::input(&project.join(OUTPUT))
            .unwrap()
            .packets()
            .count();
        assert_eq!(packets, 120);
    }

    #[test]
    fn respawn_only_studio_recovery_salvages_complete_prefix_from_pending_tail() {
        let directory = respawn_only_studio_project();
        let project = directory.path();
        let fragment = project.join(format!("{DISPLAY}/respawn-1/segment_001.m4s"));
        let mut bytes = fs::read(&fragment).unwrap();
        bytes.extend_from_slice(b"\0\0\0\x20moof\0\0");
        fs::write(fragment.with_extension("m4s.tmp"), bytes).unwrap();
        fs::remove_file(fragment).unwrap();
        let manifest = project.join(format!("{DISPLAY}/respawn-1/manifest.json"));
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["segments"][0]["is_complete"] = false.into();
        fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        let before = recovery_snapshot(project).unwrap();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        RecoveryManager::recover(&recording).unwrap();
        validate_recovered_track(&project.join(OUTPUT), ffmpeg::media::Type::Video).unwrap();
        assert_eq!(
            ffmpeg::format::input(&project.join(OUTPUT))
                .unwrap()
                .packets()
                .count(),
            60
        );
    }

    #[test]
    fn corrupt_respawn_recovery_preserves_original_tracks() {
        let directory = respawn_only_studio_project();
        let project = directory.path();
        fs::write(
            project.join(format!("{DISPLAY}/respawn-1/init.mp4")),
            b"corrupt init",
        )
        .unwrap();
        let before = recovery_snapshot(project).unwrap();
        let recording = RecoveryManager::inspect_recording(project)
            .expect("Respawn fragments must be inspected before full validation");
        assert!(RecoveryManager::recover(&recording).is_err());
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        assert!(!project.join(OUTPUT).exists());
    }

    #[test]
    fn empty_orphan_segment_directory_recovers_every_real_frame() {
        let directory = playable_studio_project(StudioRecordingStatus::InProgress);
        let project = directory.path();
        fs::create_dir_all(project.join("content/segments/segment-1")).unwrap();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        assert_eq!(recording.recoverable_segments.len(), 1);
        let recovered = RecoveryManager::recover(&recording).unwrap();
        validate_recovered_track(&project.join(OUTPUT), ffmpeg::media::Type::Video).unwrap();
        assert_eq!(
            ffmpeg::format::input(&project.join(OUTPUT))
                .unwrap()
                .packets()
                .count(),
            60
        );
        let StudioRecordingMeta::MultipleSegments { inner } = recovered.meta else {
            panic!("Expected segmented Studio metadata");
        };
        assert_eq!(inner.segments.len(), 1);
    }

    fn completed_preparing_fixture(project: &Path) -> CompletedRecording {
        use crate::studio_recording::CleanStoppedStudio;

        let mut metadata = RecordingMeta::load_for_project(project).unwrap();
        let RecordingMetaInner::Studio(studio) = &mut metadata.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        inner.segments[0].display.path = DISPLAY.into();
        inner.segments[0].display.start_time = Some(0.0);
        let configuration = ProjectConfiguration {
            timeline: Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [{"recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 2.0}],
                    "zoomSegments": []
                }))
                .unwrap(),
            ),
            ..ProjectConfiguration::default()
        };
        metadata.save_for_project().unwrap();
        configuration.write(project).unwrap();
        CompletedRecording {
            project_path: project.to_path_buf(),
            meta: metadata.studio_meta().unwrap().clone(),
            cursor_data: Default::default(),
            clean_stopped: CleanStoppedStudio::for_test(metadata, configuration),
        }
    }

    enum PreparingEntryCase {
        Supported,
        EditedConfiguration,
        EditedMetadata,
        WrongStoppedProject,
        StaleAnalysis,
        RequiredTrackFailure,
        HeldRecoveryLock,
    }

    fn assert_preparing_entry_point_matches_ordinary(case: PreparingEntryCase) {
        use super::preparing_observer::PreparingStudioTestTransition;

        let candidate = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let completed = completed_preparing_fixture(candidate.path());
        let ordinary = tempfile::tempdir().unwrap();
        for entry in fs::read_dir(candidate.path()).unwrap() {
            let entry = entry.unwrap();
            copy_recovery_input(&entry.path(), &ordinary.path().join(entry.file_name())).unwrap();
        }
        assert_eq!(
            recovery_snapshot(candidate.path()).unwrap(),
            recovery_snapshot(ordinary.path()).unwrap()
        );
        let mut candidate_recording = RecoveryManager::inspect_recording(candidate.path()).unwrap();
        let mut ordinary_recording = RecoveryManager::inspect_recording(ordinary.path()).unwrap();
        let alternate = tempfile::tempdir().unwrap();
        let (job, observer) = if matches!(case, PreparingEntryCase::WrongStoppedProject) {
            let mut metadata = RecordingMeta::load_for_project(candidate.path()).unwrap();
            metadata.project_path = alternate.path().to_path_buf();
            let configuration = ProjectConfiguration::load(candidate.path()).unwrap();
            let alternate_completed = CompletedRecording {
                project_path: alternate.path().to_path_buf(),
                meta: metadata.studio_meta().unwrap().clone(),
                cursor_data: Default::default(),
                clean_stopped: crate::studio_recording::CleanStoppedStudio::for_test(
                    metadata,
                    configuration,
                ),
            };
            PreparingStudioJob::claim(&alternate_completed, 73).unwrap()
        } else {
            PreparingStudioJob::claim(&completed, 72).unwrap()
        };
        match case {
            PreparingEntryCase::Supported
            | PreparingEntryCase::WrongStoppedProject
            | PreparingEntryCase::HeldRecoveryLock => {}
            PreparingEntryCase::EditedConfiguration => {
                for path in [candidate.path(), ordinary.path()] {
                    let mut configuration = ProjectConfiguration::load(path).unwrap();
                    configuration.timeline.as_mut().unwrap().segments[0].name =
                        Some("Edited after Stop".into());
                    configuration.write(path).unwrap();
                }
            }
            PreparingEntryCase::EditedMetadata => {
                for path in [candidate.path(), ordinary.path()] {
                    let mut metadata = RecordingMeta::load_for_project(path).unwrap();
                    metadata.pretty_name.push_str(" edited after Stop");
                    metadata.save_for_project().unwrap();
                }
                candidate_recording = RecoveryManager::inspect_recording(candidate.path()).unwrap();
                ordinary_recording = RecoveryManager::inspect_recording(ordinary.path()).unwrap();
            }
            PreparingEntryCase::StaleAnalysis => {
                candidate_recording.meta.pretty_name.push_str(" stale");
                ordinary_recording.meta.pretty_name.push_str(" stale");
            }
            PreparingEntryCase::RequiredTrackFailure => {
                for path in [candidate.path(), ordinary.path()] {
                    fs::write(
                        path.join("recording-diagnostics.json"),
                        br#"{"version":2,"segments":[{"trackFailures":[{"track":"display","reason":"injected requested track failure"}]}]}"#,
                    )
                    .unwrap();
                }
            }
        }
        let candidate_before = recovery_snapshot(candidate.path()).unwrap();
        let ordinary_before = recovery_snapshot(ordinary.path()).unwrap();
        let transitions = job.test_transitions();
        let held_locks = matches!(case, PreparingEntryCase::HeldRecoveryLock).then(|| {
            (
                RecoveryLock::acquire(candidate.path()).unwrap(),
                RecoveryLock::acquire(ordinary.path()).unwrap(),
            )
        });
        let expected = RecoveryManager::finalize(&ordinary_recording)
            .map(|recording| serde_json::to_value(recording.meta).unwrap())
            .map_err(|error| error.to_string());
        let actual = RecoveryManager::finalize_with_preparing(&candidate_recording, job)
            .map(|recording| serde_json::to_value(recording.meta).unwrap())
            .map_err(|error| error.to_string());
        assert_eq!(actual, expected);
        assert_eq!(
            observer.publication_succeeded(),
            matches!(case, PreparingEntryCase::Supported) && actual.is_ok()
        );
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        let expected_transitions = match case {
            PreparingEntryCase::Supported => vec![
                PreparingStudioTestTransition::Available,
                PreparingStudioTestTransition::Ended,
            ],
            PreparingEntryCase::EditedConfiguration => vec![
                PreparingStudioTestTransition::Unavailable(
                    "Persisted stopped configuration changed".into(),
                ),
                PreparingStudioTestTransition::Ended,
            ],
            PreparingEntryCase::EditedMetadata | PreparingEntryCase::WrongStoppedProject => vec![
                PreparingStudioTestTransition::Unavailable(
                    "Stopped recording identity or metadata changed".into(),
                ),
                PreparingStudioTestTransition::Ended,
            ],
            PreparingEntryCase::StaleAnalysis
            | PreparingEntryCase::RequiredTrackFailure
            | PreparingEntryCase::HeldRecoveryLock => vec![PreparingStudioTestTransition::Ended],
        };
        assert_eq!(*transitions.lock().unwrap(), expected_transitions);
        drop(held_locks);
        drop(wait_for_recovery_lock(candidate.path()));
        assert!(RecoveryLock::acquire(ordinary.path()).is_ok());
        if matches!(
            case,
            PreparingEntryCase::StaleAnalysis
                | PreparingEntryCase::RequiredTrackFailure
                | PreparingEntryCase::HeldRecoveryLock
        ) {
            assert!(actual.is_err());
            assert_eq!(
                recovery_snapshot(candidate.path()).unwrap(),
                candidate_before
            );
            assert_eq!(recovery_snapshot(ordinary.path()).unwrap(), ordinary_before);
            assert!(!candidate.path().join(OUTPUT).exists());
            assert!(!ordinary.path().join(OUTPUT).exists());
        } else {
            assert!(actual.is_ok());
            assert_eq!(
                recovery_snapshot(candidate.path()).unwrap(),
                recovery_snapshot(ordinary.path()).unwrap()
            );
            assert_eq!(
                fs::read(candidate.path().join(OUTPUT)).unwrap(),
                fs::read(ordinary.path().join(OUTPUT)).unwrap()
            );
            assert!(probe_video_can_decode(&candidate.path().join(OUTPUT)).unwrap());
        }
    }

    #[test]
    fn inspected_preparing_finalization_matches_ordinary_outputs_and_metadata() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::Supported);
    }

    #[test]
    fn preparing_retirement_preserves_every_encoded_video_packet() {
        fn packets(path: &Path) -> Vec<Vec<u8>> {
            let mut input = ffmpeg::format::input(path).unwrap();
            let video = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .unwrap()
                .index();
            input
                .packets()
                .filter_map(|(stream, packet)| {
                    (stream.index() == video).then(|| packet.data().unwrap().to_vec())
                })
                .collect()
        }

        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let completed = completed_preparing_fixture(project);
        let (job, observer) = PreparingStudioJob::claim(&completed, 42).unwrap();
        let metadata = RecordingMeta::load_for_project(project).unwrap();
        let recording = RecoveryManager::analyze_incomplete(project, &metadata).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let original = scratch.path().join("original.mp4");
        let mut joined = fs::File::create(&original).unwrap();
        let segment = &recording.recoverable_segments[0];
        for path in segment
            .display_init_segment
            .iter()
            .chain(&segment.display_fragments)
        {
            std::io::copy(&mut fs::File::open(path).unwrap(), &mut joined).unwrap();
        }
        drop(joined);
        let expected = packets(&original);
        assert_eq!(expected.len(), 60);
        RecoveryManager::finalize_with_preparing(&recording, job).unwrap();
        assert!(observer.publication_succeeded());
        drop(observer);
        drop(wait_for_recovery_lock(project));
        assert_eq!(packets(&project.join(OUTPUT)), expected);
        let workspaces: Vec<_> = fs::read_dir(project)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".recovery-")
            })
            .collect();
        assert_eq!(workspaces.len(), 1);
        assert!(!workspaces[0].path().join("original-segments").exists());
        assert!(matches!(
            RecordingMeta::load_for_project(project)
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Complete
        ));
    }

    #[test]
    fn inspected_preparing_finalization_matches_ordinary_configuration_behavior_after_edits() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::EditedConfiguration);
    }

    #[test]
    fn inspected_preparing_finalization_preserves_fresh_metadata_edits_and_declines_preview() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::EditedMetadata);
    }

    #[test]
    fn inspected_preparing_finalization_preserves_recovery_lock_contention_without_writes() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::HeldRecoveryLock);
    }

    #[test]
    fn inspected_preparing_finalization_declines_a_different_stopped_project() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::WrongStoppedProject);
    }

    #[test]
    fn inspected_preparing_finalization_rejects_stale_analysis_without_writes() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::StaleAnalysis);
    }

    #[test]
    fn inspected_preparing_finalization_preserves_requested_track_failure() {
        assert_preparing_entry_point_matches_ordinary(PreparingEntryCase::RequiredTrackFailure);
    }

    #[test]
    fn preparing_finalizer_revokes_sources_and_retains_lock_until_last_reader_closes() {
        use std::io::Read;

        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let completed = completed_preparing_fixture(project);
        let (job, observer) = PreparingStudioJob::claim(&completed, 42).unwrap();
        let metadata = RecordingMeta::load_for_project(project).unwrap();
        let recording = RecoveryManager::analyze_incomplete(project, &metadata).unwrap();
        let mut retained = None;
        RecoveryManager::finalize_with_publication(
            &recording,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |_, _| {
                let sources = match observer.latest() {
                    PreparingStudioState::Available(sources) => sources,
                    PreparingStudioState::Unavailable(reason) => panic!("{reason}"),
                    _ => panic!("Expected preparing sources before publication"),
                };
                let live = sources.live().unwrap();
                let video = live.video(0, PreparingVideoTrack::Display).unwrap();
                let (source, paths) = video.input().unwrap();
                let expected = fs::read(project.join("content/segments").join(&paths[0]))?;
                let mut reader = source.reader(&paths[0])?;
                let mut header = [0; 8];
                reader.read_exact(&mut header)?;
                assert_eq!(&header, &expected[..8]);
                retained = Some((sources.clone(), reader, expected));
                Ok(())
            },
            publish_recovery,
            RecoveryLock::acquire,
            Some(job),
        )
        .unwrap();
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        let (sources, mut reader, expected) = retained.unwrap();
        assert!(sources.live().is_none());
        assert!(RecoveryLock::acquire(project).is_err());
        drop(sources);
        drop(observer);
        assert!(RecoveryLock::acquire(project).is_err());
        let mut remaining = Vec::new();
        reader.read_to_end(&mut remaining).unwrap();
        assert_eq!(remaining, expected[8..]);
        drop(reader);
        drop(wait_for_recovery_lock(project));
        let finalized = RecordingMeta::load_for_project(project).unwrap();
        assert!(matches!(
            finalized.studio_meta().unwrap().status(),
            StudioRecordingStatus::Complete
        ));
    }

    #[test]
    fn preparing_config_drift_declines_preview_without_failing_finalization() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let completed = completed_preparing_fixture(project);
        let (job, observer) = PreparingStudioJob::claim(&completed, 7).unwrap();
        let mut configuration = ProjectConfiguration::load(project).unwrap();
        configuration.timeline.as_mut().unwrap().segments[0].name = Some("Changed".into());
        configuration.write(project).unwrap();
        let metadata = RecordingMeta::load_for_project(project).unwrap();
        let recording = RecoveryManager::analyze_incomplete(project, &metadata).unwrap();
        RecoveryManager::finalize_with_publication(
            &recording,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |_, _| {
                assert!(matches!(
                    observer.latest(),
                    PreparingStudioState::Unavailable(_)
                ));
                Ok(())
            },
            publish_recovery,
            RecoveryLock::acquire,
            Some(job),
        )
        .unwrap();
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        assert!(project.join(OUTPUT).is_file());
        assert!(RecoveryLock::acquire(project).is_ok());
    }

    #[test]
    fn preparing_finalizer_panic_revokes_capability_without_unlocking_live_reader() {
        use std::io::Read;

        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let completed = completed_preparing_fixture(project);
        let (job, observer) = PreparingStudioJob::claim(&completed, 8).unwrap();
        let metadata = RecordingMeta::load_for_project(project).unwrap();
        let recording = RecoveryManager::analyze_incomplete(project, &metadata).unwrap();
        let before = recovery_snapshot(project).unwrap();
        let mut retained = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            RecoveryManager::finalize_with_publication(
                &recording,
                RecoveryPurpose::Finalize,
                copy_recovery_input_with_durability,
                |_, _| {
                    let sources = match observer.latest() {
                        PreparingStudioState::Available(sources) => sources,
                        PreparingStudioState::Unavailable(reason) => panic!("{reason}"),
                        _ => panic!("Expected preparing sources before injected failure"),
                    };
                    let live = sources.live().unwrap();
                    let video = live.video(0, PreparingVideoTrack::Display).unwrap();
                    let (source, paths) = video.input().unwrap();
                    let mut reader = source.reader(&paths[0])?;
                    let mut header = [0; 8];
                    reader.read_exact(&mut header)?;
                    retained = Some((sources.clone(), reader));
                    panic!("Injected finalizer interruption after source publication");
                },
                publish_recovery,
                RecoveryLock::acquire,
                Some(job),
            )
        }));
        assert!(result.is_err());
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        let (sources, reader) = retained.unwrap();
        assert!(sources.live().is_none());
        drop(sources);
        assert!(RecoveryLock::acquire(project).is_err());
        drop(reader);
        assert!(RecoveryLock::acquire(project).is_ok());
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        assert!(project.join(DISPLAY).is_dir());
        assert!(!project.join(OUTPUT).exists());
    }

    #[test]
    fn preparing_drifted_completion_uses_ordinary_success_path() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let mut completed = completed_preparing_fixture(project);
        let (job, observer) = PreparingStudioJob::claim(&completed, 9).unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = &mut completed.meta else {
            panic!()
        };
        inner.segments[0].display.fps = 60;
        assert!(RecoveryManager::remux_stopped_with_preparing(&completed, job).unwrap());
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        assert!(project.join(OUTPUT).is_file());
        assert!(RecoveryLock::acquire(project).is_ok());
    }

    #[test]
    fn a_stop_without_a_preparing_editor_retires_the_original_media_backup() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();

        assert!(RecoveryManager::remux_if_needed(project).unwrap());

        let workspaces: Vec<_> = fs::read_dir(project)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".recovery-")
            })
            .collect();
        assert_eq!(workspaces.len(), 1);
        assert!(!workspaces[0].join("original-segments").exists());
        let meta = RecordingMeta::load_for_project(project).unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
            panic!()
        };
        let display = meta.path(&inner.segments[0].display.path);
        assert!(cap_enc_ffmpeg::remux::get_video_fps(&display).is_some());
    }

    #[test]
    fn studio_finalization_keeps_the_recorded_display_fps() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let mut meta = RecordingMeta::load_for_project(project).unwrap();
        let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        inner.segments[0].display.fps = 120;
        meta.save_for_project().unwrap();

        assert!(RecoveryManager::remux_if_needed(project).unwrap());
        let meta = RecordingMeta::load_for_project(project).unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
            panic!()
        };
        let display = meta.path(&inner.segments[0].display.path);
        assert_ne!(cap_enc_ffmpeg::remux::get_video_fps(&display), Some(120));
        assert_eq!(inner.segments[0].display.fps, 120);
    }

    #[test]
    fn studio_finalization_without_a_recorded_fps_uses_the_base_rate_not_the_average() {
        // A 60 fps capture of a mostly static screen: short bursts on the
        // 60 fps grid between long holds, averaging well under 60 fps.
        let times = (0..4u64)
            .flat_map(|burst| (0..6u64).map(move |k| burst * 500_000 + k * 1_000_000 / 60));
        let directory = studio_project_with_frames(StudioRecordingStatus::NeedsRemux, 60, times);
        let project = directory.path();
        let mut meta = RecordingMeta::load_for_project(project).unwrap();
        let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        inner.segments[0].display.fps = 0;
        meta.save_for_project().unwrap();

        assert!(RecoveryManager::remux_if_needed(project).unwrap());
        let meta = RecordingMeta::load_for_project(project).unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
            panic!()
        };
        let display = meta.path(&inner.segments[0].display.path);
        let average = cap_enc_ffmpeg::remux::get_video_fps(&display).unwrap();
        assert!(average < 30, "fixture averages {average} fps");
        assert_eq!(inner.segments[0].display.fps, 60);
    }

    #[test]
    fn studio_finalization_preserves_encoded_audio_samples_and_offsets() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let microphone = add_fragmented_audio(project, "audio-input", 90);
        let system_audio = add_fragmented_audio(project, "system_audio", 90);
        let original_audio = cap_audio::AudioData::from_file(&microphone).unwrap();
        let mut meta = RecordingMeta::load_for_project(project).unwrap();
        let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        inner.segments[0].mic = Some(AudioMeta {
            path: "content/segments/segment-0/audio-input.m4a".into(),
            start_time: Some(-0.125),
            device_id: Some("benchmark microphone".into()),
            gap_summary: None,
            digital_silence_ms: Some(190_000),
        });
        inner.segments[0].system_audio = Some(AudioMeta {
            path: "content/segments/segment-0/system_audio.m4a".into(),
            start_time: Some(0.25),
            device_id: None,
            gap_summary: None,
            digital_silence_ms: None,
        });
        meta.save_for_project().unwrap();

        assert!(RecoveryManager::remux_if_needed(project).unwrap());
        let meta = RecordingMeta::load_for_project(project).unwrap();
        let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
            panic!()
        };
        let segment = &inner.segments[0];
        let mic = segment.mic.as_ref().unwrap();
        assert_eq!(
            mic.path.as_str(),
            "content/segments/segment-0/audio-input.m4a"
        );
        assert_eq!(mic.start_time, Some(-0.125));
        assert_eq!(mic.device_id.as_deref(), Some("benchmark microphone"));
        assert_eq!(mic.digital_silence_ms, Some(190_000));
        assert_eq!(
            segment.system_audio.as_ref().unwrap().start_time,
            Some(0.25)
        );
        for path in [&microphone, &system_audio] {
            let audio = cap_audio::AudioData::from_file(path).unwrap();
            assert_eq!(audio.channels(), original_audio.channels());
            assert_eq!(audio.samples(), original_audio.samples());
        }
        let backup = fs::read_dir(project)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".recovery-")
            })
            .unwrap();
        // A stop without a preparing editor retires the original backup once
        // the published tracks above are in place.
        assert!(!backup.join("original-segments").exists());
    }

    #[test]
    fn studio_finalization_preserves_a_live_managed_audio_decoder() {
        use cap_audio::{AudioStream, ChunkRead};
        use std::sync::{Arc, atomic::AtomicBool};

        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let microphone = add_fragmented_audio(project, "audio-input", 2880);
        assert!(microphone.metadata().unwrap().len() > 4 * 64 * 1024);
        let original_audio = cap_audio::AudioData::from_file(&microphone).unwrap();
        let mut meta = RecordingMeta::load_for_project(project).unwrap();
        let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        inner.segments[0].mic = Some(AudioMeta {
            path: "content/segments/segment-0/audio-input.m4a".into(),
            start_time: Some(-0.125),
            device_id: None,
            gap_summary: None,
            digital_silence_ms: None,
        });
        meta.save_for_project().unwrap();
        let recording = RecoveryManager::analyze_incomplete(project, &meta).unwrap();
        let source = RelocatableSource::new(project.join("content/segments")).unwrap();
        let mut audio = AudioStream::open_relocatable(
            &source,
            [Path::new("segment-0/audio-input.m4a")],
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let ChunkRead::Chunk(prefix) = audio.read_chunk(4096).unwrap() else {
            panic!()
        };
        assert_eq!(prefix.source_start_sample, 0);
        let mut decoded = prefix.samples;
        let recovered =
            RecoveryManager::finalize_with_relocatable_source(&recording, &source).unwrap();
        assert_eq!(recovered.project_path, project);
        loop {
            match audio.read_chunk(4096).unwrap() {
                ChunkRead::Chunk(chunk) => {
                    assert_eq!(
                        chunk.source_start_sample as usize,
                        decoded.len() / usize::from(original_audio.channels())
                    );
                    assert_eq!(chunk.channels, original_audio.channels());
                    decoded.extend(chunk.samples);
                }
                ChunkRead::Eof { next_sample } => {
                    assert_eq!(
                        next_sample as usize,
                        decoded.len() / usize::from(original_audio.channels())
                    );
                    break;
                }
            }
        }
        let expected = original_audio
            .samples()
            .iter()
            .map(|sample| sample.to_bits());
        assert!(decoded.iter().map(|sample| sample.to_bits()).eq(expected));
        let finalized = cap_audio::AudioData::from_file(&microphone).unwrap();
        assert!(
            finalized
                .samples()
                .iter()
                .map(|sample| sample.to_bits())
                .eq(original_audio
                    .samples()
                    .iter()
                    .map(|sample| sample.to_bits()))
        );
        let persisted = RecordingMeta::load_for_project(project).unwrap();
        assert_eq!(
            serde_json::to_value(persisted.studio_meta()).unwrap(),
            serde_json::to_value(&recovered.meta).unwrap()
        );
    }

    #[test]
    fn recovery_copies_have_independent_bytes_and_preserve_existing_destinations() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("destination");
        fs::write(&source, b"original recording").unwrap();
        copy_recovery_input(&source, &destination).unwrap();
        fs::write(&destination, b"staged recording").unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original recording");
        assert!(copy_recovery_input(&source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"staged recording");
    }

    fn change_fragment_bytes(project: &Path) {
        let path = project.join(FRAGMENT);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&path, bytes).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
    }

    fn assert_unpublished(project: &Path) {
        assert!(project.join(DISPLAY).is_dir());
        assert!(!project.join(OUTPUT).exists());
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
        assert!(fs::read_dir(project).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".recovery-")
        }));
    }

    fn assert_staged_output(staged: &Path) {
        validate_recovered_track(&staged.join(OUTPUT), ffmpeg::media::Type::Video).unwrap();
        assert!(matches!(
            RecordingMeta::load_for_project(staged)
                .unwrap()
                .studio_meta()
                .unwrap()
                .status(),
            StudioRecordingStatus::Complete
        ));
    }

    #[derive(Clone, Copy)]
    enum SourceChange {
        FragmentBytes,
        AddedSegment,
        RemovedFragment,
    }

    impl SourceChange {
        fn apply(self, project: &Path) {
            match self {
                Self::FragmentBytes => change_fragment_bytes(project),
                Self::AddedSegment => {
                    fs::create_dir(project.join("content/segments/segment-1")).unwrap();
                }
                Self::RemovedFragment => fs::remove_file(project.join(FRAGMENT)).unwrap(),
            }
        }
    }

    fn check_persistent_source_changes(during_copy: bool) {
        for change in [
            SourceChange::FragmentBytes,
            SourceChange::AddedSegment,
            SourceChange::RemovedFragment,
        ] {
            let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
            let project = directory.path();
            let recording = RecoveryManager::inspect_recording(project).unwrap();
            let expected = RefCell::new(None);
            let reached_final_check = Cell::new(false);
            let error = RecoveryManager::finalize_with_operations(
                &recording,
                RecoveryPurpose::Finalize,
                |source, destination, durability| {
                    copy_recovery_input_with_durability(source, destination, durability)?;
                    if during_copy && source == project.join("content") {
                        change.apply(project);
                        *expected.borrow_mut() = Some(recovery_snapshot(project)?);
                    }
                    Ok(())
                },
                |source, staged| {
                    assert_staged_output(staged);
                    reached_final_check.set(true);
                    if !during_copy {
                        change.apply(source);
                        *expected.borrow_mut() = Some(recovery_snapshot(source)?);
                    }
                    Ok(())
                },
            )
            .unwrap_err();
            assert!(matches!(error, RecoveryError::Validation(message)
                if message == "Recording changed before publication"));
            assert!(reached_final_check.get());
            assert_eq!(
                recovery_snapshot(project).unwrap(),
                expected.into_inner().unwrap()
            );
            assert_unpublished(project);
        }
    }

    #[test]
    fn persistent_source_changes_during_copy_cannot_publish() {
        check_persistent_source_changes(true);
    }

    #[test]
    fn persistent_source_changes_before_publication_cannot_publish() {
        check_persistent_source_changes(false);
    }

    #[test]
    fn failed_copy_preserves_originals_and_removes_partial_stage() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        let before = recovery_snapshot(project).unwrap();
        let error = RecoveryManager::finalize_with_operations(
            &recording,
            RecoveryPurpose::Finalize,
            |source, destination, _| {
                assert_eq!(source, project.join("content"));
                fs::create_dir(destination)?;
                fs::write(destination.join("partial.m4s"), b"partial copy")?;
                Err(io::Error::other("injected copy failure").into())
            },
            |_, _| panic!("failed copy must not reach the final source check"),
        )
        .unwrap_err();
        assert!(matches!(error, RecoveryError::Io(error)
            if error.to_string() == "injected copy failure"));
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        assert_unpublished(project);
    }

    #[test]
    fn independently_changed_staged_bytes_cannot_publish() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        let before = recovery_snapshot(project).unwrap();
        let error = RecoveryManager::finalize_with_operations(
            &recording,
            RecoveryPurpose::Finalize,
            |source, destination, durability| {
                copy_recovery_input_with_durability(source, destination, durability)?;
                if source == project.join("content") {
                    change_fragment_bytes(destination.parent().unwrap());
                }
                Ok(())
            },
            |_, _| panic!("changed staged bytes must not reach the final source check"),
        )
        .unwrap_err();
        assert!(matches!(error, RecoveryError::Validation(message)
            if message == "Recording changed while copying"));
        assert_eq!(recovery_snapshot(project).unwrap(), before);
        assert_unpublished(project);
    }

    #[test]
    fn late_required_track_failure_preserves_originals_without_publication() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        let expected = RefCell::new(None);
        let error = RecoveryManager::finalize_with_operations(
            &recording,
            RecoveryPurpose::Finalize,
            copy_recovery_input_with_durability,
            |source, staged| {
                assert_staged_output(staged);
                fs::write(
                    source.join("recording-diagnostics.json"),
                    br#"{"version":2,"segments":[{"trackFailures":[{"track":"display","stage":"stop","error":"injected late failure"}]}]}"#,
                )?;
                *expected.borrow_mut() = Some(recovery_snapshot(source)?);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(matches!(error, RecoveryError::RequiredTrackFailure(_)));
        assert_eq!(
            recovery_snapshot(project).unwrap(),
            expected.into_inner().unwrap()
        );
        assert_unpublished(project);
    }

    #[test]
    fn clean_finalization_accepts_source_restored_identically_before_publication() {
        let directory = playable_studio_project(StudioRecordingStatus::NeedsRemux);
        let project = directory.path();
        let recording = RecoveryManager::inspect_recording(project).unwrap();
        let before = recovery_snapshot(project).unwrap();
        let raw = fs::read(project.join(FRAGMENT)).unwrap();
        let reached_final_check = Cell::new(false);
        RecoveryManager::finalize_with_operations(
            &recording,
            RecoveryPurpose::Finalize,
            |source, destination, durability| {
                copy_recovery_input_with_durability(source, destination, durability)?;
                if source == project.join("content") {
                    change_fragment_bytes(project);
                }
                Ok(())
            },
            |source, staged| {
                assert_staged_output(staged);
                assert_ne!(recovery_snapshot(source)?, before);
                fs::write(source.join(FRAGMENT), &raw)?;
                assert_eq!(recovery_snapshot(source)?, before);
                reached_final_check.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(reached_final_check.get());
        assert_staged_output(project);
        let workspace = fs::read_dir(project)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.join("original-segments").is_dir())
            .unwrap();
        for (path, digest) in before {
            let backup = if let Ok(relative) = path.strip_prefix("content/segments") {
                workspace.join("original-segments").join(relative)
            } else {
                continue;
            };
            if let Some(digest) = digest {
                assert_eq!(
                    blake3::hash(&fs::read(backup).unwrap())
                        .as_bytes()
                        .as_slice(),
                    digest
                );
            } else {
                assert!(backup.is_dir());
            }
        }
    }

    #[test]
    fn full_validation_keeps_early_source_change_rejection() {
        for (purpose, status) in [
            (RecoveryPurpose::Recover, StudioRecordingStatus::NeedsRemux),
            (RecoveryPurpose::Finalize, StudioRecordingStatus::InProgress),
        ] {
            let directory = playable_studio_project(status);
            let project = directory.path();
            let recording = RecoveryManager::inspect_recording(project).unwrap();
            let expected = RefCell::new(None);
            let error = RecoveryManager::finalize_with_operations(
                &recording,
                purpose,
                |source, destination, durability| {
                    copy_recovery_input_with_durability(source, destination, durability)?;
                    if source == project.join("content") {
                        change_fragment_bytes(project);
                        *expected.borrow_mut() = Some(recovery_snapshot(project)?);
                    }
                    Ok(())
                },
                |_, _| panic!("full validation must reject before source restoration is possible"),
            )
            .unwrap_err();
            assert!(matches!(error, RecoveryError::Validation(message)
                if message == "Recording changed while copying"));
            assert_eq!(
                recovery_snapshot(project).unwrap(),
                expected.into_inner().unwrap()
            );
            assert_unpublished(project);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RecoveryManager, RecoveryPurpose, StudioRecordingStatus, VideoValidation, replace_file,
        start_time_or_display_fallback, valid_recovered_audio, validate_recovered_audio_in_order,
        validate_recovery_track,
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

    #[test]
    fn completed_instant_audio_requirement_preserves_inputs_when_audio_is_missing() {
        let directory = tempdir().unwrap();
        let project = directory.path();
        let display = project.join("content/display");
        fs::create_dir_all(&display).unwrap();
        fs::write(display.join("init.mp4"), b"original video init").unwrap();
        let output = project.join("content/output.mp4");
        fs::write(&output, b"original output").unwrap();
        let before = super::recovery_snapshot(project).unwrap();

        let error = RecoveryManager::finalize_instant_output_with_completion(
            &display,
            &project.join("content/audio"),
            &output,
            Some((project.to_path_buf(), true)),
        )
        .unwrap_err();

        assert!(error.to_string().contains("Missing required Instant audio"));
        assert_eq!(super::recovery_snapshot(project).unwrap(), before);
        assert!(fs::read_dir(project).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".recovery-")
        }));
    }

    #[test]
    fn completed_instant_rejects_other_paths_in_the_same_project_without_mutation() {
        let directory = tempdir().unwrap();
        let project = directory.path();
        let content = project.join("content");
        fs::create_dir(&content).unwrap();
        fs::write(content.join("original.mp4"), b"original output").unwrap();
        let before = super::recovery_snapshot(project).unwrap();

        for (display, audio, output) in [
            ("other", "audio", "output.mp4"),
            ("display", "other", "output.mp4"),
            ("display", "audio", "original.mp4"),
        ] {
            let error = RecoveryManager::finalize_instant_output_with_completion(
                &content.join(display),
                &content.join(audio),
                &content.join(output),
                Some((project.to_path_buf(), false)),
            )
            .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("must use the recorded track and output paths")
            );
            assert_eq!(super::recovery_snapshot(project).unwrap(), before);
            assert_eq!(fs::read_dir(project).unwrap().count(), 1);
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
    fn recovery_keeps_a_completed_fragment_listed_pending_after_an_earlier_valid_fragment() {
        let dir = tempdir().unwrap();
        let fragment = complete_m4s_fragment();
        fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
        for name in ["segment_001.m4s", "segment_002.m4s"] {
            fs::write(dir.path().join(name), &fragment).unwrap();
        }
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 5,
            "type": "m4s_segments",
            "init_segment": "init.mp4",
            "segments": [
                {"path": "segment_001.m4s", "is_complete": true, "file_size": fragment.len()},
                {"path": "segment_002.m4s", "is_complete": false, "file_size": null}
            ]
        }))
        .unwrap();
        fs::write(dir.path().join("manifest.json"), manifest).unwrap();
        let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());
        assert_eq!(
            recovered.fragments,
            ["segment_001.m4s", "segment_002.m4s"].map(|name| dir.path().join(name))
        );
    }

    #[test]
    fn recovery_still_rejects_pending_and_mismatched_fragments_that_are_not_complete() {
        let dir = tempdir().unwrap();
        let fragment = complete_m4s_fragment();
        fs::write(dir.path().join("init.mp4"), [0; 128]).unwrap();
        fs::write(dir.path().join("segment_001.m4s"), &fragment).unwrap();
        fs::write(dir.path().join("segment_002.m4s"), &fragment).unwrap();
        fs::write(
            dir.path().join("segment_003.m4s"),
            &fragment[..fragment.len() - 1],
        )
        .unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 5,
            "type": "m4s_segments",
            "init_segment": "init.mp4",
            "segments": [
                {"path": "segment_001.m4s", "is_complete": true, "file_size": fragment.len()},
                {"path": "segment_002.m4s", "is_complete": true, "file_size": fragment.len() + 1},
                {"path": "segment_003.m4s", "is_complete": false, "file_size": null}
            ]
        }))
        .unwrap();
        fs::write(dir.path().join("manifest.json"), manifest).unwrap();
        let recovered = RecoveryManager::find_complete_fragments_with_init(dir.path());
        assert_eq!(recovered.fragments, [dir.path().join("segment_001.m4s")]);
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
    fn parallel_audio_validation_reports_the_first_failure_in_track_order() {
        let dir = tempdir().unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&68u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8000u32.to_le_bytes());
        bytes.extend_from_slice(&16000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&32u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 32]);
        let tracks = ["valid-0", "missing-1", "valid-2", "missing-3", "missing-4"]
            .map(|name| dir.path().join(format!("{name}.wav")));
        for path in tracks
            .iter()
            .filter(|path| path.to_string_lossy().contains("valid-"))
        {
            fs::write(path, &bytes).unwrap();
        }
        let tracks = tracks.iter().collect::<Vec<_>>();

        for _ in 0..16 {
            let error = validate_recovered_audio_in_order(&tracks)
                .unwrap_err()
                .to_string();
            assert!(error.contains("missing-1.wav"), "{error}");
        }
        assert!(validate_recovered_audio_in_order(&[tracks[0], tracks[2]]).is_ok());
        assert!(validate_recovered_audio_in_order(&[]).is_ok());
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
mod empty_orphan_segment_tests {
    use super::*;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};

    /// Encode a short fragmented video track so the segment passes the same
    /// media probes a real recording does.
    fn write_fragmented_track(segment_path: &Path, track: &str) {
        ffmpeg::init().unwrap();
        std::fs::create_dir_all(segment_path).unwrap();

        let mut encoder = SegmentedVideoEncoder::init(
            segment_path.join(track),
            cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 320,
                height: 240,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            },
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_secs(1),
                ..Default::default()
            },
        )
        .unwrap();

        for index in 0..60 {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
            frame.data_mut(0).fill(32 + index as u8);
            frame.data_mut(1).fill(128);
            encoder
                .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
                .unwrap();
        }

        encoder.finish().unwrap();
        assert!(!encoder.completed_segments().is_empty());
    }

    fn write_recording_meta(project: &Path, segment_count: usize) {
        let segments = (0..segment_count)
            .map(|index| MultipleSegment {
                display: VideoMeta {
                    path: RelativePathBuf::from(format!(
                        "content/segments/segment-{index}/display.mp4"
                    )),
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
            })
            .collect();

        let meta = RecordingMeta {
            platform: None,
            project_path: project.to_path_buf(),
            pretty_name: "Test Recording".to_string(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments,
                    cursors: Cursors::default(),
                    status: Some(StudioRecordingStatus::NeedsRemux),
                },
            })),
        };

        std::fs::write(
            project.join("recording-meta.json"),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .unwrap();
    }

    /// A resume that fails after `create_next` has allocated the segment
    /// directory but before it has written any frames leaves that directory
    /// behind, empty. Recovery has to ignore it, otherwise the segment that
    /// does hold footage is thrown away with it.
    #[test]
    fn empty_orphan_segment_directory_does_not_block_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();

        write_fragmented_track(&project.join("content/segments/segment-0"), "display");
        std::fs::create_dir_all(project.join("content/segments/segment-1")).unwrap();
        write_recording_meta(project, 1);

        let incomplete = RecoveryManager::inspect_recording(project)
            .expect("a recording with one recoverable segment must be detected");
        assert_eq!(
            incomplete.recoverable_segments.len(),
            1,
            "the empty segment directory must not be collected"
        );

        RecoveryManager::require_recoverable_tracks(&incomplete)
            .expect("an empty orphan segment directory must not make the recording unrecoverable");
    }

    /// The guard the fix must not disarm: a segment directory that still holds
    /// footage but never made it into the recoverable set is a real
    /// inconsistency, and recovering around it would silently drop that
    /// footage from the recording.
    ///
    /// The metadata deliberately declares a single segment so that validation
    /// reaches the directory-level guard. Declaring two would fail earlier with
    /// "Missing display segment 1" and never exercise the check under test.
    #[test]
    fn segment_directory_with_footage_outside_the_recoverable_set_is_still_fatal() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();

        write_fragmented_track(&project.join("content/segments/segment-0"), "display");
        write_fragmented_track(&project.join("content/segments/segment-1"), "display");
        write_recording_meta(project, 1);

        let mut incomplete = RecoveryManager::inspect_recording(project)
            .expect("both populated segments must be detected");
        assert_eq!(incomplete.recoverable_segments.len(), 2);

        incomplete
            .recoverable_segments
            .retain(|segment| segment.index == 0);

        let error = RecoveryManager::require_recoverable_tracks(&incomplete).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("Unrecoverable display segment 1"),
            "a populated but uncollected segment must still fail validation, got: {error}"
        );
    }

    /// A directory holding only a track other than the display is not an empty
    /// orphan. Skipping it would let recovery publish a recording that silently
    /// omits that footage, so it stays fatal.
    #[test]
    fn segment_directory_holding_only_non_display_media_is_still_fatal() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();

        write_fragmented_track(&project.join("content/segments/segment-0"), "display");
        write_fragmented_track(&project.join("content/segments/segment-1"), "camera");
        write_recording_meta(project, 1);

        let incomplete =
            RecoveryManager::inspect_recording(project).expect("the display segment must be found");
        assert_eq!(
            incomplete.recoverable_segments.len(),
            1,
            "a camera-only segment has no display fragments to collect"
        );

        let error = RecoveryManager::require_recoverable_tracks(&incomplete).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("Unrecoverable display segment 1"),
            "a segment holding camera media must still fail validation, got: {error}"
        );
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
    use std::io::{Read, Seek, SeekFrom};

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

    fn publication_fixture_with_version(
        version: u32,
        had_config: bool,
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        publication_fixture_with_receipt(version, had_config, false)
    }

    fn publication_fixture_with_receipt(
        version: u32,
        had_config: bool,
        apple_double: bool,
    ) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let fixture = publication_fixture();
        let (_, project, workspace) = &fixture;
        if !had_config {
            std::fs::remove_file(project.join("project-config.json")).unwrap();
        }
        if apple_double {
            std::fs::write(
                project.join("content/segments/._raw.m4s"),
                b"\x00\x05\x16\x07",
            )
            .unwrap();
        }
        interrupt_publication(project, workspace, 0);
        let stamp_version = match version {
            1 => RecoveryPublicationStampVersion::V1,
            2 => RecoveryPublicationStampVersion::V2,
            3 => RecoveryPublicationStampVersion::V3,
            _ => unreachable!(),
        };
        let receipt = RecoveryPublication {
            version,
            project: project.canonicalize().unwrap(),
            workspace: workspace.file_name().unwrap().to_str().unwrap().into(),
            original: recovery_publication_state_for_version(project, stamp_version).unwrap(),
            staged: recovery_publication_state_for_version(
                &workspace.join("staged"),
                stamp_version,
            )
            .unwrap(),
        };
        let bytes = serde_json::to_vec(&receipt).unwrap();
        std::fs::write(project.join(RECOVERY_PUBLICATION), &bytes).unwrap();
        std::fs::write(workspace.join(RECOVERY_PUBLICATION_RECEIPT), bytes).unwrap();
        fixture
    }

    #[test]
    fn publication_receipt_versions_reconcile_without_changing_originals() {
        for version in [1, 2, 3] {
            for had_config in [false, true] {
                let (_temporary, project, workspace) =
                    publication_fixture_with_version(version, had_config);
                let original = recovery_snapshot(&project).unwrap();
                let receipt = std::fs::read(workspace.join(RECOVERY_PUBLICATION_RECEIPT)).unwrap();
                let _lock = RecoveryLock::acquire(&project).unwrap();
                assert_eq!(recovery_snapshot(&project).unwrap(), original);
                assert!(!project.join(RECOVERY_PUBLICATION).exists());
                assert_eq!(
                    std::fs::read(workspace.join(RECOVERY_PUBLICATION_RECEIPT)).unwrap(),
                    receipt
                );
            }
        }
    }

    #[test]
    fn only_v3_publication_stamps_leave_out_apple_double_entries() {
        let temporary = tempfile::tempdir().unwrap();
        let segments = temporary.path().join("segments");
        std::fs::create_dir(&segments).unwrap();
        std::fs::write(segments.join("raw.m4s"), b"original raw").unwrap();
        let modified = segments.metadata().unwrap().modified().unwrap();
        let versions = [
            RecoveryPublicationStampVersion::V1,
            RecoveryPublicationStampVersion::V2,
            RecoveryPublicationStampVersion::V3,
        ];
        let before = versions.map(|version| {
            recovery_publication_segments_stamp(&segments, version)
                .unwrap()
                .unwrap()
        });

        std::fs::write(segments.join("._raw.m4s"), b"\x00\x05\x16\x07").unwrap();
        let mut directory = std::fs::OpenOptions::new();
        directory.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            directory
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
        directory
            .open(&segments)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let after = versions.map(|version| {
            recovery_publication_segments_stamp(&segments, version)
                .unwrap()
                .unwrap()
        });

        assert_ne!(before[0], after[0]);
        assert_ne!(before[1], after[1]);
        assert_eq!(before[2], after[2]);
    }

    #[test]
    fn publication_receipts_reconcile_with_apple_double_entries_present() {
        for version in [1, 2, 3] {
            let (_temporary, project, workspace) =
                publication_fixture_with_receipt(version, true, true);
            let original = recovery_snapshot(&project).unwrap();
            let receipt = std::fs::read(workspace.join(RECOVERY_PUBLICATION_RECEIPT)).unwrap();
            let _lock = RecoveryLock::acquire(&project).unwrap();
            assert_eq!(recovery_snapshot(&project).unwrap(), original);
            assert!(!project.join(RECOVERY_PUBLICATION).exists());
            assert_eq!(
                std::fs::read(workspace.join(RECOVERY_PUBLICATION_RECEIPT)).unwrap(),
                receipt
            );
        }
    }

    #[test]
    fn publication_receipt_versions_retain_conflict_guards() {
        use std::io::Write;

        for version in [1, 2, 3] {
            for changed in [
                "raw", "added", "removed", "metadata", "config", "stamp", "receipt",
            ] {
                let (_temporary, project, workspace) =
                    publication_fixture_with_version(version, true);
                match changed {
                    "raw" => {
                        let path = project.join("content/segments/raw.m4s");
                        let modified = path.metadata().unwrap().modified().unwrap();
                        let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
                        file.set_len(0).unwrap();
                        file.write_all(b"different raw length with original modification time")
                            .unwrap();
                        file.set_times(std::fs::FileTimes::new().set_modified(modified))
                            .unwrap();
                    }
                    "added" => {
                        std::fs::create_dir(project.join("content/segments/unrelated")).unwrap();
                    }
                    "removed" => {
                        std::fs::remove_file(project.join("content/segments/raw.m4s")).unwrap();
                    }
                    "metadata" | "config" => {
                        let name = if changed == "metadata" {
                            "recording-meta.json"
                        } else {
                            "project-config.json"
                        };
                        let path = project.join(name);
                        let mut bytes = std::fs::read(&path).unwrap();
                        bytes[0] ^= 1;
                        std::fs::write(path, bytes).unwrap();
                    }
                    "stamp" => {
                        let path = project.join(RECOVERY_PUBLICATION);
                        let mut receipt: RecoveryPublication =
                            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                        receipt.original.segments.as_mut().unwrap()[0] ^= 1;
                        let bytes = serde_json::to_vec(&receipt).unwrap();
                        std::fs::write(path, &bytes).unwrap();
                        std::fs::write(workspace.join(RECOVERY_PUBLICATION_RECEIPT), bytes)
                            .unwrap();
                    }
                    "receipt" => {
                        std::fs::write(
                            workspace.join(RECOVERY_PUBLICATION_RECEIPT),
                            b"different receipt",
                        )
                        .unwrap();
                    }
                    _ => unreachable!(),
                }
                let before = recovery_snapshot(&project).unwrap();
                assert!(RecoveryLock::acquire(&project).is_err());
                assert_eq!(recovery_snapshot(&project).unwrap(), before);
                assert!(project.join(RECOVERY_PUBLICATION).is_file());
                assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn legacy_publication_receipts_never_fall_back_to_version_two_stamps() {
        let (_temporary, project, workspace) = publication_fixture_with_version(2, true);
        let legacy =
            recovery_publication_state_for_version(&project, RecoveryPublicationStampVersion::V1)
                .unwrap();
        let path = project.join(RECOVERY_PUBLICATION);
        let mut receipt: RecoveryPublication =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(legacy.segments != receipt.original.segments);
        receipt.version = 1;
        let bytes = serde_json::to_vec(&receipt).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        std::fs::write(workspace.join(RECOVERY_PUBLICATION_RECEIPT), &bytes).unwrap();
        let before = recovery_snapshot(&project).unwrap();
        assert!(RecoveryLock::acquire(&project).is_err());
        assert_eq!(recovery_snapshot(&project).unwrap(), before);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
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
                                let actual_digest =
                                    blake3::hash(&std::fs::read(raw.join(relative)).unwrap())
                                        .as_bytes()
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
                        "version" => receipt.version = u32::MAX,
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
    fn preparing_reader_retains_recovery_lock_after_source_and_finalizer_drop() {
        let (_temporary, project, workspace) = publication_fixture();
        let mut reader = {
            let lock = Arc::new(RecoveryLock::acquire(&project).unwrap());
            let source =
                RelocatableSource::new_with_owner(project.join("content/segments"), lock.clone())
                    .unwrap();
            let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
            let mut prefix = [0; 4];
            reader.read_exact(&mut prefix).unwrap();
            assert_eq!(&prefix, b"orig");
            publish_recovery_with_source(&project, &workspace, &source).unwrap();
            reader
        };
        assert!(RecoveryLock::acquire(&project).is_err());
        let mut suffix = Vec::new();
        reader.read_to_end(&mut suffix).unwrap();
        assert_eq!(suffix, b"inal raw");
        drop(reader);
        let lock = RecoveryLock::acquire(&project).unwrap();
        drop(lock);
    }

    #[test]
    fn preparing_source_failures_release_recovery_lock_without_retained_readers() {
        let (_temporary, project, _workspace) = publication_fixture();
        let owner = Arc::new(RecoveryLock::acquire(&project).unwrap());
        assert!(RelocatableSource::new_with_owner(project.join("missing"), owner).is_err());
        let owner = Arc::new(RecoveryLock::acquire(&project).unwrap());
        let source =
            RelocatableSource::new_with_owner(project.join("content/segments"), owner).unwrap();
        assert!(source.reader(Path::new("missing.m4s")).is_err());
        drop(source);
        let lock = RecoveryLock::acquire(&project).unwrap();
        drop(lock);
    }

    #[test]
    fn managed_recovery_publication_keeps_readers_on_original_media() {
        let (_temporary, project, workspace) = publication_fixture();
        let source = RelocatableSource::new(project.join("content/segments")).unwrap();
        let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
        let mut prefix = [0; 4];
        reader.read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"orig");
        publish_recovery_with_source(&project, &workspace, &source).unwrap();
        let mut suffix = Vec::new();
        reader.read_to_end(&mut suffix).unwrap();
        assert_eq!(suffix, b"inal raw");
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original raw");
        let mut reopened = source.reader(Path::new("raw.m4s")).unwrap();
        bytes.clear();
        reopened.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original raw");
        assert_eq!(
            std::fs::read(project.join("content/segments/display.mp4")).unwrap(),
            b"validated output"
        );
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
    }

    #[test]
    fn managed_recovery_readers_survive_every_publication_rollback() {
        for failure in 1..=4 {
            let (_temporary, project, workspace) = publication_fixture();
            let before = recovery_snapshot(&project).unwrap();
            let original = project.join("content/segments");
            let backup = workspace.join("original-segments");
            let source = RelocatableSource::new(original.clone()).unwrap();
            let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
            let mut prefix = [0; 4];
            reader.read_exact(&mut prefix).unwrap();
            let mut calls = 0;
            let result = publish_recovery_with(&project, &workspace, |from, to| {
                calls += 1;
                if calls == failure {
                    return Err(std::io::Error::other(
                        "injected managed publication failure",
                    ));
                }
                rename_recovery_path_with_source(from, to, &original, &backup, &source)
            });
            assert!(result.is_err());
            assert_eq!(recovery_snapshot(&project).unwrap(), before);
            assert!(!project.join(RECOVERY_PUBLICATION).exists());
            let mut suffix = Vec::new();
            reader.read_to_end(&mut suffix).unwrap();
            assert_eq!(suffix, b"inal raw");
            assert!(source.reader(Path::new("raw.m4s")).is_ok());
        }
    }

    #[test]
    fn managed_recovery_rollback_failure_retains_readable_originals() {
        for rollback_failure in 5..=7 {
            let (_temporary, project, workspace) = publication_fixture();
            let original = project.join("content/segments");
            let backup = workspace.join("original-segments");
            let source = RelocatableSource::new(original.clone()).unwrap();
            let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
            let mut prefix = [0; 4];
            reader.read_exact(&mut prefix).unwrap();
            let mut calls = 0;
            let result = publish_recovery_with(&project, &workspace, |from, to| {
                calls += 1;
                if calls == 4 || calls == rollback_failure {
                    return Err(std::io::Error::other("injected managed rollback failure"));
                }
                rename_recovery_path_with_source(from, to, &original, &backup, &source)
            });
            assert!(result.unwrap_err().to_string().contains("rollback failed"));
            assert!(project.join(RECOVERY_PUBLICATION).is_file());
            assert_eq!(
                std::fs::read(backup.join("raw.m4s")).unwrap(),
                b"original raw"
            );
            let mut suffix = Vec::new();
            reader.read_to_end(&mut suffix).unwrap();
            assert_eq!(suffix, b"inal raw");
        }
    }

    #[test]
    fn managed_recovery_refuses_a_different_projects_source() {
        let (_temporary, project, workspace) = publication_fixture();
        let (_other_temporary, other, _other_workspace) = publication_fixture();
        let before = recovery_snapshot(&project).unwrap();
        let other_before = recovery_snapshot(&other).unwrap();
        let source = RelocatableSource::new(other.join("content/segments")).unwrap();
        let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
        assert!(publish_recovery_with_source(&project, &workspace, &source).is_err());
        assert_eq!(recovery_snapshot(&project).unwrap(), before);
        assert_eq!(recovery_snapshot(&other).unwrap(), other_before);
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original raw");
    }

    #[test]
    fn managed_recovery_lock_leaves_pending_publication_for_reader_shutdown() {
        let (_temporary, project, workspace) = publication_fixture();
        let original = project.join("content/segments");
        let backup = workspace.join("original-segments");
        let source = RelocatableSource::new(original.clone()).unwrap();
        let mut reader = source.reader(Path::new("raw.m4s")).unwrap();
        let mut prefix = [0; 4];
        reader.read_exact(&mut prefix).unwrap();
        {
            let _lock = RecoveryLock::acquire(&project).unwrap();
            let mut calls = 0;
            let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                publish_recovery_with(&project, &workspace, |from, to| {
                    rename_recovery_path_with_source(from, to, &original, &backup, &source)?;
                    calls += 1;
                    assert_ne!(calls, 1, "interrupted after managed source relocation");
                    Ok(())
                })
            }));
            assert!(interrupted.is_err());
        }
        let receipt = std::fs::read(project.join(RECOVERY_PUBLICATION)).unwrap();
        assert!(RecoveryLock::acquire_for_preparing_preview(&project).is_err());
        assert_eq!(
            std::fs::read(project.join(RECOVERY_PUBLICATION)).unwrap(),
            receipt
        );
        assert!(!original.exists());
        assert_eq!(
            std::fs::read(backup.join("raw.m4s")).unwrap(),
            b"original raw"
        );
        let mut suffix = Vec::new();
        reader.read_to_end(&mut suffix).unwrap();
        assert_eq!(suffix, b"inal raw");
        drop(reader);
        drop(source);
        let _lock = RecoveryLock::acquire(&project).unwrap();
        assert_eq!(
            std::fs::read(original.join("raw.m4s")).unwrap(),
            b"original raw"
        );
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
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
        for durability in [
            RecoveryCopyDurability::Durable,
            RecoveryCopyDurability::Deferred,
        ] {
            assert!(
                copy_recovery_input_with_durability(&source, &destination, durability).is_err()
            );
            assert_eq!(std::fs::read(&source).unwrap(), b"original");
            assert_eq!(std::fs::read(&destination).unwrap(), b"existing");
        }
    }

    #[test]
    fn recovery_copies_and_snapshots_skip_apple_double_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let segment = project.join("content/segments/segment-0");
        std::fs::create_dir_all(&segment).unwrap();
        std::fs::write(segment.join("display.mp4"), b"media").unwrap();
        let before = recovery_snapshot(&project).unwrap();

        let apple_double = b"\x00\x05\x16\x07";
        std::fs::write(segment.join("._display.mp4"), apple_double).unwrap();
        std::fs::write(project.join("content/segments/._segment-0"), apple_double).unwrap();
        assert_eq!(recovery_snapshot(&project).unwrap(), before);

        let staged = dir.path().join("staged");
        copy_recovery_input(&project.join("content"), &staged).unwrap();
        assert_eq!(
            std::fs::read(staged.join("segments/segment-0/display.mp4")).unwrap(),
            b"media"
        );
        for companion in ["segments/segment-0/._display.mp4", "segments/._segment-0"] {
            assert_ne!(
                std::fs::read(staged.join(companion)).ok().as_deref(),
                Some(&apple_double[..])
            );
        }
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

    #[cfg(unix)]
    #[test]
    fn recovery_lock_release_does_not_wait_for_inherited_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let lock = RecoveryLock::acquire(dir.path()).unwrap();
        let inherited = lock._file.try_clone().unwrap();
        assert!(RecoveryLock::acquire(dir.path()).is_err());
        drop(lock);
        let reacquired = RecoveryLock::acquire(dir.path()).unwrap();
        drop(inherited);
        assert!(RecoveryLock::acquire(dir.path()).is_err());
        drop(reacquired);
        assert!(RecoveryLock::acquire(dir.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_lock_inherited_guard_drop_does_not_unlock_parent() {
        fn reap_child(pid: libc::pid_t) -> std::io::Result<Option<i32>> {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let mut status = 0;
                match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
                    waited if waited == pid => return Ok(Some(status)),
                    -1 => {
                        let error = std::io::Error::last_os_error();
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            return Err(error);
                        }
                    }
                    _ => {}
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let lock = RecoveryLock::acquire(dir.path()).unwrap();
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // Only async-signal-safe operations may run in a child forked from the test harness.
            drop(lock);
            unsafe { libc::_exit(0) };
        }
        assert!(pid >= 0, "fork failed: {}", std::io::Error::last_os_error());
        let status = match reap_child(pid).unwrap() {
            Some(status) => status,
            None => {
                let killed = unsafe { libc::kill(pid, libc::SIGKILL) };
                let reaped = reap_child(pid);
                panic!("Forked lock probe timed out: kill={killed}, reap={reaped:?}");
            }
        };
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        assert!(RecoveryLock::acquire(dir.path()).is_err());
        drop(lock);
        assert!(RecoveryLock::acquire(dir.path()).is_ok());
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

    fn large_recovery_project() -> (tempfile::TempDir, Vec<PathBuf>) {
        let dir = tempfile::tempdir().unwrap();
        let fragments = dir.path().join("content/segments/segment-0/display");
        std::fs::create_dir_all(&fragments).unwrap();
        std::fs::write(dir.path().join("recording-meta.json"), b"{}").unwrap();
        let mut seed = 0x9e37_79b9_u32;
        let files = (0..24)
            .map(|index| {
                let bytes: Vec<u8> = (0..2 * 1024 * 1024)
                    .map(|_| {
                        seed ^= seed << 13;
                        seed ^= seed >> 17;
                        seed ^= seed << 5;
                        seed as u8
                    })
                    .collect();
                let path = fragments.join(format!("segment_{index:03}.m4s"));
                std::fs::write(&path, bytes).unwrap();
                path
            })
            .collect();
        (dir, files)
    }

    #[test]
    fn parallel_recovery_snapshot_matches_sequential_hashes() {
        let (dir, fragments) = large_recovery_project();
        let snapshot = recovery_snapshot(dir.path()).unwrap();

        let mut files = fragments.clone();
        files.push(dir.path().join("recording-meta.json"));
        let sequential = hash_recovery_files(dir.path(), &files).unwrap();
        assert_eq!(
            hash_recovery_files_parallel(dir.path(), &files, 4).unwrap(),
            sequential
        );
        for (path, hash) in &sequential {
            assert_eq!(snapshot.get(path), Some(hash));
        }
        for fragment in &fragments {
            let relative = fragment.strip_prefix(dir.path()).unwrap();
            assert_eq!(
                snapshot.get(relative),
                Some(&Some(
                    blake3::hash(&std::fs::read(fragment).unwrap())
                        .as_bytes()
                        .to_vec()
                ))
            );
        }
        assert_eq!(snapshot.get(Path::new("content/segments")), Some(&None));
        assert_eq!(snapshot.len(), sequential.len() + 4);

        let last = fragments.last().unwrap();
        let mut bytes = std::fs::read(last).unwrap();
        bytes[1024] ^= 1;
        std::fs::write(last, bytes).unwrap();
        assert_ne!(recovery_snapshot(dir.path()).unwrap(), snapshot);
    }

    #[test]
    fn parallel_recovery_hashing_reports_unreadable_inputs() {
        let (dir, mut fragments) = large_recovery_project();
        fragments.insert(12, dir.path().join("content/missing.m4s"));
        assert!(hash_recovery_files_parallel(dir.path(), &fragments, 4).is_err());
        assert!(hash_recovery_files_parallel(dir.path(), &fragments, 1).is_err());
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
        let raw = project.join("content/segments/raw.m4s");
        let modified = std::fs::metadata(&raw).unwrap().modified().unwrap();
        std::fs::write(&raw, b"modified raw").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&raw)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            std::fs::metadata(&raw).unwrap().modified().unwrap(),
            modified
        );
        assert_ne!(recovery_snapshot(&project).unwrap(), before);
        std::fs::write(project.join("content/segments/raw.m4s"), b"original raw").unwrap();
        assert_eq!(recovery_snapshot(&project).unwrap(), before);
        std::fs::create_dir(project.join("content/segments/segment-1")).unwrap();
        assert_ne!(recovery_snapshot(&project).unwrap(), before);
    }

    #[test]
    fn large_recovery_snapshots_preserve_exact_bytes_and_directory_entries() {
        use std::io::{Seek, SeekFrom, Write};

        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();
        std::fs::create_dir_all(project.join("content/nested/empty")).unwrap();
        let first = vec![0x25; 16 * 1024 * 1024 + 1];
        let second = vec![0x82; first.len()];
        std::fs::write(project.join("content/first.bin"), &first).unwrap();
        std::fs::write(project.join("content/nested/second.bin"), &second).unwrap();
        std::fs::write(project.join("recording-meta.json"), b"metadata").unwrap();
        std::fs::write(project.join("excluded"), b"not a recovery input").unwrap();

        let mut expected = RecoverySnapshot::new();
        for path in ["content", "content/nested", "content/nested/empty"] {
            let _ = expected.insert(PathBuf::from(path), None);
        }
        for (path, bytes) in [
            ("content/first.bin", first.as_slice()),
            ("content/nested/second.bin", second.as_slice()),
            ("recording-meta.json", b"metadata".as_slice()),
        ] {
            let _ = expected.insert(
                PathBuf::from(path),
                Some(blake3::hash(bytes).as_bytes().to_vec()),
            );
        }
        assert_eq!(recovery_snapshot(project).unwrap(), expected);

        let path = project.join("content/nested/second.bin");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[0x83]).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_ne!(recovery_snapshot(project).unwrap(), expected);
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[0x82]).unwrap();
        assert_eq!(recovery_snapshot(project).unwrap(), expected);
        std::fs::remove_dir(project.join("content/nested/empty")).unwrap();
        assert_ne!(recovery_snapshot(project).unwrap(), expected);
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
        drop(recovered);
        assert_eq!(
            std::fs::read(directory.path().join(".recovery.lock")).unwrap(),
            b""
        );
    }
}

#[cfg(test)]
mod preparing_canonical_probe;

#[cfg(test)]
mod timed_fragment_tests {
    use super::*;

    fn boxed(kind: &[u8; 4], values: &[u32]) -> Vec<u8> {
        let mut bytes = (8 + values.len() as u32 * 4).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(values.iter().flat_map(|value| value.to_be_bytes()));
        bytes
    }

    fn container(kind: &[u8; 4], children: &[Vec<u8>]) -> Vec<u8> {
        let payload = children.concat();
        let mut bytes = (8 + payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(payload);
        bytes
    }

    fn fixture(directory: &Path) -> (PathBuf, Vec<u8>) {
        let track = container(
            b"trak",
            &[
                boxed(b"tkhd", &[0, 0, 0, 1]),
                container(b"mdia", &[boxed(b"mdhd", &[0, 0, 0, 30])]),
            ],
        );
        let defaults = container(b"mvex", &[boxed(b"trex", &[0, 1, 1, 1, 4, 0])]);
        std::fs::write(
            directory.join("init.mp4"),
            container(b"moov", &[track, defaults]),
        )
        .unwrap();
        let moof = container(
            b"moof",
            &[container(
                b"traf",
                &[
                    boxed(b"tfhd", &[0x20000, 1]),
                    boxed(b"tfdt", &[0, 0]),
                    boxed(b"trun", &[1, 60, 76]),
                ],
            )],
        );
        assert_eq!(moof.len(), 68);
        let mut complete = moof;
        complete.extend(boxed(b"mdat", &[42; 60]));
        let path = directory.join("segment_001.m4s.tmp");
        let mut partial = complete.clone();
        partial.extend(boxed(b"moof", &[0; 10]));
        partial.extend(&boxed(b"mdat", &[0; 60])[..24]);
        std::fs::write(&path, partial).unwrap();
        (path, complete)
    }

    #[test]
    fn discovers_pending_prefix_without_mutating_source() {
        let directory = tempfile::tempdir().unwrap();
        let (source, _) = fixture(directory.path());
        let before = recovery_snapshot(directory.path()).unwrap();
        let info = RecoveryManager::find_studio_fragments_with_init(directory.path());
        assert_eq!(info.fragments, [source]);
        assert_eq!(recovery_snapshot(directory.path()).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_pending_fragment_stays_listed_for_a_retry() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let (source, _) = fixture(directory.path());
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&source).is_ok() {
            // Permissions do not apply (running as root).
            return;
        }
        let info = RecoveryManager::find_studio_fragments_with_init(directory.path());
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(info.fragments, [source]);
    }

    #[test]
    fn studio_recovery_keeps_complete_prefix_and_original_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let (source, complete) = fixture(directory.path());
        let original = std::fs::read(&source).unwrap();
        let marker = directory.path().join("segment_001.m4s.tmp.corrupt");
        std::fs::write(&marker, "truncated_fragment").unwrap();
        RecoveryManager::rescue_pending_tmp_fragments(directory.path(), None, true);
        let output = directory.path().join("segment_001.m4s");
        assert_eq!(std::fs::read(&output).unwrap(), complete);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        RecoveryManager::rescue_pending_tmp_fragments(directory.path(), None, true);
        assert_eq!(std::fs::read(&output).unwrap(), complete);
        assert_eq!(
            RecoveryManager::find_studio_fragments_with_init(directory.path()).fragments,
            [output]
        );
    }

    #[test]
    fn instant_recovery_keeps_existing_partial_tail_policy() {
        let directory = tempfile::tempdir().unwrap();
        let (source, _) = fixture(directory.path());
        let original = std::fs::read(&source).unwrap();
        RecoveryManager::rescue_pending_tmp_fragments(directory.path(), None, false);
        assert!(!directory.path().join("segment_001.m4s").exists());
        assert_eq!(std::fs::read(source).unwrap(), original);
    }

    #[test]
    fn failed_prefix_copy_does_not_quarantine_valid_media() {
        let directory = tempfile::tempdir().unwrap();
        let (source, complete) = fixture(directory.path());
        let original = std::fs::read(&source).unwrap();
        RecoveryManager::rescue_pending_tmp_fragments_with_copy(
            directory.path(),
            None,
            true,
            |_, _, _| Err(std::io::Error::other("injected storage failure")),
        );
        assert!(
            !directory
                .path()
                .join("segment_001.m4s.tmp.corrupt")
                .exists()
        );
        assert!(!directory.path().join("segment_001.m4s").exists());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        RecoveryManager::rescue_pending_tmp_fragments(directory.path(), None, true);
        assert_eq!(
            std::fs::read(directory.path().join("segment_001.m4s")).unwrap(),
            complete
        );
    }

    #[test]
    fn prefix_copy_never_overwrites_an_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let (source, complete) = fixture(directory.path());
        let output = directory.path().join("segment_001.m4s");
        std::fs::write(&output, b"existing").unwrap();
        assert!(
            RecoveryManager::copy_recovered_prefix(&source, &output, complete.len() as u64)
                .is_err()
        );
        assert_eq!(std::fs::read(output).unwrap(), b"existing");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 3);
    }
}
