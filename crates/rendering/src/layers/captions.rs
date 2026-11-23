use std::borrow::Cow;
use std::ops::Range;

use bytemuck::{Pod, Zeroable};
use cap_project::{CaptionWord, XY, caption_words::caption_display_segment};
use glyphon::cosmic_text::LayoutRunIter;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{Device, Queue, include_wgsl, util::DeviceExt};

use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, parse_color_component};

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
pub struct CaptionSettings {
    pub enabled: u32,
    pub font_size: f32,
    pub color: [f32; 4],
    pub background_color: [f32; 4],
    pub position: u32,
    pub outline: u32,
    pub outline_color: [f32; 4],
    pub font: u32,
    pub _padding: [f32; 1],
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: 1,
            font_size: 24.0,
            color: [1.0, 1.0, 1.0, 1.0],
            background_color: [0.0, 0.0, 0.0, 0.9],
            position: 5,
            outline: 1,
            outline_color: [0.0, 0.0, 0.0, 1.0],
            font: 0,
            _padding: [0.0],
        }
    }
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
struct CaptionBackgroundUniforms {
    rect: [f32; 4],
    color: [f32; 4],
    radius: f32,
    _padding: [f32; 3],
    _padding2: [f32; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CaptionPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    Manual,
}

impl CaptionPosition {
    fn from_str(s: &str) -> Self {
        match s {
            "top-left" => Self::TopLeft,
            "top-center" | "top" => Self::TopCenter,
            "top-right" => Self::TopRight,
            "bottom-left" => Self::BottomLeft,
            "bottom-right" => Self::BottomRight,
            "manual" => Self::Manual,
            _ => Self::BottomCenter,
        }
    }

    fn y_factor(&self) -> f32 {
        match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight => 0.08,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => 0.85,
            Self::Manual => 0.85,
        }
    }

    fn _x_alignment(&self) -> f32 {
        match self {
            Self::TopLeft | Self::BottomLeft => 0.05,
            Self::TopCenter | Self::BottomCenter => 0.5,
            Self::TopRight | Self::BottomRight => 0.95,
            Self::Manual => 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CaptionOverlayLayout {
    pub rect: [f32; 4],
    pub position: CaptionPosition,
}

/// The caption box on the latest frame at rest, before the bounce and pop
/// animations move it, in output-frame pixels (`[x0, y0, x1, y1]`). The
/// editor hit-tests and drags this box when the caption is placed manually.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionFrameBox {
    pub bounds: [f32; 4],
    position: CaptionPosition,
}

impl CaptionFrameBox {
    pub fn new(bounds: [f32; 4], position: &str) -> Self {
        Self {
            bounds,
            position: CaptionPosition::from_str(position),
        }
    }

    /// Whether this caption sits at the Manual position, through the
    /// settings or its segment's own override.
    pub fn is_manual(&self) -> bool {
        self.position == CaptionPosition::Manual
    }

    pub fn is_at(&self, position: &str) -> bool {
        self.position == CaptionPosition::from_str(position)
    }
}

/// Top-left corner of a caption box of `box_size` at rest in a frame of
/// `frame` pixels. Manual placement centres the box on `manual`, a fraction
/// of the frame, and keeps the whole box inside the frame.
pub(crate) fn caption_box_origin(
    position: CaptionPosition,
    manual: Option<XY<f32>>,
    box_size: (f32, f32),
    frame: (f32, f32),
) -> (f32, f32) {
    let (box_width, box_height) = box_size;
    let (width, height) = frame;
    let margin = width * 0.05;
    let max_left = (width - box_width).max(0.0);
    let max_top = (height - box_height).max(0.0);
    let manual = manual.filter(|_| position == CaptionPosition::Manual);
    let left = match (position, manual) {
        (_, Some(manual)) => {
            (manual.x.clamp(0.0, 1.0) * width - box_width / 2.0).clamp(0.0, max_left)
        }
        (CaptionPosition::TopLeft | CaptionPosition::BottomLeft, _) => margin,
        (CaptionPosition::TopRight | CaptionPosition::BottomRight, _) => {
            (width - margin - box_width).max(0.0)
        }
        _ => ((width - box_width) / 2.0).max(0.0),
    };
    let center_y = match manual {
        Some(manual) => manual.y.clamp(0.0, 1.0) * height,
        None => height * position.y_factor(),
    };
    (left, (center_y - box_height / 2.0).clamp(0.0, max_top))
}

/// The centre of the caption box last drawn, as fractions of the frame, with
/// the position setting it was drawn for. Left and right presets align the
/// box's edge to the margin, so where its centre lands depends on the box
/// width, which only this layer measures. The editor starts Manual placement
/// here so switching to it leaves the captions where they were.
static LAST_CAPTION_CENTER: std::sync::Mutex<Option<(CaptionPosition, [f32; 2])>> =
    std::sync::Mutex::new(None);

/// [`LAST_CAPTION_CENTER`] when the last caption was drawn at `position`.
pub fn last_caption_center(position: &str) -> Option<(f32, f32)> {
    let wanted = CaptionPosition::from_str(position);
    let last = *LAST_CAPTION_CENTER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    last.and_then(|(drawn, [x, y])| (drawn == wanted).then_some((x, y)))
}

fn caption_center(rect: [f32; 4], frame: (u32, u32)) -> Option<[f32; 2]> {
    (frame.0 > 0 && frame.1 > 0).then(|| {
        [
            ((rect[0] + rect[2] / 2.0) / frame.0 as f32).clamp(0.0, 1.0),
            ((rect[1] + rect[3] / 2.0) / frame.1 as f32).clamp(0.0, 1.0),
        ]
    })
}

fn record_caption_center(position: CaptionPosition, rect: [f32; 4], frame: (u32, u32)) {
    if let Some(center) = caption_center(rect, frame) {
        *LAST_CAPTION_CENTER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((position, center));
    }
}

const BASE_TEXT_OPACITY: f32 = 0.8;
const BOUNCE_OFFSET_PIXELS: f32 = 8.0;
// Safety net for caption segments whose trailing word end was stretched across a
// silence by transcription (e.g. a 16s "seconds."). Without this, such a segment
// stays on screen for the whole inflated duration. Value comes from the shared
// caption word utilities so it stays in sync with the transcription layers.
const MAX_CAPTION_WORD_DURATION: f64 = cap_project::caption_words::MAX_CAPTION_WORD_DURATION as f64;

fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn ease_in_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * t
}

const POP_MIN_SCALE: f64 = 0.72;

fn ease_out_back(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    let p = t - 1.0;
    1.0 + c3 * p * p * p + c1 * p * p
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptionAnimation {
    None,
    Bounce,
    Pop,
}

impl CaptionAnimation {
    fn from_str(s: &str) -> Self {
        match s {
            "none" => Self::None,
            "pop" => Self::Pop,
            _ => Self::Bounce,
        }
    }
}

fn calculate_caption_pop_scale(current_time: f64, start: f64, end: f64, fade_duration: f64) -> f64 {
    if fade_duration <= 0.0 {
        return 1.0;
    }

    let time_from_start = current_time - start;
    let time_to_end = end - current_time;

    if time_from_start < fade_duration {
        let progress = (time_from_start / fade_duration).clamp(0.0, 1.0);
        return POP_MIN_SCALE + (1.0 - POP_MIN_SCALE) * ease_out_back(progress);
    }

    if time_to_end >= 0.0 {
        return 1.0;
    }

    let past_end = -time_to_end;
    let progress = (past_end / fade_duration).clamp(0.0, 1.0);
    POP_MIN_SCALE + (1.0 - POP_MIN_SCALE) * (1.0 - ease_in_cubic(progress as f32) as f64)
}

fn find_active_word_index(current_time: f32, words: &[CaptionWord]) -> Option<usize> {
    if words.is_empty() {
        return None;
    }

    if let Some(idx) = words
        .iter()
        .position(|w| current_time >= w.start && current_time < w.end)
    {
        return Some(idx);
    }

    let mut last_before: Option<usize> = None;
    for (idx, word) in words.iter().enumerate() {
        if current_time >= word.end {
            last_before = Some(idx);
        }
    }

    last_before.or(Some(0))
}

fn word_byte_range(
    full_text: &str,
    words: &[CaptionWord],
    target_idx: usize,
    uppercase: bool,
) -> Option<(usize, usize)> {
    let mut last_end = 0usize;
    for (idx, word) in words.iter().enumerate() {
        let needle = if uppercase {
            word.text.to_uppercase()
        } else {
            word.text.clone()
        };
        let start_pos = full_text.get(last_end..)?.find(&needle)?;
        let abs_start = last_end + start_pos;
        let end = abs_start + needle.len();
        if idx == target_idx {
            return Some((abs_start, end));
        }
        last_end = end;
    }
    None
}

fn calculate_word_highlight(
    current_time: f32,
    word: &CaptionWord,
    word_idx: usize,
    all_words: &[CaptionWord],
    transition_duration: f32,
) -> f32 {
    if transition_duration <= 0.0 {
        if current_time >= word.start && current_time < word.end {
            return 1.0;
        }
        return 0.0;
    }

    let next_word_start = if word_idx + 1 < all_words.len() {
        Some(all_words[word_idx + 1].start)
    } else {
        None
    };

    if current_time >= word.start && current_time < word.end {
        let time_since_start = current_time - word.start;
        let fade_in = ease_out_cubic(time_since_start / transition_duration);
        return fade_in;
    }

    if current_time >= word.end {
        if let Some(next_start) = next_word_start {
            if current_time < next_start {
                let time_since_end = current_time - word.end;
                let gap_duration = next_start - word.end;
                let effective_duration = transition_duration.min(gap_duration);

                if time_since_end < effective_duration {
                    let progress = time_since_end / effective_duration;
                    return 1.0 - ease_in_cubic(progress);
                }
            }
        } else {
            let time_since_end = current_time - word.end;
            if time_since_end < transition_duration {
                let progress = time_since_end / transition_duration;
                return 1.0 - ease_in_cubic(progress);
            }
        }
    }

    0.0
}

fn caption_rgba(rgb: [f32; 3], alpha: f32) -> Color {
    Color::rgba(
        (rgb[0] * 255.0) as u8,
        (rgb[1] * 255.0) as u8,
        (rgb[2] * 255.0) as u8,
        (alpha * 255.0) as u8,
    )
}

struct WordHighlight {
    base_rgb: [f32; 3],
    highlight_rgb: [f32; 3],
    base_alpha: f32,
    highlight_alpha: f32,
    transition_duration: f32,
}

fn word_highlight_spans(
    text: &str,
    words: &[CaptionWord],
    uppercase: bool,
    current_time: f32,
    highlight: &WordHighlight,
) -> Vec<(Range<usize>, Color)> {
    let base = caption_rgba(highlight.base_rgb, highlight.base_alpha);
    let mut spans = Vec::with_capacity(words.len() * 2 + 1);
    let mut last_end = 0usize;

    for (idx, word) in words.iter().enumerate() {
        let needle = if uppercase {
            Cow::Owned(word.text.to_uppercase())
        } else {
            Cow::Borrowed(word.text.as_str())
        };
        let Some(start_pos) = text.get(last_end..).and_then(|s| s.find(needle.as_ref())) else {
            continue;
        };
        let abs_start = last_end + start_pos;
        if abs_start > last_end {
            spans.push((last_end..abs_start, base));
        }

        let word_highlight = calculate_word_highlight(
            current_time,
            word,
            idx,
            words,
            highlight.transition_duration,
        );
        let blended_rgb: [f32; 3] = std::array::from_fn(|channel| {
            highlight.base_rgb[channel]
                + (highlight.highlight_rgb[channel] - highlight.base_rgb[channel]) * word_highlight
        });
        let blended_alpha = highlight.base_alpha
            + (highlight.highlight_alpha - highlight.base_alpha) * word_highlight;

        let word_end = abs_start + needle.len();
        spans.push((
            abs_start..word_end,
            caption_rgba(blended_rgb, blended_alpha),
        ));
        last_end = word_end;
    }

    if last_end < text.len() {
        spans.push((last_end..text.len(), base));
    }

    spans
}

#[derive(PartialEq)]
enum CaptionTextColors {
    Uniform(Color),
    Spans(Vec<(Range<usize>, Color)>),
}

#[derive(PartialEq)]
struct ShapedCaptionText {
    text: String,
    font_size: u32,
    wrap_width: u32,
    family: Family<'static>,
    weight: Weight,
    colors: CaptionTextColors,
}

fn caption_text_left(buffer: &Buffer, content_left: f32, render_scale: f32) -> f32 {
    let min_x = LayoutRunIter::new(buffer)
        .flat_map(|run| run.glyphs)
        .map(|glyph| glyph.x)
        .reduce(f32::min)
        .unwrap_or(0.0);
    content_left - min_x * render_scale
}

/// The caption size in output pixels, or `None` when it rounds to nothing.
/// A size of 0 (from a hand-edited or tool-written config; the editor's
/// slider stops at 12) would give cosmic-text a zero line height, which it
/// asserts against.
pub(crate) fn scaled_font_size(size: u32, output_height: u32) -> Option<f32> {
    let font_size = size as f32 * (output_height as f32 / 1080.0);
    (font_size > 0.0).then_some(font_size)
}

fn shape_caption_text(font_system: &mut FontSystem, shaped: &ShapedCaptionText) -> Buffer {
    let font_size = f32::from_bits(shaped.font_size);
    let mut buffer = Buffer::new(font_system, Metrics::new(font_size, font_size * 1.2));
    buffer.set_size(font_system, Some(f32::from_bits(shaped.wrap_width)), None);
    buffer.set_wrap(font_system, glyphon::Wrap::None);
    let attrs = Attrs::new().family(shaped.family).weight(shaped.weight);
    match &shaped.colors {
        CaptionTextColors::Uniform(color) => buffer.set_text(
            font_system,
            &shaped.text,
            &attrs.color(*color),
            Shaping::Advanced,
        ),
        CaptionTextColors::Spans(spans) => buffer.set_rich_text(
            font_system,
            spans
                .iter()
                .map(|(range, color)| (&shaped.text[range.clone()], attrs.clone().color(*color))),
            &attrs,
            Shaping::Advanced,
            None,
        ),
    }
    buffer
}

struct CaptionText {
    buffer: Buffer,
    shaped: Option<ShapedCaptionText>,
}

impl CaptionText {
    fn new() -> Self {
        Self {
            buffer: Buffer::new_empty(Metrics::new(24.0, 24.0 * 1.2)),
            shaped: None,
        }
    }

    fn update(&mut self, font_system: &mut FontSystem, shaped: ShapedCaptionText) -> bool {
        if self.shaped.as_ref() == Some(&shaped) {
            return false;
        }
        self.buffer = shape_caption_text(font_system, &shaped);
        self.shaped = Some(shaped);
        true
    }
}

pub struct CaptionsLayer {
    _settings_buffer: wgpu::Buffer,
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    text: CaptionText,
    current_text: Option<String>,
    current_segment_start: f32,
    current_segment_end: f32,
    viewport: Viewport,
    background_pipeline: wgpu::RenderPipeline,
    background_bind_group: wgpu::BindGroup,
    background_uniform_buffer: wgpu::Buffer,
    background_scissor: Option<[u32; 4]>,
    highlight_bind_group: wgpu::BindGroup,
    highlight_uniform_buffer: wgpu::Buffer,
    highlight_scissor: Option<[u32; 4]>,
    has_highlight: bool,
    output_size: (u32, u32),
    has_caption: bool,
    active_layout: Option<CaptionOverlayLayout>,
    frame_box: Option<CaptionFrameBox>,
}

impl CaptionsLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let settings = CaptionSettings::default();
        let settings_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Settings Buffer"),
            contents: bytemuck::cast_slice(&[settings]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let font_system = super::new_font_system();
        let glyph_phase = crate::readiness::Phase::start("glyph.captions.gpu_resources");
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut text_atlas = TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8Unorm);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            device,
            wgpu::MultisampleState::default(),
            None,
        );
        glyph_phase.finish("returned");

        let background_uniforms = CaptionBackgroundUniforms {
            rect: [0.0; 4],
            color: [0.0; 4],
            radius: 0.0,
            _padding: [0.0; 3],
            _padding2: [0.0; 4],
        };

        let background_uniform_buffer =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Caption Background Uniform Buffer"),
                contents: bytemuck::bytes_of(&background_uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

        let background_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Caption Background Bind Group Layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let background_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Caption Background Bind Group"),
            layout: &background_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: background_uniform_buffer.as_entire_binding(),
            }],
        });

        let highlight_uniform_buffer =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Caption Highlight Uniform Buffer"),
                contents: bytemuck::bytes_of(&background_uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

        let highlight_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Caption Highlight Bind Group"),
            layout: &background_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: highlight_uniform_buffer.as_entire_binding(),
            }],
        });

        let background_shader =
            device.create_shader_module(include_wgsl!("../shaders/caption_bg.wgsl"));

        let background_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Caption Background Pipeline Layout"),
                bind_group_layouts: &[&background_bind_group_layout],
                push_constant_ranges: &[],
            });

        let background_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Caption Background Pipeline"),
            layout: Some(&background_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &background_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &background_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            _settings_buffer: settings_buffer,
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            text: CaptionText::new(),
            current_text: None,
            current_segment_start: 0.0,
            current_segment_end: 0.0,
            viewport,
            background_pipeline,
            background_bind_group,
            background_uniform_buffer,
            background_scissor: None,
            highlight_bind_group,
            highlight_uniform_buffer,
            highlight_scissor: None,
            has_highlight: false,
            output_size: (0, 0),
            has_caption: false,
            active_layout: None,
            frame_box: None,
        }
    }

    #[allow(dead_code)]
    pub fn update_settings(&mut self, queue: &Queue, settings: CaptionSettings) {
        queue.write_buffer(&self._settings_buffer, 0, bytemuck::cast_slice(&[settings]));
    }

    pub fn update_caption(&mut self, text: Option<String>, start: f32, end: f32) {
        self.current_text = text;
        self.current_segment_start = start;
        self.current_segment_end = end;
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        _segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        self.has_caption = false;
        self.active_layout = None;
        self.frame_box = None;
        self.background_scissor = None;
        self.highlight_scissor = None;
        self.has_highlight = false;
        self.output_size = (output_size.x, output_size.y);

        let Some(caption_data) = &uniforms.project.captions else {
            self.current_text = None;
            return;
        };

        if !caption_data.settings.enabled {
            self.current_text = None;
            return;
        }

        let timeline = match &uniforms.project.timeline {
            Some(t) => t,
            None => {
                self.current_text = None;
                return;
            }
        };

        if timeline.caption_segments.is_empty() {
            self.current_text = None;
            return;
        }

        let current_time = uniforms.frame_number as f64 / uniforms.frame_rate as f64;
        let default_fade = caption_data.settings.fade_duration;
        let word_transition_duration = caption_data.settings.word_transition_duration;

        let Some(active) = find_active_caption_segment(
            current_time,
            &timeline.caption_segments,
            default_fade,
            caption_data.settings.hides_fillers(),
        ) else {
            self.current_text = None;
            return;
        };

        let segment_fade = active
            .segment
            .fade_duration_override
            .unwrap_or(default_fade) as f64;

        let effective_end = caption_segment_effective_end(&active.segment);

        self.update_caption(
            Some(active.segment.text.clone()),
            active.segment.start as f32,
            effective_end as f32,
        );

        let raw_caption_text = self.current_text.clone().unwrap_or_default();
        let joined_caption_text = raw_caption_text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let uppercase = caption_data.settings.uppercase;
        let caption_text = if uppercase {
            joined_caption_text.to_uppercase()
        } else {
            joined_caption_text
        };
        let caption_words = &active.segment.words;

        let fade_opacity = calculate_caption_fade(
            current_time,
            active.segment.start,
            effective_end,
            segment_fade,
        ) * uniforms.takeover_overlay_fade();
        if fade_opacity <= 0.0 {
            self.current_text = None;
            return;
        }

        let animation = CaptionAnimation::from_str(&caption_data.settings.animation);

        let bounce_offset = if animation == CaptionAnimation::Bounce {
            calculate_caption_bounce(
                current_time,
                active.segment.start,
                effective_end,
                segment_fade,
            )
        } else {
            0.0
        };

        let pop_scale = if animation == CaptionAnimation::Pop {
            calculate_caption_pop_scale(
                current_time,
                active.segment.start,
                effective_end,
                segment_fade,
            )
        } else {
            1.0
        };

        let active_word_highlight_enabled = caption_data.settings.active_word_highlight;
        let use_pill_highlight = active_word_highlight_enabled
            && !caption_words.is_empty()
            && caption_data.settings.highlight_style == "pill";
        let use_color_highlight =
            active_word_highlight_enabled && !caption_words.is_empty() && !use_pill_highlight;

        let active_word_byte_range = if use_pill_highlight {
            find_active_word_index(current_time as f32, caption_words)
                .and_then(|idx| word_byte_range(&caption_text, caption_words, idx, uppercase))
        } else {
            None
        };

        let (width, height) = (output_size.x, output_size.y);
        let device = &constants.device;
        let queue = &constants.queue;

        let position = active
            .segment
            .position_override
            .as_deref()
            .map(CaptionPosition::from_str)
            .unwrap_or_else(|| CaptionPosition::from_str(&caption_data.settings.position));
        let margin = width as f32 * 0.05;

        let base_color = [
            parse_color_component(&caption_data.settings.color, 0),
            parse_color_component(&caption_data.settings.color, 1),
            parse_color_component(&caption_data.settings.color, 2),
        ];

        let highlight_color_rgb = [
            parse_color_component(&caption_data.settings.highlight_color, 0),
            parse_color_component(&caption_data.settings.highlight_color, 1),
            parse_color_component(&caption_data.settings.highlight_color, 2),
        ];

        let outline_color_rgb = [
            parse_color_component(&caption_data.settings.outline_color, 0),
            parse_color_component(&caption_data.settings.outline_color, 1),
            parse_color_component(&caption_data.settings.outline_color, 2),
        ];

        let background_color_rgb = [
            parse_color_component(&caption_data.settings.background_color, 0),
            parse_color_component(&caption_data.settings.background_color, 1),
            parse_color_component(&caption_data.settings.background_color, 2),
        ];

        let background_alpha = ((caption_data.settings.background_opacity as f32 / 100.0)
            * fade_opacity)
            .clamp(0.0, 1.0);

        let Some(font_size) = scaled_font_size(caption_data.settings.size, height) else {
            return;
        };
        let wrap_width = (width as f32 - margin * 2.0).max(font_size);
        let font_family = match caption_data.settings.font.as_str() {
            "System Serif" => Family::Serif,
            "System Monospace" => Family::Monospace,
            _ => Family::SansSerif,
        };

        let weight = if caption_data.settings.font_weight >= 700 {
            Weight::BOLD
        } else if caption_data.settings.font_weight >= 500 {
            Weight::MEDIUM
        } else {
            Weight::NORMAL
        };

        let base_alpha = (fade_opacity * BASE_TEXT_OPACITY).clamp(0.0, 1.0);
        let highlight_alpha = fade_opacity.clamp(0.0, 1.0);

        let colors = if use_color_highlight {
            CaptionTextColors::Spans(word_highlight_spans(
                &caption_text,
                caption_words,
                uppercase,
                current_time as f32,
                &WordHighlight {
                    base_rgb: base_color,
                    highlight_rgb: highlight_color_rgb,
                    base_alpha,
                    highlight_alpha,
                    transition_duration: word_transition_duration,
                },
            ))
        } else {
            CaptionTextColors::Uniform(caption_rgba(base_color, highlight_alpha))
        };
        self.text.update(
            &mut self.font_system,
            ShapedCaptionText {
                text: caption_text,
                font_size: font_size.to_bits(),
                wrap_width: wrap_width.to_bits(),
                family: font_family,
                weight,
                colors,
            },
        );

        let mut layout_width: f32 = 0.0;
        let mut layout_height: f32 = 0.0;
        let mut highlight_extent: Option<(f32, f32, f32, f32)> = None;
        for run in LayoutRunIter::new(&self.text.buffer) {
            layout_width = layout_width.max(run.line_w);
            layout_height = layout_height.max(run.line_top + run.line_height);

            if let Some((word_start, word_end)) = active_word_byte_range {
                for glyph in run.glyphs.iter() {
                    if glyph.start < word_end && glyph.end > word_start {
                        match highlight_extent {
                            Some((
                                ref mut min_x,
                                ref mut max_x,
                                ref mut line_top,
                                ref mut line_height,
                            )) => {
                                *min_x = min_x.min(glyph.x);
                                *max_x = max_x.max(glyph.x + glyph.w);
                                *line_top = run.line_top;
                                *line_height = run.line_height;
                            }
                            None => {
                                highlight_extent = Some((
                                    glyph.x,
                                    glyph.x + glyph.w,
                                    run.line_top,
                                    run.line_height,
                                ));
                            }
                        }
                    }
                }
            }
        }

        if layout_height == 0.0 {
            layout_height = font_size * 1.2;
            layout_width = layout_width.max(font_size);
        }

        let available_width = (width as f32 - margin * 2.0).max(1.0);
        let initial_padding = font_size * 0.5;
        let fit_scale = if layout_width + initial_padding * 2.0 > available_width {
            (available_width / (layout_width + initial_padding * 2.0)).clamp(0.35, 1.0)
        } else {
            1.0
        };
        let effective_font_size = font_size * fit_scale;
        let padding = effective_font_size * 0.5;
        let corner_radius = effective_font_size * 0.55;
        let text_width = (layout_width * fit_scale).min(available_width);
        let text_height = layout_height * fit_scale;
        let box_width = (text_width + padding * 2.0).min(available_width).max(1.0);
        let box_height = (text_height + padding * 2.0).min(height as f32).max(1.0);

        let (background_left, base_background_top) = caption_box_origin(
            position,
            caption_data.settings.manual_position,
            (box_width, box_height),
            (width as f32, height as f32),
        );
        let background_top = (base_background_top + bounce_offset as f32)
            .clamp(0.0, (height as f32 - box_height).max(0.0));

        let anim_scale = pop_scale as f32;
        let box_center_x = background_left + box_width / 2.0;
        let box_center_y = background_top + box_height / 2.0;
        let draw_box_width = box_width * anim_scale;
        let draw_box_height = box_height * anim_scale;
        let draw_box_left = box_center_x - draw_box_width / 2.0;
        let draw_box_top = box_center_y - draw_box_height / 2.0;
        let render_scale = fit_scale * anim_scale;
        let draw_text_width = text_width * anim_scale;
        let draw_text_height = text_height * anim_scale;

        let content_left = draw_box_left + padding * anim_scale;
        let text_left = caption_text_left(&self.text.buffer, content_left, render_scale);
        let text_top = draw_box_top + padding * anim_scale;

        let bounds = TextBounds {
            left: (content_left - 2.0).floor() as i32,
            top: (text_top - 2.0).floor() as i32,
            right: (content_left + draw_text_width + 2.0).ceil() as i32,
            bottom: (text_top + draw_text_height + 2.0).ceil() as i32,
        };

        self.viewport.update(queue, Resolution { width, height });

        let mut text_areas = Vec::new();

        let outline_color = Color::rgba(
            (outline_color_rgb[0] * 255.0) as u8,
            (outline_color_rgb[1] * 255.0) as u8,
            (outline_color_rgb[2] * 255.0) as u8,
            (fade_opacity * 255.0) as u8,
        );

        if caption_data.settings.outline {
            let outline_thickness = 1.2 * render_scale;
            let outline_offsets = [
                (-outline_thickness, -outline_thickness),
                (0.0, -outline_thickness),
                (outline_thickness, -outline_thickness),
                (-outline_thickness, 0.0),
                (outline_thickness, 0.0),
                (-outline_thickness, outline_thickness),
                (0.0, outline_thickness),
                (outline_thickness, outline_thickness),
                (-outline_thickness * 0.7, -outline_thickness * 0.7),
                (outline_thickness * 0.7, -outline_thickness * 0.7),
                (-outline_thickness * 0.7, outline_thickness * 0.7),
                (outline_thickness * 0.7, outline_thickness * 0.7),
            ];

            for (offset_x, offset_y) in outline_offsets.iter() {
                text_areas.push(TextArea {
                    buffer: &self.text.buffer,
                    left: text_left + offset_x,
                    top: text_top + offset_y,
                    scale: render_scale,
                    bounds,
                    default_color: outline_color,
                    custom_glyphs: &[],
                });
            }
        }

        let default_color = Color::rgba(
            (base_color[0] * 255.0) as u8,
            (base_color[1] * 255.0) as u8,
            (base_color[2] * 255.0) as u8,
            (base_alpha * 255.0) as u8,
        );

        text_areas.push(TextArea {
            buffer: &self.text.buffer,
            left: text_left,
            top: text_top,
            scale: render_scale,
            bounds,
            default_color,
            custom_glyphs: &[],
        });

        match self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            text_areas,
            &mut self.swash_cache,
        ) {
            Ok(_) => {}
            Err(e) => warn!("Error preparing text: {e:?}"),
        }

        let rect = [
            draw_box_left.max(0.0),
            draw_box_top.max(0.0),
            draw_box_width,
            draw_box_height,
        ];

        let resting = [background_left, base_background_top, box_width, box_height];
        self.active_layout = Some(CaptionOverlayLayout { rect, position });
        self.frame_box = Some(CaptionFrameBox {
            bounds: [
                resting[0],
                resting[1],
                resting[0] + resting[2],
                resting[1] + resting[3],
            ],
            position,
        });
        record_caption_center(position, resting, (width, height));

        let background_uniforms = CaptionBackgroundUniforms {
            rect,
            color: [
                background_color_rgb[0],
                background_color_rgb[1],
                background_color_rgb[2],
                background_alpha,
            ],
            radius: (corner_radius * anim_scale)
                .min(draw_box_width / 2.0)
                .min(draw_box_height / 2.0),
            _padding: [0.0; 3],
            _padding2: [0.0; 4],
        };

        queue.write_buffer(
            &self.background_uniform_buffer,
            0,
            bytemuck::bytes_of(&background_uniforms),
        );

        if let Some((min_x, max_x, line_top, line_height)) = highlight_extent
            && max_x > min_x
        {
            let pill_pad_x = effective_font_size * 0.28 * anim_scale;
            let pill_pad_y = effective_font_size * 0.12 * anim_scale;
            let pill_left = (text_left + min_x * render_scale - pill_pad_x).max(0.0);
            let pill_top = (text_top + line_top * render_scale - pill_pad_y).max(0.0);
            let pill_width = ((max_x - min_x) * render_scale + pill_pad_x * 2.0)
                .min((width as f32 - pill_left).max(0.0))
                .max(1.0);
            let pill_height = (line_height * render_scale + pill_pad_y * 2.0)
                .min((height as f32 - pill_top).max(0.0))
                .max(1.0);
            let pill_radius = (pill_height * 0.4).min(pill_width / 2.0);

            let pill_uniforms = CaptionBackgroundUniforms {
                rect: [pill_left, pill_top, pill_width, pill_height],
                color: [
                    highlight_color_rgb[0],
                    highlight_color_rgb[1],
                    highlight_color_rgb[2],
                    fade_opacity,
                ],
                radius: pill_radius,
                _padding: [0.0; 3],
                _padding2: [0.0; 4],
            };
            queue.write_buffer(
                &self.highlight_uniform_buffer,
                0,
                bytemuck::bytes_of(&pill_uniforms),
            );

            let pill_scissor_pad = 3.0;
            let pill_scissor_x = (pill_left - pill_scissor_pad).max(0.0).floor() as u32;
            let pill_scissor_y = (pill_top - pill_scissor_pad).max(0.0).floor() as u32;
            let pill_max_width = width.saturating_sub(pill_scissor_x);
            let pill_max_height = height.saturating_sub(pill_scissor_y);

            if pill_max_width > 0 && pill_max_height > 0 {
                let pill_scissor_width = (pill_width + pill_scissor_pad * 2.0)
                    .ceil()
                    .max(1.0)
                    .min(pill_max_width as f32) as u32;
                let pill_scissor_height = (pill_height + pill_scissor_pad * 2.0)
                    .ceil()
                    .max(1.0)
                    .min(pill_max_height as f32) as u32;

                self.highlight_scissor = Some([
                    pill_scissor_x,
                    pill_scissor_y,
                    pill_scissor_width,
                    pill_scissor_height,
                ]);
                self.has_highlight = true;
            }
        }

        let scissor_padding = 4.0;
        let scissor_x = (draw_box_left - scissor_padding).max(0.0).floor() as u32;
        let scissor_y = (draw_box_top - scissor_padding).max(0.0).floor() as u32;
        let max_width = width.saturating_sub(scissor_x);
        let max_height = height.saturating_sub(scissor_y);

        if max_width == 0 || max_height == 0 {
            self.has_caption = false;
            self.has_highlight = false;
            self.highlight_scissor = None;
            return;
        }

        let scissor_width = (draw_box_width + scissor_padding * 2.0)
            .ceil()
            .max(1.0)
            .min(max_width as f32) as u32;
        let scissor_height = (draw_box_height + scissor_padding * 2.0)
            .ceil()
            .max(1.0)
            .min(max_height as f32) as u32;

        if scissor_width == 0 || scissor_height == 0 {
            self.has_caption = false;
            self.has_highlight = false;
            self.highlight_scissor = None;
            return;
        }

        self.background_scissor = Some([scissor_x, scissor_y, scissor_width, scissor_height]);
        self.has_caption = true;
    }

    pub fn has_content(&self) -> bool {
        self.has_caption
    }

    pub fn active_layout(&self) -> Option<CaptionOverlayLayout> {
        self.active_layout
    }

    pub fn frame_box(&self) -> Option<CaptionFrameBox> {
        self.frame_box
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.has_caption {
            return;
        }

        if let Some([x, y, width, height]) = self.background_scissor {
            pass.set_scissor_rect(x, y, width, height);
            pass.set_pipeline(&self.background_pipeline);
            pass.set_bind_group(0, &self.background_bind_group, &[]);
            pass.draw(0..6, 0..1);

            if let Some([px, py, pw, ph]) = self.highlight_scissor {
                pass.set_scissor_rect(px, py, pw, ph);
                pass.set_bind_group(0, &self.highlight_bind_group, &[]);
                pass.draw(0..6, 0..1);
            }

            pass.set_scissor_rect(x, y, width, height);
        } else if self.output_size.0 > 0 && self.output_size.1 > 0 {
            pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
        }

        match self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            Ok(_) => {}
            Err(e) => warn!("Error rendering text: {e:?}"),
        }

        if self.output_size.0 > 0 && self.output_size.1 > 0 {
            pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
        }
    }
}

struct ActiveCaptionSegment<'a> {
    segment: Cow<'a, cap_project::CaptionTrackSegment>,
}

fn caption_segment_effective_end(segment: &cap_project::CaptionTrackSegment) -> f64 {
    match segment.words.last() {
        Some(last) => segment
            .end
            .min(last.start as f64 + MAX_CAPTION_WORD_DURATION),
        None => segment.end,
    }
}

fn find_active_caption_segment<'a>(
    time: f64,
    segments: &'a [cap_project::CaptionTrackSegment],
    default_fade_duration: f32,
    hide_fillers: bool,
) -> Option<ActiveCaptionSegment<'a>> {
    for segment in segments {
        if time < segment.start || time >= caption_segment_effective_end(segment) {
            continue;
        }
        if let Some(display) = caption_display_segment(segment, hide_fillers)
            && time >= display.start
            && time < caption_segment_effective_end(&display)
        {
            return Some(ActiveCaptionSegment { segment: display });
        }
    }

    for segment in segments {
        let fade = segment
            .fade_duration_override
            .unwrap_or(default_fade_duration) as f64;
        let raw_end = caption_segment_effective_end(segment);
        if time < segment.start.min(raw_end) || time >= raw_end + fade {
            continue;
        }
        if let Some(display) = caption_display_segment(segment, hide_fillers) {
            let effective_end = caption_segment_effective_end(&display);
            if time >= effective_end && time < effective_end + fade {
                return Some(ActiveCaptionSegment { segment: display });
            }
        }
    }

    None
}

fn calculate_caption_fade(current_time: f64, start: f64, end: f64, fade_duration: f64) -> f32 {
    if fade_duration <= 0.0 {
        if current_time >= start && current_time < end {
            return 1.0;
        }
        return 0.0;
    }

    let time_from_start = current_time - start;
    let time_to_end = end - current_time;

    let fade_in = (time_from_start / fade_duration).clamp(0.0, 1.0) as f32;

    let fade_out = if time_to_end >= 0.0 {
        1.0
    } else {
        let past_end = -time_to_end;
        (1.0 - past_end / fade_duration).clamp(0.0, 1.0) as f32
    };

    fade_in.min(fade_out)
}

fn calculate_caption_bounce(current_time: f64, start: f64, end: f64, fade_duration: f64) -> f64 {
    if fade_duration <= 0.0 {
        return 0.0;
    }

    let time_from_start = current_time - start;
    let time_to_end = end - current_time;

    let fade_in_progress = (time_from_start / fade_duration).clamp(0.0, 1.0);
    let fade_out_progress = (time_to_end / fade_duration).clamp(0.0, 1.0);

    if fade_in_progress < 1.0 {
        let ease = 1.0 - fade_in_progress;
        -(ease * ease) * BOUNCE_OFFSET_PIXELS as f64
    } else if fade_out_progress < 1.0 {
        let ease = 1.0 - fade_out_progress;
        (ease * ease) * BOUNCE_OFFSET_PIXELS as f64
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CaptionFrameBox, CaptionPosition, caption_box_origin, caption_center,
        caption_segment_effective_end, find_active_caption_segment, find_active_word_index,
        word_byte_range,
    };
    use cap_project::{CaptionTrackSegment, CaptionWord, XY};

    #[test]
    fn a_zero_text_size_has_no_font_size() {
        use super::scaled_font_size;
        assert_eq!(scaled_font_size(0, 1080), None);
        assert_eq!(scaled_font_size(48, 0), None);
        for height in [90, 288, 720, 1080, 2160] {
            for size in [1, 12, 48, 100, 300] {
                assert_eq!(
                    scaled_font_size(size, height).map(f32::to_bits),
                    Some((size as f32 * (height as f32 / 1080.0)).to_bits()),
                    "{size} at {height}"
                );
            }
        }
    }

    #[test]
    fn caption_glyphs_fit_the_content_box_in_both_directions() {
        use super::{CaptionTextColors, ShapedCaptionText, caption_text_left, shape_caption_text};
        use glyphon::{Color, Family, Weight};

        let mut fonts = super::super::new_font_system();
        for text in [
            "سلام دنیا این یک متن آزمایشی است",
            "مرحبا بالعالم",
            "سلام Cap 123 دنیا",
            "Hello world",
        ] {
            for wrap_width in [80.0_f32, 1800.0] {
                for colors in [
                    CaptionTextColors::Uniform(Color::rgb(255, 255, 255)),
                    CaptionTextColors::Spans(vec![(0..text.len(), Color::rgb(255, 200, 0))]),
                ] {
                    let buffer = shape_caption_text(
                        &mut fonts,
                        &ShapedCaptionText {
                            text: text.to_string(),
                            font_size: 48.0_f32.to_bits(),
                            wrap_width: wrap_width.to_bits(),
                            family: Family::SansSerif,
                            weight: Weight::BOLD,
                            colors,
                        },
                    );
                    let runs = buffer.layout_runs().collect::<Vec<_>>();
                    assert_eq!(runs.len(), 1);
                    assert!(!runs[0].glyphs.is_empty());
                    assert!(runs[0].glyphs.iter().all(|glyph| glyph.glyph_id != 0));
                    let width = runs[0].line_w;
                    for scale in [0.35, 0.72, 1.0, 1.08] {
                        let content_left = 200.0;
                        let left = caption_text_left(&buffer, content_left, scale);
                        if text == "Hello world" {
                            assert_eq!(left, content_left);
                        }
                        let mut min_x = f32::INFINITY;
                        for glyph in runs[0].glyphs {
                            let x = left + glyph.x * scale;
                            min_x = min_x.min(x);
                            assert!(x >= content_left - 0.001, "{text}: {x}");
                            assert!(
                                x + glyph.w * scale <= content_left + width * scale + 0.001,
                                "{text}: {x}"
                            );
                        }
                        assert!((min_x - content_left).abs() < 0.001, "{text}: {min_x}");
                    }
                }
            }
        }
    }

    fn segment(start: f64, end: f64, words: Vec<CaptionWord>) -> CaptionTrackSegment {
        CaptionTrackSegment {
            id: "seg".to_string(),
            start,
            end,
            text: "text".to_string(),
            words,
            fade_duration_override: None,
            linger_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
        }
    }

    fn word(start: f32, end: f32) -> CaptionWord {
        CaptionWord {
            text: "word".to_string(),
            start,
            end,
        }
    }

    /// The caption box for a 24 px caption at 1080p is about this size; the
    /// renderer scales the font with the frame height.
    fn box_at(frame: (f32, f32)) -> (f32, f32) {
        let scale = frame.1 / 1080.0;
        (520.0 * scale, 60.0 * scale)
    }

    fn normalised_center(
        position: CaptionPosition,
        manual: Option<XY<f32>>,
        frame: (f32, f32),
    ) -> (f32, f32) {
        let size = box_at(frame);
        let (left, top) = caption_box_origin(position, manual, size, frame);
        (
            (left + size.0 / 2.0) / frame.0,
            (top + size.1 / 2.0) / frame.1,
        )
    }

    /// A stored manual centre is a fraction of the output frame, so the same
    /// project places its captions at the same spot at every export size.
    #[test]
    fn a_manual_caption_lands_on_the_same_fraction_at_every_resolution() {
        let spots = [XY::new(0.5, 0.5), XY::new(0.3, 0.2), XY::new(0.62, 0.9)];
        for aspect in [
            [(1280.0, 720.0), (1920.0, 1080.0), (3840.0, 2160.0)],
            [(720.0, 1280.0), (1080.0, 1920.0), (2160.0, 3840.0)],
            [(720.0, 720.0), (1080.0, 1080.0), (2160.0, 2160.0)],
        ] {
            for spot in spots {
                let centers = aspect
                    .map(|frame| normalised_center(CaptionPosition::Manual, Some(spot), frame));
                for center in centers {
                    assert!(
                        (center.0 - centers[0].0).abs() < 1e-5,
                        "{aspect:?} {spot:?}"
                    );
                    assert!(
                        (center.1 - centers[0].1).abs() < 1e-5,
                        "{aspect:?} {spot:?}"
                    );
                }
            }
        }
        let center = normalised_center(
            CaptionPosition::Manual,
            Some(XY::new(0.3, 0.2)),
            (1920.0, 1080.0),
        );
        assert!((center.0 - 0.3).abs() < 1e-6);
        assert!((center.1 - 0.2).abs() < 1e-6);
    }

    /// A centre near an edge keeps the whole box in the frame, in every
    /// aspect, rather than cutting the caption off.
    #[test]
    fn a_manual_caption_near_an_edge_stays_inside_the_frame() {
        for frame in [(1920.0, 1080.0), (1080.0, 1920.0), (1440.0, 1080.0)] {
            let size = box_at(frame);
            for spot in [
                XY::new(0.0, 0.0),
                XY::new(1.0, 1.0),
                XY::new(0.0, 1.0),
                XY::new(-3.0, 7.0),
            ] {
                let (left, top) =
                    caption_box_origin(CaptionPosition::Manual, Some(spot), size, frame);
                assert!(
                    left >= 0.0 && left + size.0 <= frame.0 + 1e-3,
                    "{frame:?} {spot:?}"
                );
                assert!(
                    top >= 0.0 && top + size.1 <= frame.1 + 1e-3,
                    "{frame:?} {spot:?}"
                );
            }
        }
    }

    /// The presets are unchanged by manual placement: a stored manual centre
    /// does nothing until the position is Manual, and Manual without one is
    /// the bottom-centre spot.
    #[test]
    fn presets_ignore_the_manual_centre() {
        let frame = (1920.0, 1080.0);
        let size = (400.0, 80.0);
        let manual = Some(XY::new(0.1, 0.1));
        let expected = [
            (CaptionPosition::TopLeft, (96.0, 1080.0 * 0.08 - 40.0)),
            (CaptionPosition::TopCenter, (760.0, 1080.0 * 0.08 - 40.0)),
            (CaptionPosition::TopRight, (1424.0, 1080.0 * 0.08 - 40.0)),
            (CaptionPosition::BottomLeft, (96.0, 1080.0 * 0.85 - 40.0)),
            (CaptionPosition::BottomCenter, (760.0, 1080.0 * 0.85 - 40.0)),
            (CaptionPosition::BottomRight, (1424.0, 1080.0 * 0.85 - 40.0)),
        ];
        for (position, origin) in expected {
            assert_eq!(caption_box_origin(position, manual, size, frame), origin);
            assert_eq!(caption_box_origin(position, None, size, frame), origin);
        }
        assert_eq!(
            caption_box_origin(CaptionPosition::Manual, None, size, frame),
            caption_box_origin(CaptionPosition::BottomCenter, None, size, frame)
        );
    }

    #[test]
    fn the_frame_box_knows_its_placement() {
        let manual = CaptionFrameBox::new([0.0, 0.0, 10.0, 10.0], "manual");
        assert!(manual.is_manual());
        assert!(manual.is_at("manual"));
        let preset = CaptionFrameBox::new([0.0, 0.0, 10.0, 10.0], "top");
        assert!(!preset.is_manual());
        assert!(preset.is_at("top-center"));
        assert!(!preset.is_at("bottom-center"));
    }

    /// A 400 px box against the 96 px left margin of a 1920 px frame is
    /// centred at 296 px, not at the 5% the preset table names.
    #[test]
    fn the_drawn_caption_centre_is_a_fraction_of_the_frame() {
        let center = caption_center([96.0, 900.0, 400.0, 80.0], (1920, 1080)).unwrap();
        assert!((center[0] - 296.0 / 1920.0).abs() < 1e-6);
        assert!((center[1] - 940.0 / 1080.0).abs() < 1e-6);
        assert!(caption_center([0.0, 0.0, 10.0, 10.0], (0, 1080)).is_none());
        assert_eq!(
            caption_center([1900.0, 0.0, 400.0, 10.0], (1920, 1080)).map(|c| c[0]),
            Some(1.0)
        );
    }

    #[test]
    fn effective_end_clamps_inflated_trailing_word() {
        let seg = segment(36.1, 42.31, vec![word(36.1, 42.31)]);
        assert!(
            (caption_segment_effective_end(&seg) - (36.1 + super::MAX_CAPTION_WORD_DURATION)).abs()
                < 1e-4
        );
    }

    #[test]
    fn effective_end_preserves_normal_segments() {
        let seg = segment(10.0, 11.5, vec![word(10.0, 10.4), word(10.4, 11.5)]);
        assert!((caption_segment_effective_end(&seg) - 11.5).abs() < 1e-4);
    }

    #[test]
    fn hidden_fillers_do_not_show_or_hold_a_caption() {
        let mut seg = segment(
            1.0,
            3.2,
            vec![
                word(1.0, 1.4),
                word(1.6, 1.9),
                word(1.9, 2.4),
                word(2.8, 3.2),
            ],
        );
        for (word, text) in seg.words.iter_mut().zip(["Um,", "we", "ship", "uh."]) {
            word.text = text.to_string();
        }
        seg.text = "Um, we ship uh.".to_string();
        let segments = vec![seg];

        assert!(find_active_caption_segment(1.2, &segments, 0.0, true).is_none());
        assert!(find_active_caption_segment(3.0, &segments, 0.0, true).is_none());
        let active = find_active_caption_segment(1.7, &segments, 0.0, true).unwrap();
        assert_eq!(active.segment.text, "we ship");
        assert_eq!(active.segment.words.len(), 2);
        assert!((caption_segment_effective_end(&active.segment) - 2.4).abs() < 1e-6);
        let lingering = find_active_caption_segment(2.5, &segments, 0.2, true).unwrap();
        assert_eq!(lingering.segment.text, "we ship");

        let verbatim = find_active_caption_segment(1.2, &segments, 0.0, false).unwrap();
        assert_eq!(verbatim.segment.text, "Um, we ship uh.");
        assert!(find_active_caption_segment(3.0, &segments, 0.0, false).is_some());
    }

    #[test]
    fn inflated_caption_does_not_stay_active_after_clamp() {
        let segments = vec![segment(36.1, 42.31, vec![word(36.1, 42.31)])];
        // Well within the original (bloated) end, but past the clamped end.
        assert!(find_active_caption_segment(41.0, &segments, 0.2, true).is_none());
        // Still active while the (capped) word is on screen.
        assert!(find_active_caption_segment(37.0, &segments, 0.2, true).is_some());
    }

    #[test]
    fn active_word_selection_preserves_boundaries_and_gaps() {
        let words = [word(0.1, 0.4), word(0.5, 0.9)];

        for (time, expected) in [
            (-0.1, 0),
            (0.1, 0),
            (0.4, 0),
            (0.49, 0),
            (0.5, 1),
            (0.9, 1),
            (1.2, 1),
        ] {
            assert_eq!(find_active_word_index(time, &words), Some(expected));
        }
        assert_eq!(find_active_word_index(0.5, &[]), None);
    }

    #[test]
    fn word_ranges_preserve_repeated_words_and_unicode_uppercase() {
        let words = ["ŉ", "Straße", "ŉ"].map(|text| CaptionWord {
            text: text.to_string(),
            start: 0.0,
            end: 1.0,
        });
        let text = "ŉ Straße ŉ";

        for (index, expected) in [(0, (0, 2)), (1, (3, 10)), (2, (11, 13))] {
            assert_eq!(word_byte_range(text, &words, index, false), Some(expected));
        }
        for (index, expected) in [(0, (0, 3)), (1, (4, 11)), (2, (12, 15))] {
            assert_eq!(
                word_byte_range(&text.to_uppercase(), &words, index, true),
                Some(expected)
            );
        }
        assert_eq!(word_byte_range(text, &words, 3, false), None);
        assert_eq!(word_byte_range("missing", &words, 0, false), None);
    }
}

#[cfg(test)]
mod shaping_tests {
    use cap_project::CaptionWord;
    use glyphon::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, Weight};

    use super::{
        BASE_TEXT_OPACITY, CaptionText, CaptionTextColors, ShapedCaptionText, WordHighlight,
        calculate_caption_fade, calculate_word_highlight, caption_rgba, word_highlight_spans,
    };

    const FPS: f32 = 60.0;
    const FADE: f64 = 0.15;

    fn spoken_words(sentence: &str, start: f32) -> Vec<CaptionWord> {
        sentence
            .split_whitespace()
            .enumerate()
            .map(|(index, text)| CaptionWord {
                text: text.to_string(),
                start: start + index as f32 * 0.3,
                end: start + index as f32 * 0.3 + 0.25,
            })
            .collect()
    }

    struct Frame<'a> {
        text: String,
        words: &'a [CaptionWord],
        uppercase: bool,
        current_time: f32,
        highlight: WordHighlight,
        font_size: f32,
        wrap_width: f32,
        family: Family<'static>,
        weight: Weight,
    }

    impl Frame<'_> {
        fn key(&self) -> ShapedCaptionText {
            ShapedCaptionText {
                text: self.text.clone(),
                font_size: self.font_size.to_bits(),
                wrap_width: self.wrap_width.to_bits(),
                family: self.family,
                weight: self.weight,
                colors: CaptionTextColors::Spans(word_highlight_spans(
                    &self.text,
                    self.words,
                    self.uppercase,
                    self.current_time,
                    &self.highlight,
                )),
            }
        }

        fn uncached_buffer(&self, font_system: &mut FontSystem) -> Buffer {
            let WordHighlight {
                base_rgb: base_color,
                highlight_rgb: highlight_color_rgb,
                base_alpha,
                highlight_alpha,
                transition_duration: word_transition_duration,
            } = self.highlight;
            let (font_family, weight, font_size) = (self.family, self.weight, self.font_size);
            let mut rich_text: Vec<(&str, Attrs)> = Vec::new();
            let full_text = self.text.as_str();
            let mut last_end = 0usize;

            for (idx, word) in self.words.iter().enumerate() {
                let needle = if self.uppercase {
                    word.text.to_uppercase()
                } else {
                    word.text.clone()
                };
                if let Some(start_pos) = full_text.get(last_end..).and_then(|s| s.find(&needle)) {
                    let abs_start = last_end + start_pos;

                    if abs_start > last_end {
                        let space = &full_text[last_end..abs_start];
                        rich_text.push((
                            space,
                            Attrs::new()
                                .family(font_family)
                                .weight(weight)
                                .color(Color::rgba(
                                    (base_color[0] * 255.0) as u8,
                                    (base_color[1] * 255.0) as u8,
                                    (base_color[2] * 255.0) as u8,
                                    (base_alpha * 255.0) as u8,
                                )),
                        ));
                    }

                    let word_highlight = calculate_word_highlight(
                        self.current_time,
                        word,
                        idx,
                        self.words,
                        word_transition_duration,
                    );

                    let blended_color = [
                        base_color[0] + (highlight_color_rgb[0] - base_color[0]) * word_highlight,
                        base_color[1] + (highlight_color_rgb[1] - base_color[1]) * word_highlight,
                        base_color[2] + (highlight_color_rgb[2] - base_color[2]) * word_highlight,
                    ];

                    let blended_alpha =
                        base_alpha + (highlight_alpha - base_alpha) * word_highlight;

                    let word_end = abs_start + needle.len();
                    rich_text.push((
                        &full_text[abs_start..word_end],
                        Attrs::new()
                            .family(font_family)
                            .weight(weight)
                            .color(Color::rgba(
                                (blended_color[0] * 255.0) as u8,
                                (blended_color[1] * 255.0) as u8,
                                (blended_color[2] * 255.0) as u8,
                                (blended_alpha * 255.0) as u8,
                            )),
                    ));
                    last_end = word_end;
                }
            }

            if last_end < full_text.len() {
                rich_text.push((
                    &full_text[last_end..],
                    Attrs::new()
                        .family(font_family)
                        .weight(weight)
                        .color(Color::rgba(
                            (base_color[0] * 255.0) as u8,
                            (base_color[1] * 255.0) as u8,
                            (base_color[2] * 255.0) as u8,
                            (base_alpha * 255.0) as u8,
                        )),
                ));
            }

            let mut buffer = Buffer::new(font_system, Metrics::new(font_size, font_size * 1.2));
            buffer.set_size(font_system, Some(self.wrap_width), None);
            buffer.set_wrap(font_system, glyphon::Wrap::None);
            buffer.set_rich_text(
                font_system,
                rich_text,
                &Attrs::new().family(font_family).weight(weight),
                Shaping::Advanced,
                None,
            );
            buffer
        }
    }

    fn glyphs(buffer: &Buffer) -> Vec<String> {
        buffer
            .layout_runs()
            .flat_map(|run| {
                std::iter::once(format!(
                    "line {} y {} top {} height {} width {}",
                    run.line_i, run.line_y, run.line_top, run.line_height, run.line_w
                ))
                .chain(run.glyphs.iter().map(|glyph| format!("{glyph:?}")))
            })
            .collect()
    }

    fn highlight(
        highlight_rgb: [f32; 3],
        transition_duration: f32,
        fade_opacity: f32,
    ) -> WordHighlight {
        WordHighlight {
            base_rgb: [1.0, 1.0, 1.0],
            highlight_rgb,
            base_alpha: (fade_opacity * BASE_TEXT_OPACITY).clamp(0.0, 1.0),
            highlight_alpha: fade_opacity.clamp(0.0, 1.0),
            transition_duration,
        }
    }

    #[test]
    fn cached_word_highlight_layout_matches_an_uncached_shape_every_frame() {
        let mut cached_fonts = super::super::new_font_system();
        let mut uncached_fonts = super::super::new_font_system();
        let sentence = "Ship it today, then share the link with Straße ŉ everyone";
        let words = spoken_words(sentence, 0.3);
        let start = f64::from(words[0].start);
        let end = f64::from(words.last().unwrap().end);
        let variants = [
            (false, [1.0, 1.0, 1.0], 0.25),
            (true, [1.0, 0.843, 0.0], 0.1),
            (false, [0.2, 0.6, 1.0], 0.0),
        ];

        for (uppercase, highlight_rgb, transition_duration) in variants {
            let text = if uppercase {
                sentence.to_uppercase()
            } else {
                sentence.to_string()
            };
            let mut cache = CaptionText::new();
            let (mut reshapes, mut visible_frames) = (0, 0);
            let mut distinct_layouts = Vec::new();
            for frame in 0..((end + FADE + 0.2) * f64::from(FPS)) as u32 {
                let current_time = f64::from(frame) / f64::from(FPS);
                let fade_opacity = calculate_caption_fade(current_time, start, end, FADE);
                if fade_opacity <= 0.0 {
                    continue;
                }
                visible_frames += 1;
                let width = [1920.0, 1280.0, 640.0][(frame / 45) as usize % 3];
                let font_size = 48.0;
                let inputs = Frame {
                    text: text.clone(),
                    words: &words,
                    uppercase,
                    current_time: current_time as f32,
                    highlight: highlight(highlight_rgb, transition_duration, fade_opacity),
                    font_size,
                    wrap_width: (width - width * 0.1_f32).max(font_size),
                    family: Family::SansSerif,
                    weight: Weight::BOLD,
                };

                reshapes += usize::from(cache.update(&mut cached_fonts, inputs.key()));
                let expected = glyphs(&inputs.uncached_buffer(&mut uncached_fonts));
                assert_eq!(
                    glyphs(&cache.buffer),
                    expected,
                    "uppercase {uppercase}, transition {transition_duration}, time {current_time}"
                );
                if !distinct_layouts.contains(&expected) {
                    distinct_layouts.push(expected);
                }
            }

            assert!(distinct_layouts.len() > 2);
            assert!(reshapes >= distinct_layouts.len());
            assert!(
                reshapes < visible_frames,
                "{reshapes} reshapes for {visible_frames} frames"
            );
        }
    }

    #[test]
    fn word_highlight_cache_reshapes_when_any_layout_input_changes() {
        let mut cached_fonts = super::super::new_font_system();
        let mut uncached_fonts = super::super::new_font_system();
        let sentence = "Ship it today then share the link";
        let words = spoken_words(sentence, 0.0);
        let other_words = spoken_words("Ship it now then share the link", 0.0);
        let base = || Frame {
            text: sentence.to_string(),
            words: &words,
            uppercase: false,
            current_time: 0.35,
            highlight: highlight([1.0, 0.843, 0.0], 0.25, 1.0),
            font_size: 48.0,
            wrap_width: 1728.0,
            family: Family::SansSerif,
            weight: Weight::BOLD,
        };
        let mutations = [
            (
                "text",
                Frame {
                    text: "Ship it now then share the link".to_string(),
                    words: &other_words,
                    ..base()
                },
            ),
            (
                "uppercase",
                Frame {
                    text: sentence.to_uppercase(),
                    uppercase: true,
                    ..base()
                },
            ),
            (
                "font size",
                Frame {
                    font_size: 60.0,
                    ..base()
                },
            ),
            (
                "wrap width",
                Frame {
                    wrap_width: 1152.0,
                    ..base()
                },
            ),
            (
                "font family",
                Frame {
                    family: Family::Monospace,
                    ..base()
                },
            ),
            (
                "font weight",
                Frame {
                    weight: Weight::NORMAL,
                    ..base()
                },
            ),
            (
                "highlight color",
                Frame {
                    highlight: highlight([0.0, 1.0, 0.0], 0.25, 1.0),
                    ..base()
                },
            ),
            (
                "transition duration",
                Frame {
                    highlight: highlight([1.0, 0.843, 0.0], 0.5, 1.0),
                    ..base()
                },
            ),
            (
                "active word",
                Frame {
                    current_time: 0.65,
                    ..base()
                },
            ),
            (
                "caption fade",
                Frame {
                    highlight: highlight([1.0, 0.843, 0.0], 0.25, 0.5),
                    ..base()
                },
            ),
        ];

        for (name, changed) in mutations {
            let mut cache = CaptionText::new();
            assert!(cache.update(&mut cached_fonts, base().key()));
            assert!(
                !cache.update(&mut cached_fonts, base().key()),
                "{name}: identical inputs reshaped"
            );
            assert!(
                cache.update(&mut cached_fonts, changed.key()),
                "{name}: the cached layout was reused"
            );
            assert_eq!(
                glyphs(&cache.buffer),
                glyphs(&changed.uncached_buffer(&mut uncached_fonts)),
                "{name}"
            );
        }

        let mut cache = CaptionText::new();
        let plain = |color: Color| ShapedCaptionText {
            colors: CaptionTextColors::Uniform(color),
            ..base().key()
        };
        let white = caption_rgba([1.0, 1.0, 1.0], 1.0);
        assert!(cache.update(&mut cached_fonts, plain(white)));
        assert!(!cache.update(&mut cached_fonts, plain(white)));
        assert!(cache.update(&mut cached_fonts, base().key()));
        assert!(cache.update(&mut cached_fonts, plain(white)));
        assert!(cache.update(&mut cached_fonts, plain(caption_rgba([1.0, 1.0, 1.0], 0.5))));
    }
}

#[cfg(test)]
mod gpu_tests {
    use cap_project::{
        CaptionSettings, CaptionTrackSegment, CaptionWord, CaptionsData, CursorEvents,
        ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
        TimelineConfiguration, XY,
    };

    use super::CaptionsLayer;
    use crate::{
        DecodedSegmentFrames, ProjectUniforms, RenderOptions, RenderVideoConstants,
        ZoomTransformTimeline,
    };

    const FPS: u32 = 60;

    fn constants(size: XY<u32>) -> RenderVideoConstants {
        let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "display": { "path": "synthetic.mp4", "fps": FPS }
        }))
        .unwrap();
        let recording = RecordingMeta {
            platform: None,
            project_path: Default::default(),
            pretty_name: "Caption overlay test".into(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(meta.clone())),
            upload: None,
        };
        pollster::block_on(RenderVideoConstants::new_with_options(
            RenderOptions {
                screen_size: size,
                camera_size: None,
                preserve_screen_alpha: false,
            },
            recording,
            meta,
        ))
        .unwrap()
    }

    fn spoken_segments(sentences: &[&str]) -> Vec<CaptionTrackSegment> {
        let mut start = 0.3;
        sentences
            .iter()
            .enumerate()
            .map(|(index, sentence)| {
                let words = sentence
                    .split_whitespace()
                    .enumerate()
                    .map(|(word_index, text)| CaptionWord {
                        text: text.to_string(),
                        start: start as f32 + word_index as f32 * 0.3,
                        end: start as f32 + word_index as f32 * 0.3 + 0.25,
                    })
                    .collect::<Vec<_>>();
                let end = f64::from(words.last().map_or(start as f32, |word| word.end));
                let segment = CaptionTrackSegment {
                    id: format!("caption-{index}"),
                    start,
                    end,
                    text: sentence.to_string(),
                    words,
                    fade_duration_override: None,
                    linger_duration_override: None,
                    position_override: None,
                    color_override: None,
                    background_color_override: None,
                    font_size_override: None,
                };
                start = end + 0.4;
                segment
            })
            .collect()
    }

    fn frames(size: XY<u32>) -> DecodedSegmentFrames {
        DecodedSegmentFrames {
            screen_size: size,
            screen_frame: None,
            camera_frame: None,
            segment_time: 0.0,
            recording_time: 0.0,
            segment_has_camera: false,
        }
    }

    fn uniforms(
        constants: &RenderVideoConstants,
        settings: CaptionSettings,
        segments: &[CaptionTrackSegment],
        size: XY<u32>,
    ) -> ProjectUniforms {
        let project = ProjectConfiguration::default();
        let cursor = CursorEvents::default();
        let frames = frames(size);
        let mut zoom = ZoomTransformTimeline::from_project(&project, &cursor, 60.0, size);
        zoom.ensure_precomputed_until(60.0);
        let mut uniforms = ProjectUniforms::new(
            constants,
            &std::sync::Arc::new(project),
            0,
            FPS,
            size,
            &cursor,
            &frames,
            60.0,
            &zoom,
        );
        uniforms.output_size = (size.x, size.y);
        std::sync::Arc::make_mut(&mut uniforms.project).captions = Some(CaptionsData {
            segments: vec![],
            settings,
            source_timed: false,
        });
        std::sync::Arc::make_mut(&mut uniforms.project).timeline = Some(TimelineConfiguration {
            segments: vec![],
            transitions: vec![],
            zoom_segments: vec![],
            scene_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: segments.to_vec(),
            keyboard_segments: vec![],
            audio_segments: vec![],
            style_segments: vec![],
            image_segments: vec![],
            shape_segments: Vec::new(),
            camera3d_segments: vec![],
        });
        uniforms
    }

    fn render_pixels(
        constants: &RenderVideoConstants,
        layer: &CaptionsLayer,
        size: XY<u32>,
    ) -> Vec<u8> {
        let device = &constants.device;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Caption Test Target"),
            size: wgpu::Extent3d {
                width: size.x,
                height: size.y,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Caption Test Readback"),
            size: u64::from(size.x * size.y * 4),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Caption Test Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            layer.render(&mut pass);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(size.x * 4),
                    rows_per_image: Some(size.y),
                },
            },
            wgpu::Extent3d {
                width: size.x,
                height: size.y,
                depth_or_array_layers: 1,
            },
        );
        constants.queue.submit([encoder.finish()]);
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::Wait).unwrap();
        let pixels = readback.slice(..).get_mapped_range().to_vec();
        readback.unmap();
        pixels
    }

    /// A caption size of 0 draws nothing; cosmic-text asserts on the zero
    /// line height it would give.
    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn a_zero_size_caption_draws_nothing() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let decoded = frames(size);
        let segments = spoken_segments(&["hello world"]);
        for (caption_size, drawn) in [(60, true), (0, false)] {
            let settings = CaptionSettings {
                enabled: true,
                size: caption_size,
                ..Default::default()
            };
            let mut uniforms = uniforms(&constants, settings, &segments, size);
            uniforms.frame_number = 30;
            let mut layer = CaptionsLayer::new(&constants.device, &constants.queue);
            layer.prepare(&uniforms, &decoded, size, &constants);
            assert_eq!(layer.has_caption, drawn, "size {caption_size}");
        }
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn rtl_caption_ink_stays_inside_its_background() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let decoded = frames(size);
        for sentence in ["سلام دنیا", "مرحبا بالعالم"] {
            let segments = spoken_segments(&[sentence]);
            for highlight_style in ["none", "pill", "color"] {
                let settings = CaptionSettings {
                    enabled: true,
                    size: 60,
                    active_word_highlight: highlight_style != "none",
                    highlight_style: highlight_style.to_string(),
                    background_opacity: 100,
                    ..Default::default()
                };
                let mut uniforms = uniforms(&constants, settings, &segments, size);
                uniforms.frame_number = 30;
                let mut layer = CaptionsLayer::new(&constants.device, &constants.queue);
                layer.prepare(&uniforms, &decoded, size, &constants);
                assert!(layer.has_caption);
                let [left, top, right, bottom] = layer.frame_box.unwrap().bounds;
                let pixels = render_pixels(&constants, &layer, size);
                let mut ink = 0;
                for (index, pixel) in pixels.chunks_exact(4).enumerate() {
                    if pixel[0] > 100 && pixel[1] > 100 && pixel[2] > 100 {
                        ink += 1;
                        let x = (index % size.x as usize) as f32;
                        let y = (index / size.x as usize) as f32;
                        assert!(x >= left && x < right && y >= top && y < bottom);
                    }
                }
                assert!(
                    ink > 20,
                    "{sentence} ({highlight_style}) has no visible glyphs"
                );
            }
        }
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn every_caption_frame_renders_like_a_fresh_layer() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let segments = spoken_segments(&["Hello there", "Ship it today"]);
        let frames = frames(size);
        let enabled = CaptionSettings {
            enabled: true,
            size: 60,
            ..Default::default()
        };
        let variants = [
            enabled.clone(),
            CaptionSettings {
                outline: true,
                uppercase: true,
                animation: "pop".to_string(),
                ..enabled.clone()
            },
            CaptionSettings {
                active_word_highlight: true,
                highlight_style: "pill".to_string(),
                ..enabled.clone()
            },
            CaptionSettings {
                active_word_highlight: true,
                ..enabled.clone()
            },
            CaptionSettings {
                active_word_highlight: true,
                highlight_color: "#FFD700".to_string(),
                outline: true,
                uppercase: true,
                animation: "pop".to_string(),
                ..enabled.clone()
            },
            CaptionSettings {
                active_word_highlight: true,
                highlight_color: "#3399FF".to_string(),
                word_transition_duration: 0.0,
                fade_duration: 0.4,
                ..enabled
            },
        ];
        let last_frame = (segments.last().unwrap().end + 0.3) * f64::from(FPS);
        for settings in variants {
            let mut uniforms = uniforms(&constants, settings, &segments, size);
            let mut reused = CaptionsLayer::new(&constants.device, &constants.queue);
            let mut drawn_frames = 0;
            for frame in 0..last_frame as u32 {
                uniforms.frame_number = frame;
                reused.prepare(&uniforms, &frames, size, &constants);
                let mut fresh = CaptionsLayer::new(&constants.device, &constants.queue);
                fresh.prepare(&uniforms, &frames, size, &constants);
                assert_eq!(reused.has_caption, fresh.has_caption, "frame {frame}");
                let pixels = render_pixels(&constants, &reused, size);
                assert_eq!(
                    pixels,
                    render_pixels(&constants, &fresh, size),
                    "frame {frame}"
                );
                drawn_frames += usize::from(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0));
            }
            assert!(drawn_frames > 60);
        }
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn reused_layer_follows_style_and_output_size_changes() {
        let base_size = XY::new(512, 288);
        let constants = constants(base_size);
        let segments = spoken_segments(&["Ship it today"]);
        let frames = frames(base_size);
        let render = |layer: &mut CaptionsLayer, settings: &CaptionSettings, size: XY<u32>| {
            let mut uniforms = uniforms(&constants, settings.clone(), &segments, size);
            uniforms.frame_number = 45;
            layer.prepare(&uniforms, &frames, size, &constants);
            assert!(layer.has_caption);
            render_pixels(&constants, layer, size)
        };
        let plain = CaptionSettings {
            enabled: true,
            size: 60,
            ..Default::default()
        };
        let color_highlight = CaptionSettings {
            active_word_highlight: true,
            highlight_color: "#FF0000".to_string(),
            ..plain.clone()
        };
        let cases = [
            (
                "font size",
                plain.clone(),
                CaptionSettings {
                    size: 80,
                    ..plain.clone()
                },
                base_size,
            ),
            (
                "font family",
                plain.clone(),
                CaptionSettings {
                    font: "System Monospace".to_string(),
                    ..plain.clone()
                },
                base_size,
            ),
            (
                "font weight",
                plain.clone(),
                CaptionSettings {
                    font_weight: 400,
                    ..plain.clone()
                },
                base_size,
            ),
            (
                "text color",
                plain.clone(),
                CaptionSettings {
                    color: "#FF0000".to_string(),
                    ..plain.clone()
                },
                base_size,
            ),
            (
                "output height",
                plain.clone(),
                plain.clone(),
                XY::new(512, 216),
            ),
            (
                "output width",
                plain.clone(),
                plain.clone(),
                XY::new(384, 288),
            ),
            (
                "plain to color highlight",
                plain.clone(),
                color_highlight.clone(),
                base_size,
            ),
            (
                "color highlight to plain",
                color_highlight.clone(),
                plain.clone(),
                base_size,
            ),
            (
                "highlighted font size",
                color_highlight.clone(),
                CaptionSettings {
                    size: 80,
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "highlighted font family",
                color_highlight.clone(),
                CaptionSettings {
                    font: "System Monospace".to_string(),
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "highlighted font weight",
                color_highlight.clone(),
                CaptionSettings {
                    font_weight: 400,
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "highlighted uppercase",
                color_highlight.clone(),
                CaptionSettings {
                    uppercase: true,
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "highlight color",
                color_highlight.clone(),
                CaptionSettings {
                    highlight_color: "#00FF00".to_string(),
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "base color under highlight",
                color_highlight.clone(),
                CaptionSettings {
                    color: "#00FFFF".to_string(),
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "word transition",
                color_highlight.clone(),
                CaptionSettings {
                    word_transition_duration: 0.0,
                    ..color_highlight.clone()
                },
                base_size,
            ),
            (
                "highlighted output height",
                color_highlight.clone(),
                color_highlight.clone(),
                XY::new(512, 216),
            ),
            (
                "highlighted output width",
                color_highlight.clone(),
                color_highlight.clone(),
                XY::new(384, 288),
            ),
        ];

        for (name, before, after, size) in cases {
            let expected = render(
                &mut CaptionsLayer::new(&constants.device, &constants.queue),
                &after,
                size,
            );
            let previous = render(
                &mut CaptionsLayer::new(&constants.device, &constants.queue),
                &before,
                base_size,
            );
            assert!(expected != previous, "{name} edit should change the output");

            let mut reused = CaptionsLayer::new(&constants.device, &constants.queue);
            render(&mut reused, &before, base_size);
            assert!(
                render(&mut reused, &after, size) == expected,
                "{name} edit reused a stale layout"
            );
        }

        let mut reused = CaptionsLayer::new(&constants.device, &constants.queue);
        render(&mut reused, &plain, base_size);
        render(&mut reused, &color_highlight, base_size);
        let expected = render(
            &mut CaptionsLayer::new(&constants.device, &constants.queue),
            &plain,
            base_size,
        );
        assert!(
            render(&mut reused, &plain, base_size) == expected,
            "returning to plain text reused the highlighted layout"
        );
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn highlighted_frames_follow_output_size_changes_like_a_fresh_layer() {
        let sizes = [XY::new(512, 288), XY::new(384, 288), XY::new(512, 216)];
        let constants = constants(sizes[0]);
        let segments = spoken_segments(&["Hello there", "Ship it today"]);
        let settings = CaptionSettings {
            enabled: true,
            size: 60,
            active_word_highlight: true,
            highlight_color: "#FFD700".to_string(),
            ..Default::default()
        };
        let last_frame = ((segments.last().unwrap().end + 0.3) * f64::from(FPS)) as u32;
        let mut reused = CaptionsLayer::new(&constants.device, &constants.queue);
        let mut drawn_frames = 0;
        for frame in 0..last_frame {
            let size = sizes[(frame / 7) as usize % sizes.len()];
            let decoded = frames(size);
            let mut uniforms = uniforms(&constants, settings.clone(), &segments, size);
            uniforms.frame_number = frame;
            reused.prepare(&uniforms, &decoded, size, &constants);
            let mut fresh = CaptionsLayer::new(&constants.device, &constants.queue);
            fresh.prepare(&uniforms, &decoded, size, &constants);
            assert_eq!(reused.has_caption, fresh.has_caption, "frame {frame}");
            let pixels = render_pixels(&constants, &reused, size);
            assert_eq!(
                pixels,
                render_pixels(&constants, &fresh, size),
                "frame {frame}"
            );
            drawn_frames += usize::from(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0));
        }
        assert!(drawn_frames > 60);
    }

    #[test]
    #[ignore = "benchmark; requires a working wgpu adapter"]
    fn benchmark_captions_layer_prepare() {
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let segments = spoken_segments(&[
            "Today I want to walk you through the new export flow",
            "First pick a preset and the resolution you need",
            "Then trim the start and end so the video gets to the point",
            "When you are happy with it press export and share the link",
        ]);
        let frames = frames(size);
        let last_frame = (segments.last().unwrap().end * f64::from(FPS)) as u32;
        let base = CaptionSettings {
            enabled: true,
            ..Default::default()
        };
        let cases = [
            ("default", base.clone()),
            (
                "outline",
                CaptionSettings {
                    outline: true,
                    ..base.clone()
                },
            ),
            (
                "pill highlight",
                CaptionSettings {
                    active_word_highlight: true,
                    highlight_style: "pill".to_string(),
                    ..base.clone()
                },
            ),
            (
                "color highlight",
                CaptionSettings {
                    active_word_highlight: true,
                    ..base
                },
            ),
        ];
        for (name, settings) in cases {
            let mut uniforms = uniforms(&constants, settings, &segments, size);
            let mut layer = CaptionsLayer::new(&constants.device, &constants.queue);
            let mut samples = Vec::new();
            for pass in 0..4 {
                for frame in 0..last_frame {
                    uniforms.frame_number = frame;
                    let started = std::time::Instant::now();
                    layer.prepare(&uniforms, &frames, size, &constants);
                    let elapsed = started.elapsed().as_secs_f64() * 1e6;
                    if pass > 0 && layer.has_caption {
                        samples.push(elapsed);
                    }
                }
            }
            constants.device.poll(wgpu::PollType::Wait).unwrap();
            samples.sort_by(f64::total_cmp);
            println!(
                "captions layer prepare [{name}] ({} visible frames): p50 {:.1} us, p95 {:.1} us, mean {:.1} us",
                samples.len(),
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100],
                samples.iter().sum::<f64>() / samples.len() as f64,
            );
        }
    }

    fn pixel_digest(digest: u64, pixels: &[u8]) -> u64 {
        pixels.chunks_exact(8).fold(digest, |hash, chunk| {
            (hash ^ u64::from_le_bytes(chunk.try_into().unwrap())).wrapping_mul(0x0100_0000_01b3)
        })
    }

    #[test]
    #[ignore = "benchmark; requires a working wgpu adapter"]
    fn benchmark_word_highlight_prepare() {
        const FRAMES: u32 = 600;
        const PASSES: usize = 5;
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let frames = frames(size);
        let spaced = spoken_segments(&[
            "Today I want to walk you through the new export flow",
            "First pick a preset and the resolution you need",
            "Then trim the start and end so the video gets to the point",
            "When you are happy with it press export and share the link",
        ]);
        let mut back_to_back = spaced.clone();
        for segment in &mut back_to_back {
            let next_starts = segment
                .words
                .iter()
                .skip(1)
                .map(|word| word.start)
                .collect::<Vec<_>>();
            for (word, next_start) in segment.words.iter_mut().zip(next_starts) {
                word.end = next_start;
            }
        }
        let base = CaptionSettings {
            enabled: true,
            ..Default::default()
        };
        let highlight = CaptionSettings {
            active_word_highlight: true,
            ..base.clone()
        };
        let cases = [
            ("plain", base, &spaced),
            ("color highlight", highlight.clone(), &spaced),
            (
                "color highlight gold outline",
                CaptionSettings {
                    highlight_color: "#FFD700".to_string(),
                    outline: true,
                    ..highlight.clone()
                },
                &spaced,
            ),
            (
                "color highlight back-to-back words",
                highlight,
                &back_to_back,
            ),
        ];
        for (name, settings, segments) in cases {
            let mut uniforms = uniforms(&constants, settings, segments, size);
            let mut layer = CaptionsLayer::new(&constants.device, &constants.queue);
            let mut samples = Vec::new();
            let mut pass_totals = Vec::new();
            for pass in 0..PASSES {
                let mut pass_total = 0.0;
                for frame in 0..FRAMES {
                    uniforms.frame_number = frame;
                    let started = std::time::Instant::now();
                    layer.prepare(&uniforms, &frames, size, &constants);
                    let elapsed = started.elapsed().as_secs_f64() * 1e6;
                    pass_total += elapsed;
                    if pass > 0 && layer.has_caption {
                        samples.push(elapsed);
                    }
                }
                if pass > 0 {
                    pass_totals.push(pass_total / 1e3);
                }
                constants.device.poll(wgpu::PollType::Wait).unwrap();
            }
            samples.sort_by(f64::total_cmp);
            pass_totals.sort_by(f64::total_cmp);

            let mut checked = CaptionsLayer::new(&constants.device, &constants.queue);
            let mut digest = 0xcbf2_9ce4_8422_2325;
            for frame in 0..FRAMES {
                uniforms.frame_number = frame;
                checked.prepare(&uniforms, &frames, size, &constants);
                digest = pixel_digest(digest, &render_pixels(&constants, &checked, size));
            }

            println!(
                "word highlight prepare [{name}] ({FRAMES} frames, {} visible samples): p50 {:.1} us, p95 {:.1} us, {FRAMES}-frame total p50 {:.2} ms, pixels {digest:016x}",
                samples.len(),
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100],
                pass_totals[pass_totals.len() / 2],
            );
        }
    }
}
