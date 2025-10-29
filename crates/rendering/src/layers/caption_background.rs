use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

/// Vertex data for a simple quad
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
struct Vertex {
    position: [f32; 2],
}

impl Vertex {
    const ATTRIBS: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x2];

    fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

/// Uniforms for the caption background shader
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct CaptionBackgroundUniforms {
    pub position: [f32; 2], // Center position of the background (8 bytes) - offset 0
    pub size: [f32; 2],     // Width and height of the background (8 bytes) - offset 8
    pub color: [f32; 4],    // RGBA color (16 bytes) - offset 16
    pub corner_radius: f32, // Corner radius in pixels (4 bytes) - offset 32
    pub _padding1: [f32; 1], // Padding (4 bytes) - offset 36
    pub viewport_size: [f32; 2], // Viewport dimensions (8 bytes) - offset 40
    pub _padding2: f32,     // Padding (4 bytes) - offset 48
    pub _padding3: [f32; 3], // Padding (12 bytes) - offset 52
    pub _padding4: [f32; 4], // Padding to align to 80 bytes (16 bytes) - offset 64
}

impl Default for CaptionBackgroundUniforms {
    fn default() -> Self {
        Self {
            position: [0.0, 0.0],
            size: [200.0, 50.0],
            color: [0.0, 0.0, 0.0, 0.8],
            corner_radius: 10.0,
            _padding1: [0.0],
            viewport_size: [1920.0, 1080.0],
            _padding2: 0.0,
            _padding3: [0.0, 0.0, 0.0],
            _padding4: [0.0, 0.0, 0.0, 0.0],
        }
    }
}

pub struct CaptionBackgroundPipeline {
    render_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    num_indices: u32,
}

impl CaptionBackgroundPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        // Create vertex buffer for a quad
        let vertices = &[
            Vertex {
                position: [-1.0, -1.0],
            },
            Vertex {
                position: [1.0, -1.0],
            },
            Vertex {
                position: [1.0, 1.0],
            },
            Vertex {
                position: [-1.0, 1.0],
            },
        ];

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Background Vertex Buffer"),
            contents: bytemuck::cast_slice(vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Create index buffer
        let indices: &[u16] = &[0, 1, 2, 0, 2, 3];
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Caption Background Index Buffer"),
            contents: bytemuck::cast_slice(indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        // Create bind group layout
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Caption Background Bind Group Layout"),
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

        // Create shader module
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Caption Background Shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../shaders/caption_background.wgsl").into(),
            ),
        });

        // Create render pipeline
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Caption Background Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Caption Background Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
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
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            render_pipeline,
            bind_group_layout,
            vertex_buffer,
            index_buffer,
            num_indices: indices.len() as u32,
        }
    }

    pub fn create_bind_group(
        &self,
        device: &wgpu::Device,
        uniforms_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Caption Background Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms_buffer.as_entire_binding(),
            }],
        })
    }

    pub fn render<'a>(
        &'a self,
        render_pass: &mut wgpu::RenderPass<'a>,
        bind_group: &'a wgpu::BindGroup,
    ) {
        render_pass.set_pipeline(&self.render_pipeline);
        render_pass.set_bind_group(0, bind_group, &[]);
        render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
        render_pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        render_pass.draw_indexed(0..self.num_indices, 0, 0..1);
    }
}
