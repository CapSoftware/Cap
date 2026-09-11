use std::{collections::VecDeque, panic::AssertUnwindSafe, sync::Arc};

use cap_project::{
    BackgroundSource, CursorEvents, FrameStyle, ProjectConfiguration, RecordingMeta, XY,
};
use cap_rendering::decoder::ManagedVideoError;
use cap_rendering::{
    FrameLayout, FrameRenderer, FrozenRecordedCursorAssets, ManagedRecordingSegmentDecoders,
    ManagedSegmentDecoderStatus, ManagedSegmentStopHandles, ManagedSegmentVideoError,
    ManagedSegmentVideoExit, ManagedSegmentVideoInput, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};
use futures::{FutureExt, future::BoxFuture, future::Shared};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::{
    EditorFrameFormat, EditorFrameOutput,
    editor_instance::{
        PREVIEW_RENDER_MAX_ATTEMPTS, PREVIEW_RENDER_RETRY_DELAY_MS, PreviewCursorCache,
    },
};

const MAX_OPEN_SEGMENTS: usize = 2;

#[cfg(test)]
mod native_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreparingPreviewError {
    Cancelled,
    InvalidInput(String),
    Media(ManagedSegmentVideoError),
    Render(String),
    Panicked,
    TaskJoin(String),
}

impl std::fmt::Display for PreparingPreviewError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("Preparing preview cancelled"),
            Self::InvalidInput(error) => write!(formatter, "Invalid preparing preview: {error}"),
            Self::Media(error) => write!(formatter, "Preparing preview media: {error}"),
            Self::Render(error) => write!(formatter, "Preparing preview render: {error}"),
            Self::Panicked => formatter.write_str("Preparing preview task panicked"),
            Self::TaskJoin(error) => write!(formatter, "Preparing preview task join: {error}"),
        }
    }
}

impl std::error::Error for PreparingPreviewError {}

pub struct PreparingPreviewSegment {
    pub video: ManagedSegmentVideoInput,
    pub cursor: Arc<CursorEvents>,
}

pub struct PreparingPreviewInput {
    pub recording_meta: RecordingMeta,
    pub project: ProjectConfiguration,
    pub segments: Vec<PreparingPreviewSegment>,
    pub cursor_assets: FrozenRecordedCursorAssets,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PreparingPreviewOptions {
    pub use_hardware_decoding: bool,
    pub frame_format: EditorFrameFormat,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreparingFrameRequest {
    pub sequence: u64,
    pub frame_number: u32,
    pub fps: u32,
    pub resolution_base: XY<u32>,
}

#[derive(Clone, Debug)]
pub struct PreparingPreviewReady {
    pub screen_size: XY<u32>,
    pub camera_size: Option<XY<u32>>,
    pub duration: f64,
}

#[derive(Clone, Debug)]
pub struct PreparingPreviewExit {
    pub reason: PreparingPreviewError,
    pub workers: Vec<ManagedSegmentVideoExit>,
}

pub type PreparingPreviewCallback =
    Box<dyn FnMut(PreparingFrameRequest, EditorFrameOutput, FrameLayout) + Send>;

#[derive(Clone, Default)]
struct PreviewState {
    ready: Option<PreparingPreviewReady>,
    terminal: Option<PreparingPreviewError>,
}

struct PreviewControl {
    cancel: CancellationToken,
    state: watch::Sender<PreviewState>,
}

impl PreviewControl {
    fn check(&self) -> Result<(), PreparingPreviewError> {
        if let Some(error) = self.state.borrow().terminal.clone() {
            Err(error)
        } else if self.cancel.is_cancelled() {
            Err(PreparingPreviewError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn finish(&self, error: PreparingPreviewError) {
        self.state.send_modify(|state| {
            state.terminal.get_or_insert(error);
        });
    }
}

#[derive(Clone)]
pub struct PreparingPreviewStopHandle {
    control: Arc<PreviewControl>,
    completion: Shared<BoxFuture<'static, PreparingPreviewExit>>,
}

impl PreparingPreviewStopHandle {
    pub fn cancel(&self) {
        self.control.cancel.cancel();
    }

    pub fn terminal_error(&self) -> Option<PreparingPreviewError> {
        self.control.state.borrow().terminal.clone()
    }

    pub async fn stop_and_wait(&self) -> PreparingPreviewExit {
        self.cancel();
        self.completion.clone().await
    }
}

pub struct PreparingPreview {
    stop: PreparingPreviewStopHandle,
    requests: watch::Sender<Option<PreparingFrameRequest>>,
    next_sequence: u64,
    duration: f64,
}

impl PreparingPreview {
    pub fn spawn(
        input: PreparingPreviewInput,
        options: PreparingPreviewOptions,
        callback: PreparingPreviewCallback,
    ) -> Result<Self, PreparingPreviewError> {
        let duration = validate_input(&input)?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|error| PreparingPreviewError::InvalidInput(error.to_string()))?;
        let (state, _) = watch::channel(PreviewState::default());
        let control = Arc::new(PreviewControl {
            cancel: CancellationToken::new(),
            state,
        });
        let (requests, receiver) = watch::channel(None);
        let task_control = control.clone();
        let task = runtime.spawn(async move {
            let mut workers = Vec::new();
            let result = AssertUnwindSafe(run_preview(
                input,
                options,
                callback,
                receiver,
                &task_control,
                &mut workers,
            ))
            .catch_unwind()
            .await;
            let mut reason = match result {
                Ok(Err(error)) => error,
                Ok(Ok(())) => PreparingPreviewError::Cancelled,
                Err(_) => PreparingPreviewError::Panicked,
            };
            if reason != PreparingPreviewError::Cancelled {
                task_control.finish(reason.clone());
            }
            task_control.cancel.cancel();
            for (_, handles) in &workers {
                handles.cancel();
            }
            let mut exits = Vec::with_capacity(workers.len());
            for (_, handles) in workers {
                let exit = handles.stop_and_wait().await;
                if reason == PreparingPreviewError::Cancelled
                    && let Some(error) = worker_exit_error(&exit)
                {
                    reason = error;
                }
                exits.push(exit);
            }
            task_control.finish(reason.clone());
            PreparingPreviewExit {
                reason,
                workers: exits,
            }
        });
        let joined_control = control.clone();
        let completion = async move {
            match task.await {
                Ok(exit) => exit,
                Err(error) => {
                    let reason = PreparingPreviewError::TaskJoin(error.to_string());
                    joined_control.finish(reason.clone());
                    PreparingPreviewExit {
                        reason,
                        workers: Vec::new(),
                    }
                }
            }
        }
        .boxed()
        .shared();
        Ok(Self {
            stop: PreparingPreviewStopHandle {
                control,
                completion,
            },
            requests,
            next_sequence: 1,
            duration,
        })
    }

    pub fn stop_handle(&self) -> PreparingPreviewStopHandle {
        self.stop.clone()
    }

    pub async fn wait_ready(&mut self) -> Result<PreparingPreviewReady, PreparingPreviewError> {
        let mut guard = CancelReadiness(Some(self.stop.control.cancel.clone()));
        let mut state = self.stop.control.state.subscribe();
        loop {
            self.stop.control.check()?;
            if let Some(ready) = state.borrow_and_update().ready.clone() {
                guard.0 = None;
                return Ok(ready);
            }
            tokio::select! {
                biased;
                _ = self.stop.control.cancel.cancelled() => {
                    return Err(self.stop.control.check().err().unwrap_or(PreparingPreviewError::Cancelled));
                }
                changed = state.changed() => {
                    changed.map_err(|error| PreparingPreviewError::TaskJoin(error.to_string()))?;
                }
            }
        }
    }

    pub fn request_frame(
        &mut self,
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
    ) -> Result<u64, PreparingPreviewError> {
        self.stop.control.check()?;
        validate_request(frame_number, fps, resolution_base, self.duration)?;
        let next = self.next_sequence.checked_add(1).ok_or_else(|| {
            PreparingPreviewError::InvalidInput("Frame request sequence exhausted".into())
        })?;
        let request = PreparingFrameRequest {
            sequence: self.next_sequence,
            frame_number,
            fps,
            resolution_base,
        };
        self.requests
            .send(Some(request))
            .map_err(|_| PreparingPreviewError::Cancelled)?;
        self.next_sequence = next;
        Ok(request.sequence)
    }
}

impl Drop for PreparingPreview {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct CancelReadiness(Option<CancellationToken>);

impl Drop for CancelReadiness {
    fn drop(&mut self) {
        if let Some(cancel) = &self.0 {
            cancel.cancel();
        }
    }
}

fn validate_request(
    frame_number: u32,
    fps: u32,
    resolution: XY<u32>,
    duration: f64,
) -> Result<(), PreparingPreviewError> {
    if fps == 0
        || fps > 240
        || resolution.x < 2
        || resolution.y < 2
        || resolution.x > 8192
        || resolution.y > 8192
        || !duration.is_finite()
        || duration <= 0.0
        || f64::from(frame_number) / f64::from(fps) >= duration
    {
        Err(PreparingPreviewError::InvalidInput(
            "Frame, FPS, or output dimensions are outside preview limits".into(),
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_input(input: &PreparingPreviewInput) -> Result<f64, PreparingPreviewError> {
    let invalid = |message: &str| PreparingPreviewError::InvalidInput(message.into());
    let Some(meta) = input.recording_meta.studio_meta() else {
        return Err(invalid("Studio metadata is required"));
    };
    let cap_project::StudioRecordingMeta::MultipleSegments { inner } = meta else {
        return Err(invalid("Indexed stopped segments are required"));
    };
    let count = input.segments.len();
    if count == 0 || count > 1024 || count != inner.segments.len() {
        return Err(invalid("Stopped segment layout does not match"));
    }
    let project = &input.project;
    project
        .validate()
        .map_err(|error| invalid(&error.to_string()))?;
    let Some(timeline) = &project.timeline else {
        return Err(invalid("Resolved stopped timeline is required"));
    };
    if timeline.segments.len() != count
        || input.segments.iter().enumerate().any(|(index, segment)| {
            segment.video.segment_index() != index
                || !segment.video.matches_metadata(meta)
                || timeline.segments[index].recording_clip as usize != index
                || timeline.segments[index].start != 0.0
                || timeline.segments[index].timescale != 1.0
                || !timeline.segments[index].end.is_finite()
                || timeline.segments[index].end <= 0.0
                || timeline.segments[index].name.is_some()
                || timeline.segments[index].speed_audio_mode.is_some()
        })
    {
        return Err(invalid("Preparing requires the unchanged stopped timeline"));
    }
    if !matches!(
        project.background.source,
        BackgroundSource::Color { .. }
            | BackgroundSource::Gradient { .. }
            | BackgroundSource::AnimatedGradient { .. }
    ) || project
        .background
        .frame
        .as_ref()
        .is_some_and(|frame| frame.style != FrameStyle::None)
        || project.captions.is_some()
        || project.camera.background_blur.is_active()
        || project.keyboard.is_some()
        || !project.annotations.is_empty()
        || !project.hidden_text_segments.is_empty()
        || !project.overlay_order.is_empty()
        || !timeline.transitions.is_empty()
        || !timeline.scene_segments.is_empty()
        || !timeline.mask_segments.is_empty()
        || !timeline.text_segments.is_empty()
        || !timeline.caption_segments.is_empty()
        || !timeline.keyboard_segments.is_empty()
        || !timeline.audio_segments.is_empty()
        || !timeline.style_segments.is_empty()
        || !timeline.image_segments.is_empty()
        || !timeline.camera3d_segments.is_empty()
    {
        return Err(invalid("Presentation requires ordinary project loading"));
    }
    if project.clips.len() != count {
        return Err(invalid("Every clip requires resolved calibration offsets"));
    }
    let mut seen = vec![false; count];
    for clip in &project.clips {
        let Some(seen) = seen.get_mut(clip.index as usize) else {
            return Err(invalid("Clip index is outside the stopped timeline"));
        };
        if *seen
            || !clip.offsets.camera.is_finite()
            || !clip.offsets.mic.is_finite()
            || !clip.offsets.system_audio.is_finite()
        {
            return Err(invalid("Clip offsets must be unique and finite"));
        }
        *seen = true;
    }
    let duration = timeline.duration();
    if !duration.is_finite() || duration <= 0.0 {
        return Err(invalid("Stopped duration must be finite and positive"));
    }
    Ok(duration)
}

type WorkerRegistry = Vec<(usize, ManagedSegmentStopHandles)>;

struct OpenSegment {
    index: usize,
    decoder: ManagedRecordingSegmentDecoders,
    status: ManagedSegmentDecoderStatus,
}

struct PreviewDecoders {
    inputs: Vec<PreparingPreviewSegment>,
    opened: VecDeque<OpenSegment>,
    use_hardware: bool,
}

impl PreviewDecoders {
    fn check(&self) -> Result<(), PreparingPreviewError> {
        for entry in &self.opened {
            if let Some(error) = entry.decoder.terminal_error() {
                return Err(PreparingPreviewError::Media(error));
            }
        }
        Ok(())
    }

    async fn failed(&self) -> PreparingPreviewError {
        let (error, _, _) = futures::future::select_all(
            self.opened
                .iter()
                .map(|entry| entry.decoder.wait_for_terminal().boxed()),
        )
        .await;
        PreparingPreviewError::Media(error)
    }

    async fn ensure(
        &mut self,
        index: usize,
        control: &PreviewControl,
        registry: &mut WorkerRegistry,
    ) -> Result<&OpenSegment, PreparingPreviewError> {
        control.check()?;
        self.check()?;
        if let Some(position) = self.opened.iter().position(|entry| entry.index == index) {
            let segment = self
                .opened
                .remove(position)
                .expect("Located segment is present");
            self.opened.push_back(segment);
        } else {
            if self.opened.len() == MAX_OPEN_SEGMENTS {
                let evicted = self.opened.pop_front().expect("Cache is full");
                let exit = evicted.decoder.stop_and_wait().await;
                if let Some(error) = worker_exit_error(&exit) {
                    return Err(error);
                }
                registry.retain(|(entry, _)| *entry != evicted.index);
                drop(evicted);
                control.check()?;
            }
            let mut decoder = ManagedRecordingSegmentDecoders::spawn(
                self.inputs[index].video.clone(),
                self.use_hardware,
            );
            registry.push((index, decoder.stop_handles()));
            let status = tokio::select! {
                biased;
                _ = control.cancel.cancelled() => return Err(PreparingPreviewError::Cancelled),
                result = decoder.wait_ready() => result.map_err(PreparingPreviewError::Media)?,
            };
            self.opened.push_back(OpenSegment {
                index,
                decoder,
                status,
            });
        }
        control.check()?;
        Ok(self.opened.back().expect("Requested segment is cached"))
    }
}

fn is_current(
    receiver: &watch::Receiver<Option<PreparingFrameRequest>>,
    request: PreparingFrameRequest,
) -> bool {
    receiver
        .borrow()
        .as_ref()
        .is_some_and(|latest| latest.sequence == request.sequence)
}

async fn run_preview(
    input: PreparingPreviewInput,
    options: PreparingPreviewOptions,
    mut callback: PreparingPreviewCallback,
    mut requests: watch::Receiver<Option<PreparingFrameRequest>>,
    control: &PreviewControl,
    registry: &mut WorkerRegistry,
) -> Result<(), PreparingPreviewError> {
    control.check()?;
    let PreparingPreviewInput {
        recording_meta,
        project,
        segments,
        cursor_assets,
    } = input;
    let metadata = recording_meta
        .studio_meta()
        .expect("Validated Studio metadata")
        .clone();
    let duration = project
        .timeline
        .as_ref()
        .expect("Validated timeline")
        .duration();
    let mut decoders = PreviewDecoders {
        inputs: segments,
        opened: VecDeque::new(),
        use_hardware: options.use_hardware_decoding,
    };
    let first = decoders.ensure(0, control, registry).await?.status.clone();
    let screen_size = XY::new(first.display.video_width, first.display.video_height);
    let camera_size = first
        .camera
        .as_ref()
        .map(|camera| XY::new(camera.video_width, camera.video_height));
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size,
            preserve_screen_alpha: false,
        },
        recording_meta,
        metadata,
    )
    .await
    .map_err(|error| PreparingPreviewError::Render(error.to_string()))?
    .with_frozen_recorded_cursors(cursor_assets);
    control.check()?;
    let mut layers = RendererLayers::new_for_preparing_preview(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
        &project,
    )
    .map_err(|error| PreparingPreviewError::Render(error.to_string()))?;
    control.check()?;
    layers.preload_cursor_assets(
        &constants,
        project.cursor.use_svg,
        project.cursor.cursor_type(),
    );
    check_cursor_error(&constants)?;
    control.check()?;
    let mut renderer = FrameRenderer::new(&constants);
    let mut cursor_cache = PreviewCursorCache::default();
    let mut zoom_cache = VecDeque::new();
    control.state.send_modify(|state| {
        state.ready = Some(PreparingPreviewReady {
            screen_size,
            camera_size,
            duration,
        })
    });
    'requests: loop {
        control.check()?;
        decoders.check()?;
        let request = *requests.borrow_and_update();
        let Some(request) = request else {
            tokio::select! {
                biased;
                _ = control.cancel.cancelled() => return Err(PreparingPreviewError::Cancelled),
                error = decoders.failed() => return Err(error),
                changed = requests.changed() => {
                    changed.map_err(|_| PreparingPreviewError::Cancelled)?;
                    continue;
                }
            }
        };
        let frame_time = f64::from(request.frame_number) / f64::from(request.fps);
        let (segment_time, timeline_segment) =
            project.get_segment_time(frame_time).ok_or_else(|| {
                PreparingPreviewError::InvalidInput(
                    "Requested frame is outside the stopped timeline".into(),
                )
            })?;
        let index = timeline_segment.recording_clip as usize;
        let offsets = project
            .clips
            .iter()
            .find(|clip| clip.index == timeline_segment.recording_clip)
            .expect("Validated complete clip offsets")
            .offsets;
        let cursor = decoders.inputs[index].cursor.clone();
        for attempt in 0..PREVIEW_RENDER_MAX_ATTEMPTS {
            let segment = decoders.ensure(index, control, registry).await?;
            let frames = tokio::select! {
                biased;
                _ = control.cancel.cancelled() => return Err(PreparingPreviewError::Cancelled),
                result = async {
                    if attempt == 0 {
                        segment.decoder.get_frames_initial(segment_time as f32, project.requires_camera(), true, offsets).await
                    } else {
                        segment.decoder.get_frames(segment_time as f32, project.requires_camera(), true, offsets).await
                    }
                } => {
                    result.map_err(PreparingPreviewError::Media)?
                }
            };
            control.check()?;
            decoders.check()?;
            if !is_current(&requests, request) {
                continue 'requests;
            }
            let cursor_timeline =
                cursor_cache.get(timeline_segment.recording_clip, &cursor, &project);
            control.check()?;
            let zoom = cached_zoom(
                &mut zoom_cache,
                timeline_segment.recording_clip,
                &project,
                &cursor,
                duration,
                screen_size,
            );
            zoom.ensure_precomputed_until((request.frame_number as f32 + 1.0) / request.fps as f32);
            control.check()?;
            if !is_current(&requests, request) {
                continue 'requests;
            }
            let uniforms = if let Some(cursor_timeline) = &cursor_timeline {
                ProjectUniforms::new_with_precomputed_cursor(
                    &constants,
                    &project,
                    request.frame_number,
                    request.fps,
                    request.resolution_base,
                    &cursor,
                    &frames,
                    duration,
                    zoom,
                    cursor_timeline,
                )
            } else {
                ProjectUniforms::new(
                    &constants,
                    &project,
                    request.frame_number,
                    request.fps,
                    request.resolution_base,
                    &cursor,
                    &frames,
                    duration,
                    zoom,
                )
            };
            let layout = uniforms.frame_layout();
            let output = match options.frame_format {
                EditorFrameFormat::Rgba => renderer
                    .render_immediate(frames, uniforms, &cursor, true, &mut layers)
                    .await
                    .map(EditorFrameOutput::Rgba),
                #[cfg(target_os = "macos")]
                EditorFrameFormat::BgraSurface => renderer
                    .render_immediate_bgra_surface(frames, uniforms, &cursor, true, &mut layers)
                    .await
                    .map(EditorFrameOutput::Surface),
            };
            check_cursor_error(&constants)?;
            control.check()?;
            decoders.check()?;
            if !is_current(&requests, request) {
                continue 'requests;
            }
            let output = match output {
                Ok(output) => output,
                Err(error) if attempt + 1 < PREVIEW_RENDER_MAX_ATTEMPTS => {
                    tracing::warn!(%error, attempt, "Retrying preparing preview render");
                    tokio::select! {
                        biased;
                        _ = control.cancel.cancelled() => return Err(PreparingPreviewError::Cancelled),
                        error = decoders.failed() => return Err(error),
                        changed = requests.changed() => {
                            changed.map_err(|_| PreparingPreviewError::Cancelled)?;
                            continue 'requests;
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(PREVIEW_RENDER_RETRY_DELAY_MS)) => {}
                    }
                    continue;
                }
                Err(error) => return Err(PreparingPreviewError::Render(error.to_string())),
            };
            validate_output(&output, request, layout)?;
            callback(request, output, layout);
            control.check()?;
            if !is_current(&requests, request) {
                continue 'requests;
            }
            break;
        }
        tokio::select! {
            biased;
            _ = control.cancel.cancelled() => return Err(PreparingPreviewError::Cancelled),
            error = decoders.failed() => return Err(error),
            changed = requests.changed() => {
                changed.map_err(|_| PreparingPreviewError::Cancelled)?;
            }
        }
    }
}

fn worker_exit_error(exit: &ManagedSegmentVideoExit) -> Option<PreparingPreviewError> {
    if let Some(display) = &exit.display
        && display.terminal != ManagedVideoError::Cancelled
    {
        return Some(PreparingPreviewError::Media(
            ManagedSegmentVideoError::Display(display.terminal.clone()),
        ));
    }
    if let Some(camera) = &exit.camera
        && camera.terminal != ManagedVideoError::Cancelled
    {
        return Some(PreparingPreviewError::Media(
            ManagedSegmentVideoError::Camera(camera.terminal.clone()),
        ));
    }
    None
}

fn check_cursor_error(constants: &RenderVideoConstants) -> Result<(), PreparingPreviewError> {
    if let Some(error) = constants.frozen_cursor_error() {
        Err(PreparingPreviewError::Render(error.to_string()))
    } else {
        Ok(())
    }
}

fn cached_zoom<'a>(
    cache: &'a mut VecDeque<(u32, ZoomTransformTimeline)>,
    clip: u32,
    project: &ProjectConfiguration,
    cursor: &CursorEvents,
    duration: f64,
    screen_size: XY<u32>,
) -> &'a mut ZoomTransformTimeline {
    if let Some(position) = cache.iter().position(|(index, _)| *index == clip) {
        let entry = cache
            .remove(position)
            .expect("Located zoom entry is present");
        cache.push_back(entry);
    } else {
        if cache.len() == MAX_OPEN_SEGMENTS {
            cache.pop_front();
        }
        cache.push_back((
            clip,
            ZoomTransformTimeline::from_project_for_clip(
                project,
                cursor,
                duration,
                screen_size,
                clip,
            ),
        ));
    }
    &mut cache.back_mut().expect("Requested zoom entry is cached").1
}

fn validate_output(
    output: &EditorFrameOutput,
    request: PreparingFrameRequest,
    layout: FrameLayout,
) -> Result<(), PreparingPreviewError> {
    let (number, width, height) = match output {
        EditorFrameOutput::Rgba(frame) => (frame.frame_number, frame.width, frame.height),
        EditorFrameOutput::Nv12(frame) => (frame.frame_number, frame.width, frame.height),
        #[cfg(target_os = "macos")]
        EditorFrameOutput::Surface(frame) => (frame.frame_number, frame.width, frame.height),
    };
    if number != request.frame_number || [width, height] != layout.output_size {
        Err(PreparingPreviewError::Render(
            "Rendered frame does not match the requested frame and layout".into(),
        ))
    } else {
        Ok(())
    }
}
