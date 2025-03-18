use glyphon::{Attrs, Buffer, Family, Metrics, Shaping, TextArea, TextBounds};

use crate::{frame_pipeline::FramePipeline, RenderingError};

pub struct TextLayer {}

impl TextLayer {
    pub fn render(pipeline: &mut FramePipeline) -> Result<(), RenderingError> {
        let frame_size = pipeline.state.constants.options.screen_size;

        {
            let state = &mut *pipeline.state.state;

            let mut text_buffer = Buffer::new(&mut state.font_system, Metrics::new(30.0, 42.0));

            text_buffer.set_size(
                &mut state.font_system,
                Some(frame_size.x as f32),
                Some(frame_size.y as f32),
            );
            text_buffer.set_text(&mut state.font_system, "Hello world! 👋\nThis is rendered with 🦅 glyphon 🦁\nThe text below should be partially clipped.\na b c d e f g h i j k l m n o p q r s t u v w x y z", Attrs::new().family(Family::SansSerif), Shaping::Advanced);
            text_buffer.shape_until_scroll(&mut state.font_system, false);

            state.viewport.update(
                &pipeline.state.constants.queue,
                glyphon::Resolution {
                    width: frame_size.x,
                    height: frame_size.y,
                },
            );

            state.text_renderer.prepare(
                &pipeline.state.constants.device,
                &pipeline.state.constants.queue,
                &mut state.font_system,
                &mut state.atlas,
                &state.viewport,
                [TextArea {
                    buffer: &text_buffer,
                    left: 0.0,
                    top: 0.0,
                    scale: 1.0,
                    bounds: TextBounds {
                        left: 0,
                        top: 0,
                        right: 600,
                        bottom: 160,
                    },
                    default_color: glyphon::Color::rgb(255, 255, 255),
                    custom_glyphs: &[],
                }],
                &mut state.swash_cache,
            )?
        }

        let mut render_pass =
            pipeline
                .encoder
                .encoder
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &pipeline.state.get_current_texture_view(),
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

        let state = &mut pipeline.state.state;
        state
            .text_renderer
            .render(&state.atlas, &state.viewport, &mut render_pass)?;

        Ok(())
    }
}
