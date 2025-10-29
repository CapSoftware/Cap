use super::caption_background::{CaptionBackgroundPipeline, CaptionBackgroundUniforms};
use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};

#[derive(Debug, Clone)]
pub struct CaptionWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
}
use log::warn;
use wgpu::{Device, Queue, util::DeviceExt};

use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants};

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
            position: 2,
            outline: 1,
            outline_color: [0.0, 0.0, 0.0, 1.0],
            font: 0,
            _padding: [0.0],
        }
    }
}

pub struct CaptionsLayer {
    settings_buffer: wgpu::Buffer,
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    current_caption: Option<CaptionSegment>,
    next_caption: Option<CaptionSegment>,
    current_time: f32,
    word_buffers: Vec<(Buffer, usize)>,
    next_word_buffers: Vec<(Buffer, usize)>,
    background_pipeline: CaptionBackgroundPipeline,
    current_background_uniforms_buffer: Option<wgpu::Buffer>,
    current_background_bind_group: Option<wgpu::BindGroup>,
    current_background_info: Option<BackgroundInfo>,
    next_background_uniforms_buffer: Option<wgpu::Buffer>,
    next_background_bind_group: Option<wgpu::BindGroup>,
    next_background_info: Option<BackgroundInfo>,
}

#[derive(Debug, Clone)]
struct BackgroundInfo {
    position: [f32; 2],
    size: [f32; 2],
    opacity: f32,
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

        let background_pipeline = CaptionBackgroundPipeline::new(device);

        Self {
            settings_buffer,
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            viewport,
            current_caption: None,
            next_caption: None,
            current_time: 0.0,
            word_buffers: Vec::new(),
            next_word_buffers: Vec::new(),
            background_pipeline,
            current_background_uniforms_buffer: None,
            current_background_bind_group: None,
            current_background_info: None,
            next_background_uniforms_buffer: None,
            next_background_bind_group: None,
            next_background_info: None,
        }
    }

    pub fn update_settings(&mut self, queue: &Queue, settings: CaptionSettings) {
        queue.write_buffer(&self.settings_buffer, 0, bytemuck::cast_slice(&[settings]));
    }

    pub fn update_current_caption(
        &mut self,
        current_time: f32,
        segments: &[cap_project::CaptionSegment],
    ) {
        self.current_time = current_time;
        const TRANSITION_DURATION: f32 = 0.25;

        let mut visible_captions: Vec<CaptionSegment> = segments
            .iter()
            .filter(|segment| {
                let in_fade_in = current_time >= segment.start - TRANSITION_DURATION
                    && current_time < segment.start;
                let in_main = current_time >= segment.start && current_time <= segment.end;
                let in_fade_out =
                    current_time > segment.end && current_time <= segment.end + TRANSITION_DURATION;

                in_fade_in || in_main || in_fade_out
            })
            .map(|segment| CaptionSegment {
                id: segment.id.clone(),
                start: segment.start,
                end: segment.end,
                text: segment.text.clone(),
                words: segment
                    .words
                    .iter()
                    .map(|word| CaptionWord {
                        text: word.text.clone(),
                        start: word.start,
                        end: word.end,
                    })
                    .collect(),
            })
            .collect();

        visible_captions.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());

        let before_dedup = visible_captions.len();
        visible_captions.dedup_by(|a, b| a.id == b.id);
        if before_dedup != visible_captions.len() {
            log::warn!(
                "Removed {} duplicate captions",
                before_dedup - visible_captions.len()
            );
        }

        if !visible_captions.is_empty() {
            log::debug!(
                "Visible captions at time {:.2}: {:?}",
                current_time,
                visible_captions
                    .iter()
                    .map(|c| (&c.id, c.start, c.end))
                    .collect::<Vec<_>>()
            );
        }

        if visible_captions.len() >= 2 {
            let first = &visible_captions[0];
            let second = &visible_captions[1];

            let gap = second.start - first.end;
            let crossfade_window = TRANSITION_DURATION * 2.0;

            let captions_are_adjacent = gap < crossfade_window;

            let in_crossfade = if !captions_are_adjacent {
                false
            } else if gap <= 0.0 {
                current_time >= second.start && current_time <= first.end
            } else {
                current_time >= first.end - TRANSITION_DURATION
                    && current_time < second.start + TRANSITION_DURATION
            };

            log::info!(
                "Caption timing - current: {:.2}, first: {:.2}-{:.2}, second: {:.2}-{:.2}, gap: {:.2}, in_crossfade: {}",
                current_time,
                first.start,
                first.end,
                second.start,
                second.end,
                gap,
                in_crossfade
            );

            if in_crossfade {
                log::info!(
                    "CROSSFADING at time {:.2}: '{}' -> '{}'",
                    current_time,
                    first.text,
                    second.text
                );
                self.current_caption = Some(first.clone());
                self.next_caption = Some(second.clone());
            } else if current_time >= second.start && captions_are_adjacent {
                self.current_caption = Some(second.clone());
                self.next_caption = None;
            } else {
                if current_time < first.end + TRANSITION_DURATION {
                    self.current_caption = Some(first.clone());
                    self.next_caption = None;
                } else if current_time >= second.start - TRANSITION_DURATION {
                    self.current_caption = Some(second.clone());
                    self.next_caption = None;
                } else {
                    self.current_caption = None;
                    self.next_caption = None;
                }
            }
        } else if visible_captions.len() == 1 {
            let is_last = segments
                .last()
                .map(|last| last.id == visible_captions[0].id)
                .unwrap_or(false);
            if is_last {
                log::debug!(
                    "Showing last caption: {} at time {:.2}",
                    visible_captions[0].id,
                    current_time
                );
            }
            self.current_caption = Some(visible_captions[0].clone());
            self.next_caption = None;
        } else {
            self.current_caption = None;
            self.next_caption = None;
        }
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        self.word_buffers.clear();
        self.next_word_buffers.clear();
        self.current_background_uniforms_buffer = None;
        self.current_background_bind_group = None;
        self.current_background_info = None;
        self.next_background_uniforms_buffer = None;
        self.next_background_bind_group = None;
        self.next_background_info = None;

        let Some(caption_data) = &uniforms.project.captions else {
            return;
        };
        if !caption_data.settings.enabled {
            return;
        }

        let current_time = segment_frames.segment_time;

        self.update_current_caption(current_time, &caption_data.segments);

        if self.current_caption.is_none() && self.next_caption.is_none() {
            return;
        };

        let (width, height) = (output_size.x, output_size.y);
        let device = &constants.device;
        let queue = &constants.queue;

        self.viewport.update(queue, Resolution { width, height });

        let mut all_text_areas = Vec::new();
        let transition_duration = 0.25;

        if let Some(ref current_caption) = self.current_caption {
            let segment_duration = current_caption.end - current_caption.start;
            let relative_time = current_time - current_caption.start;

            let mut current_opacity = 1.0;
            let mut y_offset = 0.0;
            let mut blur_amount = 0.0;

            if let Some(ref next_caption) = self.next_caption {
                let gap = next_caption.start - current_caption.end;

                if gap <= 0.0 {
                    if current_time >= next_caption.start && current_time <= current_caption.end {
                        let overlap_duration = current_caption.end - next_caption.start;
                        let overlap_progress =
                            (current_time - next_caption.start) / overlap_duration;

                        current_opacity = 1.0 - overlap_progress;
                        current_opacity = current_opacity.clamp(0.0, 1.0);

                        current_opacity = current_opacity * current_opacity;

                        y_offset = -5.0 * (1.0 - current_opacity);
                        blur_amount = 2.0 * (1.0 - current_opacity);

                        log::info!(
                            "Current caption crossfading out (overlap): opacity = {:.2}, progress = {:.2}",
                            current_opacity,
                            overlap_progress
                        );
                    }
                } else {
                    let crossfade_start = current_caption.end - transition_duration;
                    let crossfade_end = next_caption.start + transition_duration;

                    if current_time >= crossfade_start && current_time <= crossfade_end {
                        let crossfade_duration = crossfade_end - crossfade_start;
                        let crossfade_progress =
                            (current_time - crossfade_start) / crossfade_duration;

                        current_opacity = 1.0 - crossfade_progress;
                        current_opacity = current_opacity.clamp(0.0, 1.0);

                        current_opacity = current_opacity * current_opacity;

                        y_offset = -5.0 * (1.0 - current_opacity);
                        blur_amount = 2.0 * (1.0 - current_opacity);

                        log::info!(
                            "Current caption crossfading out: opacity = {:.2}, progress = {:.2}",
                            current_opacity,
                            crossfade_progress
                        );
                    }
                }
            } else {
                let fade_duration = (segment_duration * 0.5).min(transition_duration);

                if fade_duration > 0.0 && relative_time < fade_duration {
                    let progress = (relative_time / fade_duration).clamp(0.0, 1.0);
                    let ease_progress = progress * progress;
                    current_opacity = ease_progress;
                    y_offset = 5.0 * (1.0 - ease_progress);
                    blur_amount = 2.0 * (1.0 - ease_progress);
                } else if fade_duration > 0.0
                    && relative_time > segment_duration - fade_duration
                    && relative_time <= segment_duration
                {
                    let remaining = (segment_duration - relative_time).max(0.0);
                    let progress = (remaining / fade_duration).clamp(0.0, 1.0);
                    let ease_progress = progress * progress;
                    current_opacity = ease_progress;
                    y_offset = -5.0 * (1.0 - ease_progress);
                    blur_amount = 2.0 * (1.0 - ease_progress);
                } else if relative_time > segment_duration {
                    current_opacity = 0.0;
                } else {
                    current_opacity = 1.0;
                }
            }

            if current_opacity > 0.01 {
                let base_size = caption_data.settings.size as f32 * 1.8;
                let scale_factor = (height as f32 / 1080.0).max(1.0);
                let font_size = base_size * scale_factor;
                let base_y_position = match caption_data.settings.position.as_str() {
                    "top" => height as f32 * 0.1,
                    "middle" => height as f32 * 0.5,
                    _ => height as f32 * 0.85,
                };
                let y_position = base_y_position + y_offset;

                let active_word_idx = current_caption
                    .words
                    .iter()
                    .position(|word| current_time >= word.start && current_time < word.end);

                let line_height = font_size * 1.2;
                let metrics = Metrics::new(font_size, line_height);
                let effective_opacity = current_opacity * (1.0 - blur_amount * 0.3);
                let text_opacity = (effective_opacity * 255.0) as u8;

                let inactive_color = Color::rgba(200, 200, 200, text_opacity);
                let active_color = Color::rgba(255, 255, 255, text_opacity);

                let full_text = if current_caption.words.is_empty() {
                    current_caption.text.clone()
                } else {
                    current_caption
                        .words
                        .iter()
                        .enumerate()
                        .map(|(i, word)| {
                            if i == 0 {
                                word.text.clone()
                            } else {
                                format!(" {}", word.text)
                            }
                        })
                        .collect::<String>()
                };

                let mut measure_buffer = Buffer::new(&mut self.font_system, metrics);
                measure_buffer.set_size(&mut self.font_system, None, None);
                measure_buffer.set_text(
                    &mut self.font_system,
                    &full_text,
                    &Attrs::new()
                        .family(Family::SansSerif)
                        .weight(Weight::NORMAL),
                    Shaping::Advanced,
                );

                let mut buffer = Buffer::new(&mut self.font_system, metrics);
                buffer.set_size(&mut self.font_system, None, None);

                let mut spans = Vec::new();

                if current_caption.words.is_empty() {
                    let color = inactive_color;
                    spans.push((
                        current_caption.text.as_str(),
                        Attrs::new()
                            .family(Family::SansSerif)
                            .weight(Weight::NORMAL)
                            .color(color),
                    ));
                } else {
                    for (i, word) in current_caption.words.iter().enumerate() {
                        if i > 0 {
                            spans.push((
                                " ",
                                Attrs::new()
                                    .family(Family::SansSerif)
                                    .weight(Weight::NORMAL)
                                    .color(inactive_color),
                            ));
                        }

                        let is_active = active_word_idx == Some(i);
                        let color = if is_active {
                            active_color
                        } else {
                            inactive_color
                        };

                        spans.push((
                            word.text.as_str(),
                            Attrs::new()
                                .family(Family::SansSerif)
                                .weight(Weight::NORMAL)
                                .color(color),
                        ));
                    }
                }

                buffer.set_rich_text(
                    &mut self.font_system,
                    spans,
                    &Attrs::new()
                        .family(Family::SansSerif)
                        .weight(Weight::NORMAL),
                    Shaping::Advanced,
                    None,
                );

                self.word_buffers.push((buffer, 0));

                if !self.word_buffers.is_empty() {
                    let mut text_areas = Vec::new();

                    let measure_width = measure_buffer
                        .layout_runs()
                        .next()
                        .map(|r| r.line_w)
                        .unwrap_or(0.0);

                    let total_width = measure_width;

                    let start_x = (width as f32 - total_width) / 2.0;
                    let _text_height = font_size * 1.5;

                    let h_padding = 40.0;
                    let v_padding_top = 20.0;
                    let v_padding_bottom = 28.0;
                    let bg_opacity =
                        (caption_data.settings.background_opacity as f32 / 100.0) * current_opacity;

                    if bg_opacity > 0.1 {
                        let bg_center_y = y_position - v_padding_top
                            + (font_size + v_padding_top + v_padding_bottom) / 2.0;
                        self.current_background_info = Some(BackgroundInfo {
                            position: [start_x + total_width / 2.0, bg_center_y],
                            size: [
                                total_width + h_padding * 2.0,
                                font_size + v_padding_top + v_padding_bottom,
                            ],
                            opacity: bg_opacity,
                        });

                        let bg_uniforms = CaptionBackgroundUniforms {
                            position: [start_x + total_width / 2.0, bg_center_y],
                            size: [
                                total_width + h_padding * 2.0,
                                font_size + v_padding_top + v_padding_bottom,
                            ],
                            color: [0.0, 0.0, 0.0, bg_opacity],
                            corner_radius: 12.0,
                            _padding1: [0.0],
                            viewport_size: [width as f32, height as f32],
                            _padding2: 0.0,
                            _padding3: [0.0, 0.0, 0.0],
                            _padding4: [0.0, 0.0, 0.0, 0.0],
                        };

                        let uniforms_buffer =
                            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("Current Caption Background Uniforms"),
                                contents: bytemuck::cast_slice(&[bg_uniforms]),
                                usage: wgpu::BufferUsages::UNIFORM,
                            });

                        let bind_group = self
                            .background_pipeline
                            .create_bind_group(device, &uniforms_buffer);

                        self.current_background_uniforms_buffer = Some(uniforms_buffer);
                        self.current_background_bind_group = Some(bind_group);
                    }

                    if let Some((buffer, _)) = self.word_buffers.first() {
                        let text_bounds = TextBounds {
                            left: start_x.floor() as i32,
                            top: (y_position - 10.0) as i32,
                            right: (start_x + total_width).ceil() as i32,
                            bottom: (y_position + font_size * 1.3) as i32,
                        };

                        let color = if active_word_idx.is_some() {
                            Color::rgba(255, 255, 255, text_opacity)
                        } else {
                            Color::rgba(200, 200, 200, text_opacity)
                        };

                        text_areas.push(TextArea {
                            buffer,
                            left: start_x.floor(),
                            top: y_position.floor(),
                            scale: 1.0,
                            bounds: text_bounds,
                            default_color: color,
                            custom_glyphs: &[],
                        });
                    }

                    all_text_areas.extend(text_areas);
                }
            }
        }

        if let Some(ref next_caption) = self.next_caption {
            if let Some(ref current_caption) = self.current_caption {
                let gap = next_caption.start - current_caption.end;

                let mut next_opacity = 0.0;
                let mut y_offset = 0.0;
                let mut blur_amount = 0.0;

                if gap <= 0.0 {
                    if current_time >= next_caption.start && current_time <= current_caption.end {
                        let overlap_duration = current_caption.end - next_caption.start;
                        let overlap_progress =
                            (current_time - next_caption.start) / overlap_duration;

                        next_opacity = overlap_progress;
                        next_opacity = next_opacity.clamp(0.0, 1.0);

                        next_opacity = next_opacity * next_opacity;

                        y_offset = 5.0 * (1.0 - next_opacity);
                        blur_amount = 2.0 * (1.0 - next_opacity);

                        log::info!(
                            "Next caption crossfading in (overlap): opacity = {:.2}, progress = {:.2}",
                            next_opacity,
                            overlap_progress
                        );
                    } else {
                        log::info!("Next caption not in overlap zone");
                    }
                } else {
                    let crossfade_start = current_caption.end - transition_duration;
                    let crossfade_end = next_caption.start + transition_duration;

                    if current_time >= crossfade_start && current_time <= crossfade_end {
                        let crossfade_duration = crossfade_end - crossfade_start;
                        let crossfade_progress =
                            (current_time - crossfade_start) / crossfade_duration;

                        next_opacity = crossfade_progress;
                        next_opacity = next_opacity.clamp(0.0, 1.0);

                        next_opacity = next_opacity * next_opacity;

                        y_offset = 5.0 * (1.0 - next_opacity);
                        blur_amount = 2.0 * (1.0 - next_opacity);

                        log::info!(
                            "Next caption crossfading in: opacity = {:.2}, progress = {:.2}",
                            next_opacity,
                            crossfade_progress
                        );
                    } else {
                        log::info!("Next caption not in crossfade zone");
                    }
                }

                if next_opacity > 0.01 {
                    let base_size = caption_data.settings.size as f32 * 1.8;
                    let scale_factor = (height as f32 / 1080.0).max(1.0);
                    let font_size = base_size * scale_factor;
                    let base_y_position = match caption_data.settings.position.as_str() {
                        "top" => height as f32 * 0.1,
                        "middle" => height as f32 * 0.5,
                        _ => height as f32 * 0.85,
                    };
                    let y_position = base_y_position + y_offset;

                    let active_word_idx = next_caption
                        .words
                        .iter()
                        .position(|word| current_time >= word.start && current_time < word.end);

                    let line_height = font_size * 1.2;
                    let metrics = Metrics::new(font_size, line_height);
                    let effective_opacity = next_opacity * (1.0 - blur_amount * 0.3);
                    let text_opacity = (effective_opacity * 255.0) as u8;

                    let inactive_color = Color::rgba(200, 200, 200, text_opacity);
                    let active_color = Color::rgba(255, 255, 255, text_opacity);

                    let full_text = if next_caption.words.is_empty() {
                        next_caption.text.clone()
                    } else {
                        next_caption
                            .words
                            .iter()
                            .enumerate()
                            .map(|(i, word)| {
                                if i == 0 {
                                    word.text.clone()
                                } else {
                                    format!(" {}", word.text)
                                }
                            })
                            .collect::<String>()
                    };

                    let mut measure_buffer = Buffer::new(&mut self.font_system, metrics);
                    measure_buffer.set_size(&mut self.font_system, None, None);
                    measure_buffer.set_text(
                        &mut self.font_system,
                        &full_text,
                        &Attrs::new()
                            .family(Family::SansSerif)
                            .weight(Weight::NORMAL),
                        Shaping::Advanced,
                    );

                    let mut temp_buffers = Vec::new();
                    let mut buffer = Buffer::new(&mut self.font_system, metrics);
                    buffer.set_size(&mut self.font_system, None, None);

                    let mut spans = Vec::new();

                    if next_caption.words.is_empty() {
                        let color = inactive_color;
                        spans.push((
                            next_caption.text.as_str(),
                            Attrs::new()
                                .family(Family::SansSerif)
                                .weight(Weight::NORMAL)
                                .color(color),
                        ));
                    } else {
                        for (i, word) in next_caption.words.iter().enumerate() {
                            if i > 0 {
                                spans.push((
                                    " ",
                                    Attrs::new()
                                        .family(Family::SansSerif)
                                        .weight(Weight::NORMAL)
                                        .color(inactive_color),
                                ));
                            }

                            let is_active = active_word_idx == Some(i);
                            let color = if is_active {
                                active_color
                            } else {
                                inactive_color
                            };

                            spans.push((
                                word.text.as_str(),
                                Attrs::new()
                                    .family(Family::SansSerif)
                                    .weight(Weight::NORMAL)
                                    .color(color),
                            ));
                        }
                    }

                    buffer.set_rich_text(
                        &mut self.font_system,
                        spans,
                        &Attrs::new()
                            .family(Family::SansSerif)
                            .weight(Weight::NORMAL),
                        Shaping::Advanced,
                        None,
                    );

                    temp_buffers.push((buffer, 0));

                    if !temp_buffers.is_empty() {
                        self.next_word_buffers = temp_buffers;

                        let mut text_areas = Vec::new();

                        let measure_width = measure_buffer
                            .layout_runs()
                            .next()
                            .map(|r| r.line_w)
                            .unwrap_or(0.0);

                        let total_width = measure_width;

                        let start_x = (width as f32 - total_width) / 2.0;

                        let h_padding = 40.0;
                        let v_padding_top = 20.0;
                        let v_padding_bottom = 28.0;
                        let bg_opacity = (caption_data.settings.background_opacity as f32 / 100.0)
                            * next_opacity;

                        if bg_opacity > 0.01 {
                            let bg_center_y = y_position - v_padding_top
                                + (font_size + v_padding_top + v_padding_bottom) / 2.0;
                            self.next_background_info = Some(BackgroundInfo {
                                position: [start_x + total_width / 2.0, bg_center_y],
                                size: [
                                    total_width + h_padding * 2.0,
                                    font_size + v_padding_top + v_padding_bottom,
                                ],
                                opacity: bg_opacity,
                            });

                            let bg_uniforms = CaptionBackgroundUniforms {
                                position: [start_x + total_width / 2.0, bg_center_y],
                                size: [
                                    total_width + h_padding * 2.0,
                                    font_size + v_padding_top + v_padding_bottom,
                                ],
                                color: [0.0, 0.0, 0.0, bg_opacity],
                                corner_radius: 12.0,
                                _padding1: [0.0],
                                viewport_size: [width as f32, height as f32],
                                _padding2: 0.0,
                                _padding3: [0.0, 0.0, 0.0],
                                _padding4: [0.0, 0.0, 0.0, 0.0],
                            };

                            let uniforms_buffer =
                                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: Some("Next Caption Background Uniforms"),
                                    contents: bytemuck::cast_slice(&[bg_uniforms]),
                                    usage: wgpu::BufferUsages::UNIFORM,
                                });

                            let bind_group = self
                                .background_pipeline
                                .create_bind_group(device, &uniforms_buffer);

                            self.next_background_uniforms_buffer = Some(uniforms_buffer);
                            self.next_background_bind_group = Some(bind_group);
                        }

                        if let Some((buffer, _)) = self.next_word_buffers.first() {
                            let text_bounds = TextBounds {
                                left: start_x.floor() as i32,
                                top: (y_position - 10.0) as i32,
                                right: (start_x + total_width).ceil() as i32,
                                bottom: (y_position + font_size * 1.3) as i32,
                            };

                            let color = if active_word_idx.is_some() {
                                Color::rgba(255, 255, 255, text_opacity)
                            } else {
                                Color::rgba(200, 200, 200, text_opacity)
                            };

                            text_areas.push(TextArea {
                                buffer,
                                left: start_x.floor(),
                                top: y_position.floor(),
                                scale: 1.0,
                                bounds: text_bounds,
                                default_color: color,
                                custom_glyphs: &[],
                            });
                        }

                        all_text_areas.extend(text_areas);
                    }
                }
            }
        }

        if !all_text_areas.is_empty() {
            if let Err(e) = self.text_renderer.prepare(
                device,
                queue,
                &mut self.font_system,
                &mut self.text_atlas,
                &self.viewport,
                all_text_areas,
                &mut self.swash_cache,
            ) {
                warn!("Caption text preparation failed: {:?}", e);
            }
        }
    }

    pub fn render_background<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let (Some(bind_group), Some(_)) = (
            &self.current_background_bind_group,
            &self.current_background_info,
        ) {
            self.background_pipeline.render(pass, bind_group);
        }

        if let (Some(bind_group), Some(_)) =
            (&self.next_background_bind_group, &self.next_background_info)
        {
            self.background_pipeline.render(pass, bind_group);
        }
    }

    pub fn render_text<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if (!self.word_buffers.is_empty() && self.current_caption.is_some())
            || (!self.next_word_buffers.is_empty() && self.next_caption.is_some())
        {
            if let Err(e) = self
                .text_renderer
                .render(&self.text_atlas, &self.viewport, pass)
            {
                warn!("Caption text rendering failed: {:?}", e);
            }
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
                .map(|word| CaptionWord {
                    text: word.text.clone(),
                    start: word.start,
                    end: word.end,
                })
                .collect(),
        })
}
