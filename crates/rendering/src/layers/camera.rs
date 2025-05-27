use cap_project::XY;
use wgpu::util::DeviceExt;

use crate::{
    composite_frame::CompositeVideoFramePipeline, CompositeVideoFrameUniforms, DecodedFrame,
};

pub struct CameraLayer {
    uniforms_buffer: wgpu::Buffer,
    bind_group: Option<wgpu::BindGroup>,
    pipeline: CompositeVideoFramePipeline,
}

impl CameraLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            uniforms_buffer: device.create_buffer_init(
                &(wgpu::util::BufferInitDescriptor {
                    label: Some("CameraLayer Uniforms Buffer"),
                    contents: bytemuck::cast_slice(&[CompositeVideoFrameUniforms::default()]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                }),
            ),
            bind_group: None,
            pipeline: CompositeVideoFramePipeline::new(device),
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: CompositeVideoFrameUniforms,
        camera_size: XY<u32>,
        camera_frame: &DecodedFrame,
        remove_background: bool,
        remover: Option<&crate::BackgroundRemover>,
        (texture, texture_view): (&wgpu::Texture, &wgpu::TextureView),
    ) {
        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let frame_data: Vec<u8> = if remove_background {
            if let Some(remover) = remover {
                remover
                    .remove_background(camera_frame.as_ref(), camera_size.x, camera_size.y)
                    .unwrap_or_else(|_| camera_frame.as_ref().clone())
            } else {
                camera_frame.as_ref().clone()
            }
        } else {
            camera_frame.as_ref().clone()
        };

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &frame_data,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(camera_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: camera_size.x,
                height: camera_size.y,
                depth_or_array_layers: 1,
            },
        );

        self.bind_group = Some(self.pipeline.bind_group(
            &device,
            &self.uniforms_buffer,
            &texture_view,
        ))
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(bind_group) = &self.bind_group {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
