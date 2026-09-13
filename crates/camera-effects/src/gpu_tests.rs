use super::*;

async fn read_output(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
) -> Vec<u8> {
    let stride = (texture.width() * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(stride) * u64::from(texture.height()),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
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
                rows_per_image: Some(texture.height()),
            },
        },
        texture.size(),
    );
    queue.submit([encoder.finish()]);
    let (tx, rx) = tokio::sync::oneshot::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
    device.poll(wgpu::PollType::Wait).unwrap();
    rx.await.unwrap().unwrap();
    let mapped = buffer.slice(..).get_mapped_range();
    mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..texture.width() as usize * 4].iter().copied())
        .collect()
}

#[tokio::test]
#[ignore = "requires a GPU and ONNX Runtime"]
async fn effects_preserve_foreground_alpha_and_suppress_background_detail() {
    let instance = wgpu::Instance::default();
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let width = 640;
    let height = 360;
    let input = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut pixels = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let pixel = if x > width / 2 {
                [255, 0, 0, 255]
            } else {
                let value = if (x / 12 + y / 12) % 2 == 0 { 255 } else { 0 };
                [0, value, value, 255]
            };
            pixels.extend_from_slice(&pixel);
        }
    }
    queue.write_texture(
        input.as_image_copy(),
        &pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        input.size(),
    );
    let mut processor = BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm).unwrap();
    processor.ensure_textures(&device, width, height);
    processor.set_frame_synchronous(true);
    processor.inference_requested = false;
    processor.mask_initialized = true;
    for (index, mask) in processor.mask_data.iter_mut().enumerate() {
        *mask = if index % SEGMENTATION_SIZE as usize > SEGMENTATION_SIZE as usize / 2 {
            1.0
        } else {
            0.0
        };
    }
    let mut blurred = Vec::new();
    for mode in [
        BlurMode::Remove,
        BlurMode::Light,
        BlurMode::Heavy,
        BlurMode::Remove,
    ] {
        let output = processor.process(&device, &queue, &input, mode);
        let actual = read_output(&device, &queue, output).await;
        let foreground = ((height / 2 * width + width * 3 / 4) * 4) as usize;
        assert_eq!(&actual[foreground..foreground + 4], &[255, 0, 0, 255]);
        for y in 20..height - 20 {
            for x in 20..width / 2 - 20 {
                let index = ((y * width + x) * 4) as usize;
                if mode == BlurMode::Remove {
                    assert_eq!(actual[index + 3], 0);
                } else {
                    assert_eq!(actual[index + 3], 255);
                    assert!(
                        actual[index] <= 2,
                        "foreground color leaked into the background: {}",
                        actual[index]
                    );
                }
            }
        }
        if mode != BlurMode::Remove {
            let mut detail = 0.0;
            for y in 40..height - 40 {
                for x in 40..width / 2 - 40 {
                    let index = ((y * width + x) * 4 + 1) as usize;
                    detail += (f64::from(actual[index]) - 127.5).powi(2);
                }
            }
            blurred.push(detail);
        }
    }
    assert!(
        blurred[1] < blurred[0] * 0.25,
        "Heavy should remove more detail than Light: {blurred:?}"
    );
    for (index, mask) in processor.mask_data.iter_mut().enumerate() {
        let x = index % SEGMENTATION_SIZE as usize;
        let y = index / SEGMENTATION_SIZE as usize;
        *mask = if x > 80 + y / 3 { 1.0 } else { 0.0 };
    }
    processor.mask_dirty = true;
    let output = processor.process(&device, &queue, &input, BlurMode::Remove);
    let diagonal = read_output(&device, &queue, output).await;
    for row in diagonal
        .chunks_exact(width as usize * 4)
        .skip(40)
        .take(height as usize - 80)
    {
        let alpha: Vec<_> = row.chunks_exact(4).map(|pixel| pixel[3]).collect();
        let transition_pixels = alpha
            .iter()
            .filter(|&&value| value > 8 && value < 247)
            .count();
        assert!((3..=12).contains(&transition_pixels));
        assert!(
            alpha
                .windows(2)
                .all(|pair| pair[0].abs_diff(pair[1]) <= 100)
        );
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[80, 80, 80, 255]);
    }
    queue.write_texture(
        input.as_image_copy(),
        &pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        input.size(),
    );
    let output = processor.process(&device, &queue, &input, BlurMode::Remove);
    let flat_color = read_output(&device, &queue, output).await;
    assert!(
        diagonal
            .chunks_exact(4)
            .zip(flat_color.chunks_exact(4))
            .all(|(before, after)| before[3] == after[3]),
        "Camera texture must not add jagged detail to the cutout contour"
    );
    processor.frame_time = Some(1.0);
    processor.inference_requested = false;
    processor.set_frame_time(1.0);
    assert!(!processor.inference_requested);
    processor.set_frame_time(1.0 + 1.0 / 30.0);
    assert!(processor.inference_requested);
    let readback_pointer = processor.readback_pixels.as_ptr();
    for value in [80, 160] {
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[value, value, value, 255]);
        }
        queue.write_texture(
            input.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            input.size(),
        );
        assert!(
            processor
                .readback_downsampled(&device, &queue, &input, true)
                .is_some()
        );
        assert_eq!(processor.readback_pixels.as_ptr(), readback_pointer);
        assert_eq!(processor.readback_pixels.len(), 256 * 256 * 4);
        assert!(
            processor
                .readback_pixels
                .chunks_exact(4)
                .all(|pixel| pixel == [value, value, value, 255])
        );
    }
    assert!(processor.mask_initialized);
    processor.set_frame_time(0.5);
    assert!(!processor.mask_initialized);
    assert_eq!(processor.mask_status.status, BlurMaskStatus::Pending);
    processor.ensure_textures(&device, 320, 180);
    assert!(!processor.mask_initialized);
    assert_eq!(processor.mask_status.status, BlurMaskStatus::Pending);
    assert!(processor.inference_requested);
}
