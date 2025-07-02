use cap_editor::{get_audio_segments, Segment};
use cap_media::{
    data::{RawVideoFormat, VideoInfo},
    encoders::{AACEncoder, AudioEncoder, GifEncoderWrapper, H264Encoder, MP4Input},
    feeds::AudioRenderer,
};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY};
use cap_rendering::{
    ProjectRecordingsMeta, ProjectUniforms, RenderSegment, RenderVideoConstants, RenderedFrame,
};
use futures::FutureExt;
use image::ImageBuffer;
use serde::Deserialize;
use specta::Type;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::time::timeout;
use tracing::{error, info, trace, warn};

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

#[derive(Deserialize, Type, Clone, Copy, Debug)]
pub struct Mp4ExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub compression: ExportCompression,
}

#[derive(Deserialize, Type, Clone, Copy, Debug)]
pub struct GifExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
}

#[derive(Deserialize, Clone, Copy, Debug, Type)]
pub enum ExportCompression {
    Minimal,
    Social,
    Web,
    Potato,
}

impl ExportCompression {
    pub fn bits_per_pixel(&self) -> f32 {
        match self {
            Self::Minimal => 0.3,
            Self::Social => 0.15,
            Self::Web => 0.08,
            Self::Potato => 0.04,
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum ExporterBuildError {
    #[error("Failled to load config: {0}")]
    ConfigLoad(#[source] Box<dyn std::error::Error>),
    #[error("Failed to load meta: {0}")]
    MetaLoad(#[source] Box<dyn std::error::Error>),
    #[error("Recording is not a studio recording")]
    NotStudioRecording,
    #[error("Failed to load recordings meta: {0}")]
    RecordingsMeta(String),
    #[error("Failed to setup renderer: {0}")]
    RendererSetup(#[source] cap_rendering::RenderingError),
    #[error("Failed to load media: {0}")]
    MediaLoad(String),
}

pub struct ExporterBuilder {
    project_path: PathBuf,
    config: Option<ProjectConfiguration>,
    output_path: Option<PathBuf>,
}

impl ExporterBuilder {
    pub fn with_config(mut self, config: ProjectConfiguration) -> Self {
        self.config = Some(config);
        self
    }

    pub async fn build(self) -> Result<Exporter, ExporterBuildError> {
        type Error = ExporterBuildError;

        let project_config = serde_json::from_reader(
            std::fs::File::open(self.project_path.join("project-config.json"))
                .map_err(|v| Error::ConfigLoad(v.into()))?,
        )
        .map_err(|v| Error::ConfigLoad(v.into()))?;

        let recording_meta = RecordingMeta::load_for_project(&self.project_path)
            .map_err(|v| Error::MetaLoad(v.into()))?;
        let studio_meta = recording_meta
            .studio_meta()
            .ok_or(Error::NotStudioRecording)?;

        let recordings = Arc::new(
            ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
                .map_err(Error::RecordingsMeta)?,
        );

        let render_constants = Arc::new(
            RenderVideoConstants::new(&recordings.segments, &recording_meta, studio_meta)
                .await
                .unwrap(),
        );

        let segments = cap_editor::create_segments(&recording_meta, studio_meta)
            .await
            .map_err(Error::MediaLoad)?;

        Ok(Exporter {
            output_path: self
                .output_path
                .unwrap_or_else(|| recording_meta.output_path()),
            studio_meta: studio_meta.clone(),
            recordings,
            render_constants,
            segments,
            recording_meta,
            project_config,
            project_path: self.project_path,
        })
    }
}

pub struct Exporter {
    project_path: PathBuf,
    recording_meta: RecordingMeta,
    project_config: ProjectConfiguration,
    studio_meta: StudioRecordingMeta,
    recordings: Arc<ProjectRecordingsMeta>,
    render_constants: Arc<RenderVideoConstants>,
    segments: Vec<Segment>,
    output_path: PathBuf,
}

impl Exporter {
    pub fn builder(project_path: PathBuf) -> ExporterBuilder {
        ExporterBuilder {
            project_path,
            config: None,
            output_path: None,
        }
    }

    pub fn total_frames(&self, fps: u32) -> u32 {
        let duration = cap_rendering::get_duration(
            &self.recordings,
            &self.recording_meta,
            &self.studio_meta,
            &self.project_config,
        );

        (fps as f64 * duration).ceil() as u32
    }

    pub async fn export_mp4(
        self,
        export_settings: Mp4ExportSettings,
        mut on_progress: impl FnMut(u32) + Send + 'static,
    ) -> Result<PathBuf, String> {
        let output_path = self.output_path.clone();
        let meta = &self.studio_meta;

        info!("Exporting mp4 with settings: {export_settings:?}");
        info!(
            "Expected to render {} frames",
            self.total_frames(export_settings.fps)
        );

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

        let fps = export_settings.fps;

        let output_size = ProjectUniforms::get_output_size(
            &self.render_constants.options,
            &self.project_config,
            export_settings.resolution_base,
        );

        let mut video_info =
            VideoInfo::from_raw(RawVideoFormat::Rgba, output_size.0, output_size.1, fps);
        video_info.time_base = ffmpeg::Rational::new(1, fps as i32);

        let audio_segments = get_audio_segments(&self.segments);

        let mut audio_renderer = audio_segments
            .get(0)
            .filter(|_| !self.project_config.audio.mute)
            .map(|_| AudioRenderer::new(audio_segments.clone()));
        let has_audio = audio_renderer.is_some();

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut encoder = cap_media::encoders::MP4File::init(
                "output",
                self.output_path.clone(),
                |o| {
                    H264Encoder::builder("output_video", video_info)
                        .with_bpp(export_settings.compression.bits_per_pixel())
                        .build(o)
                },
                |o| {
                    has_audio.then(|| {
                        AACEncoder::init("output_audio", AudioRenderer::info(), o)
                            .map(|v| v.boxed())
                    })
                },
            )
            .map_err(|v| v.to_string())?;

            while let Ok(frame) = frame_rx.recv() {
                encoder.queue_video_frame(frame.video);
                if let Some(audio) = frame.audio {
                    encoder.queue_audio_frame(audio);
                }
            }

            encoder.finish();

            Ok::<_, String>(self.output_path)
        });

        let render_task = tokio::spawn({
            let project = self.project_config.clone();
            let project_path = self.project_path.clone();
            async move {
                let mut frame_count = 0;
                let mut first_frame = None;

                let audio_samples_per_frame =
                    (f64::from(AudioRenderer::SAMPLE_RATE) / f64::from(fps)).ceil() as usize;

                loop {
                    let (frame, frame_number) =
                        match timeout(Duration::from_secs(6), video_rx.recv()).await {
                            Err(_) => {
                                warn!("render_task frame receive timed out");
                                break;
                            }
                            Ok(Some(v)) => v,
                            _ => {
                                break;
                            }
                        };

                    (on_progress)(frame_count);

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
                    warn!("No frames were processed, cannot save screenshot or thumbnail");
                }

                Ok::<_, ExportError>(())
            }
        })
        .then(|f| async { f.map(|v| v.map_err(|e| e.to_string())) });

        let render_video_task = cap_rendering::render_video_to_channel(
            &self.render_constants,
            &self.project_config,
            tx_image_data,
            &self.recording_meta,
            meta,
            self.segments
                .iter()
                .map(|s| RenderSegment {
                    cursor: s.cursor.clone(),
                    decoders: s.decoders.clone(),
                })
                .collect(),
            fps,
            export_settings.resolution_base,
            &self.recordings,
        )
        .then(|v| async { Ok(v.map_err(|e| e.to_string())) });

        let _ = tokio::try_join!(encoder_thread, render_video_task, render_task)
            .map_err(|e| e.to_string())?;

        Ok(output_path)
    }

    pub async fn export_gif(
        self,
        export_settings: GifExportSettings,
        mut on_progress: impl FnMut(u32) + Send + 'static,
    ) -> Result<PathBuf, String> {
        let meta = &self.studio_meta;

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);

        let fps = export_settings.fps;

        let output_size = ProjectUniforms::get_output_size(
            &self.render_constants.options,
            &self.project_config,
            export_settings.resolution_base,
        );

        // Ensure the output path has .gif extension
        let mut gif_output_path = self.output_path.clone();
        if gif_output_path.extension() != Some(std::ffi::OsStr::new("gif")) {
            gif_output_path.set_extension("gif");
        }

        std::fs::create_dir_all(gif_output_path.parent().unwrap()).map_err(|e| e.to_string())?;

        trace!(
            "Creating GIF encoder at path '{}'",
            gif_output_path.display()
        );
        let mut gif_encoder =
            GifEncoderWrapper::new(&gif_output_path, output_size.0, output_size.1, fps)
                .map_err(|e| format!("Failed to create GIF encoder: {}", e))?;

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut frame_count = 0;

            while let Some((frame, _frame_number)) = video_rx.blocking_recv() {
                (on_progress)(frame_count);

                if let Err(e) =
                    gif_encoder.add_frame(&frame.data, frame.padded_bytes_per_row as usize)
                {
                    return Err(ExportError::Other(format!(
                        "Failed to add frame to GIF: {}",
                        e
                    )));
                }

                frame_count += 1;
            }

            if let Err(e) = gif_encoder.finish() {
                return Err(ExportError::Other(format!("Failed to finish GIF: {}", e)));
            }

            Ok(gif_output_path)
        })
        .then(|f| async {
            f.map_err(|e| e.to_string())
                .and_then(|v| v.map_err(|v| v.to_string()))
        });

        let render_video_task = cap_rendering::render_video_to_channel(
            &self.render_constants,
            &self.project_config,
            tx_image_data,
            &self.recording_meta,
            meta,
            self.segments
                .iter()
                .map(|s| RenderSegment {
                    cursor: s.cursor.clone(),
                    decoders: s.decoders.clone(),
                })
                .collect(),
            fps,
            export_settings.resolution_base,
            &self.recordings,
        )
        .then(|f| async { f.map_err(|v| v.to_string()) });

        let (output_path, _) =
            tokio::try_join!(encoder_thread, render_video_task).map_err(|e| e.to_string())?;

        Ok(output_path)
    }
}
