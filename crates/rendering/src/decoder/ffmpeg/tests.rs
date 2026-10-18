use super::*;
use crate::yuv_converter::{YuvConversionError, YuvConverterPipelines, YuvToRgbaConverter};

#[test]
fn odd_yuv_frames_preserve_every_chroma_row() {
    for format in [format::Pixel::YUV420P, format::Pixel::NV12] {
        for (width, height) in [(1, 1), (3, 4), (4, 3), (17, 9), (18, 10)] {
            let mut source = frame::Video::new(format, width, height);
            for plane in 0..source.planes() {
                for (index, byte) in source.data_mut(plane).iter_mut().enumerate() {
                    *byte = (index * 37 + plane * 59) as u8;
                }
            }
            let expected: Vec<_> = (0..source.planes())
                .map(|plane| source.data(plane).to_vec())
                .collect();
            let expected_bytes: usize = expected.iter().map(Vec::len).sum();
            let mut cached = CachedFrame::Raw {
                frame: source,
                number: 7,
            };
            let raw_bytes = cached.estimated_bytes();
            let output = cached.produce(&mut FrameConverter::new());
            assert_eq!(output.number, 7);
            let decoded = output.frame;
            assert_eq!(decoded.byte_len(), expected_bytes);
            assert_eq!(raw_bytes, expected_bytes);
            assert_eq!(cached.estimated_bytes(), expected_bytes);
            assert_eq!(decoded.y_plane().unwrap(), expected[0]);
            for (plane, data) in match format {
                format::Pixel::YUV420P => vec![
                    (1, decoded.u_plane().unwrap()),
                    (2, decoded.v_plane().unwrap()),
                ],
                _ => vec![(1, decoded.uv_plane().unwrap())],
            } {
                assert_eq!(
                    data, expected[plane],
                    "{format:?} {width}x{height}, plane {plane}"
                );
            }
        }
    }
}

fn read_pixels(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let stride = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
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
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
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

#[test]
fn odd_yuv_gpu_conversion_matches_even_frame_edges() {
    let instance = crate::create_wgpu_instance_sync();
    let Ok(adapter) =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
    else {
        eprintln!("no GPU adapter available, skipping YUV edge regression");
        return;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let pipelines = Arc::new(YuvConverterPipelines::new(&device));

    for planar in [true, false] {
        for (width, height) in [(1_u32, 1_u32), (3, 4), (4, 3), (17, 9), (18, 10)] {
            let even_width = width.div_ceil(2) * 2;
            let even_height = height.div_ceil(2) * 2;
            let y_stride = even_width + 8;
            let uv_stride = even_width / 2 + 8;
            let y = vec![128; (y_stride * even_height) as usize];
            let u: Vec<_> = (0..uv_stride * even_height / 2)
                .map(|index| (index * 37 + 64) as u8)
                .collect();
            let v: Vec<_> = (0..uv_stride * even_height / 2)
                .map(|index| (index * 59 + 192) as u8)
                .collect();
            let uv: Vec<_> = u.iter().zip(&v).flat_map(|(&u, &v)| [u, v]).collect();
            let mut expected = Vec::new();

            for (w, h, batched) in [
                (even_width, even_height, false),
                (width, height, false),
                (width, height, true),
            ] {
                let mut converter =
                    YuvToRgbaConverter::new_with_shared_pipelines(&device, Arc::clone(&pipelines));
                let mut encoder = device.create_command_encoder(&Default::default());
                match (planar, batched) {
                    (true, false) => converter
                        .convert_yuv420p(&device, &queue, &y, &u, &v, w, h, y_stride, uv_stride),
                    (true, true) => converter.convert_yuv420p_to_encoder(
                        &device,
                        &queue,
                        &mut encoder,
                        &y,
                        &u,
                        &v,
                        w,
                        h,
                        y_stride,
                        uv_stride,
                    ),
                    (false, false) => converter.convert_nv12(
                        &device,
                        &queue,
                        &y,
                        &uv,
                        w,
                        h,
                        y_stride,
                        uv_stride * 2,
                    ),
                    (false, true) => converter.convert_nv12_to_encoder(
                        &device,
                        &queue,
                        &mut encoder,
                        &y,
                        &uv,
                        w,
                        h,
                        y_stride,
                        uv_stride * 2,
                    ),
                }
                .unwrap();
                queue.submit([encoder.finish()]);
                let actual = read_pixels(
                    &device,
                    &queue,
                    converter.output_texture().unwrap(),
                    width,
                    height,
                );
                if expected.is_empty() {
                    expected = actual;
                } else {
                    assert_eq!(
                        actual, expected,
                        "{width}x{height}, planar={planar}, batched={batched}"
                    );
                }
            }
        }
    }

    for batched in [false, true] {
        for uv_stride in [3, 4] {
            let mut encoder = device.create_command_encoder(&Default::default());
            let mut converter =
                YuvToRgbaConverter::new_with_shared_pipelines(&device, Arc::clone(&pipelines));
            let result = if batched {
                converter.convert_nv12_to_encoder(
                    &device,
                    &queue,
                    &mut encoder,
                    &[128; 9],
                    &[128; 4],
                    3,
                    3,
                    3,
                    uv_stride,
                )
            } else {
                converter.convert_nv12(&device, &queue, &[128; 9], &[128; 4], 3, 3, 3, uv_stride)
            };
            if uv_stride == 3 {
                assert!(matches!(
                    result,
                    Err(YuvConversionError::PlaneStrideTooSmall {
                        plane: "UV",
                        expected: 4,
                        actual: 3,
                    })
                ));
            } else {
                assert!(matches!(
                    result,
                    Err(YuvConversionError::PlaneSizeMismatch {
                        plane: "UV",
                        expected: 8,
                        actual: 4,
                    })
                ));
            }
        }
    }
}
