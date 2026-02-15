use cap_media_info::VideoInfo;
use ffmpeg::{format, frame};
use serde::Serialize;
use std::{
    ffi::CString,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::video::h264::{
    DEFAULT_KEYFRAME_INTERVAL_SECS, H264Encoder, H264EncoderBuilder, H264EncoderError, H264Preset,
};

const INIT_SEGMENT_NAME: &str = "init.mp4";

#[derive(Debug, Clone)]
pub struct DiskSpaceWarning {
    pub available_mb: u64,
    pub threshold_mb: u64,
    pub path: String,
    pub is_critical: bool,
}

pub type DiskSpaceCallback = Arc<dyn Fn(DiskSpaceWarning) + Send + Sync>;

#[cfg(unix)]
fn get_available_disk_space_mb(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    let c_path = CString::new(path.parent().unwrap_or(path).to_str().unwrap_or_default()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if result != 0 {
        return None;
    }
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize) / (1024 * 1024))
}

#[cfg(not(unix))]
fn get_available_disk_space_mb(_path: &Path) -> Option<u64> {
    None
}

fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> std::io::Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut file = std::fs::File::create(&temp_path)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;

    std::fs::rename(&temp_path, path)?;

    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
        && let Err(e) = dir.sync_all()
    {
        tracing::warn!(
            "Directory fsync failed after rename for {}: {e}",
            parent.display()
        );
    }

    Ok(())
}

fn sync_file(path: &Path) {
    if let Ok(file) = std::fs::File::open(path)
        && let Err(e) = file.sync_all()
    {
        tracing::warn!("File fsync failed for {}: {e}", path.display());
    }
}

const DISK_SPACE_CHECK_INTERVAL: Duration = Duration::from_secs(10);
const DISK_SPACE_WARNING_MB: u64 = 500;
const DISK_SPACE_CRITICAL_MB: u64 = 200;

pub struct SegmentedVideoEncoder {
    base_path: PathBuf,

    encoder: H264Encoder,
    output: format::context::Output,

    current_index: u32,
    segment_duration: Duration,
    segment_start_time: Option<Duration>,
    last_frame_timestamp: Option<Duration>,
    frames_in_segment: u32,

    completed_segments: Vec<VideoSegmentInfo>,

    codec_info: CodecInfo,

    disk_space_callback: Option<DiskSpaceCallback>,
    last_disk_check: Option<std::time::Instant>,
}

#[derive(Debug, Clone)]
pub struct VideoSegmentInfo {
    pub path: PathBuf,
    pub index: u32,
    pub duration: Duration,
    pub file_size: Option<u64>,
}

#[derive(Serialize)]
struct SegmentEntry {
    path: String,
    index: u32,
    duration: f64,
    is_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
}

#[derive(Serialize, Clone)]
struct CodecInfo {
    width: u32,
    height: u32,
    frame_rate_num: i32,
    frame_rate_den: i32,
    time_base_num: i32,
    time_base_den: i32,
    pixel_format: String,
}

const MANIFEST_VERSION: u32 = 5;

#[derive(Serialize)]
struct Manifest {
    version: u32,
    #[serde(rename = "type")]
    manifest_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    init_segment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codec_info: Option<CodecInfo>,
    segments: Vec<SegmentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_duration: Option<f64>,
    is_complete: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Encoder: {0}")]
    Encoder(#[from] H264EncoderError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Init: {0}")]
    Init(#[from] InitError),
    #[error(transparent)]
    Encode(#[from] crate::video::h264::QueueFrameError),
    #[error("Init segment validation failed: {0}")]
    InitSegmentInvalid(String),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
}

pub struct SegmentedVideoEncoderConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
}

impl Default for SegmentedVideoEncoderConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(DEFAULT_KEYFRAME_INTERVAL_SECS as u64),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
        }
    }
}

impl SegmentedVideoEncoder {
    pub fn init(
        base_path: PathBuf,
        video_config: VideoInfo,
        config: SegmentedVideoEncoderConfig,
    ) -> Result<Self, InitError> {
        std::fs::create_dir_all(&base_path)?;

        let manifest_path = base_path.join("dash_manifest.mpd");

        #[cfg(target_os = "windows")]
        let manifest_path_str = manifest_path.to_string_lossy().replace('\\', "/");
        #[cfg(not(target_os = "windows"))]
        let manifest_path_str = manifest_path.to_string_lossy().to_string();

        let mut output = format::output_as(&manifest_path_str, "dash")?;

        let init_seg_str = INIT_SEGMENT_NAME;
        let media_seg_str = "segment_$Number%03d$.m4s";

        unsafe {
            let opts = output.as_mut_ptr();

            let set_opt = |key: &str, value: &str| {
                let k = CString::new(key).unwrap();
                let v = CString::new(value).unwrap();
                ffmpeg::ffi::av_opt_set((*opts).priv_data, k.as_ptr(), v.as_ptr(), 0);
            };

            set_opt("init_seg_name", init_seg_str);
            set_opt("media_seg_name", media_seg_str);
            set_opt(
                "seg_duration",
                &config.segment_duration.as_secs_f64().to_string(),
            );
            set_opt("use_timeline", "0");
            set_opt("use_template", "1");
            set_opt("single_file", "0");
            set_opt("hls_playlist", "1");
        }

        let mut builder = H264EncoderBuilder::new(video_config)
            .with_preset(config.preset)
            .with_bpp(config.bpp);

        if let Some((width, height)) = config.output_size {
            builder = builder.with_output_size(width, height)?;
        }

        let encoder = builder.build(&mut output)?;

        output.write_header()?;

        let init_path = base_path.join(INIT_SEGMENT_NAME);
        let manifest_exists = manifest_path.exists();
        let init_exists = init_path.exists();
        tracing::debug!(
            manifest_path = %manifest_path.display(),
            manifest_exists = manifest_exists,
            init_path = %init_path.display(),
            init_exists = init_exists,
            "FFmpeg DASH muxer state after write_header()"
        );

        let codec_info = CodecInfo {
            width: video_config.width,
            height: video_config.height,
            frame_rate_num: video_config.frame_rate.0,
            frame_rate_den: video_config.frame_rate.1,
            time_base_num: video_config.time_base.0,
            time_base_den: video_config.time_base.1,
            pixel_format: format!("{:?}", video_config.pixel_format),
        };

        tracing::info!(
            path = %base_path.display(),
            segment_duration_secs = config.segment_duration.as_secs(),
            width = codec_info.width,
            height = codec_info.height,
            "Initialized segmented video encoder with FFmpeg DASH muxer (init.mp4 + m4s segments). CRITICAL: init.mp4 is required for segment playback/recovery."
        );

        let instance = Self {
            base_path,
            encoder,
            output,
            current_index: 1,
            segment_duration: config.segment_duration,
            segment_start_time: None,
            last_frame_timestamp: None,
            frames_in_segment: 0,
            completed_segments: Vec::new(),
            codec_info,
            disk_space_callback: None,
            last_disk_check: None,
        };

        instance.write_in_progress_manifest();

        Ok(instance)
    }

    pub fn set_disk_space_callback(&mut self, callback: DiskSpaceCallback) {
        self.disk_space_callback = Some(callback);
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Video,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        let segment_start = match self.segment_start_time {
            Some(start) => start,
            None => {
                self.segment_start_time = Some(timestamp);
                timestamp
            }
        };

        self.last_frame_timestamp = Some(timestamp);

        self.encoder
            .queue_frame(frame, timestamp, &mut self.output)?;
        self.frames_in_segment += 1;

        let elapsed_in_segment = timestamp.saturating_sub(segment_start);
        if elapsed_in_segment >= self.segment_duration {
            self.on_segment_boundary(self.current_index, timestamp);
        }

        Ok(())
    }

    fn on_segment_boundary(&mut self, completed_index: u32, timestamp: Duration) {
        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);

        let segment_path = self
            .base_path
            .join(format!("segment_{completed_index:03}.m4s"));

        tracing::debug!(
            segment_index = completed_index,
            duration_secs = segment_duration.as_secs_f64(),
            frames = self.frames_in_segment,
            "Segment boundary reached (time-based)"
        );

        self.completed_segments.push(VideoSegmentInfo {
            path: segment_path,
            index: completed_index,
            duration: segment_duration,
            file_size: None,
        });

        self.current_index = completed_index + 1;
        self.segment_start_time = Some(timestamp);
        self.frames_in_segment = 0;

        self.check_disk_space();
    }

    fn check_disk_space(&mut self) {
        let should_check = self
            .last_disk_check
            .map(|t| t.elapsed() >= DISK_SPACE_CHECK_INTERVAL)
            .unwrap_or(true);

        if !should_check {
            return;
        }

        self.last_disk_check = Some(std::time::Instant::now());

        if let Some(available_mb) = get_available_disk_space_mb(&self.base_path) {
            if available_mb < DISK_SPACE_CRITICAL_MB {
                tracing::error!(
                    available_mb,
                    path = %self.base_path.display(),
                    "Disk space critically low during fragmented recording"
                );
                if let Some(ref callback) = self.disk_space_callback {
                    callback(DiskSpaceWarning {
                        available_mb,
                        threshold_mb: DISK_SPACE_CRITICAL_MB,
                        path: self.base_path.display().to_string(),
                        is_critical: true,
                    });
                }
            } else if available_mb < DISK_SPACE_WARNING_MB {
                tracing::warn!(
                    available_mb,
                    path = %self.base_path.display(),
                    "Disk space low during fragmented recording"
                );
                if let Some(ref callback) = self.disk_space_callback {
                    callback(DiskSpaceWarning {
                        available_mb,
                        threshold_mb: DISK_SPACE_WARNING_MB,
                        path: self.base_path.display().to_string(),
                        is_critical: false,
                    });
                }
            }
        }
    }

    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("segment_{:03}.m4s", self.current_index))
    }

    fn write_in_progress_manifest(&self) {
        let mut segments: Vec<SegmentEntry> = self
            .completed_segments
            .iter()
            .map(|s| SegmentEntry {
                path: s
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                index: s.index,
                duration: s.duration.as_secs_f64(),
                is_complete: true,
                file_size: s.file_size,
            })
            .collect();

        segments.push(SegmentEntry {
            path: self
                .current_segment_path()
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            index: self.current_index,
            duration: 0.0,
            is_complete: false,
            file_size: None,
        });

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            manifest_type: "m4s_segments",
            init_segment: Some(INIT_SEGMENT_NAME.to_string()),
            codec_info: Some(self.codec_info.clone()),
            segments,
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = atomic_write_json(&manifest_path, &manifest) {
            tracing::warn!(
                "Failed to write in-progress manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    pub fn finish(&mut self) -> Result<(), FinishError> {
        let segment_start = self.segment_start_time;
        let last_timestamp = self.last_frame_timestamp;
        let frames_before_flush = self.frames_in_segment;

        if let Err(e) = self.encoder.flush(&mut self.output) {
            tracing::warn!("Video encoder flush warning: {e}");
        }

        if let Err(e) = self.output.write_trailer() {
            tracing::warn!("Video write_trailer warning: {e}");
        }

        self.finalize_pending_tmp_files();

        let end_timestamp =
            last_timestamp.unwrap_or_else(|| segment_start.unwrap_or(Duration::ZERO));
        self.collect_orphaned_segments(segment_start, end_timestamp, frames_before_flush);

        self.finalize_manifest();

        Ok(())
    }

    pub fn finish_with_timestamp(&mut self, timestamp: Duration) -> Result<(), FinishError> {
        let segment_start = self.segment_start_time;
        let frames_before_flush = self.frames_in_segment;

        if let Err(e) = self.encoder.flush(&mut self.output) {
            tracing::warn!("Video encoder flush warning: {e}");
        }

        if let Err(e) = self.output.write_trailer() {
            tracing::warn!("Video write_trailer warning: {e}");
        }

        self.finalize_pending_tmp_files();

        let effective_end_timestamp = self
            .last_frame_timestamp
            .map(|last| last.max(timestamp))
            .unwrap_or(timestamp);

        self.collect_orphaned_segments(segment_start, effective_end_timestamp, frames_before_flush);

        self.finalize_manifest();

        Ok(())
    }

    fn finalize_pending_tmp_files(&self) {
        let Ok(entries) = std::fs::read_dir(&self.base_path) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str())
                && name.starts_with("segment_")
                && name.ends_with(".m4s.tmp")
                && let Ok(metadata) = std::fs::metadata(&path)
                && metadata.len() > 0
            {
                let final_name = name.trim_end_matches(".tmp");
                let final_path = self.base_path.join(final_name);
                let file_size = metadata.len();

                let rename_result = Self::rename_with_retry(&path, &final_path);

                match rename_result {
                    Ok(()) => {
                        tracing::debug!(
                            "Finalized pending segment: {} ({} bytes)",
                            final_path.display(),
                            file_size
                        );
                        sync_file(&final_path);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to rename tmp segment {} to {}: {}",
                            path.display(),
                            final_path.display(),
                            e
                        );
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
        const MAX_RETRIES: u32 = 10;
        const RETRY_DELAY_MS: u64 = 50;

        let mut last_error = None;
        for attempt in 0..MAX_RETRIES {
            match std::fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let is_sharing_violation =
                        e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33);

                    if !is_sharing_violation {
                        return Err(e);
                    }

                    if attempt < MAX_RETRIES - 1 {
                        tracing::trace!(
                            "Rename attempt {} failed (file locked), retrying in {}ms",
                            attempt + 1,
                            RETRY_DELAY_MS
                        );
                        std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                    }
                    last_error = Some(e);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| std::io::Error::other("rename failed after retries")))
    }

    #[cfg(not(target_os = "windows"))]
    fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }

    fn collect_orphaned_segments(
        &mut self,
        segment_start: Option<Duration>,
        end_timestamp: Duration,
        frames_before_flush: u32,
    ) {
        let completed_indices: std::collections::HashSet<u32> =
            self.completed_segments.iter().map(|s| s.index).collect();

        let Ok(entries) = std::fs::read_dir(&self.base_path) else {
            return;
        };

        let mut orphaned: Vec<(u32, PathBuf)> = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str())
                && name.starts_with("segment_")
                && name.ends_with(".m4s")
                && !name.contains(".tmp")
                && let Some(index_str) = name
                    .strip_prefix("segment_")
                    .and_then(|s| s.strip_suffix(".m4s"))
                && let Ok(index) = index_str.parse::<u32>()
                && !completed_indices.contains(&index)
            {
                orphaned.push((index, path));
            }
        }

        orphaned.sort_by_key(|(idx, _)| *idx);

        for (index, segment_path) in orphaned {
            if let Ok(metadata) = std::fs::metadata(&segment_path) {
                let file_size = metadata.len();

                if file_size < 100 {
                    tracing::debug!(
                        "Skipping tiny orphaned segment {} ({} bytes)",
                        segment_path.display(),
                        file_size
                    );
                    continue;
                }

                sync_file(&segment_path);

                let duration = if index == self.current_index && frames_before_flush > 0 {
                    if let Some(start) = segment_start {
                        end_timestamp.saturating_sub(start)
                    } else {
                        self.segment_duration
                    }
                } else {
                    self.segment_duration
                };

                tracing::info!(
                    "Recovered orphaned segment {} with {} bytes, estimated duration {:?}",
                    segment_path.display(),
                    file_size,
                    duration
                );

                self.completed_segments.push(VideoSegmentInfo {
                    path: segment_path,
                    index,
                    duration,
                    file_size: Some(file_size),
                });
            }
        }

        self.completed_segments.sort_by_key(|s| s.index);
    }

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            manifest_type: "m4s_segments",
            init_segment: Some(INIT_SEGMENT_NAME.to_string()),
            codec_info: Some(self.codec_info.clone()),
            segments: self
                .completed_segments
                .iter()
                .map(|s| SegmentEntry {
                    path: s
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    index: s.index,
                    duration: s.duration.as_secs_f64(),
                    is_complete: true,
                    file_size: s.file_size,
                })
                .collect(),
            total_duration: Some(total_duration.as_secs_f64()),
            is_complete: true,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = atomic_write_json(&manifest_path, &manifest) {
            tracing::warn!(
                "Failed to write final manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    pub fn completed_segments(&self) -> &[VideoSegmentInfo] {
        &self.completed_segments
    }

    pub fn current_encoder(&self) -> Option<&H264Encoder> {
        Some(&self.encoder)
    }

    pub fn current_encoder_mut(&mut self) -> Option<&mut H264Encoder> {
        Some(&mut self.encoder)
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn segment_duration(&self) -> Duration {
        self.segment_duration
    }

    pub fn current_index(&self) -> u32 {
        self.current_index
    }

    pub fn init_segment_path(&self) -> PathBuf {
        self.base_path.join(INIT_SEGMENT_NAME)
    }

    pub fn validate_init_segment(&self) -> Result<(), String> {
        let init_path = self.init_segment_path();

        if !init_path.exists() {
            return Err(format!(
                "CRITICAL: init.mp4 is missing at {}. M4S segments will be unplayable without it!",
                init_path.display()
            ));
        }

        match std::fs::metadata(&init_path) {
            Ok(metadata) => {
                let size = metadata.len();
                if size < 100 {
                    return Err(format!(
                        "CRITICAL: init.mp4 at {} is too small ({} bytes). It may be corrupted!",
                        init_path.display(),
                        size
                    ));
                }
                Ok(())
            }
            Err(e) => Err(format!(
                "CRITICAL: Cannot read init.mp4 metadata at {}: {}",
                init_path.display(),
                e
            )),
        }
    }
}
