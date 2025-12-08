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
    RenderedFrame, SegmentVideoPaths, Video, get_duration,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, watch};
use tracing::{trace, warn};

pub struct EditorInstance {
    pub project_path: PathBuf,
    // pub ws_port: u16,
    pub recordings: Arc<ProjectRecordingsMeta>,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub state: Arc<Mutex<EditorState>>,
    on_state_change: Box<dyn Fn(&EditorState) + Send + Sync + 'static>,
    pub preview_tx: watch::Sender<Option<PreviewFrameInstruction>>,
    pub project_config: (
        watch::Sender<ProjectConfiguration>,
        watch::Receiver<ProjectConfiguration>,
    ),
    // ws_shutdown_token: CancellationToken,
    pub segment_medias: Arc<Vec<SegmentMedia>>,
    meta: RecordingMeta,
}

impl EditorInstance {
    pub async fn new(
        project_path: PathBuf,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
        frame_cb: Box<dyn FnMut(RenderedFrame) + Send>,
    ) -> Result<Arc<Self>, String> {
        trace!("EditorInstance::new starting for {:?}", project_path);

        if !project_path.exists() {
            return Err(format!("Video path {} not found!", project_path.display()));
        }

        trace!("Loading recording meta");
        let recording_meta = cap_project::RecordingMeta::load_for_project(&project_path)
            .map_err(|e| format!("Failed to load recording meta: {e}"))?;

        let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
            return Err("Cannot edit non-studio recordings".to_string());
        };

        let segment_count = match meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };

        trace!("Recording has {} segments", segment_count);

        if segment_count == 0 {
            return Err(
                "Recording has no segments. It may need to be recovered first.".to_string(),
            );
        }

        let mut project = recording_meta.project_config();

        if project.timeline.is_none() {
            warn!("Project config has no timeline, creating one from recording segments");
            let timeline_segments = match meta {
                StudioRecordingMeta::SingleSegment { segment } => {
                    let display_path = recording_meta.path(&segment.display.path);
                    let duration = Video::new(&display_path, 0.0)
                        .map(|v| v.duration)
                        .unwrap_or(5.0);
                    vec![TimelineSegment {
                        recording_clip: 0,
                        start: 0.0,
                        end: duration,
                        timescale: 1.0,
                    }]
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .enumerate()
                    .filter_map(|(i, segment)| {
                        let display_path = recording_meta.path(&segment.display.path);
                        let duration = Video::new(&display_path, 0.0)
                            .map(|v| v.duration)
                            .unwrap_or(5.0);
                        if duration <= 0.0 {
                            return None;
                        }
                        Some(TimelineSegment {
                            recording_clip: i as u32,
                            start: 0.0,
                            end: duration,
                            timescale: 1.0,
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
                });

                if let Err(e) = project.write(&recording_meta.project_path) {
                    warn!("Failed to save auto-generated timeline: {}", e);
                } else {
                    trace!("Auto-generated timeline saved to project config");
                }
            }
        }

        trace!("Creating ProjectRecordingsMeta");
        let recordings = Arc::new(ProjectRecordingsMeta::new(
            &recording_meta.project_path,
            meta,
        )?);

        trace!("Creating segments with decoders");
        let segments = create_segments(&recording_meta, meta).await?;
        trace!("Segments created successfully");

        trace!("Creating render constants");
        let render_constants = Arc::new(
            RenderVideoConstants::new(&recordings.segments, recording_meta.clone(), meta.clone())
                .await
                .map_err(|e| format!("Failed to create render constants: {e}"))?,
        );

        trace!("Spawning renderer");
        let renderer = Arc::new(editor::Renderer::spawn(
            render_constants.clone(),
            frame_cb,
            &recording_meta,
            meta,
        )?);

        let (preview_tx, preview_rx) = watch::channel(None);

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
            meta: recording_meta,
        });

        this.state.lock().await.preview_task =
            Some(this.clone().spawn_preview_renderer(preview_rx));

        trace!("EditorInstance::new completed successfully");
        Ok(this)
    }

    pub fn meta(&self) -> &RecordingMeta {
        &self.meta
    }

    pub async fn dispose(&self) {
        trace!("Disposing EditorInstance");

        let mut state = self.state.lock().await;

        // Stop playback
        if let Some(handle) = state.playback_task.take() {
            trace!("Stopping playback");
            handle.stop();
        }

        // Stop preview
        if let Some(task) = state.preview_task.take() {
            trace!("Stopping preview");
            task.abort();
            task.await.ok(); // Await the task to ensure it's fully stopped
        }

        // Stop renderer
        trace!("Stopping renderer");
        self.renderer.stop().await;

        // // Clear audio data
        // if self.audio.lock().unwrap().is_some() {
        //     println!("Clearing audio data");
        //     *self.audio.lock().unwrap() = None; // Explicitly drop the audio data
        // }

        // Cancel any remaining tasks
        tokio::task::yield_now().await;

        drop(state);

        println!("EditorInstance disposed");
    }

    pub async fn modify_and_emit_state(&self, modify: impl Fn(&mut EditorState)) {
        let mut state = self.state.lock().await;
        modify(&mut state);
        (self.on_state_change)(&state);
    }

    pub async fn start_playback(self: &Arc<Self>, fps: u32, resolution_base: XY<u32>) {
        let (mut handle, prev) = {
            let Ok(mut state) = self.state.try_lock() else {
                return;
            };

            let start_frame_number = state.playhead_position;

            let playback_handle = match (playback::Playback {
                segment_medias: self.segment_medias.clone(),
                renderer: self.renderer.clone(),
                render_constants: self.render_constants.clone(),
                start_frame_number,
                project: self.project_config.0.subscribe(),
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
                        // ! This editor instance (self) gets dropped here
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
        trace!("Starting preview renderer task");
        tokio::spawn(async move {
            trace!("Preview renderer task running");
            loop {
                trace!("Preview renderer: waiting for frame request");
                preview_rx.changed().await.unwrap();
                trace!("Preview renderer: received change notification");

                loop {
                    let Some((frame_number, fps, resolution_base)) =
                        *preview_rx.borrow_and_update()
                    else {
                        break;
                    };

                    trace!("Preview renderer: processing frame {}", frame_number);

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

                    let get_frames_future = segment_medias.decoders.get_frames(
                        segment_time as f32,
                        !project.camera.hide,
                        clip_offsets,
                    );

                    tokio::select! {
                        biased;

                        _ = preview_rx.changed() => {
                            continue;
                        }

                        segment_frames_opt = get_frames_future => {
                            if preview_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            if let Some(segment_frames) = segment_frames_opt {
                                trace!("Preview renderer: rendering frame {}", frame_number);
                                let uniforms = ProjectUniforms::new(
                                    &self.render_constants,
                                    &project,
                                    frame_number,
                                    fps,
                                    resolution_base,
                                    &segment_medias.cursor,
                                    &segment_frames,
                                );
                                self.renderer
                                    .render_frame(segment_frames, uniforms, segment_medias.cursor.clone(), frame_number)
                                    .await;
                            } else {
                                warn!("Preview renderer: no frames returned for frame {}", frame_number);
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
            RecordingMetaInner::Studio(meta) => meta,
            _ => panic!("Not a studio recording"),
        }
    }

    pub fn get_total_frames(&self, fps: u32) -> u32 {
        // Calculate total frames based on actual video duration and fps
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
        // TODO: Ensure that *all* resources have been released by this point?
        // For now the `dispose` method is adequate.
        println!(
            "*** Editor instance has been released: {:?} ***",
            self.project_path
        );
    }
}

type PreviewFrameInstruction = (u32, u32, XY<u32>);

pub struct EditorState {
    pub playhead_position: u32,
    pub playback_task: Option<PlaybackHandle>,
    pub preview_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct SegmentMedia {
    pub audio: Option<Arc<AudioData>>,
    pub system_audio: Option<Arc<AudioData>>,
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}

pub async fn create_segments(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
) -> Result<Vec<SegmentMedia>, String> {
    match &meta {
        cap_project::StudioRecordingMeta::SingleSegment { segment: s } => {
            let audio = s
                .audio
                .as_ref()
                .map(|audio_meta| {
                    AudioData::from_file(recording_meta.path(&audio_meta.path))
                        .map_err(|e| format!("SingleSegment Audio / {e}"))
                })
                .transpose()?
                .map(Arc::new);

            let decoders = RecordingSegmentDecoders::new(
                recording_meta,
                meta,
                SegmentVideoPaths {
                    display: recording_meta.path(&s.display.path),
                    camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                },
                0,
            )
            .await
            .map_err(|e| format!("SingleSegment / {e}"))?;

            Ok(vec![SegmentMedia {
                audio,
                system_audio: None,
                cursor: Default::default(),
                decoders,
            }])
        }
        cap_project::StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let mut segments = vec![];

            for (i, s) in inner.segments.iter().enumerate() {
                let audio = s
                    .mic
                    .as_ref()
                    .map(|audio| {
                        AudioData::from_file(recording_meta.path(&audio.path))
                            .map_err(|e| format!("MultipleSegments {i} Audio / {e}"))
                    })
                    .transpose()?
                    .map(Arc::new);

                let system_audio = s
                    .system_audio
                    .as_ref()
                    .map(|audio| {
                        AudioData::from_file(recording_meta.path(&audio.path))
                            .map_err(|e| format!("MultipleSegments {i} System Audio / {e}"))
                    })
                    .transpose()?
                    .map(Arc::new);

                let cursor = Arc::new(s.cursor_events(recording_meta));

                let decoders = RecordingSegmentDecoders::new(
                    recording_meta,
                    meta,
                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    },
                    i,
                )
                .await
                .map_err(|e| format!("MultipleSegments {i} / {e}"))?;

                segments.push(SegmentMedia {
                    audio,
                    system_audio,
                    cursor,
                    decoders,
                });
            }

            Ok(segments)
        }
    }
}
