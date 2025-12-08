use crate::{FinishError, InitError, MP4Encoder, QueueFrameError};
use cap_media_info::{AudioInfo, VideoInfo};
use cidre::arc;
use ffmpeg::frame;
use serde::Serialize;
use std::{path::PathBuf, time::Duration};

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
}

#[derive(Serialize)]
struct FragmentEntry {
    path: String,
    index: u32,
    duration: f64,
    is_complete: bool,
}

#[derive(Serialize)]
struct Manifest {
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

        Ok(Self {
            base_path,
            video_config,
            audio_config,
            output_height,
            current_encoder: Some(encoder),
            current_index: 0,
            segment_duration,
            segment_start_time: None,
            completed_segments: Vec::new(),
        })
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
            Err(QueueFrameError::Failed)
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
            Err(QueueFrameError::Failed)
        }
    }

    fn rotate_segment(&mut self, timestamp: Duration) -> Result<(), QueueFrameError> {
        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);

        if let Some(mut encoder) = self.current_encoder.take() {
            let _ = encoder.finish(Some(timestamp));

            self.completed_segments.push(SegmentInfo {
                path: self.current_segment_path(),
                index: self.current_index,
                duration: segment_duration,
            });
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
            .map_err(|_| QueueFrameError::Failed)?,
        );

        self.write_manifest();

        Ok(())
    }

    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.mp4", self.current_index))
    }

    fn write_manifest(&self) {
        let manifest = Manifest {
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
                    is_complete: true,
                })
                .collect(),
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        let _ = std::fs::write(
            manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        );
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
        if let Some(segment_start) = self.segment_start_time {
            let final_duration = timestamp
                .unwrap_or(segment_start)
                .saturating_sub(segment_start);

            self.completed_segments.push(SegmentInfo {
                path: self.current_segment_path(),
                index: self.current_index,
                duration: final_duration,
            });
        }

        if let Some(mut encoder) = self.current_encoder.take() {
            encoder.finish(timestamp)?;
        }

        self.finalize_manifest();

        Ok(())
    }

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();

        let manifest = Manifest {
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
                    is_complete: true,
                })
                .collect(),
            total_duration: Some(total_duration.as_secs_f64()),
            is_complete: true,
        };

        let manifest_path = self.base_path.join("manifest.json");
        let _ = std::fs::write(
            manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        );
    }

    pub fn completed_segments(&self) -> &[SegmentInfo] {
        &self.completed_segments
    }
}
