use crate::audio::aac::{AACEncoder, AACEncoderError};
use cap_media_info::AudioInfo;
use ffmpeg::{format, frame};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};

pub struct SegmentedAudioEncoder {
    base_path: PathBuf,
    audio_config: AudioInfo,

    current_encoder: Option<AudioSegmentEncoder>,
    current_index: u32,
    segment_duration: Duration,
    segment_start_time: Option<Duration>,

    completed_segments: Vec<SegmentInfo>,
}

struct AudioSegmentEncoder {
    encoder: AACEncoder,
    output: format::context::Output,
    has_frames: bool,
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

impl SegmentedAudioEncoder {
    pub fn init(
        base_path: PathBuf,
        audio_config: AudioInfo,
        segment_duration: Duration,
    ) -> Result<Self, InitError> {
        std::fs::create_dir_all(&base_path)?;

        let segment_path = base_path.join("fragment_000.m4a");
        let encoder = Self::create_segment_encoder(segment_path, audio_config)?;

        Ok(Self {
            base_path,
            audio_config,
            current_encoder: Some(encoder),
            current_index: 0,
            segment_duration,
            segment_start_time: None,
            completed_segments: Vec::new(),
        })
    }

    fn create_segment_encoder(
        path: PathBuf,
        audio_config: AudioInfo,
    ) -> Result<AudioSegmentEncoder, InitError> {
        let mut output = format::output_as(&path, "mp4")?;

        unsafe {
            let opts = output.as_mut_ptr();
            let key = std::ffi::CString::new("movflags").unwrap();
            let value =
                std::ffi::CString::new("frag_keyframe+empty_moov+default_base_moof").unwrap();
            ffmpeg::ffi::av_opt_set((*opts).priv_data, key.as_ptr(), value.as_ptr(), 0);
        }

        let encoder = AACEncoder::init(audio_config, &mut output)?;

        output.write_header()?;

        Ok(AudioSegmentEncoder {
            encoder,
            output,
            has_frames: false,
        })
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
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
            encoder
                .encoder
                .send_frame(frame, timestamp, &mut encoder.output)?;
            encoder.has_frames = true;
        }

        Ok(())
    }

    fn rotate_segment(&mut self, timestamp: Duration) -> Result<(), QueueFrameError> {
        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);

        if let Some(mut encoder) = self.current_encoder.take() {
            let _ = encoder.encoder.flush(&mut encoder.output);
            let _ = encoder.output.write_trailer();

            self.completed_segments.push(SegmentInfo {
                path: self.current_segment_path(),
                index: self.current_index,
                duration: segment_duration,
            });
        }

        self.current_index += 1;
        self.segment_start_time = Some(timestamp);

        let new_path = self.current_segment_path();
        self.current_encoder = Some(Self::create_segment_encoder(new_path, self.audio_config)?);

        self.write_manifest();

        Ok(())
    }

    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.m4a", self.current_index))
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

    pub fn finish(&mut self) -> Result<(), FinishError> {
        if let Some(mut encoder) = self.current_encoder.take() {
            if encoder.has_frames {
                if let Some(segment_start) = self.segment_start_time {
                    let final_duration = Duration::from_secs(5);

                    self.completed_segments.push(SegmentInfo {
                        path: self.current_segment_path(),
                        index: self.current_index,
                        duration: final_duration.saturating_sub(
                            final_duration
                                .saturating_sub(segment_start.saturating_sub(segment_start)),
                        ),
                    });
                }

                let flush_result = encoder.encoder.flush(&mut encoder.output);
                let trailer_result = encoder.output.write_trailer();

                if let Err(e) = &flush_result {
                    tracing::warn!("Audio encoder flush warning: {e}");
                }
                if let Err(e) = &trailer_result {
                    tracing::warn!("Audio write_trailer warning: {e}");
                }
            } else {
                let _ = encoder.output.write_trailer();
                let _ = std::fs::remove_file(self.current_segment_path());
            }
        }

        self.finalize_manifest();

        Ok(())
    }

    pub fn finish_with_timestamp(&mut self, timestamp: Duration) -> Result<(), FinishError> {
        if let Some(mut encoder) = self.current_encoder.take() {
            if encoder.has_frames {
                if let Some(segment_start) = self.segment_start_time {
                    let final_duration = timestamp.saturating_sub(segment_start);

                    self.completed_segments.push(SegmentInfo {
                        path: self.current_segment_path(),
                        index: self.current_index,
                        duration: final_duration,
                    });
                }

                let flush_result = encoder.encoder.flush(&mut encoder.output);
                let trailer_result = encoder.output.write_trailer();

                if let Err(e) = &flush_result {
                    tracing::warn!("Audio encoder flush warning: {e}");
                }
                if let Err(e) = &trailer_result {
                    tracing::warn!("Audio write_trailer warning: {e}");
                }
            } else {
                let _ = encoder.output.write_trailer();
                let _ = std::fs::remove_file(self.current_segment_path());
            }
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
