use cap_project::XY;

use crate::{
    DecodedSegmentFrames,
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
};

pub struct DisplayLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    pipeline: CompositeVideoFramePipeline,
    bind_groups: [Option<wgpu::BindGroup>; 2],
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

        Self {
            frame_textures: [frame_texture_0, frame_texture_1],
            frame_texture_views: [frame_texture_view_0, frame_texture_view_1],
            current_texture: 0,
            uniforms_buffer,
            pipeline,
            bind_groups: [bind_group_0, bind_group_1],
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
        let next_texture = 1 - self.current_texture;

        if self.frame_textures[next_texture].width() != frame_size.x
            || self.frame_textures[next_texture].height() != frame_size.y
        {
            self.frame_textures[next_texture] = CompositeVideoFramePipeline::create_frame_texture(
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

        let frame_data = segment_frames.screen_frame.data();
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

        uniforms.write_to_buffer(queue, &self.uniforms_buffer);

        self.current_texture = next_texture;
    }

    pub fn copy_to_texture(&mut self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(bind_group) = &self.bind_groups[self.current_texture] {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
