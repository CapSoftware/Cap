pub fn read_buffer_to_vec(
    buffer: &wgpu::Buffer,
    device: &wgpu::Device,
) -> Result<Vec<u8>, wgpu::PollError> {
    let buffer_slice = buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });
    device.poll(wgpu::PollType::Wait)?;
    rx.recv().unwrap().unwrap();

    let data = buffer_slice.get_mapped_range();
    Ok(data.to_vec())
}

#[allow(dead_code)]
pub fn copy_texture_to_buffer_command(
    device: &wgpu::Device,
    texture: &wgpu::Texture,
    encoder: &mut wgpu::CommandEncoder,
) -> wgpu::Buffer {
    let bytes_per_px = texture.format().block_copy_size(None).unwrap();
    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Output Buffer"),
        size: (texture.width() * texture.height() * bytes_per_px) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let bytes_per_row = texture.width() * bytes_per_px;

    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &output_buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(texture.height()),
            },
        },
        wgpu::Extent3d {
            width: texture.width(),
            height: texture.height(),
            depth_or_array_layers: 1,
        },
    );

    output_buffer
}
