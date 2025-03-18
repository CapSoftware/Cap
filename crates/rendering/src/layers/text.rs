use glyphon::TextRenderer;

use crate::frame_pipeline::FramePipeline;

pub struct TextLayer {}

impl TextLayer {
    pub fn render(pipeline: &mut FramePipeline, text_renderer: &TextRenderer) {
        let mut render_pass =
            pipeline
                .encoder
                .encoder
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Render Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &pipeline.state.get_other_texture_view(),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

        // TODO
        // text_renderer
        //     .render(&atlas, &constants.viewport, &mut render_pass)
        //     .unwrap(); // TODO: Error handling
    }
}
