use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::ProjectUniforms;

/// Full-frame pass applying the screen grade to the background canvas so the
/// backdrop and display card read as one graded scene.
pub struct ColorGradeLayer {
    active: bool,
    uniforms_buffer: wgpu::Buffer,
    pipeline: ColorGradePipeline,
}

impl ColorGradeLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            active: false,
            uniforms_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("ColorGrade Uniform Buffer"),
                contents: bytemuck::cast_slice(&[ColorGradeUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
            pipeline: ColorGradePipeline::new(device),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn prepare(&mut self, queue: &wgpu::Queue, uniforms: &ProjectUniforms) {
        // Must reuse the display card's exact params: grain/vignette only
        // stay continuous across the card edge with identical values.
        let params = uniforms.screen_color_grade;
        self.active = params.is_active();
        if !self.active {
            return;
        }

        queue.write_buffer(
            &self.uniforms_buffer,
            0,
            bytemuck::cast_slice(&[ColorGradeUniforms {
                color_adjust_a: params.color_adjust_a,
                color_adjust_b: params.color_adjust_b,
                grain_params: params.grain_params,
            }]),
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
                .bind_group(device, &self.uniforms_buffer, source_texture),
            &[],
        );
        pass.draw(0..3, 0..1);
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
struct ColorGradeUniforms {
    color_adjust_a: [f32; 4],
    color_adjust_b: [f32; 4],
    grain_params: [f32; 4],
}

struct ColorGradePipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl ColorGradePipeline {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("color-grade Bind Group Layout"),
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
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Color Grade Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/color-grade.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Color Grade Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Color Grade Pipeline"),
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
        });
        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        uniform_buffer: &wgpu::Buffer,
        texture_view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ColorGrade Bind Group"),
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
            ],
        })
    }
}
