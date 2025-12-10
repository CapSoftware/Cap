use cap_project::XY;
use wgpu::util::DeviceExt;

use crate::{
    CompositeVideoFrameUniforms, DecodedFrame, composite_frame::CompositeVideoFramePipeline,
};

pub struct CameraLayer {
    frame_textures: [wgpu::Texture; 2],
    frame_texture_views: [wgpu::TextureView; 2],
    current_texture: usize,
    uniforms_buffer: wgpu::Buffer,
    bind_groups: [Option<wgpu::BindGroup>; 2],
    pipeline: CompositeVideoFramePipeline,
    hidden: bool,
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

        Self {
            frame_textures: [frame_texture_0, frame_texture_1],
            frame_texture_views: [frame_texture_view_0, frame_texture_view_1],
            current_texture: 0,
            uniforms_buffer,
            bind_groups: [bind_group_0, bind_group_1],
            pipeline,
            hidden: false,
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

        let frame_data = camera_frame.data();
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

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        self.current_texture = next_texture;
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
