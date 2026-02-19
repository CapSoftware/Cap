use crate::{
    ConvertError, GpuConverterError,
    util::{copy_texture_to_buffer_command, read_buffer_to_vec},
    yuyv,
};

pub struct YUYVToRGBA {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
}

impl YUYVToRGBA {
    pub async fn new() -> Result<Self, GpuConverterError> {
        #[cfg(target_os = "windows")]
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN,
            ..Default::default()
        });
        #[cfg(not(target_os = "windows"))]
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("YUYV to RGBA Converter"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "./shader.wgsl"
            ))),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("YUYV to RGBA Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Uint,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
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

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("YUYV to RGBA Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("YUYV to RGBA Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
        })
    }

    pub fn convert(
        &self,
        yuyv_data: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ConvertError> {
        if !width.is_multiple_of(2) {
            return Err(ConvertError::OddWidth { width });
        }

        let expected_size = (width as usize) * (height as usize) * 2;
        if yuyv_data.len() != expected_size {
            return Err(ConvertError::BufferSizeMismatch {
                expected: expected_size,
                actual: yuyv_data.len(),
            });
        }

        let yuyv_texture =
            yuyv::create_input_texture(&self.device, &self.queue, yuyv_data, width, height)
                .map_err(ConvertError::TextureCreation)?;

        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("YUYV to RGBA Output Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("YUYV to RGBA Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &yuyv_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &output_texture.create_view(&Default::default()),
                    ),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("YUYV to RGBA Encoder"),
            });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("YUYV to RGBA Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups((width / 2).div_ceil(8), height.div_ceil(8), 1);
        }

        let output_buffer =
            copy_texture_to_buffer_command(&self.device, &output_texture, &mut encoder);

        self.queue.submit(std::iter::once(encoder.finish()));

        Ok(read_buffer_to_vec(&output_buffer, &self.device)?)
    }
}
