use cap_project::TextAlign;
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

struct AreaSpec {
    bounds: TextBounds,
    left: f32,
    top: f32,
    scale: f32,
    color: Color,
    shadow: Option<(f32, f32, Color)>,
}

fn shift_bounds(bounds: TextBounds, dx: f32, dy: f32) -> TextBounds {
    TextBounds {
        left: bounds.left + dx.floor() as i32,
        top: bounds.top + dy.floor() as i32,
        right: bounds.right + dx.ceil() as i32,
        bottom: bounds.bottom + dy.ceil() as i32,
    }
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
        let mut specs = Vec::with_capacity(texts.len());

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
            // the render. The room is placed so the aligned edge stays put —
            // split for centered text, after for left, before for right.
            // Boxes already spanning the frame keep their exact width — there
            // the editor genuinely wrapped too.
            let output_width = (output_size.0 as f32).max(1.0);
            let wrap_width = if width < output_width * 0.98 {
                (width * 1.05 + 4.0).min(output_width.max(width))
            } else {
                width
            };
            let origin_dx = match text.align {
                TextAlign::Left => 0.0,
                TextAlign::Center => (wrap_width - width) / 2.0,
                TextAlign::Right => wrap_width - width,
            };

            let metrics = Metrics::new(text.font_size, text.font_size * text.line_height);
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
            // Glyph color comes from each area's default_color (not Attrs) so
            // the shadow pass can re-tint the same shaped buffer.
            let mut attrs = Attrs::new()
                .family(family)
                .weight(weight)
                .style(if text.italic {
                    Style::Italic
                } else {
                    Style::Normal
                });
            if text.letter_spacing != 0.0 {
                // cosmic-text adds letter_spacing to the em-relative glyph
                // advance and multiplies by font size at layout (shape.rs), so
                // the attr is in em — convert from our px value.
                attrs = attrs.letter_spacing(text.letter_spacing / text.font_size.max(1.0));
            }

            buffer.set_text(
                &mut self.font_system,
                &text.content,
                &attrs,
                Shaping::Advanced,
            );

            let align = match text.align {
                TextAlign::Left => Align::Left,
                TextAlign::Center => Align::Center,
                TextAlign::Right => Align::Right,
            };
            for line in buffer.lines.iter_mut() {
                line.set_align(Some(align));
            }

            buffer.shape_until_scroll(&mut self.font_system, false);

            let laid_out_height = buffer.layout_runs().count() as f32 * metrics.line_height;

            // Animation transform: uniform scale about the box center plus a
            // translation, applied to the buffer origin and clip bounds (the
            // glyph layout itself is scaled by TextArea::scale from that
            // origin).
            let cx = (text.bounds[0] + text.bounds[2]) / 2.0;
            let cy = (text.bounds[1] + text.bounds[3]) / 2.0;
            let scale = text.scale.max(0.01);
            let tx = |x: f32| cx + (x - cx) * scale + text.offset[0];
            let ty = |y: f32| cy + (y - cy) * scale + text.offset[1];

            let origin_left = tx(text.bounds[0] - origin_dx);
            let origin_top = ty(text.bounds[1]);

            // Clip horizontally at the (slack-expanded) wrap box, but extend
            // the bottom to the laid-out text height so descenders and extra
            // lines never get cut off; glyphon intersects these bounds with
            // the viewport.
            let bounds = TextBounds {
                left: origin_left.floor() as i32,
                top: origin_top.floor() as i32,
                right: tx(text.bounds[0] - origin_dx + wrap_width).ceil() as i32,
                bottom: ty(text.bounds[1] + height.max(laid_out_height)).ceil() as i32,
            };

            let shadow = (text.shadow > 0.0).then(|| {
                let dx = text.font_size * scale * 0.02;
                let dy = text.font_size * scale * 0.055;
                let shadow_alpha = alpha * text.shadow.clamp(0.0, 1.0) * 0.85;
                (dx, dy, Color::rgba(0, 0, 0, (shadow_alpha * 255.0) as u8))
            });

            self.buffers.push(buffer);
            specs.push(AreaSpec {
                bounds,
                left: origin_left,
                top: origin_top,
                scale,
                color,
                shadow,
            });
        }

        let text_areas = self
            .buffers
            .iter()
            .zip(&specs)
            .flat_map(|(buffer, spec)| {
                let shadow_area = spec.shadow.map(|(dx, dy, shadow_color)| TextArea {
                    buffer,
                    left: spec.left + dx,
                    top: spec.top + dy,
                    scale: spec.scale,
                    bounds: shift_bounds(spec.bounds, dx, dy),
                    default_color: shadow_color,
                    custom_glyphs: &[],
                });
                let main_area = TextArea {
                    buffer,
                    left: spec.left,
                    top: spec.top,
                    scale: spec.scale,
                    bounds: spec.bounds,
                    default_color: spec.color,
                    custom_glyphs: &[],
                };
                shadow_area.into_iter().chain(std::iter::once(main_area))
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
