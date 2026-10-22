//! Replays raw RGBA frames through the live preview path: asynchronous
//! segmentation fed zero-copy from IOSurface pixel buffers, paced at 30fps.
//! usage: replay-live WIDTH HEIGHT < input.rgba > output.rgba

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use cap_camera_effects::{BlurMode, BlurProcessor};
    use cidre::{cf, cv};
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut u8;
        fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
    }

    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "usage: replay-live WIDTH HEIGHT < in.rgba > out.rgba"
    );
    let (width, height): (u32, u32) = (args[1].parse()?, args[2].parse()?);
    let instance = wgpu::Instance::default();
    let adapter = instance.request_adapter(&Default::default()).await?;
    let (device, queue) = adapter.request_device(&Default::default()).await?;
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
    let properties = cf::Dictionary::new();
    let attributes = cf::Dictionary::with_keys_values(
        &[cv::pixel_buffer::keys::io_surf_props().as_ref()],
        &[properties.as_ref()],
    )
    .unwrap();
    let mut ring = (0..4)
        .map(|_| {
            cv::PixelBuf::new(
                width as usize,
                height as usize,
                cv::PixelFormat::_32_BGRA,
                Some(&attributes),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut processor = BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)?;
    processor.set_inference_interval(Duration::from_millis(33));
    let stride = (width * 4).div_ceil(256) * 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(stride) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut pixels = vec![0; (width * height * 4) as usize];
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut frame = 0usize;
    while stdin.read_exact(&mut pixels).is_ok() {
        let started = Instant::now();
        let buffer = &mut ring[frame % 4];
        unsafe {
            buffer
                .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()?;
            let base = CVPixelBufferGetBaseAddress(buffer);
            let row_stride = CVPixelBufferGetBytesPerRow(buffer);
            for (y, row) in pixels.chunks_exact(width as usize * 4).enumerate() {
                for (x, p) in row.chunks_exact(4).enumerate() {
                    let d = base.add(y * row_stride + x * 4);
                    *d = p[2];
                    *d.add(1) = p[1];
                    *d.add(2) = p[0];
                    *d.add(3) = 255;
                }
            }
            buffer
                .unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()?;
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
        processor.set_segmentation_source(buffer.retained());
        let output = processor.process(&device, &queue, &input, BlurMode::Remove);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            output.size(),
        );
        queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
        device.poll(wgpu::PollType::Wait)?;
        rx.recv()??;
        {
            let mapped = readback.slice(..).get_mapped_range();
            for row in mapped.chunks_exact(stride as usize) {
                stdout.write_all(&row[..(width * 4) as usize])?;
            }
        }
        readback.unmap();
        frame += 1;
        std::thread::sleep(Duration::from_millis(33).saturating_sub(started.elapsed()));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {}
