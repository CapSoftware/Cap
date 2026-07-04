use crate::editor;
use crate::playback::{self, PlaybackHandle, PlaybackStartError};
use cap_audio::AudioData;
use cap_project::StudioRecordingMeta;
use cap_project::{
    CursorEvents, ProjectConfiguration, RecordingMeta, RecordingMetaInner, TimelineConfiguration,
    TimelineSegment, XY,
};
use cap_rendering::{
    ProjectRecordingsMeta, ProjectUniforms, RecordingSegmentDecoders, RenderVideoConstants,
    SegmentVideoPaths, SharedWgpuDevice, Video, ZoomFocusInterpolator, get_duration,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;
use tracing::warn;

const PREVIEW_RENDER_MAX_ATTEMPTS: u32 = 3;
const PREVIEW_RENDER_RETRY_DELAY_MS: u64 = 120;

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
    pub project_path: PathBuf,
    pub recordings: Arc<ProjectRecordingsMeta>,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    playback_active: watch::Sender<bool>,
    playback_active_rx: watch::Receiver<bool>,
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
        frame_cb: Box<dyn FnMut(editor::EditorFrameOutput) + Send>,
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

    /// Like [`EditorInstance::new`] but with a caller-provided audio output,
    /// letting harnesses substitute a headless sink while everything else
    /// (decoders, renderer, playback) runs the production path.
    pub async fn new_with_audio_output(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: Box<dyn FnMut(editor::EditorFrameOutput) + Send>,
        shared_device: Option<SharedWgpuDevice>,
        audio_output: Arc<crate::AudioOutput>,
    ) -> Result<Arc<Self>, String> {
        if !project_path.exists() {
            return Err(format!("Video path {} not found!", project_path.display()));
        }

        let recording_meta = cap_project::RecordingMeta::load_for_project(&project_path)
            .map_err(|e| format!("Failed to load recording meta: {e}"))?;

        let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
            return Err("Cannot edit non-studio recordings".to_string());
        };

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
                        })
                    })
                    .collect(),
            };

            if !timeline_segments.is_empty() {
                project.timeline = Some(TimelineConfiguration {
                    segments: timeline_segments,
                    zoom_segments: Vec::new(),
                    scene_segments: Vec::new(),
                    mask_segments: Vec::new(),
                    text_segments: Vec::new(),
                    caption_segments: Vec::new(),
                    keyboard_segments: Vec::new(),
                    audio_segments: Vec::new(),
                });

                if let Err(e) = project.write(&recording_meta.project_path) {
                    warn!("Failed to save auto-generated timeline: {}", e);
                }
            }
        }

        if project.clips.is_empty() {
            let calibration_store = load_calibration_store(&recording_meta.project_path);

            match meta.as_ref() {
                StudioRecordingMeta::MultipleSegments { inner } => {
                    project.clips = inner
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
                                offsets: segment
                                    .calculate_audio_offsets_with_calibration(calibration_offset),
                            }
                        })
                        .collect();
                }
                StudioRecordingMeta::SingleSegment { .. } => {
                    project.clips = vec![cap_project::ClipConfiguration {
                        index: 0,
                        offsets: cap_project::ClipOffsets::default(),
                    }];
                }
            }

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

        let segments_task = tokio::spawn({
            let recording_meta = recording_meta.clone();
            let studio_meta = (**meta).clone();
            async move { create_segments(&recording_meta, &studio_meta, force_ffmpeg_for_editor).await }
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

        let recordings = Arc::new(ProjectRecordingsMeta::new(
            &recording_meta.project_path,
            meta.as_ref(),
        )?);

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

        let renderer = Arc::new(editor::Renderer::spawn(
            render_constants.clone(),
            frame_cb,
            layers_rx,
        )?);

        let (preview_tx, preview_rx) = watch::channel(None);
        let (playback_active_tx, playback_active_rx) = watch::channel(false);

        let this = Arc::new(Self {
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
            music_cache: Arc::new(std::sync::Mutex::new(crate::MusicTracks::new())),
            meta: recording_meta,
            playback_active: playback_active_tx,
            playback_active_rx,
            export_preview_active: AtomicBool::new(false),
            export_active: AtomicBool::new(false),
            runtime_handle: tokio::runtime::Handle::current(),
            audio_output,
        });

        this.state.lock().await.preview_task =
            Some(this.clone().spawn_preview_renderer(preview_rx));

        Ok(this)
    }

    pub fn meta(&self) -> &RecordingMeta {
        &self.meta
    }

    pub async fn dispose(&self) {
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

        self.audio_output.shutdown();

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
        let music = self.load_music_tracks().await;

        let (mut handle, prev) = {
            let mut state = self.state.lock().await;

            let start_frame_number = state.playhead_position;

            let playback_handle = match (playback::Playback {
                segment_medias: self.segment_medias.clone(),
                music: music.clone(),
                renderer: self.renderer.clone(),
                render_constants: self.render_constants.clone(),
                start_frame_number,
                project: self.project_config.0.subscribe(),
                audio_output: self.audio_output.clone(),
                telemetry: None,
            })
            .start(fps, resolution_base)
            .await
            {
                Ok(handle) => handle,
                Err(PlaybackStartError::InvalidFps) => {
                    warn!(fps, "Skipping playback start due to invalid FPS");
                    return;
                }
            };

            if let Err(e) = self.playback_active.send(true) {
                tracing::warn!(%e, "failed to send playback_active=true");
            }

            let prev = state.playback_task.replace(playback_handle.clone());

            (playback_handle, prev)
        };

        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let event = *handle.receive_event().await;

                match event {
                    playback::PlaybackEvent::Start => {}
                    playback::PlaybackEvent::Frame(frame_number) => {
                        this.modify_and_emit_state(|state| {
                            state.playhead_position = frame_number;
                        })
                        .await;
                    }
                    playback::PlaybackEvent::Stop => {
                        if let Err(e) = this.playback_active.send(false) {
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
    }

    fn spawn_preview_renderer(
        self: Arc<Self>,
        mut preview_rx: watch::Receiver<Option<(u32, u32, XY<u32>)>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut prefetch_cancel_token: Option<CancellationToken> = None;

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

                    let Some((segment_time, segment)) =
                        project.get_segment_time(frame_number as f64 / fps as f64)
                    else {
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

                    let playback_is_active = *self.playback_active_rx.borrow();
                    let export_preview_is_active =
                        self.export_preview_active.load(Ordering::Acquire);
                    let export_is_active = self.export_active.load(Ordering::Acquire);
                    if !playback_is_active && !export_preview_is_active && !export_is_active {
                        let prefetch_frames_count = 15u32;
                        let hide_camera = project.camera.hide;
                        let playback_rx = self.playback_active_rx.clone();
                        for offset in 1..=prefetch_frames_count {
                            let prefetch_frame = frame_number + offset;
                            if let Some((prefetch_segment_time, prefetch_segment)) =
                                project.get_segment_time(prefetch_frame as f64 / fps as f64)
                                && let Some(prefetch_segment_media) = self
                                    .segment_medias
                                    .get(prefetch_segment.recording_clip as usize)
                            {
                                let prefetch_clip_offsets = project
                                    .clips
                                    .iter()
                                    .find(|v| v.index == prefetch_segment.recording_clip)
                                    .map(|v| v.offsets)
                                    .unwrap_or_default();
                                let decoders = prefetch_segment_media.decoders.clone();
                                let cancel_token = new_cancel_token.clone();
                                let playback_rx = playback_rx.clone();
                                tokio::spawn(async move {
                                    if cancel_token.is_cancelled() || *playback_rx.borrow() {
                                        return;
                                    }
                                    let _ = decoders
                                        .get_frames(
                                            prefetch_segment_time as f32,
                                            !hide_camera,
                                            true,
                                            prefetch_clip_offsets,
                                        )
                                        .await;
                                });
                            }
                        }
                    }

                    tokio::select! {
                        biased;

                        _ = preview_rx.changed() => {
                            continue;
                        }

                        segment_frames_opt = segment_medias.decoders.get_frames_initial(
                            segment_time as f32,
                            !project.camera.hide,
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

                            let cursor_smoothing = (!project.cursor.raw).then_some(
                                SpringMassDamperSimulationConfig {
                                    tension: project.cursor.tension,
                                    mass: project.cursor.mass,
                                    friction: project.cursor.friction,
                                },
                            );

                            let zoom_focus_interpolator = ZoomFocusInterpolator::new_arc(
                                segment_medias.cursor.clone(),
                                cursor_smoothing,
                                project.cursor.click_spring_config(),
                                project.screen_movement_spring,
                                total_duration,
                                project.timeline.as_ref().map(|t| t.zoom_segments.as_slice()).unwrap_or(&[]),
                            );

                            let mut next_segment_frames = segment_frames_opt;
                            let mut rendered = false;

                            for attempt in 0..PREVIEW_RENDER_MAX_ATTEMPTS {
                                let Some(segment_frames) = next_segment_frames.take() else {
                                    break;
                                };

                                let uniforms = ProjectUniforms::new(
                                    &self.render_constants,
                                    &project,
                                    frame_number,
                                    fps,
                                    resolution_base,
                                    &segment_medias.cursor,
                                    &segment_frames,
                                    total_duration,
                                    &zoom_focus_interpolator,
                                );

                                if self
                                    .renderer
                                    .render_frame_confirmed(
                                        segment_frames,
                                        uniforms,
                                        segment_medias.cursor.clone(),
                                    )
                                    .await
                                {
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
                                            !project.camera.hide,
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

/// Shared handle to an audio track that decodes in the background.
///
/// Editor startup doesn't block on decoding entire audio files into memory;
/// consumers that actually need samples (playback, export, waveforms) await
/// [`AudioLoader::get`], which resolves as soon as the background decode
/// completes.
#[derive(Clone)]
pub struct AudioLoader {
    rx: watch::Receiver<Option<Result<Option<Arc<AudioData>>, String>>>,
}

impl AudioLoader {
    /// A loader for a segment with no audio track.
    pub fn none() -> Self {
        Self::ready(None)
    }

    /// A loader wrapping already-decoded audio.
    pub fn ready(audio: Option<Arc<AudioData>>) -> Self {
        // The sender is dropped immediately; `get` still resolves because the
        // value is already present when it first borrows the channel.
        let (_tx, rx) = watch::channel(Some(Ok(audio)));
        Self { rx }
    }

    /// Starts decoding `path` on the blocking pool.
    pub fn spawn(path: PathBuf, label: String) -> Self {
        let (tx, rx) = watch::channel(None);
        tokio::task::spawn_blocking(move || {
            let result = AudioData::from_file(&path)
                .map(|data| Some(Arc::new(data)))
                .map_err(|e| format!("{label} / {e}"));
            let _ = tx.send(Some(result));
        });
        Self { rx }
    }

    /// Waits for the background decode to finish. Returns `Ok(None)` when the
    /// segment has no audio track.
    pub async fn get(&self) -> Result<Option<Arc<AudioData>>, String> {
        let mut rx = self.rx.clone();
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return Err("Audio load task was dropped".to_string());
            }
        }
    }
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

struct LegacyAudioTimingRepair {
    log: Option<String>,
}

impl LegacyAudioTimingRepair {
    fn load(project_path: &Path) -> Self {
        let log_path = project_path.join("recording-logs.log");
        Self {
            log: std::fs::read_to_string(log_path).ok(),
        }
    }

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
        legacy_audio_gap_summary_from_log(self.log.as_deref()?, segment_index, track)
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

pub async fn create_segments(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    force_ffmpeg: bool,
) -> Result<Vec<SegmentMedia>, String> {
    let legacy_timing_repair = LegacyAudioTimingRepair::load(&recording_meta.project_path);
    let legacy_timing_repair = &legacy_timing_repair;

    match &meta {
        cap_project::StudioRecordingMeta::SingleSegment { segment: s } => {
            let audio = s
                .audio
                .as_ref()
                .map(|audio_meta| {
                    AudioLoader::spawn(
                        recording_meta.path(&audio_meta.path),
                        "SingleSegment Audio".to_string(),
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
                audio_timing_repair: SegmentAudioTimingRepair {
                    mic_offset_secs: legacy_timing_repair.offset(
                        0,
                        LegacyAudioLogTrack::Mic,
                        s.audio.as_ref().and_then(|m| m.gap_summary.as_ref()),
                    ),
                    system_audio_offset_secs: 0.0,
                },
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
                    .map(|audio| {
                        AudioLoader::spawn(
                            recording_meta.path(&audio.path),
                            format!("MultipleSegments {i} Audio"),
                        )
                    })
                    .unwrap_or_else(AudioLoader::none);

                let system_audio = s
                    .system_audio
                    .as_ref()
                    .map(|audio| {
                        AudioLoader::spawn(
                            recording_meta.path(&audio.path),
                            format!("MultipleSegments {i} System Audio"),
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
                    audio_timing_repair: SegmentAudioTimingRepair {
                        mic_offset_secs: legacy_timing_repair.offset(
                            i,
                            LegacyAudioLogTrack::Mic,
                            s.mic.as_ref().and_then(|m| m.gap_summary.as_ref()),
                        ),
                        system_audio_offset_secs: legacy_timing_repair.offset(
                            i,
                            LegacyAudioLogTrack::SystemAudio,
                            s.system_audio.as_ref().and_then(|m| m.gap_summary.as_ref()),
                        ),
                    },
                    cursor,
                    keyboard,
                    decoders,
                })
            });

            futures::future::try_join_all(segment_futures).await
        }
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
    use cap_project::AudioGapSummary;

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
