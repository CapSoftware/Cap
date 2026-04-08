use crate::audio::aac::{AACEncoder, AACEncoderError};
use crate::mux::segmented_stream::{SegmentCompletedEvent, SegmentMediaType};
use cap_media_info::AudioInfo;
use ffmpeg::{format, frame};
use serde::Serialize;
use std::{
    ffi::CString,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

const INIT_SEGMENT_NAME: &str = "init.mp4";
const MANIFEST_VERSION: u32 = 2;

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

pub struct DashAudioSegmentEncoder {
    base_path: PathBuf,
    encoder: AACEncoder,
    output: format::context::Output,

    current_index: u32,
    segment_duration: Duration,
    segment_start_time: Option<Duration>,
    last_frame_timestamp: Option<Duration>,
    frames_in_segment: u32,

    completed_segments: Vec<AudioSegmentInfo>,

    pending_segment_indices: Vec<(u32, Duration)>,
    frames_since_pending_flush: u32,

    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    init_notified: bool,
}

#[derive(Debug, Clone)]
pub struct AudioSegmentInfo {
    pub path: PathBuf,
    pub index: u32,
    pub duration: Duration,
    pub file_size: Option<u64>,
}

pub struct DashAudioSegmentEncoderConfig {
    pub segment_duration: Duration,
}

impl Default for DashAudioSegmentEncoderConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
        }
    }
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
    Encoder(#[from] AACEncoderError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Init: {0}")]
    Init(#[from] InitError),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
}

impl DashAudioSegmentEncoder {
    pub fn init(
        base_path: PathBuf,
        audio_config: AudioInfo,
        config: DashAudioSegmentEncoderConfig,
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
            set_opt("use_timeline", "1");
            set_opt("use_template", "1");
            set_opt("single_file", "0");
        }

        let encoder = AACEncoder::init(audio_config, &mut output)?;

        output.write_header()?;

        let init_path = base_path.join(INIT_SEGMENT_NAME);
        let init_exists = init_path.exists();

        tracing::info!(
            path = %base_path.display(),
            segment_duration_secs = config.segment_duration.as_secs(),
            init_exists = init_exists,
            "Initialized DASH audio segment encoder (init.mp4 + m4s segments)"
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
            pending_segment_indices: Vec::new(),
            frames_since_pending_flush: 0,
            segment_tx: None,
            init_notified: false,
        };

        instance.write_in_progress_manifest();

        Ok(instance)
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
                media_type: SegmentMediaType::Audio,
            });
        }
    }

    fn notify_segment(&self, event: SegmentCompletedEvent) {
        if let Some(tx) = &self.segment_tx
            && let Err(e) = tx.send(event)
        {
            tracing::warn!("Failed to send audio segment completed event: {e}");
        }
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        let is_first_frame = self.segment_start_time.is_none();
        let segment_start = match self.segment_start_time {
            Some(start) => start,
            None => {
                self.segment_start_time = Some(timestamp);
                timestamp
            }
        };

        self.last_frame_timestamp = Some(timestamp);

        self.encoder
            .send_frame(frame, timestamp, &mut self.output)?;
        self.frames_in_segment += 1;

        if is_first_frame {
            self.try_notify_init_segment();
        }

        if !self.pending_segment_indices.is_empty() {
            self.frames_since_pending_flush += 1;
            if self.frames_since_pending_flush >= 10 {
                self.frames_since_pending_flush = 0;
                self.flush_pending_segments();
            }
        }

        let elapsed_in_segment = timestamp.saturating_sub(segment_start);
        if elapsed_in_segment >= self.segment_duration {
            self.on_segment_boundary(self.current_index, timestamp);
        }

        Ok(())
    }

    fn on_segment_boundary(&mut self, completed_index: u32, timestamp: Duration) {
        self.try_notify_init_segment();

        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);

        let segment_path = self
            .base_path
            .join(format!("segment_{completed_index:03}.m4s"));

        tracing::debug!(
            segment_index = completed_index,
            duration_secs = segment_duration.as_secs_f64(),
            frames = self.frames_in_segment,
            "Audio segment boundary reached (time-based)"
        );

        self.current_index = completed_index + 1;
        self.segment_start_time = Some(timestamp);
        self.frames_in_segment = 0;

        let tmp_path = self
            .base_path
            .join(format!("segment_{completed_index:03}.m4s.tmp"));

        let (resolved_path, file_size) = if segment_path.exists() {
            let size = std::fs::metadata(&segment_path)
                .ok()
                .map(|m| m.len())
                .unwrap_or(0);
            (segment_path.clone(), size)
        } else if tmp_path.exists() {
            let size = std::fs::metadata(&tmp_path)
                .ok()
                .map(|m| m.len())
                .unwrap_or(0);
            (tmp_path, size)
        } else {
            (segment_path.clone(), 0)
        };

        let file_found = resolved_path.exists();

        if file_found && file_size > 0 {
            self.completed_segments.push(AudioSegmentInfo {
                path: segment_path.clone(),
                index: completed_index,
                duration: segment_duration,
                file_size: Some(file_size),
            });

            self.write_in_progress_manifest();

            self.notify_segment(SegmentCompletedEvent {
                path: resolved_path,
                index: completed_index,
                duration: segment_duration.as_secs_f64(),
                file_size,
                is_init: false,
                media_type: SegmentMediaType::Audio,
            });
        } else {
            tracing::debug!(
                segment_index = completed_index,
                file_exists = file_found,
                file_size,
                "Segment file not ready yet, deferring notification"
            );
            self.pending_segment_indices
                .push((completed_index, segment_duration));
            self.write_in_progress_manifest();
        }
    }

    fn flush_pending_segments(&mut self) {
        if self.pending_segment_indices.is_empty() {
            return;
        }

        let mut still_pending = Vec::new();

        for (index, duration) in std::mem::take(&mut self.pending_segment_indices) {
            let segment_path = self.base_path.join(format!("segment_{index:03}.m4s"));
            let tmp_path = self.base_path.join(format!("segment_{index:03}.m4s.tmp"));

            let (resolved_path, file_size) = if segment_path.exists() {
                let size = std::fs::metadata(&segment_path)
                    .ok()
                    .map(|m| m.len())
                    .unwrap_or(0);
                (segment_path.clone(), size)
            } else if tmp_path.exists() {
                let size = std::fs::metadata(&tmp_path)
                    .ok()
                    .map(|m| m.len())
                    .unwrap_or(0);
                (tmp_path, size)
            } else {
                still_pending.push((index, duration));
                continue;
            };

            if file_size == 0 {
                still_pending.push((index, duration));
                continue;
            }

            tracing::debug!(
                segment_index = index,
                file_size,
                "Flushing previously pending segment"
            );

            self.completed_segments.push(AudioSegmentInfo {
                path: segment_path,
                index,
                duration,
                file_size: Some(file_size),
            });

            self.notify_segment(SegmentCompletedEvent {
                path: resolved_path,
                index,
                duration: duration.as_secs_f64(),
                file_size,
                is_init: false,
                media_type: SegmentMediaType::Audio,
            });
        }

        if !still_pending.is_empty() {
            self.write_in_progress_manifest();
        }

        self.pending_segment_indices = still_pending;
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
            manifest_type: "m4s_audio_segments",
            init_segment: Some(INIT_SEGMENT_NAME.to_string()),
            segments,
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = atomic_write_json(&manifest_path, &manifest) {
            tracing::warn!(
                "Failed to write audio in-progress manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    pub fn finish(&mut self) -> Result<(), FinishError> {
        let segment_start = self.segment_start_time;
        let last_timestamp = self.last_frame_timestamp;
        let frames_before_flush = self.frames_in_segment;

        if let Err(e) = self.encoder.flush(&mut self.output) {
            tracing::warn!("Audio encoder flush warning: {e}");
        }

        if let Err(e) = self.output.write_trailer() {
            tracing::warn!("Audio write_trailer warning: {e}");
        }

        self.finalize_pending_tmp_files();
        self.flush_pending_segments();

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
            tracing::warn!("Audio encoder flush warning: {e}");
        }

        if let Err(e) = self.output.write_trailer() {
            tracing::warn!("Audio write_trailer warning: {e}");
        }

        self.finalize_pending_tmp_files();
        self.flush_pending_segments();

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

                match std::fs::rename(&path, &final_path) {
                    Ok(()) => {
                        tracing::debug!(
                            "Finalized pending audio segment: {} ({} bytes)",
                            final_path.display(),
                            file_size
                        );
                        sync_file(&final_path);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to rename tmp audio segment {} to {}: {}",
                            path.display(),
                            final_path.display(),
                            e
                        );
                    }
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
                        "Skipping tiny orphaned audio segment {} ({} bytes)",
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
                    "Recovered orphaned audio segment {} with {} bytes, estimated duration {:?}",
                    segment_path.display(),
                    file_size,
                    duration
                );

                self.completed_segments.push(AudioSegmentInfo {
                    path: segment_path.clone(),
                    index,
                    duration,
                    file_size: Some(file_size),
                });

                self.notify_segment(SegmentCompletedEvent {
                    path: segment_path,
                    index,
                    duration: duration.as_secs_f64(),
                    file_size,
                    is_init: false,
                    media_type: SegmentMediaType::Audio,
                });
            }
        }

        self.completed_segments.sort_by_key(|s| s.index);
    }

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            manifest_type: "m4s_audio_segments",
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
                "Failed to write final audio manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    pub fn completed_segments(&self) -> &[AudioSegmentInfo] {
        &self.completed_segments
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn init_segment_path(&self) -> PathBuf {
        self.base_path.join(INIT_SEGMENT_NAME)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::AudioInfo;
    use std::sync::mpsc;

    fn test_audio_info() -> AudioInfo {
        AudioInfo {
            sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            sample_rate: 48000,
            channels: 1,
            time_base: ffmpeg::Rational(1, 48000),
            buffer_size: 1024,
            is_wireless_transport: false,
        }
    }

    fn create_test_audio_frame(samples: usize, sample_num: u64) -> frame::Audio {
        let mut frame = frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            samples,
            ffmpeg::ChannelLayout::MONO,
        );
        frame.set_rate(48000);
        frame.set_pts(Some(sample_num as i64));
        let data = frame.data_mut(0);
        for (i, chunk) in data.chunks_exact_mut(4).enumerate() {
            let val: f32 = (i as f32 * 0.01).sin() * 0.5;
            chunk.copy_from_slice(&val.to_ne_bytes());
        }
        frame
    }

    #[test]
    fn dash_audio_encoder_creates_init_segment() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = DashAudioSegmentEncoder::init(
            base_path.clone(),
            test_audio_info(),
            DashAudioSegmentEncoderConfig {
                segment_duration: Duration::from_secs(1),
            },
        )
        .unwrap();

        let frame = create_test_audio_frame(1024, 0);
        encoder
            .queue_frame(frame, Duration::from_millis(0))
            .unwrap();

        let manifest_path = base_path.join("manifest.json");
        assert!(manifest_path.exists(), "manifest.json should exist");

        let content = std::fs::read_to_string(&manifest_path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(manifest["type"], "m4s_audio_segments");
        assert!(!manifest["is_complete"].as_bool().unwrap());
    }

    #[test]
    fn dash_audio_segment_callback_fires() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let (tx, rx) = mpsc::channel::<SegmentCompletedEvent>();

        let mut encoder = DashAudioSegmentEncoder::init(
            base_path.clone(),
            test_audio_info(),
            DashAudioSegmentEncoderConfig {
                segment_duration: Duration::from_millis(100),
            },
        )
        .unwrap();
        encoder.set_segment_callback(tx);

        let mut sample_offset: u64 = 0;
        for i in 0..100 {
            let frame = create_test_audio_frame(1024, sample_offset);
            sample_offset += 1024;
            let ts = Duration::from_millis(i * 21);
            encoder.queue_frame(frame, ts).unwrap();
        }

        encoder.finish().unwrap();

        let events: Vec<SegmentCompletedEvent> = rx.try_iter().collect();

        let init_events: Vec<&SegmentCompletedEvent> =
            events.iter().filter(|e| e.is_init).collect();
        assert!(
            !init_events.is_empty(),
            "should receive at least one init event"
        );
        assert_eq!(init_events[0].media_type, SegmentMediaType::Audio);

        let non_init: Vec<&SegmentCompletedEvent> = events.iter().filter(|e| !e.is_init).collect();

        for event in &non_init {
            assert_eq!(event.media_type, SegmentMediaType::Audio);
        }
    }

    #[test]
    fn dash_audio_finalize_marks_complete() {
        ffmpeg::init().ok();

        let temp = tempfile::tempdir().unwrap();
        let base_path = temp.path().to_path_buf();

        let mut encoder = DashAudioSegmentEncoder::init(
            base_path.clone(),
            test_audio_info(),
            DashAudioSegmentEncoderConfig {
                segment_duration: Duration::from_millis(100),
            },
        )
        .unwrap();

        let mut sample_offset: u64 = 0;
        for i in 0..50 {
            let frame = create_test_audio_frame(1024, sample_offset);
            sample_offset += 1024;
            let ts = Duration::from_millis(i * 21);
            encoder.queue_frame(frame, ts).unwrap();
        }

        encoder.finish().unwrap();

        let manifest_path = base_path.join("manifest.json");
        let content = std::fs::read_to_string(&manifest_path).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert!(manifest["is_complete"].as_bool().unwrap());
        assert!(manifest["total_duration"].is_number());
    }
}
