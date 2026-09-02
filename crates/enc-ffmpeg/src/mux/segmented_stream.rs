use super::fragment_metadata::read_fragment_metadata;
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
    if let Err(e) = crate::sync_media_file(path) {
        tracing::warn!("File fsync failed for {}: {e}", path.display());
    }
}

#[derive(Debug, Clone)]
pub struct SegmentCompletedEvent {
    pub path: PathBuf,
    pub index: u32,
    pub duration: f64,
    pub file_size: u64,
    pub is_init: bool,
    pub media_type: SegmentMediaType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentMediaType {
    Video,
    Audio,
}

pub struct SegmentedVideoEncoder {
    base_path: PathBuf,

    encoder: H264Encoder,
    output: format::context::Output,

    current_index: u32,
    segment_duration: Duration,

    completed_segments: Vec<VideoSegmentInfo>,

    frames_since_segment_scan: u32,

    codec_info: CodecInfo,

    disk_space_callback: Option<DiskSpaceCallback>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    init_notified: bool,
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
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

pub struct SegmentedVideoEncoderConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    /// On macOS, try to open the encoder for zero-copy VideoToolbox input
    /// (IOSurface-backed NV12 CVPixelBuffers queued via
    /// [`SegmentedVideoEncoder::queue_hw_pixel_buffer`]) before falling back
    /// to the software-frame path. Ignored on other platforms.
    pub prefer_videotoolbox_hw_input: bool,
}

impl Default for SegmentedVideoEncoderConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(DEFAULT_KEYFRAME_INTERVAL_SECS as u64),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            prefer_videotoolbox_hw_input: false,
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

        let mut output = super::dash_output::create(&manifest_path_str)?;

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
            set_opt("use_timeline", "1");
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

        #[cfg(target_os = "macos")]
        let hw_attempt = if config.prefer_videotoolbox_hw_input {
            match builder.clone().build_videotoolbox_hw_input(&mut output) {
                Ok(encoder) => Some(encoder),
                Err(error) => {
                    tracing::info!(
                        %error,
                        "VideoToolbox zero-copy input unavailable, using software frame path"
                    );
                    None
                }
            }
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let hw_attempt: Option<H264Encoder> = None;

        let encoder = match hw_attempt {
            Some(encoder) => encoder,
            None => builder.build(&mut output)?,
        };

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
            "Initialized segmented video encoder with FFmpeg DASH muxer (init.mp4 + m4s segments)"
        );

        let instance = Self {
            base_path,
            encoder,
            output,
            current_index: 1,
            segment_duration: config.segment_duration,
            completed_segments: Vec::new(),
            frames_since_segment_scan: 0,
            codec_info,
            disk_space_callback: None,
            segment_tx: None,
            init_notified: false,
        };

        instance.write_in_progress_manifest();

        Ok(instance)
    }

    pub fn set_disk_space_callback(&mut self, callback: DiskSpaceCallback) {
        self.disk_space_callback = Some(callback);
    }

    pub fn set_segment_callback(&mut self, tx: std::sync::mpsc::Sender<SegmentCompletedEvent>) {
        self.segment_tx = Some(tx);
        self.try_notify_init_segment();
    }

    fn try_notify_init_segment(&mut self) {
        if self.init_notified {
            return;
        }
        let init_path = self.init_segment_path();
        if let Ok(meta) = std::fs::metadata(&init_path)
            && meta.len() > 0
        {
            self.init_notified = true;
            self.notify_segment(SegmentCompletedEvent {
                path: init_path,
                index: 0,
                duration: 0.0,
                file_size: meta.len(),
                is_init: true,
                media_type: SegmentMediaType::Video,
            });
        }
    }

    /// Whether frames should be queued as CVPixelBuffers via
    /// [`Self::queue_hw_pixel_buffer`] instead of software frames.
    #[cfg(target_os = "macos")]
    pub fn is_videotoolbox_hw_input(&self) -> bool {
        self.encoder.is_videotoolbox_hw_input()
    }

    /// Queues an IOSurface-backed NV12 `CVPixelBufferRef` without copying its
    /// planes. Only valid when [`Self::is_videotoolbox_hw_input`] is true.
    ///
    /// # Safety
    /// `pixel_buffer` must be a valid `CVPixelBufferRef` matching the
    /// encoder's dimensions with a biplanar 4:2:0 pixel format.
    #[cfg(target_os = "macos")]
    pub unsafe fn queue_hw_pixel_buffer(
        &mut self,
        pixel_buffer: *mut std::ffi::c_void,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        let frame = unsafe { self.encoder.wrap_videotoolbox_pixel_buffer(pixel_buffer) }
            .map_err(InitError::Encoder)?;
        self.queue_frame(frame, timestamp)
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Video,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        // Encode with the frame's real capture-derived timestamp. The encoder
        // anchors pts at the first frame, so capture gaps (static content,
        // stream restarts, dropped frames) stay in the timeline instead of
        // compressing it and drifting video ahead of audio.
        self.encoder
            .queue_frame(frame, timestamp, &mut self.output)?;

        // The encoder holds one packet back to stamp real durations, so the
        // init segment materializes a frame later than the first queue call;
        // keep trying until it lands (no-op once notified).
        self.try_notify_init_segment();

        self.frames_since_segment_scan += 1;
        if self.frames_since_segment_scan >= 10 {
            self.frames_since_segment_scan = 0;
            self.flush_pending_segments();
        }

        Ok(())
    }

    fn notify_segment(&self, event: SegmentCompletedEvent) {
        if let Some(tx) = &self.segment_tx
            && let Err(e) = tx.send(event)
        {
            tracing::warn!("Failed to send segment completed event: {e}");
        }
    }

    fn flush_pending_segments(&mut self) {
        let first_index = self.current_index;
        loop {
            let index = self.current_index;
            let segment_path = self.base_path.join(format!("segment_{index:03}.m4s"));
            let metadata = match read_fragment_metadata(&segment_path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::debug!(index, %error, "Waiting for finalized segment media");
                    }
                    break;
                }
            };

            self.completed_segments.push(VideoSegmentInfo {
                path: segment_path.clone(),
                index,
                duration: metadata.duration,
                file_size: Some(metadata.file_size),
            });
            self.notify_segment(SegmentCompletedEvent {
                path: segment_path,
                index,
                duration: metadata.duration.as_secs_f64(),
                file_size: metadata.file_size,
                is_init: false,
                media_type: SegmentMediaType::Video,
            });
            self.current_index += 1;
        }

        if self.current_index != first_index {
            self.write_in_progress_manifest();
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
        let flush_result = self.encoder.flush(&mut self.output).inspect_err(|error| {
            tracing::warn!(%error, "Video encoder flush failed");
        });
        let trailer_result = self.output.write_trailer().inspect_err(|error| {
            tracing::warn!(%error, "Video trailer publication failed");
        });

        self.try_notify_init_segment();
        self.finalize_pending_tmp_files();
        self.flush_pending_segments();

        self.collect_orphaned_segments();

        if let Err(error) = flush_result.and(trailer_result) {
            self.write_in_progress_manifest();
            return Err(error.into());
        }
        if let Err(error) = super::dash_output::verify_final_manifest(&self.base_path) {
            self.write_in_progress_manifest();
            return Err(error.into());
        }
        self.finalize_manifest()?;

        Ok(())
    }

    pub fn finish_with_timestamp(&mut self, _timestamp: Duration) -> Result<(), FinishError> {
        self.finish()
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
                && let Ok(metadata) = read_fragment_metadata(&path)
            {
                let final_name = name.trim_end_matches(".tmp");
                let final_path = self.base_path.join(final_name);
                let file_size = metadata.file_size;

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

    fn collect_orphaned_segments(&mut self) {
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
            let metadata = match read_fragment_metadata(&segment_path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::warn!(index, %error, "Cannot finalize invalid segment media");
                    continue;
                }
            };
            sync_file(&segment_path);
            self.completed_segments.push(VideoSegmentInfo {
                path: segment_path.clone(),
                index,
                duration: metadata.duration,
                file_size: Some(metadata.file_size),
            });
            self.notify_segment(SegmentCompletedEvent {
                path: segment_path,
                index,
                duration: metadata.duration.as_secs_f64(),
                file_size: metadata.file_size,
                is_init: false,
                media_type: SegmentMediaType::Video,
            });
        }

        self.completed_segments.sort_by_key(|s| s.index);
    }

    fn finalize_manifest(&self) -> std::io::Result<()> {
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
        atomic_write_json(&manifest_path, &manifest)
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
                "init.mp4 is missing at {}. M4S segments will be unplayable without it.",
                init_path.display()
            ));
        }

        match std::fs::metadata(&init_path) {
            Ok(metadata) => {
                let size = metadata.len();
                if size < 100 {
                    return Err(format!(
                        "init.mp4 at {} is too small ({} bytes). It may be corrupted.",
                        init_path.display(),
                        size
                    ));
                }
                Ok(())
            }
            Err(e) => Err(format!(
                "Cannot read init.mp4 metadata at {}: {}",
                init_path.display(),
                e
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::VideoInfo;
    use std::sync::mpsc;

    fn test_video_info() -> VideoInfo {
        VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width: 320,
            height: 240,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        }
    }

    fn create_test_frame(width: u32, height: u32) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
        for plane_idx in 0..frame.planes() {
            let data = frame.data_mut(plane_idx);
            for byte in data.iter_mut() {
                *byte = 128;
            }
        }
        frame
    }

    #[test]
    fn video_manifest_and_events_match_muxer_playlist() {
        ffmpeg::init().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();
        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        encoder.set_segment_callback(tx);
        let mut snapshots = Vec::new();
        for i in 0..200 {
            encoder
                .queue_frame(
                    create_test_frame(320, 240),
                    Duration::from_micros(i * 33_320),
                )
                .unwrap();
            for event in rx.try_iter().filter(|event| !event.is_init) {
                assert_eq!(event.path.extension().unwrap(), "m4s");
                let bytes = std::fs::read(&event.path).unwrap();
                snapshots.push((event, bytes));
            }
        }
        encoder
            .finish_with_timestamp(Duration::from_secs(9))
            .unwrap();
        for event in rx.try_iter().filter(|event| !event.is_init) {
            let bytes = std::fs::read(&event.path).unwrap();
            snapshots.push((event, bytes));
        }

        let playlist = std::fs::read_to_string(base_path.join("media_0.m3u8")).unwrap();
        let durations: Vec<f64> = playlist
            .lines()
            .filter_map(|line| line.strip_prefix("#EXTINF:"))
            .map(|line| line.trim_end_matches(',').parse().unwrap())
            .collect();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(base_path.join("manifest.json")).unwrap())
                .unwrap();
        let segments = manifest["segments"].as_array().unwrap();
        assert!(durations.len() >= 2);
        assert_eq!(snapshots.len(), durations.len());
        assert_eq!(segments.len(), durations.len());
        for ((event, bytes), (segment, duration)) in
            snapshots.iter().zip(segments.iter().zip(&durations))
        {
            assert_eq!(*bytes, std::fs::read(&event.path).unwrap());
            assert_eq!(event.file_size, bytes.len() as u64);
            assert_eq!(event.index, segment["index"].as_u64().unwrap() as u32);
            assert!((event.duration - duration).abs() <= 1e-6);
            assert!((segment["duration"].as_f64().unwrap() - duration).abs() <= 1e-6);
        }
        assert!(
            (manifest["total_duration"].as_f64().unwrap() - durations.iter().sum::<f64>()).abs()
                <= 1e-5
        );
    }

    #[test]
    fn failed_dash_manifest_publication_retains_video_without_claiming_completion() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().to_path_buf();
        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();
        for i in 0..600 {
            encoder
                .queue_frame(
                    create_test_frame(320, 240),
                    Duration::from_secs_f64(f64::from(i) / 30.0),
                )
                .unwrap();
            if !encoder.completed_segments().is_empty() {
                break;
            }
        }
        let retained_segments: Vec<_> = encoder
            .completed_segments()
            .iter()
            .map(|segment| (segment.path.clone(), std::fs::read(&segment.path).unwrap()))
            .collect();
        assert!(
            !retained_segments.is_empty(),
            "Video encoder did not publish a complete segment within 600 frames"
        );
        let manifest_path = base_path.join("dash_manifest.mpd");
        if manifest_path.exists() {
            std::fs::remove_file(&manifest_path).unwrap();
        }
        std::fs::create_dir(&manifest_path).unwrap();

        assert!(encoder.finish().is_err());

        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(base_path.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["is_complete"], false);
        assert!(!encoder.completed_segments().is_empty());
        assert!(encoder.init_segment_path().is_file());
        for (path, bytes) in retained_segments {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn segment_callback_fires_for_init_segment() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let (tx, _rx) = mpsc::channel::<SegmentCompletedEvent>();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path,
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_secs(1),
                ..Default::default()
            },
        )
        .unwrap();
        encoder.set_segment_callback(tx);

        let frame = create_test_frame(320, 240);
        encoder
            .queue_frame(frame, Duration::from_millis(0))
            .unwrap();

        let init_exists = encoder.init_segment_path().exists();
        assert!(init_exists, "init.mp4 should exist after first frame");
    }

    #[test]
    fn segment_callback_fires_on_boundary() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(100),
                ..Default::default()
            },
        )
        .unwrap();
        encoder.set_segment_callback(tx);

        for i in 0..30 {
            let frame = create_test_frame(320, 240);
            let ts = Duration::from_millis(i * 33);
            encoder.queue_frame(frame, ts).unwrap();
        }

        encoder.finish().unwrap();

        let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

        let non_init_events: Vec<&SegmentCompletedEvent> =
            events.iter().filter(|e| !e.is_init).collect();
        assert!(
            !non_init_events.is_empty(),
            "should have at least one segment boundary event"
        );

        for event in &non_init_events {
            assert_eq!(event.media_type, SegmentMediaType::Video);
            assert!(!event.is_init);
            assert!(event.duration > 0.0);
        }

        let all_video = events
            .iter()
            .all(|e| e.media_type == SegmentMediaType::Video);
        assert!(all_video, "all events should be video type");
    }

    #[test]
    fn encoded_pts_preserve_capture_timestamps_across_gaps() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(500),
                ..Default::default()
            },
        )
        .unwrap();

        // Three frames at ~30fps, a 1.9s capture gap (static screen /
        // stream restart), then three more frames. The encoded pts must
        // reflect the gap instead of collapsing to a frame-counter grid,
        // otherwise every dropped frame desyncs video from audio.
        let timestamps_ms: [u64; 6] = [0, 33, 66, 2000, 2033, 2066];
        for ts_ms in timestamps_ms {
            let frame = create_test_frame(320, 240);
            encoder
                .queue_frame(frame, Duration::from_millis(ts_ms))
                .unwrap();
        }

        encoder.finish().unwrap();

        // fMP4 segments concatenated after the init segment form a valid mp4.
        let mut segment_paths: Vec<PathBuf> = std::fs::read_dir(&base_path)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segment_paths.sort();
        assert!(
            !segment_paths.is_empty(),
            "encoder should have produced media segments"
        );

        let concat_path = base_path.join("concat_test.mp4");
        let mut concatenated = std::fs::read(base_path.join(INIT_SEGMENT_NAME)).unwrap();
        for segment in &segment_paths {
            concatenated.extend(std::fs::read(segment).unwrap());
        }
        std::fs::write(&concat_path, concatenated).unwrap();

        let mut input = format::input(&concat_path).unwrap();
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .index();
        let time_base = input.stream(stream_index).unwrap().time_base();
        let tb = time_base.numerator() as f64 / time_base.denominator() as f64;

        let mut pts_secs: Vec<f64> = input
            .packets()
            .filter_map(|(stream, packet)| {
                (stream.index() == stream_index)
                    .then_some(packet.pts())
                    .flatten()
            })
            .map(|pts| pts as f64 * tb)
            .collect();
        pts_secs.sort_by(|a, b| a.partial_cmp(b).unwrap());

        assert_eq!(pts_secs.len(), timestamps_ms.len());

        for (pts, expected_ms) in pts_secs.iter().zip(timestamps_ms) {
            let expected = expected_ms as f64 / 1000.0;
            assert!(
                (pts - expected).abs() < 0.005,
                "encoded pts {pts:.3}s should match capture timestamp {expected:.3}s \
                 (all pts: {pts_secs:?})"
            );
        }
    }

    // A capture gap whose post-gap frame lands on a segment cut: the dash
    // muxer anchors each fragment at the accumulated duration of the previous
    // one, and the last sample of a fragment takes its packet duration
    // verbatim. Without real packet durations the first post-gap frame is
    // pulled back onto the pre-gap timeline (one frame period after the last
    // pre-gap frame) and its content plays DURING the gap — a multi-second
    // desync for that frame and a collapsed hold for the viewer.
    #[test]
    fn gap_crossing_segment_cut_preserves_post_gap_pts() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(500),
                ..Default::default()
            },
        )
        .unwrap();

        // ~30fps up to 0.4s, a 2.6s gap, then more frames. The post-gap
        // frame is forced to a keyframe so the dash muxer cuts the segment
        // exactly at the gap — the shape that loses the gap.
        let pre_gap_ms: Vec<u64> = (0..12).map(|i| i * 33).collect();
        let post_gap_ms: Vec<u64> = (0..12).map(|i| 3000 + i * 33).collect();
        for &ts_ms in &pre_gap_ms {
            let frame = create_test_frame(320, 240);
            encoder
                .queue_frame(frame, Duration::from_millis(ts_ms))
                .unwrap();
        }
        for (i, &ts_ms) in post_gap_ms.iter().enumerate() {
            let mut frame = create_test_frame(320, 240);
            if i == 0 {
                frame.set_kind(ffmpeg::picture::Type::I);
            }
            encoder
                .queue_frame(frame, Duration::from_millis(ts_ms))
                .unwrap();
        }

        encoder.finish().unwrap();

        let mut segment_paths: Vec<PathBuf> = std::fs::read_dir(&base_path)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segment_paths.sort();

        let concat_path = base_path.join("concat_test.mp4");
        let mut concatenated = std::fs::read(base_path.join(INIT_SEGMENT_NAME)).unwrap();
        for segment in &segment_paths {
            concatenated.extend(std::fs::read(segment).unwrap());
        }
        std::fs::write(&concat_path, concatenated).unwrap();

        let mut input = format::input(&concat_path).unwrap();
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .index();
        let time_base = input.stream(stream_index).unwrap().time_base();
        let tb = time_base.numerator() as f64 / time_base.denominator() as f64;

        let mut pts_secs: Vec<f64> = input
            .packets()
            .filter_map(|(stream, packet)| {
                (stream.index() == stream_index)
                    .then_some(packet.pts())
                    .flatten()
            })
            .map(|pts| pts as f64 * tb)
            .collect();
        pts_secs.sort_by(|a, b| a.partial_cmp(b).unwrap());

        assert_eq!(pts_secs.len(), pre_gap_ms.len() + post_gap_ms.len());

        let expected: Vec<f64> = pre_gap_ms
            .iter()
            .chain(post_gap_ms.iter())
            .map(|&ms| ms as f64 / 1000.0)
            .collect();
        for (pts, expected) in pts_secs.iter().zip(&expected) {
            assert!(
                (pts - expected).abs() < 0.04,
                "encoded pts {pts:.3}s should match capture timestamp {expected:.3}s \
                 (all pts: {pts_secs:?})"
            );
        }
    }

    #[test]
    fn manifest_updated_on_segment_boundary() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(100),
                ..Default::default()
            },
        )
        .unwrap();

        for i in 0..15 {
            let frame = create_test_frame(320, 240);
            let ts = Duration::from_millis(i * 33);
            encoder.queue_frame(frame, ts).unwrap();
        }

        let manifest_path = base_path.join("manifest.json");
        assert!(manifest_path.exists(), "manifest.json should exist");

        let manifest_content = std::fs::read_to_string(&manifest_path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest_content).unwrap();

        assert_eq!(manifest["version"], 5);
        assert_eq!(manifest["type"], "m4s_segments");
        assert!(manifest["init_segment"].is_string());
        assert!(!manifest["is_complete"].as_bool().unwrap());

        encoder.finish().unwrap();

        let final_content = std::fs::read_to_string(&manifest_path).unwrap();
        let final_manifest: serde_json::Value = serde_json::from_str(&final_content).unwrap();
        assert!(final_manifest["is_complete"].as_bool().unwrap());
    }

    #[test]
    fn init_segment_is_valid_after_creation() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path,
            test_video_info(),
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();

        // The encoder holds one packet to stamp real durations (and hardware
        // encoders add their own delay), so the init segment lands once
        // enough frames have pushed the first packet through.
        for i in 0..10u64 {
            let frame = create_test_frame(320, 240);
            encoder
                .queue_frame(frame, Duration::from_millis(i * 33))
                .unwrap();
        }

        assert!(encoder.validate_init_segment().is_ok());
    }

    #[test]
    fn segment_events_contain_correct_indices() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(50),
                ..Default::default()
            },
        )
        .unwrap();
        encoder.set_segment_callback(tx);

        for i in 0..60 {
            let frame = create_test_frame(320, 240);
            let ts = Duration::from_millis(i * 33);
            encoder.queue_frame(frame, ts).unwrap();
        }

        encoder.finish().unwrap();

        let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();
        let boundary_events: Vec<&SegmentCompletedEvent> =
            events.iter().filter(|e| !e.is_init).collect();

        if boundary_events.len() >= 2 {
            for i in 1..boundary_events.len() {
                assert!(
                    boundary_events[i].index > boundary_events[i - 1].index,
                    "segment indices should be strictly increasing"
                );
            }
        }
    }

    #[test]
    fn jittery_capture_timestamps_still_produce_decodable_segments() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(250),
                ..Default::default()
            },
        )
        .unwrap();

        for i in 0_u64..120 {
            let frame = create_test_frame(320, 240);
            let base_ms = i * 33;
            let timestamp_ms = if i > 0 && i % 17 == 0 {
                base_ms.saturating_sub(90)
            } else if i > 0 && i % 29 == 0 {
                base_ms.saturating_sub(33)
            } else {
                base_ms
            };
            encoder
                .queue_frame(frame, Duration::from_millis(timestamp_ms))
                .unwrap();
        }

        encoder.finish().unwrap();

        let manifest_path = base_path.join("manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert!(manifest["is_complete"].as_bool().unwrap());

        let segment_paths: Vec<PathBuf> = manifest["segments"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|segment| segment["is_complete"].as_bool().unwrap_or(false))
            .filter_map(|segment| {
                let duration = segment["duration"].as_f64()?;
                assert!(
                    duration > 0.0,
                    "completed segment duration must be positive"
                );
                let path = base_path.join(segment["path"].as_str()?);
                path.exists().then_some(path)
            })
            .collect();
        assert!(!segment_paths.is_empty());

        let output_path = temp.path().join("jittery-output.mp4");
        crate::remux::concatenate_m4s_segments_with_init(
            &base_path.join(INIT_SEGMENT_NAME),
            &segment_paths,
            &output_path,
        )
        .unwrap();

        assert!(crate::remux::probe_video_can_decode(&output_path).unwrap_or(false));
    }

    #[test]
    fn stall_recovery_burst_with_same_microsecond_timestamps_survives() {
        // Replays the 0.5.8 field-failure timeline shape end to end: normal
        // cadence with nanosecond-fraction timestamps, a multi-second system
        // stall, then a recovery burst of backlogged frames landing hundreds
        // of nanoseconds apart (same microsecond, same 90kHz tick), plus an
        // exact duplicate and a backwards blip. The instant-mode encoder must
        // accept every frame, keep encoded PTS strictly monotonic, and the
        // production remux + decode of the segments must succeed.
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_millis(500),
                ..Default::default()
            },
        )
        .unwrap();

        let frame_ns = 33_333_333u64;
        let mut timestamps: Vec<Duration> = Vec::new();
        for i in 0..60u64 {
            timestamps.push(Duration::from_nanos(i * frame_ns + 400));
        }
        let stall_end = 60 * frame_ns + 2_000_000_000;
        for i in 0..12u64 {
            timestamps.push(Duration::from_nanos(stall_end + i * 300));
        }
        timestamps.push(Duration::from_nanos(stall_end + 11 * 300));
        timestamps.push(Duration::from_nanos(stall_end.saturating_sub(5_000_000)));
        for i in 1..=60u64 {
            timestamps.push(Duration::from_nanos(stall_end + i * frame_ns));
        }

        for (i, &ts) in timestamps.iter().enumerate() {
            let frame = create_test_frame(320, 240);
            encoder
                .queue_frame(frame, ts)
                .unwrap_or_else(|e| panic!("frame {i} at {ts:?} rejected: {e}"));
        }

        encoder.finish().unwrap();

        let mut segment_paths: Vec<PathBuf> = std::fs::read_dir(&base_path)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segment_paths.sort();
        assert!(
            segment_paths.len() >= 3,
            "expected multiple media segments, got {segment_paths:?}"
        );

        let concat_path = base_path.join("concat_test.mp4");
        let mut concatenated = std::fs::read(base_path.join(INIT_SEGMENT_NAME)).unwrap();
        for segment in &segment_paths {
            concatenated.extend(std::fs::read(segment).unwrap());
        }
        std::fs::write(&concat_path, concatenated).unwrap();

        let mut input = format::input(&concat_path).unwrap();
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .index();

        let mut pts_ticks: Vec<i64> = input
            .packets()
            .filter_map(|(stream, packet)| {
                (stream.index() == stream_index)
                    .then_some(packet.pts())
                    .flatten()
            })
            .collect();
        pts_ticks.sort_unstable();

        assert_eq!(
            pts_ticks.len(),
            timestamps.len(),
            "every queued frame must be encoded (ties bumped, never dropped)"
        );
        for pair in pts_ticks.windows(2) {
            assert!(
                pair[1] > pair[0],
                "encoded pts must be strictly monotonic, found {} then {} (duplicate PTS is the \
                 -16364 failure class)",
                pair[0],
                pair[1]
            );
        }

        let remuxed_path = temp.path().join("stall-burst-output.mp4");
        crate::remux::concatenate_m4s_segments_with_init(
            &base_path.join(INIT_SEGMENT_NAME),
            &segment_paths,
            &remuxed_path,
        )
        .unwrap();
        assert!(crate::remux::probe_video_can_decode(&remuxed_path).unwrap_or(false));
    }

    #[test]
    fn default_config_cuts_segments_from_encoder_keyframe_cadence() {
        // Production always runs segment_duration == the encoder GOP
        // (DEFAULT_KEYFRAME_INTERVAL_SECS), so segment cuts depend on the
        // encoder emitting keyframes at its configured cadence — no caller
        // forces I-frames. Pin that contract: if the GOP options regress
        // (g/keyint_min or the default interval), segments stop cutting and
        // this fails. Test helpers that force I-frames at shorter cadences
        // cannot catch that.
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = SegmentedVideoEncoder::init(
            base_path.clone(),
            test_video_info(),
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();

        // 6.6s at 30fps with untouched frame kinds.
        for i in 0..200u64 {
            let frame = create_test_frame(320, 240);
            encoder
                .queue_frame(frame, Duration::from_nanos(i * 33_333_333))
                .unwrap();
        }
        encoder.finish().unwrap();

        let mut segment_paths: Vec<PathBuf> = std::fs::read_dir(&base_path)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segment_paths.sort();
        assert!(
            (2..=5).contains(&segment_paths.len()),
            "6.6s at the default 2s segment/GOP cadence must cut ~3 media segments \
             from the encoder's own keyframes, got {}: {segment_paths:?}",
            segment_paths.len()
        );

        let remuxed_path = temp.path().join("default-cadence-output.mp4");
        crate::remux::concatenate_m4s_segments_with_init(
            &base_path.join(INIT_SEGMENT_NAME),
            &segment_paths,
            &remuxed_path,
        )
        .unwrap();
        let duration = crate::remux::get_media_duration(&remuxed_path)
            .expect("assembled duration readable")
            .as_secs_f64();
        assert!(
            (6.0..=7.2).contains(&duration),
            "assembled output must carry the full 6.6s of content, got {duration:.2}s"
        );
        assert!(crate::remux::probe_video_can_decode(&remuxed_path).unwrap_or(false));
    }
}
