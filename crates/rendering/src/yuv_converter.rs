use crate::decoder::PixelFormat;

#[derive(Debug, thiserror::Error)]
pub enum YuvConversionError {
    #[error(
        "{plane} plane bounds exceeded at row {row}: start={start}, end={end}, data_len={data_len}"
    )]
    PlaneBoundsExceeded {
        plane: &'static str,
        row: usize,
        start: usize,
        end: usize,
        data_len: usize,
    },
    #[error("{plane} plane size mismatch: expected {expected}, got {actual}")]
    PlaneSizeMismatch {
        plane: &'static str,
        expected: usize,
        actual: usize,
    },
}

fn upload_plane_with_stride(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    data: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    plane_name: &'static str,
) -> Result<(), YuvConversionError> {
    if stride == width {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    } else {
        let expected_size = (width * height) as usize;
        let mut packed = Vec::with_capacity(expected_size);
        for row in 0..height as usize {
            let start = row * stride as usize;
            let end = start + width as usize;
            if end > data.len() {
                return Err(YuvConversionError::PlaneBoundsExceeded {
                    plane: plane_name,
                    row,
                    start,
                    end,
                    data_len: data.len(),
                });
            }
            packed.extend_from_slice(&data[start..end]);
        }
        if packed.len() != expected_size {
            return Err(YuvConversionError::PlaneSizeMismatch {
                plane: plane_name,
                expected: expected_size,
                actual: packed.len(),
            });
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &packed,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }
    Ok(())
}

pub struct YuvToRgbaConverter {
    nv12_pipeline: wgpu::ComputePipeline,
    yuv420p_pipeline: wgpu::ComputePipeline,
    nv12_bind_group_layout: wgpu::BindGroupLayout,
    yuv420p_bind_group_layout: wgpu::BindGroupLayout,
    y_texture: Option<wgpu::Texture>,
    uv_texture: Option<wgpu::Texture>,
    u_texture: Option<wgpu::Texture>,
    v_texture: Option<wgpu::Texture>,
    output_texture: Option<wgpu::Texture>,
    y_view: Option<wgpu::TextureView>,
    uv_view: Option<wgpu::TextureView>,
    u_view: Option<wgpu::TextureView>,
    v_view: Option<wgpu::TextureView>,
    output_view: Option<wgpu::TextureView>,
    cached_width: u32,
    cached_height: u32,
    cached_format: Option<PixelFormat>,
}

impl YuvToRgbaConverter {
    pub fn new(device: &wgpu::Device) -> Self {
        let nv12_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("NV12 to RGBA Converter"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "shaders/nv12_to_rgba.wgsl"
            ))),
        });

        let yuv420p_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("YUV420P to RGBA Converter"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "shaders/yuv420p_to_rgba.wgsl"
            ))),
        });

        let nv12_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("NV12 Converter Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
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

        let yuv420p_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("YUV420P Converter Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
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

        let nv12_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("NV12 Converter Pipeline Layout"),
            bind_group_layouts: &[&nv12_bind_group_layout],
            push_constant_ranges: &[],
        });

        let yuv420p_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("YUV420P Converter Pipeline Layout"),
                bind_group_layouts: &[&yuv420p_bind_group_layout],
                push_constant_ranges: &[],
            });

        let nv12_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("NV12 Converter Pipeline"),
            layout: Some(&nv12_pipeline_layout),
            module: &nv12_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let yuv420p_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("YUV420P Converter Pipeline"),
            layout: Some(&yuv420p_pipeline_layout),
            module: &yuv420p_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Self {
            nv12_pipeline,
            yuv420p_pipeline,
            nv12_bind_group_layout,
            yuv420p_bind_group_layout,
            y_texture: None,
            uv_texture: None,
            u_texture: None,
            v_texture: None,
            output_texture: None,
            y_view: None,
            uv_view: None,
            u_view: None,
            v_view: None,
            output_view: None,
            cached_width: 0,
            cached_height: 0,
            cached_format: None,
        }
    }

    fn ensure_textures(
        &mut self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
        format: PixelFormat,
    ) {
        if self.cached_width == width
            && self.cached_height == height
            && self.cached_format == Some(format)
        {
            return;
        }

        self.y_texture = Some(device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Y Plane Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        }));

        match format {
            PixelFormat::Nv12 => {
                self.uv_texture = Some(device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("UV Plane Texture"),
                    size: wgpu::Extent3d {
                        width: width / 2,
                        height: height / 2,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rg8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                }));
                self.u_texture = None;
                self.v_texture = None;
            }
            PixelFormat::Yuv420p => {
                self.u_texture = Some(device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("U Plane Texture"),
                    size: wgpu::Extent3d {
                        width: width / 2,
                        height: height / 2,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                }));
                self.v_texture = Some(device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("V Plane Texture"),
                    size: wgpu::Extent3d {
                        width: width / 2,
                        height: height / 2,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                }));
                self.uv_texture = None;
            }
            PixelFormat::Rgba => {}
        }

        self.output_texture = Some(device.create_texture(&wgpu::TextureDescriptor {
            label: Some("RGBA Output Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        }));

        self.output_view = Some(
            self.output_texture
                .as_ref()
                .unwrap()
                .create_view(&Default::default()),
        );

        self.cached_width = width;
        self.cached_height = height;
        self.cached_format = Some(format);
    }

    pub fn convert_nv12(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_data: &[u8],
        uv_data: &[u8],
        width: u32,
        height: u32,
        y_stride: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        self.ensure_textures(device, width, height, PixelFormat::Nv12);

        let y_texture = self.y_texture.as_ref().unwrap();
        let uv_texture = self.uv_texture.as_ref().unwrap();
        let output_texture = self.output_texture.as_ref().unwrap();

        upload_plane_with_stride(queue, y_texture, y_data, width, height, y_stride, "Y")?;

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: uv_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            uv_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width),
                rows_per_image: Some(height / 2),
            },
            wgpu::Extent3d {
                width: width / 2,
                height: height / 2,
                depth_or_array_layers: 1,
            },
        );

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 Converter Bind Group"),
            layout: &self.nv12_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &y_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &uv_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        &output_texture.create_view(&Default::default()),
                    ),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NV12 Conversion Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("NV12 Conversion Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.nv12_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(self.output_view.as_ref().unwrap())
    }

    pub fn convert_yuv420p(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_data: &[u8],
        u_data: &[u8],
        v_data: &[u8],
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        self.ensure_textures(device, width, height, PixelFormat::Yuv420p);

        let y_texture = self.y_texture.as_ref().unwrap();
        let u_texture = self.u_texture.as_ref().unwrap();
        let v_texture = self.v_texture.as_ref().unwrap();
        let output_texture = self.output_texture.as_ref().unwrap();

        upload_plane_with_stride(queue, y_texture, y_data, width, height, y_stride, "Y")?;

        let half_width = width / 2;
        let half_height = height / 2;

        upload_plane_with_stride(
            queue,
            u_texture,
            u_data,
            half_width,
            half_height,
            uv_stride,
            "U",
        )?;
        upload_plane_with_stride(
            queue,
            v_texture,
            v_data,
            half_width,
            half_height,
            uv_stride,
            "V",
        )?;

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("YUV420P Converter Bind Group"),
            layout: &self.yuv420p_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &y_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &u_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        &v_texture.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(
                        &output_texture.create_view(&Default::default()),
                    ),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("YUV420P Conversion Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("YUV420P Conversion Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.yuv420p_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(self.output_view.as_ref().unwrap())
    }

    pub fn output_texture(&self) -> Option<&wgpu::Texture> {
        self.output_texture.as_ref()
    }
}
