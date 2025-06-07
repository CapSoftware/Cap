use bytemuck::{Pod, Zeroable};
use wgpu::{include_wgsl, util::DeviceExt};

use crate::create_shader_render_pipeline;

pub struct CompositeVideoFramePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct CompositeVideoFrameUniforms {
    pub crop_bounds: [f32; 4],
    pub target_bounds: [f32; 4],
    pub output_size: [f32; 2],
    pub frame_size: [f32; 2],
    pub velocity_uv: [f32; 2],
    pub target_size: [f32; 2],
    pub rounding_px: f32,
    pub mirror_x: f32,
    pub motion_blur_amount: f32,
    pub camera_motion_blur_amount: f32,
    pub shadow: f32,
    pub shadow_size: f32,
    pub shadow_opacity: f32,
    pub shadow_blur: f32,
    pub _padding: [f32; 3],
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
}

pub struct CompositeFrameResources {
    pub bind_group: wgpu::BindGroup,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub uniforms_buffer: wgpu::Buffer,
    pub sampler: wgpu::Sampler,
}

impl CompositeVideoFramePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = Self::bind_group_layout(device);
        let render_pipeline = create_shader_render_pipeline(
            device,
            &bind_group_layout,
            include_wgsl!("shaders/composite-video-frame.wgsl"),
        );

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    // fn resources(
    //     device: &wgpu::Device,
    //     source_frame: &wgpu::TextureView,
    //     target_frame: &wgpu::TextureView,
    // ) -> CompositeFrameResources {
    //     let sampler = device.create_sampler(
    //         &(wgpu::SamplerDescriptor {
    //             address_mode_u: wgpu::AddressMode::ClampToEdge,
    //             address_mode_v: wgpu::AddressMode::ClampToEdge,
    //             address_mode_w: wgpu::AddressMode::ClampToEdge,
    //             mag_filter: wgpu::FilterMode::Linear,
    //             min_filter: wgpu::FilterMode::Linear,
    //             mipmap_filter: wgpu::FilterMode::Nearest,
    //             ..Default::default()
    //         }),
    //     );

    //     let uniforms_buffer = CompositeVideoFrameUniforms::default().to_buffer(device);

    //     let bind_group_layout = Self::bind_group_layout(device);

    //     let bind_group = device.create_bind_group(
    //         &(wgpu::BindGroupDescriptor {
    //             layout: &bind_group_layout,
    //             entries: &[
    //                 wgpu::BindGroupEntry {
    //                     binding: 0,
    //                     resource: uniforms_buffer.as_entire_binding(),
    //                 },
    //                 wgpu::BindGroupEntry {
    //                     binding: 1,
    //                     resource: wgpu::BindingResource::TextureView(source_frame),
    //                 },
    //                 wgpu::BindGroupEntry {
    //                     binding: 2,
    //                     resource: wgpu::BindingResource::TextureView(target_frame),
    //                 },
    //                 wgpu::BindGroupEntry {
    //                     binding: 3,
    //                     resource: wgpu::BindingResource::Sampler(&sampler),
    //                 },
    //             ],
    //             label: Some("bind_group"),
    //         }),
    //     );

    //     CompositeFrameResources {
    //         bind_group,
    //         bind_group_layout,
    //         uniforms_buffer,
    //         sampler,
    //     }
    // }

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
        let sampler = device.create_sampler(
            &(wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
        );

        let bind_group = device.create_bind_group(
            &(wgpu::BindGroupDescriptor {
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
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
                label: Some("bind_group"),
            }),
        );

        bind_group
    }
}
