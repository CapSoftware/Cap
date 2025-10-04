use wgpu::util::DeviceExt;

use crate::composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms};

pub struct ShadowLayer {
    frame_texture: wgpu::Texture,
    frame_texture_view: wgpu::TextureView,
    uniforms_buffer: wgpu::Buffer,
    pipeline: CompositeVideoFramePipeline,
    bind_group: Option<wgpu::BindGroup>,
    hidden: bool,
}

impl ShadowLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let frame_texture = CompositeVideoFramePipeline::create_frame_texture(device, 1, 1);
        let frame_texture_view = frame_texture.create_view(&Default::default());

        let pipeline = CompositeVideoFramePipeline::new(device);

        let uniforms_buffer = device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("ShadowLayer Uniforms Buffer"),
                contents: bytemuck::cast_slice(&[CompositeVideoFrameUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        );

        let bind_group = Some(pipeline.bind_group(device, &uniforms_buffer, &frame_texture_view));

        Self {
            frame_texture,
            frame_texture_view,
            uniforms_buffer,
            pipeline,
            bind_group,
            hidden: true,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: Option<CompositeVideoFrameUniforms>,
    ) {
        self.hidden = uniforms.is_none();

        let Some(uniforms) = uniforms else {
            return;
        };

        if self.frame_texture.width() != 1 || self.frame_texture.height() != 1 {
            self.frame_texture = CompositeVideoFramePipeline::create_frame_texture(device, 1, 1);
            self.frame_texture_view = self.frame_texture.create_view(&Default::default());

            self.bind_group = Some(self.pipeline.bind_group(
                device,
                &self.uniforms_buffer,
                &self.frame_texture_view,
            ));
        }

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
