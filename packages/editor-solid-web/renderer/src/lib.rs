#[path = "../../../../crates/editor/src/screen_recording_defaults.rs"]
mod screen_recording_defaults;

#[cfg(feature = "export-audio")]
mod export_audio;
mod present;
// Shared verbatim with the desktop mixer; the browser uses the enhancer only.
#[cfg(feature = "export-audio")]
#[allow(dead_code)]
#[path = "../../../../crates/audio/src/voice.rs"]
mod voice;
#[cfg(feature = "export-audio")]
mod voice_level;

#[cfg(feature = "export-audio")]
pub(crate) use voice::VoiceEnhancer;
#[cfg(feature = "export-audio")]
pub(crate) use voice_level::VoiceProfile;

/// `cap_audio::AudioSampleSource`, which the shared Studio Sound enhancer
/// (`crates/audio/src/voice.rs`) reads interleaved samples through.
#[cfg(feature = "export-audio")]
pub(crate) trait AudioSampleSource {
    fn channels(&self) -> u16;
    fn sample_count(&self) -> usize;
    fn sample(&self, index: usize) -> Option<&f32>;
    #[allow(dead_code)]
    fn sample_slice(&self, _range: std::ops::Range<usize>) -> Option<&[f32]> {
        None
    }
}

#[cfg(feature = "export-audio")]
pub use export_audio::BrowserExportAudio;

use cap_project::{
    AspectRatio, ClipConfiguration, ClipOffsets, ClipTransitionType, CursorEvents,
    ProjectConfiguration, RecordingMeta, StudioRecordingMeta, TimelineConfiguration,
    TimelineFrameMapping, TimelineSource, XY,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, PrecomputedCursorTimeline, ProjectUniforms,
    RenderOptions, RenderVideoConstants, RendererLayers, SharedWgpuDevice, TransitionRenderInput,
    ZoomTransformTimeline,
    decoder::BrowserFrameSource,
    segment_timing::{SegmentVideoTiming, segment_frame_times, segment_video_timing},
};
use present::SurfacePresenter;
use std::{
    future::Future,
    pin::pin,
    sync::Arc,
    task::{Context, Poll},
};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, HtmlVideoElement, ImageBitmap, WebGl2RenderingContext};

fn js_error(value: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&value.to_string())
}

fn trace_renderer(stage: &str) {
    let Some(window) = web_sys::window() else {
        return;
    };
    if js_sys::Reflect::get(
        window.as_ref(),
        &JsValue::from_str("CapBrowserRendererTrace"),
    )
    .ok()
    .and_then(|value| value.as_bool())
        != Some(true)
    {
        return;
    }
    web_sys::console::info_1(&JsValue::from_str(&format!("Cap renderer stage: {stage}")));
}

/// The render core is async for native decoders and readbacks, but a browser
/// frame only awaits uncontended locks, so it completes in a single poll.
fn complete_now<T>(future: impl Future<Output = T>) -> Result<T, JsValue> {
    let mut future = pin!(future);
    let waker = futures::task::noop_waker();
    match future.as_mut().poll(&mut Context::from_waker(&waker)) {
        Poll::Ready(value) => Ok(value),
        Poll::Pending => Err(js_error("Editor frame did not finish rendering")),
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn default_project_config_json() -> Result<String, JsValue> {
    serde_json::to_string(&screen_recording_defaults::default_screen_recording_project_config())
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn animated_gradient_catalog_json() -> Result<String, JsValue> {
    serde_json::to_string(&cap_project::animated_gradient_catalog()).map_err(js_error)
}

#[wasm_bindgen]
pub fn random_animated_gradient_json(seed: u32) -> Result<String, JsValue> {
    serde_json::to_string(&cap_project::AnimatedGradientConfig::from_seed(seed)).map_err(js_error)
}

/// Registers a font face for text, caption and keyboard overlays.
#[wasm_bindgen]
pub fn register_font(data: Vec<u8>) {
    cap_rendering::register_browser_font(data);
}

/// Registers an image the renderer reads by project path (backgrounds, image
/// overlays, cursor images).
#[wasm_bindgen]
pub fn register_asset(path: &str, data: Vec<u8>) {
    cap_rendering::browser_assets::insert(path, data);
}

/// Registers straight RGBA the page decoded off the main thread.
#[wasm_bindgen]
pub fn register_decoded_asset(
    path: &str,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
) -> Result<(), JsValue> {
    cap_rendering::browser_assets::insert_rgba(path, width, height, pixels).map_err(js_error)
}

#[wasm_bindgen]
pub fn has_asset(path: &str) -> bool {
    cap_rendering::browser_assets::get(std::path::Path::new(path)).is_some()
}

#[wasm_bindgen]
pub fn remove_asset(path: &str) {
    cap_rendering::browser_assets::remove(path);
}

/// Converts a browser recording's input-event NDJSON into native cursor
/// events and cursor metadata, exactly as the web export worker stages them,
/// and registers the stand-in cursor images the cursor layer may load.
#[wasm_bindgen]
pub fn web_input_recording(ndjson: &str) -> Result<String, JsValue> {
    use cap_project::web_input::{parse_web_input_events, web_cursor_asset, web_cursor_id};
    if ndjson.len() as u64 > cap_project::web_input::MAX_WEB_INPUT_BYTES {
        return Err(js_error("Input event source exceeds the supported size"));
    }
    let data = parse_web_input_events(ndjson.as_bytes()).map_err(js_error)?;
    let mut cursors = serde_json::Map::new();
    for &style in &data.styles {
        let (image, shape, hotspot) = web_cursor_asset(&data.platform, style).map_err(js_error)?;
        let image_path = format!("content/cursors/web-{style}.png");
        cap_rendering::browser_assets::insert(&image_path, image.to_vec());
        cursors.insert(
            web_cursor_id(style),
            serde_json::json!({ "imagePath": image_path, "hotspot": hotspot, "shape": shape }),
        );
    }
    serde_json::to_string(&serde_json::json!({
        "platform": data.platform,
        "cursor": data.cursor,
        "cursors": cursors,
        "hasKeyboard": !data.keyboard.presses.is_empty(),
    }))
    .map_err(js_error)
}

fn source_values(source: TimelineSource<'_>) -> [f64; 3] {
    [
        source.segment_index as f64,
        source.segment.recording_clip as f64,
        source.source_time,
    ]
}

#[wasm_bindgen]
pub struct BrowserTimeline {
    timeline: TimelineConfiguration,
}

#[wasm_bindgen]
impl BrowserTimeline {
    #[wasm_bindgen(constructor)]
    pub fn new(timeline_json: &str) -> Result<BrowserTimeline, JsValue> {
        Ok(Self {
            timeline: serde_json::from_str(timeline_json).map_err(js_error)?,
        })
    }

    /// Output duration in seconds, as native export sizes its frame count.
    pub fn duration(&self) -> f64 {
        self.timeline.duration()
    }

    pub fn map_frame(&self, time: f64) -> Vec<f64> {
        if !time.is_finite() {
            return Vec::new();
        }
        match self.timeline.get_frame_mapping(time) {
            None => Vec::new(),
            Some(TimelineFrameMapping::Single { source, output_end }) => {
                let [index, clip, source_time] = source_values(source);
                vec![
                    0.0,
                    index,
                    clip,
                    source_time,
                    -1.0,
                    -1.0,
                    -1.0,
                    -1.0,
                    0.0,
                    0.0,
                    output_end,
                ]
            }
            Some(TimelineFrameMapping::Hold { source, output_end }) => {
                let [index, clip, source_time] = source_values(source);
                vec![
                    1.0,
                    index,
                    clip,
                    source_time,
                    -1.0,
                    -1.0,
                    -1.0,
                    -1.0,
                    0.0,
                    0.0,
                    output_end,
                ]
            }
            Some(TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                duration,
                output_end,
            }) => {
                let [index, clip, source_time] = source_values(incoming);
                let [outgoing_index, outgoing_clip, outgoing_time] = source_values(outgoing);
                let kind = match kind {
                    ClipTransitionType::CrossFade => 0.0,
                    ClipTransitionType::FadeThroughBlack => 1.0,
                };
                vec![
                    2.0,
                    index,
                    clip,
                    source_time,
                    outgoing_index,
                    outgoing_clip,
                    outgoing_time,
                    kind,
                    progress,
                    duration,
                    output_end,
                ]
            }
        }
    }
}

#[wasm_bindgen]
pub struct BrowserRecordingTimes {
    timings: Vec<SegmentVideoTiming>,
    offsets: Vec<ClipOffsets>,
    audio_present: Vec<[bool; 2]>,
}

#[wasm_bindgen]
impl BrowserRecordingTimes {
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str, clips_json: &str) -> Result<BrowserRecordingTimes, JsValue> {
        let meta: StudioRecordingMeta = serde_json::from_str(meta_json).map_err(js_error)?;
        let clips: Vec<ClipConfiguration> = serde_json::from_str(clips_json).map_err(js_error)?;
        let count = match &meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };
        if count == 0 {
            return Err(js_error("Recording contains no video segments"));
        }
        let timings = (0..count)
            .map(|index| segment_video_timing(&meta, index))
            .collect();
        let (mut offsets, audio_present) = match &meta {
            StudioRecordingMeta::SingleSegment { segment } => (
                vec![ClipOffsets::default()],
                vec![[segment.audio.is_some(), false]],
            ),
            StudioRecordingMeta::MultipleSegments { inner } => (
                inner
                    .segments
                    .iter()
                    .map(|segment| segment.calculate_audio_offsets())
                    .collect(),
                inner
                    .segments
                    .iter()
                    .map(|segment| [segment.mic.is_some(), segment.system_audio.is_some()])
                    .collect(),
            ),
        };
        for clip in clips {
            let index = clip.index as usize;
            if index < count {
                offsets[index] = clip.offsets;
            }
        }
        Ok(Self {
            timings,
            offsets,
            audio_present,
        })
    }

    pub fn source_times(&self, segment_index: usize, source_time: f64) -> Vec<f64> {
        if !source_time.is_finite() {
            return Vec::new();
        }
        let Some(timing) = self.timings.get(segment_index) else {
            return Vec::new();
        };
        let Some(offsets) = self.offsets.get(segment_index) else {
            return Vec::new();
        };
        let segment_time = source_time as f32;
        let (camera_request_time, _) = segment_frame_times(
            segment_time,
            timing.latest_start_time.unwrap_or(0.0),
            *offsets,
        );
        let display_time = segment_time + timing.screen_offset as f32;
        let camera_time = timing.camera_fps.map_or(f64::NAN, |_| {
            (camera_request_time + timing.camera_offset as f32) as f64
        });
        vec![display_time as f64, camera_time]
    }

    pub fn audio_times(&self, segment_index: usize, source_time: f64) -> Vec<f64> {
        if !source_time.is_finite() {
            return Vec::new();
        }
        let Some(offsets) = self.offsets.get(segment_index) else {
            return Vec::new();
        };
        let Some(present) = self.audio_present.get(segment_index) else {
            return Vec::new();
        };
        let source_time = source_time as f32;
        vec![
            if present[0] {
                (source_time + offsets.mic) as f64
            } else {
                f64::NAN
            },
            if present[1] {
                (source_time + offsets.system_audio) as f64
            } else {
                f64::NAN
            },
        ]
    }
}

#[wasm_bindgen]
pub struct BrowserVisualConfig {
    project: ProjectConfiguration,
}

#[wasm_bindgen]
impl BrowserVisualConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<Self, JsValue> {
        Ok(Self {
            project: serde_json::from_str(config_json).map_err(js_error)?,
        })
    }

    /// Output frame size for a preview box, identical to the native renderer's
    /// `ProjectUniforms::get_output_size`.
    pub fn output_dimensions(
        &self,
        source_width: u32,
        source_height: u32,
        resolution_width: u32,
        resolution_height: u32,
    ) -> Result<Vec<u32>, JsValue> {
        if source_width == 0
            || source_height == 0
            || resolution_width == 0
            || resolution_height == 0
        {
            return Err(js_error("Editor output dimensions are invalid"));
        }
        if self
            .project
            .background
            .crop
            .as_ref()
            .is_some_and(|crop| crop.size.x == 0 || crop.size.y == 0)
        {
            return Err(js_error("Editor crop dimensions are invalid"));
        }
        let options = RenderOptions {
            screen_size: XY::new(source_width, source_height),
            camera_size: None,
            preserve_screen_alpha: false,
        };
        let (width, height) = ProjectUniforms::get_output_size(
            &options,
            &self.project,
            XY::new(resolution_width, resolution_height),
        );
        Ok(vec![width.max(2), height.max(2)])
    }

    pub fn aspect_locked(&self) -> bool {
        matches!(
            self.project.aspect_ratio,
            Some(
                AspectRatio::Square
                    | AspectRatio::Wide
                    | AspectRatio::Vertical
                    | AspectRatio::Classic
                    | AspectRatio::Tall
            )
        )
    }
}

fn browser_source(value: &JsValue) -> Result<(BrowserFrameSource, u32, u32), JsValue> {
    if let Some(video) = value.dyn_ref::<HtmlVideoElement>() {
        if video.ready_state() < 2 {
            return Err(js_error("Video frame is not decoded"));
        }
        return Ok((
            BrowserFrameSource::Video(video.clone()),
            video.video_width(),
            video.video_height(),
        ));
    }
    if let Some(frame) = value.dyn_ref::<web_sys::VideoFrame>() {
        return Ok((
            BrowserFrameSource::VideoFrame(Clone::clone(frame)),
            frame.display_width(),
            frame.display_height(),
        ));
    }
    if let Some(bitmap) = value.dyn_ref::<ImageBitmap>() {
        return Ok((
            BrowserFrameSource::Bitmap(bitmap.clone()),
            bitmap.width(),
            bitmap.height(),
        ));
    }
    Err(js_error("Video frame source is invalid"))
}

fn decoded_frame(
    value: &JsValue,
    color_fix: bool,
    max_dimension: u32,
) -> Result<Option<DecodedFrame>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let (source, width, height) = browser_source(value)?;
    if width == 0 || height == 0 {
        return Err(js_error("Video frame is not decoded"));
    }
    if width > max_dimension || height > max_dimension {
        return Err(js_error("Video exceeds the browser GPU texture limit"));
    }
    Ok(Some(DecodedFrame::from_browser_source(
        source, width, height, color_fix,
    )))
}

struct ClipTimelines {
    project_revision: u64,
    recording_clip: u32,
    outgoing: bool,
    zoom: ZoomTransformTimeline,
}

struct CursorTimelineEntry {
    project_revision: u64,
    recording_clip: u32,
    timeline: Arc<PrecomputedCursorTimeline>,
}

/// Owns the native render core for one canvas. `frame_renderer` borrows
/// `constants`, so it is declared first and therefore dropped first.
#[wasm_bindgen]
pub struct BrowserStudioRenderer {
    frame_renderer: FrameRenderer<'static>,
    layers: RendererLayers,
    presenter: SurfacePresenter,
    zoom_cache: Vec<ClipTimelines>,
    cursor_cache: Vec<CursorTimelineEntry>,
    project: ProjectConfiguration,
    project_revision: u64,
    cursors: Vec<Arc<CursorEvents>>,
    backend: String,
    last_layout: Option<[f64; 10]>,
    constants: Box<RenderVideoConstants>,
}

struct TrackFrames {
    recording_clip: u32,
    segment_time: f32,
    screen: JsValue,
    screen_color_fix: bool,
    camera: JsValue,
    camera_color_fix: bool,
}

#[wasm_bindgen]
impl BrowserStudioRenderer {
    /// `recording_meta_json` is a `RecordingMeta` for a studio recording and
    /// `cursors_json` an array with one `CursorEvents` per recording clip.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        canvas: JsValue,
        prefer_webgpu: bool,
        recording_meta_json: String,
        screen_width: u32,
        screen_height: u32,
        camera_width: u32,
        camera_height: u32,
    ) -> Result<BrowserStudioRenderer, JsValue> {
        let recording_meta: RecordingMeta =
            serde_json::from_str(&recording_meta_json).map_err(js_error)?;
        let studio_meta = recording_meta
            .studio_meta()
            .cloned()
            .ok_or_else(|| js_error("Editor recording is not a studio recording"))?;
        if screen_width == 0 || screen_height == 0 {
            return Err(js_error("Editor recording dimensions are invalid"));
        }
        let segment_count = match &studio_meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };
        let canvas = present::CanvasTarget::from_js(canvas)?;
        let (shared, surface, surface_config) =
            present::create_device(&canvas, prefer_webgpu).await?;
        shared.device.on_uncaptured_error(Box::new(|error| {
            web_sys::console::error_1(&JsValue::from_str(&format!(
                "Cap renderer GPU error: {error}"
            )));
        }));
        let backend = format!("{:?}", shared.adapter.get_info().backend);
        trace_renderer(&format!("backend {backend}"));
        let options = RenderOptions {
            screen_size: XY::new(screen_width, screen_height),
            camera_size: (camera_width > 0 && camera_height > 0)
                .then(|| XY::new(camera_width, camera_height)),
            preserve_screen_alpha: false,
        };
        let constants = Box::new(RenderVideoConstants::from_shared_device(
            shared,
            options,
            studio_meta,
            recording_meta,
            Arc::new(Default::default()),
        ));
        // SAFETY: `constants` is boxed, never moved out of or replaced, and the
        // renderer that borrows it is dropped before it (field order).
        let constants_ref: &'static RenderVideoConstants =
            unsafe { &*(constants.as_ref() as *const RenderVideoConstants) };
        trace_renderer("creating layers");
        // Browser frames arrive as RGBA, so the native YUV compute converters
        // are never used; WebGL2 has no compute stage to build them with.
        constants
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let layers = RendererLayers::new(&constants.device, &constants.queue);
        if let Some(error) = constants.device.pop_error_scope().await {
            let message = error.to_string();
            if !message.contains("Converter") {
                web_sys::console::error_1(&JsValue::from_str(&format!(
                    "Cap renderer GPU error: {message}"
                )));
            }
        }
        let presenter = SurfacePresenter::new(&constants.device, surface, surface_config);
        presenter.configure(&constants.device);
        trace_renderer("renderer ready");
        Ok(Self {
            frame_renderer: FrameRenderer::new(constants_ref),
            layers,
            presenter,
            zoom_cache: Vec::new(),
            cursor_cache: Vec::new(),
            project: screen_recording_defaults::default_screen_recording_project_config(),
            project_revision: 0,
            cursors: (0..segment_count)
                .map(|_| Arc::new(CursorEvents::default()))
                .collect(),
            backend,
            last_layout: None,
            constants,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.backend.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn max_texture_dimension(&self) -> u32 {
        self.constants.device.limits().max_texture_dimension_2d
    }

    pub fn set_project(&mut self, config_json: &str) -> Result<(), JsValue> {
        self.project = serde_json::from_str(config_json).map_err(js_error)?;
        self.project_revision += 1;
        self.zoom_cache.clear();
        self.cursor_cache.clear();
        Ok(())
    }

    pub fn set_cursor(&mut self, recording_clip: u32, cursor_json: &str) -> Result<(), JsValue> {
        let cursor: CursorEvents = serde_json::from_str(cursor_json).map_err(js_error)?;
        let slot = self
            .cursors
            .get_mut(recording_clip as usize)
            .ok_or_else(|| js_error("Editor recording clip is unavailable"))?;
        *slot = Arc::new(cursor);
        self.zoom_cache.clear();
        self.cursor_cache.clear();
        Ok(())
    }

    /// Output size the next frame will have for a preview box.
    pub fn output_size(&self, resolution_width: u32, resolution_height: u32) -> Vec<u32> {
        let (width, height) = ProjectUniforms::get_output_size(
            &self.constants.options,
            &self.project,
            XY::new(resolution_width.max(2), resolution_height.max(2)),
        );
        vec![width.max(2), height.max(2)]
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        frame_number: u32,
        fps: u32,
        resolution_width: u32,
        resolution_height: u32,
        recording_clip: u32,
        segment_time: f64,
        screen: JsValue,
        screen_color_fix: bool,
        camera: JsValue,
        camera_color_fix: bool,
    ) -> Result<Vec<f64>, JsValue> {
        self.render_frame(
            frame_number,
            fps,
            XY::new(resolution_width, resolution_height),
            TrackFrames {
                recording_clip,
                segment_time: segment_time as f32,
                screen,
                screen_color_fix,
                camera,
                camera_color_fix,
            },
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_transition(
        &mut self,
        frame_number: u32,
        fps: u32,
        resolution_width: u32,
        resolution_height: u32,
        outgoing_clip: u32,
        outgoing_time: f64,
        outgoing_screen: JsValue,
        outgoing_screen_color_fix: bool,
        outgoing_camera: JsValue,
        outgoing_camera_color_fix: bool,
        incoming_clip: u32,
        incoming_time: f64,
        incoming_screen: JsValue,
        incoming_screen_color_fix: bool,
        incoming_camera: JsValue,
        incoming_camera_color_fix: bool,
        kind: u32,
        progress: f64,
    ) -> Result<Vec<f64>, JsValue> {
        self.render_frame(
            frame_number,
            fps,
            XY::new(resolution_width, resolution_height),
            TrackFrames {
                recording_clip: incoming_clip,
                segment_time: incoming_time as f32,
                screen: incoming_screen,
                screen_color_fix: incoming_screen_color_fix,
                camera: incoming_camera,
                camera_color_fix: incoming_camera_color_fix,
            },
            Some((
                TrackFrames {
                    recording_clip: outgoing_clip,
                    segment_time: outgoing_time as f32,
                    screen: outgoing_screen,
                    screen_color_fix: outgoing_screen_color_fix,
                    camera: outgoing_camera,
                    camera_color_fix: outgoing_camera_color_fix,
                },
                if kind == 1 {
                    ClipTransitionType::FadeThroughBlack
                } else {
                    ClipTransitionType::CrossFade
                },
                progress.clamp(0.0, 1.0) as f32,
            )),
        )
    }

    /// Presents the last rendered frame again, so a canvas snapshot taken in
    /// the same task sees it.
    pub fn redraw_last(&mut self) -> bool {
        self.presenter
            .redraw(&self.constants.device, &self.constants.queue)
    }

    pub async fn snapshot_rgba(&mut self) -> Result<Vec<u8>, JsValue> {
        self.presenter
            .snapshot_rgba(&self.constants.device, &self.constants.queue)
            .await
    }

    /// `[display x0, y0, x1, y1, camera x0, y0, x1, y1, output width, height]`
    /// of the last frame; camera entries are NaN when it is hidden.
    pub fn last_layout(&self) -> Vec<f64> {
        self.last_layout
            .map(|layout| layout.to_vec())
            .unwrap_or_default()
    }
}

impl BrowserStudioRenderer {
    fn segment_frames(
        &self,
        frames: &TrackFrames,
    ) -> Result<(DecodedSegmentFrames, Arc<CursorEvents>), JsValue> {
        let max_dimension = self.constants.device.limits().max_texture_dimension_2d;
        let clip = frames.recording_clip as usize;
        let cursor = self
            .cursors
            .get(clip)
            .cloned()
            .ok_or_else(|| js_error("Editor recording clip is unavailable"))?;
        let timing = segment_video_timing(&self.constants.meta, clip);
        let offsets = self
            .project
            .clips
            .iter()
            .find(|config| config.index == frames.recording_clip)
            .map(|config| config.offsets)
            .unwrap_or_default();
        let (_, recording_time) = segment_frame_times(
            frames.segment_time,
            timing.latest_start_time.unwrap_or(0.0),
            offsets,
        );
        let screen_frame = decoded_frame(&frames.screen, frames.screen_color_fix, max_dimension)?
            .ok_or_else(|| js_error("Editor display video is unavailable"))?;
        let camera_frame = if self.project.requires_camera() {
            decoded_frame(&frames.camera, frames.camera_color_fix, max_dimension)?
        } else {
            None
        };
        Ok((
            DecodedSegmentFrames {
                screen_size: self.constants.options.screen_size,
                screen_frame: Some(screen_frame),
                camera_frame,
                segment_time: frames.segment_time,
                recording_time,
                segment_has_camera: timing.camera_fps.is_some(),
            },
            cursor,
        ))
    }

    fn zoom_timeline(
        &mut self,
        recording_clip: u32,
        outgoing: bool,
        cursor: &CursorEvents,
        total_duration: f64,
        until_secs: f32,
    ) -> usize {
        let revision = self.project_revision;
        let index = match self.zoom_cache.iter().position(|entry| {
            entry.project_revision == revision
                && entry.recording_clip == recording_clip
                && entry.outgoing == outgoing
        }) {
            Some(index) => index,
            None => {
                let zoom = if outgoing {
                    ZoomTransformTimeline::from_project_for_outgoing_clip(
                        &self.project,
                        cursor,
                        total_duration,
                        self.constants.options.screen_size,
                        recording_clip,
                    )
                } else {
                    ZoomTransformTimeline::from_project_for_clip(
                        &self.project,
                        cursor,
                        total_duration,
                        self.constants.options.screen_size,
                        recording_clip,
                    )
                };
                if self.zoom_cache.len() >= 4 {
                    self.zoom_cache.remove(0);
                }
                self.zoom_cache.push(ClipTimelines {
                    project_revision: revision,
                    recording_clip,
                    outgoing,
                    zoom,
                });
                self.zoom_cache.len() - 1
            }
        };
        self.zoom_cache[index]
            .zoom
            .ensure_precomputed_until(until_secs);
        index
    }

    fn cursor_timeline(
        &mut self,
        recording_clip: u32,
        cursor: &Arc<CursorEvents>,
    ) -> Option<Arc<PrecomputedCursorTimeline>> {
        if cursor.moves.is_empty() {
            return None;
        }
        let project = &self.project;
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
            return None;
        }
        let revision = self.project_revision;
        if let Some(entry) = self.cursor_cache.iter().find(|entry| {
            entry.project_revision == revision && entry.recording_clip == recording_clip
        }) {
            return Some(entry.timeline.clone());
        }
        let smoothing = cap_rendering::spring_mass_damper::SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        };
        let timeline = Arc::new(PrecomputedCursorTimeline::new(
            cursor,
            (!project.cursor.raw).then_some(smoothing),
            Some(project.cursor.click_spring_config()),
        ));
        if self.cursor_cache.len() >= 2 {
            self.cursor_cache.remove(0);
        }
        self.cursor_cache.push(CursorTimelineEntry {
            project_revision: revision,
            recording_clip,
            timeline: timeline.clone(),
        });
        Some(timeline)
    }

    #[allow(clippy::too_many_arguments)]
    fn uniforms(
        &mut self,
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
        recording_clip: u32,
        outgoing: bool,
        cursor: &Arc<CursorEvents>,
        segment_frames: &DecodedSegmentFrames,
        total_duration: f64,
    ) -> ProjectUniforms {
        let zoom_index = self.zoom_timeline(
            recording_clip,
            outgoing,
            cursor,
            total_duration,
            (frame_number as f32 + 1.0) / fps as f32,
        );
        let cursor_timeline = self.cursor_timeline(recording_clip, cursor);
        let zoom = &self.zoom_cache[zoom_index].zoom;
        match cursor_timeline {
            Some(cursor_timeline) => ProjectUniforms::new_with_precomputed_cursor(
                &self.constants,
                &self.project,
                frame_number,
                fps,
                resolution_base,
                cursor,
                segment_frames,
                total_duration,
                zoom,
                &cursor_timeline,
            ),
            None => ProjectUniforms::new(
                &self.constants,
                &self.project,
                frame_number,
                fps,
                resolution_base,
                cursor,
                segment_frames,
                total_duration,
                zoom,
            ),
        }
    }

    fn render_frame(
        &mut self,
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
        incoming: TrackFrames,
        outgoing: Option<(TrackFrames, ClipTransitionType, f32)>,
    ) -> Result<Vec<f64>, JsValue> {
        if fps == 0 || resolution_base.x < 2 || resolution_base.y < 2 {
            return Err(js_error("Editor frame request is invalid"));
        }
        let total_duration = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.duration())
            .unwrap_or(0.0);
        let (incoming_frames, incoming_cursor) = self.segment_frames(&incoming)?;
        let incoming_uniforms = self.uniforms(
            frame_number,
            fps,
            resolution_base,
            incoming.recording_clip,
            false,
            &incoming_cursor,
            &incoming_frames,
            total_duration,
        );
        let layout = incoming_uniforms.frame_layout();
        let outgoing = match outgoing {
            Some((outgoing, kind, progress)) => {
                let (frames, cursor) = self.segment_frames(&outgoing)?;
                let uniforms = self.uniforms(
                    frame_number,
                    fps,
                    resolution_base,
                    outgoing.recording_clip,
                    true,
                    &cursor,
                    &frames,
                    total_duration,
                );
                Some((frames, uniforms, cursor, kind, progress))
            }
            None => None,
        };
        let (width, height) = incoming_uniforms.output_size;
        self.presenter
            .resize(&self.constants.device, width, height)?;
        let presenter = &mut self.presenter;
        let device = &self.constants.device;
        let present = |encoder: &mut wgpu::CommandEncoder,
                       texture: &wgpu::Texture,
                       view: &wgpu::TextureView| {
            presenter.present(device, encoder, texture, view);
        };
        let result = match outgoing {
            None => complete_now(self.frame_renderer.render_and_present(
                incoming_frames,
                incoming_uniforms,
                &incoming_cursor,
                true,
                &mut self.layers,
                present,
            ))?,
            Some((outgoing_frames, outgoing_uniforms, outgoing_cursor, kind, progress)) => {
                complete_now(self.frame_renderer.render_transition_and_present(
                    TransitionRenderInput {
                        segment_frames: outgoing_frames,
                        uniforms: outgoing_uniforms,
                        cursor: &outgoing_cursor,
                        render_display: true,
                    },
                    TransitionRenderInput {
                        segment_frames: incoming_frames,
                        uniforms: incoming_uniforms,
                        cursor: &incoming_cursor,
                        render_display: true,
                    },
                    kind,
                    progress,
                    &mut self.layers,
                    present,
                ))?
            }
        };
        self.presenter.finish();
        result.map_err(js_error)?;
        let camera = layout.camera.unwrap_or([f32::NAN; 4]);
        let values = [
            f64::from(layout.display[0]),
            f64::from(layout.display[1]),
            f64::from(layout.display[2]),
            f64::from(layout.display[3]),
            f64::from(camera[0]),
            f64::from(camera[1]),
            f64::from(camera[2]),
            f64::from(camera[3]),
            f64::from(layout.output_size[0]),
            f64::from(layout.output_size[1]),
        ];
        self.last_layout = Some(values);
        Ok(values.to_vec())
    }
}

#[wasm_bindgen]
pub fn webgl2_available(canvas: HtmlCanvasElement) -> bool {
    canvas
        .get_context("webgl2")
        .ok()
        .flatten()
        .and_then(|context| context.dyn_into::<WebGl2RenderingContext>().ok())
        .is_some()
}

pub(crate) fn shared_device(
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
) -> SharedWgpuDevice {
    let is_software_adapter = cap_rendering::is_software_wgpu_adapter(&adapter.get_info());
    SharedWgpuDevice {
        instance,
        adapter,
        device,
        queue,
        is_software_adapter,
    }
}
