use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use wgpu::{util::DeviceExt, Device, Queue};
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache, TextArea,
    TextAtlas, TextBounds, TextRenderer, Viewport,
};
use log::{info, warn, debug};

use crate::frame_pipeline::FramePipeline;

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
    pub outline: u32, // 0 = disabled, 1 = enabled
    pub outline_color: [f32; 4],
    pub _padding: [f32; 2], // for alignment
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: 1,
            font_size: 24.0,
            color: [1.0, 1.0, 1.0, 1.0], // white
            background_color: [0.0, 0.0, 0.0, 0.8], // 80% black
            position: 2, // bottom
            outline: 1, // enabled
            outline_color: [0.0, 0.0, 0.0, 1.0], // black
            _padding: [0.0, 0.0],
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
    /// Create a new captions layer
    pub fn new(device: &Device, queue: &Queue) -> Self {
        info!("Initializing new CaptionsLayer");
        // Create default settings buffer
        let settings = CaptionSettings::default();
        let settings_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Settings Buffer"),
            contents: bytemuck::cast_slice(&[settings]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Initialize glyphon text rendering components
        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut text_atlas = TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8UnormSrgb);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            device, 
            wgpu::MultisampleState::default(),
            None
        );
        
        // Create an empty buffer with default metrics
        let metrics = Metrics::new(24.0, 24.0 * 1.2); // Default font size and line height
        let mut text_buffer = Buffer::new_empty(metrics);

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
        debug!("Updating caption - Text: {:?}, Time: {}", text, time);
        if self.current_text != text {
            if let Some(content) = &text {
                info!("Setting new caption text: {}", content);
                // Update the text buffer with new content
                let metrics = Metrics::new(24.0, 24.0 * 1.2);
                self.text_buffer = Buffer::new_empty(metrics);
                self.text_buffer.set_text(&mut self.font_system, content, Attrs::new(), Shaping::Advanced);
            }
            self.current_text = text;
        }
        self.current_segment_time = time;
    }

    /// Render the current caption to the frame
    pub fn render(
        &mut self,
        pipeline: &mut FramePipeline,
        output_size: XY<u32>,
        time: f32,
        segments: &[CaptionSegment],
        settings: &CaptionSettings,
    ) {
        info!("Starting caption render - Enabled: {}, Segments: {}", settings.enabled, segments.len());
        
        // Don't render if captions are disabled or no text
        if settings.enabled == 0 {
            debug!("Captions disabled, skipping render");
            return;
        }
        
        if self.current_text.is_none() {
            debug!("No caption text to render");
            return;
        }

        if let Some(text) = &self.current_text {
            let (width, height) = (output_size.x, output_size.y);
            info!("Rendering caption '{}' at time {} on {}x{}", text, time, width, height);
            
            // Access device and queue from the pipeline's constants
            let device = &pipeline.state.constants.device;
            let queue = &pipeline.state.constants.queue;
            
            // Find caption position based on settings
            let y_position = match settings.position {
                0 => height as f32 * 0.1, // top
                1 => height as f32 * 0.5, // middle
                _ => height as f32 * 0.85, // bottom (default)
            };
            info!("Caption Y position: {}", y_position);
            
            // Set up caption appearance
            let color = Color::rgb(
                (settings.color[0] * 255.0) as u8, 
                (settings.color[1] * 255.0) as u8, 
                (settings.color[2] * 255.0) as u8
            );
            
            // Get outline color if needed
            let outline_color = Color::rgb(
                (settings.outline_color[0] * 255.0) as u8, 
                (settings.outline_color[1] * 255.0) as u8, 
                (settings.outline_color[2] * 255.0) as u8
            );
            
            // Calculate text bounds
            let font_size = settings.font_size * (height as f32 / 1080.0); // Scale font size based on resolution
            let metrics = Metrics::new(font_size, font_size * 1.2); // 1.2 line height
            info!("Font size: {} (scaled from {})", font_size, settings.font_size);
            
            // Create a new buffer with explicit size for this frame
            let mut updated_buffer = Buffer::new(&mut self.font_system, metrics);
            
            // Explicitly set the buffer size to match frame dimensions
            updated_buffer.set_size(&mut self.font_system, Some(width as f32), Some(height as f32));
            
            // Position text in the center horizontally
            let bounds = TextBounds {
                left: (width as f32 * 0.05) as i32,  // Left margin 5%
                top: y_position as i32,
                right: (width as f32 * 0.95) as i32, // Right margin 5%
                bottom: (y_position + font_size * 4.0) as i32,  // Increased height for better visibility
            };
            info!("Text bounds: left={}, top={}, right={}, bottom={}", 
                   bounds.left, bounds.top, bounds.right, bounds.bottom);
            
            // Apply text styling directly when setting the text
            // Create text attributes with or without outline
            let mut attrs = Attrs::new().family(Family::SansSerif).color(color);
            
            // Apply text to buffer
            updated_buffer.set_text(
                &mut self.font_system,
                text,
                attrs,
                Shaping::Advanced
            );
            
            // Replace the existing buffer
            self.text_buffer = updated_buffer;
            
            // Update the viewport with explicit resolution
            self.viewport.update(queue, Resolution { width, height });
            
            // Background color
            let bg_color = if settings.background_color[3] > 0.01 {
                info!("Rendering with background color");
                // Create a new text area with background color
                Color::rgba(
                    (settings.background_color[0] * 255.0) as u8,
                    (settings.background_color[1] * 255.0) as u8,
                    (settings.background_color[2] * 255.0) as u8,
                    (settings.background_color[3] * 255.0) as u8
                )
            } else {
                info!("Using transparent background");
                Color::rgba(0, 0, 0, 0)
            };
            
            // Prepare text areas for rendering
            let mut text_areas = Vec::new();
            
            // Add background if enabled
            if settings.background_color[3] > 0.01 {
                text_areas.push(TextArea {
                    buffer: &self.text_buffer,
                    left: width as f32 * 0.5,  // Center horizontally
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
                    (-1.0, -1.0), (0.0, -1.0), (1.0, -1.0),
                    (-1.0, 0.0),               (1.0, 0.0),
                    (-1.0, 1.0),  (0.0, 1.0),  (1.0, 1.0)
                ];
                
                for (offset_x, offset_y) in outline_offsets.iter() {
                    text_areas.push(TextArea {
                        buffer: &self.text_buffer,
                        left: width as f32 * 0.5 + offset_x,
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
                left: width as f32 * 0.5,  // Center horizontally
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
                Ok(_) => info!("Text preparation successful"),
                Err(e) => warn!("Error preparing text: {:?}", e),
            }
            
            // Create an explicit render pass for text rendering
            let mut render_pass = pipeline.encoder.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Caption Text Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: pipeline.state.get_current_texture_view(),
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            
            // Render the text to the frame
            match self.text_renderer.render(&self.text_atlas, &self.viewport, &mut render_pass) {
                Ok(_) => info!("Text rendering successful"),
                Err(e) => warn!("Error rendering text: {:?}", e),
            }
        }
    }
}

/// Function to find the current caption segment based on playback time
pub fn find_caption_at_time(time: f32, segments: &[CaptionSegment]) -> Option<&CaptionSegment> {
    segments.iter().find(|segment| time >= segment.start && time < segment.end)
}

// Adding a new version that accepts cap_project::CaptionSegment
/// Function to find the current caption segment from cap_project::CaptionSegment based on playback time
pub fn find_caption_at_time_project(time: f32, segments: &[cap_project::CaptionSegment]) -> Option<CaptionSegment> {
    segments.iter().find(|segment| time >= segment.start && time < segment.end)
        .map(|segment| CaptionSegment {
            id: segment.id.clone(),
            start: segment.start,
            end: segment.end,
            text: segment.text.clone(),
        })
}

/// Convert from cap_project::CaptionSegment to our internal CaptionSegment
pub fn convert_project_caption(segment: &cap_project::CaptionSegment) -> CaptionSegment {
    CaptionSegment {
        id: segment.id.clone(),
        start: segment.start,
        end: segment.end,
        text: segment.text.clone(),
    }
} 