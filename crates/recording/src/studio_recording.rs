use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context as _;
use cap_project::{
    AudioMeta, SingleSegment, StudioRecordingMeta, VideoMeta,
};
use relative_path::RelativePathBuf;
use serde::Serialize;
use specta::Type;

use crate::instant_recording;

pub struct ActorHandle {
    inner: instant_recording::ActorHandle,
    pub capture_target: crate::sources::screen_capture::ScreenCaptureTarget,
    project_path: PathBuf,
}

impl ActorHandle {
    pub async fn stop(&self) -> anyhow::Result<CompletedRecording> {
        let _ = self.inner.stop().await?;

        Ok(CompletedRecording {
            project_path: self.project_path.clone(),
            meta: default_studio_meta(),
        })
    }

    pub fn done_fut(&self) -> crate::DoneFut {
        self.inner.done_fut()
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        self.inner.pause().await
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        self.inner.resume().await
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        self.inner.cancel().await
    }

    pub async fn is_paused(&self) -> anyhow::Result<bool> {
        Ok(false)
    }
}

impl Drop for ActorHandle {
    fn drop(&mut self) {
        let _ = &self.inner;
    }
}

pub struct Actor;

impl Actor {
    pub fn builder(
        output: PathBuf,
        capture_target: crate::sources::screen_capture::ScreenCaptureTarget,
    ) -> ActorBuilder {
        ActorBuilder::new(output, capture_target)
    }
}

pub struct ActorBuilder {
    output_path: PathBuf,
    capture_target: crate::sources::screen_capture::ScreenCaptureTarget,
    system_audio: bool,
    mic_feed: Option<Arc<crate::feeds::microphone::MicrophoneFeedLock>>,
    camera_feed: Option<Arc<crate::feeds::camera::CameraFeedLock>>,
    custom_cursor: bool,
    fragmented: bool,
    max_fps: u32,
    #[cfg(target_os = "macos")]
    excluded_windows: Vec<scap_targets::WindowId>,
}

impl ActorBuilder {
    pub fn new(
        output: PathBuf,
        capture_target: crate::sources::screen_capture::ScreenCaptureTarget,
    ) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            camera_feed: None,
            custom_cursor: false,
            fragmented: false,
            max_fps: 60,
            #[cfg(target_os = "macos")]
            excluded_windows: Vec::new(),
        }
    }

    pub fn with_system_audio(mut self, system_audio: bool) -> Self {
        self.system_audio = system_audio;
        self
    }

    pub fn with_mic_feed(
        mut self,
        mic_feed: Arc<crate::feeds::microphone::MicrophoneFeedLock>,
    ) -> Self {
        self.mic_feed = Some(mic_feed);
        self
    }

    pub fn with_camera_feed(
        mut self,
        camera_feed: Arc<crate::feeds::camera::CameraFeedLock>,
    ) -> Self {
        self.camera_feed = Some(camera_feed);
        self
    }

    pub fn with_custom_cursor(mut self, custom_cursor: bool) -> Self {
        self.custom_cursor = custom_cursor;
        self
    }

    pub fn with_fragmented(mut self, fragmented: bool) -> Self {
        self.fragmented = fragmented;
        self
    }

    pub fn with_max_fps(mut self, max_fps: u32) -> Self {
        self.max_fps = max_fps.clamp(1, 120);
        self
    }

    #[cfg(target_os = "macos")]
    pub fn with_excluded_windows(mut self, excluded_windows: Vec<scap_targets::WindowId>) -> Self {
        self.excluded_windows = excluded_windows;
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] _shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    ) -> anyhow::Result<ActorHandle> {
        let mut builder = instant_recording::Actor::builder(
            self.output_path.clone(),
            self.capture_target.clone(),
        )
        .with_system_audio(self.system_audio)
        .with_max_output_size(self.max_fps);

        if let Some(mic_feed) = self.mic_feed {
            builder = builder.with_mic_feed(mic_feed);
        }

        #[cfg(target_os = "macos")]
        {
            builder = builder.with_excluded_windows(self.excluded_windows);
        }

        let inner = builder.build(
            #[cfg(target_os = "macos")]
            _shareable_content,
        )
        .await
        .context("spawn instant recording actor")?;

        Ok(ActorHandle {
            inner,
            capture_target: self.capture_target,
            project_path: self.output_path,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub meta: StudioRecordingMeta,
}

fn default_studio_meta() -> StudioRecordingMeta {
    StudioRecordingMeta::SingleSegment {
        segment: SingleSegment {
            display: VideoMeta {
                path: RelativePathBuf::from("content/output.mp4"),
                fps: 30,
                start_time: None,
            },
            camera: None,
            audio: None,
            cursor: None,
        },
    }
}

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
            let mut input =
                ffmpeg::format::input(path).map_err(|e| format!("Failed to open video: {e}"))?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| "No video stream found".to_string())?;
            let stream_index = stream.index();
            let stream_time_base = stream.time_base();
            let stream_duration = stream.duration();
            let stream_frames = stream.frames();

            let video_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .map_err(|e| format!("Failed to create decoder: {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("Failed to get video decoder: {e}"))?;

            let rate = stream.avg_frame_rate();
            let mut fps = if rate.denominator() != 0 && rate.numerator() != 0 {
                rate.numerator() as f64 / rate.denominator() as f64
            } else {
                0.0
            };

            if fps <= 0.0 {
                let r_rate = stream.rate();
                if r_rate.denominator() != 0 && r_rate.numerator() != 0 {
                    fps = r_rate.numerator() as f64 / r_rate.denominator() as f64;
                }
            }

            let container_duration = input.duration();
            let mut duration = if container_duration > 0 && container_duration != i64::MIN {
                container_duration as f64 / 1_000_000.0
            } else {
                0.0
            };

            if duration <= 0.0 {
                if stream_duration > 0 && stream_duration != i64::MIN {
                    duration = (stream_duration as f64 * stream_time_base.numerator() as f64)
                        / stream_time_base.denominator() as f64;
                }
            }

            if duration <= 0.0 {
                let mut last_ts: i64 = -1;
                for (s, packet) in input.packets() {
                    if s.index() == stream_index {
                        if let Some(pts) = packet.pts() {
                            if pts > last_ts {
                                last_ts = pts;
                            }
                        } else if let Some(dts) = packet.dts() {
                            if dts > last_ts {
                                last_ts = dts;
                            }
                        }
                    }
                }

                if last_ts >= 0 {
                    duration = (last_ts as f64 * stream_time_base.numerator() as f64)
                        / stream_time_base.denominator() as f64;
                }
            }

            if duration <= 0.0 && stream_frames > 0 && fps > 0.0 {
                duration = stream_frames as f64 / fps;
            }

            if !duration.is_finite() || duration <= 0.0 {
                tracing::warn!(
                    ?path,
                    container_duration,
                    stream_duration,
                    frames = stream_frames,
                    fps,
                    "Failed to determine video duration; defaulting to zero"
                );
                duration = 0.0;
            }

            Ok(Video {
                width: video_decoder.width(),
                height: video_decoder.height(),
                duration,
                fps: if fps > 0.0 { fps.round() as u32 } else { 0 },
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

                    Ok::<_, String>(SegmentRecordings {
                        display: load_video(&s.display).map_err(|e| format!("video / {e}"))?,
                        camera: Option::map(s.camera.as_ref(), load_video)
                            .transpose()
                            .map_err(|e| format!("camera / {e}"))?,
                        mic: Option::map(s.mic.as_ref(), load_audio)
                            .transpose()
                            .map_err(|e| format!("mic / {e}"))?,
                        system_audio: Option::map(s.system_audio.as_ref(), load_audio)
                            .transpose()
                            .map_err(|e| format!("system audio / {e}"))?,
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
