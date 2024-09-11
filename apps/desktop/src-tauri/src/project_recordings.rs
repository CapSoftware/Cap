use std::path::PathBuf;

use cap_project::RecordingMeta;
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Video {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
}

impl Video {
    pub fn new(path: &PathBuf) -> Self {
        let input = ffmpeg_next::format::input(path).unwrap();
        let stream = input
            .streams()
            .best(ffmpeg_next::media::Type::Video)
            .unwrap();

        let video_decoder = ffmpeg_next::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();

        let frame_rate = video_decoder.frame_rate().unwrap();

        Video {
            width: video_decoder.width(),
            height: video_decoder.height(),
            duration: (input.duration() / 1_000_000) as f64,
            fps: frame_rate.numerator() as f32 / frame_rate.denominator() as f32,
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
        let input = ffmpeg_next::format::input(path).unwrap();
        let stream = input
            .streams()
            .best(ffmpeg_next::media::Type::Audio)
            .unwrap();

        let video_decoder = ffmpeg_next::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();

        Audio {
            duration: (input.duration() / 1_000_000) as f64,
            sample_rate: video_decoder.rate(),
            channels: video_decoder.channels(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct ProjectRecordings {
    pub display: Video,
    pub camera: Option<Video>,
    pub audio: Option<Audio>,
}

impl ProjectRecordings {
    pub fn new(meta: &RecordingMeta) -> Self {
        let display = Video::new(&meta.project_path.join(&meta.display.path));
        let camera = meta
            .camera
            .as_ref()
            .map(|camera| Video::new(&meta.project_path.join(&camera.path)));
        let audio = meta
            .audio
            .as_ref()
            .map(|audio| Audio::new(&meta.project_path.join(&audio.path)));

        ProjectRecordings {
            display,
            camera,
            audio,
        }
    }

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
