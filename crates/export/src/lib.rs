use cap_editor::{get_audio_segments, Segment};
use cap_media::{
    data::{AudioInfo, RawVideoFormat, VideoInfo},
    encoders::{AACEncoder, AudioEncoder, H264Encoder, MP4Input, OpusEncoder},
    feeds::{AudioRenderer, AudioSegment, AudioSegmentTrack},
    MediaError,
};
use cap_project::{
    AudioConfiguration, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, XY,
};
use cap_rendering::{
    ProjectRecordings, ProjectUniforms, RecordingSegmentDecoders, RenderSegment,
    RenderVideoConstants, RenderedFrame, SegmentVideoPaths,
};
use futures::FutureExt;
use image::{ImageBuffer, Rgba};
use serde::Deserialize;
use specta::Type;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::time::timeout;

#[derive(thiserror::Error, Debug)]
pub enum ExportError {
    #[error("FFmpeg: {0}")]
    FFmpeg(String),

    #[error("IO: {0}")]
    IO(#[from] std::io::Error),

    #[error("Rendering: {0}")]
    Rendering(#[from] cap_rendering::RenderingError),

    #[error("Media/{0}")]
    Media(#[from] cap_media::MediaError),

    #[error("Join: {0}")]
    Join(#[from] tokio::task::JoinError),

    #[error("Other:{0}")]
    Other(String),

    #[error("Exporting timed out")]
    Timeout(#[from] tokio::time::error::Elapsed),
}

pub struct Exporter<TOnProgress> {
    render_segments: Vec<RenderSegment>,
    audio_segments: Vec<AudioSegment>,
    output_size: (u32, u32),
    output_path: PathBuf,
    project: ProjectConfiguration,
    project_path: PathBuf,
    on_progress: TOnProgress,
    recording_meta: RecordingMeta,
    render_constants: Arc<RenderVideoConstants>,
    settings: ExportSettings,
    recordings: Arc<ProjectRecordings>,
}

#[derive(Deserialize, Type, Clone, Copy, Debug)]
pub struct ExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
}

impl<TOnProgress> Exporter<TOnProgress>
where
    TOnProgress: FnMut(u32) + Send + 'static,
{
    pub async fn new(
        project: ProjectConfiguration,
        output_path: PathBuf,
        on_progress: TOnProgress,
        project_path: PathBuf,
        recording_meta: RecordingMeta,
        render_constants: Arc<RenderVideoConstants>,
        segments: &[Segment],
        recordings: Arc<ProjectRecordings>,
        settings: ExportSettings,
    ) -> Result<Self, ExportError> {
        let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
            return Err(ExportError::Other(
                "Cannot export non-studio recordings".to_string(),
            ));
        };

        let output_folder = output_path.parent().unwrap();
        std::fs::create_dir_all(output_folder)?;

        let output_size = ProjectUniforms::get_output_size(
            &render_constants.options,
            &project,
            settings.resolution_base,
        );

        let mut render_segments = vec![];

        for (i, s) in segments.iter().enumerate() {
            let segment_paths = match &meta {
                cap_project::StudioRecordingMeta::SingleSegment { segment: s } => {
                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    }
                }
                cap_project::StudioRecordingMeta::MultipleSegments { inner, .. } => {
                    let s = &inner.segments[i];

                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    }
                }
            };
            render_segments.push(RenderSegment {
                cursor: s.cursor.clone(),
                decoders: RecordingSegmentDecoders::new(&recording_meta, meta, segment_paths, i)
                    .await
                    .map_err(ExportError::Other)?,
            });
        }

        Ok(Self {
            project,
            output_path,
            on_progress,
            project_path,
            recording_meta,
            render_constants,
            render_segments,
            audio_segments: get_audio_segments(segments),
            output_size,
            recordings: recordings.clone(),
            settings,
        })
    }

    pub async fn export_with_custom_muxer(mut self) -> Result<PathBuf, ExportError> {
        let meta = match &self.recording_meta.inner {
            RecordingMetaInner::Studio(meta) => meta,
            _ => panic!("Not a studio recording"),
        };

        println!("Exporting with custom muxer");

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

        let fps = self.settings.fps;

        let mut video_info = VideoInfo::from_raw(
            RawVideoFormat::Rgba,
            self.output_size.0,
            self.output_size.1,
            self.settings.fps,
        );
        video_info.time_base = ffmpeg::Rational::new(1, self.settings.fps as i32);

        let mut audio_renderer = self
            .audio_segments
            .get(0)
            .filter(|_| !self.project.audio.mute)
            .map(|_| AudioRenderer::new(self.audio_segments.clone()));
        let has_audio = audio_renderer.is_some();

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut encoder = cap_media::encoders::MP4File::init(
                "output",
                self.output_path.clone(),
                H264Encoder::factory("output_video", video_info),
                |o| {
                    has_audio.then(|| {
                        AACEncoder::init("output_audio", AudioRenderer::info(), o)
                            .map(|v| v.boxed())
                    })
                },
            )
            .unwrap();

            while let Ok(frame) = frame_rx.recv() {
                encoder.queue_video_frame(frame.video);
                if let Some(audio) = frame.audio {
                    encoder.queue_audio_frame(audio);
                }
            }

            encoder.finish();

            Ok::<_, ExportError>(self.output_path)
        })
        .then(|f| async { f.map_err(Into::into).and_then(|v| v) });

        let render_task = tokio::spawn({
            let project = self.project.clone();
            let project_path = self.project_path.clone();
            async move {
                println!("Starting FFmpeg output process...");

                let mut frame_count = 0;
                let mut first_frame = None;

                let audio_samples_per_frame = (f64::from(AudioRenderer::SAMPLE_RATE)
                    / f64::from(self.settings.fps))
                .ceil() as usize;

                loop {
                    let Some((frame, frame_number)) =
                        timeout(Duration::from_secs(6), video_rx.recv()).await?
                    else {
                        break;
                    };

                    (self.on_progress)(frame_count);

                    if frame_count == 0 {
                        first_frame = Some(frame.clone());
                        if let Some(audio) = &mut audio_renderer {
                            audio.set_playhead(0.0, &project);
                        }
                    }

                    let audio_frame = audio_renderer
                        .as_mut()
                        .and_then(|audio| audio.render_frame(audio_samples_per_frame, &project))
                        .map(|mut frame| {
                            let pts = ((frame_number * frame.rate()) as f64 / fps as f64) as i64;
                            frame.set_pts(Some(pts));
                            frame
                        });

                    frame_tx
                        .send(MP4Input {
                            audio: audio_frame,
                            video: video_info.wrap_frame(
                                &frame.data,
                                frame_number as i64,
                                frame.padded_bytes_per_row as usize,
                            ),
                        })
                        .ok();

                    frame_count += 1;
                }

                if let Some(frame) = first_frame {
                    let rgb_img = ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(
                        frame.width,
                        frame.height,
                        frame
                            .data
                            .chunks(frame.padded_bytes_per_row as usize)
                            .flat_map(|row| {
                                row[0..(frame.width * 4) as usize]
                                    .chunks(4)
                                    .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
                            })
                            .collect::<Vec<_>>(),
                    )
                    .expect("Failed to create image from frame data");

                    let screenshots_dir = project_path.join("screenshots");
                    std::fs::create_dir_all(&screenshots_dir).unwrap_or_else(|e| {
                        eprintln!("Failed to create screenshots directory: {:?}", e);
                    });

                    // Save full-size screenshot
                    let screenshot_path = screenshots_dir.join("display.jpg");
                    rgb_img.save(&screenshot_path).unwrap_or_else(|e| {
                        eprintln!("Failed to save screenshot: {:?}", e);
                    });
                } else {
                    eprintln!("No frames were processed, cannot save screenshot or thumbnail");
                }

                Ok::<_, ExportError>(())
            }
        })
        .then(|f| async { f.map_err(Into::into).and_then(|v| v) });

        println!("Rendering video to channel");

        let render_video_task = cap_rendering::render_video_to_channel(
            self.render_constants.options,
            self.project,
            tx_image_data,
            &self.recording_meta,
            meta,
            self.render_segments,
            self.settings.fps,
            self.settings.resolution_base,
            &self.recordings,
        )
        .then(|f| async { f.map_err(Into::into) });

        let (output_path, _, _) = tokio::try_join!(encoder_thread, render_video_task, render_task)?;

        Ok(output_path)
    }
}
