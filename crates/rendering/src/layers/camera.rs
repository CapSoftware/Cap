use cap_project::XY;
use wgpu::util::DeviceExt;

use crate::{
    CompositeVideoFrameUniforms, DecodedFrame, composite_frame::CompositeVideoFramePipeline,
};

pub struct CameraLayer {
    frame_texture: wgpu::Texture,
    frame_texture_view: wgpu::TextureView,
    uniforms_buffer: wgpu::Buffer,
    bind_group: Option<wgpu::BindGroup>,
    pipeline: CompositeVideoFramePipeline,
    hidden: bool,
}

impl CameraLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let frame_texture = CompositeVideoFramePipeline::create_frame_texture(device, 1920, 1080);
        let frame_texture_view = frame_texture.create_view(&Default::default());

        let pipeline = CompositeVideoFramePipeline::new(device);

        let uniforms_buffer = device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CameraLayer Uniforms Buffer"),
                contents: bytemuck::cast_slice(&[CompositeVideoFrameUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        );

        let bind_group = Some(pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view));

        Self {
            frame_texture,
            frame_texture_view,
            uniforms_buffer,
            bind_group,
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

        if self.frame_texture.width() != frame_size.x || self.frame_texture.height() != frame_size.y
        {
            self.frame_texture = CompositeVideoFramePipeline::create_frame_texture(
                device,
                frame_size.x,
                frame_size.y,
            );
            self.frame_texture_view = self.frame_texture.create_view(&Default::default());

            self.bind_group = Some(self.pipeline.bind_group(
                device,
                &self.uniforms_buffer,
                &self.frame_texture_view,
            ));
        }

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.frame_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            camera_frame.data(),
            wgpu::TexelCopyBufferLayout {
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
        if !self.hidden
            && let Some(bind_group) = &self.bind_group
        {
            pass.set_pipeline(&self.pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}
