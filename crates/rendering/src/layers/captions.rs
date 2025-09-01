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
use log::{debug, info, warn};
use wgpu::{Device, Queue, util::DeviceExt};

use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, parse_color_component};

/// Represents a caption segment with timing and text
#[derive(Debug, Clone)]
pub struct CaptionSegment {
    pub id: String,
    pub start: f32,
    pub end: f32,
    pub text: String,
    pub words: Vec<CaptionWord>,
}

/// Settings for caption rendering
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable, Debug)]
pub struct CaptionSettings {
    pub enabled: u32, // 0 = disabled, 1 = enabled
    pub font_size: f32,
    pub color: [f32; 4],
    pub background_color: [f32; 4],
    pub position: u32, // 0 = top, 1 = middle, 2 = bottom
    pub outline: u32,  // 0 = disabled, 1 = enabled
    pub outline_color: [f32; 4],
    pub font: u32,          // 0 = SansSerif, 1 = Serif, 2 = Monospace
    pub _padding: [f32; 1], // for alignment
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: 1,
            font_size: 24.0,
            color: [1.0, 1.0, 1.0, 1.0],            // white
            background_color: [0.0, 0.0, 0.0, 0.8], // 80% black
            position: 2,                            // bottom
            outline: 1,                             // enabled
            outline_color: [0.0, 0.0, 0.0, 1.0],    // black
            font: 0,                                // SansSerif
            _padding: [0.0],
        }
    }
}

/// Caption layer that renders text using GPU
pub struct CaptionsLayer {
    settings_buffer: wgpu::Buffer,
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    // Current caption state
    current_caption: Option<CaptionSegment>,
    current_time: f32,
    // Store individual buffers for each word
    word_buffers: Vec<(Buffer, usize)>, // (buffer, word_index)
    // Background rendering
    background_pipeline: CaptionBackgroundPipeline,
    background_uniforms_buffer: Option<wgpu::Buffer>,
    background_bind_group: Option<wgpu::BindGroup>,
    // Store background info
    background_info: Option<BackgroundInfo>,
}

#[derive(Debug, Clone)]
struct BackgroundInfo {
    position: [f32; 2],
    size: [f32; 2],
    opacity: f32,
}

impl CaptionsLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        // Create default settings buffer
        let settings = CaptionSettings::default();
        let settings_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Settings Buffer"),
            contents: bytemuck::cast_slice(&[settings]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Initialize glyphon text rendering components
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
            current_time: 0.0,
            word_buffers: Vec::new(),
            background_pipeline,
            background_uniforms_buffer: None,
            background_bind_group: None,
            background_info: None,
        }
    }

    /// Update the settings for caption rendering
    pub fn update_settings(&mut self, queue: &Queue, settings: CaptionSettings) {
        queue.write_buffer(&self.settings_buffer, 0, bytemuck::cast_slice(&[settings]));
    }

    /// Update current caption state - simpler approach
    pub fn update_current_caption(
        &mut self,
        current_time: f32,
        segments: &[cap_project::CaptionSegment],
    ) {
        self.current_time = current_time;

        // Find current caption segment
        self.current_caption = segments
            .iter()
            .find(|segment| current_time >= segment.start && current_time < segment.end)
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
            });
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        // Clear any existing word buffers
        self.word_buffers.clear();
        self.background_uniforms_buffer = None;
        self.background_bind_group = None;
        self.background_info = None;

        // Only render if captions are enabled and available
        let Some(caption_data) = &uniforms.project.captions else {
            return;
        };
        if !caption_data.settings.enabled {
            return;
        }

        let current_time = segment_frames.segment_time;

        // Update current caption state
        self.update_current_caption(current_time, &caption_data.segments);

        // Only proceed if we have a current caption
        let Some(ref current_caption) = self.current_caption else {
            return;
        };

        let (width, height) = (output_size.x, output_size.y);
        let device = &constants.device;
        let queue = &constants.queue;

        // Calculate fade in/out
        let fade_duration = 0.3;
        let segment_duration = current_caption.end - current_caption.start;
        let relative_time = current_time - current_caption.start;

        let opacity = if relative_time < fade_duration {
            relative_time / fade_duration
        } else if relative_time > segment_duration - fade_duration {
            (segment_duration - relative_time) / fade_duration
        } else {
            1.0
        }
        .clamp(0.0, 1.0);

        // Skip if completely faded out
        if opacity < 0.01 {
            return;
        }

        // Calculate responsive sizing with better quality
        let base_size = caption_data.settings.size as f32 * 1.8; // Larger base size for better quality
        let scale_factor = (height as f32 / 1080.0).max(1.0); // Don't go below 1.0
        let font_size = base_size * scale_factor;
        let y_position = match caption_data.settings.position.as_str() {
            "top" => height as f32 * 0.1,
            "middle" => height as f32 * 0.5,
            _ => height as f32 * 0.85, // bottom
        };

        // Find currently active word
        let active_word_idx = current_caption
            .words
            .iter()
            .position(|word| current_time >= word.start && current_time < word.end);

        let line_height = font_size * 1.2;
        let metrics = Metrics::new(font_size, line_height);
        let text_opacity = (opacity * 255.0) as u8;

        // Colors for active and inactive words
        let inactive_color = Color::rgba(200, 200, 200, text_opacity); // Light grey
        let active_color = Color::rgba(255, 255, 255, text_opacity); // White

        // Create the full text to measure total width
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

        // Create a measuring buffer to get the full width
        let mut measure_buffer = Buffer::new(&mut self.font_system, metrics);
        measure_buffer.set_size(&mut self.font_system, None, None);
        measure_buffer.set_text(
            &mut self.font_system,
            &full_text,
            &Attrs::new().family(Family::SansSerif),
            Shaping::Advanced,
        );

        // Create individual buffers for each word
        if current_caption.words.is_empty() {
            // No word-level data, create single buffer
            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            buffer.set_size(&mut self.font_system, None, None);

            let color = if active_word_idx.is_some() {
                active_color
            } else {
                inactive_color
            };
            buffer.set_text(
                &mut self.font_system,
                &current_caption.text,
                &Attrs::new()
                    .family(Family::SansSerif)
                    .weight(Weight::NORMAL)
                    .color(color),
                Shaping::Advanced,
            );
            self.word_buffers.push((buffer, 0));
        } else {
            // Create buffer for each word
            for (i, word) in current_caption.words.iter().enumerate() {
                let mut buffer = Buffer::new(&mut self.font_system, metrics);
                buffer.set_size(&mut self.font_system, None, None);

                let word_text = if i == 0 {
                    word.text.clone()
                } else {
                    format!(" {}", word.text)
                };

                let color = if Some(i) == active_word_idx {
                    active_color
                } else {
                    inactive_color
                };

                buffer.set_text(
                    &mut self.font_system,
                    &word_text,
                    &Attrs::new()
                        .family(Family::SansSerif)
                        .weight(Weight::NORMAL)
                        .color(color),
                    Shaping::Advanced,
                );

                self.word_buffers.push((buffer, i));
            }
        }

        // Update viewport
        self.viewport.update(queue, Resolution { width, height });

        // Prepare text areas for rendering
        if !self.word_buffers.is_empty() {
            let mut text_areas = Vec::new();

            // Calculate total text width by summing word widths
            let mut total_width = 0.0;
            let word_widths: Vec<f32> = self
                .word_buffers
                .iter()
                .map(|(buffer, _)| {
                    // Get the width of this word's buffer
                    let run = buffer.layout_runs().next();
                    run.map(|r| r.line_w).unwrap_or(0.0)
                })
                .collect();

            total_width = word_widths.iter().sum();

            // Center the text
            let start_x = (width as f32 - total_width) / 2.0;
            let _text_height = font_size * 1.5; // Proper text height for layout

            // Create background with padding
            let h_padding = 40.0;
            let v_padding_top = 20.0;
            let v_padding_bottom = 28.0; // Balanced padding - text bounds now handle descender space
            let bg_opacity = (caption_data.settings.background_opacity as f32 / 100.0) * opacity;

            if bg_opacity > 0.1 {
                // Store background info for rendering
                // Adjust position to account for unequal padding
                let bg_center_y = y_position - v_padding_top
                    + (font_size + v_padding_top + v_padding_bottom) / 2.0;
                self.background_info = Some(BackgroundInfo {
                    position: [start_x + total_width / 2.0, bg_center_y],
                    size: [
                        total_width + h_padding * 2.0,
                        font_size + v_padding_top + v_padding_bottom,
                    ],
                    opacity: bg_opacity,
                });

                // Create background uniforms
                let bg_uniforms = CaptionBackgroundUniforms {
                    position: [start_x + total_width / 2.0, bg_center_y],
                    size: [
                        total_width + h_padding * 2.0,
                        font_size + v_padding_top + v_padding_bottom,
                    ],
                    color: [0.0, 0.0, 0.0, bg_opacity],
                    corner_radius: 12.0, // Nice rounded corners
                    _padding1: [0.0],
                    viewport_size: [width as f32, height as f32],
                    _padding2: 0.0,
                    _padding3: [0.0, 0.0, 0.0],
                    _padding4: [0.0, 0.0, 0.0, 0.0],
                };

                // Create buffer and bind group
                let uniforms_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Caption Background Uniforms"),
                        contents: bytemuck::cast_slice(&[bg_uniforms]),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });

                let bind_group = self
                    .background_pipeline
                    .create_bind_group(device, &uniforms_buffer);

                self.background_uniforms_buffer = Some(uniforms_buffer);
                self.background_bind_group = Some(bind_group);
            }

            // Add each word at its position
            let mut current_x = start_x;
            for (i, (buffer, word_idx)) in self.word_buffers.iter().enumerate() {
                let word_width = if i < word_widths.len() {
                    word_widths[i]
                } else {
                    0.0
                };

                // Text bounds for this word - add extra space for descenders
                let word_bounds = TextBounds {
                    left: current_x as i32,
                    top: (y_position - 10.0) as i32, // Add some top space
                    right: (current_x + word_width) as i32,
                    bottom: (y_position + font_size * 1.3) as i32, // Extra space for descenders
                };

                // Determine color based on whether this is the active word
                let is_active = active_word_idx == Some(*word_idx);
                let color = if is_active {
                    Color::rgba(255, 255, 255, text_opacity) // Bright white
                } else {
                    Color::rgba(180, 180, 180, text_opacity) // Lighter grey for better readability
                };

                text_areas.push(TextArea {
                    buffer,
                    left: current_x,
                    top: y_position,
                    scale: 1.0,
                    bounds: word_bounds,
                    default_color: color,
                    custom_glyphs: &[],
                });

                current_x += word_width;
            }

            // Prepare for GPU rendering
            if let Err(e) = self.text_renderer.prepare(
                device,
                queue,
                &mut self.font_system,
                &mut self.text_atlas,
                &self.viewport,
                text_areas,
                &mut self.swash_cache,
            ) {
                warn!("Caption text preparation failed: {:?}", e);
            }
        }
    }

    /// Render the caption background
    pub fn render_background<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        // Render background if available
        if let (Some(ref bind_group), Some(_)) =
            (&self.background_bind_group, &self.background_info)
        {
            self.background_pipeline.render(pass, bind_group);
        }
    }

    /// Render the caption text
    pub fn render_text<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        // Only render if we have word buffers prepared and current caption exists
        if !self.word_buffers.is_empty() && self.current_caption.is_some() {
            if let Err(e) = self
                .text_renderer
                .render(&self.text_atlas, &self.viewport, pass)
            {
                warn!("Caption text rendering failed: {:?}", e);
            }
        }
    }
}

/// Function to find the current caption segment based on playback time
pub fn find_caption_at_time(time: f32, segments: &[CaptionSegment]) -> Option<&CaptionSegment> {
    segments
        .iter()
        .find(|segment| time >= segment.start && time < segment.end)
}

// Adding a new version that accepts cap_project::CaptionSegment
/// Function to find the current caption segment from cap_project::CaptionSegment based on playback time
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
