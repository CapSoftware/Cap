use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::{debug, warn};
use wgpu::{Device, Queue, util::DeviceExt};

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
            background_color: [0.0, 0.0, 0.0, 0.8],
            position: 5,
            outline: 1,
            outline_color: [0.0, 0.0, 0.0, 1.0],
            font: 0,
            _padding: [0.0],
        }
    }
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

    fn calculate_fade_opacity(&self, current_time: f32, fade_duration: f32) -> f32 {
        if fade_duration <= 0.0 {
            return 1.0;
        }

        let time_from_start = current_time - self.current_segment_start;
        let time_to_end = self.current_segment_end - current_time;

        let fade_in = (time_from_start / fade_duration).min(1.0);
        let fade_out = (time_to_end / fade_duration).min(1.0);

        fade_in.min(fade_out).max(0.0)
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        if let Some(caption_data) = &uniforms.project.captions {
            if !caption_data.settings.enabled {
                return;
            }

            let current_time = segment_frames.segment_time;
            let fade_duration = caption_data.settings.fade_duration;

            if let Some(current_caption) =
                find_caption_at_time_project(current_time, &caption_data.segments)
            {
                let caption_text = current_caption.text.clone();
                let caption_words = current_caption.words.clone();
                self.update_caption(
                    Some(caption_text.clone()),
                    current_caption.start,
                    current_caption.end,
                );

                let fade_opacity = self.calculate_fade_opacity(current_time, fade_duration);

                if let Some(text) = &self.current_text {
                    let (width, height) = (output_size.x, output_size.y);
                    let device = &constants.device;
                    let queue = &constants.queue;

                    let position = CaptionPosition::from_str(&caption_data.settings.position);
                    let y_position = height as f32 * position.y_factor();

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

                    let _bg_opacity =
                        (caption_data.settings.background_opacity as f32 / 100.0) * fade_opacity;

                    let font_size = caption_data.settings.size as f32 * (height as f32 / 1080.0);
                    let metrics = Metrics::new(font_size, font_size * 1.2);

                    let mut updated_buffer = Buffer::new(&mut self.font_system, metrics);

                    let text_width = width as f32 * 0.9;
                    updated_buffer.set_size(&mut self.font_system, Some(text_width), None);
                    updated_buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);

                    let x_offset = match position.x_alignment() {
                        x if x < 0.3 => (width as f32 * 0.05) as i32,
                        x if x > 0.7 => (width as f32 * 0.05) as i32,
                        _ => ((width as f32 - text_width) / 2.0) as i32,
                    };

                    let bounds = TextBounds {
                        left: x_offset,
                        top: y_position as i32,
                        right: (x_offset as f32 + text_width) as i32,
                        bottom: (y_position + font_size * 4.0) as i32,
                    };

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

                    if !caption_words.is_empty() {
                        let current_word_idx = caption_words
                            .iter()
                            .position(|w| current_time >= w.start && current_time < w.end);

                        let mut rich_text: Vec<(&str, Attrs)> = Vec::new();
                        let full_text = text.as_str();
                        let mut last_end = 0usize;

                        for (idx, word) in caption_words.iter().enumerate() {
                            if let Some(start_pos) = full_text[last_end..].find(&word.text) {
                                let abs_start = last_end + start_pos;

                                if abs_start > last_end {
                                    let space = &full_text[last_end..abs_start];
                                    rich_text.push((
                                        space,
                                        Attrs::new().family(font_family).weight(weight).color(
                                            Color::rgba(
                                                (base_color[0] * 255.0) as u8,
                                                (base_color[1] * 255.0) as u8,
                                                (base_color[2] * 255.0) as u8,
                                                (fade_opacity * 255.0) as u8,
                                            ),
                                        ),
                                    ));
                                }

                                let is_current = Some(idx) == current_word_idx;
                                let word_color = if is_current {
                                    Color::rgba(
                                        (highlight_color_rgb[0] * 255.0) as u8,
                                        (highlight_color_rgb[1] * 255.0) as u8,
                                        (highlight_color_rgb[2] * 255.0) as u8,
                                        (fade_opacity * 255.0) as u8,
                                    )
                                } else {
                                    Color::rgba(
                                        (base_color[0] * 255.0) as u8,
                                        (base_color[1] * 255.0) as u8,
                                        (base_color[2] * 255.0) as u8,
                                        (fade_opacity * 255.0) as u8,
                                    )
                                };

                                let word_end = abs_start + word.text.len();
                                rich_text.push((
                                    &full_text[abs_start..word_end],
                                    Attrs::new()
                                        .family(font_family)
                                        .weight(weight)
                                        .color(word_color),
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
                                        (fade_opacity * 255.0) as u8,
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
                            (fade_opacity * 255.0) as u8,
                        );
                        let attrs = Attrs::new().family(font_family).weight(weight).color(color);
                        updated_buffer.set_text(
                            &mut self.font_system,
                            text,
                            &attrs,
                            Shaping::Advanced,
                        );
                    }

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
                        let outline_offsets = [
                            (-1.5, -1.5),
                            (0.0, -1.5),
                            (1.5, -1.5),
                            (-1.5, 0.0),
                            (1.5, 0.0),
                            (-1.5, 1.5),
                            (0.0, 1.5),
                            (1.5, 1.5),
                        ];

                        for (offset_x, offset_y) in outline_offsets.iter() {
                            text_areas.push(TextArea {
                                buffer: &self.text_buffer,
                                left: bounds.left as f32 + offset_x,
                                top: y_position + offset_y,
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
                        (fade_opacity * 255.0) as u8,
                    );

                    text_areas.push(TextArea {
                        buffer: &self.text_buffer,
                        left: bounds.left as f32,
                        top: y_position,
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
                }
            }
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        match self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            Ok(_) => {}
            Err(e) => warn!("Error rendering text: {e:?}"),
        }
    }
}

pub fn find_caption_at_time(time: f32, segments: &[CaptionSegment]) -> Option<&CaptionSegment> {
    segments
        .iter()
        .find(|segment| time >= segment.start && time < segment.end)
}

pub fn find_caption_at_time_project(
    time: f32,
    segments: &[cap_project::CaptionSegment],
) -> Option<CaptionSegment> {
    segments
        .iter()
        .find(|segment| time >= segment.start && time < segment.end)
        .map(|segment| CaptionSegment {
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
        })
}
