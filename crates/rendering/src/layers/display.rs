use cap_project::XY;

use crate::{
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    DecodedSegmentFrames,
};

pub struct DisplayLayer {
    frame_texture: wgpu::Texture,
    frame_texture_view: wgpu::TextureView,
    uniforms_buffer: wgpu::Buffer,
    pipeline: CompositeVideoFramePipeline,
    bind_group: Option<wgpu::BindGroup>,
}

impl DisplayLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let frame_texture = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        Self {
            frame_texture_view: frame_texture.create_view(&Default::default()),
            frame_texture,
            uniforms_buffer: CompositeVideoFrameUniforms::default().to_buffer(device),
            pipeline: CompositeVideoFramePipeline::new(device),
            bind_group: None,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        segment_frames: &DecodedSegmentFrames,
        frame_size: XY<u32>,
        uniforms: CompositeVideoFrameUniforms,
    ) {
        if self.frame_texture.width() != frame_size.x || self.frame_texture.height() != frame_size.y
        {
            self.frame_texture = CompositeVideoFramePipeline::create_frame_texture(
                device,
                frame_size.x,
                frame_size.y,
            );
            self.frame_texture_view = self.frame_texture.create_view(&Default::default());

            self.bind_group = Some(self.pipeline.bind_group(
                &device,
                &self.uniforms_buffer,
                &self.frame_texture_view,
            ));
        }

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &self.frame_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &segment_frames.screen_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(frame_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: frame_size.x,
                height: frame_size.y,
                depth_or_array_layers: 1,
            },
        );

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(bind_group) = &self.bind_group {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
