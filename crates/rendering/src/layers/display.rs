use crate::{frame_pipeline::FramePipeline, DecodedSegmentFrames};

pub struct DisplayLayer {
    // composite_resources: CompositeFrameResources,
}

impl DisplayLayer {
    pub fn render(pipeline: &mut FramePipeline, segment_frames: &DecodedSegmentFrames) {
        let constants = pipeline.state.constants;
        let uniforms = pipeline.state.uniforms;
        let frame_size = pipeline.state.constants.options.screen_size;

        constants.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &constants.screen_frame.0,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &segment_frames.screen_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(constants.options.screen_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: frame_size.x,
                height: frame_size.y,
                depth_or_array_layers: 1,
            },
        );

        pipeline.state.switch_output();

        pipeline.encoder.do_render_pass(
            pipeline.state.get_current_texture_view(),
            &constants.composite_video_frame_pipeline.render_pipeline,
            constants.composite_video_frame_pipeline.bind_group(
                &constants.device,
                &uniforms.display.to_buffer(&constants.device),
                &constants.screen_frame.1,
                pipeline.state.get_other_texture_view(),
            ),
            wgpu::LoadOp::Load,
        );
    }
}
