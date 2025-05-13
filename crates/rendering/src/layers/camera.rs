use cap_project::XY;
use wgpu::util::DeviceExt;

use crate::{
    composite_frame::CompositeVideoFramePipeline, frame_pipeline::FramePipeline,
    CompositeVideoFrameUniforms, DecodedFrame,
};

pub struct CameraLayer {
    uniforms_buffer: wgpu::Buffer,
    bind_group: Option<(wgpu::BindGroup, wgpu::TextureView)>,
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
        pipeline: &mut FramePipeline,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: CompositeVideoFrameUniforms,
        camera_size: XY<u32>,
        camera_frame: &DecodedFrame,
        (texture, texture_view): (&wgpu::Texture, &wgpu::TextureView),
    ) {
        pipeline.state.switch_output();

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            camera_frame,
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

        self.bind_group = Some((
            self.pipeline.bind_group(
                &device,
                &self.uniforms_buffer,
                &texture_view,
                pipeline.state.get_other_texture_view(),
            ),
            pipeline
                .state
                .get_current_texture()
                .create_view(&Default::default()),
        ))
    }

    pub fn render(&self, pipeline: &mut FramePipeline) {
        if let Some((bind_group, target_texture)) = &self.bind_group {
            pipeline.encoder.do_render_pass(
                target_texture,
                &self.pipeline.render_pipeline,
                bind_group,
                wgpu::LoadOp::Load,
            );
        }
    }
}
