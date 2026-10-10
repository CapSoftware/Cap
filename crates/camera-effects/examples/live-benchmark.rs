//! Live camera-preview cost per frame at camera pacing.
//! usage: live-benchmark INPUT.rgba WIDTH HEIGHT sync|async|zero-copy

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use cap_camera_effects::{BlurMaskStatus, BlurMode, BlurProcessor};
    use cidre::{cf, cv};
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut u8;
        fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
    }

    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 5,
        "usage: live-benchmark INPUT.rgba W H sync|async|zero-copy"
    );
    let (width, height): (u32, u32) = (args[2].parse()?, args[3].parse()?);
    let pixels = std::fs::read(&args[1])?;
    anyhow::ensure!(
        pixels.len() == (width * height * 4) as usize,
        "expected exactly one {width}x{height} RGBA frame"
    );
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
    let properties = cf::Dictionary::new();
    let attributes = cf::Dictionary::with_keys_values(
        &[cv::pixel_buffer::keys::io_surf_props().as_ref()],
        &[properties.as_ref()],
    )
    .unwrap();
    let mut buffer = cv::PixelBuf::new(
        width as usize,
        height as usize,
        cv::PixelFormat::_32_BGRA,
        Some(&attributes),
    )?;
    unsafe {
        buffer
            .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()?;
        let base = CVPixelBufferGetBaseAddress(&buffer);
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        for (y, row) in pixels
            .chunks_exact(width as usize * 4)
            .take(height as usize)
            .enumerate()
        {
            for (x, p) in row.chunks_exact(4).enumerate() {
                let d = base.add(y * stride + x * 4);
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

    let mode = args[4].as_str();
    let mut processor = BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)?;
    processor.set_frame_synchronous(mode == "sync");
    processor.set_inference_interval(Duration::ZERO);
    let mut timings = Vec::new();
    let mut generations = std::collections::HashSet::new();
    let start = Instant::now();
    for frame in 0..300 {
        let frame_start = Instant::now();
        processor.set_frame_time(frame as f32 / 30.0);
        if mode == "zero-copy" {
            processor.set_segmentation_source(buffer.retained());
        }
        let _ = processor.process(&device, &queue, &input, BlurMode::Remove);
        device.poll(wgpu::PollType::Wait)?;
        timings.push(frame_start.elapsed().as_secs_f64() * 1000.0);
        if let Some(status) = processor.output_status()
            && let BlurMaskStatus::Ready(receipt) = status.mask
        {
            generations.insert(receipt.generation);
        }
        std::thread::sleep(Duration::from_millis(33).saturating_sub(frame_start.elapsed()));
    }
    let elapsed = start.elapsed().as_secs_f64();
    timings.remove(0);
    timings.sort_by(f64::total_cmp);
    println!(
        "{mode:9} {width}x{height}: render-thread p50={:.2}ms p95={:.2}ms max={:.2}ms, mask updates {:.1}/s",
        timings[timings.len() / 2],
        timings[timings.len() * 95 / 100],
        timings[timings.len() - 1],
        generations.len() as f64 / elapsed
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {}
