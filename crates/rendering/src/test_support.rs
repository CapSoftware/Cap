use crate::{
    DecodedFrame, PixelFormat, composite_frame::CompositeVideoFramePipeline,
    yuv_converter::YuvToRgbaConverter,
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum TestFormat {
    Nv12,
    Yuv420p,
}

pub(crate) fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = crate::create_wgpu_instance_sync();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
}

pub(crate) fn read_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let stride = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("RGBA test readback"),
        size: u64::from(stride * height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(std::iter::once(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            sender.send(result).unwrap();
        });
    device.poll(wgpu::PollType::Wait).unwrap();
    receiver.recv().unwrap().unwrap();
    let pixels = buffer
        .slice(..)
        .get_mapped_range()
        .chunks(stride as usize)
        .flat_map(|row| row[..width as usize * 4].iter().copied())
        .collect();
    buffer.unmap();
    pixels
}

fn padded_strides(width: u32) -> (u32, u32) {
    (
        width.next_multiple_of(16).max(16),
        (width.div_ceil(2) * 2).next_multiple_of(16).max(16),
    )
}

fn fill_plane(plane: &mut [u8], width: u32, height: u32, stride: u32, seed: u32) {
    for (row_index, row) in plane
        .chunks_mut(stride as usize)
        .take(height as usize)
        .enumerate()
    {
        for (x, value) in row[..width as usize].iter_mut().enumerate() {
            *value = ((x * 37 + row_index * 59 + seed as usize * 97 + 16) % 220) as u8 + 16;
        }
    }
}

fn fill_interleaved_chroma(plane: &mut [u8], width: u32, height: u32, stride: u32, seed: u32) {
    for (row_index, row) in plane
        .chunks_mut(stride as usize)
        .take(height as usize)
        .enumerate()
    {
        for (x, pair) in row[..width as usize * 2].chunks_exact_mut(2).enumerate() {
            pair[0] = ((x * 41 + row_index * 61 + seed as usize * 101 + 20) % 200) as u8 + 20;
            pair[1] = ((x * 43 + row_index * 67 + seed as usize * 103 + 24) % 200) as u8 + 20;
        }
    }
}

pub(crate) fn test_frame(format: TestFormat, width: u32, height: u32, seed: u32) -> DecodedFrame {
    let (y_stride, uv_stride) = padded_strides(width);
    let half_width = width.div_ceil(2);
    let half_height = height.div_ceil(2);
    let y_len = (y_stride * height) as usize;
    let chroma_len = (uv_stride * half_height) as usize;

    match format {
        TestFormat::Nv12 => {
            let mut data = vec![0u8; y_len + chroma_len];
            fill_plane(&mut data[..y_len], width, height, y_stride, seed);
            fill_interleaved_chroma(&mut data[y_len..], half_width, half_height, uv_stride, seed);
            DecodedFrame::new_nv12(data, width, height, y_stride, uv_stride)
        }
        TestFormat::Yuv420p => {
            let mut data = vec![0u8; y_len + chroma_len * 2];
            fill_plane(&mut data[..y_len], width, height, y_stride, seed);
            fill_plane(
                &mut data[y_len..y_len + chroma_len],
                half_width,
                half_height,
                uv_stride,
                seed,
            );
            fill_plane(
                &mut data[y_len + chroma_len..],
                half_width,
                half_height,
                uv_stride,
                seed.wrapping_add(1),
            );
            DecodedFrame::new_yuv420p(data, width, height, y_stride, uv_stride)
        }
    }
}

pub(crate) fn reference_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    converter: &mut YuvToRgbaConverter,
    frame: &DecodedFrame,
) -> Vec<u8> {
    let width = frame.width();
    let height = frame.height();
    converter.set_matrix(frame.matrix());
    converter
        .prepare_for_dimensions(device, width, height)
        .unwrap();

    match frame.format() {
        PixelFormat::Nv12 => {
            converter
                .convert_nv12(
                    device,
                    queue,
                    frame.y_plane().unwrap(),
                    frame.uv_plane().unwrap(),
                    width,
                    height,
                    frame.y_stride(),
                    frame.uv_stride(),
                )
                .unwrap();
        }
        PixelFormat::Yuv420p => {
            converter
                .convert_yuv420p(
                    device,
                    queue,
                    frame.y_plane().unwrap(),
                    frame.u_plane().unwrap(),
                    frame.v_plane().unwrap(),
                    width,
                    height,
                    frame.y_stride(),
                    frame.uv_stride(),
                )
                .unwrap();
        }
        PixelFormat::Rgba => unreachable!("reference only covers YUV frames"),
    }

    let target = CompositeVideoFramePipeline::create_frame_texture(device, width, height);
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_texture(
        converter.output_texture().unwrap().as_image_copy(),
        target.as_image_copy(),
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(std::iter::once(encoder.finish()));

    read_rgba(device, queue, &target, width, height)
}
