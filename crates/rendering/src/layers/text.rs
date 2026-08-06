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
        let font_system = super::new_font_system();
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
            let alpha = text.color[3].clamp(0.0, 1.0) * text.opacity.clamp(0.0, 1.0);
            let color = Color::rgba(
                (text.color[0].clamp(0.0, 1.0) * 255.0) as u8,
                (text.color[1].clamp(0.0, 1.0) * 255.0) as u8,
                (text.color[2].clamp(0.0, 1.0) * 255.0) as u8,
                (alpha * 255.0) as u8,
            );

            let width = (text.bounds[2] - text.bounds[0]).max(1.0);
            let height = (text.bounds[3] - text.bounds[1]).max(1.0);

            // Shape with a little more width than the editor-measured box:
            // the webview and cosmic-text can disagree by a few pixels per
            // line, and without slack a line that fit in the editor wraps in
            // the render. The room is split evenly so centered lines stay
            // centered. Boxes already spanning the frame keep their exact
            // width — there the editor genuinely wrapped too.
            let output_width = (output_size.0 as f32).max(1.0);
            let wrap_width = if width < output_width * 0.98 {
                (width * 1.05 + 4.0).min(output_width.max(width))
            } else {
                width
            };
            let wrap_dx = (wrap_width - width) / 2.0;

            let metrics = Metrics::new(text.font_size, text.font_size * 1.2);
            let mut buffer = Buffer::new(&mut self.font_system, metrics);
            // The box only constrains wrapping; height is unbounded so every
            // line is laid out even when the configured box is a little
            // shorter than the shaped text (e.g. font metric differences
            // between the editor's measurement and cosmic-text).
            buffer.set_size(&mut self.font_system, Some(wrap_width), None);
            buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);

            let family = match text.font_family.trim() {
                "" => Family::SansSerif,
                name => match name.to_ascii_lowercase().as_str() {
                    "sans" | "sans-serif" | "system sans" | "system sans-serif" => {
                        Family::SansSerif
                    }
                    "serif" | "system serif" => Family::Serif,
                    "mono" | "monospace" | "system mono" | "system monospace" => Family::Monospace,
                    _ => Family::Name(name),
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

            // Clip horizontally at the (slack-expanded) wrap box, but extend
            // the bottom to the laid-out text height so descenders and extra
            // lines never get cut off; glyphon intersects these bounds with
            // the viewport.
            let laid_out_height = buffer.layout_runs().count() as f32 * metrics.line_height;
            let bounds = TextBounds {
                left: (text.bounds[0] - wrap_dx).floor() as i32,
                top: text.bounds[1].floor() as i32,
                right: (text.bounds[0] + width + wrap_dx).ceil() as i32,
                bottom: (text.bounds[1] + height.max(laid_out_height)).ceil() as i32,
            };

            self.buffers.push(buffer);
            // The buffer origin shifts left by the slack so centered lines
            // stay centered on the box.
            text_area_data.push((bounds, text.bounds[0] - wrap_dx, text.bounds[1], color));
        }

        let text_areas = self
            .buffers
            .iter()
            .zip(text_area_data)
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
