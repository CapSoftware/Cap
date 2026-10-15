#![cfg(target_os = "macos")]

use cap_rendering::{create_wgpu_instance_sync, yuv_converter::YuvToRgbaConverter};
use cidre::{arc, cf, cv};

const SIZE: u32 = 16;
const ROW_BYTES: u32 = 256;
const FRAME_BYTES: u64 = (ROW_BYTES * SIZE) as u64;

fn pool() -> arc::R<cv::PixelBufPool> {
    let format = cv::PixelFormat::_420V.to_cf_number();
    let dimension = cf::Number::from_usize(SIZE as usize);
    let surface = cf::Dictionary::new();
    let keys: [&cf::Type; 5] = [
        cv::pixel_buffer::keys::pixel_format().as_ref(),
        cv::pixel_buffer::keys::width().as_ref(),
        cv::pixel_buffer::keys::height().as_ref(),
        cv::pixel_buffer::keys::io_surf_props().as_ref(),
        cv::pixel_buffer::keys::metal_compatibility().as_ref(),
    ];
    let values: [&cf::Type; 5] = [
        format.as_ref(),
        dimension.as_ref(),
        dimension.as_ref(),
        surface.as_ref(),
        cf::Boolean::value_true().as_ref(),
    ];
    let attributes = cf::Dictionary::with_keys_values(&keys, &values).unwrap();
    cv::PixelBufPool::new(None, Some(attributes.as_ref())).unwrap()
}

fn fill(buffer: &mut cv::PixelBuf, luma: u8) {
    unsafe {
        buffer
            .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()
            .unwrap();
        for plane in 0..2 {
            let length = buffer.plane_bytes_per_row(plane) * buffer.plane_height(plane);
            std::ptr::write_bytes(
                buffer.plane_base_address(plane) as *mut u8,
                if plane == 0 { luma } else { 128 },
                length,
            );
        }
        buffer.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
    }
}

#[test]
fn conversions_keep_recycled_pixel_buffers_until_submission() {
    let instance = create_wgpu_instance_sync();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .unwrap();
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let mut converter = YuvToRgbaConverter::new(&device);
    let pool = pool();
    let lumas = [32, 80, 128, 200];
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("IOSurface lifetime readback"),
        size: FRAME_BYTES * lumas.len() as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    for (index, luma) in lumas.into_iter().enumerate() {
        let mut source = pool.pixel_buf().unwrap();
        fill(&mut source, luma);
        converter
            .convert_nv12_from_iosurface_to_encoder(&device, &mut encoder, &source)
            .unwrap();
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: converter.output_texture().unwrap(),
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: index as u64 * FRAME_BYTES,
                    bytes_per_row: Some(ROW_BYTES),
                    rows_per_image: Some(SIZE),
                },
            },
            wgpu::Extent3d {
                width: SIZE,
                height: SIZE,
                depth_or_array_layers: 1,
            },
        );
    }
    let mut next = pool.pixel_buf().unwrap();
    fill(&mut next, 235);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    output
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            sender.send(result).unwrap();
        });
    device.poll(wgpu::PollType::Wait).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = output.slice(..).get_mapped_range();
    for (index, luma) in lumas.into_iter().enumerate() {
        let expected = (f32::from(luma) - 16.0) * 255.0 / 219.0;
        for row in 0..SIZE as usize {
            let start = index * FRAME_BYTES as usize + row * ROW_BYTES as usize;
            for pixel in bytes[start..start + SIZE as usize * 4].chunks_exact(4) {
                assert!(
                    pixel[..3]
                        .iter()
                        .all(|&channel| (f32::from(channel) - expected).abs() < 3.0),
                    "source {index} luma {luma}: got {pixel:?}, expected {expected}"
                );
                assert_eq!(pixel[3], 255);
            }
        }
    }
}
