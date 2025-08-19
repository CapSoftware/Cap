use wgpu::{self, util::DeviceExt};

use crate::ConversionError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalingQuality {
    Fast,    // Nearest neighbor
    Good,    // Bilinear
    Best,    // Bicubic
}

pub struct GPUScaler {
    device: wgpu::Device,
    queue: wgpu::Queue,
    nearest_pipeline: wgpu::ComputePipeline,
    bilinear_pipeline: wgpu::ComputePipeline,
    bicubic_pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_bind_group_layout: wgpu::BindGroupLayout,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ScaleParams {
    input_width: f32,
    input_height: f32,
    output_width: f32,
    output_height: f32,
}

impl GPUScaler {
    pub async fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Result<Self, ConversionError> {
        // Create bind group layouts
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Scaler Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });

        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Scaler Uniform Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        // Create shaders
        let nearest_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Nearest Neighbor Scaler"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!("nearest.wgsl"))),
        });

        let bilinear_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Bilinear Scaler"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!("bilinear.wgsl"))),
        });

        let bicubic_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Bicubic Scaler"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!("bicubic.wgsl"))),
        });

        // Create pipeline layout
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Scaler Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout, &uniform_bind_group_layout],
            push_constant_ranges: &[],
        });

        // Create compute pipelines
        let nearest_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Nearest Scaler Pipeline"),
            layout: Some(&pipeline_layout),
            module: &nearest_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let bilinear_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Bilinear Scaler Pipeline"),
            layout: Some(&pipeline_layout),
            module: &bilinear_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let bicubic_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Bicubic Scaler Pipeline"),
            layout: Some(&pipeline_layout),
            module: &bicubic_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            device: device.clone(),
            queue: queue.clone(),
            nearest_pipeline,
            bilinear_pipeline,
            bicubic_pipeline,
            bind_group_layout,
            uniform_bind_group_layout,
        })
    }

    pub async fn scale_texture(
        &self,
        input_texture: &wgpu::Texture,
        output_width: u32,
        output_height: u32,
        quality: ScalingQuality,
    ) -> Result<wgpu::Texture, ConversionError> {
        let input_size = input_texture.size();

        if input_size.width == output_width && input_size.height == output_height {
            // No scaling needed, return a copy of the input texture
            return self.copy_texture(input_texture);
        }

        // Create output texture
        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Scaled Output Texture"),
            size: wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        // Create sampler
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Scaler Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: match quality {
                ScalingQuality::Fast => wgpu::FilterMode::Nearest,
                _ => wgpu::FilterMode::Linear,
            },
            min_filter: match quality {
                ScalingQuality::Fast => wgpu::FilterMode::Nearest,
                _ => wgpu::FilterMode::Linear,
            },
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // Create uniform buffer with scale parameters
        let scale_params = ScaleParams {
            input_width: input_size.width as f32,
            input_height: input_size.height as f32,
            output_width: output_width as f32,
            output_height: output_height as f32,
        };

        let uniform_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scale Params Buffer"),
            contents: bytemuck::cast_slice(&[scale_params]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        // Create bind groups
        let texture_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Scaler Texture Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &input_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        &output_texture.create_view(&Default::default()),
                    ),
                },
            ],
        });

        let uniform_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Scaler Uniform Bind Group"),
            layout: &self.uniform_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
        });

        // Select pipeline based on quality
        let pipeline = match quality {
            ScalingQuality::Fast => &self.nearest_pipeline,
            ScalingQuality::Good => &self.bilinear_pipeline,
            ScalingQuality::Best => &self.bicubic_pipeline,
        };

        // Dispatch compute shader
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Scaling Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Scaling Pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(pipeline);
            compute_pass.set_bind_group(0, &texture_bind_group, &[]);
            compute_pass.set_bind_group(1, &uniform_bind_group, &[]);
            compute_pass.dispatch_workgroups(
                output_width.div_ceil(8),
                output_height.div_ceil(8),
                1,
            );
        }

        self.queue.submit(std::iter::once(encoder.finish()));

        Ok(output_texture)
    }

    fn copy_texture(&self, input_texture: &wgpu::Texture) -> Result<wgpu::Texture, ConversionError> {
        let size = input_texture.size();

        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Copied Texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Texture Copy Encoder"),
        });

        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: input_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &output_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            size,
        );

        self.queue.submit(std::iter::once(encoder.finish()));

        Ok(output_texture)
    }
}
