use wgpu::{self, util::DeviceExt};

use crate::{ConvertError, GpuConverterError, util::read_buffer_to_vec, yuyv};

pub struct YUYVToNV12 {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
}

impl YUYVToNV12 {
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
            label: Some("YUYV to NV12 Converter"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "./shader.wgsl"
            ))),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("YUYV to NV12 Bind Group Layout"),
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
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
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

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("YUYV to NV12 Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("YUYV to NV12 Pipeline"),
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
    ) -> Result<(Vec<u8>, Vec<u8>), ConvertError> {
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

        let width_u64 = u64::from(width);
        let height_u64 = u64::from(height);
        let y_plane_size = width_u64 * height_u64;
        let uv_plane_size = (width_u64 * height_u64) / 2;

        let y_write_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("YUYV to NV12 Y Plane Buffer"),
            size: y_plane_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let uv_write_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("YUYV to NV12 UV Plane Buffer"),
            size: uv_plane_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let dimensions_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("YUYV to NV12 Dimensions Buffer"),
                contents: [width.to_ne_bytes(), height.to_ne_bytes()].as_flattened(),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("YUYV to NV12 Bind Group"),
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
                    resource: wgpu::BindingResource::Buffer(
                        y_write_buffer.as_entire_buffer_binding(),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Buffer(
                        uv_write_buffer.as_entire_buffer_binding(),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(
                        dimensions_buffer.as_entire_buffer_binding(),
                    ),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("YUYV to NV12 Encoder"),
            });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("YUYV to NV12 Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups((width / 2).div_ceil(8), height.div_ceil(8), 1);
        }

        let y_read_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("YUYV to NV12 Y Read Buffer"),
            size: y_write_buffer.size(),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let uv_read_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("YUYV to NV12 UV Read Buffer"),
            size: uv_write_buffer.size(),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        encoder.copy_buffer_to_buffer(&y_write_buffer, 0, &y_read_buffer, 0, y_write_buffer.size());
        encoder.copy_buffer_to_buffer(
            &uv_write_buffer,
            0,
            &uv_read_buffer,
            0,
            uv_write_buffer.size(),
        );

        let _submission = self.queue.submit(std::iter::once(encoder.finish()));

        Ok((
            read_buffer_to_vec(&y_read_buffer, &self.device).map_err(ConvertError::Poll)?,
            read_buffer_to_vec(&uv_read_buffer, &self.device).map_err(ConvertError::Poll)?,
        ))
    }
}
