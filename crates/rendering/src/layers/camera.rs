use cap_project::XY;
use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::{
    CompositeVideoFrameUniforms, DecodedFrame, PixelFormat,
    composite_frame::CompositeVideoFramePipeline,
    decoder::DecodedFrameStorageIdentity,
    yuv_converter::{YuvConverterPipelines, YuvToRgbaConverter},
};

#[cfg(target_os = "macos")]
use crate::yuv_converter::RetainedImageBuf;

pub struct CameraLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    pipeline: Arc<CompositeVideoFramePipeline>,
    hidden: bool,
    last_recording_time: Option<f32>,
    last_frame_storage: Option<DecodedFrameStorageIdentity>,
    yuv_converter: YuvToRgbaConverter,
    #[cfg(target_os = "macos")]
    frame_sources: [Option<RetainedImageBuf>; 2],
    blur_bind_group: Option<wgpu::BindGroup>,
    blur_active: bool,
    blur_cache: Option<BlurCacheEntry>,
}

#[derive(Clone, Copy)]
struct BlurCacheEntry {
    recording_time: f32,
    mode: cap_camera_effects::BlurMode,
    texture_idx: usize,
    output_generation: u64,
}

impl CameraLayer {
    /// Forget the last frame shown, as a new layer would: the next render of
    /// a reused layer set starts somewhere else in the recording.
    pub(crate) fn reset_frame_state(&mut self) {
        self.last_recording_time = None;
        self.last_frame_storage = None;
        self.blur_cache = None;
    }

    #[allow(dead_code)]
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
        let frame_texture_0 = CompositeVideoFramePipeline::create_frame_texture(device, 1, 1);
        let frame_texture_1 = CompositeVideoFramePipeline::create_frame_texture(device, 1, 1);
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
            last_frame_storage: None,
            yuv_converter,
            #[cfg(target_os = "macos")]
            frame_sources: [None, None],
            blur_bind_group: None,
            blur_active: false,
            blur_cache: None,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: Option<CompositeVideoFrameUniforms>,
        frame_data: Option<(XY<u32>, &DecodedFrame, f32)>,
    ) {
        self.blur_active = false;

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
        self.yuv_converter.set_matrix(camera_frame.matrix());
        let frame_storage = camera_frame.storage_identity();

        let is_same_frame = self
            .last_frame_storage
            .as_ref()
            .is_some_and(|last| last.matches(&frame_storage))
            || self
                .last_recording_time
                .is_some_and(|last| (last - recording_time).abs() < 0.001);

        if !is_same_frame {
            let next_texture = 1 - self.current_texture;

            self.resize_frame_texture(device, next_texture, frame_size.x, frame_size.y);

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
                                        self.last_frame_storage = Some(frame_storage);
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

                    #[cfg(target_os = "macos")]
                    let iosurface_converted = camera_frame
                        .with_image_buf(|image_buf| {
                            self.yuv_converter
                                .convert_nv12_from_iosurface(device, queue, image_buf)
                                .is_ok()
                        })
                        .unwrap_or(false);
                    #[cfg(target_os = "linux")]
                    let iosurface_converted = camera_frame.cuda_nv12().is_some_and(|cuda| {
                        self.yuv_converter
                            .convert_nv12_cuda(device, queue, cuda)
                            .inspect_err(|error| {
                                tracing::warn!(%error, "CUDA camera frame conversion failed")
                            })
                            .is_ok()
                    });
                    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
                    let iosurface_converted = false;

                    if iosurface_converted && self.yuv_converter.output_texture().is_some() {
                        self.copy_from_yuv_output(device, queue, next_texture, frame_size);
                    } else if let (Some(y_data), Some(uv_data)) =
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
            self.last_frame_storage = Some(frame_storage);
            self.current_texture = next_texture;
        } else {
            self.last_recording_time = Some(recording_time);
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
        self.blur_active = false;

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
        self.yuv_converter.set_matrix(camera_frame.matrix());
        let frame_storage = camera_frame.storage_identity();

        let is_same_frame = self
            .last_frame_storage
            .as_ref()
            .is_some_and(|last| last.matches(&frame_storage))
            || self
                .last_recording_time
                .is_some_and(|last| (last - recording_time).abs() < 0.001);

        if !is_same_frame {
            let next_texture = 1 - self.current_texture;

            self.resize_frame_texture(device, next_texture, frame_size.x, frame_size.y);

            #[cfg(target_os = "macos")]
            let mut frame_source = None;

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
                    #[cfg(target_os = "macos")]
                    let converted_into_frame = {
                        frame_source = camera_frame
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

                    if !converted_into_frame {
                        if let Err(e) = self.yuv_converter.prepare_for_dimensions(
                            device,
                            frame_size.x,
                            frame_size.y,
                        ) {
                            tracing::warn!(error = %e, "YUV converter prepare failed");
                            return;
                        }

                        // Submitted on its own ahead of `encoder`, so queue order
                        // still has the conversion land before the copy below.
                        #[cfg(target_os = "linux")]
                        let iosurface_converted = camera_frame.cuda_nv12().is_some_and(|cuda| {
                            self.yuv_converter
                                .convert_nv12_cuda(device, queue, cuda)
                                .inspect_err(|error| {
                                    tracing::warn!(%error, "CUDA camera frame conversion failed")
                                })
                                .is_ok()
                        });
                        #[cfg(not(target_os = "linux"))]
                        let iosurface_converted = false;

                        if iosurface_converted && self.yuv_converter.output_texture().is_some() {
                            self.copy_from_yuv_output_to_encoder(encoder, next_texture, frame_size);
                        } else if let (Some(y_data), Some(uv_data)) =
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

            #[cfg(target_os = "macos")]
            RetainedImageBuf::replace(queue, &mut self.frame_sources[next_texture], frame_source);
            self.last_recording_time = Some(recording_time);
            self.last_frame_storage = Some(frame_storage);
            self.current_texture = next_texture;
        } else {
            self.last_recording_time = Some(recording_time);
        }
    }

    pub fn source_time_for_blur(&self) -> Option<f32> {
        self.last_recording_time.filter(|_| !self.hidden)
    }

    pub fn source_texture_for_blur(&self) -> Option<&wgpu::Texture> {
        if self.hidden || self.last_recording_time.is_none() {
            return None;
        }
        Some(&self.frame_textures[self.current_texture])
    }

    pub fn attach_shared_blur(
        &mut self,
        device: &wgpu::Device,
        processor: &cap_camera_effects::BlurProcessor,
        mode: cap_camera_effects::BlurMode,
    ) {
        if self.hidden || self.last_recording_time.is_none() {
            return;
        }

        let recording_time = self.last_recording_time.expect("checked above");
        let current = self.current_texture;
        let processor_generation = processor.output_generation();

        let cache_hit = matches!(
            self.blur_cache,
            Some(entry)
                if entry.texture_idx == current
                    && entry.mode == mode
                    && (entry.recording_time - recording_time).abs() < 0.001
                    && entry.output_generation == processor_generation
        ) && self.blur_bind_group.is_some();

        if cache_hit {
            self.blur_active = true;
            return;
        }

        let Some(output_view) = processor.output_view() else {
            return;
        };

        self.blur_bind_group = Some(self.pipeline.bind_group(
            device,
            &self.uniforms_buffer,
            output_view,
        ));
        self.blur_cache = Some(BlurCacheEntry {
            recording_time,
            mode,
            texture_idx: current,
            output_generation: processor_generation,
        });
        self.blur_active = true;
    }

    pub fn copy_to_texture(&mut self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.hidden {
            return;
        }

        let bind_group = if self.blur_active {
            self.blur_bind_group
                .as_ref()
                .or(self.bind_groups[self.current_texture].as_ref())
        } else {
            self.bind_groups[self.current_texture].as_ref()
        };

        if let Some(bind_group) = bind_group {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
    }

    fn resize_frame_texture(
        &mut self,
        device: &wgpu::Device,
        index: usize,
        width: u32,
        height: u32,
    ) -> bool {
        if self.frame_textures[index].width() == width
            && self.frame_textures[index].height() == height
        {
            return false;
        }
        self.frame_textures[index] =
            CompositeVideoFramePipeline::create_frame_texture(device, width, height);
        self.frame_texture_views[index] =
            self.frame_textures[index].create_view(&Default::default());
        self.bind_groups[index] = Some(self.pipeline.bind_group(
            device,
            &self.uniforms_buffer,
            &self.frame_texture_views[index],
        ));
        true
    }

    pub fn prepare_for_video_dimensions(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
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
            return;
        }
        let max_dimension = device.limits().max_texture_dimension_2d;
        if width > max_dimension || height > max_dimension {
            tracing::warn!(
                width,
                height,
                max_dimension,
                "Camera frame dimensions exceed the texture limit"
            );
            return;
        }
        let mut resized = false;
        for index in 0..self.frame_textures.len() {
            resized |= self.resize_frame_texture(device, index, width, height);
        }
        if resized {
            self.reset_frame_state();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CursorEvents, DecodedSegmentFrames, FrameRenderer, ProjectConfiguration, ProjectUniforms,
        RecordingMeta, RenderOptions, RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
    };

    async fn constants() -> RenderVideoConstants {
        let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "camera texture boundary",
            "display": { "path": "unused.mp4", "fps": 60 },
            "camera": { "path": "unused-camera.mp4", "fps": 60 },
            "audio": null, "cursor": null
        }))
        .unwrap();
        let studio = metadata.studio_meta().unwrap().clone();
        RenderVideoConstants::new_with_options(
            RenderOptions {
                screen_size: XY::new(320, 180),
                camera_size: Some(XY::new(1920, 1080)),
                preserve_screen_alpha: false,
            },
            metadata,
            studio,
        )
        .await
        .expect("A working native WGPU adapter is required")
    }

    fn legacy_layers(constants: &RenderVideoConstants) -> RendererLayers {
        let mut layers = RendererLayers::new(&constants.device, &constants.queue);
        for camera in [&mut layers.camera, &mut layers.camera_only] {
            for index in 0..2 {
                camera.frame_textures[index] = CompositeVideoFramePipeline::create_frame_texture(
                    &constants.device,
                    1920,
                    1080,
                );
                camera.frame_texture_views[index] =
                    camera.frame_textures[index].create_view(&Default::default());
                camera.bind_groups[index] = Some(camera.pipeline.bind_group(
                    &constants.device,
                    &camera.uniforms_buffer,
                    &camera.frame_texture_views[index],
                ));
            }
        }
        layers
    }

    fn frames(camera: Option<DecodedFrame>, number: u32) -> DecodedSegmentFrames {
        DecodedSegmentFrames {
            screen_size: XY::new(320, 180),
            screen_frame: Some(DecodedFrame::new(
                [17, 43, 89, 255].repeat(320 * 180),
                320,
                180,
            )),
            camera_frame: camera,
            segment_time: number as f32 / 60.0,
            recording_time: number as f32 / 60.0,
            segment_has_camera: true,
        }
    }

    async fn pixels(
        constants: &RenderVideoConstants,
        project: &ProjectConfiguration,
        frames: DecodedSegmentFrames,
        layers: &mut RendererLayers,
        ordinary_prepare: bool,
    ) -> Vec<u8> {
        let cursor = CursorEvents::default();
        let size = XY::new(320, 180);
        let zoom = ZoomTransformTimeline::from_project(
            project,
            &cursor,
            6.0,
            crate::ZoomLayoutInputs::screen_only(size),
        );
        let uniforms = ProjectUniforms::new(
            constants,
            &std::sync::Arc::new(project.clone()),
            (frames.segment_time * 60.0).round() as u32,
            60,
            size,
            &cursor,
            &frames,
            6.0,
            &zoom,
        );
        if ordinary_prepare {
            layers
                .prepare(constants, &uniforms, &frames, &cursor, true)
                .await
                .unwrap();
        }
        let mut renderer = FrameRenderer::new(constants);
        let output = renderer
            .render_immediate(frames, uniforms, &cursor, true, layers)
            .await
            .unwrap();
        output
            .data
            .chunks_exact(output.padded_bytes_per_row as usize)
            .flat_map(|row| row[..output.width as usize * 4].iter().copied())
            .collect()
    }

    fn matches_color(pixel: &[u8], expected: [u8; 4]) -> bool {
        pixel
            .iter()
            .zip(expected)
            .all(|(&value, expected)| value.abs_diff(expected) <= 2)
    }

    #[tokio::test]
    #[ignore = "requires a working native WGPU adapter"]
    async fn camera_setup_keeps_frame_resources_out_of_first_uploads() {
        let constants = constants().await;
        let mut layers = RendererLayers::new(&constants.device, &constants.queue);
        layers.prepare_for_video_dimensions(&constants.device, 320, 180, None, None);
        for camera in [&layers.camera, &layers.camera_only] {
            assert!(
                camera
                    .frame_textures
                    .iter()
                    .all(|texture| { texture.width() == 1 && texture.height() == 1 })
            );
        }
        let initial_resources = (
            layers.camera.frame_textures.clone(),
            layers.camera.frame_texture_views.clone(),
            layers.camera.bind_groups.clone(),
        );
        let max_dimension = constants.device.limits().max_texture_dimension_2d;
        for (width, height) in [(0, 1080), (max_dimension + 1, 2), (2, max_dimension + 1)] {
            layers
                .camera
                .prepare_for_video_dimensions(&constants.device, width, height);
            assert_eq!(layers.camera.frame_textures, initial_resources.0);
            assert_eq!(layers.camera.frame_texture_views, initial_resources.1);
            assert_eq!(layers.camera.bind_groups, initial_resources.2);
        }

        for (width, height) in [(1920, 1080), (1280, 720), (3840, 2160), (1080, 1920)] {
            for camera_only in [false, true] {
                for ordinary_prepare in [false, true] {
                    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
                    layers.prepare_for_video_dimensions(
                        &constants.device,
                        320,
                        180,
                        Some(width),
                        Some(height),
                    );
                    let resources: Vec<_> = [&layers.camera, &layers.camera_only]
                        .into_iter()
                        .map(|camera| {
                            assert!(camera.frame_textures.iter().all(|texture| {
                                texture.width() == width && texture.height() == height
                            }));
                            (
                                camera.frame_textures.clone(),
                                camera.frame_texture_views.clone(),
                                camera.bind_groups.clone(),
                            )
                        })
                        .collect();
                    layers.prepare_for_video_dimensions(
                        &constants.device,
                        320,
                        180,
                        Some(width),
                        Some(height),
                    );
                    let mut project = ProjectConfiguration::default();
                    project.camera.hide = false;
                    if camera_only {
                        project.timeline = Some(
                            serde_json::from_value(serde_json::json!({
                                "segments": [], "zoomSegments": [],
                                "sceneSegments": [{
                                    "start": 2.0, "end": 5.0, "mode": "cameraOnly",
                                    "transitionIn": 0.0, "transitionOut": 0.0
                                }]
                            }))
                            .unwrap(),
                        );
                    }
                    for (number, color) in
                        [[255, 0, 0, 255], [0, 0, 255, 255]].into_iter().enumerate()
                    {
                        let camera = DecodedFrame::new(
                            color.repeat(width as usize * height as usize),
                            width,
                            height,
                        );
                        let output = pixels(
                            &constants,
                            &project,
                            frames(Some(camera), 180 + number as u32),
                            &mut layers,
                            ordinary_prepare,
                        )
                        .await;
                        assert!(
                            output
                                .chunks_exact(4)
                                .filter(|pixel| matches_color(pixel, color))
                                .count()
                                > 100
                        );
                        for (camera, expected) in [&layers.camera, &layers.camera_only]
                            .into_iter()
                            .zip(&resources)
                        {
                            assert_eq!(&camera.frame_textures, &expected.0);
                            assert_eq!(&camera.frame_texture_views, &expected.1);
                            assert_eq!(&camera.bind_groups, &expected.2);
                        }
                    }
                }
            }
        }

        let project = ProjectConfiguration::default();
        let camera = DecodedFrame::new([255, 0, 0, 255].repeat(1920 * 1080), 1920, 1080);
        let input = frames(Some(camera), 180);
        layers.prepare_for_video_dimensions(&constants.device, 320, 180, Some(1920), Some(1080));
        let original = pixels(&constants, &project, input.clone(), &mut layers, false).await;
        layers.prepare_for_video_dimensions(&constants.device, 320, 180, Some(1280), Some(720));
        layers.prepare_for_video_dimensions(&constants.device, 320, 180, Some(1920), Some(1080));
        let repeated = pixels(&constants, &project, input, &mut layers, false).await;
        assert_eq!(original, repeated);
    }

    #[tokio::test]
    #[ignore = "requires a working native WGPU adapter"]
    async fn camera_placeholders_preserve_pixels_through_frame_state_changes() {
        let constants = constants().await;
        for camera_only in [false, true] {
            for ordinary_prepare in [false, true] {
                let mut current = RendererLayers::new(&constants.device, &constants.queue);
                let mut legacy = legacy_layers(&constants);
                for layers in [&mut current, &mut legacy] {
                    layers.prepare_for_video_dimensions(
                        &constants.device,
                        320,
                        180,
                        Some(1920),
                        Some(1080),
                    );
                }
                let mut project = ProjectConfiguration::default();
                project.background.source = cap_project::BackgroundSource::Color {
                    value: [0, 255, 0],
                    alpha: 255,
                };
                project.background.shadow = 0.0;
                project.camera.shadow = 0.0;
                if camera_only {
                    project.timeline = Some(
                        serde_json::from_value(serde_json::json!({
                            "segments": [], "zoomSegments": [],
                            "sceneSegments": [{
                                "start": 2.0, "end": 5.0, "mode": "cameraOnly",
                                "transitionIn": 0.0, "transitionOut": 0.0
                            }]
                        }))
                        .unwrap(),
                    );
                }
                let red = || DecodedFrame::new([255, 0, 0, 255].repeat(1920 * 1080), 1920, 1080);
                let blue = || DecodedFrame::new([0, 0, 255, 255].repeat(1920 * 1080), 1920, 1080);
                let mut nv12 = vec![81; 640 * 360];
                nv12.extend([90, 240].repeat(640 * 360 / 4));
                let mut yuv420p = vec![41; 160 * 90];
                yuv420p.extend(vec![240; 160 * 90 / 4]);
                yuv420p.extend(vec![110; 160 * 90 / 4]);
                let steps = [
                    (None, None, false, false),
                    (Some(red()), Some([255, 0, 0, 255]), false, false),
                    (Some(blue()), Some([0, 0, 255, 255]), false, false),
                    (None, Some([0, 0, 255, 255]), false, false),
                    (None, None, true, false),
                    (None, Some([0, 0, 255, 255]), false, false),
                    (
                        Some(DecodedFrame::new(
                            [255, 0, 0, 255].repeat(160 * 90),
                            160,
                            90,
                        )),
                        Some([255, 0, 0, 255]),
                        false,
                        false,
                    ),
                    (Some(blue()), Some([0, 0, 255, 255]), false, false),
                    (
                        Some(DecodedFrame::new(
                            [255, 0, 0, 255].repeat(640 * 360),
                            640,
                            360,
                        )),
                        Some([255, 0, 0, 255]),
                        false,
                        false,
                    ),
                    (None, None, false, true),
                    (
                        Some(DecodedFrame::new_nv12(nv12, 640, 360, 640, 640)),
                        Some([255, 0, 0, 255]),
                        false,
                        false,
                    ),
                    (
                        Some(DecodedFrame::new_yuv420p(yuv420p, 160, 90, 160, 80)),
                        Some([1, 0, 255, 255]),
                        false,
                        false,
                    ),
                    (Some(blue()), Some([0, 0, 255, 255]), false, false),
                ];
                for (index, (camera, color, hidden, reset)) in steps.into_iter().enumerate() {
                    project.camera.hide = hidden;
                    if reset {
                        current.reset_frame_state();
                        legacy.reset_frame_state();
                    }
                    let frames = frames(camera, 180 + index as u32);
                    let actual = pixels(
                        &constants,
                        &project,
                        frames.clone(),
                        &mut current,
                        ordinary_prepare,
                    )
                    .await;
                    let expected =
                        pixels(&constants, &project, frames, &mut legacy, ordinary_prepare).await;
                    assert_eq!(
                        actual, expected,
                        "step {index}, cameraOnly={camera_only}, ordinary={ordinary_prepare}"
                    );
                    if let Some(color) = color {
                        assert!(
                            actual
                                .chunks_exact(4)
                                .filter(|pixel| matches_color(pixel, color))
                                .count()
                                > 100,
                            "The camera must visibly draw the expected frame at step {index}"
                        );
                    } else {
                        assert!(!actual.chunks_exact(4).any(|pixel| matches_color(
                            pixel,
                            [255, 0, 0, 255]
                        ) || matches_color(
                            pixel,
                            [0, 0, 255, 255]
                        )));
                    }
                }
            }
        }
    }
}
