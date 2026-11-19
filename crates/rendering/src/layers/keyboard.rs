use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{Device, Queue, include_wgsl, util::DeviceExt};

use super::captions::{CaptionOverlayLayout, CaptionPosition};
use super::keycaps::{self, Keycap, KeycapKind, KeycapStyle, KeycapTheme};
use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, parse_color_component};

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
struct KeyboardBackgroundUniforms {
    rect: [f32; 4],
    color: [f32; 4],
    radius: f32,
    _padding: [f32; 3],
    _padding2: [f32; 4],
}

/// One key for `shaders/keycap.wgsl`.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug, Default)]
struct KeycapUniform {
    rect: [f32; 4],
    top_a: [f32; 4],
    top_b: [f32; 4],
    side_a: [f32; 4],
    side_b: [f32; 4],
    border: [f32; 4],
    highlight: [f32; 4],
    shape: [f32; 4],
    finish: [f32; 4],
    motion: [f32; 4],
}

const MAX_KEYCAPS: usize = 16;
/// The label slots for typed text's settled letters and its newest letter
/// while that one rises in, past every row's own slots.
const RISING_SLOT: usize = MAX_KEYCAPS * 6;
/// How long a typed letter takes to rise into its key.
const LETTER_RISE: f64 = 0.16;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
struct KeycapUniforms {
    caps: [KeycapUniform; MAX_KEYCAPS],
    info: [f32; 4],
}

/// A key label placed for glyphon: which shaped buffer, where, in what colour.
struct PlacedLabel {
    slot: usize,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    color: Color,
    /// How far the label travels while the shutter is open.
    travel: [f32; 2],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KeyboardPosition {
    AboveCaptions,
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    /// The middle of the frame, for a video that is all about its keys.
    MiddleLeft,
    Center,
    MiddleRight,
}

impl KeyboardPosition {
    fn from_str(s: &str) -> Self {
        match s {
            "top-left" => Self::TopLeft,
            "top-center" | "top" => Self::TopCenter,
            "top-right" => Self::TopRight,
            "bottom-left" => Self::BottomLeft,
            "bottom-right" => Self::BottomRight,
            "bottom-center" | "bottom" => Self::BottomCenter,
            "middle-left" => Self::MiddleLeft,
            "center" | "middle-center" => Self::Center,
            "middle-right" => Self::MiddleRight,
            _ => Self::AboveCaptions,
        }
    }

    fn y_factor(&self) -> f32 {
        match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight => 0.08,
            Self::AboveCaptions => 0.75,
            Self::MiddleLeft | Self::Center | Self::MiddleRight => 0.5,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => 0.85,
        }
    }
}

const BOUNCE_OFFSET_PIXELS: f32 = 6.0;
const MIN_OVERLAY_GAP: f32 = 15.0;

/// A keycap is this many times the size setting tall, at 1080p: the default
/// size of 50 makes a key a tenth of the frame's height.
const KEYCAP_HEIGHT_PER_SIZE: f32 = 2.15;

/// The keycaps stand a little apart from the captions, more on a taller frame,
/// so their shadows never touch the caption card.
fn keycap_caption_gap(frame_height: f32) -> f32 {
    (frame_height * 0.035).max(MIN_OVERLAY_GAP)
}

/// Manual captions can sit anywhere, so they share the keyboard's lane
/// wherever the two boxes would meet side by side.
fn shares_caption_lane(
    caption_layout: CaptionOverlayLayout,
    keyboard_position: KeyboardPosition,
    keyboard_left: f32,
    keyboard_width: f32,
) -> bool {
    if caption_layout.position == CaptionPosition::Manual {
        let caption_left = caption_layout.rect[0];
        let caption_right = caption_left + caption_layout.rect[2];
        return keyboard_left < caption_right + MIN_OVERLAY_GAP
            && caption_left < keyboard_left + keyboard_width + MIN_OVERLAY_GAP;
    }
    matches!(
        (caption_layout.position, keyboard_position),
        (CaptionPosition::TopLeft, KeyboardPosition::TopLeft)
            | (CaptionPosition::TopCenter, KeyboardPosition::TopCenter)
            | (CaptionPosition::TopRight, KeyboardPosition::TopRight)
            | (CaptionPosition::BottomLeft, KeyboardPosition::BottomLeft)
            | (
                CaptionPosition::BottomCenter,
                KeyboardPosition::AboveCaptions
            )
            | (
                CaptionPosition::BottomCenter,
                KeyboardPosition::BottomCenter
            )
            | (CaptionPosition::BottomRight, KeyboardPosition::BottomRight)
    )
}

fn prefers_above_caption(keyboard_position: KeyboardPosition) -> bool {
    matches!(
        keyboard_position,
        KeyboardPosition::AboveCaptions
            | KeyboardPosition::BottomLeft
            | KeyboardPosition::BottomCenter
            | KeyboardPosition::BottomRight
    )
}

fn resolve_keyboard_position(
    keyboard_position: KeyboardPosition,
    caption_layout: Option<CaptionOverlayLayout>,
) -> KeyboardPosition {
    if keyboard_position == KeyboardPosition::AboveCaptions && caption_layout.is_none() {
        KeyboardPosition::BottomCenter
    } else {
        keyboard_position
    }
}

/// `keyboard` is the box at its own position, `[left, top, width, height]`,
/// kept `gap` pixels clear of the captions.
fn resolve_background_top(
    keyboard: [f32; 4],
    frame_height: f32,
    keyboard_position: KeyboardPosition,
    caption_layout: Option<CaptionOverlayLayout>,
    gap: f32,
) -> f32 {
    let [left, current_top, width, box_height] = keyboard;
    let Some(caption_layout) = caption_layout else {
        return current_top;
    };

    if !shares_caption_lane(caption_layout, keyboard_position, left, width) {
        return current_top;
    }

    let max_top = (frame_height - box_height).max(0.0);
    let caption_top = caption_layout.rect[1];
    let caption_bottom = caption_layout.rect[1] + caption_layout.rect[3];
    let current_bottom = current_top + box_height;

    if current_bottom + gap <= caption_top || current_top >= caption_bottom + gap {
        return current_top.clamp(0.0, max_top);
    }

    let above_candidate = caption_top - gap - box_height;
    let below_candidate = caption_bottom + gap;
    let above_valid = above_candidate >= 0.0;
    let below_valid = below_candidate <= max_top;

    let adjusted_top = if prefers_above_caption(keyboard_position) {
        if above_valid {
            above_candidate
        } else if below_valid {
            below_candidate
        } else {
            current_top
        }
    } else if below_valid {
        below_candidate
    } else if above_valid {
        above_candidate
    } else {
        current_top
    };

    adjusted_top.clamp(0.0, max_top)
}

#[derive(PartialEq)]
struct ShapedKeyboardText {
    text: String,
    font_size: u32,
    wrap_width: u32,
    family: Family<'static>,
    weight: Weight,
}

pub struct KeyboardLayer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    text_buffer: Buffer,
    shaped: Option<ShapedKeyboardText>,
    viewport: Viewport,
    background_pipeline: wgpu::RenderPipeline,
    background_bind_group: wgpu::BindGroup,
    background_uniform_buffer: wgpu::Buffer,
    background_scissor: Option<[u32; 4]>,
    output_size: (u32, u32),
    has_content: bool,
    keycap_pipeline: wgpu::RenderPipeline,
    keycap_bind_group: wgpu::BindGroup,
    keycap_uniform_buffer: wgpu::Buffer,
    /// Shaped key labels, kept between frames while their text holds.
    keycap_buffers: Vec<Option<(ShapedKeyboardText, Buffer)>>,
    keycap_labels: Vec<PlacedLabel>,
    keycap_mode: bool,
}

impl KeyboardLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let font_system = super::new_font_system();
        let glyph_phase = crate::readiness::Phase::start("glyph.keyboard.gpu_resources");
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

        let metrics = Metrics::new(28.0, 28.0 * 1.2);
        let text_buffer = Buffer::new_empty(metrics);

        let background_uniforms = KeyboardBackgroundUniforms {
            rect: [0.0; 4],
            color: [0.0; 4],
            radius: 0.0,
            _padding: [0.0; 3],
            _padding2: [0.0; 4],
        };

        let background_uniform_buffer =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Keyboard Background Uniform Buffer"),
                contents: bytemuck::bytes_of(&background_uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

        let background_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Keyboard Background Bind Group Layout"),
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
            label: Some("Keyboard Background Bind Group"),
            layout: &background_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: background_uniform_buffer.as_entire_binding(),
            }],
        });

        let background_shader =
            device.create_shader_module(include_wgsl!("../shaders/caption_bg.wgsl"));

        let background_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Keyboard Background Pipeline Layout"),
                bind_group_layouts: &[&background_bind_group_layout],
                push_constant_ranges: &[],
            });

        let background_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Keyboard Background Pipeline"),
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

        let (keycap_pipeline, keycap_bind_group, keycap_uniform_buffer) =
            create_keycap_pipeline(device);

        Self {
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            text_buffer,
            shaped: None,
            viewport,
            background_pipeline,
            background_bind_group,
            background_uniform_buffer,
            background_scissor: None,
            output_size: (0, 0),
            has_content: false,
            keycap_pipeline,
            keycap_bind_group,
            keycap_uniform_buffer,
            keycap_buffers: Vec::new(),
            keycap_labels: Vec::new(),
            keycap_mode: false,
        }
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        _segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
        caption_layout: Option<CaptionOverlayLayout>,
    ) {
        self.has_content = false;
        self.keycap_mode = false;
        self.background_scissor = None;
        self.output_size = (output_size.x, output_size.y);

        let Some(keyboard_data) = &uniforms.project.keyboard else {
            return;
        };

        if !keyboard_data.settings.enabled {
            return;
        }

        let timeline = match &uniforms.project.timeline {
            Some(t) => t,
            None => return,
        };

        if timeline.keyboard_segments.is_empty() {
            return;
        }

        let current_time = uniforms.frame_number as f64 / uniforms.frame_rate as f64;
        let settings = &keyboard_data.settings;

        let active_segment = find_active_keyboard_segment(
            current_time,
            &timeline.keyboard_segments,
            settings.fade_duration,
        );

        let Some(active) = active_segment else {
            return;
        };

        let segment_fade = active
            .segment
            .fade_duration_override
            .unwrap_or(settings.fade_duration) as f64;

        let raw_text = build_visible_text(active.segment, current_time);

        if raw_text.is_empty() {
            return;
        }

        let should_uppercase = active
            .segment
            .uppercase_override
            .unwrap_or(settings.uppercase);
        let visible_text = if should_uppercase {
            raw_text.to_uppercase()
        } else {
            raw_text
        };

        let fade_opacity = calculate_fade(
            current_time,
            active.segment.start,
            active.segment.end,
            segment_fade,
        ) * uniforms.takeover_overlay_fade();

        if fade_opacity <= 0.0 {
            return;
        }

        let bounce_offset = calculate_keyboard_bounce(
            current_time,
            active.segment.start,
            active.segment.end,
            segment_fade,
        );

        let (width, height) = (output_size.x, output_size.y);
        let device = &constants.device;
        let queue = &constants.queue;

        let position = active
            .segment
            .position_override
            .as_deref()
            .map(KeyboardPosition::from_str)
            .unwrap_or_else(|| KeyboardPosition::from_str(&settings.position));

        let margin = width as f32 * 0.05;

        let color_hex = active
            .segment
            .color_override
            .as_deref()
            .unwrap_or(&settings.color);
        let text_color = [
            parse_color_component(color_hex, 0),
            parse_color_component(color_hex, 1),
            parse_color_component(color_hex, 2),
        ];

        let bg_color_hex = active
            .segment
            .background_color_override
            .as_deref()
            .unwrap_or(&settings.background_color);
        let background_color_rgb = [
            parse_color_component(bg_color_hex, 0),
            parse_color_component(bg_color_hex, 1),
            parse_color_component(bg_color_hex, 2),
        ];

        let background_alpha =
            ((settings.background_opacity as f32 / 100.0) * fade_opacity).clamp(0.0, 1.0);

        let Some(font_size) = super::captions::scaled_font_size(
            active.segment.font_size_override.unwrap_or(settings.size),
            height,
        ) else {
            return;
        };
        let wrap_width = (width as f32 - margin * 2.0).max(font_size);

        let (font_family, weight) =
            super::captions::overlay_face(&settings.font, settings.font_weight);

        // Keys are drawn for the platform the recording was made on, so a
        // project looks the same wherever it is exported. A key coloured on
        // its own keeps an older project on its styled label.
        let platform = constants.recording_meta.platform.as_ref();
        let styled_keys = settings.style == "auto"
            && timeline.keyboard_segments.iter().any(|segment| {
                segment.color_override.is_some() || segment.background_color_override.is_some()
            });
        let style = KeycapStyle::from_setting_for(
            settings.effective_style_for(platform, styled_keys),
            platform,
        );
        if style != KeycapStyle::Classic {
            let case = |text: String| {
                if should_uppercase {
                    text.to_uppercase()
                } else {
                    text
                }
            };
            let pace = keycap_pace(segment_fade);
            let struck = last_struck_at(active.segment, current_time);
            // The keys animate from the first key press, not from the
            // segment's lead-in.
            let first_key = active
                .segment
                .keys
                .iter()
                .map(|key| key.time_offset)
                .reduce(f64::min)
                .map_or(active.segment.start, |offset| {
                    active.segment.start + offset / 1000.0
                });
            let since_press = current_time - first_key;
            // With typing shown, what is not a shortcut is typed text, from
            // its first letter on.
            let typed = |segment: &cap_project::KeyboardTrackSegment| {
                // Text typed into the composer is typing, shown or not; a
                // space struck on its own there is the space bar.
                let manual = cap_project::is_manual_keyboard_segment(segment);
                (settings.show_typing || manual)
                    && !is_shortcut(segment)
                    && !(manual && segment.display_text == "␣")
            };
            // What the keys showed just before the latest key went down, when
            // that key changed them (a typed letter, a key added).
            let before_strike = (struck > first_key + 1e-6)
                .then(|| case(build_visible_text(active.segment, struck - 1e-4)))
                .filter(|before| *before != visible_text);
            // The same shortcut struck again changes nothing on screen: the
            // keys dip once for it instead.
            let repeat =
                before_strike.is_none() && is_shortcut(active.segment) && struck > first_key + 1e-6;
            // Typed into the composer, each letter rises into the key as it
            // is struck, and the key dips for it.
            let typing = cap_project::is_manual_keyboard_segment(active.segment)
                && typed(active.segment)
                && before_strike.is_some();
            let change = match before_strike {
                Some(before) if since_press >= (KEYCAP_MOVE + KEYCAP_ENTER) * pace => KeyChange {
                    from: Some((before, typed(active.segment))),
                    by_identity: false,
                    since: current_time - struck,
                },
                // Keys appearing, or taking over from the keys before them as
                // those last stood.
                _ => KeyChange {
                    from: handed_from(active.segment, &timeline.keyboard_segments, settings)
                        .map(|previous| {
                            (
                                case(build_visible_text(previous, active.segment.start - 1e-4)),
                                typed(previous),
                            )
                        })
                        .filter(|(text, _)| !text.is_empty()),
                    by_identity: true,
                    since: since_press,
                },
            };
            // Keys that hand straight over to the next keys stay up through
            // the gap; the rest leave once their segment ends.
            let leaving = (current_time >= active.segment.end
                && !handed_over(active.segment, &timeline.keyboard_segments, segment_fade))
            .then_some(current_time - active.segment.end);
            self.prepare_keycaps(
                KeycapFrame {
                    text: &visible_text,
                    typed: typed(active.segment),
                    style,
                    theme: KeycapTheme::from_setting(&settings.theme),
                    font_size,
                    opacity: uniforms.takeover_overlay_fade(),
                    change,
                    leaving,
                    pace,
                    fade: segment_fade,
                    since_struck: if repeat || typing {
                        current_time - struck
                    } else {
                        f64::INFINITY
                    },
                    fresh: typing.then_some(current_time - struck),
                    position,
                    margin,
                },
                (width, height),
                caption_layout,
                constants,
            );
            return;
        }

        let text_alpha = fade_opacity.clamp(0.0, 1.0);
        let color = Color::rgba(
            (text_color[0] * 255.0) as u8,
            (text_color[1] * 255.0) as u8,
            (text_color[2] * 255.0) as u8,
            (text_alpha * 255.0) as u8,
        );

        let shaped = ShapedKeyboardText {
            text: visible_text,
            font_size: font_size.to_bits(),
            wrap_width: wrap_width.to_bits(),
            family: font_family,
            weight,
        };
        if self.shaped.as_ref() != Some(&shaped) {
            let metrics = Metrics::new(font_size, font_size * 1.2);
            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            buffer.set_size(&mut self.font_system, Some(wrap_width), None);
            buffer.set_text(
                &mut self.font_system,
                &shaped.text,
                &Attrs::new().family(font_family).weight(weight),
                Shaping::Advanced,
            );
            self.text_buffer = buffer;
            self.shaped = Some(shaped);
        }

        let mut layout_width: f32 = 0.0;
        let mut layout_height: f32 = 0.0;
        for run in glyphon::cosmic_text::LayoutRunIter::new(&self.text_buffer) {
            layout_width = layout_width.max(run.line_w);
            layout_height = layout_height.max(run.line_top + run.line_height);
        }

        if layout_height == 0.0 {
            layout_height = font_size * 1.2;
            layout_width = layout_width.max(font_size);
        }

        let available_width = (width as f32 - margin * 2.0).max(1.0);
        let padding = font_size * 0.45;
        let corner_radius = font_size * 0.5;
        let text_width = layout_width.min(available_width);
        let text_height = layout_height;
        let box_width = (text_width + padding * 2.0).min(available_width).max(1.0);
        let box_height = (text_height + padding * 2.0).min(height as f32).max(1.0);

        let resolved_position = resolve_keyboard_position(position, caption_layout);

        let background_left = match resolved_position {
            KeyboardPosition::TopLeft
            | KeyboardPosition::MiddleLeft
            | KeyboardPosition::BottomLeft => margin,
            KeyboardPosition::TopRight
            | KeyboardPosition::MiddleRight
            | KeyboardPosition::BottomRight => (width as f32 - margin - box_width).max(0.0),
            _ => ((width as f32 - box_width) / 2.0).max(0.0),
        };

        let center_y = height as f32 * resolved_position.y_factor();
        let max_background_top = (height as f32 - box_height).max(0.0);
        let base_background_top = (center_y - box_height / 2.0).clamp(0.0, max_background_top);
        let background_top = resolve_background_top(
            [
                background_left,
                (base_background_top + bounce_offset as f32).clamp(0.0, max_background_top),
                box_width,
                box_height,
            ],
            height as f32,
            position,
            caption_layout,
            MIN_OVERLAY_GAP,
        );

        let text_left = background_left + padding;
        let text_top = background_top + padding;

        let bounds = TextBounds {
            left: (text_left - 2.0).floor() as i32,
            top: (text_top - 2.0).floor() as i32,
            right: (text_left + text_width + 2.0).ceil() as i32,
            bottom: (text_top + text_height + 2.0).ceil() as i32,
        };

        self.viewport.update(queue, Resolution { width, height });

        let text_areas = vec![TextArea {
            buffer: &self.text_buffer,
            left: text_left,
            top: text_top,
            scale: 1.0,
            bounds,
            default_color: color,
            custom_glyphs: &[],
        }];

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
            Err(e) => warn!("Error preparing keyboard text: {e:?}"),
        }

        let rect = KeyboardBackgroundUniforms {
            rect: [
                background_left.max(0.0),
                background_top.max(0.0),
                box_width,
                box_height,
            ],
            color: [
                background_color_rgb[0],
                background_color_rgb[1],
                background_color_rgb[2],
                background_alpha,
            ],
            radius: corner_radius.min(box_width / 2.0).min(box_height / 2.0),
            _padding: [0.0; 3],
            _padding2: [0.0; 4],
        };

        queue.write_buffer(
            &self.background_uniform_buffer,
            0,
            bytemuck::bytes_of(&rect),
        );

        let scissor_padding = 4.0;
        let scissor_x = (background_left - scissor_padding).max(0.0).floor() as u32;
        let scissor_y = (background_top - scissor_padding).max(0.0).floor() as u32;
        let max_width = width.saturating_sub(scissor_x);
        let max_height = height.saturating_sub(scissor_y);

        if max_width == 0 || max_height == 0 {
            self.has_content = false;
            return;
        }

        let scissor_width = (box_width + scissor_padding * 2.0)
            .ceil()
            .max(1.0)
            .min(max_width as f32) as u32;
        let scissor_height = (box_height + scissor_padding * 2.0)
            .ceil()
            .max(1.0)
            .min(max_height as f32) as u32;

        if scissor_width == 0 || scissor_height == 0 {
            self.has_content = false;
            return;
        }

        self.background_scissor = Some([scissor_x, scissor_y, scissor_width, scissor_height]);
        self.has_content = true;
    }

    pub fn has_content(&self) -> bool {
        self.has_content
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.has_content {
            return;
        }

        if self.keycap_mode {
            if let Some([x, y, width, height]) = self.background_scissor {
                pass.set_scissor_rect(x, y, width, height);
                pass.set_pipeline(&self.keycap_pipeline);
                pass.set_bind_group(0, &self.keycap_bind_group, &[]);
                pass.draw(0..6, 0..1);
            }
            if let Err(e) = self
                .text_renderer
                .render(&self.text_atlas, &self.viewport, pass)
            {
                warn!("Error rendering keycap labels: {e:?}");
            }
            if self.output_size.0 > 0 && self.output_size.1 > 0 {
                pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
            }
            return;
        }

        if let Some([x, y, width, height]) = self.background_scissor {
            pass.set_scissor_rect(x, y, width, height);
            pass.set_pipeline(&self.background_pipeline);
            pass.set_bind_group(0, &self.background_bind_group, &[]);
            pass.draw(0..6, 0..1);
            pass.set_scissor_rect(x, y, width, height);
        } else if self.output_size.0 > 0 && self.output_size.1 > 0 {
            pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
        }

        match self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            Ok(_) => {}
            Err(e) => warn!("Error rendering keyboard text: {e:?}"),
        }

        if self.output_size.0 > 0 && self.output_size.1 > 0 {
            pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
        }
    }
}

/// A shaped label's set width and height, and where its baseline sits below
/// the top of its line box.
#[derive(Debug, Clone, Copy, Default)]
struct LabelMetrics {
    width: f32,
    height: f32,
    baseline: f32,
    size: f32,
}

/// What one frame of keycaps needs from the segment and settings.
struct KeycapFrame<'a> {
    text: &'a str,
    /// Whether `text` was typed rather than a shortcut struck.
    typed: bool,
    style: KeycapStyle,
    theme: KeycapTheme,
    font_size: f32,
    opacity: f32,
    /// How the keys came to be what they are, which the frame animates out
    /// of.
    change: KeyChange,
    /// Seconds since the keys started leaving, while they leave.
    leaving: Option<f64>,
    /// How long the animations run, 1 at the default fade.
    pace: f64,
    fade: f64,
    /// Seconds since a repeat of the same shortcut went down, or the newest
    /// letter of a word being typed.
    since_struck: f64,
    /// Seconds since the last letter of typed text was struck, while it is
    /// typing: that letter rises into the key.
    fresh: Option<f64>,
    position: KeyboardPosition,
    margin: f32,
}

/// A key drawn this frame: the key, its shaped label, corner word and width,
/// its first label slot, where it is, and how far it travels while the
/// shutter is open.
type DrawnKey<'a> = (
    &'a Keycap,
    &'a (LabelMetrics, LabelMetrics, f32),
    usize,
    KeyMotion,
    [f32; 2],
);

/// The keys before the latest change and how long ago it was.
struct KeyChange {
    /// The keys' text before, or none when they appeared from nothing, and
    /// whether it was typed.
    from: Option<(String, bool)>,
    /// Keys carry over when they are the same key (a shortcut handing over
    /// to the next); otherwise by their place in the row (typed text
    /// growing).
    by_identity: bool,
    since: f64,
}

/// Where one key is drawn this frame: its place, width, how far below its
/// rest it sits, and how opaque it is.
#[derive(Clone, Copy)]
struct KeyMotion {
    x: f32,
    width: f32,
    drop: f32,
    opacity: f32,
}

// The keys' motion at the default fade, in seconds, timed from the key
// press. Keys that appear fade in where they rest, a beat after the key
// before them; keys that carry over glide to their new places first, and
// the new keys follow as they settle; keys that go fade out where they are.
const KEYCAP_ENTER: f64 = 0.18;
const KEYCAP_STAGGER: f64 = 0.065;
const KEYCAP_RISE: f64 = 0.2;
const KEYCAP_MOVE: f64 = 0.09;
const KEYCAP_AFTER_MOVE: f64 = 0.07;
const KEYCAP_GROW: f64 = 0.08;
const KEYCAP_EXIT: f64 = 0.12;
/// How long the virtual shutter is open: a moving key smears over the
/// distance it covers in this time, as a camera would catch it.
const KEYCAP_SHUTTER: f64 = 0.022;

fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_quint(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(5)
}

fn ease_in_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// How far along a motion `duration` long is after `elapsed`, with no
/// motion at all when there is no time for one.
fn progress(elapsed: f64, duration: f64) -> f64 {
    if duration <= 0.0 {
        1.0
    } else {
        (elapsed / duration).clamp(0.0, 1.0)
    }
}

/// The animations scale with the fade setting, so a shorter fade makes for
/// snappier keys and none for none.
fn keycap_pace(fade: f64) -> f64 {
    (fade / 0.15).clamp(0.0, 4.0)
}

/// Pairs each key in `to` with the key it was in `from`, if any.
fn match_keys(from: &[Keycap], to: &[Keycap], by_identity: bool) -> Vec<Option<usize>> {
    let mut used = vec![false; from.len()];
    to.iter()
        .enumerate()
        .map(|(index, cap)| {
            let found = if by_identity {
                // Typed text is one key whatever it says, so a new word
                // reuses the key the last one was on.
                from.iter().enumerate().position(|(at, old)| {
                    !used[at]
                        && (old == cap
                            || (old.kind == KeycapKind::Wide && cap.kind == KeycapKind::Wide))
                })
            } else {
                from.get(index)
                    .filter(|old| old.kind == cap.kind && !used[index])
                    .map(|_| index)
            };
            if let Some(at) = found {
                used[at] = true;
            }
            found
        })
        .collect()
}

/// Where every key is drawn `change.since` after a change: those in `to`
/// (at rest at `to_x`), then the ones from `from` that have gone (at rest at
/// `from_x`).
fn key_motions(
    to: (&[Keycap], &[(f32, f32)]),
    from: (&[Keycap], &[(f32, f32)]),
    change: &KeyChange,
    pace: f64,
    cap_height: f32,
) -> (Vec<KeyMotion>, Vec<(usize, KeyMotion)>) {
    let matches = match_keys(from.0, to.0, change.by_identity);
    let carry = if change.by_identity {
        ease_in_out_cubic(progress(change.since, KEYCAP_MOVE * pace))
    } else {
        ease_out_cubic(progress(change.since, KEYCAP_GROW * pace))
    } as f32;
    // New keys wait for the keys carrying over to make room, or for the
    // keys they replace to have mostly gone, so no two keys share a place.
    let delay = if matches.iter().any(Option::is_some) {
        KEYCAP_AFTER_MOVE * pace
    } else if !from.0.is_empty() {
        KEYCAP_EXIT * 0.7 * pace
    } else {
        0.0
    };
    let mut entering = 0;
    let current =
        to.1.iter()
            .zip(&matches)
            .map(|(&(x, width), found)| match found {
                Some(at) => {
                    let (old_x, old_width) = from.1[*at];
                    KeyMotion {
                        x: old_x + (x - old_x) * carry,
                        width: old_width + (width - old_width) * carry,
                        drop: 0.0,
                        opacity: 1.0,
                    }
                }
                None => {
                    let local = change.since - delay - entering as f64 * KEYCAP_STAGGER * pace;
                    entering += 1;
                    KeyMotion {
                        x,
                        width,
                        drop: (1.0 - ease_out_quint(progress(local, KEYCAP_RISE * pace))) as f32
                            * cap_height
                            * 0.1,
                        opacity: ease_out_cubic(progress(local, KEYCAP_ENTER * pace)) as f32,
                    }
                }
            })
            .collect();
    let gone = ease_out_cubic(progress(change.since, KEYCAP_EXIT * pace)) as f32;
    let leaving = from
        .1
        .iter()
        .enumerate()
        .filter(|(at, _)| !matches.contains(&Some(*at)))
        .filter(|_| gone < 1.0)
        .map(|(at, &(x, width))| {
            (
                at,
                KeyMotion {
                    x,
                    width,
                    drop: gone * cap_height * 0.06,
                    opacity: 1.0 - gone,
                },
            )
        })
        .collect();
    (current, leaving)
}

impl KeyboardLayer {
    /// Shapes `text` into the buffer at `slot`, reusing it while the text
    /// holds, and returns how wide and tall the set text is.
    fn shape_keycap_label(
        &mut self,
        slot: usize,
        text: &str,
        size: f32,
        family: Family<'static>,
        weight: Weight,
    ) -> LabelMetrics {
        if self.keycap_buffers.len() <= slot {
            self.keycap_buffers.resize_with(slot + 1, || None);
        }
        let shaped = ShapedKeyboardText {
            text: text.to_string(),
            font_size: size.to_bits(),
            wrap_width: 0,
            family,
            weight,
        };
        let fresh = !matches!(&self.keycap_buffers[slot], Some((held, _)) if *held == shaped);
        if fresh {
            let metrics = Metrics::new(size, size * 1.2);
            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            buffer.set_size(&mut self.font_system, None, None);
            // Key symbols are printed in the one face that draws them all
            // alike; letters and words in the key's own face.
            let attrs = Attrs::new().family(family).weight(weight);
            let symbol_attrs = Attrs::new()
                .family(Family::Name(keycaps::KEY_SYMBOL_FONT))
                .weight(Weight(500));
            buffer.set_rich_text(
                &mut self.font_system,
                keycaps::symbol_runs(text).into_iter().map(|(run, symbol)| {
                    (
                        run,
                        if symbol {
                            symbol_attrs.clone()
                        } else {
                            attrs.clone()
                        },
                    )
                }),
                &attrs,
                Shaping::Advanced,
                None,
            );
            buffer.shape_until_scroll(&mut self.font_system, false);
            self.keycap_buffers[slot] = Some((shaped, buffer));
        }
        let Some((_, buffer)) = &self.keycap_buffers[slot] else {
            return LabelMetrics::default();
        };
        let mut metrics = LabelMetrics {
            size,
            ..LabelMetrics::default()
        };
        for (index, run) in glyphon::cosmic_text::LayoutRunIter::new(buffer).enumerate() {
            metrics.width = metrics.width.max(run.line_w);
            metrics.height = metrics.height.max(run.line_top + run.line_height);
            if index == 0 {
                metrics.baseline = run.line_y;
            }
        }
        metrics.height = metrics.height.max(size * 1.2);
        if metrics.baseline <= 0. {
            metrics.baseline = size;
        }
        metrics
    }

    /// Shapes a row of keys at `cap_height` into the label slots from
    /// `slot_base`, and returns each key's label, corner word and width.
    fn layout_keycap_row(
        &mut self,
        caps: &[Keycap],
        cap_height: f32,
        style: KeycapStyle,
        (family, weight): (Family<'static>, Weight),
        slot_base: usize,
    ) -> Vec<(LabelMetrics, LabelMetrics, f32)> {
        caps.iter()
            .enumerate()
            .map(|(index, cap)| {
                let label = self.shape_keycap_label(
                    slot_base + index * 2,
                    &cap.label,
                    keycaps::label_size(cap, cap_height, style),
                    family,
                    weight,
                );
                let legend = match &cap.legend {
                    Some(legend) => self.shape_keycap_label(
                        slot_base + index * 2 + 1,
                        legend,
                        keycaps::legend_size(cap_height),
                        family,
                        weight,
                    ),
                    None => LabelMetrics::default(),
                };
                let cap_width = keycaps::cap_width(cap, cap_height, label.width, legend.width);
                (label, legend, cap_width)
            })
            .collect()
    }

    fn prepare_keycaps(
        &mut self,
        frame: KeycapFrame<'_>,
        (width, height): (u32, u32),
        caption_layout: Option<CaptionOverlayLayout>,
        constants: &RenderVideoConstants,
    ) {
        // The newest keys are the ones being struck: keep those.
        let newest = |mut caps: Vec<Keycap>| {
            if caps.len() > MAX_KEYCAPS {
                caps.drain(..caps.len() - MAX_KEYCAPS);
            }
            caps
        };
        let keys_for = |text: &str, typed: bool| {
            newest(if typed {
                keycaps::typed_keycaps(text, frame.style)
            } else {
                keycaps::keycaps_for(text, frame.style)
            })
        };
        let caps = keys_for(frame.text, frame.typed);
        if caps.is_empty() {
            return;
        }
        let from_caps = frame
            .change
            .from
            .as_ref()
            .map(|(text, typed)| keys_for(text, *typed))
            .unwrap_or_default();
        let available = (width as f32 - frame.margin * 2.0).max(1.0);
        let geometry = frame.style.geometry();
        let (face, face_weight) = keycaps::keycap_font(frame.style, frame.theme);
        let face = (Family::Name(face), Weight(face_weight));

        // Lay the keys out at the set size; a row too wide for the frame is
        // set again, smaller, so every key stays on screen.
        let row_width = |sizes: &[(LabelMetrics, LabelMetrics, f32)], cap_height: f32| {
            sizes.iter().map(|size| size.2).sum::<f32>()
                + keycaps::cap_gap(cap_height) * sizes.len().saturating_sub(1) as f32
        };
        // The row is measured at full size in slots of its own, so a row
        // that has to shrink keeps both its measured and its drawn labels
        // shaped from one frame to the next.
        let mut cap_height = frame.font_size * KEYCAP_HEIGHT_PER_SIZE;
        let measured =
            self.layout_keycap_row(&caps, cap_height, frame.style, face, MAX_KEYCAPS * 4);
        let total = row_width(&measured, cap_height);
        if total > available {
            cap_height *= available / total;
        }
        let sizes = self.layout_keycap_row(&caps, cap_height, frame.style, face, 0);
        let from_sizes = if from_caps.is_empty() {
            Vec::new()
        } else {
            self.layout_keycap_row(&from_caps, cap_height, frame.style, face, MAX_KEYCAPS * 2)
        };

        let radius = geometry.radius * cap_height;
        let depth = (geometry.depth * cap_height).max(2.0);
        let inset = geometry.inset * cap_height;
        let gap = keycaps::cap_gap(cap_height);
        let resolved_position = resolve_keyboard_position(frame.position, caption_layout);
        // Each row at rest: every key's left edge and width, squeezed to fit.
        let place_row = |sizes: &[(LabelMetrics, LabelMetrics, f32)]| {
            let total = row_width(sizes, cap_height);
            let squeeze = (available / total.max(1.0)).min(1.0);
            let total = total * squeeze;
            let left = match resolved_position {
                KeyboardPosition::TopLeft
                | KeyboardPosition::MiddleLeft
                | KeyboardPosition::BottomLeft => frame.margin,
                KeyboardPosition::TopRight
                | KeyboardPosition::MiddleRight
                | KeyboardPosition::BottomRight => (width as f32 - frame.margin - total).max(0.0),
                _ => ((width as f32 - total) / 2.0).max(0.0),
            };
            let mut x = left;
            let placed: Vec<(f32, f32)> = sizes
                .iter()
                .map(|size| {
                    let at = (x, size.2 * squeeze);
                    x += (size.2 + gap) * squeeze;
                    at
                })
                .collect();
            (left, total, placed)
        };
        let (left, total, rest) = place_row(&sizes);
        let (_, _, from_rest) = place_row(&from_sizes);
        let center_y = height as f32 * resolved_position.y_factor();
        let max_top = (height as f32 - cap_height).max(0.0);
        let base_top = (center_y - cap_height / 2.0).clamp(0.0, max_top);
        let top = resolve_background_top(
            [left, base_top, total, cap_height],
            height as f32,
            frame.position,
            caption_layout,
            keycap_caption_gap(height as f32),
        );

        // Where every key is `before` seconds ago, so how far it travels
        // while the shutter is open.
        let motions_at = |before: f64| {
            let (mut current, leaving_from) = key_motions(
                (&caps, &rest),
                (&from_caps, &from_rest),
                &KeyChange {
                    from: None,
                    by_identity: frame.change.by_identity,
                    since: frame.change.since - before,
                },
                frame.pace,
                cap_height,
            );
            // Leaving for good: every key fades as it settles a little
            // lower.
            if let Some(elapsed) = frame.leaving {
                let out = ease_in_out_cubic(progress(elapsed - before, frame.fade)) as f32;
                for motion in &mut current {
                    motion.opacity *= 1.0 - out;
                    motion.drop += out * cap_height * 0.08;
                }
            }
            (current, leaving_from)
        };
        let (current, leaving_from) = motions_at(0.0);
        let (earlier, earlier_leaving) = motions_at(KEYCAP_SHUTTER * frame.pace.min(1.0));
        let travel = |now: &KeyMotion, then: Option<&KeyMotion>| {
            then.map_or([0.0, 0.0], |then| [now.x - then.x, now.drop - then.drop])
        };
        let current: Vec<(KeyMotion, [f32; 2])> = current
            .iter()
            .zip(&earlier)
            .map(|(now, then)| (*now, travel(now, Some(then))))
            .collect();
        let leaving_from: Vec<(usize, KeyMotion, [f32; 2])> = leaving_from
            .iter()
            .map(|(at, now)| {
                let then = earlier_leaving
                    .iter()
                    .find(|(earlier_at, _)| earlier_at == at)
                    .map(|(_, motion)| motion);
                (*at, *now, travel(now, then))
            })
            .collect();
        // Keys going are drawn first, under the keys arriving.
        let mut drawn: Vec<DrawnKey> = leaving_from
            .iter()
            .map(|&(at, motion, travel)| {
                (
                    &from_caps[at],
                    &from_sizes[at],
                    MAX_KEYCAPS * 2 + at * 2,
                    motion,
                    travel,
                )
            })
            .collect();
        drawn.truncate(MAX_KEYCAPS - caps.len());
        drawn.extend(caps.iter().zip(&sizes).zip(&current).enumerate().map(
            |(index, ((cap, size), (motion, travel)))| (cap, size, index * 2, *motion, *travel),
        ));

        let press = keycaps::press_depth(frame.since_struck);
        let mut uniforms = KeycapUniforms {
            caps: [KeycapUniform::default(); MAX_KEYCAPS],
            info: [drawn.len() as f32, 1.0, 0.0, 0.0],
        };
        self.keycap_labels.clear();
        let pad = cap_height * 0.13;
        let (mut reach_left, mut reach_right) = (f32::INFINITY, f32::NEG_INFINITY);
        let mut reach_bottom = top + cap_height;
        for (index, (cap, (label, legend, _), slot, motion, travel)) in drawn.iter().enumerate() {
            // While text types out, only the key it is typing into dips.
            let press = if frame.fresh.is_some() && index + 1 != drawn.len() {
                0.0
            } else {
                press
            };
            let opacity = (motion.opacity * frame.opacity).clamp(0.0, 1.0);
            let x = motion.x;
            let cap_top = top + motion.drop;
            let cap_width = motion.width;
            reach_left = reach_left.min(x);
            reach_right = reach_right.max(x + cap_width);
            reach_bottom = reach_bottom.max(cap_top + cap_height);
            let palette = frame.theme.palette_for(frame.style, cap);
            uniforms.info[2] = uniforms.info[2].max(palette.shadow);
            uniforms.caps[index] = KeycapUniform {
                rect: [x, cap_top, cap_width, cap_height],
                top_a: palette.top[0],
                top_b: palette.top[1],
                side_a: palette.side[0],
                side_b: palette.side[1],
                border: palette.border,
                highlight: palette.highlight,
                shape: [radius, depth, inset, press],
                finish: [geometry.dish, palette.grain, palette.gloss, opacity],
                motion: [travel[0], travel[1], geometry.sculpt, 0.0],
            };
            let sink = depth * press;
            let face_x = x + inset;
            let face_y = cap_top + sink + inset * 0.4;
            let face_w = cap_width - inset * 2.0;
            let face_h = cap_height - depth - inset * 0.85;
            let color = |c: [f32; 4]| {
                Color::rgba(
                    (c[0] * 255.0) as u8,
                    (c[1] * 255.0) as u8,
                    (c[2] * 255.0) as u8,
                    (c[3] * opacity * 255.0) as u8,
                )
            };
            // Labels are placed by their ink, not their line box: the
            // baseline sits so the capitals (or running text) centre on the
            // face, or, for Apple's modifiers, hug the corners as printed.
            let place = |metrics: &LabelMetrics, left: f32, ink_top: f32, ink: f32| {
                (left, ink_top + metrics.size * ink - metrics.baseline)
            };
            if cap.legend.is_some() {
                // Apple's keys print towards the space bar: the symbol in
                // the top corner, the word in the bottom one, same side.
                let right = cap.align == keycaps::LegendAlign::Right;
                let along = |width: f32| {
                    if right {
                        face_x + face_w - pad - width
                    } else {
                        face_x + pad
                    }
                };
                if !cap.label.is_empty() {
                    let (left, top) = place(label, along(label.width), face_y + pad * 0.75, 0.71);
                    self.keycap_labels.push(PlacedLabel {
                        slot: *slot,
                        left,
                        top,
                        width: label.width,
                        height: label.height,
                        color: color(palette.label),
                        travel: *travel,
                    });
                }
                let legend_ink = legend.size * 0.71;
                let (left, top) = place(
                    legend,
                    along(legend.width),
                    face_y + face_h - pad * 0.7 - legend_ink,
                    0.71,
                );
                self.keycap_labels.push(PlacedLabel {
                    slot: *slot + 1,
                    left,
                    top,
                    width: legend.width,
                    height: legend.height,
                    color: color(palette.legend),
                    travel: *travel,
                });
            } else if !cap.label.is_empty() {
                let ink = keycaps::ink_height(cap);
                let (left, top) = place(
                    label,
                    face_x + (face_w - label.width) / 2.0,
                    face_y + (face_h - label.size * ink) / 2.0,
                    ink,
                );
                // While text types out, its newest letter rises into place
                // beside the ones already set, fading in as it comes.
                // It rises at the keys' own pace: not at all with no fade.
                let rise_for = LETTER_RISE * frame.pace;
                let rising = frame.fresh.filter(|age| {
                    *age < rise_for && index + 1 == drawn.len() && cap.kind == KeycapKind::Wide
                });
                if let Some(age) = rising {
                    let split = cap.label.char_indices().last().map_or(0, |(at, _)| at);
                    let (settled, newest) = cap.label.split_at(split);
                    let settled_width = if settled.is_empty() {
                        0.0
                    } else {
                        let metrics = self.shape_keycap_label(
                            RISING_SLOT,
                            settled,
                            label.size,
                            face.0,
                            face.1,
                        );
                        self.keycap_labels.push(PlacedLabel {
                            slot: RISING_SLOT,
                            left,
                            top,
                            width: metrics.width,
                            height: metrics.height,
                            color: color(palette.label),
                            travel: *travel,
                        });
                        metrics.width
                    };
                    let newest_metrics = self.shape_keycap_label(
                        RISING_SLOT + 1,
                        newest,
                        label.size,
                        face.0,
                        face.1,
                    );
                    let rise = |age: f64| {
                        (1.0 - ease_out_cubic(progress(age, rise_for))) as f32 * label.size * 0.45
                    };
                    let shown = ease_out_cubic(progress(age, rise_for * 0.7)) as f32;
                    let mut ink_color = palette.label;
                    ink_color[3] *= shown;
                    let shutter = KEYCAP_SHUTTER * frame.pace.min(1.0);
                    self.keycap_labels.push(PlacedLabel {
                        slot: RISING_SLOT + 1,
                        left: left + settled_width,
                        top: top + rise(age),
                        width: newest_metrics.width,
                        height: newest_metrics.height,
                        color: color(ink_color),
                        travel: [travel[0], travel[1] + rise(age) - rise(age - shutter)],
                    });
                } else {
                    self.keycap_labels.push(PlacedLabel {
                        slot: *slot,
                        left,
                        top,
                        width: label.width,
                        height: label.height,
                        color: color(palette.label),
                        travel: *travel,
                    });
                }
            }
        }

        let device = &constants.device;
        let queue = &constants.queue;
        queue.write_buffer(
            &self.keycap_uniform_buffer,
            0,
            bytemuck::bytes_of(&uniforms),
        );
        self.viewport.update(queue, Resolution { width, height });

        // A moving label is printed along its path at a share of its
        // opacity each time, smearing it like the key under it.
        let text_areas: Vec<TextArea> = self
            .keycap_labels
            .iter()
            .filter_map(|placed| {
                let (_, buffer) = self.keycap_buffers.get(placed.slot)?.as_ref()?;
                let distance = placed.travel[0].hypot(placed.travel[1]);
                let copies = distance.ceil().clamp(1.0, 24.0) as usize;
                let mut color = placed.color;
                if copies > 1 {
                    // Each print carries a share of the ink, a little over
                    // an even split since prints laid over each other add up
                    // to less than their sum.
                    let alpha = color.a() as f32 / 255.0;
                    let share = (alpha * 1.6 / copies as f32).min(alpha);
                    color = Color::rgba(color.r(), color.g(), color.b(), (share * 255.0) as u8);
                }
                Some((0..copies).map(move |copy| {
                    let along = if copies > 1 {
                        copy as f32 / (copies - 1) as f32 - 0.5
                    } else {
                        0.0
                    };
                    let left = placed.left + placed.travel[0] * along;
                    let top = placed.top + placed.travel[1] * along;
                    TextArea {
                        buffer,
                        left,
                        top,
                        scale: 1.0,
                        bounds: TextBounds {
                            left: (left - 2.0).floor() as i32,
                            top: (top - 2.0).floor() as i32,
                            right: (left + placed.width + 2.0).ceil() as i32,
                            bottom: (top + placed.height + 2.0).ceil() as i32,
                        },
                        default_color: color,
                        custom_glyphs: &[],
                    }
                }))
            })
            .flatten()
            .collect();
        if let Err(e) = self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            text_areas,
            &mut self.swash_cache,
        ) {
            warn!("Error preparing keycap labels: {e:?}");
        }

        // The shadow reaches below and around the keys.
        let reach = cap_height * 0.5 + depth * 2.0 + 4.0;
        let scissor_x = (reach_left - reach).max(0.0).floor() as u32;
        let scissor_y = (top - reach).max(0.0).floor() as u32;
        let scissor_w = ((reach_right - reach_left + reach * 2.0).ceil() as u32)
            .min(width.saturating_sub(scissor_x));
        let scissor_h = ((reach_bottom - top + reach * 2.0).ceil() as u32)
            .min(height.saturating_sub(scissor_y));
        if scissor_w == 0 || scissor_h == 0 {
            return;
        }
        self.background_scissor = Some([scissor_x, scissor_y, scissor_w, scissor_h]);
        self.keycap_mode = true;
        self.has_content = true;
    }
}

/// When the segment's latest key went down, in timeline seconds: the start,
/// or the last typed key at or before `current_time`.
fn last_struck_at(segment: &cap_project::KeyboardTrackSegment, current_time: f64) -> f64 {
    let elapsed_ms = (current_time - segment.start) * 1000.0;
    segment
        .keys
        .iter()
        .map(|key| key.time_offset)
        .filter(|offset| *offset <= elapsed_ms)
        .fold(0.0_f64, f64::max)
        / 1000.0
        + segment.start
}

fn create_keycap_pipeline(
    device: &Device,
) -> (wgpu::RenderPipeline, wgpu::BindGroup, wgpu::Buffer) {
    let uniforms = KeycapUniforms {
        caps: [KeycapUniform::default(); MAX_KEYCAPS],
        info: [0.0; 4],
    };
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Keycap Uniform Buffer"),
        contents: bytemuck::bytes_of(&uniforms),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Keycap Bind Group Layout"),
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
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Keycap Bind Group"),
        layout: &layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    });
    let shader = device.create_shader_module(include_wgsl!("../shaders/keycap.wgsl"));
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Keycap Pipeline Layout"),
        bind_group_layouts: &[&layout],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Keycap Pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
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
    (pipeline, bind_group, buffer)
}

struct ActiveKeyboardSegment<'a> {
    segment: &'a cap_project::KeyboardTrackSegment,
}

/// The segment whose keys are still on screen when `segment` starts, which
/// it takes over from.
fn handed_from<'a>(
    segment: &cap_project::KeyboardTrackSegment,
    segments: &'a [cap_project::KeyboardTrackSegment],
    settings: &cap_project::KeyboardSettings,
) -> Option<&'a cap_project::KeyboardTrackSegment> {
    segments
        .iter()
        .filter(|other| {
            let fade = other
                .fade_duration_override
                .unwrap_or(settings.fade_duration) as f64;
            other.start < segment.start && other.end + fade > segment.start
        })
        .max_by(|a, b| a.start.total_cmp(&b.start))
}

/// Whether other keys start before `segment` has faded out, taking over
/// from it.
fn handed_over(
    segment: &cap_project::KeyboardTrackSegment,
    segments: &[cap_project::KeyboardTrackSegment],
    fade: f64,
) -> bool {
    segments.iter().any(|next| {
        next.start > segment.start && next.start >= segment.end && next.start < segment.end + fade
    })
}

fn find_active_keyboard_segment<'a>(
    time: f64,
    segments: &'a [cap_project::KeyboardTrackSegment],
    default_fade_duration: f32,
) -> Option<ActiveKeyboardSegment<'a>> {
    segments
        .iter()
        .filter(|segment| time >= segment.start && time < segment.end)
        .max_by(|a, b| a.start.total_cmp(&b.start))
        .or_else(|| {
            segments
                .iter()
                .filter(|segment| {
                    let fade = segment
                        .fade_duration_override
                        .unwrap_or(default_fade_duration) as f64;
                    time >= segment.end && time < segment.end + fade
                })
                .max_by(|a, b| a.end.total_cmp(&b.end))
        })
        .map(|segment| ActiveKeyboardSegment { segment })
}

fn build_visible_text(segment: &cap_project::KeyboardTrackSegment, current_time: f64) -> String {
    if segment.keys.is_empty() || is_shortcut(segment) {
        return segment.display_text.clone();
    }

    let time_offset_from_start = (current_time - segment.start) * 1000.0;
    let chars: Vec<char> = segment.display_text.chars().collect();

    if segment.keys.len() != chars.len() {
        if segment
            .keys
            .iter()
            .any(|key| time_offset_from_start >= key.time_offset)
        {
            return segment.display_text.clone();
        }

        return String::new();
    }

    let mut visible = String::new();

    for (i, key) in segment.keys.iter().enumerate() {
        if time_offset_from_start >= key.time_offset && i < chars.len() {
            visible.push(chars[i]);
        }
    }

    if visible.is_empty() && !segment.display_text.is_empty() {
        visible.push(chars[0]);
    }

    visible
}

/// A shortcut shows whole from the start, however many times it was struck:
/// its keys are presses of one combination, not letters typed one by one.
fn is_shortcut(segment: &cap_project::KeyboardTrackSegment) -> bool {
    if segment.display_text.contains(['⌃', '⌥', '⌘']) {
        return true;
    }
    // One key struck again and again: a repeated shortcut shows its combo
    // once, while a doubled typed letter shows one character per press.
    let repeated = segment.keys.len() > 1
        && segment
            .keys
            .iter()
            .all(|key| key.key == segment.keys[0].key);
    if !repeated {
        return false;
    }
    let mut chars = segment.display_text.chars();
    let first = chars.next();
    let typed = segment.display_text.chars().count() == segment.keys.len()
        && chars.all(|c| Some(c) == first);
    !typed
}

fn calculate_fade(current_time: f64, start: f64, end: f64, fade_duration: f64) -> f32 {
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

fn calculate_keyboard_bounce(current_time: f64, start: f64, end: f64, fade_duration: f64) -> f64 {
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
        KeyboardPosition, MIN_OVERLAY_GAP, build_visible_text, find_active_keyboard_segment,
        resolve_background_top, resolve_keyboard_position,
    };
    use crate::layers::{CaptionOverlayLayout, CaptionPosition};

    #[test]
    fn a_shortcut_handing_over_keeps_its_shared_keys_and_brings_new_ones_in_turn() {
        use super::{KeyChange, key_motions};
        use crate::layers::keycaps::{KeycapStyle, keycaps_for};
        let from = keycaps_for("⌘C", KeycapStyle::MacOs);
        let to = keycaps_for("⇧⌘P", KeycapStyle::MacOs);
        let from_rest = [(100.0, 140.0), (250.0, 100.0)];
        let to_rest = [(60.0, 140.0), (210.0, 140.0), (360.0, 100.0)];
        let at = |since: f64| {
            key_motions(
                (&to, &to_rest),
                (&from, &from_rest),
                &KeyChange {
                    from: Some(("⌘C".into(), false)),
                    by_identity: true,
                    since,
                },
                1.0,
                100.0,
            )
        };
        // At the change: command is where it was, fully shown; shift and P
        // have not appeared; C is still there.
        let (keys, leaving) = at(0.0);
        assert_eq!(keys[0].x, 100.0);
        assert_eq!(keys[0].opacity, 1.0);
        assert_eq!(keys[1].opacity, 0.0);
        assert!(keys[1].drop > 5.0);
        assert_eq!(leaving.len(), 1);
        assert_eq!(leaving[0].1.opacity, 1.0);
        // Partway: command glides while C fades, and the new keys wait.
        let (keys, leaving) = at(0.05);
        assert!(keys[0].x < 100.0 && keys[0].x > 60.0);
        assert!(leaving[0].1.opacity < 1.0);
        assert_eq!(keys[1].opacity, 0.0);
        // Then shift arrives ahead of P.
        let (keys, _) = at(0.15);
        assert!(keys[1].opacity > keys[2].opacity && keys[2].opacity > 0.0);
        // Settled: everything at rest, C gone.
        let (keys, leaving) = at(1.0);
        for (key, rest) in keys.iter().zip(to_rest) {
            assert_eq!(
                (key.x, key.width, key.drop, key.opacity),
                (rest.0, rest.1, 0.0, 1.0)
            );
        }
        assert!(leaving.is_empty());
        // No fade setting: no motion at all.
        let (keys, leaving) = key_motions(
            (&to, &to_rest),
            (&from, &from_rest),
            &KeyChange {
                from: Some(("⌘C".into(), false)),
                by_identity: true,
                since: 0.0,
            },
            0.0,
            100.0,
        );
        assert!(keys.iter().all(|key| key.opacity == 1.0 && key.drop == 0.0));
        assert!(leaving.is_empty());
    }

    #[test]
    fn typed_text_grows_in_place_rather_than_appearing_again() {
        use super::{KeyChange, key_motions};
        use crate::layers::keycaps::{KeycapStyle, keycaps_for};
        let from = keycaps_for("he", KeycapStyle::MacOs);
        let to = keycaps_for("hey", KeycapStyle::MacOs);
        let (keys, leaving) = key_motions(
            (&to, &[(90.0, 120.0)]),
            (&from, &[(100.0, 100.0)]),
            &KeyChange {
                from: Some(("he".into(), true)),
                by_identity: false,
                since: 0.0,
            },
            1.0,
            100.0,
        );
        assert_eq!(
            (keys[0].x, keys[0].width, keys[0].opacity),
            (100.0, 100.0, 1.0)
        );
        assert!(leaving.is_empty());
    }

    #[test]
    fn a_shortcut_struck_as_often_as_it_has_characters_shows_whole() {
        let segment: cap_project::KeyboardTrackSegment =
            serde_json::from_value(serde_json::json!({
                "id": "s", "start": 1.0, "end": 3.0, "displayText": "⌘C",
                "keys": [{"key": "c", "timeOffset": 100.0}, {"key": "c", "timeOffset": 600.0}]
            }))
            .unwrap();
        assert_eq!(build_visible_text(&segment, 1.0), "⌘C");
        assert_eq!(build_visible_text(&segment, 1.2), "⌘C");
        let typed: cap_project::KeyboardTrackSegment = serde_json::from_value(serde_json::json!({
            "id": "t", "start": 1.0, "end": 3.0, "displayText": "hi",
            "keys": [{"key": "h", "timeOffset": 0.0}, {"key": "i", "timeOffset": 500.0}]
        }))
        .unwrap();
        assert_eq!(build_visible_text(&typed, 1.2), "h");
        // A doubled letter appears as it is typed, whichever grouping made it.
        let doubled: cap_project::KeyboardTrackSegment =
            serde_json::from_value(serde_json::json!({
                "id": "d", "start": 1.0, "end": 3.0, "displayText": "aa",
                "keys": [{"key": "a", "timeOffset": 0.0}, {"key": "a", "timeOffset": 500.0}]
            }))
            .unwrap();
        assert_eq!(build_visible_text(&doubled, 1.2), "a");
        assert_eq!(build_visible_text(&doubled, 1.6), "aa");
        // A shortcut struck twice shows whole from its first strike, even
        // with typing switched on after it was generated.
        let repeated: cap_project::KeyboardTrackSegment =
            serde_json::from_value(serde_json::json!({
                "id": "r", "start": 1.0, "end": 3.0, "displayText": "⇧⇥",
                "keys": [{"key": "Tab", "timeOffset": 0.0}, {"key": "Tab", "timeOffset": 500.0}]
            }))
            .unwrap();
        assert_eq!(build_visible_text(&repeated, 1.2), "⇧⇥");
        let escaped: cap_project::KeyboardTrackSegment =
            serde_json::from_value(serde_json::json!({
                "id": "e", "start": 1.0, "end": 3.0, "displayText": "⎋",
                "keys": [{"key": "Escape", "timeOffset": 0.0}, {"key": "Escape", "timeOffset": 500.0}]
            }))
            .unwrap();
        assert_eq!(build_visible_text(&escaped, 1.2), "⎋");
    }

    #[test]
    fn new_typing_is_not_hidden_by_the_previous_words_linger() {
        let segment = |id: &str, start: f64, end: f64| -> cap_project::KeyboardTrackSegment {
            serde_json::from_value(
                serde_json::json!({"id":id,"start":start,"end":end,"displayText":id}),
            )
            .unwrap()
        };
        let segments = [segment("previous", 7.0, 7.8), segment("current", 7.2, 8.0)];
        let active = find_active_keyboard_segment(7.5, &segments, 0.15).unwrap();
        assert_eq!(build_visible_text(active.segment, 7.5), "current");
        assert_eq!(
            find_active_keyboard_segment(8.1, &segments, 0.15)
                .unwrap()
                .segment
                .id,
            "current"
        );
    }

    #[test]
    fn shortcut_segments_show_the_full_combo() {
        let segment = cap_project::KeyboardTrackSegment {
            id: "kb-1".to_string(),
            start: 1.0,
            end: 1.8,
            display_text: "⌘T".to_string(),
            keys: vec![cap_project::KeyPressDisplay {
                key: "t".to_string(),
                time_offset: 0.0,
            }],
            fade_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
            uppercase_override: None,
        };

        assert_eq!(build_visible_text(&segment, 1.0), "⌘T");
    }

    #[test]
    fn above_captions_falls_back_to_bottom_center_without_caption_layout() {
        assert_eq!(
            resolve_keyboard_position(KeyboardPosition::AboveCaptions, None),
            KeyboardPosition::BottomCenter
        );
    }

    #[test]
    fn bottom_keyboard_moves_above_captions_with_gap() {
        let caption_layout = CaptionOverlayLayout {
            rect: [100.0, 760.0, 400.0, 140.0],
            position: CaptionPosition::BottomCenter,
        };

        let resolved_top = resolve_background_top(
            [100.0, 720.0, 400.0, 120.0],
            1080.0,
            KeyboardPosition::AboveCaptions,
            Some(caption_layout),
            MIN_OVERLAY_GAP,
        );

        assert_eq!(resolved_top, 625.0);
    }

    #[test]
    fn top_keyboard_moves_below_captions_with_gap() {
        let caption_layout = CaptionOverlayLayout {
            rect: [100.0, 60.0, 400.0, 100.0],
            position: CaptionPosition::TopCenter,
        };

        let resolved_top = resolve_background_top(
            [100.0, 90.0, 400.0, 80.0],
            1080.0,
            KeyboardPosition::TopCenter,
            Some(caption_layout),
            MIN_OVERLAY_GAP,
        );

        assert_eq!(resolved_top, 175.0);
    }

    #[test]
    fn different_lanes_do_not_shift_keyboard() {
        let caption_layout = CaptionOverlayLayout {
            rect: [100.0, 760.0, 400.0, 140.0],
            position: CaptionPosition::BottomLeft,
        };

        let resolved_top = resolve_background_top(
            [1400.0, 720.0, 400.0, 120.0],
            1080.0,
            KeyboardPosition::BottomRight,
            Some(caption_layout),
            MIN_OVERLAY_GAP,
        );

        assert_eq!(resolved_top, 720.0);
    }

    #[test]
    fn keyboard_stays_clear_of_manual_captions_it_would_overlap() {
        let keyboard = [760.0, 760.0, 400.0, 100.0];
        let manual = |rect| {
            Some(CaptionOverlayLayout {
                rect,
                position: CaptionPosition::Manual,
            })
        };
        let resolve = |position, caption| {
            resolve_background_top(keyboard, 1080.0, position, caption, MIN_OVERLAY_GAP)
        };

        let overlapping = manual([700.0, 780.0, 520.0, 60.0]);
        assert_eq!(resolve(KeyboardPosition::AboveCaptions, overlapping), 665.0);
        assert_eq!(resolve(KeyboardPosition::TopCenter, overlapping), 855.0);

        let beside = manual([96.0, 780.0, 520.0, 60.0]);
        assert_eq!(resolve(KeyboardPosition::AboveCaptions, beside), 760.0);
        let above = manual([700.0, 60.0, 520.0, 60.0]);
        assert_eq!(resolve(KeyboardPosition::AboveCaptions, above), 760.0);
    }
}

#[cfg(test)]
mod gpu_tests {
    use cap_project::{
        CursorEvents, KeyPressDisplay, KeyboardData, KeyboardSettings, KeyboardTrackSegment,
        ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
        TimelineConfiguration, XY,
    };

    use super::KeyboardLayer;
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
            pretty_name: "Keyboard overlay test".into(),
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

    fn typed_segment(id: &str, start: f64, text: &str, key_gap_ms: f64) -> KeyboardTrackSegment {
        let keys = text
            .chars()
            .enumerate()
            .map(|(index, key)| KeyPressDisplay {
                key: key.to_string(),
                time_offset: index as f64 * key_gap_ms,
            })
            .collect::<Vec<_>>();
        KeyboardTrackSegment {
            id: id.to_string(),
            start,
            end: start + keys.len() as f64 * key_gap_ms / 1000.0 + 0.8,
            display_text: text.to_string(),
            keys,
            fade_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
            uppercase_override: None,
        }
    }

    fn uniforms(
        constants: &RenderVideoConstants,
        segments: &[KeyboardTrackSegment],
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
        std::sync::Arc::make_mut(&mut uniforms.project).keyboard = Some(KeyboardData {
            settings: KeyboardSettings {
                enabled: true,
                style: "classic".to_string(),
                ..Default::default()
            },
        });
        std::sync::Arc::make_mut(&mut uniforms.project).timeline = Some(TimelineConfiguration {
            segments: vec![],
            transitions: vec![],
            zoom_segments: vec![],
            scene_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: vec![],
            keyboard_segments: segments.to_vec(),
            audio_segments: vec![],
            style_segments: vec![],
            image_segments: vec![],
            shape_segments: Vec::new(),
            camera3d_segments: vec![],
        });
        uniforms
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

    fn render_pixels(
        constants: &RenderVideoConstants,
        layer: &KeyboardLayer,
        size: XY<u32>,
    ) -> Vec<u8> {
        render_with(constants, size, |pass| layer.render(pass))
    }

    fn render_with(
        constants: &RenderVideoConstants,
        size: XY<u32>,
        draw: impl FnOnce(&mut wgpu::RenderPass<'_>),
    ) -> Vec<u8> {
        let device = &constants.device;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Keyboard Test Target"),
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
            label: Some("Keyboard Test Readback"),
            size: u64::from(size.x * size.y * 4),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Keyboard Test Pass"),
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
            draw(&mut pass);
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

    /// A size of 0, from the settings or one segment's override, draws
    /// nothing; cosmic-text asserts on the zero line height it would give.
    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn a_zero_size_keyboard_overlay_draws_nothing() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let frames = frames(size);
        let mut overridden = typed_segment("typed", 0.2, "git push", 90.0);
        overridden.font_size_override = Some(0);
        for (settings_size, segment, drawn) in [
            (
                KeyboardSettings::default().size,
                typed_segment("typed", 0.2, "git push", 90.0),
                true,
            ),
            (0, typed_segment("typed", 0.2, "git push", 90.0), false),
            (KeyboardSettings::default().size, overridden, false),
        ] {
            let mut uniforms = uniforms(&constants, std::slice::from_ref(&segment), size);
            std::sync::Arc::make_mut(&mut uniforms.project)
                .keyboard
                .as_mut()
                .unwrap()
                .settings
                .size = settings_size;
            uniforms.frame_number = FPS;
            let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
            layer.prepare(&uniforms, &frames, size, &constants, None);
            assert_eq!(layer.has_content(), drawn, "size {settings_size}");
        }
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn every_frame_of_a_typed_segment_renders_like_a_fresh_layer() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let segments = [typed_segment("typed", 0.2, "git push", 90.0)];
        let mut uniforms = uniforms(&constants, &segments, size);
        let frames = frames(size);
        let mut reused = KeyboardLayer::new(&constants.device, &constants.queue);
        let mut drawn_frames = 0;
        for frame in 0..((segments[0].end + 0.2) * FPS as f64) as u32 {
            uniforms.frame_number = frame;
            reused.prepare(&uniforms, &frames, size, &constants, None);
            let mut fresh = KeyboardLayer::new(&constants.device, &constants.queue);
            fresh.prepare(&uniforms, &frames, size, &constants, None);
            assert_eq!(reused.has_content(), fresh.has_content(), "frame {frame}");
            let pixels = render_pixels(&constants, &reused, size);
            assert_eq!(
                pixels,
                render_pixels(&constants, &fresh, size),
                "frame {frame}"
            );
            drawn_frames += usize::from(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0));
        }
        assert!(drawn_frames > 40);
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn reused_layer_follows_font_and_output_size_changes() {
        type Edit = (&'static str, XY<u32>, fn(&mut KeyboardSettings));
        let base_size = XY::new(512, 288);
        let constants = constants(base_size);
        let segments = [typed_segment("typed", 0.2, "git push origin main", 60.0)];
        let frames = frames(base_size);
        let prepare =
            |layer: &mut KeyboardLayer, size: XY<u32>, edit: fn(&mut KeyboardSettings)| {
                let mut uniforms = uniforms(&constants, &segments, size);
                uniforms.frame_number = 96;
                edit(
                    &mut std::sync::Arc::make_mut(&mut uniforms.project)
                        .keyboard
                        .as_mut()
                        .unwrap()
                        .settings,
                );
                layer.prepare(&uniforms, &frames, size, &constants, None);
                assert!(layer.has_content());
                render_pixels(&constants, layer, size)
            };
        let unchanged: fn(&mut KeyboardSettings) = |_| {};
        let edits: [Edit; 5] = [
            ("font size", base_size, |settings| settings.size = 70),
            ("font family", base_size, |settings| {
                settings.font = "System Monospace".to_string()
            }),
            ("font weight", base_size, |settings| {
                settings.font_weight = 700
            }),
            ("output height", XY::new(512, 216), unchanged),
            ("output width", XY::new(128, 288), unchanged),
        ];
        let base_pixels = prepare(
            &mut KeyboardLayer::new(&constants.device, &constants.queue),
            base_size,
            unchanged,
        );

        for (name, size, edit) in edits {
            let expected = prepare(
                &mut KeyboardLayer::new(&constants.device, &constants.queue),
                size,
                edit,
            );
            assert!(
                expected != base_pixels,
                "{name} edit should change the output"
            );

            let mut reused = KeyboardLayer::new(&constants.device, &constants.queue);
            prepare(&mut reused, base_size, unchanged);
            assert!(
                prepare(&mut reused, size, edit) == expected,
                "{name} edit reused a stale layout"
            );
        }
    }

    fn shortcut_segment(id: &str, start: f64, text: &str) -> KeyboardTrackSegment {
        KeyboardTrackSegment {
            keys: vec![KeyPressDisplay {
                key: "P".to_string(),
                time_offset: 0.0,
            }],
            ..typed_segment(id, start, text, 0.0)
        }
    }

    fn with_keycaps(uniforms: &mut ProjectUniforms, style: &str, theme: &str) {
        let settings = &mut std::sync::Arc::make_mut(&mut uniforms.project)
            .keyboard
            .as_mut()
            .unwrap()
            .settings;
        settings.style = style.to_string();
        settings.theme = theme.to_string();
    }

    /// Keycaps, like the classic label, draw the same from a reused layer as
    /// from a fresh one on every frame, including while a key is pressed.
    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn every_frame_of_a_keycap_segment_renders_like_a_fresh_layer() {
        let size = XY::new(512, 288);
        let constants = constants(size);
        let segments = [
            shortcut_segment("shortcut", 0.2, "⇧⌘P"),
            typed_segment("typed", 1.4, "git push", 90.0),
        ];
        let frames = frames(size);
        for style in ["macos", "windows", "linux", "mechanical"] {
            let mut uniforms = uniforms(&constants, &segments, size);
            with_keycaps(&mut uniforms, style, "dark");
            let mut reused = KeyboardLayer::new(&constants.device, &constants.queue);
            let mut drawn_frames = 0;
            for frame in 0..((segments[1].end + 0.2) * FPS as f64) as u32 {
                uniforms.frame_number = frame;
                reused.prepare(&uniforms, &frames, size, &constants, None);
                let mut fresh = KeyboardLayer::new(&constants.device, &constants.queue);
                fresh.prepare(&uniforms, &frames, size, &constants, None);
                assert_eq!(reused.has_content(), fresh.has_content(), "{style} {frame}");
                let pixels = render_pixels(&constants, &reused, size);
                assert_eq!(
                    pixels,
                    render_pixels(&constants, &fresh, size),
                    "{style} frame {frame}"
                );
                drawn_frames += usize::from(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0));
            }
            assert!(drawn_frames > 60, "{style}: {drawn_frames}");
        }
    }

    /// How long the GPU takes to draw the keys at 4K, per style, at rest and
    /// mid-glide (when every key is sampled along its path), printed for a
    /// comparison by eye.
    #[test]
    #[ignore = "benchmark; requires a working wgpu adapter"]
    fn keycap_gpu_cost() {
        let size = XY::new(3840, 2160);
        let constants = constants(size);
        let frames = frames(size);
        let device = &constants.device;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Keycap Bench Target"),
            size: wgpu::Extent3d {
                width: size.x,
                height: size.y,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let segments = [
            shortcut_segment("a", 0.0, "⌘C"),
            shortcut_segment("b", 0.6, "⌃⌥⇧⌘P"),
        ];
        for style in ["macos", "windows", "linux", "mechanical"] {
            let mut uniforms = uniforms(&constants, &segments, size);
            with_keycaps(&mut uniforms, style, "dark");
            for (moment, frame) in [("rest", 30), ("glide", 39)] {
                uniforms.frame_number = frame;
                let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
                layer.prepare(&uniforms, &frames, size, &constants, None);
                assert!(layer.has_content());
                let run = |count: usize| {
                    let started = std::time::Instant::now();
                    let mut encoder = device.create_command_encoder(&Default::default());
                    for _ in 0..count {
                        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: None,
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
                    constants.queue.submit([encoder.finish()]);
                    device.poll(wgpu::PollType::Wait).unwrap();
                    started.elapsed().as_secs_f64() * 1e6 / count as f64
                };
                run(20);
                let mut samples: Vec<f64> = (0..7).map(|_| run(100)).collect();
                samples.sort_by(f64::total_cmp);
                println!(
                    "keycap gpu {style:<10} {moment:<5} {:>7.1} us/frame",
                    samples[3]
                );
            }
        }
    }

    /// Writes every keycap style and theme, over a mid-grey frame, to
    /// `CAP_KEYCAP_GALLERY` for a look by eye.
    #[test]
    #[ignore = "writes images; requires a working wgpu adapter"]
    fn keycap_gallery() {
        let Some(dir) = std::env::var_os("CAP_KEYCAP_GALLERY") else {
            return;
        };
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let frames = frames(size);
        for (name, segment, frame) in [
            ("shortcut", shortcut_segment("s", 0.0, "⌃⌥⇧⌘P"), 30),
            ("pressed", shortcut_segment("s", 0.0, "⇧⌘P"), 4),
            ("named", shortcut_segment("s", 0.0, "⏎"), 30),
            ("typed", typed_segment("t", 0.0, "hello world", 30.0), 50),
            ("arrow", shortcut_segment("s", 0.0, "⇧⌘←"), 30),
            ("delete", shortcut_segment("s", 0.0, "⌥⌫"), 30),
            ("escape", shortcut_segment("s", 0.0, "⌃⎋"), 30),
            ("tab", shortcut_segment("s", 0.0, "⇧⇥"), 30),
        ] {
            for style in ["macos", "windows", "linux", "mechanical"] {
                for theme in ["light", "dark", "retro"] {
                    let mut uniforms = uniforms(&constants, std::slice::from_ref(&segment), size);
                    with_keycaps(&mut uniforms, style, theme);
                    std::sync::Arc::make_mut(&mut uniforms.project)
                        .keyboard
                        .as_mut()
                        .unwrap()
                        .settings
                        .position = "top-center".to_string();
                    uniforms.frame_number = frame;
                    let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
                    layer.prepare(&uniforms, &frames, size, &constants, None);
                    let pixels = render_pixels(&constants, &layer, size);
                    let mut image = image::RgbaImage::from_pixel(
                        size.x,
                        size.y,
                        image::Rgba([126, 132, 148, 255]),
                    );
                    for (pixel, src) in image.pixels_mut().zip(pixels.chunks_exact(4)) {
                        let a = src[3] as f32 / 255.0;
                        for c in 0..3 {
                            pixel[c] = (src[c] as f32 * a + pixel[c] as f32 * (1.0 - a)) as u8;
                        }
                    }
                    image
                        .save(
                            std::path::Path::new(&dir).join(format!("{name}-{style}-{theme}.png")),
                        )
                        .unwrap();
                }
            }
        }
    }

    /// Every frame of a saved project's key track, written to
    /// `CAP_KEY_FRAMES` as crops around the keys, with each frame's key row
    /// logged, to judge motion frame by frame.
    #[test]
    #[ignore = "writes images; requires a working wgpu adapter"]
    fn key_track_frames() {
        let Some(dir) = std::env::var_os("CAP_KEY_FRAMES") else {
            return;
        };
        let range: Vec<f64> = std::env::var("CAP_KEY_RANGE")
            .unwrap_or_else(|_| "11.5,20".into())
            .split(',')
            .map(|value| value.parse().unwrap())
            .collect();
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let frames = frames(size);
        // A saved project's track, or the shortcut fixture the reference
        // capture uses, grouped with default settings.
        let (segments, keyboard) = match std::env::var_os("CAP_KEY_PROJECT") {
            Some(config) => {
                let saved: ProjectConfiguration =
                    serde_json::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
                (
                    saved.timeline.as_ref().unwrap().keyboard_segments.clone(),
                    saved.keyboard.clone(),
                )
            }
            None => {
                let event = |key: &str, time_ms: f64, down: bool| cap_project::KeyPressEvent {
                    key: key.to_string(),
                    key_code: key.to_string(),
                    time_ms,
                    down,
                };
                let mut presses = Vec::new();
                for (modifiers, key, at) in [
                    (&["LMeta"][..], "c", 200.0),
                    (&["LShift", "LMeta"][..], "p", 1100.0),
                    (&["LMeta"][..], "z", 2000.0),
                    (&["LMeta"][..], "z", 2300.0),
                    (&["LControl", "LAlt", "LMeta"][..], "Enter", 3000.0),
                ] {
                    presses.extend(modifiers.iter().map(|m| event(m, at - 20.0, true)));
                    presses.push(event(key, at, true));
                    presses.push(event(key, at + 90.0, false));
                    presses.extend(modifiers.iter().map(|m| event(m, at + 100.0, false)));
                }
                let settings = KeyboardSettings {
                    enabled: true,
                    ..Default::default()
                };
                (
                    cap_project::group_shortcuts(
                        &cap_project::KeyboardEvents { presses },
                        settings.linger_duration as f64 * 1000.0,
                        settings.show_special_keys,
                    ),
                    Some(KeyboardData { settings }),
                )
            }
        };
        let mut uniforms = uniforms(&constants, &segments, size);
        std::sync::Arc::make_mut(&mut uniforms.project).keyboard = keyboard;
        let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
        for frame in (range[0] * FPS as f64) as u32..(range[1] * FPS as f64) as u32 {
            uniforms.frame_number = frame;
            layer.prepare(&uniforms, &frames, size, &constants, None);
            let pixels = render_pixels(&constants, &layer, size);
            let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
            for (index, pixel) in pixels.chunks_exact(4).enumerate() {
                if pixel[3] > 200 {
                    let (x, y) = (index as u32 % size.x, index as u32 / size.x);
                    x0 = x0.min(x);
                    x1 = x1.max(x);
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
            }
            println!(
                "frame {frame} t={:.3} keys x {x0}..{x1} y {y0}..{y1}",
                frame as f64 / FPS as f64
            );
            let mut image =
                image::RgbaImage::from_pixel(size.x, 360, image::Rgba([126, 132, 148, 255]));
            let band: usize = std::env::var("CAP_KEY_BAND")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(720);
            for (y, row) in pixels
                .chunks_exact(size.x as usize * 4)
                .skip(band)
                .take(360)
                .enumerate()
            {
                for (x, src) in row.chunks_exact(4).enumerate() {
                    let pixel = image.get_pixel_mut(x as u32, y as u32);
                    let a = src[3] as f32 / 255.0;
                    for c in 0..3 {
                        pixel[c] = (src[c] as f32 * a + pixel[c] as f32 * (1.0 - a)) as u8;
                    }
                }
            }
            image
                .save(std::path::Path::new(&dir).join(format!("{frame:05}.png")))
                .unwrap();
        }
    }

    /// Keys and captions together over a recording, written to
    /// `CAP_OVERLAY_GALLERY` to judge how the two sit with each other.
    #[test]
    #[ignore = "writes images; requires a working wgpu adapter"]
    fn keys_and_captions_gallery() {
        let Some(dir) = std::env::var_os("CAP_OVERLAY_GALLERY") else {
            return;
        };
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let frames = frames(size);
        let backdrop = std::env::var_os("CAP_OVERLAY_BACKDROP")
            .and_then(|path| image::open(path).ok())
            .map(|image| {
                image
                    .resize_to_fill(size.x, size.y, image::imageops::FilterType::Triangle)
                    .to_rgba8()
            })
            .unwrap_or_else(|| {
                image::RgbaImage::from_pixel(size.x, size.y, image::Rgba([126, 132, 148, 255]))
            });
        let words = ["Now", "open", "the", "command", "palette", "and", "search"];
        let caption = cap_project::CaptionSegment {
            id: "c".to_string(),
            start: 0.0,
            end: 3.0,
            text: words.join(" "),
            words: words
                .iter()
                .enumerate()
                .map(|(index, word)| cap_project::CaptionWord {
                    text: word.to_string(),
                    start: index as f32 * 0.3,
                    end: index as f32 * 0.3 + 0.28,
                })
                .collect(),
            recording_clip: None,
        };
        for (name, text) in [("shortcut", "⇧⌘P"), ("single", "⌘K"), ("long", "⌃⌥⌘⏎")]
        {
            for (style, theme) in [
                ("macos", "dark"),
                ("macos", "light"),
                ("windows", "dark"),
                ("classic", "dark"),
            ] {
                let segment = KeyboardTrackSegment {
                    end: 3.0,
                    ..shortcut_segment("s", 0.0, text)
                };
                let mut uniforms = uniforms(&constants, std::slice::from_ref(&segment), size);
                with_keycaps(&mut uniforms, style, theme);
                let project = std::sync::Arc::make_mut(&mut uniforms.project);
                project.captions = Some(cap_project::CaptionsData {
                    segments: vec![caption.clone()],
                    settings: cap_project::CaptionSettings {
                        enabled: true,
                        ..Default::default()
                    },
                    source_timed: false,
                });
                if let Some(timeline) = project.timeline.as_mut() {
                    timeline.caption_segments = vec![cap_project::CaptionTrackSegment {
                        id: caption.id.clone(),
                        start: 0.0,
                        end: 3.0,
                        text: caption.text.clone(),
                        words: caption.words.clone(),
                        fade_duration_override: None,
                        linger_duration_override: None,
                        position_override: None,
                        color_override: None,
                        background_color_override: None,
                        font_size_override: None,
                    }];
                }
                uniforms.frame_number = 66;
                let mut captions =
                    super::super::captions::CaptionsLayer::new(&constants.device, &constants.queue);
                captions.prepare(&uniforms, &frames, size, &constants);
                let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
                layer.prepare(
                    &uniforms,
                    &frames,
                    size,
                    &constants,
                    captions.active_layout(),
                );
                let pixels = render_with(&constants, size, |pass| {
                    captions.render(pass);
                    layer.render(pass);
                });
                let mut image = backdrop.clone();
                for (pixel, src) in image.pixels_mut().zip(pixels.chunks_exact(4)) {
                    let a = src[3] as f32 / 255.0;
                    for c in 0..3 {
                        pixel[c] = (src[c] as f32 * a + pixel[c] as f32 * (1.0 - a)) as u8;
                    }
                }
                image
                    .save(std::path::Path::new(&dir).join(format!("{name}-{style}-{theme}.png")))
                    .unwrap();
            }
        }
    }

    #[test]
    #[ignore = "benchmark; requires a working wgpu adapter"]
    fn benchmark_keyboard_layer_prepare() {
        let size = XY::new(1920, 1080);
        let constants = constants(size);
        let mut segments = Vec::new();
        let mut start = 0.5;
        for (index, text) in ["cargo test --release", "git status", "npm run dev"]
            .iter()
            .enumerate()
        {
            let segment = typed_segment(&format!("typed-{index}"), start, text, 120.0);
            start = segment.end + 0.5;
            segments.push(segment);
        }
        for (index, text) in ["⇧⌘P", "⌘C", "⌃⌥⌘⏎"].iter().enumerate() {
            let segment = shortcut_segment(&format!("shortcut-{index}"), start, text);
            start = segment.end + 0.5;
            segments.push(segment);
        }
        let frames = frames(size);
        let total_frames = (start * FPS as f64) as u32;
        for style in ["classic", "macos", "linux", "mechanical"] {
            let mut uniforms = uniforms(&constants, &segments, size);
            with_keycaps(&mut uniforms, style, "dark");
            let mut layer = KeyboardLayer::new(&constants.device, &constants.queue);
            let mut samples = Vec::new();
            for pass in 0..4 {
                for frame in 0..total_frames {
                    uniforms.frame_number = frame;
                    let started = std::time::Instant::now();
                    layer.prepare(&uniforms, &frames, size, &constants, None);
                    let elapsed = started.elapsed().as_secs_f64() * 1e6;
                    if pass > 0 && layer.has_content() {
                        samples.push(elapsed);
                    }
                }
            }
            constants.device.poll(wgpu::PollType::Wait).unwrap();
            samples.sort_by(f64::total_cmp);
            println!(
                "keyboard layer prepare, {style} ({} visible frames): p50 {:.1} us, p95 {:.1} us, mean {:.1} us",
                samples.len(),
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100],
                samples.iter().sum::<f64>() / samples.len() as f64,
            );
        }
    }
}
