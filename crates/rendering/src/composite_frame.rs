use bytemuck::{Pod, Zeroable};
use wgpu::{include_wgsl, util::DeviceExt};

use crate::create_shader_render_pipeline;

pub struct CompositeVideoFramePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CompositeVideoFrameUniforms {
    pub crop_bounds: [f32; 4],
    pub target_bounds: [f32; 4],
    pub output_size: [f32; 2],
    pub frame_size: [f32; 2],
    pub motion_blur_vector: [f32; 2],
    pub motion_blur_zoom_center: [f32; 2],
    pub motion_blur_params: [f32; 4],
    pub target_size: [f32; 2],
    pub rounding_px: f32,
    pub rounding_type: f32,
    pub mirror_x: f32,
    pub shadow: f32,
    pub shadow_size: f32,
    pub shadow_opacity: f32,
    pub shadow_blur: f32,
    pub opacity: f32,
    pub border_enabled: f32,
    pub border_width: f32,
    pub _padding0: f32,
    pub _padding1: [f32; 2],
    pub _padding1b: [f32; 2],
    pub border_color: [f32; 4],
    pub _padding2: [f32; 4],
}

impl Default for CompositeVideoFrameUniforms {
    fn default() -> Self {
        Self {
            crop_bounds: Default::default(),
            target_bounds: Default::default(),
            output_size: Default::default(),
            frame_size: Default::default(),
            motion_blur_vector: Default::default(),
            motion_blur_zoom_center: [0.5, 0.5],
            motion_blur_params: Default::default(),
            target_size: Default::default(),
            rounding_px: Default::default(),
            rounding_type: 0.0,
            mirror_x: Default::default(),
            shadow: Default::default(),
            shadow_size: Default::default(),
            shadow_opacity: Default::default(),
            shadow_blur: Default::default(),
            opacity: 1.0,
            border_enabled: 0.0,
            border_width: 5.0,
            _padding0: 0.0,
            _padding1: [0.0; 2],
            _padding1b: [0.0; 2],
            border_color: [0.0, 0.0, 0.0, 0.0],
            _padding2: [0.0; 4],
        }
    }
}

impl CompositeVideoFrameUniforms {
    pub fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CompositeVideoFrameUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }

    pub fn write_to_buffer(&self, queue: &wgpu::Queue, buffer: &wgpu::Buffer) {
        queue.write_buffer(buffer, 0, bytemuck::bytes_of(self));
    }
}

// pub struct CompositeFrameResources {
//     pub bind_group: wgpu::BindGroup,
//     pub bind_group_layout: wgpu::BindGroupLayout,
//     pub uniforms_buffer: wgpu::Buffer,
//     pub sampler: wgpu::Sampler,
// }

impl CompositeVideoFramePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = Self::bind_group_layout(device);
        let render_pipeline = create_shader_render_pipeline(
            device,
            &bind_group_layout,
            include_wgsl!("shaders/composite-video-frame.wgsl"),
        );

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            bind_group_layout,
            render_pipeline,
            sampler,
        }
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-video-frame.wgsl Bind Group Layout"),
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
        })
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        frame: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(frame),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
            label: Some("bind_group"),
        })
    }

    pub fn create_frame_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
        device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_DST,
                label: Some("Frame Composite texture"),
                view_formats: &[],
            }),
        )
    }
}
