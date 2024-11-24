use std::path::PathBuf;

use cap_project::RecordingMeta;
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Video {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
}

impl Video {
    pub fn new(path: &PathBuf) -> Self {
        let input = ffmpeg::format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();

        let video_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();

        Video {
            width: video_decoder.width(),
            height: video_decoder.height(),
            duration: input.duration() as f64 / 1_000_000.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Audio {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

impl Audio {
    pub fn new(path: &PathBuf) -> Self {
        let input = ffmpeg::format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();

        let audio_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();

        Audio {
            duration: input.duration() as f64 / 1_000_000.0,
            sample_rate: audio_decoder.rate(),
            channels: audio_decoder.channels(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ProjectRecordings {
    pub segments: Vec<SegmentRecordings>,
}

impl ProjectRecordings {
    pub fn new(meta: &RecordingMeta) -> Self {
        let segments = match &meta.content {
            cap_project::Content::SingleSegment { segment } => {
                let display = Video::new(&meta.project_path.join(&segment.display.path));
                let camera = segment
                    .camera
                    .as_ref()
                    .map(|camera| Video::new(&meta.project_path.join(&camera.path)));
                let audio = segment
                    .audio
                    .as_ref()
                    .map(|audio| Audio::new(&meta.project_path.join(&audio.path)));

                vec![SegmentRecordings {
                    display,
                    camera,
                    audio,
                }]
            }
            cap_project::Content::MultipleSegments { inner } => inner
                .segments
                .iter()
                .map(|s| {
                    let display = Video::new(&meta.project_path.join(&s.display.path));
                    let camera = s
                        .camera
                        .as_ref()
                        .map(|camera| Video::new(&meta.project_path.join(&camera.path)));
                    let audio = s
                        .audio
                        .as_ref()
                        .map(|audio| Audio::new(&meta.project_path.join(&audio.path)));

                    SegmentRecordings {
                        display,
                        camera,
                        audio,
                    }
                })
                .collect(),
        };

        Self { segments }
    }

    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration()).sum()
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SegmentRecordings {
    pub display: Video,
    pub camera: Option<Video>,
    pub audio: Option<Audio>,
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
