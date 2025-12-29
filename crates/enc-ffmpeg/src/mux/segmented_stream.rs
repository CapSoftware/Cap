use cap_media_info::VideoInfo;
use ffmpeg::{format, frame};
use serde::Serialize;
use std::{
    ffi::CString,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::video::h264::{H264Encoder, H264EncoderBuilder, H264EncoderError, H264Preset};

const INIT_SEGMENT_NAME: &str = "init.mp4";

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

const MANIFEST_VERSION: u32 = 4;

#[derive(Serialize)]
struct Manifest {
    version: u32,
    #[serde(rename = "type")]
    manifest_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    init_segment: Option<String>,
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
    #[error("Encode: {0}")]
    Encode(#[from] crate::video::h264::QueueFrameError),
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
            segment_duration: Duration::from_secs(3),
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

        let mut output = format::output_as(&manifest_path, "dash")?;

        unsafe {
            let opts = output.as_mut_ptr();

            let set_opt = |key: &str, value: &str| {
                let k = CString::new(key).unwrap();
                let v = CString::new(value).unwrap();
                ffmpeg::ffi::av_opt_set((*opts).priv_data, k.as_ptr(), v.as_ptr(), 0);
            };

            set_opt("init_seg_name", INIT_SEGMENT_NAME);
            set_opt("media_seg_name", "segment_$Number%03d$.m4s");
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

        tracing::info!(
            path = %base_path.display(),
            segment_duration_secs = config.segment_duration.as_secs(),
            "Initialized segmented video encoder with FFmpeg DASH muxer (init.mp4 + m4s segments)"
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
        };

        instance.write_in_progress_manifest();

        Ok(instance)
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Video,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.segment_start_time.is_none() {
            self.segment_start_time = Some(timestamp);
        }

        self.last_frame_timestamp = Some(timestamp);

        let prev_segment_index = self.detect_current_segment_index();

        self.encoder
            .queue_frame(frame, timestamp, &mut self.output)?;
        self.frames_in_segment += 1;

        let new_segment_index = self.detect_current_segment_index();

        if new_segment_index > prev_segment_index {
            self.on_segment_completed(prev_segment_index, timestamp)?;
        }

        Ok(())
    }

    fn detect_current_segment_index(&self) -> u32 {
        let next_segment_path = self
            .base_path
            .join(format!("segment_{:03}.m4s", self.current_index + 1));
        if next_segment_path.exists() {
            self.current_index + 1
        } else {
            self.current_index
        }
    }

    fn on_segment_completed(
        &mut self,
        completed_index: u32,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        let segment_path = self
            .base_path
            .join(format!("segment_{completed_index:03}.m4s"));

        if segment_path.exists() {
            sync_file(&segment_path);

            let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
            let segment_duration = timestamp.saturating_sub(segment_start);

            let file_size = std::fs::metadata(&segment_path).ok().map(|m| m.len());

            tracing::debug!(
                segment_index = completed_index,
                duration_secs = segment_duration.as_secs_f64(),
                file_size = ?file_size,
                frames = self.frames_in_segment,
                "Segment completed"
            );

            self.completed_segments.push(VideoSegmentInfo {
                path: segment_path,
                index: completed_index,
                duration: segment_duration,
                file_size,
            });

            self.current_index = completed_index + 1;
            self.segment_start_time = Some(timestamp);
            self.frames_in_segment = 0;

            self.write_manifest();
            self.write_in_progress_manifest();
        }

        Ok(())
    }

    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("segment_{:03}.m4s", self.current_index))
    }

    fn write_manifest(&self) {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            manifest_type: "m4s_segments",
            init_segment: Some(INIT_SEGMENT_NAME.to_string()),
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
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = atomic_write_json(&manifest_path, &manifest) {
            tracing::warn!(
                "Failed to write manifest to {}: {e}",
                manifest_path.display()
            );
        }
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

                if let Err(e) = std::fs::rename(&path, &final_path) {
                    tracing::warn!(
                        "Failed to rename tmp segment {} to {}: {}",
                        path.display(),
                        final_path.display(),
                        e
                    );
                } else {
                    tracing::debug!(
                        "Finalized pending segment: {} ({} bytes)",
                        final_path.display(),
                        metadata.len()
                    );
                    sync_file(&final_path);
                }
            }
        }
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
}
