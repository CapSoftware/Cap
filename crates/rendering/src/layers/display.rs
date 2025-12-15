use cap_project::XY;

use crate::{
    DecodedSegmentFrames, PixelFormat,
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    yuv_converter::YuvToRgbaConverter,
};

struct PendingTextureCopy {
    width: u32,
    height: u32,
    dst_texture_index: usize,
}

pub struct DisplayLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    pipeline: CompositeVideoFramePipeline,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    last_recording_time: Option<f32>,
    yuv_converter: YuvToRgbaConverter,
    pending_copy: Option<PendingTextureCopy>,
}

impl DisplayLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let frame_texture_0 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_1 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_view_0 = frame_texture_0.create_view(&Default::default());
        let frame_texture_view_1 = frame_texture_1.create_view(&Default::default());

        let uniforms_buffer = CompositeVideoFrameUniforms::default().to_buffer(device);
        let pipeline = CompositeVideoFramePipeline::new(device);
        let bind_group_0 =
            Some(pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_0));
        let bind_group_1 =
            Some(pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view_1));

        let yuv_converter = YuvToRgbaConverter::new(device);

        Self {
            frame_textures: [frame_texture_0, frame_texture_1],
            frame_texture_views: [frame_texture_view_0, frame_texture_view_1],
            current_texture: 0,
            uniforms_buffer,
            pipeline,
            bind_groups: [bind_group_0, bind_group_1],
            last_recording_time: None,
            yuv_converter,
            pending_copy: None,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        segment_frames: &DecodedSegmentFrames,
        frame_size: XY<u32>,
        uniforms: CompositeVideoFrameUniforms,
    ) -> (bool, u32, u32) {
        self.pending_copy = None;

        let frame_data = segment_frames.screen_frame.data();
        let actual_width = segment_frames.screen_frame.width();
        let actual_height = segment_frames.screen_frame.height();
        let format = segment_frames.screen_frame.format();
        let current_recording_time = segment_frames.recording_time;

        let skipped = self
            .last_recording_time
            .is_some_and(|last| (last - current_recording_time).abs() < f32::EPSILON);

        if !skipped {
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

            let frame_uploaded = match format {
                PixelFormat::Rgba => {
                    let src_bytes_per_row = frame_size.x * 4;

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
                            rows_per_image: Some(frame_size.y),
                        },
                        wgpu::Extent3d {
                            width: frame_size.x,
                            height: frame_size.y,
                            depth_or_array_layers: 1,
                        },
                    );
                    true
                }
                PixelFormat::Nv12 => {
                    let screen_frame = &segment_frames.screen_frame;
                    if let (Some(y_data), Some(uv_data)) =
                        (screen_frame.y_plane(), screen_frame.uv_plane())
                    {
                        let y_stride = screen_frame.y_stride();
                        let convert_result = self.yuv_converter.convert_nv12(
                            device,
                            queue,
                            y_data,
                            uv_data,
                            frame_size.x,
                            frame_size.y,
                            y_stride,
                        );

                        match convert_result {
                            Ok(_) => {
                                if self.yuv_converter.output_texture().is_some() {
                                    self.pending_copy = Some(PendingTextureCopy {
                                        width: frame_size.x,
                                        height: frame_size.y,
                                        dst_texture_index: next_texture,
                                    });
                                    true
                                } else {
                                    tracing::debug!(
                                        width = frame_size.x,
                                        height = frame_size.y,
                                        y_stride,
                                        "NV12 conversion succeeded but output texture is None, skipping copy"
                                    );
                                    false
                                }
                            }
                            Err(e) => {
                                tracing::debug!(
                                    error = ?e,
                                    width = frame_size.x,
                                    height = frame_size.y,
                                    y_stride,
                                    "NV12 to RGBA conversion failed"
                                );
                                false
                            }
                        }
                    } else {
                        false
                    }
                }
                PixelFormat::Yuv420p => {
                    let screen_frame = &segment_frames.screen_frame;
                    if let (Some(y_data), Some(u_data), Some(v_data)) = (
                        screen_frame.y_plane(),
                        screen_frame.u_plane(),
                        screen_frame.v_plane(),
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
                            screen_frame.y_stride(),
                            screen_frame.uv_stride(),
                        )
                        .is_ok()
                        && self.yuv_converter.output_texture().is_some()
                    {
                        self.pending_copy = Some(PendingTextureCopy {
                            width: frame_size.x,
                            height: frame_size.y,
                            dst_texture_index: next_texture,
                        });
                        true
                    } else {
                        false
                    }
                }
            };

            if frame_uploaded {
                self.last_recording_time = Some(current_recording_time);
                self.current_texture = next_texture;
            }
        }

        uniforms.write_to_buffer(queue, &self.uniforms_buffer);
        (skipped, actual_width, actual_height)
    }

    pub fn copy_to_texture(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let Some(pending) = self.pending_copy.take() else {
            return;
        };

        let Some(src_texture) = self.yuv_converter.output_texture() else {
            return;
        };

        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: src_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.frame_textures[pending.dst_texture_index],
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: pending.width,
                height: pending.height,
                depth_or_array_layers: 1,
            },
        );
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(bind_group) = &self.bind_groups[self.current_texture] {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
