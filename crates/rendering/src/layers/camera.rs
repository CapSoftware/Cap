use cap_project::XY;
use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::{
    CompositeVideoFrameUniforms, DecodedFrame, PixelFormat,
    composite_frame::CompositeVideoFramePipeline,
    yuv_converter::{YuvConverterPipelines, YuvToRgbaConverter},
};

pub struct CameraLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    pipeline: Arc<CompositeVideoFramePipeline>,
    hidden: bool,
    last_recording_time: Option<f32>,
    yuv_converter: YuvToRgbaConverter,
}

impl CameraLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self::new_with_all_shared_pipelines(
            device,
            Arc::new(YuvConverterPipelines::new(device)),
            Arc::new(CompositeVideoFramePipeline::new(device)),
        )
    }

    pub fn new_with_all_shared_pipelines(
        device: &wgpu::Device,
        yuv_pipelines: Arc<YuvConverterPipelines>,
        composite_pipeline: Arc<CompositeVideoFramePipeline>,
    ) -> Self {
        let frame_texture_0 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_1 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_view_0 = frame_texture_0.create_view(&Default::default());
        let frame_texture_view_1 = frame_texture_1.create_view(&Default::default());

        let uniforms_buffer = device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CameraLayer Uniforms Buffer"),
                contents: bytemuck::cast_slice(&[CompositeVideoFrameUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        );

        let bind_group_0 =
            Some(composite_pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_0));
        let bind_group_1 =
            Some(composite_pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_1));

        let yuv_converter = YuvToRgbaConverter::new_with_shared_pipelines(device, yuv_pipelines);

        Self {
            frame_textures: [frame_texture_0, frame_texture_1],
            frame_texture_views: [frame_texture_view_0, frame_texture_view_1],
            current_texture: 0,
            uniforms_buffer,
            bind_groups: [bind_group_0, bind_group_1],
            pipeline: composite_pipeline,
            hidden: false,
            last_recording_time: None,
            yuv_converter,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: Option<CompositeVideoFrameUniforms>,
        frame_data: Option<(XY<u32>, &DecodedFrame, f32)>,
    ) {
        let Some(uniforms) = uniforms else {
            self.hidden = true;
            return;
        };

        let has_previous_frame = self.last_recording_time.is_some();
        self.hidden = frame_data.is_none() && !has_previous_frame;

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let Some((frame_size, camera_frame, recording_time)) = frame_data else {
            return;
        };

        let frame_data_bytes = camera_frame.data();
        let format = camera_frame.format();

        let is_same_frame = self
            .last_recording_time
            .is_some_and(|last| (last - recording_time).abs() < 0.001);

        if !is_same_frame {
            let next_texture = 1 - self.current_texture;

            if self.frame_textures[next_texture].width() != frame_size.x
                || self.frame_textures[next_texture].height() != frame_size.y
            {
                self.frame_textures[next_texture] =
                    CompositeVideoFramePipeline::create_frame_texture(
                        device,
                        frame_size.x,
                        frame_size.y,
                    );
                self.frame_texture_views[next_texture] =
                    self.frame_textures[next_texture].create_view(&Default::default());

                self.bind_groups[next_texture] = Some(self.pipeline.bind_group(
                    device,
                    &self.uniforms_buffer,
                    &self.frame_texture_views[next_texture],
                ));
            }

            match format {
                PixelFormat::Rgba => {
                    let src_bytes_per_row = frame_size.x * 4;

                    queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.frame_textures[next_texture],
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        frame_data_bytes,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(src_bytes_per_row),
                            rows_per_image: Some(frame_size.y),
                        },
                        wgpu::Extent3d {
                            width: frame_size.x,
                            height: frame_size.y,
                            depth_or_array_layers: 1,
                        },
                    );
                }
                PixelFormat::Nv12 => {
                    if let Err(e) = self.yuv_converter.prepare_for_dimensions(
                        device,
                        frame_size.x,
                        frame_size.y,
                    ) {
                        tracing::warn!(error = %e, "YUV converter prepare failed");
                        return;
                    }

                    #[cfg(target_os = "windows")]
                    {
                        if let Some(nv12_texture) = camera_frame.d3d11_texture_backing() {
                            if let Ok(d3d11_device) = unsafe { nv12_texture.GetDevice() } {
                                if let Ok(d3d11_context) =
                                    unsafe { d3d11_device.GetImmediateContext() }
                                {
                                    if self
                                        .yuv_converter
                                        .convert_nv12_with_fallback(
                                            device,
                                            queue,
                                            &d3d11_device,
                                            &d3d11_context,
                                            nv12_texture,
                                            camera_frame.d3d11_y_handle(),
                                            camera_frame.d3d11_uv_handle(),
                                            frame_size.x,
                                            frame_size.y,
                                        )
                                        .is_ok()
                                        && self.yuv_converter.output_texture().is_some()
                                    {
                                        self.copy_from_yuv_output(
                                            device,
                                            queue,
                                            next_texture,
                                            frame_size,
                                        );
                                        self.last_recording_time = Some(recording_time);
                                        self.current_texture = next_texture;
                                        return;
                                    }
                                } else {
                                    tracing::warn!(
                                        "Failed to get D3D11 immediate context for camera frame"
                                    );
                                }
                            } else {
                                tracing::warn!("Failed to get D3D11 device for camera frame");
                            }
                        }
                    }

                    if let (Some(y_data), Some(uv_data)) =
                        (camera_frame.y_plane(), camera_frame.uv_plane())
                        && self
                            .yuv_converter
                            .convert_nv12(
                                device,
                                queue,
                                y_data,
                                uv_data,
                                frame_size.x,
                                frame_size.y,
                                camera_frame.y_stride(),
                                camera_frame.uv_stride(),
                            )
                            .is_ok()
                    {
                        self.copy_from_yuv_output(device, queue, next_texture, frame_size);
                    }
                }
                PixelFormat::Yuv420p => {
                    if let Err(e) = self.yuv_converter.prepare_for_dimensions(
                        device,
                        frame_size.x,
                        frame_size.y,
                    ) {
                        tracing::warn!(error = %e, "YUV converter prepare failed");
                        return;
                    }

                    if let (Some(y_data), Some(u_data), Some(v_data)) = (
                        camera_frame.y_plane(),
                        camera_frame.u_plane(),
                        camera_frame.v_plane(),
                    ) && self
                        .yuv_converter
                        .convert_yuv420p(
                            device,
                            queue,
                            y_data,
                            u_data,
                            v_data,
                            frame_size.x,
                            frame_size.y,
                            camera_frame.y_stride(),
                            camera_frame.uv_stride(),
                        )
                        .is_ok()
                    {
                        self.copy_from_yuv_output(device, queue, next_texture, frame_size);
                    }
                }
            }

            self.last_recording_time = Some(recording_time);
            self.current_texture = next_texture;
        }
    }

    fn copy_from_yuv_output(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        next_texture: usize,
        frame_size: XY<u32>,
    ) {
        if let Some(output_texture) = self.yuv_converter.output_texture() {
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Camera YUV Copy Encoder"),
            });

            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: output_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.frame_textures[next_texture],
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: frame_size.x,
                    height: frame_size.y,
                    depth_or_array_layers: 1,
                },
            );

            let _submission_index = queue.submit(std::iter::once(encoder.finish()));
        }
    }

    fn copy_from_yuv_output_to_encoder(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        next_texture: usize,
        frame_size: XY<u32>,
    ) {
        if let Some(output_texture) = self.yuv_converter.output_texture() {
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: output_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.frame_textures[next_texture],
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: frame_size.x,
                    height: frame_size.y,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    pub fn prepare_with_encoder(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: Option<CompositeVideoFrameUniforms>,
        frame_data: Option<(XY<u32>, &DecodedFrame, f32)>,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let Some(uniforms) = uniforms else {
            self.hidden = true;
            return;
        };

        let has_previous_frame = self.last_recording_time.is_some();
        self.hidden = frame_data.is_none() && !has_previous_frame;

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let Some((frame_size, camera_frame, recording_time)) = frame_data else {
            return;
        };

        let format = camera_frame.format();

        let is_same_frame = self
            .last_recording_time
            .is_some_and(|last| (last - recording_time).abs() < 0.001);

        if !is_same_frame {
            let next_texture = 1 - self.current_texture;

            if self.frame_textures[next_texture].width() != frame_size.x
                || self.frame_textures[next_texture].height() != frame_size.y
            {
                self.frame_textures[next_texture] =
                    CompositeVideoFramePipeline::create_frame_texture(
                        device,
                        frame_size.x,
                        frame_size.y,
                    );
                self.frame_texture_views[next_texture] =
                    self.frame_textures[next_texture].create_view(&Default::default());

                self.bind_groups[next_texture] = Some(self.pipeline.bind_group(
                    device,
                    &self.uniforms_buffer,
                    &self.frame_texture_views[next_texture],
                ));
            }

            match format {
                PixelFormat::Rgba => {
                    let frame_data_bytes = camera_frame.data();
                    let src_bytes_per_row = frame_size.x * 4;

                    queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.frame_textures[next_texture],
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        frame_data_bytes,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(src_bytes_per_row),
                            rows_per_image: Some(frame_size.y),
                        },
                        wgpu::Extent3d {
                            width: frame_size.x,
                            height: frame_size.y,
                            depth_or_array_layers: 1,
                        },
                    );
                }
                PixelFormat::Nv12 => {
                    if let Err(e) = self.yuv_converter.prepare_for_dimensions(
                        device,
                        frame_size.x,
                        frame_size.y,
                    ) {
                        tracing::warn!(error = %e, "YUV converter prepare failed");
                        return;
                    }

                    if let (Some(y_data), Some(uv_data)) =
                        (camera_frame.y_plane(), camera_frame.uv_plane())
                        && self
                            .yuv_converter
                            .convert_nv12_to_encoder(
                                device,
                                queue,
                                encoder,
                                y_data,
                                uv_data,
                                frame_size.x,
                                frame_size.y,
                                camera_frame.y_stride(),
                                camera_frame.uv_stride(),
                            )
                            .is_ok()
                    {
                        self.copy_from_yuv_output_to_encoder(encoder, next_texture, frame_size);
                    }
                }
                PixelFormat::Yuv420p => {
                    if let Err(e) = self.yuv_converter.prepare_for_dimensions(
                        device,
                        frame_size.x,
                        frame_size.y,
                    ) {
                        tracing::warn!(error = %e, "YUV converter prepare failed");
                        return;
                    }

                    if let (Some(y_data), Some(u_data), Some(v_data)) = (
                        camera_frame.y_plane(),
                        camera_frame.u_plane(),
                        camera_frame.v_plane(),
                    ) && self
                        .yuv_converter
                        .convert_yuv420p_to_encoder(
                            device,
                            queue,
                            encoder,
                            y_data,
                            u_data,
                            v_data,
                            frame_size.x,
                            frame_size.y,
                            camera_frame.y_stride(),
                            camera_frame.uv_stride(),
                        )
                        .is_ok()
                    {
                        self.copy_from_yuv_output_to_encoder(encoder, next_texture, frame_size);
                    }
                }
            }

            self.last_recording_time = Some(recording_time);
            self.current_texture = next_texture;
        }
    }

    pub fn copy_to_texture(&mut self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.hidden
            && let Some(bind_group) = &self.bind_groups[self.current_texture]
        {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
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
                "Failed to pre-allocate camera YUV converter textures"
            );
        }
    }
}
