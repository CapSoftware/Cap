use bytemuck::{Pod, Zeroable};
use cap_project::TextAlign;
use glyphon::cosmic_text::Align;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use log::warn;
use wgpu::{Device, Queue, include_wgsl, util::DeviceExt};

use crate::text::PreparedText;

pub struct TextLayer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    buffers: Vec<Buffer>,
    segment_renderers: Vec<TextRenderer>,
    background: Option<TextBackgroundResources>,
    segmented_render: bool,
    segment_backgrounds: Vec<bool>,
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

struct AreaSpec {
    bounds: TextBounds,
    left: f32,
    top: f32,
    scale: f32,
    color: Color,
    shadow: Option<(f32, f32, Color)>,
    background: Option<TextBackgroundUniforms>,
}

fn text_areas<'a>(buffer: &'a Buffer, spec: &AreaSpec) -> impl Iterator<Item = TextArea<'a>> {
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
            segment_renderers: Vec::new(),
            background: None,
            segmented_render: false,
            segment_backgrounds: Vec::new(),
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

            let background = text.background_color.map(|background_color| {
                let (rect, radius) = crate::text::text_background_rect(
                    text.bounds,
                    laid_out_height,
                    text.font_size,
                    scale,
                    text.offset,
                );
                TextBackgroundUniforms {
                    rect,
                    color: [
                        background_color[0],
                        background_color[1],
                        background_color[2],
                        background_color[3] * text.opacity.clamp(0.0, 1.0),
                    ],
                    radius,
                    _padding0: 0.0,
                    _padding1: 0.0,
                    _padding2: 0.0,
                    output_size: [output_size.0.max(1) as f32, output_size.1.max(1) as f32],
                    _padding3: [0.0; 2],
                }
            });

            self.buffers.push(buffer);
            specs.push(AreaSpec {
                bounds,
                left: origin_left,
                top: origin_top,
                scale,
                color,
                shadow,
                background,
            });
        }

        self.viewport.update(
            queue,
            Resolution {
                width: output_size.0,
                height: output_size.1,
            },
        );

        self.segmented_render = specs.iter().any(|spec| spec.background.is_some());
        if self.segmented_render {
            self.segment_backgrounds = specs.iter().map(|spec| spec.background.is_some()).collect();
            let background = self
                .background
                .get_or_insert_with(|| TextBackgroundResources::new(device));
            background.ensure_capacity(device, specs.len());
            for (index, spec) in specs.iter().enumerate() {
                if let Some(uniforms) = spec.background {
                    background.write(queue, index, &uniforms);
                }
            }

            while self.segment_renderers.len() < specs.len() {
                self.segment_renderers.push(TextRenderer::new(
                    &mut self.text_atlas,
                    device,
                    wgpu::MultisampleState::default(),
                    None,
                ));
            }
            for (index, spec) in specs.iter().enumerate() {
                if let Err(error) = self.segment_renderers[index].prepare(
                    device,
                    queue,
                    &mut self.font_system,
                    &mut self.text_atlas,
                    &self.viewport,
                    text_areas(&self.buffers[index], spec),
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
            self.buffers
                .iter()
                .zip(&specs)
                .flat_map(|(buffer, spec)| text_areas(buffer, spec)),
            &mut self.swash_cache,
        ) {
            warn!("Failed to prepare text: {error:?}");
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if self.segmented_render {
            if let Some(background) = &self.background {
                for (index, (renderer, has_background)) in self
                    .segment_renderers
                    .iter()
                    .zip(&self.segment_backgrounds)
                    .enumerate()
                {
                    if *has_background {
                        background.render(pass, index);
                    }
                    if let Err(error) = renderer.render(&self.text_atlas, &self.viewport, pass) {
                        warn!("Failed to render text: {error:?}");
                    }
                }
            }
        } else if let Err(error) = self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            warn!("Failed to render text: {error:?}");
        }
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
