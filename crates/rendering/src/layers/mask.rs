use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use super::SourceBindGroups;
use crate::{MaskRenderMode, PreparedMask, RenderSession};

const PIXELATE_MODE: u32 = 0;
const HIGHLIGHT_MODE: u32 = 1;
const BLUR_HORIZONTAL_MODE: u32 = 2;
const BLUR_VERTICAL_MODE: u32 = 3;

pub struct MaskLayer {
    sampler: wgpu::Sampler,
    pipeline: MaskPipeline,
    /// One uniform buffer per mask pass in a frame. Every pass of a frame is
    /// encoded before it is submitted, so passes cannot share a buffer.
    uniform_buffers: Vec<(wgpu::Buffer, MaskUniforms)>,
    next_uniform_buffer: usize,
    bind_groups: SourceBindGroups,
}

struct MaskPass<'a> {
    source_texture_view: &'a wgpu::TextureView,
    target_texture_view: &'a wgpu::TextureView,
    blur_composite: bool,
    load: wgpu::LoadOp<wgpu::Color>,
    uniforms: MaskUniforms,
}

impl MaskLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
            pipeline: MaskPipeline::new(device),
            uniform_buffers: Vec::new(),
            next_uniform_buffer: 0,
            bind_groups: SourceBindGroups::default(),
        }
    }

    pub fn begin_frame(&mut self, views: [&wgpu::TextureView; 2]) {
        self.next_uniform_buffer = 0;
        self.bind_groups.retain_views(views);
    }

    #[cfg(test)]
    pub fn bind_groups_created(&self) -> usize {
        self.bind_groups.created()
    }

    #[cfg(test)]
    pub fn uniform_buffer_count(&self) -> usize {
        self.uniform_buffers.len()
    }

    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        session: &mut RenderSession,
        encoder: &mut wgpu::CommandEncoder,
        mask: &PreparedMask,
    ) {
        match mask.mode {
            MaskRenderMode::Blur => {
                self.render_pass(
                    device,
                    queue,
                    encoder,
                    MaskPass {
                        source_texture_view: session.current_texture_view(),
                        target_texture_view: session.other_texture_view(),
                        blur_composite: false,
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        uniforms: MaskUniforms::from_mask(mask, BLUR_HORIZONTAL_MODE),
                    },
                );
                self.render_pass(
                    device,
                    queue,
                    encoder,
                    MaskPass {
                        source_texture_view: session.other_texture_view(),
                        target_texture_view: session.current_texture_view(),
                        blur_composite: true,
                        load: wgpu::LoadOp::Load,
                        uniforms: MaskUniforms::from_mask(mask, BLUR_VERTICAL_MODE),
                    },
                );
            }
            MaskRenderMode::Pixelate => {
                self.render_single_pass(device, queue, session, encoder, mask, PIXELATE_MODE);
            }
            MaskRenderMode::Highlight => {
                self.render_single_pass(device, queue, session, encoder, mask, HIGHLIGHT_MODE);
            }
        }
    }

    fn render_single_pass(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        session: &mut RenderSession,
        encoder: &mut wgpu::CommandEncoder,
        mask: &PreparedMask,
        mode: u32,
    ) {
        self.render_pass(
            device,
            queue,
            encoder,
            MaskPass {
                source_texture_view: session.current_texture_view(),
                target_texture_view: session.other_texture_view(),
                blur_composite: false,
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                uniforms: MaskUniforms::from_mask(mask, mode),
            },
        );
        session.swap_textures();
    }

    fn render_pass(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        config: MaskPass<'_>,
    ) {
        let index = self.next_uniform_buffer;
        self.next_uniform_buffer += 1;
        match self.uniform_buffers.get_mut(index) {
            Some((buffer, written)) => {
                if *written != config.uniforms {
                    queue.write_buffer(buffer, 0, bytemuck::cast_slice(&[config.uniforms]));
                    *written = config.uniforms;
                }
            }
            None => self.uniform_buffers.push((
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Mask Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[config.uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                }),
                config.uniforms,
            )),
        }
        let uniforms_buffer = &self.uniform_buffers[index].0;

        let bind_group =
            self.bind_groups
                .get_or_create(uniforms_buffer, config.source_texture_view, || {
                    self.pipeline.bind_group(
                        device,
                        uniforms_buffer,
                        config.source_texture_view,
                        &self.sampler,
                    )
                });

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Mask Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: config.target_texture_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: config.load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(if config.blur_composite {
            &self.pipeline.blur_composite_pipeline
        } else {
            &self.pipeline.render_pipeline
        });
        pass.set_bind_group(0, bind_group, &[]);
        config.uniforms.draw(&mut pass);

        drop(pass);
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, PartialEq)]
struct MaskUniforms {
    rect_center: [f32; 2],
    rect_size: [f32; 2],
    feather: f32,
    opacity: f32,
    effect_size: f32,
    darkness: f32,
    mode: u32,
    padding0: u32,
    output_size: [f32; 2],
    padding1: [f32; 2],
}

impl Default for MaskUniforms {
    fn default() -> Self {
        Self::zeroed()
    }
}

impl MaskUniforms {
    fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(rect @ [left, top, width, height]) = self.blur_scissor() {
            if width == 0 || height == 0 {
                return;
            }
            if rect != [0, 0, self.output_size[0] as u32, self.output_size[1] as u32] {
                pass.set_scissor_rect(left, top, width, height);
            }
        }
        pass.draw(0..3, 0..1);
    }

    fn blur_scissor(&self) -> Option<[u32; 4]> {
        let padding = match self.mode {
            BLUR_HORIZONTAL_MODE => [2.0, self.effect_size.max(1.0) + 2.0],
            BLUR_VERTICAL_MODE => [1.0, 1.0],
            _ => return None,
        };
        if !self
            .rect_center
            .iter()
            .chain(&self.rect_size)
            .chain(&self.output_size)
            .chain(std::iter::once(&self.effect_size))
            .all(|value| value.is_finite())
            || self.output_size.iter().any(|size| *size <= 0.0)
        {
            return None;
        }

        let bounds = std::array::from_fn::<_, 2, _>(|axis| {
            let center = self.rect_center[axis] * self.output_size[axis];
            let half_size = self.rect_size[axis] * self.output_size[axis] * 0.5;
            let start = (center - half_size - padding[axis])
                .floor()
                .clamp(0.0, self.output_size[axis]) as u32;
            let end = (center + half_size + padding[axis])
                .ceil()
                .clamp(0.0, self.output_size[axis]) as u32;
            (start, end.saturating_sub(start))
        });
        Some([bounds[0].0, bounds[1].0, bounds[0].1, bounds[1].1])
    }

    fn from_mask(mask: &PreparedMask, mode: u32) -> Self {
        Self {
            rect_center: [mask.center.x, mask.center.y],
            rect_size: [mask.size.x, mask.size.y],
            feather: mask.feather,
            opacity: mask.opacity,
            effect_size: mask.effect_size,
            darkness: mask.darkness,
            mode,
            padding0: 0,
            output_size: [mask.output_size.x as f32, mask.output_size.y as f32],
            padding1: [0.0; 2],
        }
    }
}

pub struct MaskPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
    blur_composite_pipeline: wgpu::RenderPipeline,
}

impl MaskPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Mask Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Mask Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/mask.wgsl").into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Mask Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let create_render_pipeline = |label, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[],
                        zero_initialize_workgroup_memory: false,
                    },
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[],
                        zero_initialize_workgroup_memory: false,
                    },
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: Some(wgpu::Face::Back),
                    polygon_mode: wgpu::PolygonMode::Fill,
                    unclipped_depth: false,
                    conservative: false,
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let render_pipeline = create_render_pipeline("Mask Pipeline", wgpu::BlendState::REPLACE);
        let blur_composite_pipeline = create_render_pipeline(
            "Mask Blur Composite Pipeline",
            wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::Zero,
                    dst_factor: wgpu::BlendFactor::One,
                    operation: wgpu::BlendOperation::Add,
                },
            },
        );

        Self {
            bind_group_layout,
            render_pipeline,
            blur_composite_pipeline,
        }
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        uniform_buffer: &wgpu::Buffer,
        texture_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Mask Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniforms(center: [f32; 2], size: [f32; 2], effect_size: f32, mode: u32) -> MaskUniforms {
        MaskUniforms {
            rect_center: center,
            rect_size: size,
            effect_size,
            mode,
            output_size: [1920.0, 1080.0],
            ..Default::default()
        }
    }

    #[test]
    fn blur_scissor_bounds() {
        let cases = [
            ([0.5, 0.5], [0.1, 0.1], 12.0, [862, 472, 196, 136]),
            ([0.5, 0.5], [0.5, 0.5], 24.0, [478, 244, 964, 592]),
            ([0.5, 0.5], [1.0, 1.0], 12.0, [0, 0, 1920, 1080]),
            ([0.02, 0.04], [0.1, 0.12], 8.0, [0, 0, 137, 118]),
            ([-0.2, 0.5], [0.1, 0.1], 12.0, [0, 472, 0, 136]),
            (
                [0.3333, 0.6667],
                [0.1234, 0.2345],
                7.25,
                [519, 584, 242, 272],
            ),
            ([0.5, 0.5], [0.1, 0.1], 0.25, [862, 483, 196, 114]),
        ];

        for (center, size, radius, expected) in cases {
            assert_eq!(
                uniforms(center, size, radius, BLUR_HORIZONTAL_MODE).blur_scissor(),
                Some(expected)
            );
        }
        assert_eq!(
            uniforms([0.5, 0.5], [0.1, 0.1], 12.0, BLUR_VERTICAL_MODE).blur_scissor(),
            Some([863, 485, 194, 110])
        );
    }

    #[test]
    fn blur_scissor_fallback() {
        assert_eq!(
            uniforms([0.5, 0.5], [0.1, 0.1], 12.0, PIXELATE_MODE).blur_scissor(),
            None
        );
        assert_eq!(
            uniforms([f32::NAN, 0.5], [0.1, 0.1], 12.0, BLUR_HORIZONTAL_MODE).blur_scissor(),
            None
        );

        let mut zero_output = uniforms([0.5, 0.5], [0.1, 0.1], 12.0, BLUR_HORIZONTAL_MODE);
        zero_output.output_size[0] = 0.0;
        assert_eq!(zero_output.blur_scissor(), None);
    }

    #[test]
    #[ignore = "requires a real WGPU adapter"]
    fn blur_scissor_pixels() {
        let adapter =
            pollster::block_on(wgpu::Instance::default().request_adapter(&Default::default()))
                .expect("GPU mask tests require a WGPU adapter");
        assert_ne!(adapter.get_info().backend, wgpu::Backend::Noop);
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))
            .expect("request mask test device");
        let layer = MaskLayer::new(&device);
        let mask = |center, size| MaskUniforms {
            feather: 0.01,
            opacity: 1.0,
            output_size: [128.0, 96.0],
            ..uniforms(center, size, 12.0, BLUR_HORIZONTAL_MODE)
        };
        let cases = [
            (
                "fractional",
                &[mask([0.3333, 0.6667], [0.1234, 0.2345])][..],
            ),
            ("edge-clipped", &[mask([0.02, 0.99], [0.13, 0.12])][..]),
            (
                "overlapping",
                &[
                    mask([0.47, 0.5], [0.28, 0.3]),
                    mask([0.57, 0.55], [0.26, 0.24]),
                ],
            ),
        ];
        for (name, masks) in cases {
            let expected = blur_pixels(&device, &queue, &layer, masks, false);
            let actual = blur_pixels(&device, &queue, &layer, masks, true);
            assert_eq!(actual, expected, "{name} pixels differ");
        }
    }

    fn blur_pixels(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layer: &MaskLayer,
        masks: &[MaskUniforms],
        scissored: bool,
    ) -> Vec<u8> {
        let size = wgpu::Extent3d {
            width: 128,
            height: 96,
            depth_or_array_layers: 1,
        };
        let texture = || {
            device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        let source = texture();
        let scratch = texture();
        let source_view = source.create_view(&Default::default());
        let scratch_view = scratch.create_view(&Default::default());
        let pixels = (0..size.width * size.height * 4)
            .map(|index| (index * 37 % 251) as u8)
            .collect::<Vec<_>>();
        let layout = wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(size.width * 4),
            rows_per_image: Some(size.height),
        };
        queue.write_texture(source.as_image_copy(), &pixels, layout, size);
        let mut encoder = device.create_command_encoder(&Default::default());
        for mask in masks {
            for (source, target, pipeline, load, mode) in [
                (
                    &source_view,
                    &scratch_view,
                    &layer.pipeline.render_pipeline,
                    wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    BLUR_HORIZONTAL_MODE,
                ),
                (
                    &scratch_view,
                    &source_view,
                    &layer.pipeline.blur_composite_pipeline,
                    wgpu::LoadOp::Load,
                    BLUR_VERTICAL_MODE,
                ),
            ] {
                let uniforms = MaskUniforms { mode, ..*mask };
                let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: bytemuck::bytes_of(&uniforms),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let bind_group =
                    layer
                        .pipeline
                        .bind_group(device, &uniform_buffer, source, &layer.sampler);
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                if scissored {
                    uniforms.draw(&mut pass);
                } else {
                    pass.draw(0..3, 0..1);
                }
            }
        }
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: pixels.len() as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            source.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout,
            },
            size,
        );
        queue.submit([encoder.finish()]);
        readback.slice(..).map_async(wgpu::MapMode::Read, |result| {
            result.expect("map mask test pixels")
        });
        device
            .poll(wgpu::PollType::Wait)
            .expect("poll mask test device");
        let result = readback.slice(..).get_mapped_range().to_vec();
        readback.unmap();
        assert!(result != pixels, "test mask must change pixels");
        result
    }
}
