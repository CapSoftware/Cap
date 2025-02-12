use futures_intrusive::channel::shared::oneshot_channel;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{get_either, ProjectUniforms, RenderVideoConstants, RenderingError};

pub struct FramePipeline<'a, 'b> {
    pub state: &'a mut FramePipelineState<'b>,
    pub encoder: &'a mut FramePipelineEncoder,
}

pub struct FramePipelineState<'a> {
    pub constants: &'a RenderVideoConstants,
    pub uniforms: &'a ProjectUniforms,
    pub textures: &'a (wgpu::Texture, wgpu::Texture),
    pub texture_views: (wgpu::TextureView, wgpu::TextureView),
    output_is_left: bool,
}

impl<'a> FramePipelineState<'a> {
    pub fn new(
        constants: &'a RenderVideoConstants,
        uniforms: &'a ProjectUniforms,
        textures: &'a (wgpu::Texture, wgpu::Texture),
    ) -> Self {
        let texture_views = (
            textures
                .0
                .create_view(&wgpu::TextureViewDescriptor::default()),
            textures
                .1
                .create_view(&wgpu::TextureViewDescriptor::default()),
        );

        Self {
            constants,
            uniforms,
            textures,
            texture_views,
            output_is_left: true,
        }
    }

    pub fn get_current_texture_view(&self) -> &wgpu::TextureView {
        get_either(
            (&self.texture_views.0, &self.texture_views.1),
            self.output_is_left,
        )
    }

    pub fn get_other_texture_view(&self) -> &wgpu::TextureView {
        get_either(
            (&self.texture_views.0, &self.texture_views.1),
            !self.output_is_left,
        )
    }

    pub fn get_current_texture(&self) -> &wgpu::Texture {
        get_either((&self.textures.1, &self.textures.0), self.output_is_left)
    }

    pub fn get_other_texture(&self) -> &wgpu::Texture {
        get_either((&self.textures.1, &self.textures.0), !self.output_is_left)
    }

    pub fn switch_output(&mut self) {
        self.output_is_left = !self.output_is_left;
    }
}

pub struct FramePipelineEncoder {
    pub encoder: wgpu::CommandEncoder,
}

impl FramePipelineEncoder {
    pub fn new(state: &FramePipelineState) -> Self {
        Self {
            encoder: state.constants.device.create_command_encoder(
                &(wgpu::CommandEncoderDescriptor {
                    label: Some("Render Encoder"),
                }),
            ),
        }
    }
    pub fn do_render_pass(
        &mut self,
        output_view: &wgpu::TextureView,
        render_pipeline: &wgpu::RenderPipeline,
        bind_group: wgpu::BindGroup,
        load_op: wgpu::LoadOp<wgpu::Color>,
    ) {
        let mut render_pass = self.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Render Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: load_op,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        render_pass.set_pipeline(render_pipeline);
        render_pass.set_bind_group(0, &bind_group, &[]);
        render_pass.draw(0..3, 0..1);
    }

    pub fn padded_bytes_per_row(&self, state: &FramePipelineState<'_>) -> u32 {
        // Calculate the aligned bytes per row
        let align = COPY_BYTES_PER_ROW_ALIGNMENT;
        let unpadded_bytes_per_row = state.uniforms.output_size.0 * 4;
        let padding = (align - (unpadded_bytes_per_row % align)) % align;
        let padded_bytes_per_row = unpadded_bytes_per_row + padding;

        // Ensure the padded_bytes_per_row is a multiple of 4 (32 bits)
        (padded_bytes_per_row + 3) & !3
    }

    pub async fn copy_output(
        self,
        state: FramePipelineState<'_>,
    ) -> Result<Vec<u8>, RenderingError> {
        let padded_bytes_per_row = self.padded_bytes_per_row(&state);
        let constants = &state.constants;

        constants
            .queue
            .submit(std::iter::once(self.encoder.finish()));

        let output_texture_size = wgpu::Extent3d {
            width: state.uniforms.output_size.0,
            height: state.uniforms.output_size.1,
            depth_or_array_layers: 1,
        };

        let output_buffer_size = (padded_bytes_per_row * state.uniforms.output_size.1) as u64;

        let output_buffer = constants.device.create_buffer(&wgpu::BufferDescriptor {
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            label: Some("Output Buffer"),
            mapped_at_creation: false,
        });

        {
            let mut encoder = constants.device.create_command_encoder(
                &(wgpu::CommandEncoderDescriptor {
                    label: Some("Copy Encoder"),
                }),
            );

            encoder.copy_texture_to_buffer(
                wgpu::ImageCopyTexture {
                    texture: state.get_current_texture(),
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::ImageCopyBuffer {
                    buffer: &output_buffer,
                    layout: wgpu::ImageDataLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_bytes_per_row),
                        rows_per_image: Some(state.uniforms.output_size.1),
                    },
                },
                output_texture_size,
            );

            constants.queue.submit(std::iter::once(encoder.finish()));
        }

        let buffer_slice = output_buffer.slice(..);
        let (tx, rx) = oneshot_channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).ok();
        });
        constants.device.poll(wgpu::Maintain::Wait);

        rx.receive()
            .await
            .ok_or(RenderingError::BufferMapWaitingFailed)??;

        let data = buffer_slice.get_mapped_range();
        let data_vec = data.to_vec();

        drop(data);
        output_buffer.unmap();

        Ok(data_vec)
    }
}
