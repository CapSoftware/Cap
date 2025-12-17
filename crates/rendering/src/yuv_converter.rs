use crate::cpu_yuv;

#[cfg(target_os = "macos")]
use crate::iosurface_texture::{
    IOSurfaceTextureCache, IOSurfaceTextureError, import_metal_texture_to_wgpu,
};

#[cfg(target_os = "macos")]
use cidre::cv;

#[cfg(target_os = "windows")]
use crate::d3d_texture::D3DTextureError;

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};

#[derive(Debug, thiserror::Error)]
pub enum YuvConversionError {
    #[error("{plane} plane size mismatch: expected {expected}, got {actual}")]
    PlaneSizeMismatch {
        plane: &'static str,
        expected: usize,
        actual: usize,
    },
    #[error("{dimension} dimension ({value}) exceeds maximum allowed ({max})")]
    DimensionExceedsLimit {
        dimension: &'static str,
        value: u32,
        max: u32,
    },
    #[cfg(target_os = "macos")]
    #[error("IOSurface error: {0}")]
    IOSurfaceError(#[from] IOSurfaceTextureError),
    #[cfg(target_os = "windows")]
    #[error("D3D texture error: {0}")]
    D3DTextureError(#[from] D3DTextureError),
    #[cfg(target_os = "windows")]
    #[error("D3D11 error: {0}")]
    D3D11Error(String),
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
    let expected_data_size = (stride * height) as usize;
    if data.len() < expected_data_size {
        return Err(YuvConversionError::PlaneSizeMismatch {
            plane: plane_name,
            expected: expected_data_size,
            actual: data.len(),
        });
    }

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
            bytes_per_row: Some(stride),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    Ok(())
}

const MAX_TEXTURE_WIDTH: u32 = 3840;
const MAX_TEXTURE_HEIGHT: u32 = 2160;

fn validate_dimensions(width: u32, height: u32) -> Result<(), YuvConversionError> {
    if width > MAX_TEXTURE_WIDTH {
        return Err(YuvConversionError::DimensionExceedsLimit {
            dimension: "width",
            value: width,
            max: MAX_TEXTURE_WIDTH,
        });
    }
    if height > MAX_TEXTURE_HEIGHT {
        return Err(YuvConversionError::DimensionExceedsLimit {
            dimension: "height",
            value: height,
            max: MAX_TEXTURE_HEIGHT,
        });
    }
    Ok(())
}

pub struct YuvToRgbaConverter {
    nv12_pipeline: wgpu::ComputePipeline,
    yuv420p_pipeline: wgpu::ComputePipeline,
    nv12_bind_group_layout: wgpu::BindGroupLayout,
    yuv420p_bind_group_layout: wgpu::BindGroupLayout,
    y_texture: wgpu::Texture,
    y_view: wgpu::TextureView,
    uv_texture: wgpu::Texture,
    uv_view: wgpu::TextureView,
    u_texture: wgpu::Texture,
    u_view: wgpu::TextureView,
    v_texture: wgpu::Texture,
    v_view: wgpu::TextureView,
    output_textures: [wgpu::Texture; 2],
    output_views: [wgpu::TextureView; 2],
    current_output: usize,
    #[cfg(target_os = "macos")]
    iosurface_cache: Option<IOSurfaceTextureCache>,
    #[cfg(target_os = "windows")]
    d3d11_staging_texture: Option<ID3D11Texture2D>,
    #[cfg(target_os = "windows")]
    d3d11_staging_width: u32,
    #[cfg(target_os = "windows")]
    d3d11_staging_height: u32,
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

        let y_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Y Plane Texture (Pre-allocated)"),
            size: wgpu::Extent3d {
                width: MAX_TEXTURE_WIDTH,
                height: MAX_TEXTURE_HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let y_view = y_texture.create_view(&Default::default());

        let uv_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("UV Plane Texture (Pre-allocated)"),
            size: wgpu::Extent3d {
                width: MAX_TEXTURE_WIDTH / 2,
                height: MAX_TEXTURE_HEIGHT / 2,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rg8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let uv_view = uv_texture.create_view(&Default::default());

        let u_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("U Plane Texture (Pre-allocated)"),
            size: wgpu::Extent3d {
                width: MAX_TEXTURE_WIDTH / 2,
                height: MAX_TEXTURE_HEIGHT / 2,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let u_view = u_texture.create_view(&Default::default());

        let v_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("V Plane Texture (Pre-allocated)"),
            size: wgpu::Extent3d {
                width: MAX_TEXTURE_WIDTH / 2,
                height: MAX_TEXTURE_HEIGHT / 2,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let v_view = v_texture.create_view(&Default::default());

        let create_output_texture = |label: &str| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: MAX_TEXTURE_WIDTH,
                    height: MAX_TEXTURE_HEIGHT,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };

        let output_texture_0 = create_output_texture("RGBA Output Texture 0 (Pre-allocated)");
        let output_texture_1 = create_output_texture("RGBA Output Texture 1 (Pre-allocated)");
        let output_view_0 = output_texture_0.create_view(&Default::default());
        let output_view_1 = output_texture_1.create_view(&Default::default());

        Self {
            nv12_pipeline,
            yuv420p_pipeline,
            nv12_bind_group_layout,
            yuv420p_bind_group_layout,
            y_texture,
            y_view,
            uv_texture,
            uv_view,
            u_texture,
            u_view,
            v_texture,
            v_view,
            output_textures: [output_texture_0, output_texture_1],
            output_views: [output_view_0, output_view_1],
            current_output: 0,
            #[cfg(target_os = "macos")]
            iosurface_cache: IOSurfaceTextureCache::new(),
            #[cfg(target_os = "windows")]
            d3d11_staging_texture: None,
            #[cfg(target_os = "windows")]
            d3d11_staging_width: 0,
            #[cfg(target_os = "windows")]
            d3d11_staging_height: 0,
        }
    }

    fn swap_output_buffer(&mut self) {
        self.current_output = 1 - self.current_output;
    }

    fn current_output_texture(&self) -> &wgpu::Texture {
        &self.output_textures[self.current_output]
    }

    fn current_output_view(&self) -> &wgpu::TextureView {
        &self.output_views[self.current_output]
    }

    #[allow(clippy::too_many_arguments)]
    pub fn convert_nv12(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_data: &[u8],
        uv_data: &[u8],
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        validate_dimensions(width, height)?;
        self.swap_output_buffer();

        upload_plane_with_stride(queue, &self.y_texture, y_data, width, height, y_stride, "Y")?;

        let half_height = height / 2;
        let expected_uv_size = (uv_stride * half_height) as usize;
        if uv_data.len() < expected_uv_size {
            return Err(YuvConversionError::PlaneSizeMismatch {
                plane: "UV",
                expected: expected_uv_size,
                actual: uv_data.len(),
            });
        }

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.uv_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            uv_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(uv_stride),
                rows_per_image: Some(half_height),
            },
            wgpu::Extent3d {
                width: width / 2,
                height: half_height,
                depth_or_array_layers: 1,
            },
        );

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 Converter Bind Group"),
            layout: &self.nv12_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(self.current_output_view()),
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

        Ok(self.current_output_view())
    }

    #[cfg(target_os = "macos")]
    pub fn convert_nv12_from_iosurface(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        image_buf: &cv::ImageBuf,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        self.swap_output_buffer();

        let cache = self
            .iosurface_cache
            .as_ref()
            .ok_or(IOSurfaceTextureError::NoMetalDevice)?;

        let io_surface = image_buf
            .io_surf()
            .ok_or(IOSurfaceTextureError::NoIOSurface)?;

        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;

        validate_dimensions(width, height)?;

        let y_metal_texture = cache.create_y_texture(io_surface, width, height)?;
        let uv_metal_texture = cache.create_uv_texture(io_surface, width, height)?;

        let y_wgpu_texture = import_metal_texture_to_wgpu(
            device,
            &y_metal_texture,
            wgpu::TextureFormat::R8Unorm,
            width,
            height,
            Some("IOSurface Y Plane"),
        )?;

        let uv_wgpu_texture = import_metal_texture_to_wgpu(
            device,
            &uv_metal_texture,
            wgpu::TextureFormat::Rg8Unorm,
            width / 2,
            height / 2,
            Some("IOSurface UV Plane"),
        )?;

        let y_view = y_wgpu_texture.create_view(&Default::default());
        let uv_view = uv_wgpu_texture.create_view(&Default::default());

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 IOSurface Converter Bind Group"),
            layout: &self.nv12_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(self.current_output_view()),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NV12 IOSurface Conversion Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("NV12 IOSurface Conversion Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.nv12_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(self.current_output_view())
    }

    #[allow(clippy::too_many_arguments)]
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
        validate_dimensions(width, height)?;
        self.swap_output_buffer();

        upload_plane_with_stride(queue, &self.y_texture, y_data, width, height, y_stride, "Y")?;

        let half_width = width / 2;
        let half_height = height / 2;

        upload_plane_with_stride(
            queue,
            &self.u_texture,
            u_data,
            half_width,
            half_height,
            uv_stride,
            "U",
        )?;
        upload_plane_with_stride(
            queue,
            &self.v_texture,
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
                    resource: wgpu::BindingResource::TextureView(&self.y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.u_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.v_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(self.current_output_view()),
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

        Ok(self.current_output_view())
    }

    #[cfg(target_os = "windows")]
    pub fn convert_nv12_from_d3d11_texture(
        &mut self,
        wgpu_device: &wgpu::Device,
        queue: &wgpu::Queue,
        d3d11_device: &ID3D11Device,
        d3d11_context: &ID3D11DeviceContext,
        nv12_texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        validate_dimensions(width, height)?;

        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

        if self.d3d11_staging_width != width
            || self.d3d11_staging_height != height
            || self.d3d11_staging_texture.is_none()
        {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };

            let staging_texture = unsafe {
                let mut texture: Option<ID3D11Texture2D> = None;
                d3d11_device
                    .CreateTexture2D(&desc, None, Some(&mut texture))
                    .map_err(|e| {
                        YuvConversionError::D3D11Error(format!("CreateTexture2D failed: {e:?}"))
                    })?;
                texture.ok_or_else(|| {
                    YuvConversionError::D3D11Error("CreateTexture2D returned null".to_string())
                })?
            };

            self.d3d11_staging_texture = Some(staging_texture);
            self.d3d11_staging_width = width;
            self.d3d11_staging_height = height;
        }

        let staging_texture = self.d3d11_staging_texture.as_ref().ok_or_else(|| {
            YuvConversionError::D3D11Error("D3D11 staging texture not initialized".to_string())
        })?;

        unsafe {
            d3d11_context.CopyResource(staging_texture, nv12_texture);
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            d3d11_context
                .Map(staging_texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| YuvConversionError::D3D11Error(format!("Map failed: {e:?}")))?;
        }

        let y_stride = mapped.RowPitch;
        let uv_stride = mapped.RowPitch;

        let y_size = (y_stride * height) as usize;
        let uv_size = (uv_stride * height / 2) as usize;

        let (y_data_vec, uv_data_vec) = unsafe {
            let y_data = std::slice::from_raw_parts(mapped.pData as *const u8, y_size);
            let uv_data =
                std::slice::from_raw_parts((mapped.pData as *const u8).add(y_size), uv_size);
            (y_data.to_vec(), uv_data.to_vec())
        };

        unsafe {
            d3d11_context.Unmap(staging_texture, 0);
        }

        self.swap_output_buffer();

        upload_plane_with_stride(
            queue,
            &self.y_texture,
            &y_data_vec,
            width,
            height,
            y_stride,
            "Y",
        )?;

        let half_height = height / 2;
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.uv_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &uv_data_vec,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(uv_stride),
                rows_per_image: Some(half_height),
            },
            wgpu::Extent3d {
                width: width / 2,
                height: half_height,
                depth_or_array_layers: 1,
            },
        );

        let bind_group = wgpu_device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 D3D11 Converter Bind Group"),
            layout: &self.nv12_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(self.current_output_view()),
                },
            ],
        });

        let mut encoder = wgpu_device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NV12 D3D11 Conversion Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("NV12 D3D11 Conversion Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.nv12_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(self.current_output_view())
    }

    #[cfg(target_os = "windows")]
    pub fn convert_nv12_from_d3d11_shared_handles(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_handle: windows::Win32::Foundation::HANDLE,
        uv_handle: windows::Win32::Foundation::HANDLE,
        width: u32,
        height: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        validate_dimensions(width, height)?;

        use crate::d3d_texture::import_d3d11_texture_to_wgpu;

        self.swap_output_buffer();

        let y_wgpu_texture = import_d3d11_texture_to_wgpu(
            device,
            y_handle,
            wgpu::TextureFormat::R8Unorm,
            width,
            height,
            Some("D3D11 Y Plane Zero-Copy"),
        )?;

        let uv_wgpu_texture = import_d3d11_texture_to_wgpu(
            device,
            uv_handle,
            wgpu::TextureFormat::Rg8Unorm,
            width / 2,
            height / 2,
            Some("D3D11 UV Plane Zero-Copy"),
        )?;

        let y_view = y_wgpu_texture.create_view(&Default::default());
        let uv_view = uv_wgpu_texture.create_view(&Default::default());

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 D3D11 Zero-Copy Converter Bind Group"),
            layout: &self.nv12_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(self.current_output_view()),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("NV12 D3D11 Zero-Copy Conversion Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("NV12 D3D11 Zero-Copy Conversion Pass"),
                ..Default::default()
            });
            compute_pass.set_pipeline(&self.nv12_pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(self.current_output_view())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn convert_nv12_cpu(
        &mut self,
        _device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_data: &[u8],
        uv_data: &[u8],
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        validate_dimensions(width, height)?;
        self.swap_output_buffer();

        let mut rgba_data = vec![0u8; (width * height * 4) as usize];

        cpu_yuv::nv12_to_rgba_simd(
            y_data,
            uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut rgba_data,
        );

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: self.current_output_texture(),
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        Ok(self.current_output_view())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn convert_yuv420p_cpu(
        &mut self,
        _device: &wgpu::Device,
        queue: &wgpu::Queue,
        y_data: &[u8],
        u_data: &[u8],
        v_data: &[u8],
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Result<&wgpu::TextureView, YuvConversionError> {
        validate_dimensions(width, height)?;
        self.swap_output_buffer();

        let mut rgba_data = vec![0u8; (width * height * 4) as usize];

        cpu_yuv::yuv420p_to_rgba_simd(
            y_data,
            u_data,
            v_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut rgba_data,
        );

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: self.current_output_texture(),
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        Ok(self.current_output_view())
    }

    pub fn output_texture(&self) -> Option<&wgpu::Texture> {
        Some(self.current_output_texture())
    }
}
