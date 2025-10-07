use futures_intrusive::channel::shared::oneshot_channel;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{ProjectUniforms, RenderSession, RenderingError};

// pub struct FramePipelineState<'a> {
//     pub constants: &'a RenderVideoConstants,
//     pub uniforms: &'a ProjectUniforms,
//     pub texture: &'a wgpu::Texture,
//     pub texture_view: wgpu::TextureView,
// }

// impl<'a> FramePipelineState<'a> {
//     pub fn new(
//         constants: &'a RenderVideoConstants,
//         uniforms: &'a ProjectUniforms,
//         texture: &'a wgpu::Texture,
//     ) -> Self {
//         let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

//         Self {
//             constants,
//             uniforms,
//             texture,
//             texture_view,
//         }
//     }
// }

// pub struct FramePipelineEncoder {
//     pub encoder: wgpu::CommandEncoder,
// }

#[derive(Clone)]
pub struct RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub padded_bytes_per_row: u32,
}

// impl FramePipelineEncoder {
//     pub fn new(state: &FramePipelineState) -> Self {
//         Self {
//             encoder: state.constants.device.create_command_encoder(
//                 &(wgpu::CommandEncoderDescriptor {
//                     label: Some("Render Encoder"),
//                 }),
//             ),
//         }
//     }
// }

pub fn padded_bytes_per_row(output_size: (u32, u32)) -> u32 {
    // Calculate the aligned bytes per row
    let align = COPY_BYTES_PER_ROW_ALIGNMENT;
    let unpadded_bytes_per_row = output_size.0 * 4;
    let padding = (align - (unpadded_bytes_per_row % align)) % align;
    let padded_bytes_per_row = unpadded_bytes_per_row + padding;

    // Ensure the padded_bytes_per_row is a multiple of 4 (32 bits)
    (padded_bytes_per_row + 3) & !3
}

pub async fn finish_encoder(
    session: &mut RenderSession,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    uniforms: &ProjectUniforms,
    encoder: wgpu::CommandEncoder,
) -> Result<RenderedFrame, RenderingError> {
    let padded_bytes_per_row = padded_bytes_per_row(uniforms.output_size);

    queue.submit(std::iter::once(encoder.finish()));

    let output_texture_size = wgpu::Extent3d {
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
        depth_or_array_layers: 1,
    };

    let output_buffer_size = (padded_bytes_per_row * uniforms.output_size.1) as u64;
    session.ensure_readback_buffer(device, output_buffer_size);
    let output_buffer = session.readback_buffer();

    let mut encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Copy Encoder"),
        }),
    );

    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: session.current_texture(),
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: output_buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(uniforms.output_size.1),
            },
        },
        output_texture_size,
    );

    queue.submit(std::iter::once(encoder.finish()));

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = oneshot_channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).ok();
    });
    device.poll(wgpu::PollType::Wait)?;

    rx.receive()
        .await
        .ok_or(RenderingError::BufferMapWaitingFailed)??;

    let data = buffer_slice.get_mapped_range();
    let data_vec = data.to_vec();

    drop(data);
    output_buffer.unmap();

    Ok(RenderedFrame {
        data: data_vec,
        padded_bytes_per_row,
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
    })
}
