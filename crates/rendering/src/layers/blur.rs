use bytemuck::{Pod, Zeroable};
use wgpu::{
    include_wgsl, util::DeviceExt, BindGroupLayoutEntry, BufferBindingType,
    ComputePipelineDescriptor, ShaderSource, ShaderStages, TextureFormat, TextureUsages,
};

use crate::frame_pipeline::FramePipeline;

pub struct BlurLayer;

impl BlurLayer {
    pub fn render(pipeline: &mut FramePipeline, rect: [f32; 4]) {
        let constants = &pipeline.state.constants;

        // Create intermediate textures for blur passes
        let texture_desc = wgpu::TextureDescriptor {
            label: Some("Blur Intermediate Texture"),
            size: pipeline.state.get_current_texture().size(),
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: pipeline.state.get_current_texture().format(),
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        };

        let intermediate_texture = constants.device.create_texture(&texture_desc);
        let intermediate_view =
            intermediate_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let horizontal_uniforms = BlurUniforms {
            rect,
            direction: [1.0, 0.0],
            blur_radius: 4.0,
            _pad: 0.0,
        };

        let vertical_uniforms = BlurUniforms {
            rect,
            direction: [0.0, 1.0],
            blur_radius: 4.0,
            _pad: 0.0,
        };

        let uniform_buffer =
            constants
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Horizontal Blur Uniforms Buffer"),
                    contents: bytemuck::cast_slice(&[horizontal_uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let vertical_uniform_buffer =
            constants
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Vertical Blur Uniforms Buffer"),
                    contents: bytemuck::cast_slice(&[vertical_uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        // Load shader
        let shader = constants
            .device
            .create_shader_module(include_wgsl!("../shaders/blur.wgsl"));

        let sampler = constants.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Blur Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let bind_group_layout =
            constants
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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

        let pipeline_layout =
            constants
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Blur Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                });

        let render_pipeline =
            constants
                .device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Blur Pipeline"),
                    layout: Some(&pipeline_layout),
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
                            format: pipeline.state.get_current_texture().format(),
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

        // First pass - Horizontal blur
        let input_view = pipeline.state.get_current_texture_view();

        let horizontal_bind_group =
            constants
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Horizontal Blur Bind Group"),
                    layout: &bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Sampler(&sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&input_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: uniform_buffer.as_entire_binding(),
                        },
                    ],
                });

        // First pass render - horizontal blur to intermediate texture
        {
            let mut render_pass =
                pipeline
                    .encoder
                    .encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Horizontal Blur Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &intermediate_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

            render_pass.set_pipeline(&render_pipeline);
            render_pass.set_bind_group(0, &horizontal_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        // Second pass - Vertical blur
        let output_view = pipeline.state.get_current_texture_view();

        let vertical_bind_group = constants
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Vertical Blur Bind Group"),
                layout: &bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&intermediate_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: vertical_uniform_buffer.as_entire_binding(),
                    },
                ],
            });

        // Second pass render - vertical blur to output
        {
            let mut render_pass =
                pipeline
                    .encoder
                    .encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Vertical Blur Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &output_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

            render_pass.set_pipeline(&render_pipeline);
            render_pass.set_bind_group(0, &vertical_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }
    }
}

pub struct BlurPipeline {}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct BlurUniforms {
    rect: [f32; 4], // x, y, width, height
    direction: [f32; 2],
    blur_radius: f32,
    _pad: f32,
}

impl BlurPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {}
    }
}

struct Kernel {
    sum: f32,
    values: Vec<f32>,
}

impl Kernel {
    fn new(values: Vec<f32>) -> Self {
        let sum = values.iter().sum();
        Self { sum, values }
    }

    fn packed_data(&self) -> Vec<f32> {
        let mut data = vec![0.0; self.values.len() + 1];
        data[0] = self.sum;
        data[1..].copy_from_slice(&self.values);
        data
    }

    fn size(&self) -> usize {
        self.values.len()
    }
}

fn kernel_size_for_sigma(sigma: f32) -> u32 {
    2 * (sigma * 3.0).ceil() as u32 + 1
}

fn kernel(sigma: f32) -> Kernel {
    let kernel_size = kernel_size_for_sigma(sigma);
    let mut values = vec![0.0; kernel_size as usize];
    let kernel_radius = (kernel_size as usize - 1) / 2;
    for index in 0..=kernel_radius {
        let normpdf = normalized_probablility_density_function(index as f32, sigma);
        values[kernel_radius + index] = normpdf;
        values[kernel_radius - index] = normpdf;
    }

    Kernel::new(values)
}

fn normalized_probablility_density_function(x: f32, sigma: f32) -> f32 {
    0.39894 * (-0.5 * x * x / (sigma * sigma)).exp() / sigma
}
