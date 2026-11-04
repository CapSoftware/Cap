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
            assert!(
                decoded.data().is_empty(),
                "{format:?} {width}x{height} should borrow its planes"
            );
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

fn gpu() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = crate::create_wgpu_instance_sync();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
}

fn render_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    converter: &mut YuvToRgbaConverter,
    frame: &DecodedFrame,
) -> Vec<u8> {
    let width = frame.width();
    let height = frame.height();
    match frame.format() {
        PixelFormat::Nv12 => converter
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
            .unwrap(),
        PixelFormat::Yuv420p => converter
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
            .unwrap(),
        PixelFormat::Rgba => panic!("the test only builds YUV frames"),
    };
    read_pixels(
        device,
        queue,
        converter.output_texture().unwrap(),
        width,
        height,
    )
}

#[test]
fn borrowed_planes_render_the_same_rgba_as_the_copy_path() {
    let Some((device, queue)) = gpu() else {
        eprintln!("no GPU adapter available, skipping borrowed-plane pixel parity");
        return;
    };

    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../video-decode/tests/fixtures/h264-no-reordering.mp4");
    let mut decoder = cap_video_decode::FFmpegDecoder::new(fixture, None).unwrap();
    let mut sources: Vec<frame::Video> = decoder.frames().take(4).map(Result::unwrap).collect();

    for (width, height) in [(1u32, 1u32), (3, 4), (17, 9)] {
        for format in [format::Pixel::YUV420P, format::Pixel::NV12] {
            let mut frame = frame::Video::new(format, width, height);
            for plane in 0..frame.planes() {
                for (index, byte) in frame.data_mut(plane).iter_mut().enumerate() {
                    *byte = (index * 37 + plane * 59) as u8;
                }
            }
            sources.push(frame);
        }
    }

    let mut rgba_converter = YuvToRgbaConverter::new(&device);
    for source in sources {
        let width = source.width();
        let height = source.height();
        let (format, y_stride, uv_stride) = match source.format() {
            format::Pixel::YUV420P => (
                PixelFormat::Yuv420p,
                source.stride(0) as u32,
                source.stride(1) as u32,
            ),
            format::Pixel::NV12 => (
                PixelFormat::Nv12,
                source.stride(0) as u32,
                source.stride(1) as u32,
            ),
            other => panic!("unexpected decoded format {other:?}"),
        };

        let mut plane_converter = FrameConverter::new();
        let (copied, _, _, _) = extract_yuv_planes(&source, plane_converter.plane_pool()).unwrap();
        let copied = match format {
            PixelFormat::Nv12 => DecodedFrame::new_nv12_with_arc(
                Arc::new(copied),
                width,
                height,
                y_stride,
                uv_stride,
            ),
            PixelFormat::Yuv420p => DecodedFrame::new_yuv420p_with_arc(
                Arc::new(copied),
                width,
                height,
                y_stride,
                uv_stride,
            ),
            PixelFormat::Rgba => unreachable!(),
        };

        let borrowed = CachedFrame::Raw {
            frame: source,
            number: 0,
        }
        .produce(&mut plane_converter);
        assert!(
            borrowed.frame.data().is_empty(),
            "{format:?} {width}x{height} should borrow"
        );

        let expected = render_rgba(&device, &queue, &mut rgba_converter, &copied);
        let actual = render_rgba(&device, &queue, &mut rgba_converter, &borrowed.frame);
        assert_eq!(actual, expected, "{format:?} {width}x{height}");
    }
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

#[test]
#[ignore = "performance probe: compares the 4K NV12 plane copy against borrowing"]
fn nv12_4k_plane_copy_benchmark() {
    const WIDTH: u32 = 3840;
    const HEIGHT: u32 = 2160;
    const ITERS: u32 = 60;

    let mut source = frame::Video::new(format::Pixel::NV12, WIDTH, HEIGHT);
    for plane in 0..source.planes() {
        for (index, byte) in source.data_mut(plane).iter_mut().enumerate() {
            *byte = (index * 37 + plane * 59) as u8;
        }
    }

    let y_stride = source.stride(0) as u32;
    let uv_stride = source.stride(1) as u32;
    let bytes = yuv_plane_bytes(PixelFormat::Nv12, y_stride, uv_stride, HEIGHT)
        .saturating_mul(ITERS as usize);

    let copy_start = std::time::Instant::now();
    let pool = PlanePool::new();
    for _ in 0..ITERS {
        let copied = extract_yuv_planes(&source, &pool).unwrap();
        std::hint::black_box(copied.0.len());
        pool.recycle(copied.0);
    }
    let copy = copy_start.elapsed();

    let borrow_start = std::time::Instant::now();
    for _ in 0..ITERS {
        let y = source
            .data(0)
            .get(..(y_stride as usize * HEIGHT as usize))
            .unwrap();
        let uv = source
            .data(1)
            .get(..(uv_stride as usize * HEIGHT.div_ceil(2) as usize))
            .unwrap();
        std::hint::black_box(y.len() + uv.len());
    }
    let borrow = borrow_start.elapsed();

    let mib = bytes as f64 / (1024.0 * 1024.0);
    println!(
        "4K NV12 plane copy: {:.2} ms/frame, {:.1} MiB/s; borrowed: {:.3} ms/frame, {:.1} MiB/s",
        copy.as_secs_f64() * 1000.0 / ITERS as f64,
        mib / copy.as_secs_f64(),
        borrow.as_secs_f64() * 1000.0 / ITERS as f64,
        mib / borrow.as_secs_f64(),
    );
}
