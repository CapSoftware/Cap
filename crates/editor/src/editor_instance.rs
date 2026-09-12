use crate::completed_audio::{CompletedAudioHandoff, CompletedAudioSegment};
use crate::editor;
use crate::playback::{self, PlaybackHandle, PlaybackStartError};
use cap_project::StudioRecordingMeta;
use cap_project::{
    CursorEvents, ProjectConfiguration, RecordingMeta, RecordingMetaInner, TimelineConfiguration,
    TimelineFrameMapping, TimelineSegment, XY,
};
use cap_rendering::{
    PrecomputedCursorTimeline, ProjectRecordingsMeta, ProjectUniforms, RecordingSegmentDecoders,
    RenderVideoConstants, SegmentVideoPaths, SharedWgpuDevice, Video, ZoomTransformTimeline,
    get_duration, spring_mass_damper::SpringMassDamperSimulationConfig,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub(super) const PREVIEW_RENDER_MAX_ATTEMPTS: u32 = 3;
pub(super) const PREVIEW_RENDER_RETRY_DELAY_MS: u64 = 120;
const PREVIEW_CURSOR_CACHE_CAPACITY: usize = 2;

#[derive(Default)]
pub(super) struct PreviewCursorCache {
    entries: Vec<PreviewCursorCacheEntry>,
}

struct PreviewCursorCacheEntry {
    recording_clip: u32,
    cursor: Arc<CursorEvents>,
    settings: [u32; 7],
    timeline: Arc<PrecomputedCursorTimeline>,
}

impl PreviewCursorCache {
    pub(super) fn get(
        &mut self,
        recording_clip: u32,
        cursor: &Arc<CursorEvents>,
        project: &ProjectConfiguration,
    ) -> Option<Arc<PrecomputedCursorTimeline>> {
        if project.cursor.raw
            && !project.timeline.as_ref().is_some_and(|timeline| {
                timeline.style_segments.iter().any(|style| {
                    style.is_active_at(style.start)
                        && style
                            .overrides
                            .cursor
                            .as_ref()
                            .is_some_and(|cursor| !cursor.raw)
                })
            })
        {
            self.entries.clear();
            return None;
        }
        if cursor.moves.is_empty() {
            self.entries
                .retain(|entry| entry.recording_clip != recording_clip);
            return None;
        }

        let smoothing = SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        };
        let click_spring = project.cursor.click_spring_config();
        let settings = [
            u32::from(project.cursor.raw),
            smoothing.tension.to_bits(),
            smoothing.mass.to_bits(),
            smoothing.friction.to_bits(),
            click_spring.tension.to_bits(),
            click_spring.mass.to_bits(),
            click_spring.friction.to_bits(),
        ];

        if let Some(index) = self.entries.iter().position(|entry| {
            entry.recording_clip == recording_clip
                && Arc::ptr_eq(&entry.cursor, cursor)
                && entry.settings == settings
        }) {
            let entry = self.entries.remove(index);
            let timeline = Arc::clone(&entry.timeline);
            self.entries.push(entry);
            return Some(timeline);
        }

        self.entries
            .retain(|entry| entry.recording_clip != recording_clip);
        if self.entries.len() == PREVIEW_CURSOR_CACHE_CAPACITY {
            self.entries.remove(0);
        }

        let timeline = Arc::new(PrecomputedCursorTimeline::new(
            cursor,
            (!project.cursor.raw).then_some(smoothing),
            Some(click_spring),
        ));
        self.entries.push(PreviewCursorCacheEntry {
            recording_clip,
            cursor: Arc::clone(cursor),
            settings,
            timeline: Arc::clone(&timeline),
        });
        Some(timeline)
    }
}

fn get_video_duration_fallback(path: &Path) -> Option<f64> {
    tracing::debug!("get_video_duration_fallback called for: {:?}", path);
    let input = match ffmpeg::format::input(path) {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("get_video_duration_fallback: failed to open input: {}", e);
            return None;
        }
    };

    let container_duration = input.duration();
    tracing::debug!(
        "get_video_duration_fallback: container_duration (raw i64) = {}",
        container_duration
    );
    if container_duration > 0 {
        let secs = container_duration as f64 / 1_000_000.0;
        tracing::debug!(
            "get_video_duration_fallback: returning container duration {} seconds",
            secs
        );
        return Some(secs);
    }

    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    let stream_duration = stream.duration();
    let time_base = stream.time_base();
    tracing::debug!(
        "get_video_duration_fallback: stream_duration = {}, time_base = {}/{}",
        stream_duration,
        time_base.numerator(),
        time_base.denominator()
    );
    if stream_duration > 0 && time_base.denominator() > 0 {
        let secs =
            stream_duration as f64 * time_base.numerator() as f64 / time_base.denominator() as f64;
        tracing::debug!(
            "get_video_duration_fallback: returning stream duration {} seconds",
            secs
        );
        Some(secs)
    } else {
        tracing::warn!("get_video_duration_fallback: no valid duration found");
        None
    }
}

fn display_video_duration(path: &Path) -> Option<f64> {
    match Video::new(path, 0.0) {
        Ok(v) => Some(v.duration),
        Err(e) => {
            warn!(
                "Failed to load video for duration calculation: {} (path: {}), trying fallback",
                e,
                path.display()
            );
            get_video_duration_fallback(path)
        }
    }
}

pub struct EditorInstance {
    preparing_adoption: std::sync::Mutex<Option<crate::PreparingPlaybackAdoption>>,
    completed_track_identity: Option<crate::preparing_handoff::CompletedTrackIdentity>,
    pub project_path: PathBuf,
    pub recordings: Arc<ProjectRecordingsMeta>,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    playback_active: watch::Sender<bool>,
    playback_active_rx: watch::Receiver<bool>,
    // Guards playback_active against a restart race: the event pump of a
    // replaced playback receives its Stop after the successor already sent
    // true, and without the epoch check that late Stop would flip the watch
    // to false while the new playback is running.
    playback_epoch: AtomicU64,
    pub state: Arc<Mutex<EditorState>>,
    on_state_change: Box<dyn Fn(&EditorState) + Send + Sync + 'static>,
    pub preview_tx: watch::Sender<Option<PreviewFrameInstruction>>,
    pub project_config: (
        watch::Sender<ProjectConfiguration>,
        watch::Receiver<ProjectConfiguration>,
    ),
    pub segment_medias: Arc<Vec<SegmentMedia>>,
    music_cache: Arc<std::sync::Mutex<crate::MusicTracks>>,
    meta: RecordingMeta,
    pub export_preview_active: AtomicBool,
    pub export_active: AtomicBool,
    runtime_handle: tokio::runtime::Handle,
    audio_output: Arc<crate::AudioOutput>,
}

impl EditorInstance {
    pub async fn new(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
    ) -> Result<Arc<Self>, String> {
        Self::new_with_audio_output(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            Arc::new(crate::AudioOutput::new()),
        )
        .await
    }

    pub async fn new_with_frame_format(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        frame_format: editor::EditorFrameFormat,
    ) -> Result<Arc<Self>, String> {
        Self::new_with_audio_output_and_frame_format(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            frame_format,
            Arc::new(crate::AudioOutput::new()),
        )
        .await
    }

    /// Like [`EditorInstance::new`] but with a caller-provided audio output,
    /// letting harnesses substitute a headless sink while everything else
    /// (decoders, renderer, playback) runs the production path.
    pub async fn new_with_audio_output(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        audio_output: Arc<crate::AudioOutput>,
    ) -> Result<Arc<Self>, String> {
        Self::new_with_audio_output_and_frame_format(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            editor::EditorFrameFormat::Rgba,
            audio_output,
        )
        .await
    }

    pub async fn new_with_audio_output_and_frame_format(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        frame_format: editor::EditorFrameFormat,
        audio_output: Arc<crate::AudioOutput>,
    ) -> Result<Arc<Self>, String> {
        Self::new_inner(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            frame_format,
            audio_output,
            EditorStartupInputs::default(),
        )
        .await
    }

    pub async fn new_with_preloaded_recordings(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        frame_format: editor::EditorFrameFormat,
        audio_output: Arc<crate::AudioOutput>,
        recordings: Arc<ProjectRecordingsMeta>,
    ) -> Result<Arc<Self>, String> {
        Self::new_inner(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            frame_format,
            audio_output,
            EditorStartupInputs {
                recordings: Some(recordings),
                completed_audio: None,
            },
        )
        .await
    }

    pub async fn new_with_startup_inputs(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        frame_format: editor::EditorFrameFormat,
        audio_output: Arc<crate::AudioOutput>,
        inputs: EditorStartupInputs,
    ) -> Result<Arc<Self>, String> {
        Self::new_inner(
            project_path,
            on_state_change,
            frame_cb,
            shared_device,
            frame_format,
            audio_output,
            inputs,
        )
        .await
    }

    async fn new_inner(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        shared_device: Option<SharedWgpuDevice>,
        frame_format: editor::EditorFrameFormat,
        audio_output: Arc<crate::AudioOutput>,
        inputs: EditorStartupInputs,
    ) -> Result<Arc<Self>, String> {
        let EditorStartupInputs {
            recordings: preloaded_recordings,
            completed_audio,
        } = inputs;
        if !project_path.exists() {
            return Err(format!("Video path {} not found!", project_path.display()));
        }

        let recording_meta = cap_project::RecordingMeta::load_for_project(&project_path)
            .map_err(|e| format!("Failed to load recording meta: {e}"))?;

        let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
            return Err("Cannot edit non-studio recordings".to_string());
        };

        meta.ensure_ordinary_media_access(&project_path)?;

        let segment_count = match meta.as_ref() {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };

        if segment_count == 0 {
            return Err(
                "Recording has no segments. It may need to be recovered first.".to_string(),
            );
        }

        let mut project = recording_meta.project_config();

        if project.timeline.is_none() {
            warn!("Project config has no timeline, creating one from recording segments");
            let timeline_segments = match meta.as_ref() {
                StudioRecordingMeta::SingleSegment { segment } => {
                    let display_path = recording_meta.path(&segment.display.path);
                    match display_video_duration(&display_path) {
                        Some(duration) if duration > 0.0 => vec![TimelineSegment {
                            recording_clip: 0,
                            start: 0.0,
                            end: duration,
                            timescale: 1.0,
                            name: None,
                            speed_audio_mode: None,
                        }],
                        _ => {
                            warn!(
                                "Failed to determine display duration for {}, leaving timeline unset",
                                display_path.display()
                            );
                            Vec::new()
                        }
                    }
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .enumerate()
                    .filter_map(|(i, segment)| {
                        let display_path = recording_meta.path(&segment.display.path);
                        tracing::debug!(
                            "Attempting to get duration for segment {}: {:?}",
                            i,
                            display_path
                        );
                        let duration = display_video_duration(&display_path)?;
                        tracing::debug!("Final duration for segment {}: {}", i, duration);
                        if duration <= 0.0 {
                            return None;
                        }
                        Some(TimelineSegment {
                            recording_clip: i as u32,
                            start: 0.0,
                            end: duration,
                            timescale: 1.0,
                            name: None,
                            speed_audio_mode: None,
                        })
                    })
                    .collect(),
            };

            if !timeline_segments.is_empty() {
                project.timeline = Some(TimelineConfiguration {
                    segments: timeline_segments,
                    transitions: Vec::new(),
                    zoom_segments: Vec::new(),
                    scene_segments: Vec::new(),
                    style_segments: Vec::new(),
                    image_segments: Vec::new(),
                    mask_segments: Vec::new(),
                    text_segments: Vec::new(),
                    caption_segments: Vec::new(),
                    keyboard_segments: Vec::new(),
                    audio_segments: Vec::new(),
                    camera3d_segments: Vec::new(),
                });

                if let Err(e) = project.write(&recording_meta.project_path) {
                    warn!("Failed to save auto-generated timeline: {}", e);
                }
            }
        }

        if project.clips.is_empty() {
            project.clips = initial_clip_configuration(&recording_meta.project_path, meta);

            if let Err(e) = project.write(&recording_meta.project_path) {
                warn!("Failed to save auto-generated clip offsets: {}", e);
            }
        }

        // Segment setup (decoder init + kicking off audio decodes) is
        // independent of the GPU/render setup below, so run it concurrently on
        // its own task.
        // The env override lets headless harnesses on runners whose
        // VideoToolbox is too slow for real-time playback fall back to the
        // FFmpeg decoder.
        let force_ffmpeg_for_editor = cfg!(target_os = "windows")
            || std::env::var_os("CAP_EDITOR_FORCE_FFMPEG_DECODER").is_some();
        if force_ffmpeg_for_editor {
            tracing::info!("Using FFmpeg decoder for editor preview");
        }

        let completed_audio = completed_audio.and_then(|handoff| {
            let matching = handoff.into_matching(&recording_meta, meta);
            if matching.is_none() {
                tracing::debug!("Completed preparing audio did not match finalized metadata; decoding ordinary sources");
            }
            matching
        });
        let completed_track_identity = completed_audio
            .as_deref()
            .map(crate::preparing_handoff::completed_track_identity);
        let segments_task = tokio::spawn({
            let recording_meta = recording_meta.clone();
            let studio_meta = (**meta).clone();
            async move {
                create_segments_with_audio(
                    &recording_meta,
                    &studio_meta,
                    force_ffmpeg_for_editor,
                    true,
                    completed_audio.as_deref(),
                )
                .await
            }
        });

        // Open the session's audio output stream now (in the background) so
        // the first play press doesn't wait on the device — Bluetooth outputs
        // in particular can take seconds to wake.
        let has_declared_audio = match meta.as_ref() {
            StudioRecordingMeta::SingleSegment { segment } => segment.audio.is_some(),
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .any(|s| s.mic.is_some() || s.system_audio.is_some()),
        };
        let has_music = project
            .timeline
            .as_ref()
            .map(|t| !t.audio_segments.is_empty())
            .unwrap_or(false);
        if has_declared_audio || has_music {
            audio_output.prewarm();
        }

        let music_cache = Arc::new(std::sync::Mutex::new(crate::MusicTracks::new()));
        if has_music {
            let project = project.clone();
            let project_path = project_path.clone();
            let cache = Arc::clone(&music_cache);
            tokio::task::spawn_blocking(move || {
                let mut cache = cache
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                drop(crate::load_music_tracks(
                    &project,
                    &project_path,
                    &mut cache,
                ));
            });
        }

        let recordings = match preloaded_recordings {
            Some(recordings) => recordings,
            None => Arc::new(ProjectRecordingsMeta::new(
                &recording_meta.project_path,
                meta.as_ref(),
            )?),
        };

        cap_project::synchronize_legacy_keyboard(&recording_meta, &mut project);
        cap_project::synchronize_captions(
            &mut project,
            &recordings
                .segments
                .iter()
                .map(|segment| segment.display.duration)
                .collect::<Vec<_>>(),
        );

        let render_constants = if let Some(shared) = shared_device {
            let rc = RenderVideoConstants::new_with_device(
                shared,
                &recordings.segments,
                recording_meta.clone(),
                (**meta).clone(),
            )
            .map_err(|e| format!("Failed to create render constants: {e}"))?;
            Arc::new(rc)
        } else {
            let rc = RenderVideoConstants::new(
                &recordings.segments,
                recording_meta.clone(),
                (**meta).clone(),
            )
            .await
            .map_err(|e| format!("Failed to create render constants: {e}"))?;
            Arc::new(rc)
        };

        let layers_rx = editor::start_renderer_layers_creation(&render_constants, &project);

        let segments = segments_task
            .await
            .map_err(|e| format!("Segment setup task failed: {e}"))??;
        let layers_rx = editor::finish_renderer_layers_creation(layers_rx).await;

        let renderer = Arc::new(editor::Renderer::spawn_with_format(
            render_constants.clone(),
            frame_cb,
            layers_rx,
            frame_format,
        )?);

        let (preview_tx, preview_rx) = watch::channel(None);
        let (playback_active_tx, playback_active_rx) = watch::channel(false);

        let this = Arc::new(Self {
            preparing_adoption: std::sync::Mutex::new(None),
            completed_track_identity,
            project_path,
            recordings,
            renderer,
            render_constants,
            state: Arc::new(Mutex::new(EditorState {
                playhead_position: 0,
                playback_task: None,
                preview_task: None,
            })),
            on_state_change: Box::new(on_state_change),
            preview_tx,
            project_config: watch::channel(project),
            segment_medias: Arc::new(segments),
            music_cache,
            meta: recording_meta,
            playback_active: playback_active_tx,
            playback_active_rx,
            export_preview_active: AtomicBool::new(false),
            export_active: AtomicBool::new(false),
            playback_epoch: AtomicU64::new(0),
            runtime_handle: tokio::runtime::Handle::current(),
            audio_output,
        });

        this.state.lock().await.preview_task =
            Some(this.clone().spawn_preview_renderer(preview_rx));

        Ok(this)
    }

    pub async fn install_preparing_handoff(
        &self,
        handoff: &crate::PreparingPlaybackHandoff,
    ) -> Result<(), String> {
        if self.preparing_adoption().is_some() {
            return Err("Editor already has a preparing candidate".into());
        }
        let admission = if self
            .completed_track_identity
            .as_ref()
            .is_some_and(|identity| handoff.matches_completed_audio(identity, &self.audio_output))
        {
            handoff.prepare_when_settled().await
        } else {
            Err("Preparing audio does not match this editor's completed sources or output".into())
        };
        let adoption = match admission {
            Ok(adoption) => adoption,
            Err(error) => {
                let exit = handoff.stop_and_wait().await;
                self.dispose().await;
                return Err(if exit.cleanup_failed {
                    format!("{error}; preparing audio ownership could not be released")
                } else {
                    error
                });
            }
        };
        *self
            .preparing_adoption
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(adoption);
        Ok(())
    }

    pub fn preparing_adoption(&self) -> Option<crate::PreparingPlaybackAdoption> {
        self.preparing_adoption
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn commit_preparing_frame(&self, frame: u32, fps: u32) -> bool {
        self.preparing_adoption()
            .is_some_and(|adoption| adoption.try_commit(frame, fps))
    }

    pub async fn start_preparing_handoff(
        self: &Arc<Self>,
        fps: u32,
        resolution: XY<u32>,
    ) -> Result<bool, PlaybackStartError> {
        let Some(adoption) = self.preparing_adoption() else {
            return Ok(false);
        };
        let Some(snapshot) = adoption.snapshot() else {
            return Ok(false);
        };
        if !snapshot.playback.playing {
            return Ok(false);
        }
        let frame = crate::preparing_handoff::presentation_frame(&snapshot, fps);
        self.start_playback_internal(fps, resolution, Some(frame), Some(adoption))
            .await?;
        Ok(true)
    }

    pub async fn recreate_preparing_candidate(
        self: &Arc<Self>,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: editor::EditorFrameCallback,
        frame_format: editor::EditorFrameFormat,
    ) -> Result<Arc<Self>, String> {
        let adoption = self
            .preparing_adoption()
            .ok_or("Editor has no preparing candidate")?;
        if !adoption.invalidated() {
            return Err("Preparing candidate is still current".into());
        }
        self.dispose().await;
        let adoption = adoption.retry().await?;
        let project = self.project_config.1.borrow().clone();
        let layers = editor::start_renderer_layers_creation(&self.render_constants, &project);
        let layers = editor::finish_renderer_layers_creation(layers).await;
        let renderer = Arc::new(editor::Renderer::spawn_with_format(
            self.render_constants.clone(),
            frame_cb,
            layers,
            frame_format,
        )?);
        let (preview_tx, preview_rx) = watch::channel(None);
        let (playback_active, playback_active_rx) = watch::channel(false);
        let next = Arc::new(Self {
            preparing_adoption: std::sync::Mutex::new(Some(adoption)),
            completed_track_identity: self.completed_track_identity.clone(),
            project_path: self.project_path.clone(),
            recordings: self.recordings.clone(),
            renderer,
            render_constants: self.render_constants.clone(),
            playback_active,
            playback_active_rx,
            playback_epoch: AtomicU64::new(0),
            state: Arc::new(Mutex::new(EditorState {
                playhead_position: 0,
                playback_task: None,
                preview_task: None,
            })),
            on_state_change: Box::new(on_state_change),
            preview_tx,
            project_config: self.project_config.clone(),
            segment_medias: self.segment_medias.clone(),
            music_cache: self.music_cache.clone(),
            meta: self.meta.clone(),
            export_preview_active: AtomicBool::new(false),
            export_active: AtomicBool::new(false),
            runtime_handle: self.runtime_handle.clone(),
            audio_output: self.audio_output.clone(),
        });
        next.state.lock().await.preview_task =
            Some(next.clone().spawn_preview_renderer(preview_rx));
        Ok(next)
    }

    pub fn meta(&self) -> &RecordingMeta {
        &self.meta
    }

    pub async fn dispose(&self) {
        self.playback_epoch.fetch_add(1, Ordering::SeqCst);
        let mut state = self.state.lock().await;

        if let Some(handle) = state.playback_task.take() {
            handle.stop();
        }

        if let Some(task) = state.preview_task.take() {
            task.abort();
            if let Err(e) = task.await {
                if e.is_cancelled() {
                    tracing::debug!("preview task cancelled during editor disposal");
                } else {
                    tracing::warn!("preview task abort await failed: {e}");
                }
            }
        }

        self.renderer.stop().await;

        let adoption = self.preparing_adoption();
        let owns_output = adoption.as_ref().is_none_or(|adoption| adoption.is_owner());
        if let Some(adoption) = adoption {
            drop(adoption.stop_and_wait().await);
        }
        if owns_output {
            self.audio_output.shutdown();
        }

        tokio::task::yield_now().await;

        drop(state);
    }

    pub async fn modify_and_emit_state(&self, modify: impl Fn(&mut EditorState)) {
        let mut state = self.state.lock().await;
        modify(&mut state);
        (self.on_state_change)(&state);
    }

    /// Decodes (and caches) the music tracks referenced by the current project
    /// config off the async runtime so playback start isn't blocked by ffmpeg.
    async fn load_music_tracks(&self) -> crate::MusicTracks {
        let project = self.project_config.1.borrow().clone();
        let project_path = self.project_path.clone();
        let cache = self.music_cache.clone();

        tokio::task::spawn_blocking(move || {
            let mut cache = cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            crate::load_music_tracks(&project, &project_path, &mut cache)
        })
        .await
        .unwrap_or_default()
    }

    pub async fn start_playback(self: &Arc<Self>, fps: u32, resolution_base: XY<u32>) {
        if let Err(error) = self
            .start_playback_with_handle(fps, resolution_base, None)
            .await
        {
            warn!(fps, ?error, "Skipping playback start");
        }
    }

    pub async fn start_playback_with_handle(
        self: &Arc<Self>,
        fps: u32,
        resolution_base: XY<u32>,
        start_frame_number: Option<u32>,
    ) -> Result<PlaybackHandle, PlaybackStartError> {
        let adoption = self.preparing_adoption();
        if let Some(adoption) = adoption {
            if !adoption.is_owner() {
                return Err(PlaybackStartError::PreparingCandidate);
            }
            if adoption
                .stop_and_wait()
                .await
                .is_some_and(|exit| exit.cleanup_failed)
            {
                return Err(PlaybackStartError::PreparingCleanup);
            }
            drop(
                self.preparing_adoption
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take(),
            );
        }
        self.start_playback_internal(fps, resolution_base, start_frame_number, None)
            .await
    }

    async fn start_playback_internal(
        self: &Arc<Self>,
        fps: u32,
        resolution_base: XY<u32>,
        start_frame_number: Option<u32>,
        adoption: Option<crate::PreparingPlaybackAdoption>,
    ) -> Result<PlaybackHandle, PlaybackStartError> {
        let music = self.load_music_tracks().await;

        let (mut handle, prev, epoch) = {
            let mut state = self.state.lock().await;

            if let Some(frame_number) = start_frame_number {
                state.playhead_position = frame_number;
            }
            let start_frame_number = start_frame_number.unwrap_or(state.playhead_position);

            let playback = playback::Playback {
                segment_medias: self.segment_medias.clone(),
                music: music.clone(),
                renderer: self.renderer.clone(),
                render_constants: self.render_constants.clone(),
                start_frame_number,
                project: self.project_config.0.subscribe(),
                audio_output: self.audio_output.clone(),
                telemetry: None,
            };
            let playback_handle = if let Some(adoption) = adoption {
                playback
                    .start_with_adopted_audio(fps, resolution_base, adoption)
                    .await?
            } else {
                playback
                    .start_with_diagnostics(
                        fps,
                        resolution_base,
                        Some(cap_utils::operation_diagnostics::resource_id(
                            &self.project_path,
                        )),
                    )
                    .await?
            };

            let epoch = self.playback_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            if let Err(e) = self.playback_active.send(true) {
                tracing::warn!(%e, "failed to send playback_active=true");
            }

            let prev = state.playback_task.replace(playback_handle.clone());

            (playback_handle, prev, epoch)
        };

        let owned_handle = handle.clone();
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let event = *handle.receive_event().await;
                if this.playback_epoch.load(Ordering::SeqCst) == epoch
                    && handle.preparing_audio_released()
                {
                    drop(
                        this.preparing_adoption
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .take(),
                    );
                }

                match event {
                    playback::PlaybackEvent::Start => {}
                    playback::PlaybackEvent::Frame(frame_number) => {
                        if this.playback_epoch.load(Ordering::SeqCst) != epoch {
                            continue;
                        }
                        this.modify_and_emit_state(|state| {
                            state.playhead_position = frame_number;
                        })
                        .await;
                    }
                    playback::PlaybackEvent::Stop => {
                        if this.playback_epoch.load(Ordering::SeqCst) == epoch
                            && let Err(e) = this.playback_active.send(false)
                        {
                            tracing::warn!(%e, "failed to send playback_active=false");
                        }
                        return;
                    }
                }
            }
        });

        if let Some(prev) = prev {
            prev.stop();
        }
        Ok(owned_handle)
    }

    /// True while a playback engine is live. Epoch-guarded against restart
    /// races, so a false here means the engine genuinely stopped -- end of
    /// timeline, warmup abort, or error -- not a stop/start transition.
    pub fn playback_watch(&self) -> watch::Receiver<bool> {
        self.playback_active_rx.clone()
    }

    /// Live-seek the running playback. Returns false when no engine is
    /// running (or it died before the seek landed); the caller decides
    /// whether that means a plain playhead move or a restart.
    pub async fn seek_playback(&self, frame_number: u32) -> bool {
        let state = self.state.lock().await;
        state
            .playback_task
            .as_ref()
            .is_some_and(|handle| handle.seek(frame_number))
    }

    fn spawn_preview_renderer(
        self: Arc<Self>,
        mut preview_rx: watch::Receiver<Option<(u32, u32, XY<u32>)>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut prefetch_cancel_token: Option<CancellationToken> = None;
            let mut cursor_cache = PreviewCursorCache::default();

            loop {
                preview_rx.changed().await.unwrap();

                loop {
                    let Some((frame_number, fps, resolution_base)) =
                        *preview_rx.borrow_and_update()
                    else {
                        break;
                    };

                    if let Some(token) = prefetch_cancel_token.take() {
                        token.cancel();
                    }

                    if *self.playback_active_rx.borrow() {
                        break;
                    }

                    if self.export_active.load(Ordering::Acquire) {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        break;
                    }

                    let project = self.project_config.1.borrow().clone();
                    let frame_time = frame_number as f64 / fps as f64;
                    let transition_mapping = project.timeline.as_ref().and_then(|timeline| {
                        if timeline.transitions.is_empty() {
                            return None;
                        }
                        match timeline.get_frame_mapping(frame_time) {
                            Some(TimelineFrameMapping::Transition {
                                outgoing,
                                kind,
                                progress,
                                ..
                            }) => Some((outgoing, kind, progress)),
                            _ => None,
                        }
                    });

                    let Some((segment_time, segment)) = project.get_segment_time(frame_time) else {
                        warn!(
                            "Preview renderer: no segment found for frame {}",
                            frame_number
                        );
                        break;
                    };

                    let segment_medias = &self.segment_medias[segment.recording_clip as usize];
                    let clip_config = project
                        .clips
                        .iter()
                        .find(|v| v.index == segment.recording_clip);
                    let clip_offsets = clip_config.map(|v| v.offsets).unwrap_or_default();

                    let new_cancel_token = CancellationToken::new();
                    prefetch_cancel_token = Some(new_cancel_token.clone());

                    tokio::select! {
                        biased;

                        _ = preview_rx.changed() => {
                            continue;
                        }

                        segment_frames_opt = segment_medias.decoders.get_frames_initial(
                            segment_time as f32,
                            project.requires_camera(),
                            true,
                            clip_offsets,
                        ) => {
                            if preview_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            if segment_frames_opt.is_none() {
                                warn!("Preview renderer: no frames returned for frame {}", frame_number);
                                break;
                            }

                            let total_duration = project
                                .timeline
                                .as_ref()
                                .map(|t| t.duration())
                                .unwrap_or(0.0);

                            // Scrub renders sample the same precomputed spring
                            // timeline playback and export use (the old focus
                            // interpolator was never precomputed here and fell
                            // back to a divergent direct interpolation).
                            let mut zoom_timeline =
                                ZoomTransformTimeline::from_project_for_clip(
                                &project,
                                &segment_medias.cursor,
                                total_duration,
                                self.render_constants.options.screen_size,
                                segment.recording_clip,
                            );
                            zoom_timeline
                                .ensure_precomputed_until((frame_number as f32 + 1.0) / fps as f32);

                            let outgoing_transition = if let Some((outgoing, kind, progress)) =
                                transition_mapping
                            {
                                let outgoing_media =
                                    &self.segment_medias[outgoing.segment.recording_clip as usize];
                                let outgoing_offsets = project
                                    .clips
                                    .iter()
                                    .find(|clip| clip.index == outgoing.segment.recording_clip)
                                    .map(|clip| clip.offsets)
                                    .unwrap_or_default();
                                let outgoing_frames = tokio::select! {
                                    biased;
                                    _ = preview_rx.changed() => {
                                        continue;
                                    }
                                    frames = outgoing_media.decoders.get_frames_initial(
                                        outgoing.source_time as f32,
                                        project.requires_camera(),
                                        true,
                                        outgoing_offsets,
                                    ) => frames,
                                };
                                if let Some(outgoing_frames) = outgoing_frames {
                                    let mut outgoing_zoom =
                                        ZoomTransformTimeline::from_project_for_outgoing_clip(
                                            &project,
                                            &outgoing_media.cursor,
                                            total_duration,
                                            self.render_constants.options.screen_size,
                                            outgoing.segment.recording_clip,
                                        );
                                    outgoing_zoom.ensure_precomputed_until(
                                        (frame_number as f32 + 1.0) / fps as f32,
                                    );
                                    let outgoing_cursor_timeline = cursor_cache.get(
                                        outgoing.segment.recording_clip,
                                        &outgoing_media.cursor,
                                        &project,
                                    );
                                    if preview_rx.has_changed().unwrap_or(false) {
                                        continue;
                                    }
                                    let outgoing_uniforms = if let Some(cursor_timeline) =
                                        &outgoing_cursor_timeline
                                    {
                                        ProjectUniforms::new_with_precomputed_cursor(
                                            &self.render_constants,
                                            &project,
                                            frame_number,
                                            fps,
                                            resolution_base,
                                            &outgoing_media.cursor,
                                            &outgoing_frames,
                                            total_duration,
                                            &outgoing_zoom,
                                            cursor_timeline,
                                        )
                                    } else {
                                        ProjectUniforms::new(
                                            &self.render_constants,
                                            &project,
                                            frame_number,
                                            fps,
                                            resolution_base,
                                            &outgoing_media.cursor,
                                            &outgoing_frames,
                                            total_duration,
                                            &outgoing_zoom,
                                        )
                                    };
                                    Some((
                                        outgoing_frames,
                                        outgoing_uniforms,
                                        outgoing_media.cursor.clone(),
                                        kind,
                                        progress as f32,
                                    ))
                                } else {
                                    None
                                }
                            } else {
                                None
                            };

                            if preview_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            let cursor_timeline = cursor_cache.get(
                                segment.recording_clip,
                                &segment_medias.cursor,
                                &project,
                            );
                            if preview_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            let mut next_segment_frames = segment_frames_opt;
                            let mut rendered = false;

                            for attempt in 0..PREVIEW_RENDER_MAX_ATTEMPTS {
                                let Some(segment_frames) = next_segment_frames.take() else {
                                    break;
                                };

                                let uniforms = if let Some(cursor_timeline) = &cursor_timeline {
                                    ProjectUniforms::new_with_precomputed_cursor(
                                        &self.render_constants,
                                        &project,
                                        frame_number,
                                        fps,
                                        resolution_base,
                                        &segment_medias.cursor,
                                        &segment_frames,
                                        total_duration,
                                        &zoom_timeline,
                                        cursor_timeline,
                                    )
                                } else {
                                    ProjectUniforms::new(
                                        &self.render_constants,
                                        &project,
                                        frame_number,
                                        fps,
                                        resolution_base,
                                        &segment_medias.cursor,
                                        &segment_frames,
                                        total_duration,
                                        &zoom_timeline,
                                    )
                                };

                                let render_confirmed = if let Some((
                                    outgoing_frames,
                                    outgoing_uniforms,
                                    outgoing_cursor,
                                    kind,
                                    progress,
                                )) = &outgoing_transition
                                {
                                    self.renderer
                                        .render_transition_frame_confirmed(
                                            editor::RendererTransitionInput {
                                                segment_frames: outgoing_frames.clone(),
                                                uniforms: outgoing_uniforms.clone(),
                                                cursor: outgoing_cursor.clone(),
                                            },
                                            editor::RendererTransitionInput {
                                                segment_frames,
                                                uniforms,
                                                cursor: segment_medias.cursor.clone(),
                                            },
                                            *kind,
                                            *progress,
                                        )
                                        .await
                                } else {
                                    self.renderer
                                        .render_frame_confirmed(
                                            segment_frames,
                                            uniforms,
                                            segment_medias.cursor.clone(),
                                        )
                                        .await
                                };
                                if render_confirmed {
                                    rendered = true;
                                    break;
                                }

                                if preview_rx.has_changed().unwrap_or(false) {
                                    break;
                                }

                                if attempt + 1 < PREVIEW_RENDER_MAX_ATTEMPTS {
                                    tokio::time::sleep(std::time::Duration::from_millis(
                                        PREVIEW_RENDER_RETRY_DELAY_MS,
                                    ))
                                    .await;
                                    next_segment_frames = segment_medias
                                        .decoders
                                        .get_frames(
                                            segment_time as f32,
                                            project.requires_camera(),
                                            true,
                                            clip_offsets,
                                        )
                                        .await;
                                }
                            }

                            if !rendered && !preview_rx.has_changed().unwrap_or(false) {
                                warn!(
                                    frame_number,
                                    attempts = PREVIEW_RENDER_MAX_ATTEMPTS,
                                    "Preview renderer: frame render failed"
                                );
                            }

                            if rendered
                                && !preview_rx.has_changed().unwrap_or(true)
                                && !*self.playback_active_rx.borrow()
                                && !self.export_preview_active.load(Ordering::Acquire)
                                && !self.export_active.load(Ordering::Acquire)
                            {
                                let this = self.clone();
                                let project = project.clone();
                                let cancel_token = new_cancel_token.clone();
                                let playback_rx = self.playback_active_rx.clone();
                                tokio::spawn(async move {
                                    for offset in 1..=15u32 {
                                        if cancel_token.is_cancelled()
                                            || *playback_rx.borrow()
                                            || this.export_preview_active.load(Ordering::Acquire)
                                            || this.export_active.load(Ordering::Acquire)
                                        {
                                            break;
                                        }

                                        let prefetch_frame =
                                            frame_number.saturating_add(offset);
                                        let Some((prefetch_segment_time, prefetch_segment)) =
                                            project.get_segment_time(
                                                prefetch_frame as f64 / fps as f64,
                                            )
                                        else {
                                            continue;
                                        };
                                        let Some(prefetch_segment_media) = this
                                            .segment_medias
                                            .get(prefetch_segment.recording_clip as usize)
                                        else {
                                            continue;
                                        };
                                        let prefetch_clip_offsets = project
                                            .clips
                                            .iter()
                                            .find(|v| {
                                                v.index == prefetch_segment.recording_clip
                                            })
                                            .map(|v| v.offsets)
                                            .unwrap_or_default();
                                        tokio::select! {
                                            biased;
                                            _ = cancel_token.cancelled() => break,
                                            _ = prefetch_segment_media.decoders.get_frames(
                                                prefetch_segment_time as f32,
                                                project.requires_camera(),
                                                true,
                                                prefetch_clip_offsets,
                                            ) => {}
                                        }

                                        if cancel_token.is_cancelled() {
                                            break;
                                        }
                                    }
                                });
                            }
                        }
                    }

                    break;
                }
            }
        })
    }

    fn get_studio_meta(&self) -> &StudioRecordingMeta {
        match &self.meta.inner {
            RecordingMetaInner::Studio(meta) => meta.as_ref(),
            _ => panic!("Not a studio recording"),
        }
    }

    pub fn get_total_frames(&self, fps: u32) -> u32 {
        let duration = get_duration(
            &self.recordings,
            &self.meta,
            self.get_studio_meta(),
            &self.project_config.1.borrow(),
        );

        (fps as f64 * duration).ceil() as u32
    }
}

impl Drop for EditorInstance {
    fn drop(&mut self) {
        let renderer = self.renderer.clone();
        let state = self.state.clone();
        let handle = self.runtime_handle.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            handle.spawn(async move {
                let mut state = state.lock().await;
                if let Some(playback) = state.playback_task.take() {
                    playback.stop();
                }
                if let Some(task) = state.preview_task.take() {
                    task.abort();
                }
                drop(state);
                renderer.stop().await;
            });
        }));

        if result.is_err() {
            tracing::warn!("EditorInstance cleanup skipped — runtime is no longer available");
        }
    }
}

type PreviewFrameInstruction = (u32, u32, XY<u32>);

pub struct EditorState {
    pub playhead_position: u32,
    pub playback_task: Option<PlaybackHandle>,
    pub preview_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct SegmentMedia {
    pub audio: AudioLoader,
    pub system_audio: AudioLoader,
    pub audio_timing_repair: SegmentAudioTimingRepair,
    pub cursor: Arc<CursorEvents>,
    pub keyboard: Arc<cap_project::KeyboardEvents>,
    pub decoders: RecordingSegmentDecoders,
}

pub type AudioLoader = cap_audio::ProgressiveAudio;

#[derive(Default)]
pub struct EditorStartupInputs {
    pub recordings: Option<Arc<ProjectRecordingsMeta>>,
    pub completed_audio: Option<CompletedAudioHandoff>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SegmentAudioTimingRepair {
    pub mic_offset_secs: f32,
    pub system_audio_offset_secs: f32,
}

#[derive(Clone, Copy)]
enum LegacyAudioLogTrack {
    Mic,
    SystemAudio,
}

impl LegacyAudioLogTrack {
    fn span(self) -> &'static str {
        match self {
            Self::Mic => "mic-out",
            Self::SystemAudio => "system-audio-out",
        }
    }
}

struct LegacyAudioTimingRepair<'a> {
    log: Option<&'a str>,
}

impl LegacyAudioTimingRepair<'_> {
    fn offset(
        &self,
        segment_index: usize,
        track: LegacyAudioLogTrack,
        structured_summary: Option<&cap_project::AudioGapSummary>,
    ) -> f32 {
        let structured_offset = audio_timing_repair_offset(structured_summary);
        if structured_offset != 0.0 {
            return structured_offset;
        }

        let should_try_legacy = match structured_summary {
            Some(summary) => {
                summary.startup_overlap_trimmed_ms == 0 && summary.total_overlap_trimmed_ms > 0
            }
            None => true,
        };
        if !should_try_legacy {
            return 0.0;
        }

        self.summary(segment_index, track)
            .as_ref()
            .map(|summary| audio_timing_repair_offset(Some(summary)))
            .unwrap_or(0.0)
    }

    fn summary(
        &self,
        segment_index: usize,
        track: LegacyAudioLogTrack,
    ) -> Option<cap_project::AudioGapSummary> {
        legacy_audio_gap_summary_from_log(self.log?, segment_index, track)
    }
}

const MIN_STALE_STARTUP_DROPS: u32 = 3;
const MIN_STALE_STARTUP_TRIMMED_MS: u32 = 100;
const MAX_STALE_STARTUP_REPAIR_MS: u32 = 2_000;
const STARTUP_OVERLAP_DROP_FRAME_COUNT: u32 = 3;

fn parse_u32_log_field(line: &str, field: &str) -> Option<u32> {
    let value = line
        .split_once(field)?
        .1
        .split(|c: char| !c.is_ascii_digit())
        .next()?;
    value.parse().ok()
}

fn legacy_audio_gap_summary_from_log(
    log: &str,
    segment_index: usize,
    track: LegacyAudioLogTrack,
) -> Option<cap_project::AudioGapSummary> {
    let segment_marker = format!("segment{{index={segment_index}}}");
    let track_marker = format!(":{}:", track.span());
    let mut summary = cap_project::AudioGapSummary {
        total_overlap_trimmed_ms: 0,
        startup_overlap_trimmed_ms: 0,
        overlap_dropped_frames: 0,
        startup_overlap_drops: 0,
    };

    for line in log.lines() {
        if !line.contains(&segment_marker) || !line.contains(&track_marker) {
            continue;
        }

        let dropped = line.contains("Dropping overlapping audio frame");
        let trimmed = line.contains("Trimmed overlapping audio frame");
        if !(dropped || trimmed) {
            continue;
        }

        let Some(overlap_ms) = parse_u32_log_field(line, "overlap_ms=") else {
            continue;
        };
        let Some(frame_count) = parse_u32_log_field(line, "frame_count=") else {
            continue;
        };

        summary.total_overlap_trimmed_ms =
            summary.total_overlap_trimmed_ms.saturating_add(overlap_ms);

        if frame_count < STARTUP_OVERLAP_DROP_FRAME_COUNT {
            summary.startup_overlap_trimmed_ms = summary
                .startup_overlap_trimmed_ms
                .saturating_add(overlap_ms);
        }

        if dropped {
            summary.overlap_dropped_frames = summary.overlap_dropped_frames.saturating_add(1);
            if frame_count < STARTUP_OVERLAP_DROP_FRAME_COUNT {
                summary.startup_overlap_drops = summary.startup_overlap_drops.saturating_add(1);
            }
        }
    }

    (summary.total_overlap_trimmed_ms > 0).then_some(summary)
}

fn audio_timing_repair_offset(summary: Option<&cap_project::AudioGapSummary>) -> f32 {
    let Some(summary) = summary else {
        return 0.0;
    };

    if summary.startup_overlap_drops < MIN_STALE_STARTUP_DROPS
        || summary.overlap_dropped_frames < MIN_STALE_STARTUP_DROPS
        || !(MIN_STALE_STARTUP_TRIMMED_MS..=MAX_STALE_STARTUP_REPAIR_MS)
            .contains(&summary.startup_overlap_trimmed_ms)
    {
        return 0.0;
    }

    -(summary.startup_overlap_trimmed_ms as f32 / 1_000.0)
}

pub fn segment_audio_timing_repairs(
    meta: &StudioRecordingMeta,
    legacy_log: Option<&str>,
) -> Vec<SegmentAudioTimingRepair> {
    let count = match meta {
        StudioRecordingMeta::SingleSegment { .. } => 1,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
    };
    (0..count)
        .map(|index| segment_audio_timing_repair(meta, index, legacy_log))
        .collect()
}

fn segment_audio_timing_repair(
    meta: &StudioRecordingMeta,
    index: usize,
    legacy_log: Option<&str>,
) -> SegmentAudioTimingRepair {
    let legacy = LegacyAudioTimingRepair { log: legacy_log };
    match meta {
        StudioRecordingMeta::SingleSegment { segment } => SegmentAudioTimingRepair {
            mic_offset_secs: legacy.offset(
                0,
                LegacyAudioLogTrack::Mic,
                segment
                    .audio
                    .as_ref()
                    .and_then(|audio| audio.gap_summary.as_ref()),
            ),
            system_audio_offset_secs: 0.0,
        },
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = &inner.segments[index];
            SegmentAudioTimingRepair {
                mic_offset_secs: legacy.offset(
                    index,
                    LegacyAudioLogTrack::Mic,
                    segment
                        .mic
                        .as_ref()
                        .and_then(|audio| audio.gap_summary.as_ref()),
                ),
                system_audio_offset_secs: legacy.offset(
                    index,
                    LegacyAudioLogTrack::SystemAudio,
                    segment
                        .system_audio
                        .as_ref()
                        .and_then(|audio| audio.gap_summary.as_ref()),
                ),
            }
        }
    }
}

fn audio_loader_with_completed(
    path: PathBuf,
    label: String,
    completed: Option<&Arc<cap_audio::DecodedAudio>>,
) -> AudioLoader {
    match completed {
        Some(audio) => AudioLoader::from_result(Ok(Some(audio.clone()))),
        None => AudioLoader::spawn(path, label),
    }
}

pub async fn create_segments(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    force_ffmpeg: bool,
) -> Result<Vec<SegmentMedia>, String> {
    create_segments_with_audio(recording_meta, meta, force_ffmpeg, true, None).await
}

pub async fn create_segments_without_audio(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    force_ffmpeg: bool,
) -> Result<Vec<SegmentMedia>, String> {
    create_segments_with_audio(recording_meta, meta, force_ffmpeg, false, None).await
}

async fn create_segments_with_audio(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    force_ffmpeg: bool,
    load_audio: bool,
    completed_audio: Option<&[CompletedAudioSegment]>,
) -> Result<Vec<SegmentMedia>, String> {
    let legacy_log =
        std::fs::read_to_string(recording_meta.project_path.join("recording-logs.log")).ok();
    let legacy_log = legacy_log.as_deref();

    match &meta {
        cap_project::StudioRecordingMeta::SingleSegment { segment: s } => {
            let audio = s
                .audio
                .as_ref()
                .filter(|_| load_audio)
                .map(|audio_meta| {
                    audio_loader_with_completed(
                        recording_meta.path(&audio_meta.path),
                        "SingleSegment Audio".to_string(),
                        completed_audio
                            .and_then(|segments| segments.first())
                            .and_then(|segment| segment.mic.as_ref()),
                    )
                })
                .unwrap_or_else(AudioLoader::none);

            let cursor = Arc::new(
                s.cursor
                    .as_ref()
                    .map(|cursor_path| {
                        let full_path = recording_meta.path(cursor_path);
                        match CursorEvents::load_from_file(&full_path) {
                            Ok(events) => events,
                            Err(e) => {
                                warn!(
                                    "Failed to load cursor events from {}: {}",
                                    full_path.display(),
                                    e
                                );
                                CursorEvents::default()
                            }
                        }
                    })
                    .unwrap_or_default(),
            );

            let decoders = RecordingSegmentDecoders::new(
                recording_meta,
                meta,
                SegmentVideoPaths {
                    display: recording_meta.path(&s.display.path),
                    camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                },
                0,
                force_ffmpeg,
            )
            .await
            .map_err(|e| format!("SingleSegment / {e}"))?;

            Ok(vec![SegmentMedia {
                audio,
                system_audio: AudioLoader::none(),
                audio_timing_repair: segment_audio_timing_repair(meta, 0, legacy_log),
                cursor,
                keyboard: Arc::new(Default::default()),
                decoders,
            }])
        }
        cap_project::StudioRecordingMeta::MultipleSegments { inner, .. } => {
            // Segments initialize concurrently: decoder setup dominates and is
            // independent per segment, while audio decodes lazily in the
            // background via AudioLoader.
            let segment_futures = inner.segments.iter().enumerate().map(|(i, s)| async move {
                let audio = s
                    .mic
                    .as_ref()
                    .filter(|_| load_audio)
                    .map(|audio| {
                        audio_loader_with_completed(
                            recording_meta.path(&audio.path),
                            format!("MultipleSegments {i} Audio"),
                            completed_audio
                                .and_then(|segments| segments.get(i))
                                .and_then(|segment| segment.mic.as_ref()),
                        )
                    })
                    .unwrap_or_else(AudioLoader::none);

                let system_audio = s
                    .system_audio
                    .as_ref()
                    .filter(|_| load_audio)
                    .map(|audio| {
                        audio_loader_with_completed(
                            recording_meta.path(&audio.path),
                            format!("MultipleSegments {i} System Audio"),
                            completed_audio
                                .and_then(|segments| segments.get(i))
                                .and_then(|segment| segment.system_audio.as_ref()),
                        )
                    })
                    .unwrap_or_else(AudioLoader::none);

                let cursor = Arc::new(s.cursor_events(recording_meta));

                let decoders = RecordingSegmentDecoders::new(
                    recording_meta,
                    meta,
                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    },
                    i,
                    force_ffmpeg,
                )
                .await
                .map_err(|e| format!("MultipleSegments {i} / {e}"))?;

                let keyboard = Arc::new(s.keyboard_events(recording_meta));

                Ok::<SegmentMedia, String>(SegmentMedia {
                    audio,
                    system_audio,
                    audio_timing_repair: segment_audio_timing_repair(meta, i, legacy_log),
                    cursor,
                    keyboard,
                    decoders,
                })
            });

            futures::future::try_join_all(segment_futures).await
        }
    }
}

pub fn initial_clip_configuration(
    project_path: &std::path::Path,
    meta: &StudioRecordingMeta,
) -> Vec<cap_project::ClipConfiguration> {
    let calibration_store = load_calibration_store(project_path);
    match meta {
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .enumerate()
            .map(|(i, segment)| {
                let calibration_offset = get_calibration_offset(
                    segment.camera_device_id(),
                    segment.mic_device_id(),
                    &calibration_store,
                );
                cap_project::ClipConfiguration {
                    index: i as u32,
                    offsets: segment.calculate_audio_offsets_with_calibration(calibration_offset),
                    offsets_auto_calculated: true,
                }
            })
            .collect(),
        StudioRecordingMeta::SingleSegment { .. } => vec![cap_project::ClipConfiguration {
            index: 0,
            offsets: cap_project::ClipOffsets::default(),
            offsets_auto_calculated: false,
        }],
    }
}

fn load_calibration_store(project_path: &std::path::Path) -> cap_audio::CalibrationStore {
    let calibration_dir = project_path
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| project_path.to_path_buf());

    cap_audio::CalibrationStore::load(&calibration_dir)
}

fn get_calibration_offset(
    camera_id: Option<&str>,
    mic_id: Option<&str>,
    store: &cap_audio::CalibrationStore,
) -> Option<f32> {
    match (camera_id, mic_id) {
        (Some(cam), Some(mic)) => store.get_offset(cam, mic).map(|o| o as f32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{AudioGapSummary, CursorClickEvent, CursorConfiguration, CursorMoveEvent};

    #[tokio::test]
    async fn completed_pcm_loader_reuses_arc_without_opening_a_missing_file() {
        let audio = crate::completed_audio::tests::audio();
        let loader = audio_loader_with_completed(
            "not-created/audio.m4a".into(),
            "cached".into(),
            Some(&audio),
        );
        let loaded = loader.get().await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&loaded, &audio));
        let missing =
            audio_loader_with_completed("not-created/audio.m4a".into(), "ordinary".into(), None);
        assert!(missing.get().await.is_err());
    }

    #[test]
    fn shared_timing_repairs_preserve_track_index_and_legacy_precedence() {
        let mut meta = crate::completed_audio::tests::metadata();
        let structured = AudioGapSummary {
            total_overlap_trimmed_ms: 867,
            startup_overlap_trimmed_ms: 867,
            overlap_dropped_frames: 3,
            startup_overlap_drops: 3,
        };
        crate::completed_audio::tests::segments_mut(&mut meta)[0]
            .mic
            .as_mut()
            .unwrap()
            .gap_summary = Some(structured);
        let log = (0..3).map(|_| "segment{index=0}:mic-out: Dropping overlapping audio frame frame_count=1 overlap_ms=100\nsegment{index=1}:system-audio-out: Dropping overlapping audio frame frame_count=1 overlap_ms=50\n").collect::<String>();
        let repairs = segment_audio_timing_repairs(meta.studio_meta().unwrap(), Some(&log));
        assert_eq!(
            repairs,
            vec![
                SegmentAudioTimingRepair {
                    mic_offset_secs: -0.867,
                    system_audio_offset_secs: 0.0
                },
                SegmentAudioTimingRepair {
                    mic_offset_secs: 0.0,
                    system_audio_offset_secs: -0.15
                }
            ]
        );
        let without_log = segment_audio_timing_repairs(meta.studio_meta().unwrap(), None);
        assert_eq!(without_log[0].mic_offset_secs, -0.867);
        assert_eq!(without_log[1], SegmentAudioTimingRepair::default());
    }

    fn preview_cursor_events() -> Arc<CursorEvents> {
        Arc::new(CursorEvents {
            moves: [
                (0.0, 0.1, 0.2, "arrow"),
                (100.0, 0.3, 0.4, "arrow"),
                (100.0, 0.4, 0.3, "hand"),
                (300.0, 0.8, 0.6, "hand"),
                (1500.0, 0.6, 0.2, "arrow"),
                (1600.0, 0.2, 0.8, "arrow"),
            ]
            .into_iter()
            .map(|(time_ms, x, y, cursor_id)| CursorMoveEvent {
                active_modifiers: Vec::new(),
                cursor_id: cursor_id.to_string(),
                time_ms,
                x,
                y,
            })
            .collect(),
            clicks: [
                (80.0, true),
                (240.0, false),
                (1400.0, true),
                (1550.0, false),
            ]
            .into_iter()
            .map(|(time_ms, down)| CursorClickEvent {
                active_modifiers: Vec::new(),
                cursor_id: "arrow".to_string(),
                cursor_num: 0,
                time_ms,
                down,
            })
            .collect(),
        })
    }

    #[test]
    fn preview_cursor_cache_reuses_effective_settings() {
        let cursor = preview_cursor_events();
        let mut project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        let first = cache.get(0, &cursor, &project).unwrap();

        project.cursor.hide = !project.cursor.hide;
        project.cursor.size += 1;
        project.cursor.rotation_amount += 0.1;
        project.cursor.stop_movement_in_last_seconds = Some(0.5);
        project.cursor.click_spring = Some(project.cursor.click_spring_config());
        let repeated = cache.get(0, &Arc::clone(&cursor), &project).unwrap();

        assert!(Arc::ptr_eq(&first, &repeated));
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn preview_cursor_cache_invalidates_each_spring_parameter() {
        let cursor = preview_cursor_events();
        let project = ProjectConfiguration::default();
        let changes: [fn(&mut CursorConfiguration); 6] = [
            |cursor| cursor.tension += 1.0,
            |cursor| cursor.mass += 1.0,
            |cursor| cursor.friction += 1.0,
            |cursor| {
                cursor
                    .click_spring
                    .get_or_insert_with(Default::default)
                    .tension += 1.0;
            },
            |cursor| {
                cursor
                    .click_spring
                    .get_or_insert_with(Default::default)
                    .mass += 1.0;
            },
            |cursor| {
                cursor
                    .click_spring
                    .get_or_insert_with(Default::default)
                    .friction += 1.0;
            },
        ];

        for change in changes {
            let mut cache = PreviewCursorCache::default();
            let first = cache.get(0, &cursor, &project).unwrap();
            let mut changed = project.clone();
            change(&mut changed.cursor);
            let updated = cache.get(0, &cursor, &changed).unwrap();

            assert!(!Arc::ptr_eq(&first, &updated));
            assert!(Arc::ptr_eq(
                &updated,
                &cache.get(0, &cursor, &changed).unwrap()
            ));
            assert_eq!(cache.entries.len(), 1);
        }
    }

    #[test]
    fn preview_cursor_cache_bypasses_raw_mode_without_retaining_cursor_data() {
        let cursor = preview_cursor_events();
        let mut project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        let smoothed = cache.get(0, &cursor, &project).unwrap();
        let smoothed_weak = Arc::downgrade(&smoothed);
        drop(smoothed);
        drop(cache.get(1, &cursor, &project).unwrap());
        project.cursor.raw = true;

        assert!(cache.get(0, &cursor, &project).is_none());
        assert!(cache.entries.is_empty());
        assert!(smoothed_weak.upgrade().is_none());
        assert_eq!(Arc::strong_count(&cursor), 1);

        project.cursor.tension += 1.0;
        project.cursor.click_spring = Some(cap_project::ClickSpringConfig {
            tension: 900.0,
            mass: 2.0,
            friction: 60.0,
        });
        assert!(cache.get(0, &cursor, &project).is_none());
        assert!(cache.entries.is_empty());
        assert_eq!(Arc::strong_count(&cursor), 1);

        project.cursor.raw = false;
        assert!(cache.get(0, &cursor, &project).is_some());
        assert_eq!(cache.entries.len(), 1);
    }

    #[test]
    fn preview_cursor_cache_retains_raw_source_for_style_smoothing() {
        let cursor = preview_cursor_events();
        let mut project = ProjectConfiguration::default();
        project.cursor.raw = true;
        project.timeline = Some(
            serde_json::from_value(serde_json::json!({
                "segments": [], "zoomSegments": [],
                "styleSegments": [{
                    "start": 1.0, "end": 2.0,
                    "overrides": { "cursor": { "raw": false } }
                }]
            }))
            .unwrap(),
        );
        let mut cache = PreviewCursorCache::default();
        let first = cache.get(0, &cursor, &project).unwrap();
        let second = cache.get(0, &cursor, &project).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let raw = PrecomputedCursorTimeline::new(&cursor, None, None);
        for time in [0.0, 0.5, 1.0, 1.5, 2.5] {
            let actual = first.interpolate(time).unwrap();
            let expected = raw.interpolate(time).unwrap();
            assert_eq!(
                actual.position.coord.x.to_bits(),
                expected.position.coord.x.to_bits()
            );
            assert_eq!(
                actual.position.coord.y.to_bits(),
                expected.position.coord.y.to_bits()
            );
            assert_eq!(actual.velocity.x.to_bits(), expected.velocity.x.to_bits());
            assert_eq!(actual.velocity.y.to_bits(), expected.velocity.y.to_bits());
            assert_eq!(actual.cursor_id, expected.cursor_id);
        }
        project.cursor.raw = false;
        let smoothed = cache.get(0, &cursor, &project).unwrap();
        assert!(!Arc::ptr_eq(&first, &smoothed));
        project.cursor.raw = true;
        project.timeline.as_mut().unwrap().style_segments[0].enabled = false;
        assert!(cache.get(0, &cursor, &project).is_none());
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn raw_preview_cache_ignores_invalid_disabled_and_raw_styles() {
        let cursor = preview_cursor_events();
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "cursor": { "raw": true },
            "timeline": { "segments": [], "zoomSegments": [], "styleSegments": [{
                "start": 1.0, "end": 2.0, "overrides": { "cursor": { "raw": false } }
            }] }
        }))
        .unwrap();
        for (start, end, enabled, raw) in [
            (1.0, 2.0, false, false),
            (1.0, 1.0, true, false),
            (2.0, 1.0, true, false),
            (f64::NAN, 2.0, true, false),
            (1.0, f64::INFINITY, true, false),
            (1.0, 2.0, true, true),
        ] {
            let style = &mut project.timeline.as_mut().unwrap().style_segments[0];
            style.start = start;
            style.end = end;
            style.enabled = enabled;
            style.overrides.cursor.as_mut().unwrap().raw = raw;
            let mut cache = PreviewCursorCache::default();
            assert!(cache.get(0, &cursor, &project).is_none());
            assert!(cache.entries.is_empty());
        }
    }

    #[test]
    fn preview_cursor_cache_bypasses_empty_moves_without_retaining_cursor_data() {
        let cursor = preview_cursor_events();
        let empty = Arc::new(CursorEvents {
            moves: Vec::new(),
            clicks: cursor.clicks.clone(),
        });
        let project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        drop(cache.get(0, &cursor, &project).unwrap());
        let other_segment = cache.get(1, &cursor, &project).unwrap();

        assert!(cache.get(0, &empty, &project).is_none());
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(Arc::strong_count(&empty), 1);
        assert!(Arc::ptr_eq(
            &other_segment,
            &cache.get(1, &cursor, &project).unwrap()
        ));
    }

    #[test]
    fn preview_cursor_cache_distinguishes_cursor_identity_and_segments() {
        let cursor = preview_cursor_events();
        let project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        let first = cache.get(0, &cursor, &project).unwrap();
        let replacement = Arc::new((*cursor).clone());
        let replaced = cache.get(0, &replacement, &project).unwrap();
        assert!(!Arc::ptr_eq(&first, &replaced));
        assert_eq!(cache.entries.len(), 1);

        let second_segment = cache.get(1, &replacement, &project).unwrap();
        assert!(!Arc::ptr_eq(&replaced, &second_segment));
        assert!(Arc::ptr_eq(
            &replaced,
            &cache.get(0, &replacement, &project).unwrap()
        ));
        assert_eq!(cache.entries.len(), 2);
    }

    #[test]
    fn preview_cursor_cache_evicts_the_least_recent_segment() {
        let cursor = preview_cursor_events();
        let project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        let first = cache.get(0, &cursor, &project).unwrap();
        let second = cache.get(1, &cursor, &project).unwrap();
        let second_weak = Arc::downgrade(&second);
        drop(second);

        assert!(Arc::ptr_eq(
            &first,
            &cache.get(0, &cursor, &project).unwrap()
        ));
        drop(cache.get(2, &cursor, &project).unwrap());

        assert!(second_weak.upgrade().is_none());
        assert_eq!(cache.entries.len(), PREVIEW_CURSOR_CACHE_CAPACITY);
        assert!(Arc::ptr_eq(
            &first,
            &cache.get(0, &cursor, &project).unwrap()
        ));
    }

    #[test]
    fn preview_cursor_cache_matches_fresh_interpolation_across_seeks_and_modes() {
        let mut project = ProjectConfiguration::default();
        let mut cache = PreviewCursorCache::default();
        for cursor in [preview_cursor_events(), Arc::new(CursorEvents::default())] {
            for (raw, click_spring) in [
                (false, None),
                (
                    false,
                    Some(cap_project::ClickSpringConfig {
                        tension: 720.0,
                        mass: 2.0,
                        friction: 55.0,
                    }),
                ),
                (true, None),
            ] {
                project.cursor.raw = raw;
                project.cursor.click_spring = click_spring;
                let cached = cache.get(0, &cursor, &project);
                if raw || cursor.moves.is_empty() {
                    assert!(cached.is_none());
                    continue;
                }
                let cached = cached.unwrap();
                let fresh = PrecomputedCursorTimeline::new(
                    &cursor,
                    (!raw).then_some(SpringMassDamperSimulationConfig {
                        tension: project.cursor.tension,
                        mass: project.cursor.mass,
                        friction: project.cursor.friction,
                    }),
                    Some(project.cursor.click_spring_config()),
                );

                for time in [1.5, 0.0, 0.08, 0.1, 0.23, 0.24, 0.3, 1.0, 1.6, 2.5, -1.0] {
                    match (cached.interpolate(time), fresh.interpolate(time)) {
                        (Some(actual), Some(expected)) => {
                            assert_eq!(
                                actual.position.coord.x.to_bits(),
                                expected.position.coord.x.to_bits()
                            );
                            assert_eq!(
                                actual.position.coord.y.to_bits(),
                                expected.position.coord.y.to_bits()
                            );
                            assert_eq!(actual.velocity.x.to_bits(), expected.velocity.x.to_bits());
                            assert_eq!(actual.velocity.y.to_bits(), expected.velocity.y.to_bits());
                            assert_eq!(actual.cursor_id, expected.cursor_id);
                        }
                        (None, None) => {}
                        _ => panic!("cached cursor presence differed at {time}"),
                    }
                }
            }
        }
    }

    #[test]
    fn audio_timing_repair_uses_startup_trimmed_overlap() {
        let summary = AudioGapSummary {
            total_overlap_trimmed_ms: 1_667,
            startup_overlap_trimmed_ms: 867,
            overlap_dropped_frames: 23,
            startup_overlap_drops: 23,
        };

        assert_eq!(audio_timing_repair_offset(Some(&summary)), -0.867);
    }

    #[test]
    fn legacy_audio_timing_repair_reads_startup_trimmed_overlap_from_log() {
        let log = r#"
2026-06-01T12:37:20.016795Z DEBUG recording:studio_recording:segment{index=0}:mic-out:{task="mux-audio"}: cap_recording::output_pipeline::core: Trimmed overlapping audio frame frame_count=1 overlap_ms=34 frame_samples=1680 trim_samples=1656 kept_samples=24
2026-06-01T12:37:20.051756Z DEBUG recording:studio_recording:segment{index=0}:mic-out:{task="mux-audio"}: cap_recording::output_pipeline::core: Dropping overlapping audio frame frame_count=2 overlap_ms=35 frame_samples=1680 trim_samples=1680
2026-06-01T12:37:20.086773Z DEBUG recording:studio_recording:segment{index=0}:mic-out:{task="mux-audio"}: cap_recording::output_pipeline::core: Dropping overlapping audio frame frame_count=2 overlap_ms=35 frame_samples=1680 trim_samples=1680
2026-06-01T12:37:20.121809Z DEBUG recording:studio_recording:segment{index=0}:mic-out:{task="mux-audio"}: cap_recording::output_pipeline::core: Dropping overlapping audio frame frame_count=2 overlap_ms=35 frame_samples=1680 trim_samples=1680
2026-06-01T12:37:30.121809Z DEBUG recording:studio_recording:segment{index=0}:mic-out:{task="mux-audio"}: cap_recording::output_pipeline::core: Dropping overlapping audio frame frame_count=50 overlap_ms=800 frame_samples=1680 trim_samples=1680
"#;

        let summary = legacy_audio_gap_summary_from_log(log, 0, LegacyAudioLogTrack::Mic).unwrap();

        assert_eq!(summary.total_overlap_trimmed_ms, 939);
        assert_eq!(summary.startup_overlap_trimmed_ms, 139);
        assert_eq!(summary.overlap_dropped_frames, 4);
        assert_eq!(summary.startup_overlap_drops, 3);
        assert_eq!(audio_timing_repair_offset(Some(&summary)), -0.139);
        assert_eq!(
            legacy_audio_gap_summary_from_log(log, 0, LegacyAudioLogTrack::SystemAudio),
            None
        );
    }

    #[test]
    fn audio_timing_repair_ignores_missing_summary() {
        assert_eq!(audio_timing_repair_offset(None), 0.0);
    }

    #[test]
    fn audio_timing_repair_ignores_overlap_without_startup_signature() {
        let summary = AudioGapSummary {
            total_overlap_trimmed_ms: 867,
            startup_overlap_trimmed_ms: 867,
            overlap_dropped_frames: 23,
            startup_overlap_drops: 0,
        };

        assert_eq!(audio_timing_repair_offset(Some(&summary)), 0.0);
    }

    #[test]
    fn audio_timing_repair_ignores_trim_outside_expected_range() {
        let too_small = AudioGapSummary {
            total_overlap_trimmed_ms: MIN_STALE_STARTUP_TRIMMED_MS - 1,
            startup_overlap_trimmed_ms: MIN_STALE_STARTUP_TRIMMED_MS - 1,
            overlap_dropped_frames: 5,
            startup_overlap_drops: 5,
        };
        assert_eq!(audio_timing_repair_offset(Some(&too_small)), 0.0);

        let too_large = AudioGapSummary {
            total_overlap_trimmed_ms: MAX_STALE_STARTUP_REPAIR_MS + 1,
            startup_overlap_trimmed_ms: MAX_STALE_STARTUP_REPAIR_MS + 1,
            overlap_dropped_frames: 5,
            startup_overlap_drops: 5,
        };
        assert_eq!(audio_timing_repair_offset(Some(&too_large)), 0.0);
    }
}

#[cfg(test)]
mod initial_clip_configuration_tests {
    use super::*;

    fn metadata(with_ids: bool) -> StudioRecordingMeta {
        serde_json::from_value(serde_json::json!({
            "segments": [{
                "display": {"path": "display.mp4", "fps": 30, "start_time": 1.23456789},
                "camera": {"path": "camera.mp4", "fps": 24, "start_time": 0.987654321, "device_id": with_ids.then_some("camera")},
                "mic": {"path": "mic.m4a", "start_time": 0.876543219, "device_id": with_ids.then_some("mic")},
                "system_audio": {"path": "system.m4a", "start_time": 1.111111111}
            }],
            "cursors": {}
        })).unwrap()
    }

    fn assert_bits(clips: &[cap_project::ClipConfiguration], calibration: f32) {
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].index, 0);
        assert!(clips[0].offsets_auto_calculated);
        assert_eq!(
            clips[0].offsets.camera.to_bits(),
            ((1.23456789_f64 - 0.987654321) as f32).to_bits()
        );
        assert_eq!(
            clips[0].offsets.mic.to_bits(),
            (((1.23456789_f64 - 0.876543219) as f32) + calibration).to_bits()
        );
        assert_eq!(
            clips[0].offsets.system_audio.to_bits(),
            (((1.23456789_f64 - 1.111111111) as f32) + calibration).to_bits()
        );
    }

    #[test]
    fn calibration_projection_preserves_store_location_confidence_and_cast_order_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("recordings/test.cap");
        std::fs::create_dir_all(&project).unwrap();
        let config = project.join("project-config.json");
        std::fs::write(&config, b"untouched config sentinel").unwrap();
        let mut store = cap_audio::CalibrationStore::new();
        for confidence in [0.49, 0.5, 1.0] {
            let offset = -0.03123456789_f64;
            store.update_calibration(&cap_audio::DeviceSyncCalibration {
                camera_id: "camera".into(),
                microphone_id: "mic".into(),
                measured_offset_secs: offset,
                confidence,
                measurement_count: 3,
            });
            store.save(directory.path()).unwrap();
            let saved = std::fs::read(directory.path().join("sync_calibrations.json")).unwrap();
            let clips = initial_clip_configuration(&project, &metadata(true));
            assert_bits(
                &clips,
                if confidence >= 0.5 {
                    offset as f32
                } else {
                    0.0
                },
            );
            assert_eq!(
                std::fs::read(&config).unwrap(),
                b"untouched config sentinel"
            );
            assert_eq!(
                std::fs::read(directory.path().join("sync_calibrations.json")).unwrap(),
                saved
            );
        }
    }

    #[test]
    fn missing_store_invalid_store_and_missing_device_ids_keep_uncalibrated_offsets() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("recordings/test.cap");
        assert_bits(&initial_clip_configuration(&project, &metadata(true)), 0.0);
        assert!(!directory.path().join("sync_calibrations.json").exists());
        std::fs::write(
            directory.path().join("sync_calibrations.json"),
            b"malformed",
        )
        .unwrap();
        assert_bits(&initial_clip_configuration(&project, &metadata(true)), 0.0);
        let mut store = cap_audio::CalibrationStore::new();
        store.update_calibration(&cap_audio::DeviceSyncCalibration {
            camera_id: "camera".into(),
            microphone_id: "mic".into(),
            measured_offset_secs: 0.7,
            confidence: 1.0,
            measurement_count: 2,
        });
        store.save(directory.path()).unwrap();
        assert_bits(&initial_clip_configuration(&project, &metadata(false)), 0.0);
        assert!(!project.exists());
    }

    #[test]
    fn legacy_single_segment_and_missing_timing_preserve_their_default_offsets() {
        let directory = tempfile::tempdir().unwrap();
        let single: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "display": {"path": "display.mp4", "fps": 30}
        }))
        .unwrap();
        let clips = initial_clip_configuration(directory.path(), &single);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].index, 0);
        assert!(!clips[0].offsets_auto_calculated);
        assert_eq!(
            [
                clips[0].offsets.camera,
                clips[0].offsets.mic,
                clips[0].offsets.system_audio
            ],
            [0.0; 3]
        );
        let mut multiple = metadata(true);
        let StudioRecordingMeta::MultipleSegments { inner } = &mut multiple else {
            panic!("Expected indexed metadata")
        };
        inner.segments[0].camera.as_mut().unwrap().start_time = None;
        let clips = initial_clip_configuration(directory.path(), &multiple);
        assert!(clips[0].offsets_auto_calculated);
        assert_eq!(
            [
                clips[0].offsets.camera,
                clips[0].offsets.mic,
                clips[0].offsets.system_audio
            ],
            [0.0; 3]
        );
    }
}
