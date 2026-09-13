use anyhow::{Context, ensure};
use cap_camera_effects::{BlurMode, BlurProcessor};
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 6,
        "usage: process-frame INPUT.rgba WIDTH HEIGHT light|heavy|remove OUTPUT.rgba"
    );
    let width: u32 = args[2].parse()?;
    let height: u32 = args[3].parse()?;
    let mode = match args[4].as_str() {
        "light" => BlurMode::Light,
        "heavy" => BlurMode::Heavy,
        "remove" => BlurMode::Remove,
        _ => anyhow::bail!("unknown effect"),
    };
    let pixels = std::fs::read(&args[1])?;
    ensure!(
        pixels.len() == (width * height * 4) as usize,
        "invalid frame size"
    );
    let instance = wgpu::Instance::default();
    let adapter = instance.request_adapter(&Default::default()).await?;
    println!("adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await?;
    let input = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Camera effect verification input"),
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
    let start = Instant::now();
    let mut processor = BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)?;
    println!(
        "initialization_ms: {:.2}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    processor.set_inference_interval(Duration::ZERO);
    processor.set_frame_synchronous(true);
    let mut timings = Vec::new();
    for frame in 0..60 {
        processor.set_frame_time(frame as f32 / 30.0);
        let start = Instant::now();
        let _ = processor.process(&device, &queue, &input, mode);
        device.poll(wgpu::PollType::Wait)?;
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!("first_frame_ms: {:.2}", timings[0]);
    timings.remove(0);
    timings.sort_by(f64::total_cmp);
    println!(
        "frame_ms p50={:.2} p95={:.2}",
        timings[timings.len() / 2],
        timings[timings.len() * 95 / 100]
    );
    println!("status: {:?}", processor.output_status());
    let output = processor
        .process_returning_output()
        .context("missing output")?;
    let stride = (width * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Camera effect verification readback"),
        size: u64::from(stride) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        output.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
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
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
    device.poll(wgpu::PollType::Wait)?;
    rx.recv()??;
    let mapped = buffer.slice(..).get_mapped_range();
    let mut rgba = Vec::with_capacity(pixels.len());
    for row in mapped.chunks_exact(stride as usize) {
        rgba.extend_from_slice(&row[..(width * 4) as usize]);
    }
    std::fs::write(&args[5], rgba)?;
    Ok(())
}
