use super::fragment_metadata::read_fragment_metadata;
use cap_media_info::VideoInfo;
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::mux::segmented_stream::{SegmentCompletedEvent, SegmentMediaType, VideoSegmentInfo};

const INIT_SEGMENT_NAME: &str = "init.mp4";
const MANIFEST_VERSION: u32 = 5;
const MANIFEST_TYPE: &str = "m4s_segments";

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
    #[serde(skip_serializing_if = "Option::is_none")]
    codec_info: Option<CodecInfo>,
    segments: Vec<SegmentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_duration: Option<f64>,
    is_complete: bool,
}

pub struct FragmentManifestTracker {
    base_path: PathBuf,
    segment_duration: Duration,
    current_index: u32,
    completed_segments: Vec<VideoSegmentInfo>,
    frames_since_segment_scan: u32,
    codec_info: CodecInfo,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    init_notified: bool,
}

impl FragmentManifestTracker {
    pub fn new(base_path: PathBuf, video_config: &VideoInfo, segment_duration: Duration) -> Self {
        let codec_info = CodecInfo {
            width: video_config.width,
            height: video_config.height,
            frame_rate_num: video_config.frame_rate.0,
            frame_rate_den: video_config.frame_rate.1,
            time_base_num: video_config.time_base.0,
            time_base_den: video_config.time_base.1,
            pixel_format: format!("{:?}", video_config.pixel_format),
        };
        Self {
            base_path,
            segment_duration,
            current_index: 1,
            completed_segments: Vec::new(),
            frames_since_segment_scan: 0,
            codec_info,
            segment_tx: None,
            init_notified: false,
        }
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn segment_duration(&self) -> Duration {
        self.segment_duration
    }

    pub fn init_segment_path(&self) -> PathBuf {
        self.base_path.join(INIT_SEGMENT_NAME)
    }

    pub fn init_segment_name() -> &'static str {
        INIT_SEGMENT_NAME
    }

    pub fn media_segment_pattern() -> &'static str {
        "segment_$Number%03d$.m4s"
    }

    pub fn set_segment_callback(&mut self, tx: std::sync::mpsc::Sender<SegmentCompletedEvent>) {
        self.segment_tx = Some(tx);
        self.try_notify_init_segment();
    }

    pub fn write_initial_manifest(&self) {
        self.write_in_progress_manifest();
    }

    pub fn on_frame(&mut self, _timestamp: Duration) {
        self.try_notify_init_segment();

        self.frames_since_segment_scan += 1;
        if self.frames_since_segment_scan >= 10 {
            self.frames_since_segment_scan = 0;
            self.flush_pending_segments();
        }
    }

    pub fn try_notify_init_segment(&mut self) {
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

    fn notify_segment(&self, event: SegmentCompletedEvent) {
        if let Some(tx) = &self.segment_tx
            && let Err(e) = tx.send(event)
        {
            tracing::warn!("Failed to send segment completed event: {e}");
        }
    }

    pub fn flush_pending_segments(&mut self) {
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
            manifest_type: MANIFEST_TYPE,
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

    pub fn finalize(&mut self, _end_timestamp: Duration) {
        self.try_notify_init_segment();
        self.finalize_pending_tmp_files();
        self.flush_pending_segments();
        self.collect_orphaned_segments();
        self.finalize_manifest();
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

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            manifest_type: MANIFEST_TYPE,
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

    pub fn current_index(&self) -> u32 {
        self.current_index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::VideoInfo;

    fn test_video_info() -> VideoInfo {
        VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width: 320,
            height: 240,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        }
    }

    #[test]
    fn tracker_writes_initial_manifest_on_start() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();

        let tracker =
            FragmentManifestTracker::new(base.clone(), &test_video_info(), Duration::from_secs(2));
        tracker.write_initial_manifest();

        let manifest_path = base.join("manifest.json");
        assert!(manifest_path.exists());

        let content = std::fs::read_to_string(&manifest_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["version"], 5);
        assert_eq!(parsed["type"], MANIFEST_TYPE);
        assert_eq!(parsed["is_complete"], false);
    }

    #[test]
    fn tracker_finalizes_with_is_complete_true() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();

        let mut tracker =
            FragmentManifestTracker::new(base.clone(), &test_video_info(), Duration::from_secs(2));
        tracker.write_initial_manifest();
        tracker.finalize(Duration::from_secs(0));

        let manifest_path = base.join("manifest.json");
        let content = std::fs::read_to_string(&manifest_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["is_complete"], true);
    }

    #[test]
    fn tracker_does_not_invent_segments_from_capture_timestamps() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();

        let mut tracker = FragmentManifestTracker::new(
            base.clone(),
            &test_video_info(),
            Duration::from_millis(100),
        );
        tracker.write_initial_manifest();

        for i in 0..20 {
            tracker.on_frame(Duration::from_millis(i * 15));
        }

        assert_eq!(tracker.current_index(), 1);
    }

    #[test]
    fn tracker_waits_for_finalized_files_and_uses_media_duration() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();
        let mut tracker =
            FragmentManifestTracker::new(base.clone(), &test_video_info(), Duration::from_secs(2));
        let (tx, rx) = std::sync::mpsc::channel();
        tracker.set_segment_callback(tx);
        let bytes = crate::mux::fragment_metadata::tests::fragment(1, 90_000, &[360_070]);
        let temporary = base.join("segment_001.m4s.tmp");
        let finalized = base.join("segment_001.m4s");
        std::fs::write(&temporary, &bytes).unwrap();

        tracker.on_frame(Duration::ZERO);
        tracker.on_frame(Duration::from_secs(2));
        for i in 1..=20 {
            tracker.on_frame(Duration::from_millis(2000 + i * 33));
        }
        assert!(rx.try_recv().is_err());
        assert!(tracker.completed_segments().is_empty());

        std::fs::rename(&temporary, &finalized).unwrap();
        for i in 21..=30 {
            tracker.on_frame(Duration::from_millis(2000 + i * 33));
        }
        let event = rx.try_recv().unwrap();
        assert_eq!(event.path, finalized);
        assert_eq!(event.file_size, bytes.len() as u64);
        assert!((event.duration - 4.000_777_777).abs() < 1e-9);

        tracker.finalize(Duration::from_secs(3));
        assert!(rx.try_recv().is_err());
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(base.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["segments"][0]["duration"], event.duration);
        assert_eq!(manifest["total_duration"], event.duration);
    }

    #[test]
    fn tracker_finalizes_actual_tail_without_publishing_truncated_files() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();
        let mut tracker =
            FragmentManifestTracker::new(base.clone(), &test_video_info(), Duration::from_secs(2));
        let (tx, rx) = std::sync::mpsc::channel();
        tracker.set_segment_callback(tx);
        tracker.on_frame(Duration::ZERO);
        let bytes = crate::mux::fragment_metadata::tests::fragment(1, 90_000, &[155_815]);
        std::fs::write(base.join("segment_001.m4s.tmp"), &bytes).unwrap();
        std::fs::write(base.join("segment_002.m4s.tmp"), &bytes[..80]).unwrap();
        tracker.finalize(Duration::from_secs(10));

        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].index, 1);
        assert!((events[0].duration - 1.731_277_777).abs() < 1e-9);
        assert!(!base.join("segment_002.m4s").exists());
        assert_eq!(tracker.completed_segments().len(), 1);
    }
}
