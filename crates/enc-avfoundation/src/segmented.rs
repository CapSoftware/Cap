use crate::{FinishError, InitError, MP4Encoder, QueueFrameError, wait_for_writer_finished};
use cap_media_info::{AudioInfo, VideoInfo};
use cidre::arc;
use ffmpeg::frame;
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tracing::warn;

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
    {
        let _ = dir.sync_all();
    }

    Ok(())
}

fn sync_file(path: &Path) {
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.sync_all();
    }
}

pub struct SegmentedMP4Encoder {
    base_path: PathBuf,
    video_config: VideoInfo,
    audio_config: Option<AudioInfo>,
    output_height: Option<u32>,

    current_encoder: Option<MP4Encoder>,
    current_index: u32,
    segment_duration: Duration,
    segment_start_time: Option<Duration>,

    completed_segments: Vec<SegmentInfo>,
}

#[derive(Debug, Clone)]
pub struct SegmentInfo {
    pub path: PathBuf,
    pub index: u32,
    pub duration: Duration,
    pub file_size: Option<u64>,
    pub is_failed: bool,
}

#[derive(Serialize)]
struct FragmentEntry {
    path: String,
    index: u32,
    duration: f64,
    is_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_failed: bool,
}

const MANIFEST_VERSION: u32 = 2;

#[derive(Serialize)]
struct Manifest {
    version: u32,
    fragments: Vec<FragmentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_duration: Option<f64>,
    is_complete: bool,
}

impl SegmentedMP4Encoder {
    pub fn init(
        base_path: PathBuf,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output_height: Option<u32>,
        segment_duration: Duration,
    ) -> Result<Self, InitError> {
        std::fs::create_dir_all(&base_path).map_err(|_| InitError::NoSettingsAssistant)?;

        let segment_path = base_path.join("fragment_000.mp4");
        let encoder = MP4Encoder::init(segment_path, video_config, audio_config, output_height)?;

        let instance = Self {
            base_path,
            video_config,
            audio_config,
            output_height,
            current_encoder: Some(encoder),
            current_index: 0,
            segment_duration,
            segment_start_time: None,
            completed_segments: Vec::new(),
        };

        instance.write_in_progress_manifest();

        Ok(instance)
    }

    pub fn queue_video_frame(
        &mut self,
        frame: arc::R<cidre::cm::SampleBuf>,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.segment_start_time.is_none() {
            self.segment_start_time = Some(timestamp);
        }

        let segment_elapsed =
            timestamp.saturating_sub(self.segment_start_time.unwrap_or(Duration::ZERO));

        if segment_elapsed >= self.segment_duration {
            self.rotate_segment(timestamp)?;
        }

        if let Some(encoder) = &mut self.current_encoder {
            encoder.queue_video_frame(frame, timestamp)
        } else {
            Err(QueueFrameError::NoEncoder)
        }
    }

    pub fn queue_audio_frame(
        &mut self,
        frame: &frame::Audio,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if let Some(encoder) = &mut self.current_encoder {
            encoder.queue_audio_frame(frame, timestamp)
        } else {
            Err(QueueFrameError::NoEncoder)
        }
    }

    fn rotate_segment(&mut self, timestamp: Duration) -> Result<(), QueueFrameError> {
        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);
        let completed_segment_path = self.current_segment_path();
        let current_index = self.current_index;

        if let Some(mut encoder) = self.current_encoder.take() {
            let finish_failed = match encoder.finish_nowait(Some(timestamp)) {
                Ok(writer) => {
                    let path_for_sync = completed_segment_path.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = wait_for_writer_finished(&writer) {
                            warn!(
                                "Background writer finalization failed for segment {current_index}: {e}"
                            );
                        }
                        sync_file(&path_for_sync);
                    });
                    false
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to finish encoder during rotation for segment {}: {e}",
                        current_index
                    );
                    true
                }
            };

            let file_size = std::fs::metadata(&completed_segment_path)
                .ok()
                .map(|m| m.len());

            self.completed_segments.push(SegmentInfo {
                path: completed_segment_path,
                index: current_index,
                duration: segment_duration,
                file_size,
                is_failed: finish_failed,
            });

            self.write_manifest();

            if finish_failed {
                tracing::warn!(
                    "Segment {} marked as failed in manifest, continuing with new segment",
                    current_index
                );
            }
        }

        self.current_index += 1;
        self.segment_start_time = Some(timestamp);

        let new_path = self.current_segment_path();
        self.current_encoder = Some(
            MP4Encoder::init(
                new_path,
                self.video_config,
                self.audio_config,
                self.output_height,
            )
            .map_err(|e| {
                tracing::error!(
                    "Failed to create new encoder for segment {}: {e}",
                    self.current_index
                );
                QueueFrameError::Failed
            })?,
        );

        self.write_in_progress_manifest();

        Ok(())
    }

    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.mp4", self.current_index))
    }

    fn write_manifest(&self) {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments: self
                .completed_segments
                .iter()
                .map(|s| FragmentEntry {
                    path: s
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    index: s.index,
                    duration: s.duration.as_secs_f64(),
                    is_complete: !s.is_failed,
                    file_size: s.file_size,
                    is_failed: s.is_failed,
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
        let mut fragments: Vec<FragmentEntry> = self
            .completed_segments
            .iter()
            .map(|s| FragmentEntry {
                path: s
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                index: s.index,
                duration: s.duration.as_secs_f64(),
                is_complete: !s.is_failed,
                file_size: s.file_size,
                is_failed: s.is_failed,
            })
            .collect();

        fragments.push(FragmentEntry {
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
            is_failed: false,
        });

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments,
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

    pub fn pause(&mut self) {
        if let Some(encoder) = &mut self.current_encoder {
            encoder.pause();
        }
    }

    pub fn resume(&mut self) {
        if let Some(encoder) = &mut self.current_encoder {
            encoder.resume();
        }
    }

    pub fn finish(&mut self, timestamp: Option<Duration>) -> Result<(), FinishError> {
        let segment_path = self.current_segment_path();
        let segment_start = self.segment_start_time;
        let current_index = self.current_index;

        if let Some(mut encoder) = self.current_encoder.take() {
            match encoder.finish_nowait(timestamp) {
                Ok(writer) => {
                    let path_for_sync = segment_path.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = wait_for_writer_finished(&writer) {
                            warn!(
                                "Background writer finalization failed for segment {current_index}: {e}"
                            );
                        }
                        sync_file(&path_for_sync);
                    });

                    if let Some(start) = segment_start {
                        let final_duration = timestamp.unwrap_or(start).saturating_sub(start);
                        let file_size = std::fs::metadata(&segment_path).ok().map(|m| m.len());

                        self.completed_segments.push(SegmentInfo {
                            path: segment_path,
                            index: current_index,
                            duration: final_duration,
                            file_size,
                            is_failed: false,
                        });
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to finish final segment {current_index}: {e}");

                    if let Some(start) = segment_start {
                        let final_duration = timestamp.unwrap_or(start).saturating_sub(start);
                        let file_size = std::fs::metadata(&segment_path).ok().map(|m| m.len());

                        self.completed_segments.push(SegmentInfo {
                            path: segment_path,
                            index: current_index,
                            duration: final_duration,
                            file_size,
                            is_failed: true,
                        });
                    }
                }
            }
        }

        self.finalize_manifest();

        Ok(())
    }

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();
        let has_failed_segments = self.completed_segments.iter().any(|s| s.is_failed);

        if has_failed_segments {
            tracing::warn!(
                "Recording completed with {} failed segment(s)",
                self.completed_segments
                    .iter()
                    .filter(|s| s.is_failed)
                    .count()
            );
        }

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments: self
                .completed_segments
                .iter()
                .map(|s| FragmentEntry {
                    path: s
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    index: s.index,
                    duration: s.duration.as_secs_f64(),
                    is_complete: !s.is_failed,
                    file_size: s.file_size,
                    is_failed: s.is_failed,
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

    pub fn completed_segments(&self) -> &[SegmentInfo] {
        &self.completed_segments
    }
}
