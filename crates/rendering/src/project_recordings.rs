use std::{
    cell::RefCell,
    path::{Path, PathBuf},
};

use cap_project::{AudioMeta, StudioRecordingMeta, VideoMeta};
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Video {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub start_time: f64,
}

impl Video {
    pub fn new(path: impl AsRef<Path>, start_time: f64) -> Result<Self, String> {
        fn inner(path: &Path, start_time: f64) -> Result<Video, String> {
            let input =
                ffmpeg::format::input(path).map_err(|e| format!("Failed to open video: {e}"))?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| "No video stream found".to_string())?;

            let decoder_ctx = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .map_err(|e| format!("Failed to create decoder context: {e}"))?;
            let decoder = decoder_ctx
                .decoder()
                .video()
                .map_err(|e| format!("Failed to get video decoder: {e}"))?;

            let width = decoder.width();
            let height = decoder.height();

            if width == 0 || height == 0 {
                return Err("Invalid video dimensions".to_string());
            }

            let rate = stream.avg_frame_rate();
            let fps = if rate.denominator() != 0 {
                rate.numerator() as f64 / rate.denominator() as f64
            } else {
                30.0
            };

            let duration = {
                let container_duration = input.duration();
                if container_duration > 0 {
                    container_duration as f64 / 1_000_000.0
                } else {
                    let stream_duration = stream.duration();
                    let time_base = stream.time_base();
                    if stream_duration > 0 && time_base.denominator() > 0 {
                        stream_duration as f64 * time_base.numerator() as f64
                            / time_base.denominator() as f64
                    } else {
                        return Err("Could not determine video duration".to_string());
                    }
                }
            };

            Ok(Video {
                width,
                height,
                duration,
                fps: fps.round() as u32,
                start_time,
            })
        }

        inner(path.as_ref(), start_time)
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Audio {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub start_time: f64,
}

impl Audio {
    pub fn new(path: impl AsRef<Path>, start_time: f64) -> Result<Self, String> {
        fn inner(path: &Path, start_time: f64) -> Result<Audio, String> {
            let input =
                ffmpeg::format::input(path).map_err(|e| format!("Failed to open audio: {e}"))?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Audio)
                .ok_or_else(|| "No audio stream found".to_string())?;

            let audio_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .map_err(|e| format!("Failed to create decoder: {e}"))?
                .decoder()
                .audio()
                .map_err(|e| format!("Failed to get audio decoder: {e}"))?;

            Ok(Audio {
                duration: input.duration() as f64 / 1_000_000.0,
                sample_rate: audio_decoder.rate(),
                channels: audio_decoder.channels(),
                start_time,
            })
        }

        inner(path.as_ref(), start_time)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ProjectRecordingsMeta {
    pub segments: Vec<SegmentRecordings>,
}

impl ProjectRecordingsMeta {
    pub fn new(recording_path: &PathBuf, meta: &StudioRecordingMeta) -> Result<Self, String> {
        let segments = match &meta {
            StudioRecordingMeta::SingleSegment { segment: s } => {
                let display = Video::new(s.display.path.to_path(recording_path), 0.0)
                    .expect("Failed to read display video");
                let camera = s.camera.as_ref().map(|camera| {
                    Video::new(camera.path.to_path(recording_path), 0.0)
                        .expect("Failed to read camera video")
                });
                let mic = s
                    .audio
                    .as_ref()
                    .map(|audio| Audio::new(audio.path.to_path(recording_path), 0.0))
                    .transpose()
                    .expect("Failed to read audio");

                vec![SegmentRecordings {
                    display,
                    camera,
                    mic,
                    system_audio: None,
                }]
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner
                .segments
                .iter()
                .map(|s| {
                    let has_start_times = RefCell::new(None);

                    let ensure_start_time = |time: Option<f64>| {
                        let Some(has_start_times) = *has_start_times.borrow_mut() else {
                            *has_start_times.borrow_mut() = Some(time.is_some());
                            return Ok(time.unwrap_or_default());
                        };

                        Ok(if has_start_times {
                            if let Some(time) = time {
                                time
                            } else {
                                return Err("Missing start time".to_string());
                            }
                        } else if time.is_some() {
                            return Err("Start time mismatch".to_string());
                        } else {
                            0.0
                        })
                    };

                    let load_video = |meta: &VideoMeta| {
                        ensure_start_time(meta.start_time).and_then(|start_time| {
                            Video::new(meta.path.to_path(recording_path), start_time)
                        })
                    };

                    let load_audio = |meta: &AudioMeta| {
                        ensure_start_time(meta.start_time).and_then(|start_time| {
                            Audio::new(meta.path.to_path(recording_path), start_time)
                        })
                    };

                    let system_audio = match Option::map(s.system_audio.as_ref(), load_audio)
                        .transpose()
                    {
                        Ok(audio) => audio,
                        Err(e) => {
                            tracing::warn!(
                                "Failed to load system audio for segment, treating as no audio: {e}"
                            );
                            None
                        }
                    };

                    Ok::<_, String>(SegmentRecordings {
                        display: load_video(&s.display).map_err(|e| format!("video / {e}"))?,
                        camera: Option::map(s.camera.as_ref(), load_video)
                            .transpose()
                            .map_err(|e| format!("camera / {e}"))?,
                        mic: Option::map(s.mic.as_ref(), load_audio)
                            .transpose()
                            .map_err(|e| format!("mic / {e}"))?,
                        system_audio,
                    })
                })
                .enumerate()
                .map(|(i, v)| v.map_err(|e| format!("segment {i} / {e}")))
                .collect::<Result<_, String>>()?,
        };

        Ok(Self { segments })
    }

    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration()).sum()
    }

    pub fn get_source_duration(&self, path: &PathBuf) -> Result<f64, String> {
        Video::new(path, 0.0).map(|v| v.duration)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SegmentRecordings {
    pub display: Video,
    pub camera: Option<Video>,
    pub mic: Option<Audio>,
    pub system_audio: Option<Audio>,
}

impl SegmentRecordings {
    pub fn duration(&self) -> f64 {
        let mut duration_ns = [
            Some(self.display.duration),
            self.camera.as_ref().map(|s| s.duration),
            self.mic.as_ref().map(|s| s.duration),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        duration_ns.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        duration_ns[0]
    }
}
