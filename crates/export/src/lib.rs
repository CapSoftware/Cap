pub mod gif;
pub mod mov;
pub mod mp4;
pub mod preview;
pub mod settings;

use cap_editor::{ExportAudioPreparation, ExportAudioRenderer, SegmentMedia};
use cap_project::{
    BackgroundSource, ProjectConfiguration, RecordingMeta, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment,
};
use cap_rendering::{ProjectRecordingsMeta, RenderVideoConstants};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

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

    pub fn with_output_path(mut self, output_path: PathBuf) -> Self {
        self.output_path = Some(output_path);
        self
    }

    pub fn with_force_ffmpeg_decoder(mut self, force: bool) -> Self {
        self.force_ffmpeg_decoder = force;
        self
    }

    pub async fn build(self) -> Result<ExporterBase, ExporterBuildError> {
        self.build_inner(None).await
    }

    pub async fn build_for_mp4(
        self,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Mp4ExporterBase, ExporterBuildError> {
        self.build_inner(Some(cancellation))
            .await
            .map(Mp4ExporterBase)
    }

    async fn build_inner(
        self,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<ExporterBase, ExporterBuildError> {
        type Error = ExporterBuildError;

        let mut project_config = if let Some(config) = self.config {
            config
        } else {
            ProjectConfiguration::load(&self.project_path)
                .map_err(|v| Error::ConfigLoad(v.into()))?
        };

        let recording_meta =
            RecordingMeta::load_for_project(&self.project_path).map_err(Error::MetaLoad)?;
        let studio_meta = recording_meta
            .studio_meta()
            .ok_or(Error::NotStudioRecording)?;

        let recordings = Arc::new(
            ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
                .map_err(Error::RecordingsMeta)?,
        );

        // A freshly recorded .cap has no timeline — only the editor creates one. Without it the
        // render loop's get_segment_time() returns None on frame 0 and produces zero frames (an empty
        // export). Synthesize the same default timeline the editor would (one segment per recording,
        // spanning its full duration) so raw recordings — e.g. from `cap export` — render correctly.
        // Desktop exports already carry a timeline by export time, so this only fires for un-edited
        // projects and changes nothing for them.
        if project_config.timeline.is_none() {
            let segments: Vec<TimelineSegment> = recordings
                .segments
                .iter()
                .enumerate()
                .filter_map(|(i, segment)| {
                    let duration = segment.duration();
                    (duration > 0.0).then_some(TimelineSegment {
                        recording_clip: i as u32,
                        start: 0.0,
                        end: duration,
                        timescale: 1.0,
                        name: None,
                        speed_audio_mode: None,
                    })
                })
                .collect();
            if !segments.is_empty() {
                project_config.timeline = Some(TimelineConfiguration {
                    segments,
                    transitions: Vec::new(),
                    zoom_segments: Vec::new(),
                    scene_segments: Vec::new(),
                    mask_segments: Vec::new(),
                    text_segments: Vec::new(),
                    caption_segments: Vec::new(),
                    keyboard_segments: Vec::new(),
                    audio_segments: Vec::new(),
                    camera3d_segments: Vec::new(),
                });
            }
        }

        let output_path = self
            .output_path
            .unwrap_or_else(|| recording_meta.output_path());
        let streaming_output = prepare_streaming_output(
            &output_path,
            cancellation.is_some() && ExportAudioRenderer::eligible(&project_config, studio_meta),
        );
        let stream_audio = streaming_output.is_some();

        let render_constants = Arc::new(
            RenderVideoConstants::new(
                &recordings.segments,
                recording_meta.clone(),
                studio_meta.clone(),
            )
            .await
            .map_err(Error::RendererSetup)?,
        );

        let audio_cancellation = if stream_audio {
            cancellation.map(ExportAudioCancellation::new)
        } else {
            None
        };
        let (segments, streaming_audio) = if let Some(control) = &audio_cancellation {
            let recording = recording_meta.clone();
            let studio = studio_meta.clone();
            let cancellation = control.user.clone();
            let abort = control.stop.clone();
            let preparation = tokio::task::spawn_blocking(move || {
                ExportAudioPreparation::open(&recording, &studio, cancellation, abort)
            });
            let segments = cap_editor::create_segments_without_audio(
                &recording_meta,
                studio_meta,
                self.force_ffmpeg_decoder,
            )
            .await;
            let (segments, audio) =
                finish_audio_preparation(segments, preparation, &control.stop).await?;
            (segments, Some(audio))
        } else {
            let segments = cap_editor::create_segments(
                &recording_meta,
                studio_meta,
                self.force_ffmpeg_decoder,
            )
            .await
            .map_err(Error::MediaLoad)?;
            for segment in &segments {
                segment.audio.get().await.map_err(Error::MediaLoad)?;
                segment.system_audio.get().await.map_err(Error::MediaLoad)?;
            }
            (segments, None)
        };

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
            streaming_audio,
            streaming_output,
            audio_cancellation,
        })
    }
}

async fn finish_audio_preparation(
    segments: Result<Vec<SegmentMedia>, String>,
    preparation: tokio::task::JoinHandle<
        Result<ExportAudioPreparation, cap_editor::ExportAudioError>,
    >,
    abort: &AtomicBool,
) -> Result<(Vec<SegmentMedia>, ExportAudioRenderer), ExporterBuildError> {
    if segments.is_err() {
        abort.store(true, Ordering::Relaxed);
    }
    let preparation = preparation.await;
    let segments = segments.map_err(ExporterBuildError::MediaLoad)?;
    let audio = preparation
        .map_err(|error| ExporterBuildError::MediaLoad(error.to_string()))?
        .map_err(|error| ExporterBuildError::MediaLoad(error.to_string()))?
        .finish(&segments)
        .map_err(|error| ExporterBuildError::MediaLoad(error.to_string()))?;
    Ok((segments, audio))
}

pub fn make_cursor_only_project(mut project_config: ProjectConfiguration) -> ProjectConfiguration {
    project_config.background.source = BackgroundSource::Color {
        value: [0, 0, 0],
        alpha: 0,
    };
    project_config.background.blur = 0.0;
    project_config.background.shadow = 0.0;
    project_config.background.advanced_shadow = None;
    project_config.background.border = None;
    project_config.captions = None;
    project_config.keyboard = None;

    if let Some(timeline) = project_config.timeline.as_mut() {
        timeline.mask_segments.clear();
        // Fullscreen text segments pause the recording clock (holds), which
        // shapes the frame count and cursor motion. Split titles also move
        // the cursor with the display, so both need invisible placeholders.
        timeline
            .text_segments
            .retain(|text| text.layout != cap_project::TextLayout::Overlay);
        for text in &mut timeline.text_segments {
            text.content.clear();
        }
        timeline.caption_segments.clear();
        timeline.keyboard_segments.clear();
    }

    project_config
}

fn prepare_streaming_output(
    output: &std::path::Path,
    eligible: bool,
) -> Option<mp4::TemporaryMp4Output> {
    if !eligible
        || output.extension().and_then(|extension| extension.to_str()) != Some("mp4")
        || !matches!(std::fs::symlink_metadata(output), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return None;
    }
    mp4::temporary_mp4_output(output).ok()
}

struct ExportAudioCancellation {
    user: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl ExportAudioCancellation {
    fn new(user: Arc<AtomicBool>) -> Self {
        Self {
            user,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Drop for ExportAudioCancellation {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub struct Mp4ExporterBase(ExporterBase);

impl Mp4ExporterBase {
    pub fn total_frames(&self, fps: u32) -> u32 {
        self.0.total_frames(fps)
    }

    pub fn uses_streaming_audio(&self) -> bool {
        self.0.streaming_audio.is_some()
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
    streaming_audio: Option<ExportAudioRenderer>,
    streaming_output: Option<mp4::TemporaryMp4Output>,
    audio_cancellation: Option<ExportAudioCancellation>,
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

#[cfg(test)]
mod cursor_only_tests {
    use super::*;
    use cap_project::TextLayout;

    #[test]
    fn cursor_only_preserves_layout_and_recording_time_without_title_pixels() {
        for hide_camera in [false, true] {
            let mut project = ProjectConfiguration::default();
            project.camera.hide = hide_camera;
            project.timeline = Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [{ "start": 0.0, "end": 8.0, "timescale": 1.0 }],
                    "zoomSegments": [],
                    "sceneSegments": [{ "start": 1.0, "end": 3.0, "mode": "splitScreen" }],
                    "textSegments": [
                        { "start": 0.0, "end": 1.0, "layout": "overlay" },
                        { "start": 1.0, "end": 2.0, "layout": "fullscreen" },
                        { "start": 2.0, "end": 3.0, "layout": "splitLeft" },
                        { "start": 3.0, "end": 4.0, "layout": "splitRight" }
                    ]
                }))
                .unwrap(),
            );
            let duration = project.timeline.as_ref().unwrap().duration();
            let cursor_only = make_cursor_only_project(project);
            let timeline = cursor_only.timeline.unwrap();
            assert_eq!(cursor_only.camera.hide, hide_camera);
            assert_eq!(timeline.duration(), duration);
            assert_eq!(
                timeline
                    .text_segments
                    .iter()
                    .map(|text| text.layout)
                    .collect::<Vec<_>>(),
                [
                    TextLayout::Fullscreen,
                    TextLayout::SplitLeft,
                    TextLayout::SplitRight
                ],
            );
            assert!(
                timeline
                    .text_segments
                    .iter()
                    .all(|text| text.content.is_empty())
            );
            assert!(matches!(
                timeline.scene_segments[0].mode,
                cap_project::SceneMode::SplitScreen
            ));
        }
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn segment_failure_aborts_and_joins_preparation_before_returning() {
        use std::time::{Duration, Instant};

        let user = Arc::new(AtomicBool::new(false));
        let control = ExportAudioCancellation::new(user.clone());
        let abort = control.stop.clone();
        let completed = Arc::new(AtomicBool::new(false));
        let worker_completed = completed.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let preparation = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            let start = Instant::now();
            while !abort.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(2) {
                std::thread::yield_now();
            }
            assert!(abort.load(Ordering::Relaxed));
            worker_completed.store(true, Ordering::Release);
            Err(cap_editor::ExportAudioError::Sink(
                "audio preparation error".into(),
            ))
        });
        entered.await.unwrap();
        let result = finish_audio_preparation(
            Err("segment setup error".into()),
            preparation,
            &control.stop,
        )
        .await;
        assert!(
            matches!(result, Err(ExporterBuildError::MediaLoad(error)) if error == "segment setup error")
        );
        assert!(completed.load(Ordering::Acquire));
        assert!(!user.load(Ordering::Relaxed));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preparation_error_or_panic_is_returned_after_successful_segment_setup() {
        let abort = AtomicBool::new(false);
        for panic in [false, true] {
            let preparation = tokio::task::spawn_blocking(move || {
                assert!(!panic, "preparation panic");
                Err(cap_editor::ExportAudioError::Sink(
                    "preparation error".into(),
                ))
            });
            let result = finish_audio_preparation(Ok(Vec::new()), preparation, &abort).await;
            let Err(ExporterBuildError::MediaLoad(error)) = result else {
                panic!("preparation failure was lost");
            };
            assert!(error.contains(if panic {
                "preparation panic"
            } else {
                "preparation error"
            }));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropped_builder_aborts_preparation_without_user_cancellation() {
        use std::time::{Duration, Instant};

        let user = Arc::new(AtomicBool::new(false));
        let worker_user = user.clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (finished, observed) = std::sync::mpsc::channel();
        let builder = tokio::spawn(async move {
            let control = ExportAudioCancellation::new(worker_user);
            let abort = control.stop.clone();
            let preparation = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                let start = Instant::now();
                while !abort.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(2) {
                    std::thread::yield_now();
                }
                finished.send(abort.load(Ordering::Relaxed)).unwrap();
                Err(cap_editor::ExportAudioError::Cancelled)
            });
            finish_audio_preparation(Ok(Vec::new()), preparation, &control.stop)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        });
        entered.await.unwrap();
        builder.abort();
        assert!(builder.await.is_err_and(|error| error.is_cancelled()));
        let stopped =
            tokio::task::spawn_blocking(move || observed.recv_timeout(Duration::from_secs(2)))
                .await
                .unwrap()
                .unwrap();
        assert!(stopped);
        assert!(!user.load(Ordering::Relaxed));
        assert_eq!(Arc::strong_count(&user), 1);
    }

    #[test]
    fn unavailable_streaming_destination_falls_back_without_creating_directories() {
        let directory = tempfile::tempdir().unwrap();
        let missing_parent = directory.path().join("missing");
        assert!(prepare_streaming_output(&missing_parent.join("export.mp4"), true).is_none());
        assert!(!missing_parent.exists());
        let existing = directory.path().join("existing.mp4");
        std::fs::write(&existing, b"existing").unwrap();
        assert!(prepare_streaming_output(&existing, true).is_none());
        assert_eq!(std::fs::read(existing).unwrap(), b"existing");
    }

    #[test]
    fn prepared_destination_is_removed_when_preparation_is_dropped() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("export.mp4");
        assert!(prepare_streaming_output(&output, false).is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        let prepared = prepare_streaming_output(&output, true).unwrap();
        let temporary_path = prepared.to_path_buf();
        assert!(temporary_path.exists());
        assert!(!output.exists());
        drop(prepared);
        assert!(!temporary_path.exists());
        assert!(!output.exists());
    }

    #[test]
    fn pipeline_stop_does_not_change_user_cancellation() {
        let user = Arc::new(AtomicBool::new(false));
        let cancellation = ExportAudioCancellation::new(user.clone());
        let stop = cancellation.stop.clone();
        drop(cancellation);
        assert!(stop.load(Ordering::Relaxed));
        assert!(!user.load(Ordering::Relaxed));
    }

    #[test]
    fn user_cancellation_does_not_change_pipeline_abort() {
        let user = Arc::new(AtomicBool::new(false));
        let cancellation = ExportAudioCancellation::new(user.clone());
        user.store(true, Ordering::Relaxed);
        assert!(cancellation.user.load(Ordering::Relaxed));
        assert!(!cancellation.stop.load(Ordering::Relaxed));
    }
}
