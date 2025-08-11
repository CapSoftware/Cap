#![allow(unused)] // TODO: This module is still being implemented

use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport,
};
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
    text_buffer: Buffer,
    current_text: Option<String>,
    current_segment_time: f32,
    viewport: Viewport,
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

        // Create an empty buffer with default metrics
        let metrics = Metrics::new(24.0, 24.0 * 1.2); // Default font size and line height
        let text_buffer = Buffer::new_empty(metrics);

        Self {
            settings_buffer,
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            text_buffer,
            current_text: None,
            current_segment_time: 0.0,
            viewport,
        }
    }

    /// Update the settings for caption rendering
    pub fn update_settings(&mut self, queue: &Queue, settings: CaptionSettings) {
        queue.write_buffer(&self.settings_buffer, 0, bytemuck::cast_slice(&[settings]));
    }

    /// Update the current caption text and timing
    pub fn update_caption(&mut self, text: Option<String>, time: f32) {
        debug!("Updating caption - Text: {text:?}, Time: {time}");
        if self.current_text != text {
            if let Some(content) = &text {
                info!("Setting new caption text: {content}");
                // Update the text buffer with new content
                let metrics = Metrics::new(24.0, 24.0 * 1.2);
                self.text_buffer = Buffer::new_empty(metrics);
                self.text_buffer.set_text(
                    &mut self.font_system,
                    content,
                    &Attrs::new(),
                    Shaping::Advanced,
                );
            }
            self.current_text = text;
        }
        self.current_segment_time = time;
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        // Render captions if there are any caption segments to display
        if let Some(caption_data) = &uniforms.project.captions
            && caption_data.settings.enabled
        {
            // Find the current caption for this time
            let current_time = segment_frames.segment_time;

            if let Some(current_caption) =
                find_caption_at_time_project(current_time, &caption_data.segments)
            {
                // Get caption text and time for use in rendering
                let caption_text = current_caption.text.clone();

                // Create settings for the caption
                let settings = CaptionSettings {
                    enabled: 1,
                    font_size: caption_data.settings.size as f32,
                    color: [
                        parse_color_component(&caption_data.settings.color, 0),
                        parse_color_component(&caption_data.settings.color, 1),
                        parse_color_component(&caption_data.settings.color, 2),
                        1.0,
                    ],
                    background_color: [
                        parse_color_component(&caption_data.settings.background_color, 0),
                        parse_color_component(&caption_data.settings.background_color, 1),
                        parse_color_component(&caption_data.settings.background_color, 2),
                        caption_data.settings.background_opacity as f32 / 100.0,
                    ],
                    position: match caption_data.settings.position.as_str() {
                        "top" => 0,
                        "middle" => 1,
                        _ => 2, // default to bottom
                    },
                    outline: if caption_data.settings.outline { 1 } else { 0 },
                    outline_color: [
                        parse_color_component(&caption_data.settings.outline_color, 0),
                        parse_color_component(&caption_data.settings.outline_color, 1),
                        parse_color_component(&caption_data.settings.outline_color, 2),
                        1.0,
                    ],
                    font: match caption_data.settings.font.as_str() {
                        "System Serif" => 1,
                        "System Monospace" => 2,
                        _ => 0, // Default to SansSerif for "System Sans-Serif" and any other value
                    },
                    _padding: [0.0],
                };

                self.update_caption(Some(caption_text), current_time);

                if settings.enabled == 0 {
                    return;
                }

                if self.current_text.is_none() {
                    return;
                }

                if let Some(text) = &self.current_text {
                    let (width, height) = (output_size.x, output_size.y);

                    // Access device and queue from the pipeline's constants
                    let device = &constants.device;
                    let queue = &constants.queue;

                    // Find caption position based on settings
                    let y_position = match settings.position {
                        0 => height as f32 * 0.1,  // top
                        1 => height as f32 * 0.5,  // middle
                        _ => height as f32 * 0.85, // bottom (default)
                    };

                    // Set up caption appearance
                    let color = Color::rgb(
                        (settings.color[0] * 255.0) as u8,
                        (settings.color[1] * 255.0) as u8,
                        (settings.color[2] * 255.0) as u8,
                    );

                    // Get outline color if needed
                    let outline_color = Color::rgb(
                        (settings.outline_color[0] * 255.0) as u8,
                        (settings.outline_color[1] * 255.0) as u8,
                        (settings.outline_color[2] * 255.0) as u8,
                    );

                    // Calculate text bounds
                    let font_size = settings.font_size * (height as f32 / 1080.0); // Scale font size based on resolution
                    let metrics = Metrics::new(font_size, font_size * 1.2); // 1.2 line height

                    // Create a new buffer with explicit size for this frame
                    let mut updated_buffer = Buffer::new(&mut self.font_system, metrics);

                    // Set explicit width to enable proper text wrapping and centering
                    // Set width to 90% of screen width for better appearance
                    let text_width = width as f32 * 0.9;
                    updated_buffer.set_size(&mut self.font_system, Some(text_width), None);
                    updated_buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);

                    // Position text in the center horizontally
                    // The bounds dictate the rendering area
                    let bounds = TextBounds {
                        left: ((width as f32 - text_width) / 2.0) as i32, // Center the text horizontally
                        top: y_position as i32,
                        right: ((width as f32 + text_width) / 2.0) as i32, // Center + width
                        bottom: (y_position + font_size * 4.0) as i32, // Increased height for better visibility
                    };

                    // Apply text styling directly when setting the text
                    // Create text attributes with or without outline
                    let font_family = match settings.font {
                        0 => Family::SansSerif,
                        1 => Family::Serif,
                        2 => Family::Monospace,
                        _ => Family::SansSerif, // Default to SansSerif for any other value
                    };
                    let attrs = Attrs::new().family(font_family).color(color);

                    // Apply text to buffer
                    updated_buffer.set_text(&mut self.font_system, text, &attrs, Shaping::Advanced);

                    // Replace the existing buffer
                    self.text_buffer = updated_buffer;

                    // Update the viewport with explicit resolution
                    self.viewport.update(queue, Resolution { width, height });

                    // Background color
                    let bg_color = if settings.background_color[3] > 0.01 {
                        // Create a new text area with background color
                        Color::rgba(
                            (settings.background_color[0] * 255.0) as u8,
                            (settings.background_color[1] * 255.0) as u8,
                            (settings.background_color[2] * 255.0) as u8,
                            (settings.background_color[3] * 255.0) as u8,
                        )
                    } else {
                        Color::rgba(0, 0, 0, 0)
                    };

                    // Prepare text areas for rendering
                    let mut text_areas = Vec::new();

                    // Add background if enabled
                    if settings.background_color[3] > 0.01 {
                        text_areas.push(TextArea {
                            buffer: &self.text_buffer,
                            left: bounds.left as f32, // Match the bounds left for positioning
                            top: y_position,
                            scale: 1.0,
                            bounds,
                            default_color: bg_color,
                            custom_glyphs: &[],
                        });
                    }

                    // Add outline if enabled (by rendering the text multiple times with slight offsets in different positions)
                    if settings.outline == 1 {
                        info!("Rendering with outline");
                        // Outline is created by drawing the text multiple times with small offsets in different directions
                        let outline_offsets = [
                            (-1.0, -1.0),
                            (0.0, -1.0),
                            (1.0, -1.0),
                            (-1.0, 0.0),
                            (1.0, 0.0),
                            (-1.0, 1.0),
                            (0.0, 1.0),
                            (1.0, 1.0),
                        ];

                        for (offset_x, offset_y) in outline_offsets.iter() {
                            text_areas.push(TextArea {
                                buffer: &self.text_buffer,
                                left: bounds.left as f32 + offset_x, // Match bounds with small offset for outline
                                top: y_position + offset_y,
                                scale: 1.0,
                                bounds,
                                default_color: outline_color,
                                custom_glyphs: &[],
                            });
                        }
                    }

                    // Add main text (rendered last, on top of everything)
                    text_areas.push(TextArea {
                        buffer: &self.text_buffer,
                        left: bounds.left as f32, // Match the bounds left for positioning
                        top: y_position,
                        scale: 1.0,
                        bounds,
                        default_color: color,
                        custom_glyphs: &[],
                    });

                    // Prepare text rendering
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

    /// Render the current caption to the frame
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
        })
}
