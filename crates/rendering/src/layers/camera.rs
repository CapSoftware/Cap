use cap_project::XY;
use wgpu::util::DeviceExt;

use crate::{
    CompositeVideoFrameUniforms, DecodedFrame, PixelFormat,
    composite_frame::CompositeVideoFramePipeline, yuv_converter::YuvToRgbaConverter,
};

pub struct CameraLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    pipeline: CompositeVideoFramePipeline,
    hidden: bool,
    last_frame_ptr: usize,
    yuv_converter: YuvToRgbaConverter,
}

impl CameraLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let frame_texture_0 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_1 = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_view_0 = frame_texture_0.create_view(&Default::default());
        let frame_texture_view_1 = frame_texture_1.create_view(&Default::default());

        let pipeline = CompositeVideoFramePipeline::new(device);

        let uniforms_buffer = device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CameraLayer Uniforms Buffer"),
                contents: bytemuck::cast_slice(&[CompositeVideoFrameUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        );

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
            bind_groups: [bind_group_0, bind_group_1],
            pipeline,
            hidden: false,
            last_frame_ptr: 0,
            yuv_converter,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        data: Option<(CompositeVideoFrameUniforms, XY<u32>, &DecodedFrame)>,
    ) {
        self.hidden = data.is_none();

        let Some((uniforms, frame_size, camera_frame)) = data else {
            return;
        };

        let frame_data = camera_frame.data();
        let frame_ptr = frame_data.as_ptr() as usize;
        let format = camera_frame.format();

        if frame_ptr != self.last_frame_ptr {
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
                }
                PixelFormat::Nv12 => {
                    if let (Some(y_data), Some(uv_data)) =
                        (camera_frame.y_plane(), camera_frame.uv_plane())
                    {
                        if self
                            .yuv_converter
                            .convert_nv12(
                                device,
                                queue,
                                y_data,
                                uv_data,
                                frame_size.x,
                                frame_size.y,
                                camera_frame.y_stride(),
                            )
                            .is_ok()
                        {
                            self.copy_from_yuv_output(device, queue, next_texture, frame_size);
                        }
                    }
                }
                PixelFormat::Yuv420p => {
                    if let (Some(y_data), Some(u_data), Some(v_data)) = (
                        camera_frame.y_plane(),
                        camera_frame.u_plane(),
                        camera_frame.v_plane(),
                    ) {
                        if self
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
            }

            self.last_frame_ptr = frame_ptr;
            self.current_texture = next_texture;
        }

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));
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

            let _ = queue.submit(std::iter::once(encoder.finish()));
        }
    }

    pub fn copy_to_texture(&mut self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.hidden
            && let Some(bind_group) = &self.bind_groups[self.current_texture]
        {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
