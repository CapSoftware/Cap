use wgpu::util::DeviceExt;

pub fn create_input_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<wgpu::Texture, String> {
    if width == 0 {
        return Err("YUYV texture width must be non-zero".to_string());
    }
    if height == 0 {
        return Err("YUYV texture height must be non-zero".to_string());
    }
    if !width.is_multiple_of(2) {
        return Err(format!(
            "YUYV texture width must be even (got {width}), as YUYV encodes pairs of pixels"
        ));
    }
    let expected_len = (width as usize) * (height as usize) * 2;
    let actual_len = data.len();
    if actual_len != expected_len {
        return Err(format!(
            "YUYV data length mismatch: expected {expected_len} bytes ({width}x{height}x2), got {actual_len} bytes"
        ));
    }

    Ok(device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("YUYV Texture"),
            size: wgpu::Extent3d {
                width: width / 2,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::MipMajor,
        data,
    ))
}
