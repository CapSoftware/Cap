use bytemuck::{Pod, Zeroable};
use wgpu::{include_wgsl, util::DeviceExt, TextureFormat};

use crate::frame_pipeline::FramePipeline;

pub struct BlurLayer;

impl BlurLayer {
    pub fn render(pipeline: &mut FramePipeline, rect: [f32; 4], blur_radius: f32) {
        let constants = &pipeline.state.constants;

        // TODO: Can we remove this
        let intermediate_texture = constants.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Blur Intermediate Texture"),
            size: pipeline.state.get_current_texture().size(),
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: pipeline.state.get_current_texture().format(),
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let intermediate_view =
            intermediate_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // First pass - Horizontal blur
        let input_view = pipeline.state.get_current_texture_view();

        let horizontal_bind_group = constants.blur_pipeline.bind_group(
            &constants.device,
            &input_view,
            &BlurUniforms {
                rect,
                direction: [1.0, 0.0],
                blur_radius,
                _pad: 0.0,
            }
            .to_buffer(&constants.device),
        );
        let vertical_bind_group = constants.blur_pipeline.bind_group(
            &constants.device,
            &intermediate_view,
            &BlurUniforms {
                rect,
                direction: [0.0, 1.0],
                blur_radius,
                _pad: 0.0,
            }
            .to_buffer(&constants.device),
        );

        // First pass render - horizontal blur to intermediate texture
        pipeline.encoder.do_render_pass(
            &intermediate_view,
            &constants.blur_pipeline.render_pipeline,
            horizontal_bind_group,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            0..6,
        );

        // Second pass render - vertical blur to output
        pipeline.encoder.do_render_pass(
            &pipeline.state.get_current_texture_view(),
            &constants.blur_pipeline.render_pipeline,
            vertical_bind_group,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            0..6,
        );
    }
}

pub struct BlurPipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
    pub sampler: wgpu::Sampler,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct BlurUniforms {
    rect: [f32; 4], // x, y, width, height
    direction: [f32; 2],
    blur_radius: f32,
    _pad: f32,
}

impl BlurUniforms {
    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("BlurUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }
}

impl BlurPipeline {
    pub fn new(device: &wgpu::Device, format: TextureFormat) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Blur Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let shader = device.create_shader_module(include_wgsl!("../shaders/blur.wgsl"));

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Blur Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Blur Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Blur Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            bind_group_layout,
            render_pipeline,
            sampler,
        }
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        uniforms: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blur Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniforms.as_entire_binding(),
                },
            ],
        });

        bind_group
    }
}
