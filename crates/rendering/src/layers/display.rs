use cap_project::XY;

use crate::{
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    frame_pipeline::FramePipeline,
    DecodedSegmentFrames, ProjectUniforms, RenderOptions,
};

pub struct DisplayLayer {
    frame_texture: wgpu::Texture,
    frame_texture_view: wgpu::TextureView,
    uniforms_buffer: wgpu::Buffer,
    pipeline: CompositeVideoFramePipeline,
    bind_group: Option<(wgpu::BindGroup, wgpu::TextureView)>,
}

impl DisplayLayer {
    pub fn new(device: &wgpu::Device, frame_size: XY<u32>) -> Self {
        let frame_texture = device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: frame_size.x,
                    height: frame_size.y,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_DST,
                label: Some("Screen Frame texture"),
                view_formats: &[],
            }),
        );

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
        pipeline: &mut FramePipeline,
        segment_frames: &DecodedSegmentFrames,
        options: &RenderOptions,
        uniforms: &ProjectUniforms,
    ) {
        // pipeline.state.switch_output();

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
                bytes_per_row: Some(options.screen_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: options.screen_size.x,
                height: options.screen_size.y,
                depth_or_array_layers: 1,
            },
        );

        queue.write_buffer(
            &self.uniforms_buffer,
            0,
            bytemuck::cast_slice(&[uniforms.display]),
        );

        self.bind_group = Some((
            self.pipeline.bind_group(
                &device,
                &uniforms.display.to_buffer(&device),
                &self.frame_texture_view,
                pipeline.state.get_other_texture_view(),
            ),
            pipeline
                .state
                .get_current_texture()
                .create_view(&Default::default()),
        ));
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
