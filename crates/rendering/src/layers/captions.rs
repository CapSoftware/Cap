use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::cosmic_text::LayoutRunIter;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{include_wgsl, util::DeviceExt, Device, Queue};

use crate::{parse_color_component, DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants};

#[derive(Debug, Clone)]
pub struct CaptionWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
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

    fn _x_alignment(&self) -> f32 {
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
    _settings_buffer: wgpu::Buffer,
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
        let mut text_atlas = TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8Unorm);
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

        let Some(active) =
            find_active_caption_segment(current_time, &timeline.caption_segments, default_fade)
        else {
            self.current_text = None;
            return;
        };

        let segment_fade = active
            .segment
            .fade_duration_override
            .unwrap_or(default_fade) as f64;

        self.update_caption(
            Some(active.segment.text.clone()),
            active.segment.start as f32,
            active.segment.end as f32,
        );

        let raw_caption_text = self.current_text.clone().unwrap_or_default();
        let caption_text = wrap_text_by_words(&raw_caption_text, MAX_WORDS_PER_LINE);
        let caption_words: Vec<CaptionWord> = active
            .segment
            .words
            .iter()
            .map(|w| CaptionWord {
                text: w.text.clone(),
                start: w.start,
                end: w.end,
            })
            .collect();

        let fade_opacity = calculate_caption_fade(
            current_time,
            active.segment.start,
            active.segment.end,
            segment_fade,
        );
        if fade_opacity <= 0.0 {
            self.current_text = None;
            return;
        }

        let bounce_offset = calculate_caption_bounce(
            current_time,
            active.segment.start,
            active.segment.end,
            segment_fade,
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

        let weight = if caption_data.settings.font_weight >= 700 {
            Weight::BOLD
        } else if caption_data.settings.font_weight >= 500 {
            Weight::MEDIUM
        } else {
            Weight::NORMAL
        };

        let base_alpha = (fade_opacity * BASE_TEXT_OPACITY).clamp(0.0, 1.0);
        let highlight_alpha = fade_opacity.clamp(0.0, 1.0);

        let active_word_highlight_enabled = caption_data.settings.active_word_highlight;

        if !caption_words.is_empty() && active_word_highlight_enabled {
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
                        current_time as f32,
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
                (highlight_color_rgb[0] * 255.0) as u8,
                (highlight_color_rgb[1] * 255.0) as u8,
                (highlight_color_rgb[2] * 255.0) as u8,
                (highlight_alpha * 255.0) as u8,
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
        let background_top = (base_background_top + bounce_offset as f32)
            .clamp(0.0, (height as f32 - box_height).max(0.0));

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

struct ActiveCaptionSegment<'a> {
    segment: &'a cap_project::CaptionTrackSegment,
}

fn find_active_caption_segment<'a>(
    time: f64,
    segments: &'a [cap_project::CaptionTrackSegment],
    default_fade_duration: f32,
) -> Option<ActiveCaptionSegment<'a>> {
    for segment in segments {
        if time >= segment.start && time < segment.end {
            return Some(ActiveCaptionSegment { segment });
        }
    }

    for segment in segments {
        let fade = segment
            .fade_duration_override
            .unwrap_or(default_fade_duration) as f64;
        if time >= segment.end && time < segment.end + fade {
            return Some(ActiveCaptionSegment { segment });
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
