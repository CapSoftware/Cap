use cap_project::XY;

use crate::{frame_pipeline::FramePipeline, CompositeVideoFrameUniforms, DecodedFrame};

pub struct CameraLayer;

impl CameraLayer {
    pub fn render(
        pipeline: &mut FramePipeline,
        camera_size: XY<u32>,
        camera_frame: &DecodedFrame,
        uniforms: &CompositeVideoFrameUniforms,
        (texture, texture_view): (&wgpu::Texture, &wgpu::TextureView),
    ) {
        let constants = pipeline.state.constants;

        constants.queue.write_texture(
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

        pipeline.state.switch_output();

        pipeline.encoder.do_render_pass(
            pipeline.state.get_current_texture_view(),
            &constants.composite_video_frame_pipeline.render_pipeline,
            constants.composite_video_frame_pipeline.bind_group(
                &constants.device,
                &uniforms.to_buffer(&constants.device),
                &texture_view,
                pipeline.state.get_other_texture_view(),
            ),
            wgpu::LoadOp::Load,
            0..4,
        );
    }
}
