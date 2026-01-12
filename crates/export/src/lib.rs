pub mod gif;
pub mod mp4;

use cap_editor::SegmentMedia;
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{ProjectRecordingsMeta, RenderVideoConstants};
use std::{path::PathBuf, sync::Arc};

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

#[derive(thiserror::Error, Debug)]
pub enum ExporterBuildError {
    #[error("Failed to load config: {0}")]
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
    #[error("IO error at path '{0}': {1}")]
    IO(PathBuf, std::io::Error),
}

pub struct ExporterBuilder {
    project_path: PathBuf,
    config: Option<ProjectConfiguration>,
    output_path: Option<PathBuf>,
    force_ffmpeg_decoder: bool,
}

impl ExporterBuilder {
    pub fn with_config(mut self, config: ProjectConfiguration) -> Self {
        self.config = Some(config);
        self
    }

    pub fn with_force_ffmpeg_decoder(mut self, force: bool) -> Self {
        self.force_ffmpeg_decoder = force;
        self
    }

    pub async fn build(self) -> Result<ExporterBase, ExporterBuildError> {
        type Error = ExporterBuildError;

        let project_config = serde_json::from_reader(
            std::fs::File::open(self.project_path.join("project-config.json"))
                .map_err(|v| Error::ConfigLoad(v.into()))?,
        )
        .map_err(|v| Error::ConfigLoad(v.into()))?;

        let recording_meta =
            RecordingMeta::load_for_project(&self.project_path).map_err(Error::MetaLoad)?;
        let studio_meta = recording_meta
            .studio_meta()
            .ok_or(Error::NotStudioRecording)?;

        let recordings = Arc::new(
            ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
                .map_err(Error::RecordingsMeta)?,
        );

        let render_constants = Arc::new(
            RenderVideoConstants::new(
                &recordings.segments,
                recording_meta.clone(),
                studio_meta.clone(),
            )
            .await
            .map_err(Error::RendererSetup)?,
        );

        let segments =
            cap_editor::create_segments(&recording_meta, studio_meta, self.force_ffmpeg_decoder)
                .await
                .map_err(Error::MediaLoad)?;

        let output_path = self
            .output_path
            .unwrap_or_else(|| recording_meta.output_path());

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ExporterBuildError::IO(parent.to_path_buf(), e))?;
        }

        Ok(ExporterBase {
            output_path,
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

pub struct ExporterBase {
    project_path: PathBuf,
    recording_meta: RecordingMeta,
    project_config: ProjectConfiguration,
    studio_meta: StudioRecordingMeta,
    recordings: Arc<ProjectRecordingsMeta>,
    render_constants: Arc<RenderVideoConstants>,
    segments: Vec<SegmentMedia>,
    output_path: PathBuf,
}

impl ExporterBase {
    pub fn total_frames(&self, fps: u32) -> u32 {
        let duration = cap_rendering::get_duration(
            &self.recordings,
            &self.recording_meta,
            &self.studio_meta,
            &self.project_config,
        );

        (fps as f64 * duration).ceil() as u32
    }

    pub fn builder(project_path: PathBuf) -> ExporterBuilder {
        ExporterBuilder {
            project_path,
            config: None,
            output_path: None,
            force_ffmpeg_decoder: false,
        }
    }
}
