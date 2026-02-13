use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::ProjectUniforms;

pub struct PerspectiveLayer {
    sampler: wgpu::Sampler,
    uniforms_buffer: wgpu::Buffer,
    pipeline: PerspectivePipeline,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct PerspectiveUniforms {
    pub inverse_mvp: [[f32; 4]; 4],
    pub output_size: [f32; 2],
    pub plane_half_size: [f32; 2],
    pub shadow_opacity: f32,
    pub rounding_px: f32,
    pub enabled: f32,
    pub _padding: f32,
    pub background_color: [f32; 4],
}

impl Default for PerspectiveUniforms {
    fn default() -> Self {
        Self {
            inverse_mvp: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            output_size: [1920.0, 1080.0],
            plane_half_size: [0.8889, 0.5],
            shadow_opacity: 0.3,
            rounding_px: 0.0,
            enabled: 0.0,
            _padding: 0.0,
            background_color: [0.0, 0.0, 0.0, 0.0],
        }
    }
}

impl PerspectiveLayer {
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
            uniforms_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Perspective Uniform Buffer"),
                contents: bytemuck::cast_slice(&[PerspectiveUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
            pipeline: PerspectivePipeline::new(device),
        }
    }

    pub fn prepare(&mut self, queue: &wgpu::Queue, uniforms: &ProjectUniforms) {
        if !uniforms.perspective.is_active() {
            return;
        }

        let output_w = uniforms.output_size.0 as f32;
        let output_h = uniforms.output_size.1 as f32;
        let aspect = output_w / output_h;

        let inverse_mvp = uniforms.perspective.compute_inverse_mvp(aspect);
        let plane_half_size = uniforms.perspective.plane_half_size(aspect);

        let rounding =
            uniforms.project.background.rounding as f32 / 100.0 * 0.5 * output_w.min(output_h);

        let perspective_uniforms = PerspectiveUniforms {
            inverse_mvp,
            output_size: [output_w, output_h],
            plane_half_size,
            shadow_opacity: 0.35,
            rounding_px: rounding,
            enabled: 1.0,
            _padding: 0.0,
            background_color: [0.0, 0.0, 0.0, 0.0],
        };

        queue.write_buffer(
            &self.uniforms_buffer,
            0,
            bytemuck::cast_slice(&[perspective_uniforms]),
        );
    }

    pub fn render(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        device: &wgpu::Device,
        source_texture: &wgpu::TextureView,
    ) {
        pass.set_pipeline(&self.pipeline.render_pipeline);
        pass.set_bind_group(
            0,
            &self
                .pipeline
                .bind_group(device, &self.uniforms_buffer, source_texture, &self.sampler),
            &[],
        );
        pass.draw(0..4, 0..1);
    }
}

pub struct PerspectivePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

impl PerspectivePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Perspective Bind Group Layout"),
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
            label: Some("Perspective Transform Shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../shaders/perspective-transform.wgsl").into(),
            ),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Perspective Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Perspective Pipeline"),
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
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
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
            label: Some("Perspective Bind Group"),
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
