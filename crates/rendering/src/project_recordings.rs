use std::path::{Path, PathBuf};

use crate::RecordingMeta;
use cap_project::StudioRecordingMeta;
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Video {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Video {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, String> {
        fn inner(path: &Path) -> Result<Video, String> {
            let input =
                ffmpeg::format::input(path).map_err(|e| format!("Failed to open video: {}", e))?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| "No video stream found".to_string())?;

            let video_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .map_err(|e| format!("Failed to create decoder: {}", e))?
                .decoder()
                .video()
                .map_err(|e| format!("Failed to get video decoder: {}", e))?;

            let rate = stream.avg_frame_rate();
            let fps = rate.numerator() as f64 / rate.denominator() as f64;

            Ok(Video {
                width: video_decoder.width(),
                height: video_decoder.height(),
                duration: input.duration() as f64 / 1_000_000.0,
                fps: fps.round() as u32,
            })
        }

        inner(path.as_ref())
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
}

impl Audio {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, String> {
        fn inner(path: &Path) -> Result<Audio, String> {
            let input =
                ffmpeg::format::input(path).map_err(|e| format!("Failed to open audio: {}", e))?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Audio)
                .ok_or_else(|| "No audio stream found".to_string())?;

            let audio_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .map_err(|e| format!("Failed to create decoder: {}", e))?
                .decoder()
                .audio()
                .map_err(|e| format!("Failed to get audio decoder: {}", e))?;

            Ok(Audio {
                duration: input.duration() as f64 / 1_000_000.0,
                sample_rate: audio_decoder.rate(),
                channels: audio_decoder.channels(),
            })
        }

        inner(path.as_ref())
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ProjectRecordings {
    pub segments: Vec<SegmentRecordings>,
}

impl ProjectRecordings {
    pub fn new(recording_path: &PathBuf, meta: &StudioRecordingMeta) -> Self {
        let segments = match &meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                let display = Video::new(segment.display.path.to_path(recording_path))
                    .expect("Failed to read display video");
                let camera = segment.camera.as_ref().map(|camera| {
                    Video::new(&camera.path.to_path(recording_path))
                        .expect("Failed to read camera video")
                });
                let audio = segment
                    .audio
                    .as_ref()
                    .map(|audio| Audio::new(audio.path.to_path(recording_path)))
                    .transpose()
                    .expect("Failed to read audio");

                vec![SegmentRecordings {
                    display,
                    camera,
                    audio,
                    system_audio: None,
                }]
            }
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .map(|s| {
                    let display = Video::new(s.display.path.to_path(recording_path))
                        .expect("Failed to read display video");
                    let camera = s.camera.as_ref().map(|camera| {
                        Video::new(&camera.path.to_path(recording_path))
                            .expect("Failed to read camera video")
                    });
                    let audio = s
                        .audio
                        .as_ref()
                        .map(|audio| Audio::new(audio.path.to_path(recording_path)))
                        .transpose()
                        .expect("Failed to read audio");

                    let system_audio = s
                        .system_audio
                        .as_ref()
                        .map(|audio| Audio::new(audio.path.to_path(recording_path)))
                        .transpose()
                        .expect("Failed to read audio");

                    SegmentRecordings {
                        display,
                        camera,
                        audio,
                        system_audio,
                    }
                })
                .collect(),
        };

        Self { segments }
    }

    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration()).sum()
    }

    pub fn get_source_duration(&self, path: &PathBuf) -> Result<f64, String> {
        Video::new(path).map(|v| v.duration)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SegmentRecordings {
    pub display: Video,
    pub camera: Option<Video>,
    pub audio: Option<Audio>,
    pub system_audio: Option<Audio>,
}

impl SegmentRecordings {
    pub fn duration(&self) -> f64 {
        let mut duration_ns = [
            Some(self.display.duration),
            self.camera.as_ref().map(|s| s.duration),
            self.audio.as_ref().map(|s| s.duration),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        duration_ns.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        duration_ns[0]
    }
}
