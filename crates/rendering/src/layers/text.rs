use std::ops::Range;

use bytemuck::{Pod, Zeroable};
use cap_project::{TextAlign, TextBackgroundStyle};
use glyphon::cosmic_text::Align;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{Device, Queue, include_wgsl, util::DeviceExt};

use crate::text::{PreparedText, StaggerEdge, stagger_alpha};

pub struct TextLayer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    buffers: Vec<Buffer>,
    draws: Vec<TextDraw>,
    segment_renderers: Vec<TextRenderer>,
    background: Option<TextBackgroundResources>,
    segmented_render: bool,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct TextBackgroundUniforms {
    rect: [f32; 4],
    color: [f32; 4],
    radius: f32,
    _padding0: f32,
    _padding1: f32,
    _padding2: f32,
    output_size: [f32; 2],
    _padding3: [f32; 2],
}

struct TextBackgroundResources {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffers: Vec<wgpu::Buffer>,
    bind_groups: Vec<wgpu::BindGroup>,
}

impl TextBackgroundResources {
    fn new(device: &Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Text Background Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let shader = device.create_shader_module(include_wgsl!("../shaders/text_bg.wgsl"));
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Text Background Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Text Background Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
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
            pipeline,
            bind_group_layout,
            uniform_buffers: Vec::new(),
            bind_groups: Vec::new(),
        }
    }

    fn ensure_capacity(&mut self, device: &Device, count: usize) {
        while self.uniform_buffers.len() < count {
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Text Background Uniform Buffer"),
                contents: bytemuck::bytes_of(&TextBackgroundUniforms {
                    rect: [0.0; 4],
                    color: [0.0; 4],
                    radius: 0.0,
                    _padding0: 0.0,
                    _padding1: 0.0,
                    _padding2: 0.0,
                    output_size: [1.0; 2],
                    _padding3: [0.0; 2],
                }),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Text Background Bind Group"),
                layout: &self.bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            });
            self.uniform_buffers.push(buffer);
            self.bind_groups.push(bind_group);
        }
    }

    fn write(&self, queue: &Queue, index: usize, uniforms: &TextBackgroundUniforms) {
        queue.write_buffer(
            &self.uniform_buffers[index],
            0,
            bytemuck::bytes_of(uniforms),
        );
    }

    fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>, index: usize) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_groups[index], &[]);
        pass.draw(0..6, 0..1);
    }
}

/// One `TextArea` per entry of `offsets`, all sharing `buffer` and tinted
/// `color` unless the buffer carries its own per-glyph colours.
struct Pass {
    buffer: usize,
    color: Color,
    offsets: Vec<[f32; 2]>,
}

struct TextDraw {
    track: u32,
    bounds: TextBounds,
    left: f32,
    top: f32,
    scale: f32,
    /// Draw order: shadow, glow, outline, then the text itself.
    passes: Vec<Pass>,
    background: Range<usize>,
}

fn text_areas<'a>(
    buffers: &'a [Buffer],
    draw: &'a TextDraw,
) -> impl Iterator<Item = TextArea<'a>> + 'a {
    draw.passes.iter().flat_map(move |pass| {
        pass.offsets.iter().map(move |[dx, dy]| TextArea {
            buffer: &buffers[pass.buffer],
            left: draw.left + dx,
            top: draw.top + dy,
            scale: draw.scale,
            bounds: shift_bounds(draw.bounds, *dx, *dy),
            default_color: pass.color,
            custom_glyphs: &[],
        })
    })
}

fn shift_bounds(bounds: TextBounds, dx: f32, dy: f32) -> TextBounds {
    TextBounds {
        left: bounds.left + dx.floor() as i32,
        top: bounds.top + dy.floor() as i32,
        right: bounds.right + dx.ceil() as i32,
        bottom: bounds.bottom + dy.ceil() as i32,
    }
}

fn to_color(rgb: [f32; 4], alpha: f32) -> Color {
    Color::rgba(
        (rgb[0].clamp(0.0, 1.0) * 255.0) as u8,
        (rgb[1].clamp(0.0, 1.0) * 255.0) as u8,
        (rgb[2].clamp(0.0, 1.0) * 255.0) as u8,
        (alpha.clamp(0.0, 1.0) * 255.0) as u8,
    )
}

/// Eight compass directions at `radius`, the diagonals pulled in so every
/// copy sits on the same circle.
fn ring(radius: f32) -> impl Iterator<Item = [f32; 2]> {
    let diagonal = radius * std::f32::consts::FRAC_1_SQRT_2;
    [
        [radius, 0.0],
        [-radius, 0.0],
        [0.0, radius],
        [0.0, -radius],
        [diagonal, diagonal],
        [-diagonal, diagonal],
        [diagonal, -diagonal],
        [-diagonal, -diagonal],
    ]
    .into_iter()
}

/// Concentric rings out to `radius`, dense enough that the copies overlap
/// into a solid outline.
fn stroke_offsets(radius: f32) -> Vec<[f32; 2]> {
    let rings = ((radius / 2.5).ceil() as usize).clamp(1, 5);
    (1..=rings)
        .flat_map(|step| ring(radius * step as f32 / rings as f32))
        .collect()
}

/// Radius (em) and alpha of each halo ring, outermost faintest.
const GLOW_RINGS: [(f32, f32); 3] = [(0.04, 0.16), (0.09, 0.10), (0.16, 0.06)];

/// Which reveal unit each byte of `content` belongs to, and how many units
/// there are. Whitespace rides with the unit before it.
fn unit_map(content: &str, by_word: bool) -> (Vec<usize>, usize) {
    let mut map = vec![0; content.len()];
    let mut units = 0usize;
    let mut in_word = false;
    for (index, ch) in content.char_indices() {
        if ch.is_whitespace() {
            in_word = false;
        } else if !by_word || !in_word {
            units += 1;
            in_word = true;
        }
        let unit = units.saturating_sub(1);
        for byte in map.iter_mut().take(index + ch.len_utf8()).skip(index) {
            *byte = unit;
        }
    }
    (map, units)
}

fn stagger_alpha_by_byte(content: &str, edge: Option<StaggerEdge>, out: &mut [f32]) {
    let Some(edge) = edge else {
        return;
    };
    if edge.progress >= 1.0 {
        return;
    }
    let (map, units) = unit_map(content, edge.by_word);
    for (alpha, unit) in out.iter_mut().zip(map) {
        *alpha *= stagger_alpha(edge, unit, units);
    }
}

/// Byte offset of every original line's start, matching cosmic-text's own
/// line split so a glyph's in-line byte range maps back into `content`.
fn line_starts(content: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (index, ch) in content.char_indices() {
        if ch == '\n' {
            starts.push(index + 1);
        }
    }
    starts
}

fn lerp_rgb(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    let t = t.clamp(0.0, 1.0);
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3],
    ]
}

/// Per-byte text colour for a horizontal gradient: each laid-out line runs
/// `from` at its left ink edge to `to` at its right.
fn gradient_by_byte(buffer: &Buffer, content: &str, from: [f32; 4], to: [f32; 4]) -> Vec<[f32; 4]> {
    let mut colors = vec![from; content.len()];
    let starts = line_starts(content);
    for run in buffer.layout_runs() {
        let Some(base) = starts.get(run.line_i).copied() else {
            continue;
        };
        let (min_x, max_x) = run
            .glyphs
            .iter()
            .fold((f32::MAX, f32::MIN), |(lo, hi), glyph| {
                (lo.min(glyph.x), hi.max(glyph.x + glyph.w))
            });
        let span = (max_x - min_x).max(1.0);
        for glyph in run.glyphs {
            let t = (glyph.x + glyph.w * 0.5 - min_x) / span;
            let color = lerp_rgb(from, to, t);
            for byte in colors
                .iter_mut()
                .take((base + glyph.end).min(content.len()))
                .skip(base + glyph.start)
            {
                *byte = color;
            }
        }
    }
    colors
}

/// Coalesces per-byte colours into the fewest rich-text spans that rebuild
/// `content` exactly, which is what `set_rich_text` needs.
fn rich_spans(content: &str, colors: &[Color]) -> Vec<(Range<usize>, Color)> {
    let mut spans: Vec<(Range<usize>, Color)> = Vec::new();
    for (index, _) in content.char_indices() {
        let color = colors[index];
        match spans.last_mut() {
            Some((range, last)) if *last == color => range.end = index,
            _ => spans.push((index..index, color)),
        }
    }
    let mut end = content.len();
    for (range, _) in spans.iter_mut().rev() {
        range.end = end;
        end = range.start;
    }
    spans
}

/// The ink extent of one laid-out line: `(left, right)` from the leftmost
/// glyph edge to the rightmost, in unscaled buffer space, or `None` for an
/// empty line.
fn run_ink(run: &glyphon::LayoutRun<'_>) -> Option<(f32, f32)> {
    run.glyphs
        .iter()
        .fold(None, |extent: Option<(f32, f32)>, glyph| {
            let (lo, hi) = extent.unwrap_or((f32::MAX, f32::MIN));
            Some((lo.min(glyph.x), hi.max(glyph.x + glyph.w)))
        })
}

impl TextLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let font_system = super::new_font_system();
        let glyph_phase = crate::readiness::Phase::start("glyph.text.gpu_resources");
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
        glyph_phase.finish("returned");

        Self {
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            viewport,
            buffers: Vec::new(),
            draws: Vec::new(),
            segment_renderers: Vec::new(),
            background: None,
            segmented_render: false,
        }
    }

    pub fn prepare(
        &mut self,
        device: &Device,
        queue: &Queue,
        output_size: (u32, u32),
        texts: &[PreparedText],
    ) {
        self.prepare_with_mode(device, queue, output_size, texts, false);
    }

    pub fn prepare_mixed(
        &mut self,
        device: &Device,
        queue: &Queue,
        output_size: (u32, u32),
        texts: &[PreparedText],
    ) {
        self.prepare_with_mode(device, queue, output_size, texts, true);
    }

    fn shape(
        &mut self,
        content: &str,
        attrs: &Attrs<'_>,
        align: Align,
        metrics: Metrics,
        wrap_width: f32,
        colors: Option<&[Color]>,
    ) -> usize {
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        // The box only constrains wrapping; height is unbounded so every
        // line is laid out even when the configured box is a little
        // shorter than the shaped text (e.g. font metric differences
        // between the editor's measurement and cosmic-text).
        buffer.set_size(&mut self.font_system, Some(wrap_width), None);
        buffer.set_wrap(&mut self.font_system, glyphon::Wrap::Word);
        match colors {
            Some(colors) => {
                let spans = rich_spans(content, colors);
                buffer.set_rich_text(
                    &mut self.font_system,
                    spans.iter().map(|(range, color)| {
                        (&content[range.clone()], attrs.clone().color(*color))
                    }),
                    attrs,
                    Shaping::Advanced,
                    Some(align),
                );
            }
            None => {
                buffer.set_text(&mut self.font_system, content, attrs, Shaping::Advanced);
                for line in buffer.lines.iter_mut() {
                    line.set_align(Some(align));
                }
            }
        }
        buffer.shape_until_scroll(&mut self.font_system, false);
        self.buffers.push(buffer);
        self.buffers.len() - 1
    }

    fn prepare_with_mode(
        &mut self,
        device: &Device,
        queue: &Queue,
        output_size: (u32, u32),
        texts: &[PreparedText],
        force_segmented: bool,
    ) {
        self.buffers.clear();
        self.draws.clear();
        let mut backgrounds: Vec<TextBackgroundUniforms> = Vec::new();
        let output_px = [output_size.0.max(1) as f32, output_size.1.max(1) as f32];

        for text in texts {
            let alpha = text.color[3].clamp(0.0, 1.0) * text.opacity.clamp(0.0, 1.0);

            let width = (text.bounds[2] - text.bounds[0]).max(1.0);
            let height = (text.bounds[3] - text.bounds[1]).max(1.0);

            // Shape with a little more width than the editor-measured box:
            // the webview and cosmic-text can disagree by a few pixels per
            // line, and without slack a line that fit in the editor wraps in
            // the render. The room is placed so the aligned edge stays put —
            // split for centered text, after for left, before for right.
            // Boxes already spanning the frame keep their exact width — there
            // the editor genuinely wrapped too.
            let output_width = output_px[0];
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
            // Glyph colour comes from each area's default_color (or, for a
            // gradient / staggered reveal, from per-span attrs) so the
            // shadow, glow and outline passes can re-tint the same layout.
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
            let align = match text.align {
                TextAlign::Left => Align::Left,
                TextAlign::Center => Align::Center,
                TextAlign::Right => Align::Right,
            };

            let content = text.content.as_str();
            let plain = self.shape(content, &attrs, align, metrics, wrap_width, None);
            let laid_out_height =
                self.buffers[plain].layout_runs().count() as f32 * metrics.line_height;
            // The glyphs' own horizontal extent across every line, so a
            // background hugs the text rather than the authored box and a
            // wipe reveals the ink proportionally whatever the alignment.
            let ink = self.buffers[plain]
                .layout_runs()
                .filter_map(|run| run_ink(&run))
                .fold(None, |extent: Option<(f32, f32)>, (lo, hi)| {
                    let (min, max) = extent.unwrap_or((lo, hi));
                    Some((min.min(lo), max.max(hi)))
                });

            let staggered = text.stagger_in.is_some_and(|edge| edge.progress < 1.0)
                || text.stagger_out.is_some_and(|edge| edge.progress < 1.0);
            let mut unit_alpha = vec![1.0f32; content.len()];
            if staggered {
                stagger_alpha_by_byte(content, text.stagger_in, &mut unit_alpha);
                stagger_alpha_by_byte(content, text.stagger_out, &mut unit_alpha);
            }
            let gradient = text
                .gradient_color
                .map(|to| gradient_by_byte(&self.buffers[plain], content, text.color, to));

            // A pass whose colour varies per glyph needs its own buffer; a
            // flat pass re-tints the plain layout through default_color.
            let pass = |this: &mut Self,
                        rgb: [f32; 4],
                        pass_alpha: f32,
                        offsets: Vec<[f32; 2]>,
                        is_main: bool| {
                let gradient = if is_main { gradient.as_deref() } else { None };
                if !staggered && gradient.is_none() {
                    return Pass {
                        buffer: plain,
                        color: to_color(rgb, pass_alpha),
                        offsets,
                    };
                }
                let colors: Vec<Color> = (0..content.len())
                    .map(|byte| {
                        let rgb = gradient.map_or(rgb, |colors| colors[byte]);
                        to_color(rgb, pass_alpha * unit_alpha[byte])
                    })
                    .collect();
                Pass {
                    buffer: this.shape(content, &attrs, align, metrics, wrap_width, Some(&colors)),
                    color: to_color(rgb, pass_alpha),
                    offsets,
                }
            };

            // Animation transform: uniform scale about the box center plus a
            // translation, applied to the buffer origin and clip bounds (the
            // glyph layout itself is scaled by TextArea::scale from that
            // origin).
            let cx = (text.bounds[0] + text.bounds[2]) / 2.0;
            let cy = (text.bounds[1] + text.bounds[3]) / 2.0;
            let scale = text.scale.max(0.01);
            let tx = |x: f32| cx + (x - cx) * scale + text.offset[0];
            let ty = |y: f32| cy + (y - cy) * scale + text.offset[1];

            let block_left = text.bounds[0] - origin_dx;
            let origin_left = tx(block_left);
            let origin_top = ty(text.bounds[1]);
            let wipe = text.wipe.clamp(0.0, 1.0);
            let clip_right = match ink {
                Some((ink_left, ink_right)) if wipe < 1.0 => {
                    block_left + ink_left + (ink_right - ink_left) * wipe
                }
                _ => block_left + wrap_width,
            };

            // Clip horizontally at the (slack-expanded) wrap box, but extend
            // the bottom to the laid-out text height so descenders and extra
            // lines never get cut off; glyphon intersects these bounds with
            // the viewport. A wipe narrows the right edge.
            let bounds = TextBounds {
                left: origin_left.floor() as i32,
                top: origin_top.floor() as i32,
                right: tx(clip_right).ceil() as i32,
                bottom: ty(text.bounds[1] + height.max(laid_out_height)).ceil() as i32,
            };

            let mut passes = Vec::new();
            if text.shadow > 0.0 {
                let dx = text.font_size * scale * 0.02;
                let dy = text.font_size * scale * 0.055;
                let shadow_alpha = alpha * text.shadow.clamp(0.0, 1.0) * 0.85;
                passes.push(pass(
                    self,
                    [0.0, 0.0, 0.0, 1.0],
                    shadow_alpha,
                    vec![[dx, dy]],
                    false,
                ));
            }
            if text.glow > 0.0 {
                for (radius_em, ring_alpha) in GLOW_RINGS {
                    let radius = radius_em * text.font_size * scale;
                    passes.push(pass(
                        self,
                        text.color,
                        alpha * ring_alpha * text.glow,
                        ring(radius).collect(),
                        false,
                    ));
                }
            }
            if let Some((stroke_px, stroke_color)) = text.stroke {
                passes.push(pass(
                    self,
                    stroke_color,
                    alpha,
                    stroke_offsets(stroke_px * scale),
                    false,
                ));
            }
            passes.push(pass(self, text.color, alpha, vec![[0.0, 0.0]], true));

            let background_start = backgrounds.len();
            if let Some(background_color) = text.background_color {
                let color = [
                    background_color[0],
                    background_color[1],
                    background_color[2],
                    background_color[3] * text.opacity.clamp(0.0, 1.0),
                ];
                let uniforms = |(mut rect, radius): ([f32; 4], f32)| {
                    rect[2] *= wipe;
                    TextBackgroundUniforms {
                        rect,
                        color,
                        radius: radius.min(rect[2] * 0.5),
                        _padding0: 0.0,
                        _padding1: 0.0,
                        _padding2: 0.0,
                        output_size: output_px,
                        _padding3: [0.0; 2],
                    }
                };
                match text.background_style {
                    TextBackgroundStyle::Highlight => {
                        for run in self.buffers[plain].layout_runs() {
                            let Some((ink_left, ink_right)) = run_ink(&run) else {
                                continue;
                            };
                            backgrounds.push(uniforms(crate::text::highlight_rect(
                                (block_left + ink_left, block_left + ink_right),
                                (text.bounds[1] + run.line_top, run.line_height),
                                text.font_size,
                                [cx, cy],
                                scale,
                                text.offset,
                            )));
                        }
                    }
                    style => {
                        let hugged = ink.map_or(text.bounds, |(ink_left, ink_right)| {
                            [
                                block_left + ink_left,
                                text.bounds[1],
                                block_left + ink_right,
                                text.bounds[3],
                            ]
                        });
                        backgrounds.push(uniforms(crate::text::background_rect(
                            hugged,
                            laid_out_height,
                            text.font_size,
                            [cx, cy],
                            scale,
                            text.offset,
                            style == TextBackgroundStyle::Pill,
                        )));
                    }
                }
            }

            self.draws.push(TextDraw {
                track: text.track,
                bounds,
                left: origin_left,
                top: origin_top,
                scale,
                passes,
                background: background_start..backgrounds.len(),
            });
        }

        self.viewport.update(
            queue,
            Resolution {
                width: output_size.0,
                height: output_size.1,
            },
        );

        self.segmented_render = force_segmented || !backgrounds.is_empty();
        if self.segmented_render {
            let background = self
                .background
                .get_or_insert_with(|| TextBackgroundResources::new(device));
            background.ensure_capacity(device, backgrounds.len());
            for (index, uniforms) in backgrounds.iter().enumerate() {
                background.write(queue, index, uniforms);
            }

            while self.segment_renderers.len() < self.draws.len() {
                self.segment_renderers.push(TextRenderer::new(
                    &mut self.text_atlas,
                    device,
                    wgpu::MultisampleState::default(),
                    None,
                ));
            }
            for (index, draw) in self.draws.iter().enumerate() {
                if let Err(error) = self.segment_renderers[index].prepare(
                    device,
                    queue,
                    &mut self.font_system,
                    &mut self.text_atlas,
                    &self.viewport,
                    text_areas(&self.buffers, draw),
                    &mut self.swash_cache,
                ) {
                    warn!("Failed to prepare text: {error:?}");
                }
            }
        } else if let Err(error) = self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            self.draws
                .iter()
                .flat_map(|draw| text_areas(&self.buffers, draw)),
            &mut self.swash_cache,
        ) {
            warn!("Failed to prepare text: {error:?}");
        }
    }

    fn render_draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>, index: usize) {
        let draw = &self.draws[index];
        if let Some(background) = &self.background {
            for rect in draw.background.clone() {
                background.render(pass, rect);
            }
        }
        if let Err(error) =
            self.segment_renderers[index].render(&self.text_atlas, &self.viewport, pass)
        {
            warn!("Failed to render text: {error:?}");
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if self.segmented_render {
            for index in 0..self.draws.len() {
                self.render_draw(pass, index);
            }
        } else if let Err(error) = self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            warn!("Failed to render text: {error:?}");
        }
    }

    pub fn render_track<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>, track: u32) {
        if !self.segmented_render {
            return;
        }
        for index in 0..self.draws.len() {
            if self.draws[index].track == track {
                self.render_draw(pass, index);
            }
        }
    }

    pub fn has_track(&self, track: u32) -> bool {
        self.segmented_render && self.draws.iter().any(|draw| draw.track == track)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_letters_map_bytes_to_reveal_units() {
        let (map, units) = unit_map("Hi there", true);
        assert_eq!(units, 2);
        assert_eq!(map, [0, 0, 0, 1, 1, 1, 1, 1]);

        let (map, units) = unit_map("Hi there", false);
        assert_eq!(units, 7);
        assert_eq!(map, [0, 1, 1, 2, 3, 4, 5, 6]);

        let (map, units) = unit_map("é a", false);
        assert_eq!(units, 2);
        assert_eq!(map, [0, 0, 0, 1]);
    }

    #[test]
    fn rich_spans_rebuild_the_whole_string() {
        let content = "ab\ncd";
        let red = Color::rgb(255, 0, 0);
        let blue = Color::rgb(0, 0, 255);
        let colors = [red, red, red, blue, blue];
        let spans = rich_spans(content, &colors);
        assert_eq!(spans, vec![(0..3, red), (3..5, blue)]);
        let rebuilt: String = spans
            .iter()
            .map(|(range, _)| &content[range.clone()])
            .collect();
        assert_eq!(rebuilt, content);
    }

    #[test]
    fn stroke_rings_grow_with_the_radius() {
        assert_eq!(stroke_offsets(1.0).len(), 8);
        assert_eq!(stroke_offsets(6.0).len(), 24);
        assert_eq!(stroke_offsets(100.0).len(), 40);
        let far = stroke_offsets(6.0);
        assert!(
            far.iter()
                .all(|[x, y]| (x * x + y * y).sqrt() <= 6.0 + 1e-4)
        );
    }

    #[test]
    fn line_starts_follow_newlines() {
        assert_eq!(line_starts("a\nbc\n"), [0, 2, 5]);
    }
}

#[cfg(test)]
mod gpu_tests {
    use super::*;
    use crate::create_wgpu_instance_sync;
    use crate::text::PreparedText;

    const OUTPUT: u32 = 64;

    fn device() -> Option<(Device, Queue)> {
        let instance = create_wgpu_instance_sync();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
    }

    fn text(bounds: [f32; 4], color: [f32; 4]) -> PreparedText {
        PreparedText {
            track: 0,
            content: " ".to_string(),
            bounds,
            color: [1.0; 4],
            background_color: Some(color),
            font_family: "sans-serif".to_string(),
            font_size: 48.0,
            font_weight: 400.0,
            italic: false,
            opacity: 1.0,
            align: TextAlign::Left,
            letter_spacing: 0.0,
            line_height: 1.2,
            shadow: 0.0,
            offset: [0.0, 0.0],
            scale: 1.0,
            stroke: None,
            glow: 0.0,
            gradient_color: None,
            background_style: TextBackgroundStyle::Box,
            wipe: 1.0,
            stagger_in: None,
            stagger_out: None,
        }
    }

    fn render_pixels(device: &Device, queue: &Queue, layer: &TextLayer) -> Vec<u8> {
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Text Background Test Target"),
            size: wgpu::Extent3d {
                width: OUTPUT,
                height: OUTPUT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Text Background Test Readback"),
            size: (OUTPUT * OUTPUT * 4) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Text Background Test Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            layer.render(&mut pass);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(OUTPUT * 4),
                    rows_per_image: Some(OUTPUT),
                },
            },
            wgpu::Extent3d {
                width: OUTPUT,
                height: OUTPUT,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::Wait).unwrap();
        let pixels = readback.slice(..).get_mapped_range().to_vec();
        readback.unmap();
        pixels
    }

    fn pixel(pixels: &[u8], x: u32, y: u32) -> [u8; 4] {
        let index = ((y * OUTPUT + x) * 4) as usize;
        pixels[index..index + 4].try_into().unwrap()
    }

    #[test]
    #[ignore = "requires a working wgpu adapter"]
    fn text_background_timeline_preserves_order_and_shrinks_without_stale_layers() {
        let (device, queue) = device().expect("A working wgpu adapter is required for this test");
        let mut layer = TextLayer::new(&device, &queue);
        let first = text([16.0, 16.0, 32.0, 32.0], [1.0, 0.0, 0.0, 1.0]);
        let second = text([32.0, 32.0, 48.0, 48.0], [0.0, 0.0, 1.0, 1.0]);

        layer.prepare(&device, &queue, (OUTPUT, OUTPUT), &[first.clone(), second]);
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 12, 28), [255, 0, 0, 255]);
        assert_eq!(pixel(&pixels, 28, 28), [0, 0, 255, 255]);
        assert_eq!(pixel(&pixels, 48, 40), [0, 0, 255, 255]);

        layer.prepare(&device, &queue, (OUTPUT, OUTPUT), &[first.clone()]);
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 28, 28), [255, 0, 0, 255]);
        assert_eq!(pixel(&pixels, 48, 40), [255, 255, 255, 255]);

        layer.prepare(&device, &queue, (OUTPUT, OUTPUT), &[]);
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 28, 28), [255, 255, 255, 255]);

        let mut no_background = first;
        no_background.background_color = None;
        layer.prepare(&device, &queue, (OUTPUT, OUTPUT), &[no_background]);
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 12, 28), [255, 255, 255, 255]);

        let mut multiline = text([12.0, 8.0, 48.0, 20.0], [0.0, 0.0, 1.0, 1.0]);
        multiline.content = "Top\ngyp\nq".to_string();
        multiline.font_size = 10.0;
        layer.prepare(&device, &queue, (OUTPUT, OUTPUT), &[multiline]);
        assert_eq!(layer.buffers[0].layout_runs().count(), 3);
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 11, 38), [0, 0, 255, 255]);
        assert_eq!(pixel(&pixels, 11, 42), [0, 0, 255, 255]);
        assert!((32..44).any(|y| (12..32).any(|x| {
            let [red, green, _, _] = pixel(&pixels, x, y);
            red > 200 && green > 200
        })));
    }
}
