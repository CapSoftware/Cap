use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::cosmic_text::LayoutRunIter;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::{debug, warn};
use wgpu::{Device, Queue, include_wgsl, util::DeviceExt};

use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, parse_color_component};

#[derive(Debug, Clone)]
pub struct CaptionWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Clone)]
pub struct CaptionSegment {
    pub id: String,
    pub start: f32,
    pub end: f32,
    pub text: String,
    pub words: Vec<CaptionWord>,
}

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
}

impl CaptionPosition {
    fn from_str(s: &str) -> Self {
        match s {
            "top-left" => Self::TopLeft,
            "top-center" | "top" => Self::TopCenter,
            "top-right" => Self::TopRight,
            "bottom-left" => Self::BottomLeft,
            "bottom-right" => Self::BottomRight,
            _ => Self::BottomCenter,
        }
    }

    fn y_factor(&self) -> f32 {
        match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight => 0.08,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => 0.85,
        }
    }

    fn x_alignment(&self) -> f32 {
        match self {
            Self::TopLeft | Self::BottomLeft => 0.05,
            Self::TopCenter | Self::BottomCenter => 0.5,
            Self::TopRight | Self::BottomRight => 0.95,
        }
    }
}

const BASE_TEXT_OPACITY: f32 = 0.8;
const MAX_WORDS_PER_LINE: usize = 6;
const BOUNCE_OFFSET_PIXELS: f32 = 8.0;
const CLOSE_TRANSITION_BOUNCE_DURATION: f32 = 0.12;

fn wrap_text_by_words(text: &str, max_words: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }

    let mut result = String::new();
    for (i, word) in words.iter().enumerate() {
        if i > 0 {
            if i % max_words == 0 {
                result.push('\n');
            } else {
                result.push(' ');
            }
        }
        result.push_str(word);
    }
    result
}

fn calculate_bounce_offset(
    _fade_opacity: f32,
    time_from_start: f32,
    time_to_end: f32,
    fade_duration: f32,
    skip_fade_in: bool,
    skip_fade_out: bool,
) -> f32 {
    if skip_fade_in && time_from_start < CLOSE_TRANSITION_BOUNCE_DURATION {
        let progress = (time_from_start / CLOSE_TRANSITION_BOUNCE_DURATION).clamp(0.0, 1.0);
        let ease = 1.0 - progress;
        let bounce = ease * ease;
        return -bounce * BOUNCE_OFFSET_PIXELS;
    }

    if skip_fade_out && time_to_end < 0.0 {
        let time_past_end = -time_to_end;
        if time_past_end < CLOSE_TRANSITION_BOUNCE_DURATION {
            let progress = (time_past_end / CLOSE_TRANSITION_BOUNCE_DURATION).clamp(0.0, 1.0);
            let bounce = progress * progress;
            return bounce * BOUNCE_OFFSET_PIXELS;
        }
    }

    if fade_duration <= 0.0 {
        return 0.0;
    }

    let fade_in_progress = (time_from_start / fade_duration).clamp(0.0, 1.0);
    let fade_out_progress = (time_to_end / fade_duration).clamp(0.0, 1.0);

    if fade_in_progress < 1.0 && !skip_fade_in {
        let ease = 1.0 - fade_in_progress;
        let bounce = ease * ease;
        -bounce * BOUNCE_OFFSET_PIXELS
    } else if fade_out_progress < 1.0 && !skip_fade_out {
        let ease = 1.0 - fade_out_progress;
        let bounce = ease * ease;
        bounce * BOUNCE_OFFSET_PIXELS
    } else {
        0.0
    }
}

fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn ease_in_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * t
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

pub struct CaptionsLayer {
    settings_buffer: wgpu::Buffer,
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    text_buffer: Buffer,
    current_text: Option<String>,
    current_segment_start: f32,
    current_segment_end: f32,
    viewport: Viewport,
    background_pipeline: wgpu::RenderPipeline,
    background_bind_group: wgpu::BindGroup,
    background_uniform_buffer: wgpu::Buffer,
    background_scissor: Option<[u32; 4]>,
    output_size: (u32, u32),
    has_caption: bool,
}

impl CaptionsLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let settings = CaptionSettings::default();
        let settings_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Settings Buffer"),
            contents: bytemuck::cast_slice(&[settings]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut text_atlas =
            TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8UnormSrgb);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            device,
            wgpu::MultisampleState::default(),
            None,
        );

        let metrics = Metrics::new(24.0, 24.0 * 1.2);
        let text_buffer = Buffer::new_empty(metrics);

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
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
            settings_buffer,
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            text_buffer,
            current_text: None,
            current_segment_start: 0.0,
            current_segment_end: 0.0,
            viewport,
            background_pipeline,
            background_bind_group,
            background_uniform_buffer,
            background_scissor: None,
            output_size: (0, 0),
            has_caption: false,
        }
    }

    pub fn update_settings(&mut self, queue: &Queue, settings: CaptionSettings) {
        queue.write_buffer(&self.settings_buffer, 0, bytemuck::cast_slice(&[settings]));
    }

    pub fn update_caption(&mut self, text: Option<String>, start: f32, end: f32) {
        debug!("Updating caption - Text: {text:?}, Start: {start}, End: {end}");
        self.current_text = text;
        self.current_segment_start = start;
        self.current_segment_end = end;
    }

    fn calculate_fade_opacity(
        &self,
        current_time: f32,
        fade_duration: f32,
        linger_duration: f32,
        skip_fade_in: bool,
        skip_fade_out: bool,
    ) -> (f32, f32, f32) {
        let time_from_start = current_time - self.current_segment_start;
        let time_to_end = self.current_segment_end - current_time;

        if fade_duration <= 0.0 {
            return (1.0, time_from_start, time_to_end);
        }

        let fade_in = if skip_fade_in {
            1.0
        } else {
            (time_from_start / fade_duration).min(1.0)
        };

        let fade_out = if skip_fade_out {
            1.0
        } else {
            let effective_time_to_end = time_to_end + linger_duration;
            if effective_time_to_end > linger_duration {
                1.0
            } else if effective_time_to_end > 0.0 {
                (effective_time_to_end / fade_duration).min(1.0)
            } else {
                0.0
            }
        };

        (fade_in.min(fade_out).max(0.0), time_from_start, time_to_end)
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        self.has_caption = false;
        self.background_scissor = None;
        self.output_size = (output_size.x, output_size.y);

        let Some(caption_data) = &uniforms.project.captions else {
            self.current_text = None;
            return;
        };

        if !caption_data.settings.enabled {
            self.current_text = None;
            return;
        }

        let current_time = segment_frames.segment_time;
        let fade_duration = caption_data.settings.fade_duration;
        let linger_duration = caption_data.settings.linger_duration;
        let word_transition_duration = caption_data.settings.word_transition_duration;

        let Some(caption_result) = find_caption_at_time_project(
            current_time,
            &caption_data.segments,
            linger_duration,
            fade_duration,
        ) else {
            self.current_text = None;
            return;
        };

        let current_caption = caption_result.segment;
        let skip_fade_in = caption_result.skip_fade_in;
        let skip_fade_out = caption_result.skip_fade_out;

        self.update_caption(
            Some(current_caption.text.clone()),
            current_caption.start,
            current_caption.end,
        );

        let raw_caption_text = self.current_text.clone().unwrap_or_default();
        let caption_text = wrap_text_by_words(&raw_caption_text, MAX_WORDS_PER_LINE);
        let caption_words = current_caption.words.clone();
        let (fade_opacity, time_from_start, time_to_end) = self.calculate_fade_opacity(
            current_time,
            fade_duration,
            linger_duration,
            skip_fade_in,
            skip_fade_out,
        );
        if fade_opacity <= 0.0 {
            self.current_text = None;
            return;
        }

        let bounce_offset = calculate_bounce_offset(
            fade_opacity,
            time_from_start,
            time_to_end,
            fade_duration,
            skip_fade_in,
            skip_fade_out,
        );

        let (width, height) = (output_size.x, output_size.y);
        let device = &constants.device;
        let queue = &constants.queue;

        let position = CaptionPosition::from_str(&caption_data.settings.position);
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

        let font_size = caption_data.settings.size as f32 * (height as f32 / 1080.0);
        let metrics = Metrics::new(font_size, font_size * 1.2);

        let mut updated_buffer = Buffer::new(&mut self.font_system, metrics);
        let wrap_width = (width as f32 - margin * 2.0).max(font_size);
        updated_buffer.set_size(&mut self.font_system, Some(wrap_width), None);
        updated_buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);

        let font_family = match caption_data.settings.font.as_str() {
            "System Serif" => Family::Serif,
            "System Monospace" => Family::Monospace,
            _ => Family::SansSerif,
        };

        let weight = if caption_data.settings.bold {
            Weight::BOLD
        } else {
            Weight::NORMAL
        };

        let base_alpha = (fade_opacity * BASE_TEXT_OPACITY).clamp(0.0, 1.0);
        let highlight_alpha = fade_opacity.clamp(0.0, 1.0);

        if !caption_words.is_empty() {
            let mut rich_text: Vec<(&str, Attrs)> = Vec::new();
            let full_text = caption_text.as_str();
            let mut last_end = 0usize;

            for (idx, word) in caption_words.iter().enumerate() {
                if let Some(start_pos) = full_text[last_end..].find(&word.text) {
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
                        current_time,
                        word,
                        idx,
                        &caption_words,
                        word_transition_duration,
                    );

                    let blended_color = [
                        base_color[0] + (highlight_color_rgb[0] - base_color[0]) * word_highlight,
                        base_color[1] + (highlight_color_rgb[1] - base_color[1]) * word_highlight,
                        base_color[2] + (highlight_color_rgb[2] - base_color[2]) * word_highlight,
                    ];

                    let blended_alpha =
                        base_alpha + (highlight_alpha - base_alpha) * word_highlight;

                    let word_end = abs_start + word.text.len();
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

            updated_buffer.set_rich_text(
                &mut self.font_system,
                rich_text,
                &Attrs::new().family(font_family).weight(weight),
                Shaping::Advanced,
                None,
            );
        } else {
            let color = Color::rgba(
                (base_color[0] * 255.0) as u8,
                (base_color[1] * 255.0) as u8,
                (base_color[2] * 255.0) as u8,
                (base_alpha * 255.0) as u8,
            );
            let attrs = Attrs::new().family(font_family).weight(weight).color(color);
            updated_buffer.set_text(
                &mut self.font_system,
                caption_text.as_str(),
                &attrs,
                Shaping::Advanced,
            );
        }

        let mut layout_width: f32 = 0.0;
        let mut layout_height: f32 = 0.0;
        for run in LayoutRunIter::new(&updated_buffer) {
            layout_width = layout_width.max(run.line_w);
            layout_height = layout_height.max(run.line_top + run.line_height);
        }

        if layout_height == 0.0 {
            layout_height = font_size * 1.2;
            layout_width = layout_width.max(font_size);
        }

        let available_width = (width as f32 - margin * 2.0).max(1.0);
        let padding = font_size * 0.5;
        let corner_radius = font_size * 0.55;
        let text_width = layout_width.min(available_width);
        let text_height = layout_height;
        let box_width = (text_width + padding * 2.0).min(available_width).max(1.0);
        let box_height = (text_height + padding * 2.0).min(height as f32).max(1.0);

        let background_left = match position {
            CaptionPosition::TopLeft | CaptionPosition::BottomLeft => margin,
            CaptionPosition::TopRight | CaptionPosition::BottomRight => {
                (width as f32 - margin - box_width).max(0.0)
            }
            _ => ((width as f32 - box_width) / 2.0).max(0.0),
        };

        let center_y = height as f32 * position.y_factor();
        let base_background_top =
            (center_y - box_height / 2.0).clamp(0.0, (height as f32 - box_height).max(0.0));
        let background_top =
            (base_background_top + bounce_offset).clamp(0.0, (height as f32 - box_height).max(0.0));

        let text_left = background_left + padding;
        let text_top = background_top + padding;

        let bounds = TextBounds {
            left: (text_left - 2.0).floor() as i32,
            top: (text_top - 2.0).floor() as i32,
            right: (text_left + text_width + 2.0).ceil() as i32,
            bottom: (text_top + text_height + 2.0).ceil() as i32,
        };

        self.text_buffer = updated_buffer;
        self.viewport.update(queue, Resolution { width, height });

        let mut text_areas = Vec::new();

        let outline_color = Color::rgba(
            (outline_color_rgb[0] * 255.0) as u8,
            (outline_color_rgb[1] * 255.0) as u8,
            (outline_color_rgb[2] * 255.0) as u8,
            (fade_opacity * 255.0) as u8,
        );

        if caption_data.settings.outline {
            let outline_thickness = 1.2;
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
                    buffer: &self.text_buffer,
                    left: text_left + offset_x,
                    top: text_top + offset_y,
                    scale: 1.0,
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
            buffer: &self.text_buffer,
            left: text_left,
            top: text_top,
            scale: 1.0,
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

        let rect = CaptionBackgroundUniforms {
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
            self.has_caption = false;
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
            self.has_caption = false;
            return;
        }

        self.background_scissor = Some([scissor_x, scissor_y, scissor_width, scissor_height]);
        self.has_caption = true;
    }

    pub fn has_content(&self) -> bool {
        self.has_caption
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if !self.has_caption {
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
            Err(e) => warn!("Error rendering text: {e:?}"),
        }

        if self.output_size.0 > 0 && self.output_size.1 > 0 {
            pass.set_scissor_rect(0, 0, self.output_size.0, self.output_size.1);
        }
    }
}

pub fn find_caption_at_time(time: f32, segments: &[CaptionSegment]) -> Option<&CaptionSegment> {
    segments
        .iter()
        .find(|segment| time >= segment.start && time < segment.end)
}

pub struct CaptionAtTime {
    pub segment: CaptionSegment,
    pub skip_fade_in: bool,
    pub skip_fade_out: bool,
}

const CLOSE_TRANSITION_THRESHOLD: f32 = 0.4;

fn convert_project_segment(segment: &cap_project::CaptionSegment) -> CaptionSegment {
    CaptionSegment {
        id: segment.id.clone(),
        start: segment.start,
        end: segment.end,
        text: segment.text.clone(),
        words: segment
            .words
            .iter()
            .map(|w| CaptionWord {
                text: w.text.clone(),
                start: w.start,
                end: w.end,
            })
            .collect(),
    }
}

pub fn find_caption_at_time_project(
    time: f32,
    segments: &[cap_project::CaptionSegment],
    linger_duration: f32,
    fade_duration: f32,
) -> Option<CaptionAtTime> {
    let extended_end = linger_duration + fade_duration;

    for (idx, segment) in segments.iter().enumerate() {
        if time >= segment.start && time < segment.end {
            let prev_segment = if idx > 0 {
                Some(&segments[idx - 1])
            } else {
                None
            };
            let next_segment = segments.get(idx + 1);

            let skip_fade_in = prev_segment
                .map(|prev| segment.start - prev.end < CLOSE_TRANSITION_THRESHOLD)
                .unwrap_or(false);
            let skip_fade_out = next_segment
                .map(|next| next.start - segment.end < CLOSE_TRANSITION_THRESHOLD)
                .unwrap_or(false);

            return Some(CaptionAtTime {
                segment: convert_project_segment(segment),
                skip_fade_in,
                skip_fade_out,
            });
        }
    }

    for (idx, segment) in segments.iter().enumerate() {
        if time >= segment.end && time < segment.end + extended_end {
            let prev_segment = if idx > 0 {
                Some(&segments[idx - 1])
            } else {
                None
            };
            let next_segment = segments.get(idx + 1);

            let skip_fade_in = prev_segment
                .map(|prev| segment.start - prev.end < CLOSE_TRANSITION_THRESHOLD)
                .unwrap_or(false);
            let skip_fade_out = next_segment
                .map(|next| next.start - segment.end < CLOSE_TRANSITION_THRESHOLD)
                .unwrap_or(false);

            return Some(CaptionAtTime {
                segment: convert_project_segment(segment),
                skip_fade_in,
                skip_fade_out,
            });
        }
    }

    None
}
