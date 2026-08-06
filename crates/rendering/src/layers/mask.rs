use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::{MaskRenderMode, PreparedMask, RenderSession};

const PIXELATE_MODE: u32 = 0;
const HIGHLIGHT_MODE: u32 = 1;
const BLUR_HORIZONTAL_MODE: u32 = 2;
const BLUR_VERTICAL_MODE: u32 = 3;

pub struct MaskLayer {
    sampler: wgpu::Sampler,
    pipeline: MaskPipeline,
}

struct MaskPass<'a> {
    source_texture_view: &'a wgpu::TextureView,
    target_texture_view: &'a wgpu::TextureView,
    render_pipeline: &'a wgpu::RenderPipeline,
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
        }
    }

    pub fn render(
        &self,
        device: &wgpu::Device,
        _queue: &wgpu::Queue,
        session: &mut RenderSession,
        encoder: &mut wgpu::CommandEncoder,
        mask: &PreparedMask,
    ) {
        match mask.mode {
            MaskRenderMode::Blur => {
                self.render_pass(
                    device,
                    encoder,
                    MaskPass {
                        source_texture_view: session.current_texture_view(),
                        target_texture_view: session.other_texture_view(),
                        render_pipeline: &self.pipeline.render_pipeline,
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        uniforms: MaskUniforms::from_mask(mask, BLUR_HORIZONTAL_MODE),
                    },
                );
                self.render_pass(
                    device,
                    encoder,
                    MaskPass {
                        source_texture_view: session.other_texture_view(),
                        target_texture_view: session.current_texture_view(),
                        render_pipeline: &self.pipeline.blur_composite_pipeline,
                        load: wgpu::LoadOp::Load,
                        uniforms: MaskUniforms::from_mask(mask, BLUR_VERTICAL_MODE),
                    },
                );
            }
            MaskRenderMode::Pixelate => {
                self.render_single_pass(device, session, encoder, mask, PIXELATE_MODE);
            }
            MaskRenderMode::Highlight => {
                self.render_single_pass(device, session, encoder, mask, HIGHLIGHT_MODE);
            }
        }
    }

    fn render_single_pass(
        &self,
        device: &wgpu::Device,
        session: &mut RenderSession,
        encoder: &mut wgpu::CommandEncoder,
        mask: &PreparedMask,
        mode: u32,
    ) {
        self.render_pass(
            device,
            encoder,
            MaskPass {
                source_texture_view: session.current_texture_view(),
                target_texture_view: session.other_texture_view(),
                render_pipeline: &self.pipeline.render_pipeline,
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                uniforms: MaskUniforms::from_mask(mask, mode),
            },
        );
        session.swap_textures();
    }

    fn render_pass(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        config: MaskPass<'_>,
    ) {
        let uniforms_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Mask Uniform Buffer"),
            contents: bytemuck::cast_slice(&[config.uniforms]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bind_group = self.pipeline.bind_group(
            device,
            &uniforms_buffer,
            config.source_texture_view,
            &self.sampler,
        );

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

        pass.set_pipeline(config.render_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);

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
