use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{ProjectUniforms, RenderSession, RenderingError};

#[derive(Clone)]
pub struct RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub padded_bytes_per_row: u32,
}

pub fn padded_bytes_per_row(output_size: (u32, u32)) -> u32 {
    let align = COPY_BYTES_PER_ROW_ALIGNMENT;
    let unpadded_bytes_per_row = output_size.0 * 4;
    let padding = (align - (unpadded_bytes_per_row % align)) % align;
    let padded_bytes_per_row = unpadded_bytes_per_row + padding;

    (padded_bytes_per_row + 3) & !3
}

pub struct PendingReadback {
    pub width: u32,
    pub height: u32,
    pub padded_bytes_per_row: u32,
    pub receiver: tokio::sync::oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
}

pub fn submit_frame_for_readback(
    session: &mut RenderSession,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    uniforms: &ProjectUniforms,
    encoder: wgpu::CommandEncoder,
) -> PendingReadback {
    let padded_bytes_per_row = padded_bytes_per_row(uniforms.output_size);

    queue.submit(std::iter::once(encoder.finish()));

    let output_texture_size = wgpu::Extent3d {
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
        depth_or_array_layers: 1,
    };

    let output_buffer_size = (padded_bytes_per_row * uniforms.output_size.1) as u64;
    session.ensure_readback_buffers(device, output_buffer_size);
    let output_buffer = session.current_readback_buffer();

    let mut copy_encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Copy Encoder"),
        }),
    );

    copy_encoder.copy_texture_to_buffer(
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

    queue.submit(std::iter::once(copy_encoder.finish()));

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = tokio::sync::oneshot::channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });

    session.swap_readback_buffers();

    PendingReadback {
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
        padded_bytes_per_row,
        receiver: rx,
    }
}

pub async fn collect_readback(
    session: &RenderSession,
    device: &wgpu::Device,
    pending: PendingReadback,
) -> Result<RenderedFrame, RenderingError> {
    device.poll(wgpu::PollType::Wait)?;

    pending
        .receiver
        .await
        .map_err(|_| RenderingError::BufferMapWaitingFailed)??;

    let output_buffer = session.previous_readback_buffer();
    let buffer_slice = output_buffer.slice(..);
    let data = buffer_slice.get_mapped_range();
    let data_vec = data.to_vec();

    drop(data);
    output_buffer.unmap();

    Ok(RenderedFrame {
        data: data_vec,
        padded_bytes_per_row: pending.padded_bytes_per_row,
        width: pending.width,
        height: pending.height,
    })
}

pub async fn finish_encoder(
    session: &mut RenderSession,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    uniforms: &ProjectUniforms,
    encoder: wgpu::CommandEncoder,
) -> Result<RenderedFrame, RenderingError> {
    let pending = submit_frame_for_readback(session, device, queue, uniforms, encoder);
    collect_readback(session, device, pending).await
}
