use std::path::{Path, PathBuf};

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Bumped whenever the shape of [`DiagnosticReport`] changes incompatibly.
/// Additive fields do not bump it; consumers must tolerate unknown keys.
pub const DIAGNOSTIC_REPORT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu_brand: String,
    pub cpu_cores: u32,
    pub total_memory_mb: u64,
    pub available_memory_mb: u64,
    pub architecture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDiagnostics {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
    /// Logical top-left of the display in the desktop coordinate space, so a
    /// multi-monitor arrangement can be reconstructed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraDiagnostics {
    pub device_id: String,
    pub display_name: String,
    pub model_id: Option<String>,
    pub formats: Vec<CameraFormatInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraFormatInfo {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDiagnostics {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_bluetooth: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_usb: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_builtin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_configs: Option<Vec<AudioConfigRange>>,
}

/// One capability range a device advertises. Sample rates are a range rather
/// than a list because that is what CoreAudio/WASAPI/ALSA report.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfigRange {
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffer_size: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDiagnostics {
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub supported_configs: Vec<AudioConfigRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub recordings_path: String,
    pub available_space_mb: u64,
    pub total_space_mb: u64,
}

pub fn collect_hardware_info() -> HardwareInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    HardwareInfo {
        cpu_brand: sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Unknown".to_string()),
        cpu_cores: sys.cpus().len() as u32,
        total_memory_mb: sys.total_memory() / (1024 * 1024),
        available_memory_mb: sys.available_memory() / (1024 * 1024),
        architecture: std::env::consts::ARCH.to_string(),
    }
}

pub fn collect_displays() -> Vec<DisplayDiagnostics> {
    let displays = crate::screen_capture::list_displays();

    displays
        .into_iter()
        .enumerate()
        .map(|(idx, (cap_display, display))| {
            let physical_size = display.physical_size();
            let logical_size = display.logical_size();

            let (width, height) = physical_size
                .map(|s| (s.width() as u32, s.height() as u32))
                .unwrap_or((0, 0));

            let scale_factor = match (physical_size, logical_size) {
                (Some(phys), Some(log)) if log.width() > 0.0 => phys.width() / log.width(),
                _ => 1.0,
            };

            DisplayDiagnostics {
                id: cap_display.id.to_string(),
                name: cap_display.name,
                width,
                height,
                refresh_rate: cap_display.refresh_rate,
                scale_factor,
                is_primary: idx == 0,
                position: display
                    .raw_handle()
                    .logical_bounds()
                    .map(|bounds| (bounds.position().x(), bounds.position().y())),
            }
        })
        .collect()
}

pub fn collect_cameras() -> Vec<CameraDiagnostics> {
    cap_camera::list_cameras()
        .map(|camera| {
            let formats = camera
                .formats()
                .unwrap_or_default()
                .into_iter()
                .take(10)
                .map(|f| CameraFormatInfo {
                    width: f.width(),
                    height: f.height(),
                    frame_rate: f.frame_rate(),
                    pixel_format: f.pixel_format_name(),
                })
                .collect();

            CameraDiagnostics {
                device_id: camera.device_id().to_string(),
                display_name: camera.display_name().to_string(),
                model_id: camera.model_id().map(|m| m.to_string()),
                formats,
            }
        })
        .collect()
}

fn config_ranges<I: Iterator<Item = cpal::SupportedStreamConfigRange>>(
    configs: I,
) -> Vec<AudioConfigRange> {
    configs
        .map(|config| AudioConfigRange {
            min_sample_rate: config.min_sample_rate().0,
            max_sample_rate: config.max_sample_rate().0,
            channels: config.channels(),
            sample_format: format!("{:?}", config.sample_format()),
            buffer_size: match config.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max } => Some((*min, *max)),
                cpal::SupportedBufferSize::Unknown => None,
            },
        })
        .collect()
}

/// Name heuristics, matching `cap-test`'s device discovery so reports and the
/// test harness classify the same device the same way.
fn is_bluetooth_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("bluetooth")
        || lower.contains("airpods")
        || lower.contains("beats")
        || lower.contains("bose")
        || lower.contains("sony wh")
        || lower.contains("sony wf")
        || lower.contains("jabra")
        || lower.contains("jbl")
}

fn is_usb_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("usb")
        || lower.contains("blue yeti")
        || lower.contains("snowball")
        || lower.contains("rode")
        || lower.contains("focusrite")
        || lower.contains("scarlett")
        || lower.contains("audio-technica")
        || lower.contains("shure")
        || lower.contains("elgato wave")
}

fn is_builtin_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("macbook")
        || lower.contains("built-in")
        || lower.contains("builtin")
        || lower.contains("internal")
        || lower.contains("realtek")
        || lower.contains("conexant")
}

pub fn collect_microphones() -> Vec<MicrophoneDiagnostics> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };

    devices
        .filter_map(|device| {
            let name = device.name().ok()?;
            let config = device.default_input_config().ok()?;
            let supported = device
                .supported_input_configs()
                .ok()
                .map(config_ranges)
                .filter(|ranges: &Vec<AudioConfigRange>| !ranges.is_empty());

            Some(MicrophoneDiagnostics {
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
                sample_format: format!("{:?}", config.sample_format()),
                is_default: Some(default_name.as_deref() == Some(name.as_str())),
                is_bluetooth: Some(is_bluetooth_device(&name)),
                is_usb: Some(is_usb_device(&name)),
                is_builtin: Some(is_builtin_device(&name)),
                supported_configs: supported,
                name,
            })
        })
        .collect()
}

pub fn collect_audio_outputs() -> Vec<AudioOutputDiagnostics> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());

    let Ok(devices) = host.output_devices() else {
        return Vec::new();
    };

    devices
        .filter_map(|device| {
            let name = device.name().ok()?;
            let config = device.default_output_config().ok()?;

            Some(AudioOutputDiagnostics {
                is_default: default_name.as_deref() == Some(name.as_str()),
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
                sample_format: format!("{:?}", config.sample_format()),
                supported_configs: device
                    .supported_output_configs()
                    .ok()
                    .map(config_ranges)
                    .unwrap_or_default(),
                name,
            })
        })
        .collect()
}

pub fn collect_storage_info(recordings_path: &Path) -> Option<StorageInfo> {
    // Only free/total space is read, so skip the per-disk I/O counters a full
    // refresh would also collect. Enumerating mounts is still slow (seconds on
    // a machine with network or cloud volumes) — call this off the UI thread.
    let disks = sysinfo::Disks::new_with_refreshed_list_specifics(
        sysinfo::DiskRefreshKind::nothing().with_storage(),
    );

    let mut best_match: Option<(&sysinfo::Disk, usize)> = None;

    for disk in disks.iter() {
        if recordings_path.starts_with(disk.mount_point()) {
            let mount_point_len = disk.mount_point().as_os_str().len();
            if best_match.is_none_or(|(_, len)| mount_point_len > len) {
                best_match = Some((disk, mount_point_len));
            }
        }
    }

    best_match.map(|(disk, _)| StorageInfo {
        recordings_path: redact_home_paths(&recordings_path.display().to_string()),
        available_space_mb: disk.available_space() / (1024 * 1024),
        total_space_mb: disk.total_space() / (1024 * 1024),
    })
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let raw = std::env::var_os("HOME");

    raw.map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Replaces the user's home directory with `~` anywhere it appears. Reports
/// are shared with the Cap team, and paths are the main place a real name
/// leaks out of an otherwise anonymous machine description.
pub fn redact_home_paths(value: &str) -> String {
    let Some(home) = home_dir() else {
        return value.to_string();
    };
    redact_prefix(value, &home.to_string_lossy())
}

fn redact_prefix(value: &str, home: &str) -> String {
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return value.to_string();
    }
    if cfg!(windows) {
        // Windows paths are case-insensitive, so `c:\users\bob` is the same
        // directory as the `C:\Users\Bob` the environment reports.
        return replace_ignore_ascii_case(value, home);
    }
    value.replace(home, "~")
}

/// `str::replace` with an ASCII-case-insensitive needle, substituting `~`.
fn replace_ignore_ascii_case(value: &str, needle: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;

    while rest.len() >= needle.len() {
        // Only char boundaries can start a match, and the needle is a path
        // prefix, so a byte-wise scan is safe as long as slicing is guarded.
        let found = (0..=rest.len() - needle.len()).find(|&index| {
            rest.is_char_boundary(index)
                && rest.is_char_boundary(index + needle.len())
                && rest[index..index + needle.len()].eq_ignore_ascii_case(needle)
        });
        match found {
            Some(index) => {
                out.push_str(&rest[..index]);
                out.push('~');
                rest = &rest[index + needle.len()..];
            }
            None => break,
        }
    }

    out.push_str(rest);
    out
}

/// One `.cap` directory reduced to the timing facts that explain a sync
/// complaint: which devices produced each track, at what rate, and how far
/// apart the tracks started.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentRecordingDigest {
    /// Deliberately NOT the directory name. A `.cap` folder is named from the
    /// capture target's title (`recording.rs` -> `ScreenCaptureTarget::title`),
    /// so for a window recording that name IS the window title -- document
    /// names, client names, chat subjects. `created` identifies the entry well
    /// enough for support to correlate it with what the reporter describes.
    pub index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default)]
    pub segments: Vec<RecentRecordingSegment>,
    /// A corrupt or unreadable entry reports itself here instead of taking
    /// the whole collection down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentRecordingSegment {
    pub display_fps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_fps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_gap_summary: Option<cap_project::AudioGapSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_gap_summary: Option<cap_project::AudioGapSummary>,
}

fn file_created_rfc3339(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let time = metadata.created().or_else(|_| metadata.modified()).ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

fn segment_from_studio(
    display: &cap_project::VideoMeta,
    camera: Option<&cap_project::VideoMeta>,
    mic: Option<&cap_project::AudioMeta>,
    system_audio: Option<&cap_project::AudioMeta>,
) -> RecentRecordingSegment {
    RecentRecordingSegment {
        display_fps: display.fps,
        display_device_id: display.device_id.clone(),
        display_start_time: display.start_time,
        camera_fps: camera.map(|c| c.fps),
        camera_device_id: camera.and_then(|c| c.device_id.clone()),
        camera_start_time: camera.and_then(|c| c.start_time),
        mic_device_id: mic.and_then(|m| m.device_id.clone()),
        mic_start_time: mic.and_then(|m| m.start_time),
        mic_gap_summary: mic.and_then(|m| m.gap_summary),
        system_audio_device_id: system_audio.and_then(|a| a.device_id.clone()),
        system_audio_start_time: system_audio.and_then(|a| a.start_time),
        system_audio_gap_summary: system_audio.and_then(|a| a.gap_summary),
    }
}

fn digest_recording(index: usize, path: &Path) -> RecentRecordingDigest {
    use cap_project::{
        InstantRecordingMeta, RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus,
    };

    let mut digest = RecentRecordingDigest {
        index,
        mode: None,
        status: None,
        created: file_created_rfc3339(path),
        segments: Vec::new(),
        error: None,
    };

    let meta = match cap_project::RecordingMeta::load_for_project(path) {
        Ok(meta) => meta,
        Err(e) => {
            digest.error = Some(redact_home_paths(&e.to_string()));
            return digest;
        }
    };

    match &meta.inner {
        RecordingMetaInner::Studio(studio) => {
            digest.mode = Some("studio".to_string());
            let (status, failure) = match studio.status() {
                StudioRecordingStatus::InProgress => ("in_progress", None),
                StudioRecordingStatus::NeedsRemux => ("needs_remux", None),
                StudioRecordingStatus::Failed { error } => {
                    ("failed", Some(redact_home_paths(&error)))
                }
                StudioRecordingStatus::Complete => ("complete", None),
            };
            digest.status = Some(status.to_string());
            digest.error = failure;

            match &**studio {
                StudioRecordingMeta::SingleSegment { segment } => {
                    digest.segments.push(segment_from_studio(
                        &segment.display,
                        segment.camera.as_ref(),
                        segment.audio.as_ref(),
                        None,
                    ));
                }
                StudioRecordingMeta::MultipleSegments { inner } => {
                    for segment in &inner.segments {
                        digest.segments.push(segment_from_studio(
                            &segment.display,
                            segment.camera.as_ref(),
                            segment.mic.as_ref(),
                            segment.system_audio.as_ref(),
                        ));
                    }
                }
            }
        }
        RecordingMetaInner::Instant(instant) => {
            digest.mode = Some("instant".to_string());
            match instant {
                InstantRecordingMeta::InProgress { .. } => {
                    digest.status = Some("in_progress".to_string())
                }
                InstantRecordingMeta::Failed { error } => {
                    digest.status = Some("failed".to_string());
                    digest.error = Some(redact_home_paths(error));
                }
                InstantRecordingMeta::Complete { fps, .. } => {
                    digest.status = Some("complete".to_string());
                    // Instant recordings mux one output; the fps is the only
                    // per-track fact the meta carries.
                    digest.segments.push(RecentRecordingSegment {
                        display_fps: *fps,
                        display_device_id: None,
                        display_start_time: None,
                        camera_fps: None,
                        camera_device_id: None,
                        camera_start_time: None,
                        mic_device_id: None,
                        mic_start_time: None,
                        mic_gap_summary: None,
                        system_audio_device_id: None,
                        system_audio_start_time: None,
                        system_audio_gap_summary: None,
                    });
                }
            }
        }
    }

    digest
}

/// The newest `limit` `.cap` directories under `recordings_dir`, newest first.
pub fn collect_recent_recordings(
    recordings_dir: &Path,
    limit: usize,
) -> Vec<RecentRecordingDigest> {
    let Ok(entries) = std::fs::read_dir(recordings_dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if !path.is_dir() || path.extension().is_none_or(|ext| ext != "cap") {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, path))
        })
        .collect();

    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    candidates
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, (_, path))| digest_recording(index, &path))
        .collect()
}

/// The machine's capture shapes expressed as `sync_matrix` case parameters,
/// so a report can be replayed as a synthetic matrix run
/// (`CAP_SYNC_MATRIX_FROM_REPORT`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncMatrixHints {
    pub video: Vec<VideoHint>,
    pub audio_inputs: Vec<AudioHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoHint {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_max_fps: Option<u32>,
    pub fragmented: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioHint {
    pub rate: u32,
    pub channels: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffer_range: Option<(u32, u32)>,
}

fn video_hints_from_displays(
    displays: &[DisplayDiagnostics],
    configured_max_fps: Option<u32>,
    fragmented: bool,
) -> Vec<VideoHint> {
    displays
        .iter()
        .map(|display| VideoHint {
            width: display.width,
            height: display.height,
            refresh_rate: display.refresh_rate,
            configured_max_fps,
            fragmented,
        })
        .collect()
}

fn audio_hints_from_microphones(microphones: &[MicrophoneDiagnostics]) -> Vec<AudioHint> {
    microphones
        .iter()
        .map(|mic| AudioHint {
            rate: mic.sample_rate,
            channels: mic.channels,
            buffer_range: mic
                .supported_configs
                .as_ref()
                .and_then(|configs| configs.iter().find_map(|c| c.buffer_size)),
        })
        .collect()
}

/// Probes the machine and derives the hints from it. [`collect_report`] builds
/// its hints from the displays and microphones it already probed instead; this
/// is for callers that have neither.
pub fn collect_matrix_hints(configured_max_fps: Option<u32>, fragmented: bool) -> SyncMatrixHints {
    SyncMatrixHints {
        video: video_hints_from_displays(&collect_displays(), configured_max_fps, fragmented),
        audio_inputs: audio_hints_from_microphones(&collect_microphones()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Which desktop shell produced the report: `tauri` or `gpui`.
    pub flavor: String,
    pub version: String,
}

/// Inputs the caller owns (app identity, settings, permissions, an already-run
/// sync test). Everything else the report contains is probed here.
#[derive(Debug, Clone, Default)]
pub struct DiagnosticReportArgs<'a> {
    pub flavor: &'a str,
    pub app_version: &'a str,
    pub settings: Option<serde_json::Value>,
    pub permissions: Option<serde_json::Value>,
    pub recordings_dir: Option<&'a Path>,
    pub configured_max_fps: Option<u32>,
    pub fragmented_recording: bool,
    pub sync_test: Option<serde_json::Value>,
    pub sync_test_error: Option<String>,
}

/// The full environment snapshot uploaded from the Feedback page. Additive
/// only: consumers validate leniently and must tolerate unknown keys.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub schema_version: u32,
    pub report_id: String,
    pub generated_at: String,
    pub app: AppInfo,
    pub hardware: HardwareInfo,
    pub system: SystemDiagnostics,
    pub displays: Vec<DisplayDiagnostics>,
    pub cameras: Vec<CameraDiagnostics>,
    pub microphones: Vec<MicrophoneDiagnostics>,
    pub audio_outputs: Vec<AudioOutputDiagnostics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    pub recent_recordings: Vec<RecentRecordingDigest>,
    pub matrix_hints: SyncMatrixHints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_test: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_test_error: Option<String>,
}

pub fn collect_report(args: DiagnosticReportArgs<'_>) -> DiagnosticReport {
    // Display enumeration is the expensive probe here and microphone
    // enumeration re-walks every device's supported configs, so both run once
    // and feed the report and its matrix hints. Probing twice also let the two
    // disagree when hardware changed in between, breaking the invariant that
    // there is one video hint per display.
    let displays = collect_displays();
    let microphones = collect_microphones();
    let matrix_hints = SyncMatrixHints {
        video: video_hints_from_displays(
            &displays,
            args.configured_max_fps,
            args.fragmented_recording,
        ),
        audio_inputs: audio_hints_from_microphones(&microphones),
    };

    DiagnosticReport {
        schema_version: DIAGNOSTIC_REPORT_SCHEMA_VERSION,
        report_id: uuid::Uuid::new_v4().to_string(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        app: AppInfo {
            flavor: args.flavor.to_string(),
            version: args.app_version.to_string(),
        },
        hardware: collect_hardware_info(),
        system: collect_diagnostics(),
        displays,
        cameras: collect_cameras(),
        microphones,
        audio_outputs: collect_audio_outputs(),
        storage: args.recordings_dir.and_then(collect_storage_info),
        permissions: args.permissions,
        settings: args.settings,
        recent_recordings: args
            .recordings_dir
            .map(|dir| collect_recent_recordings(dir, 5))
            .unwrap_or_default(),
        matrix_hints,
        // The sync test is produced by a separate process, so its paths and
        // error strings never passed through the redaction the rest of this
        // report applies. `syncTestError` also reaches the Discord message
        // body, not just the attachment.
        sync_test: args.sync_test.map(redact_json_strings),
        sync_test_error: args.sync_test_error.as_deref().map(redact_home_paths),
    }
}

/// Applies [`redact_home_paths`] to every string leaf of a JSON document.
///
/// Redacting the *serialized* text instead would be backslash-blind: once
/// serialized, a Windows path is `C:\\Users\\Bob`, which no longer matches the
/// `C:\Users\Bob` the home directory reports.
pub fn redact_json_strings(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;

    match value {
        Value::String(text) => Value::String(redact_home_paths(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_json_strings).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key, redact_json_strings(value)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct WindowsVersionInfo {
        pub major: u32,
        pub minor: u32,
        pub build: u32,
        pub display_name: String,
        pub meets_requirements: bool,
        pub is_windows_11: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct GpuInfoDiag {
        pub vendor: String,
        pub description: String,
        pub dedicated_video_memory_mb: f64,
        pub adapter_index: u32,
        pub is_software_adapter: bool,
        pub is_basic_render_driver: bool,
        pub supports_hardware_encoding: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct AllGpusInfo {
        pub gpus: Vec<GpuInfoDiag>,
        pub primary_gpu_index: Option<u32>,
        pub is_multi_gpu_system: bool,
        pub has_discrete_gpu: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RenderingStatus {
        pub is_using_software_rendering: bool,
        pub is_using_basic_render_driver: bool,
        pub hardware_encoding_available: bool,
        pub warning_message: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub windows_version: Option<WindowsVersionInfo>,
        pub gpu_info: Option<GpuInfoDiag>,
        pub all_gpus: Option<AllGpusInfo>,
        pub rendering_status: RenderingStatus,
        pub available_encoders: Vec<String>,
        pub graphics_capture_supported: bool,
        #[serde(rename = "d3D11VideoProcessorAvailable")]
        pub d3d11_video_processor_available: bool,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let windows_version = get_windows_version_info();
        let gpu_info = get_gpu_info();
        let all_gpus = get_all_gpus_info();
        let rendering_status = get_rendering_status(&gpu_info);
        let available_encoders = get_available_encoders();
        let graphics_capture_supported = check_graphics_capture_support();
        let d3d11_video_processor_available = check_d3d11_video_processor();

        tracing::info!("System Diagnostics:");
        if let Some(ref ver) = windows_version {
            tracing::info!("  Windows: {}", ver.display_name);
        }
        if let Some(ref gpu) = gpu_info {
            tracing::info!(
                "  Primary GPU: {} ({}) - Software: {}, BasicRender: {}",
                gpu.description,
                gpu.vendor,
                gpu.is_software_adapter,
                gpu.is_basic_render_driver
            );
        }
        if let Some(ref all) = all_gpus {
            tracing::info!(
                "  GPU Count: {}, Multi-GPU: {}, Has Discrete: {}",
                all.gpus.len(),
                all.is_multi_gpu_system,
                all.has_discrete_gpu
            );
        }
        tracing::info!(
            "  Rendering: SoftwareRendering={}, HardwareEncoding={}",
            rendering_status.is_using_software_rendering,
            rendering_status.hardware_encoding_available
        );
        if let Some(ref warning) = rendering_status.warning_message {
            tracing::warn!("  Warning: {}", warning);
        }
        tracing::info!("  Encoders: {:?}", available_encoders);
        tracing::info!("  Graphics Capture: {}", graphics_capture_supported);
        tracing::info!(
            "  D3D11 Video Processor: {}",
            d3d11_video_processor_available
        );

        SystemDiagnostics {
            windows_version,
            gpu_info,
            all_gpus,
            rendering_status,
            available_encoders,
            graphics_capture_supported,
            d3d11_video_processor_available,
        }
    }

    fn get_windows_version_info() -> Option<WindowsVersionInfo> {
        scap_direct3d::WindowsVersion::detect().map(|v| WindowsVersionInfo {
            major: v.major,
            minor: v.minor,
            build: v.build,
            display_name: v.display_name(),
            meets_requirements: v.meets_minimum_requirements(),
            is_windows_11: v.is_windows_11(),
        })
    }

    fn gpu_info_to_diag(info: &cap_frame_converter::GpuInfo) -> GpuInfoDiag {
        GpuInfoDiag {
            vendor: info.vendor_name().to_string(),
            description: info.description.clone(),
            dedicated_video_memory_mb: (info.dedicated_video_memory / (1024 * 1024)) as f64,
            adapter_index: info.adapter_index,
            is_software_adapter: info.is_software_adapter,
            is_basic_render_driver: info.is_basic_render_driver(),
            supports_hardware_encoding: info.supports_hardware_encoding(),
        }
    }

    fn get_gpu_info() -> Option<GpuInfoDiag> {
        cap_frame_converter::detect_primary_gpu().map(gpu_info_to_diag)
    }

    fn get_all_gpus_info() -> Option<AllGpusInfo> {
        let all_gpus = cap_frame_converter::get_all_gpus();

        if all_gpus.is_empty() {
            return None;
        }

        let gpus: Vec<GpuInfoDiag> = all_gpus.iter().map(gpu_info_to_diag).collect();

        let primary_gpu = cap_frame_converter::detect_primary_gpu();
        let primary_gpu_index = primary_gpu.and_then(|primary| {
            all_gpus
                .iter()
                .position(|g| g.adapter_index == primary.adapter_index)
                .map(|idx| idx as u32)
        });

        let has_discrete = all_gpus.iter().any(|g| {
            matches!(
                g.vendor,
                cap_frame_converter::GpuVendor::Nvidia
                    | cap_frame_converter::GpuVendor::Amd
                    | cap_frame_converter::GpuVendor::Qualcomm
                    | cap_frame_converter::GpuVendor::Arm
            ) && !g.is_software_adapter
        });

        Some(AllGpusInfo {
            is_multi_gpu_system: gpus.len() > 1,
            has_discrete_gpu: has_discrete,
            primary_gpu_index,
            gpus,
        })
    }

    fn get_rendering_status(gpu_info: &Option<GpuInfoDiag>) -> RenderingStatus {
        let (is_software, is_basic_render, hw_encoding, warning) = match gpu_info {
            Some(gpu) => {
                let is_basic = gpu.is_basic_render_driver;
                let is_software = gpu.is_software_adapter;
                let hw_available = gpu.supports_hardware_encoding;

                let warning = if is_basic {
                    Some(
                        "Microsoft Basic Render Driver detected. This may indicate missing GPU drivers or a remote desktop session. Recording will use software encoding which may impact performance."
                            .to_string(),
                    )
                } else if is_software {
                    Some(
                        "Software rendering is active. Hardware GPU acceleration is not available. Update your graphics drivers for better performance."
                            .to_string(),
                    )
                } else if !hw_available {
                    Some(
                        "Hardware encoding may not be available on this GPU. Software encoding will be used as a fallback."
                            .to_string(),
                    )
                } else {
                    None
                };

                (is_software, is_basic, hw_available, warning)
            }
            None => (
                true,
                false,
                false,
                Some("No GPU detected. Recording will use software encoding.".to_string()),
            ),
        };

        RenderingStatus {
            is_using_software_rendering: is_software,
            is_using_basic_render_driver: is_basic_render,
            hardware_encoding_available: hw_encoding,
            warning_message: warning,
        }
    }

    fn get_available_encoders() -> Vec<String> {
        let candidates = [
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_mf",
            "libx264",
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_amf",
            "hevc_mf",
            "libx265",
        ];

        candidates
            .iter()
            .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
            .map(|s| s.to_string())
            .collect()
    }

    fn check_graphics_capture_support() -> bool {
        scap_direct3d::is_supported().unwrap_or(false)
    }

    fn check_d3d11_video_processor() -> bool {
        use cap_frame_converter::ConversionConfig;

        let test_config = ConversionConfig::new(
            ffmpeg::format::Pixel::BGRA,
            1920,
            1080,
            ffmpeg::format::Pixel::NV12,
            1920,
            1080,
        );

        match cap_frame_converter::D3D11Converter::new(test_config) {
            Ok(converter) => {
                tracing::debug!(
                    "D3D11 video processor check passed: {} ({})",
                    converter.gpu_info().description,
                    converter.gpu_info().vendor_name()
                );
                true
            }
            Err(e) => {
                tracing::warn!("D3D11 video processor check failed: {e:?}");
                false
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct MacOSVersionInfo {
        pub major: u32,
        pub minor: u32,
        pub patch: u32,
        pub display_name: String,
        pub build_number: String,
        pub is_apple_silicon: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub macos_version: Option<MacOSVersionInfo>,
        pub available_encoders: Vec<String>,
        pub screen_capture_supported: bool,
        pub metal_supported: bool,
        pub gpu_name: Option<String>,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let macos_version = get_macos_version();
        let available_encoders = get_available_encoders();
        let metal_supported = check_metal_support();
        let gpu_name = get_gpu_name();

        tracing::info!("System Diagnostics:");
        if let Some(ref ver) = macos_version {
            tracing::info!(
                "  macOS: {} (Build {}), Apple Silicon: {}",
                ver.display_name,
                ver.build_number,
                ver.is_apple_silicon
            );
        }
        if let Some(ref gpu) = gpu_name {
            tracing::info!("  GPU: {}", gpu);
        }
        tracing::info!("  Metal: {}", metal_supported);
        tracing::info!("  Encoders: {:?}", available_encoders);

        SystemDiagnostics {
            macos_version,
            available_encoders,
            screen_capture_supported: true,
            metal_supported,
            gpu_name,
        }
    }

    fn get_macos_version() -> Option<MacOSVersionInfo> {
        use std::process::Command;

        let version_output = Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        let version_str = String::from_utf8_lossy(&version_output.stdout);
        let version_str = version_str.trim();

        let parts: Vec<u32> = version_str
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect();

        let (major, minor, patch) = match parts.as_slice() {
            [maj, min, pat, ..] => (*maj, *min, *pat),
            [maj, min] => (*maj, *min, 0),
            [maj] => (*maj, 0, 0),
            _ => return None,
        };

        let build_output = Command::new("sw_vers").arg("-buildVersion").output().ok()?;
        let build_number = String::from_utf8_lossy(&build_output.stdout)
            .trim()
            .to_string();

        let is_apple_silicon = std::env::consts::ARCH == "aarch64";

        let display_name = format!(
            "macOS {}.{}.{} ({})",
            major,
            minor,
            patch,
            if is_apple_silicon {
                "Apple Silicon"
            } else {
                "Intel"
            }
        );

        Some(MacOSVersionInfo {
            major,
            minor,
            patch,
            display_name,
            build_number,
            is_apple_silicon,
        })
    }

    fn check_metal_support() -> bool {
        std::env::consts::ARCH == "aarch64"
            || std::process::Command::new("system_profiler")
                .args(["SPDisplaysDataType"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("Metal"))
                .unwrap_or(false)
    }

    fn get_gpu_name() -> Option<String> {
        use std::process::Command;

        let output = Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-json"])
            .output()
            .ok()?;

        let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;

        json.get("SPDisplaysDataType")?
            .as_array()?
            .first()?
            .get("sppci_model")
            .or_else(|| {
                json.get("SPDisplaysDataType")?
                    .as_array()?
                    .first()?
                    .get("_name")
            })?
            .as_str()
            .map(|s| s.to_string())
    }

    fn get_available_encoders() -> Vec<String> {
        let candidates = [
            "h264_videotoolbox",
            "libx264",
            "hevc_videotoolbox",
            "libx265",
        ];

        candidates
            .iter()
            .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
            .map(|s| s.to_string())
            .collect()
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::*;

    #[derive(Debug, Clone, Serialize, Deserialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub kernel_version: Option<String>,
        pub available_encoders: Vec<String>,
        pub screen_capture_supported: bool,
        pub gpu_name: Option<String>,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let kernel_version = get_kernel_version();
        let available_encoders = get_available_encoders();
        let gpu_name = get_gpu_name();

        tracing::info!("System Diagnostics:");
        if let Some(ref version) = kernel_version {
            tracing::info!("  Kernel: {}", version);
        }
        if let Some(ref gpu) = gpu_name {
            tracing::info!("  GPU: {}", gpu);
        }
        tracing::info!("  Encoders: {:?}", available_encoders);

        SystemDiagnostics {
            kernel_version,
            available_encoders,
            screen_capture_supported: true,
            gpu_name,
        }
    }

    fn get_kernel_version() -> Option<String> {
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn get_gpu_name() -> Option<String> {
        let output = std::process::Command::new("glxinfo")
            .arg("-B")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("OpenGL renderer string:")
                    .map(|name| name.trim().to_string())
            })
            .filter(|name| !name.is_empty())
    }

    fn get_available_encoders() -> Vec<String> {
        let candidates = [
            "h264_nvenc",
            "h264_vaapi",
            "h264_qsv",
            "libx264",
            "hevc_nvenc",
            "hevc_vaapi",
            "libx265",
        ];

        candidates
            .iter()
            .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
            .map(|s| s.to_string())
            .collect()
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::*;

#[cfg(target_os = "macos")]
pub use macos_impl::*;

#[cfg(target_os = "linux")]
pub use linux_impl::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn write_recording(dir: &Path, name: &str, meta: &str) {
        let project = dir.join(name);
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("recording-meta.json"), meta).unwrap();
    }

    #[test]
    fn redacts_every_string_leaf_of_a_json_document() {
        let home = home_dir().expect("a home directory");
        let home = home.to_string_lossy().to_string();
        let value = serde_json::json!({
            "summary": format!("kept at {home}/Movies/a.cap"),
            "nested": { "paths": [format!("{home}/one"), "/opt/two".to_string()] },
            "count": 7,
            "flag": true,
            "nothing": serde_json::Value::Null,
        });

        let redacted = redact_json_strings(value);

        assert_eq!(redacted["summary"], "kept at ~/Movies/a.cap");
        assert_eq!(redacted["nested"]["paths"][0], "~/one");
        // Non-home paths and non-string leaves are left exactly as they were.
        assert_eq!(redacted["nested"]["paths"][1], "/opt/two");
        assert_eq!(redacted["count"], 7);
        assert_eq!(redacted["flag"], true);
        assert!(redacted["nothing"].is_null());
    }

    #[test]
    fn windows_home_matching_ignores_case() {
        // Windows paths are case-insensitive, so a lowercased spelling of the
        // home directory still has to redact.
        assert_eq!(
            replace_ignore_ascii_case(r"c:\users\bob\Movies\a.cap", r"C:\Users\Bob"),
            r"~\Movies\a.cap"
        );
        assert_eq!(
            replace_ignore_ascii_case("nothing to do here", r"C:\Users\Bob"),
            "nothing to do here"
        );
        // Multibyte content around the match must survive intact.
        assert_eq!(
            replace_ignore_ascii_case(r"café C:\Users\Bob\x ✅", r"c:\users\bob"),
            r"café ~\x ✅"
        );
    }

    #[test]
    fn redacts_home_paths() {
        // The env var is read, never written: another test thread reading
        // HOME concurrently must not see it change.
        assert_eq!(
            redact_prefix("/Users/someone/Movies/Cap/a.cap", "/Users/someone"),
            "~/Movies/Cap/a.cap"
        );
        assert_eq!(
            redact_prefix(
                "failed to open /Users/someone/x and /Users/someone/y",
                "/Users/someone/"
            ),
            "failed to open ~/x and ~/y"
        );
        assert_eq!(redact_prefix("/opt/cap", "/Users/someone"), "/opt/cap");
        assert_eq!(
            redact_prefix(r"C:\Users\someone\Videos", r"C:\Users\someone\"),
            r"~\Videos"
        );
        // No home means no redaction rather than a mangled string.
        assert_eq!(redact_prefix("/opt/cap", ""), "/opt/cap");

        if let Some(home) = home_dir() {
            let home = home.to_string_lossy().to_string();
            if !home.trim_end_matches(['/', '\\']).is_empty() {
                assert_eq!(redact_home_paths(&format!("{home}/x")), "~/x");
            }
        }
    }

    #[test]
    fn digests_recent_recordings_and_survives_corrupt_entries() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();

        write_recording(
            dir,
            "studio.cap",
            r#"{
                "pretty_name": "Studio",
                "segments": [
                    {
                        "display": {
                            "path": "content/segments/segment-0/display.mp4",
                            "fps": 60,
                            "start_time": 1.5,
                            "device_id": "display-1"
                        },
                        "mic": {
                            "path": "content/segments/segment-0/audio-input.ogg",
                            "start_time": 1.75,
                            "device_id": "Built-in Microphone",
                            "gap_summary": {
                                "total_overlap_trimmed_ms": 12,
                                "overlap_dropped_frames": 2,
                                "startup_overlap_drops": 1
                            }
                        },
                        "system_audio": {
                            "path": "content/segments/segment-0/system_audio.ogg",
                            "start_time": 1.4
                        }
                    }
                ]
            }"#,
        );
        write_recording(
            dir,
            "instant.cap",
            r#"{ "pretty_name": "Instant", "fps": 30, "sample_rate": 48000 }"#,
        );
        write_recording(dir, "broken.cap", "{ not json");
        std::fs::create_dir_all(dir.join("not-a-recording")).unwrap();

        let digests = collect_recent_recordings(dir, 5);
        assert_eq!(digests.len(), 3, "only .cap directories are digested");

        // Entries are identified by mode now: the digest deliberately carries
        // no name, because a .cap directory is named from the capture
        // target's title.
        let studio = digests
            .iter()
            .find(|d| d.mode.as_deref() == Some("studio"))
            .expect("studio digest");
        assert_eq!(studio.mode.as_deref(), Some("studio"));
        assert_eq!(studio.status.as_deref(), Some("complete"));
        assert_eq!(studio.segments.len(), 1);
        let segment = &studio.segments[0];
        assert_eq!(segment.display_fps, 60);
        assert_eq!(segment.display_device_id.as_deref(), Some("display-1"));
        assert_eq!(segment.display_start_time, Some(1.5));
        assert_eq!(
            segment.mic_device_id.as_deref(),
            Some("Built-in Microphone")
        );
        assert_eq!(segment.system_audio_start_time, Some(1.4));
        assert_eq!(
            segment
                .mic_gap_summary
                .map(|summary| summary.total_overlap_trimmed_ms),
            Some(12)
        );
        assert!(studio.error.is_none());

        let instant = digests
            .iter()
            .find(|d| d.mode.as_deref() == Some("instant"))
            .expect("instant digest");
        assert_eq!(instant.mode.as_deref(), Some("instant"));
        assert_eq!(instant.segments.first().map(|s| s.display_fps), Some(30));

        let broken = digests
            .iter()
            .find(|d| d.error.is_some())
            .expect("broken digest");
        assert!(broken.mode.is_none(), "a corrupt entry has no mode");
    }

    #[test]
    fn recent_recordings_respects_limit() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..4 {
            write_recording(
                temp.path(),
                &format!("r{i}.cap"),
                r#"{ "pretty_name": "R", "fps": 30, "sample_rate": 48000 }"#,
            );
        }
        assert_eq!(collect_recent_recordings(temp.path(), 2).len(), 2);
        assert_eq!(
            collect_recent_recordings(&temp.path().join("missing"), 2).len(),
            0
        );
    }

    #[test]
    fn matrix_hints_map_devices_onto_case_parameters() {
        let displays = vec![DisplayDiagnostics {
            id: "1".to_string(),
            name: "Built-in".to_string(),
            width: 3456,
            height: 2234,
            refresh_rate: 120,
            scale_factor: 2.0,
            is_primary: true,
            position: Some((0.0, 0.0)),
        }];
        let hints = video_hints_from_displays(&displays, Some(60), true);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].width, 3456);
        assert_eq!(hints[0].refresh_rate, 120);
        assert_eq!(hints[0].configured_max_fps, Some(60));
        assert!(hints[0].fragmented);

        let microphones = vec![MicrophoneDiagnostics {
            name: "Mic".to_string(),
            sample_rate: 44_100,
            channels: 1,
            sample_format: "F32".to_string(),
            is_default: Some(true),
            is_bluetooth: Some(false),
            is_usb: Some(true),
            is_builtin: Some(false),
            supported_configs: Some(vec![AudioConfigRange {
                min_sample_rate: 44_100,
                max_sample_rate: 48_000,
                channels: 1,
                sample_format: "F32".to_string(),
                buffer_size: Some((15, 4096)),
            }]),
        }];
        let audio = audio_hints_from_microphones(&microphones);
        assert_eq!(audio.len(), 1);
        assert_eq!(audio[0].rate, 44_100);
        assert_eq!(audio[0].channels, 1);
        assert_eq!(audio[0].buffer_range, Some((15, 4096)));

        // A device that reports no ranges still produces a usable hint.
        let bare = audio_hints_from_microphones(&[MicrophoneDiagnostics {
            name: "Bare".to_string(),
            sample_rate: 48_000,
            channels: 2,
            sample_format: "I16".to_string(),
            is_default: None,
            is_bluetooth: None,
            is_usb: None,
            is_builtin: None,
            supported_configs: None,
        }]);
        assert_eq!(bare[0].buffer_range, None);
    }

    #[test]
    fn device_name_heuristics() {
        assert!(is_bluetooth_device("Richie's AirPods Pro"));
        assert!(is_usb_device("Blue Yeti Nano"));
        assert!(is_builtin_device("MacBook Pro Microphone"));
        assert!(!is_bluetooth_device("Blue Yeti Nano"));
    }

    /// A populated envelope without touching capture hardware. `collect_displays`
    /// goes through ScreenCaptureKit, which blocks for ~35s in a test binary that
    /// has no screen-recording permission; the serde contract is what this file
    /// needs to guard, so it is asserted on a report built from parts.
    fn sample_report(recordings_dir: &Path) -> DiagnosticReport {
        let displays = vec![DisplayDiagnostics {
            id: "1".to_string(),
            name: "Built-in".to_string(),
            width: 3456,
            height: 2234,
            refresh_rate: 120,
            scale_factor: 2.0,
            is_primary: true,
            position: Some((0.0, -1080.0)),
        }];
        let microphones = vec![MicrophoneDiagnostics {
            name: "MacBook Pro Microphone".to_string(),
            sample_rate: 48_000,
            channels: 1,
            sample_format: "F32".to_string(),
            is_default: Some(true),
            is_bluetooth: Some(false),
            is_usb: Some(false),
            is_builtin: Some(true),
            supported_configs: Some(vec![AudioConfigRange {
                min_sample_rate: 48_000,
                max_sample_rate: 48_000,
                channels: 1,
                sample_format: "F32".to_string(),
                buffer_size: Some((15, 4096)),
            }]),
        }];

        DiagnosticReport {
            schema_version: DIAGNOSTIC_REPORT_SCHEMA_VERSION,
            report_id: uuid::Uuid::new_v4().to_string(),
            generated_at: chrono::Utc::now().to_rfc3339(),
            app: AppInfo {
                flavor: "gpui".to_string(),
                version: "0.6.0".to_string(),
            },
            hardware: collect_hardware_info(),
            system: collect_diagnostics(),
            cameras: vec![CameraDiagnostics {
                device_id: "cam-1".to_string(),
                display_name: "FaceTime HD Camera".to_string(),
                model_id: None,
                formats: vec![CameraFormatInfo {
                    width: 1920,
                    height: 1080,
                    frame_rate: 30.0,
                    pixel_format: Some("420v".to_string()),
                }],
            }],
            audio_outputs: vec![AudioOutputDiagnostics {
                name: "MacBook Pro Speakers".to_string(),
                is_default: true,
                sample_rate: 48_000,
                channels: 2,
                sample_format: "F32".to_string(),
                supported_configs: Vec::new(),
            }],
            // Not the real probe: enumerating mounts takes seconds on a machine
            // with network volumes attached.
            storage: Some(StorageInfo {
                recordings_path: redact_home_paths(&recordings_dir.display().to_string()),
                available_space_mb: 128_000,
                total_space_mb: 512_000,
            }),
            permissions: Some(serde_json::json!({ "screenRecording": "granted" })),
            settings: Some(serde_json::json!({ "recordingFps": 60 })),
            recent_recordings: collect_recent_recordings(recordings_dir, 5),
            matrix_hints: SyncMatrixHints {
                video: video_hints_from_displays(&displays, Some(60), true),
                audio_inputs: audio_hints_from_microphones(&microphones),
            },
            sync_test: Some(serde_json::json!({ "verdict": "pass" })),
            sync_test_error: None,
            displays,
            microphones,
        }
    }

    #[test]
    fn report_envelope_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        write_recording(
            temp.path(),
            "one.cap",
            r#"{ "pretty_name": "One", "fps": 30, "sample_rate": 48000 }"#,
        );

        let report = sample_report(temp.path());
        assert_eq!(report.schema_version, DIAGNOSTIC_REPORT_SCHEMA_VERSION);
        assert_eq!(report.recent_recordings.len(), 1);
        assert!(!report.report_id.is_empty());

        let json = serde_json::to_string(&report).unwrap();
        // The web validator reads camelCase, like every other diagnostics type.
        for key in [
            "\"schemaVersion\"",
            "\"reportId\"",
            "\"generatedAt\"",
            "\"matrixHints\"",
            "\"recentRecordings\"",
            "\"audioOutputs\"",
            "\"syncTest\"",
            "\"pixelFormat\"",
            "\"configuredMaxFps\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }

        let parsed: DiagnosticReport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.report_id, report.report_id);
        assert_eq!(parsed.generated_at, report.generated_at);
        assert_eq!(parsed.app.version, "0.6.0");
        assert_eq!(parsed.app.flavor, "gpui");
        assert_eq!(parsed.sync_test_error, None);
        assert_eq!(parsed.displays[0].position, Some((0.0, -1080.0)));
        assert_eq!(parsed.matrix_hints.video.len(), 1);
        assert_eq!(parsed.matrix_hints.audio_inputs[0].rate, 48_000);
        assert_eq!(parsed.recent_recordings[0].index, 0);
        assert_eq!(
            parsed.cameras[0].formats[0].pixel_format.as_deref(),
            Some("420v")
        );
        assert_eq!(
            parsed
                .sync_test
                .and_then(|t| t["verdict"].as_str().map(str::to_string)),
            Some("pass".to_string())
        );
    }

    /// Exercises the real probe end to end. Ignored by default because it is
    /// slow in a headless process: the first `refresh_rate()`/`name()` call
    /// pays a one-time WindowServer connection cost (measured 40-110s here,
    /// varying with machine load). It is a per-process cost, not per-call —
    /// the second call in the same process measures 0.000s — so a GUI app,
    /// which connects to WindowServer at launch, never pays it. Do not
    /// "optimize" `collect_displays` on the strength of this test's runtime.
    #[test]
    #[ignore = "probes real capture devices; slow only in a headless process"]
    fn collect_report_probes_the_machine() {
        let temp = tempfile::tempdir().unwrap();
        let report = collect_report(DiagnosticReportArgs {
            flavor: "gpui",
            app_version: "0.6.0",
            recordings_dir: Some(temp.path()),
            configured_max_fps: Some(60),
            fragmented_recording: true,
            ..Default::default()
        });

        assert_eq!(report.schema_version, DIAGNOSTIC_REPORT_SCHEMA_VERSION);
        assert_eq!(report.app.flavor, "gpui");
        assert_eq!(report.matrix_hints.video.len(), report.displays.len());
        assert_eq!(
            report.matrix_hints.audio_inputs.len(),
            report.microphones.len()
        );
        assert!(report.recent_recordings.is_empty());
        serde_json::from_str::<DiagnosticReport>(&serde_json::to_string(&report).unwrap()).unwrap();
    }
}
