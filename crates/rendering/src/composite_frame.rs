use bytemuck::{Pod, Zeroable};
use wgpu::{include_wgsl, util::DeviceExt};

pub struct CompositeVideoFramePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

static PIPELINE_CACHE_DATA: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();

fn get_cache_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|p| p.join("Cap").join("shader_cache.bin"))
}

fn load_pipeline_cache(device: &wgpu::Device) -> Option<wgpu::PipelineCache> {
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        return None;
    }

    if let Some(cached_data) = PIPELINE_CACHE_DATA.get() {
        return Some(unsafe {
            device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                label: Some("Cap Pipeline Cache"),
                data: Some(cached_data),
                fallback: true,
            })
        });
    }

    let cache_path = get_cache_path()?;
    if cache_path.exists()
        && let Ok(data) = std::fs::read(&cache_path)
    {
        let _ = PIPELINE_CACHE_DATA.set(data.clone());
        return Some(unsafe {
            device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                label: Some("Cap Pipeline Cache"),
                data: Some(&data),
                fallback: true,
            })
        });
    }

    Some(unsafe {
        device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
            label: Some("Cap Pipeline Cache"),
            data: None,
            fallback: true,
        })
    })
}

fn save_pipeline_cache(cache: &wgpu::PipelineCache) {
    if let Some(data) = cache.get_data() {
        let _ = PIPELINE_CACHE_DATA.set(data.clone());
        if let Some(cache_path) = get_cache_path() {
            if let Some(parent) = cache_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(cache_path, &data);
        }
    }
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
    pub _padding1: [f32; 4],
    pub border_color: [f32; 4],
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
            _padding1: [0.0; 4],
            border_color: [0.0, 0.0, 0.0, 0.0],
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
        let pipeline_cache = load_pipeline_cache(device);
        let bind_group_layout = Self::bind_group_layout(device);
        let shader_desc = include_wgsl!("shaders/composite-video-frame.wgsl");
        let shader = device.create_shader_module(shader_desc);

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Composite Render Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Composite Render Pipeline"),
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
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: pipeline_cache.as_ref(),
        });

        if let Some(cache) = &pipeline_cache {
            save_pipeline_cache(cache);
        }

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
