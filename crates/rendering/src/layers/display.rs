use cap_project::XY;

use std::sync::Arc;

use crate::{
    DecodedSegmentFrames, PixelFormat,
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    decoder::DecodedFrameStorageIdentity,
    yuv_converter::{YuvConverterPipelines, YuvToRgbaConverter},
};

#[cfg(target_os = "macos")]
use crate::yuv_converter::RetainedImageBuf;

pub struct DisplayLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    pipeline: std::sync::Arc<CompositeVideoFramePipeline>,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    last_recording_time: Option<f32>,
    last_frame_storage: Option<DecodedFrameStorageIdentity>,
    yuv_converter: YuvToRgbaConverter,
    #[cfg(target_os = "macos")]
    frame_sources: [Option<RetainedImageBuf>; 2],
    prefer_cpu_conversion: bool,
    has_valid_frame: bool,
}

impl DisplayLayer {
    /// Forget the last frame shown, as a new layer would.
    pub(crate) fn reset_frame_state(&mut self) {
        self.last_recording_time = None;
        self.last_frame_storage = None;
        self.has_valid_frame = false;
    }

    #[allow(dead_code)]
    pub fn new(device: &wgpu::Device) -> Self {
        Self::new_with_options(device, false)
    }

    pub fn new_with_options(device: &wgpu::Device, prefer_cpu_conversion: bool) -> Self {
        Self::new_with_all_shared_pipelines(
            device,
            Arc::new(YuvConverterPipelines::new(device)),
            Arc::new(CompositeVideoFramePipeline::new(device)),
            prefer_cpu_conversion,
        )
    }

    pub fn new_with_all_shared_pipelines(
        device: &wgpu::Device,
        yuv_pipelines: Arc<YuvConverterPipelines>,
        composite_pipeline: Arc<CompositeVideoFramePipeline>,
        prefer_cpu_conversion: bool,
    ) -> Self {
        let frame_texture_0 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_1 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_view_0 = frame_texture_0.create_view(&Default::default());
        let frame_texture_view_1 = frame_texture_1.create_view(&Default::default());

        let uniforms_buffer = CompositeVideoFrameUniforms::default().to_buffer(device);
        let bind_group_0 =
            Some(composite_pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_0));
        let bind_group_1 =
            Some(composite_pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_1));

        let yuv_converter = YuvToRgbaConverter::new_with_shared_pipelines_and_outputs(
            device,
            yuv_pipelines,
            [frame_texture_0.clone(), frame_texture_1.clone()],
            [frame_texture_view_0.clone(), frame_texture_view_1.clone()],
        );

        if prefer_cpu_conversion {
            tracing::info!("DisplayLayer initialized with CPU YUV conversion preference");
        }

        Self {
            frame_textures: [frame_texture_0, frame_texture_1],
            frame_texture_views: [frame_texture_view_0, frame_texture_view_1],
            current_texture: 0,
            uniforms_buffer,
            pipeline: composite_pipeline,
            bind_groups: [bind_group_0, bind_group_1],
            last_recording_time: None,
            last_frame_storage: None,
            yuv_converter,
            #[cfg(target_os = "macos")]
            frame_sources: [None, None],
            prefer_cpu_conversion,
            has_valid_frame: false,
        }
    }

    #[cfg(target_os = "windows")]
    fn try_d3d11_staging_fallback(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        screen_frame: &crate::DecodedFrame,
        actual_width: u32,
        actual_height: u32,
        _next_texture: usize,
    ) -> bool {
        let Some(nv12_texture) = screen_frame.d3d11_texture_backing() else {
            return false;
        };

        let Ok(d3d11_device) = (unsafe { nv12_texture.GetDevice() }) else {
            return false;
        };

        let Ok(d3d11_context) = (unsafe { d3d11_device.GetImmediateContext() }) else {
            return false;
        };

        self.yuv_converter
            .convert_nv12_with_fallback(
                device,
                queue,
                &d3d11_device,
                &d3d11_context,
                nv12_texture,
                screen_frame.d3d11_y_handle(),
                screen_frame.d3d11_uv_handle(),
                actual_width,
                actual_height,
            )
            .is_ok()
            && self.yuv_converter.output_texture().is_some()
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        segment_frames: &DecodedSegmentFrames,
        frame_size: XY<u32>,
        uniforms: CompositeVideoFrameUniforms,
    ) -> (bool, u32, u32) {
        let Some(screen_frame) = &segment_frames.screen_frame else {
            tracing::debug!(
                "DisplayLayer::prepare - screen_frame is None, skipping display rendering"
            );
            uniforms.write_to_buffer(queue, &self.uniforms_buffer);
            return (false, frame_size.x, frame_size.y);
        };

        let actual_width = screen_frame.width();
        let actual_height = screen_frame.height();
        let source_size = XY::new(actual_width, actual_height);
        let format = screen_frame.format();
        self.yuv_converter.set_matrix(screen_frame.matrix());
        let current_recording_time = segment_frames.recording_time;
        let frame_storage = screen_frame.storage_identity();

        let skipped = self
            .last_frame_storage
            .as_ref()
            .is_some_and(|last| last.matches(&frame_storage))
            || self
                .last_recording_time
                .is_some_and(|last| (last - current_recording_time).abs() < 0.001);

        let mut frame_uploaded = false;

        if !skipped {
            let next_texture = 1 - self.current_texture;
            self.yuv_converter.set_output_index(next_texture);

            if self.frame_textures[next_texture].width() != source_size.x
                || self.frame_textures[next_texture].height() != source_size.y
            {
                self.frame_textures[next_texture] =
                    CompositeVideoFramePipeline::create_frame_texture(
                        device,
                        source_size.x,
                        source_size.y,
                    );
                self.frame_texture_views[next_texture] =
                    self.frame_textures[next_texture].create_view(&Default::default());

                self.bind_groups[next_texture] = Some(self.pipeline.bind_group(
                    device,
                    &self.uniforms_buffer,
                    &self.frame_texture_views[next_texture],
                ));

                self.yuv_converter.set_external_output(
                    next_texture,
                    self.frame_textures[next_texture].clone(),
                    self.frame_texture_views[next_texture].clone(),
                );
            }

            frame_uploaded = match format {
                PixelFormat::Rgba => {
                    let frame_data = screen_frame.data();
                    let src_bytes_per_row = source_size.x * 4;

                    queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.frame_textures[next_texture],
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        frame_data,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(src_bytes_per_row),
                            rows_per_image: Some(source_size.y),
                        },
                        wgpu::Extent3d {
                            width: source_size.x,
                            height: source_size.y,
                            depth_or_array_layers: 1,
                        },
                    );
                    true
                }
                PixelFormat::Nv12 => {
                    #[cfg(target_os = "macos")]
                    if !self.prefer_cpu_conversion {
                        let iosurface_converted = screen_frame
                            .with_image_buf(|image_buf| {
                                self.yuv_converter
                                    .convert_nv12_from_iosurface(device, queue, image_buf)
                                    .is_ok()
                            })
                            .unwrap_or(false);

                        if iosurface_converted && self.yuv_converter.output_texture().is_some() {
                            true
                        } else if let (Some(y_data), Some(uv_data)) =
                            (screen_frame.y_plane(), screen_frame.uv_plane())
                        {
                            let y_stride = screen_frame.y_stride();
                            let uv_stride = screen_frame.uv_stride();
                            let convert_result = self.yuv_converter.convert_nv12(
                                device,
                                queue,
                                y_data,
                                uv_data,
                                source_size.x,
                                source_size.y,
                                y_stride,
                                uv_stride,
                            );

                            match convert_result {
                                Ok(_) => self.yuv_converter.output_texture().is_some(),
                                Err(_) => false,
                            }
                        } else {
                            false
                        }
                    } else if let (Some(y_data), Some(uv_data)) =
                        (screen_frame.y_plane(), screen_frame.uv_plane())
                    {
                        let y_stride = screen_frame.y_stride();
                        let uv_stride = screen_frame.uv_stride();
                        let convert_result = self.yuv_converter.convert_nv12_cpu(
                            device,
                            queue,
                            y_data,
                            uv_data,
                            source_size.x,
                            source_size.y,
                            y_stride,
                            uv_stride,
                        );

                        match convert_result {
                            Ok(_) => self.yuv_converter.output_texture().is_some(),
                            Err(_) => false,
                        }
                    } else {
                        false
                    }

                    #[cfg(target_os = "windows")]
                    {
                        let mut d3d11_succeeded = false;

                        if self.yuv_converter.is_using_zero_copy()
                            && let (Some(y_handle), Some(uv_handle)) = (
                                screen_frame.d3d11_y_handle(),
                                screen_frame.d3d11_uv_handle(),
                            )
                            && self
                                .yuv_converter
                                .convert_nv12_from_d3d11_shared_handles(
                                    device,
                                    queue,
                                    y_handle,
                                    uv_handle,
                                    actual_width,
                                    actual_height,
                                )
                                .is_ok()
                            && self.yuv_converter.output_texture().is_some()
                        {
                            d3d11_succeeded = true;
                        }

                        if d3d11_succeeded {
                            true
                        } else if let (Some(y_data), Some(uv_data)) =
                            (screen_frame.y_plane(), screen_frame.uv_plane())
                        {
                            let y_stride = screen_frame.y_stride();
                            let uv_stride = screen_frame.uv_stride();

                            let convert_ok = if self.prefer_cpu_conversion {
                                self.yuv_converter
                                    .convert_nv12_cpu(
                                        device,
                                        queue,
                                        y_data,
                                        uv_data,
                                        actual_width,
                                        actual_height,
                                        y_stride,
                                        uv_stride,
                                    )
                                    .is_ok()
                            } else {
                                self.yuv_converter
                                    .convert_nv12(
                                        device,
                                        queue,
                                        y_data,
                                        uv_data,
                                        actual_width,
                                        actual_height,
                                        y_stride,
                                        uv_stride,
                                    )
                                    .is_ok()
                            };

                            let has_output = self.yuv_converter.output_texture().is_some();

                            convert_ok && has_output
                        } else {
                            self.try_d3d11_staging_fallback(
                                device,
                                queue,
                                screen_frame,
                                actual_width,
                                actual_height,
                                next_texture,
                            )
                        }
                    }

                    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                    {
                        #[cfg(target_os = "linux")]
                        let cuda_result = screen_frame.cuda_nv12().map(|cuda| {
                            let converted = self
                                .yuv_converter
                                .convert_nv12_cuda(device, queue, cuda)
                                .map(|_| ());
                            match converted {
                                Ok(()) if self.yuv_converter.output_texture().is_some() => true,
                                Ok(()) => false,
                                Err(error) => {
                                    tracing::warn!(%error, "CUDA frame conversion failed");
                                    false
                                }
                            }
                        });
                        #[cfg(not(target_os = "linux"))]
                        let cuda_result: Option<bool> = None;
                        if let Some(converted) = cuda_result {
                            converted
                        } else if let (Some(y_data), Some(uv_data)) =
                            (screen_frame.y_plane(), screen_frame.uv_plane())
                        {
                            let y_stride = screen_frame.y_stride();
                            let uv_stride = screen_frame.uv_stride();

                            let convert_result = if self.prefer_cpu_conversion {
                                self.yuv_converter.convert_nv12_cpu(
                                    device,
                                    queue,
                                    y_data,
                                    uv_data,
                                    source_size.x,
                                    source_size.y,
                                    y_stride,
                                    uv_stride,
                                )
                            } else {
                                self.yuv_converter.convert_nv12(
                                    device,
                                    queue,
                                    y_data,
                                    uv_data,
                                    source_size.x,
                                    source_size.y,
                                    y_stride,
                                    uv_stride,
                                )
                            };

                            match convert_result {
                                Ok(_) => self.yuv_converter.output_texture().is_some(),
                                Err(_) => false,
                            }
                        } else {
                            false
                        }
                    }
                }
                PixelFormat::Yuv420p => {
                    let y_plane = screen_frame.y_plane();
                    let u_plane = screen_frame.u_plane();
                    let v_plane = screen_frame.v_plane();

                    if let (Some(y_data), Some(u_data), Some(v_data)) = (y_plane, u_plane, v_plane)
                    {
                        let convert_result = if self.prefer_cpu_conversion {
                            self.yuv_converter.convert_yuv420p_cpu(
                                device,
                                queue,
                                y_data,
                                u_data,
                                v_data,
                                source_size.x,
                                source_size.y,
                                screen_frame.y_stride(),
                                screen_frame.uv_stride(),
                            )
                        } else {
                            self.yuv_converter.convert_yuv420p(
                                device,
                                queue,
                                y_data,
                                u_data,
                                v_data,
                                source_size.x,
                                source_size.y,
                                screen_frame.y_stride(),
                                screen_frame.uv_stride(),
                            )
                        };

                        match convert_result {
                            Ok(_) => self.yuv_converter.output_texture().is_some(),
                            Err(_) => false,
                        }
                    } else {
                        false
                    }
                }
            };

            if frame_uploaded {
                self.last_recording_time = Some(current_recording_time);
                self.last_frame_storage = Some(frame_storage);
                self.current_texture = next_texture;
                self.has_valid_frame = true;
            } else {
                tracing::warn!(
                    recording_time = current_recording_time,
                    width = actual_width,
                    height = actual_height,
                    format = ?format,
                    "Display frame upload failed"
                );
            }
        }

        uniforms.write_to_buffer(queue, &self.uniforms_buffer);
        (
            (skipped && self.has_valid_frame) || frame_uploaded,
            actual_width,
            actual_height,
        )
    }

    pub fn prepare_with_encoder(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        segment_frames: &DecodedSegmentFrames,
        uniforms: CompositeVideoFrameUniforms,
        encoder: &mut wgpu::CommandEncoder,
    ) -> bool {
        let Some(screen_frame) = &segment_frames.screen_frame else {
            tracing::debug!(
                "DisplayLayer::prepare_with_encoder - screen_frame is None, skipping display rendering"
            );
            uniforms.write_to_buffer(queue, &self.uniforms_buffer);
            return false;
        };

        let actual_width = screen_frame.width();
        let actual_height = screen_frame.height();
        let source_size = XY::new(actual_width, actual_height);
        let format = screen_frame.format();
        self.yuv_converter.set_matrix(screen_frame.matrix());
        let current_recording_time = segment_frames.recording_time;
        let frame_storage = screen_frame.storage_identity();

        let skipped = self
            .last_frame_storage
            .as_ref()
            .is_some_and(|last| last.matches(&frame_storage))
            || self
                .last_recording_time
                .is_some_and(|last| (last - current_recording_time).abs() < 0.001);

        let mut frame_uploaded = false;

        if !skipped {
            let next_texture = 1 - self.current_texture;
            self.yuv_converter.set_output_index(next_texture);

            if self.frame_textures[next_texture].width() != source_size.x
                || self.frame_textures[next_texture].height() != source_size.y
            {
                self.frame_textures[next_texture] =
                    CompositeVideoFramePipeline::create_frame_texture(
                        device,
                        source_size.x,
                        source_size.y,
                    );
                self.frame_texture_views[next_texture] =
                    self.frame_textures[next_texture].create_view(&Default::default());

                self.bind_groups[next_texture] = Some(self.pipeline.bind_group(
                    device,
                    &self.uniforms_buffer,
                    &self.frame_texture_views[next_texture],
                ));

                self.yuv_converter.set_external_output(
                    next_texture,
                    self.frame_textures[next_texture].clone(),
                    self.frame_texture_views[next_texture].clone(),
                );
            }

            #[cfg(target_os = "macos")]
            let mut frame_source = None;

            frame_uploaded = match format {
                PixelFormat::Rgba => {
                    let frame_data = screen_frame.data();
                    let src_bytes_per_row = source_size.x * 4;

                    queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.frame_textures[next_texture],
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        frame_data,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(src_bytes_per_row),
                            rows_per_image: Some(source_size.y),
                        },
                        wgpu::Extent3d {
                            width: source_size.x,
                            height: source_size.y,
                            depth_or_array_layers: 1,
                        },
                    );
                    true
                }
                PixelFormat::Nv12 => {
                    #[cfg(target_os = "windows")]
                    let d3d11_zero_copy_succeeded = {
                        let mut succeeded = false;
                        if !self.prefer_cpu_conversion
                            && self.yuv_converter.is_using_zero_copy()
                            && let (Some(y_handle), Some(uv_handle)) = (
                                screen_frame.d3d11_y_handle(),
                                screen_frame.d3d11_uv_handle(),
                            )
                            && self
                                .yuv_converter
                                .convert_nv12_from_d3d11_shared_handles(
                                    device,
                                    queue,
                                    y_handle,
                                    uv_handle,
                                    actual_width,
                                    actual_height,
                                )
                                .is_ok()
                            && self.yuv_converter.output_texture().is_some()
                        {
                            succeeded = true;
                        }
                        succeeded
                    };

                    #[cfg(target_os = "windows")]
                    if d3d11_zero_copy_succeeded {
                        true
                    } else if !self.prefer_cpu_conversion {
                        if let (Some(y_data), Some(uv_data)) =
                            (screen_frame.y_plane(), screen_frame.uv_plane())
                        {
                            let y_stride = screen_frame.y_stride();
                            let uv_stride = screen_frame.uv_stride();

                            let convert_result = self.yuv_converter.convert_nv12_to_encoder(
                                device,
                                queue,
                                encoder,
                                y_data,
                                uv_data,
                                actual_width,
                                actual_height,
                                y_stride,
                                uv_stride,
                            );

                            match convert_result {
                                Ok(_) => self.yuv_converter.output_texture().is_some(),
                                Err(_) => false,
                            }
                        } else {
                            self.try_d3d11_staging_fallback(
                                device,
                                queue,
                                screen_frame,
                                actual_width,
                                actual_height,
                                next_texture,
                            )
                        }
                    } else if let (Some(y_data), Some(uv_data)) =
                        (screen_frame.y_plane(), screen_frame.uv_plane())
                    {
                        let y_stride = screen_frame.y_stride();
                        let uv_stride = screen_frame.uv_stride();
                        let convert_result = self.yuv_converter.convert_nv12_cpu(
                            device,
                            queue,
                            y_data,
                            uv_data,
                            actual_width,
                            actual_height,
                            y_stride,
                            uv_stride,
                        );

                        match convert_result {
                            Ok(_) => self.yuv_converter.output_texture().is_some(),
                            Err(_) => false,
                        }
                    } else {
                        self.try_d3d11_staging_fallback(
                            device,
                            queue,
                            screen_frame,
                            actual_width,
                            actual_height,
                            next_texture,
                        )
                    }

                    #[cfg(not(target_os = "windows"))]
                    if !self.prefer_cpu_conversion {
                        #[cfg(target_os = "macos")]
                        let converted_into_frame = {
                            frame_source = screen_frame
                                .with_image_buf(|image_buf| {
                                    self.yuv_converter
                                        .convert_nv12_from_iosurface_into(
                                            device,
                                            encoder,
                                            image_buf,
                                            &self.frame_texture_views[next_texture],
                                        )
                                        .ok()
                                })
                                .flatten();
                            frame_source.is_some()
                        };
                        #[cfg(not(target_os = "macos"))]
                        let converted_into_frame = false;
                        // Submitted ahead of `encoder`, so queue order still puts
                        // the conversion before the render pass.
                        #[cfg(target_os = "linux")]
                        let iosurface_converted = screen_frame.cuda_nv12().is_some_and(|cuda| {
                            self.yuv_converter
                                .convert_nv12_cuda(device, queue, cuda)
                                .inspect_err(
                                    |error| tracing::warn!(%error, "CUDA frame conversion failed"),
                                )
                                .is_ok()
                        });
                        #[cfg(not(target_os = "linux"))]
                        let iosurface_converted = false;

                        if converted_into_frame
                            || (iosurface_converted
                                && self.yuv_converter.output_texture().is_some())
                        {
                            true
                        } else if let (Some(y_data), Some(uv_data)) =
                            (screen_frame.y_plane(), screen_frame.uv_plane())
                        {
                            let y_stride = screen_frame.y_stride();
                            let uv_stride = screen_frame.uv_stride();

                            let convert_result = self.yuv_converter.convert_nv12_to_encoder(
                                device,
                                queue,
                                encoder,
                                y_data,
                                uv_data,
                                source_size.x,
                                source_size.y,
                                y_stride,
                                uv_stride,
                            );

                            match convert_result {
                                Ok(_) => self.yuv_converter.output_texture().is_some(),
                                Err(_) => false,
                            }
                        } else {
                            false
                        }
                    } else if let (Some(y_data), Some(uv_data)) =
                        (screen_frame.y_plane(), screen_frame.uv_plane())
                    {
                        let y_stride = screen_frame.y_stride();
                        let uv_stride = screen_frame.uv_stride();
                        let convert_result = self.yuv_converter.convert_nv12_cpu(
                            device,
                            queue,
                            y_data,
                            uv_data,
                            source_size.x,
                            source_size.y,
                            y_stride,
                            uv_stride,
                        );

                        match convert_result {
                            Ok(_) => self.yuv_converter.output_texture().is_some(),
                            Err(_) => false,
                        }
                    } else {
                        false
                    }
                }
                PixelFormat::Yuv420p => {
                    let y_plane = screen_frame.y_plane();
                    let u_plane = screen_frame.u_plane();
                    let v_plane = screen_frame.v_plane();

                    if let (Some(y_data), Some(u_data), Some(v_data)) = (y_plane, u_plane, v_plane)
                    {
                        let convert_result = if self.prefer_cpu_conversion {
                            self.yuv_converter.convert_yuv420p_cpu(
                                device,
                                queue,
                                y_data,
                                u_data,
                                v_data,
                                source_size.x,
                                source_size.y,
                                screen_frame.y_stride(),
                                screen_frame.uv_stride(),
                            )
                        } else {
                            self.yuv_converter.convert_yuv420p_to_encoder(
                                device,
                                queue,
                                encoder,
                                y_data,
                                u_data,
                                v_data,
                                source_size.x,
                                source_size.y,
                                screen_frame.y_stride(),
                                screen_frame.uv_stride(),
                            )
                        };

                        match convert_result {
                            Ok(_) => self.yuv_converter.output_texture().is_some(),
                            Err(_) => false,
                        }
                    } else {
                        false
                    }
                }
            };

            if frame_uploaded {
                #[cfg(target_os = "macos")]
                RetainedImageBuf::replace(
                    queue,
                    &mut self.frame_sources[next_texture],
                    frame_source,
                );
                self.last_recording_time = Some(current_recording_time);
                self.last_frame_storage = Some(frame_storage);
                self.current_texture = next_texture;
                self.has_valid_frame = true;
            } else {
                tracing::warn!(
                    recording_time = current_recording_time,
                    width = actual_width,
                    height = actual_height,
                    format = ?format,
                    "Display frame upload failed"
                );
            }
        }

        uniforms.write_to_buffer(queue, &self.uniforms_buffer);
        (skipped && self.has_valid_frame) || frame_uploaded
    }

    pub fn copy_to_texture(&mut self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.has_valid_frame {
            return;
        }

        if let Some(bind_group) = &self.bind_groups[self.current_texture] {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..3, 0..1);
        } else {
            tracing::warn!(
                current_texture_index = self.current_texture,
                "DisplayLayer::render - no bind group available"
            );
        }
    }

    pub fn has_valid_frame(&self) -> bool {
        self.has_valid_frame
    }

    pub fn prepare_for_video_dimensions(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if let Err(e) = self
            .yuv_converter
            .prepare_for_dimensions(device, width, height)
        {
            tracing::warn!(
                width = width,
                height = height,
                error = ?e,
                "Failed to pre-allocate YUV converter textures"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DecodedFrame, DecodedSegmentFrames};

    fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = crate::create_wgpu_instance_sync();
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
    }

    fn read_rgba(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Vec<u8> {
        let stride = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("display NV12 readback"),
            size: u64::from(stride * height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(std::iter::once(encoder.finish()));
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                sender.send(result).unwrap();
            });
        device.poll(wgpu::PollType::Wait).unwrap();
        receiver.recv().unwrap().unwrap();
        let pixels = buffer
            .slice(..)
            .get_mapped_range()
            .chunks(stride as usize)
            .flat_map(|row| row[..width as usize * 4].iter().copied())
            .collect();
        buffer.unmap();
        pixels
    }

    #[test]
    fn nv12_prepare_writes_the_display_texture_directly() {
        let Some((device, queue)) = device() else {
            eprintln!("no GPU adapter available, skipping display NV12 direct-output test");
            return;
        };

        let width = 4u32;
        let height = 4u32;
        let mut data = vec![235u8; (width * height) as usize];
        data.extend(std::iter::repeat_n(
            128u8,
            (width * height.div_ceil(2)) as usize,
        ));

        let frame = DecodedFrame::new_nv12(data, width, height, width, width);
        let frames = DecodedSegmentFrames {
            screen_size: XY::new(width, height),
            screen_frame: Some(frame),
            camera_frame: None,
            segment_time: 0.0,
            recording_time: 0.0,
            segment_has_camera: false,
        };

        let mut layer = DisplayLayer::new_with_options(&device, false);
        let (uploaded, _, _) = layer.prepare(
            &device,
            &queue,
            &frames,
            XY::new(width, height),
            CompositeVideoFrameUniforms::default(),
        );
        assert!(uploaded, "NV12 display upload failed");
        device.poll(wgpu::PollType::Wait).unwrap();

        let rgba = read_rgba(&device, &queue, &layer.frame_textures[1], width, height);
        assert!(
            rgba[0..4].iter().all(|channel| *channel >= 254),
            "expected direct white NV12 output, got {rgba:?}"
        );
    }

    fn nv12_pattern(width: u32, height: u32, seed: u32) -> Vec<u8> {
        let mut data = Vec::with_capacity((width * height * 3 / 2) as usize);
        data.extend((0..width * height).map(|i| ((i * 37 + seed * 97 + 16) % 220) as u8 + 16));
        data.extend(
            (0..width * height.div_ceil(2)).map(|i| ((i * 59 + seed * 131 + 32) % 200) as u8 + 20),
        );
        data
    }

    fn reference_rgba(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipelines: Arc<YuvConverterPipelines>,
        width: u32,
        height: u32,
        data: &[u8],
    ) -> Vec<u8> {
        let y_len = (width * height) as usize;
        let mut converter = YuvToRgbaConverter::new_with_shared_pipelines(device, pipelines);
        converter
            .prepare_for_dimensions(device, width, height)
            .unwrap();
        converter
            .convert_nv12(
                device,
                queue,
                &data[..y_len],
                &data[y_len..],
                width,
                height,
                width,
                width,
            )
            .unwrap();

        let target = CompositeVideoFramePipeline::create_frame_texture(device, width, height);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_texture(
            converter.output_texture().unwrap().as_image_copy(),
            target.as_image_copy(),
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(std::iter::once(encoder.finish()));
        read_rgba(device, queue, &target, width, height)
    }

    #[test]
    fn direct_output_matches_intermediate_copy_across_size_changes() {
        let Some((device, queue)) = device() else {
            eprintln!("no GPU adapter available, skipping display direct-output parity test");
            return;
        };

        let pipelines = Arc::new(YuvConverterPipelines::new(&device));
        let composite = Arc::new(CompositeVideoFramePipeline::new(&device));
        let sizes = [(4u32, 4u32), (4, 4), (4, 4), (6u32, 5u32), (6, 5), (6, 5)];
        for encoder_path in [false, true] {
            let mut layer = DisplayLayer::new_with_all_shared_pipelines(
                &device,
                Arc::clone(&pipelines),
                Arc::clone(&composite),
                false,
            );
            for (index, (width, height)) in sizes.into_iter().enumerate() {
                let data = nv12_pattern(width, height, index as u32);
                let frame = DecodedFrame::new_nv12(data.clone(), width, height, width, width);
                let frames = DecodedSegmentFrames {
                    screen_size: XY::new(width, height),
                    screen_frame: Some(frame),
                    camera_frame: None,
                    segment_time: index as f32,
                    recording_time: index as f32,
                    segment_has_camera: false,
                };

                if encoder_path {
                    let mut encoder = device.create_command_encoder(&Default::default());
                    assert!(layer.prepare_with_encoder(
                        &device,
                        &queue,
                        &frames,
                        CompositeVideoFrameUniforms::default(),
                        &mut encoder,
                    ));
                    queue.submit(std::iter::once(encoder.finish()));
                } else {
                    let (uploaded, _, _) = layer.prepare(
                        &device,
                        &queue,
                        &frames,
                        XY::new(width, height),
                        CompositeVideoFrameUniforms::default(),
                    );
                    assert!(uploaded);
                }
                device.poll(wgpu::PollType::Wait).unwrap();

                let direct = read_rgba(
                    &device,
                    &queue,
                    &layer.frame_textures[layer.current_texture],
                    width,
                    height,
                );
                let expected = reference_rgba(
                    &device,
                    &queue,
                    Arc::clone(&pipelines),
                    width,
                    height,
                    &data,
                );
                assert_eq!(
                    direct, expected,
                    "encoder_path={encoder_path} {width}x{height}"
                );
            }
        }
    }

    #[test]
    fn nv12_prepare_with_encoder_writes_the_display_texture_directly() {
        let Some((device, queue)) = device() else {
            eprintln!("no GPU adapter available, skipping display NV12 encoder test");
            return;
        };

        let width = 4u32;
        let height = 4u32;
        let mut data = vec![235u8; (width * height) as usize];
        data.extend(std::iter::repeat_n(
            128u8,
            (width * height.div_ceil(2)) as usize,
        ));
        let frame = DecodedFrame::new_nv12(data, width, height, width, width);
        let frames = DecodedSegmentFrames {
            screen_size: XY::new(width, height),
            screen_frame: Some(frame),
            camera_frame: None,
            segment_time: 0.0,
            recording_time: 0.0,
            segment_has_camera: false,
        };

        let mut layer = DisplayLayer::new_with_options(&device, false);
        let mut encoder = device.create_command_encoder(&Default::default());
        let uploaded = layer.prepare_with_encoder(
            &device,
            &queue,
            &frames,
            CompositeVideoFrameUniforms::default(),
            &mut encoder,
        );
        assert!(uploaded, "NV12 display encoder upload failed");
        queue.submit(std::iter::once(encoder.finish()));
        device.poll(wgpu::PollType::Wait).unwrap();

        let rgba = read_rgba(&device, &queue, &layer.frame_textures[1], width, height);
        assert!(
            rgba[0..4].iter().all(|channel| *channel >= 254),
            "expected direct white NV12 output, got {rgba:?}"
        );
    }
}
