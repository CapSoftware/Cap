use crate::{
    frame_output::{FramePipelineEncoder, FramePipelineState},
    DecodedSegmentFrames,
};

pub struct DisplayLayer<'a, 'b: 'a> {
    pub pipeline: &'a mut FramePipelineState<'b>,
    pub encoder: &'a mut FramePipelineEncoder,
}

impl<'a, 'b> DisplayLayer<'a, 'b> {
    pub fn new(
        pipeline: &'a mut FramePipelineState<'b>,
        encoder: &'a mut FramePipelineEncoder,
    ) -> Self {
        Self { pipeline, encoder }
    }

    pub fn render(&mut self, segment_frames: &DecodedSegmentFrames) {
        let constants = self.pipeline.constants;
        let uniforms = self.pipeline.uniforms;
        let frame_size = self.pipeline.constants.options.screen_size;

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

        self.encoder.do_render_pass(
            self.pipeline.get_current_texture_view(),
            &constants.composite_video_frame_pipeline.render_pipeline,
            constants.composite_video_frame_pipeline.bind_group(
                &constants.device,
                &uniforms.display.to_buffer(&constants.device),
                &constants.screen_frame.1,
                self.pipeline.get_other_texture_view(),
            ),
            wgpu::LoadOp::Load,
        );

        self.pipeline.output_is_left = !self.pipeline.output_is_left;
    }
}
