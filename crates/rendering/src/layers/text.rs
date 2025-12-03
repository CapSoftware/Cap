use glyphon::cosmic_text::Align;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{Device, Queue};

use crate::text::PreparedText;

pub struct TextLayer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    buffers: Vec<Buffer>,
}

impl TextLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
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

        Self {
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            viewport,
            buffers: Vec::new(),
        }
    }

    pub fn prepare(
        &mut self,
        device: &Device,
        queue: &Queue,
        output_size: (u32, u32),
        texts: &[PreparedText],
    ) {
        self.buffers.clear();
        self.buffers.reserve(texts.len());
        let mut text_area_data = Vec::with_capacity(texts.len());

        for text in texts {
            let color = Color::rgba(
                (text.color[0].clamp(0.0, 1.0) * 255.0) as u8,
                (text.color[1].clamp(0.0, 1.0) * 255.0) as u8,
                (text.color[2].clamp(0.0, 1.0) * 255.0) as u8,
                (text.color[3].clamp(0.0, 1.0) * 255.0) as u8,
            );

            let width = (text.bounds[2] - text.bounds[0]).max(1.0);
            let height = (text.bounds[3] - text.bounds[1]).max(1.0);

            let metrics = Metrics::new(text.font_size, text.font_size * 1.2);
            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            buffer.set_size(&mut self.font_system, Some(width), Some(height));
            buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);

            let family = match text.font_family.trim() {
                "" => Family::SansSerif,
                name => match name.to_ascii_lowercase().as_str() {
                    "sans" | "sans-serif" | "system sans" | "system sans-serif" => {
                        Family::SansSerif
                    }
                    "serif" | "system serif" => Family::Serif,
                    "mono" | "monospace" | "system mono" | "system monospace" => Family::Monospace,
                    _ => Family::Name(name.into()),
                },
            };
            let weight = Weight(text.font_weight.round().clamp(100.0, 900.0) as u16);
            let attrs = Attrs::new()
                .family(family)
                .color(color)
                .weight(weight)
                .style(if text.italic {
                    Style::Italic
                } else {
                    Style::Normal
                });

            buffer.set_text(
                &mut self.font_system,
                &text.content,
                &attrs,
                Shaping::Advanced,
            );

            for line in buffer.lines.iter_mut() {
                line.set_align(Some(Align::Center));
            }

            buffer.shape_until_scroll(&mut self.font_system, false);

            let bounds = TextBounds {
                left: text.bounds[0].floor() as i32,
                top: text.bounds[1].floor() as i32,
                right: (text.bounds[0] + width).ceil() as i32,
                bottom: (text.bounds[1] + height).ceil() as i32,
            };

            self.buffers.push(buffer);
            text_area_data.push((bounds, text.bounds[0], text.bounds[1], color));
        }

        let text_areas = self
            .buffers
            .iter()
            .zip(text_area_data.into_iter())
            .map(|(buffer, (bounds, left, top, color))| TextArea {
                buffer,
                left,
                top,
                scale: 1.0,
                bounds,
                default_color: color,
                custom_glyphs: &[],
            })
            .collect::<Vec<_>>();

        self.viewport.update(
            queue,
            Resolution {
                width: output_size.0,
                height: output_size.1,
            },
        );

        if let Err(error) = self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            text_areas,
            &mut self.swash_cache,
        ) {
            warn!("Failed to prepare text: {error:?}");
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let Err(error) = self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            warn!("Failed to render text: {error:?}");
        }
    }
}
