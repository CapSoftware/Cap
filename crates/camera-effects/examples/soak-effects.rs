use anyhow::{Context, ensure};
use cap_camera_effects::{BlurMode, BlurProcessor};
use std::time::{Duration, Instant};

fn heap_mib() -> Option<[f64; 2]> {
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        #[derive(Default)]
        struct MallocStatistics {
            blocks_in_use: u32,
            size_in_use: usize,
            max_size_in_use: usize,
            size_allocated: usize,
        }
        unsafe extern "C" {
            fn malloc_zone_statistics(
                zone: *mut std::ffi::c_void,
                statistics: *mut MallocStatistics,
            );
        }
        let mut statistics = MallocStatistics::default();
        unsafe { malloc_zone_statistics(std::ptr::null_mut(), &mut statistics) };
        Some([
            statistics.size_in_use as f64 / 1_048_576.0,
            statistics.size_allocated as f64 / 1_048_576.0,
        ])
    }
    #[cfg(not(target_os = "macos"))]
    None
}

fn resources(instance: &wgpu::Instance) -> [usize; 8] {
    let hub = instance.generate_report().expect("native GPU report").hub;
    [
        hub.buffers,
        hub.textures,
        hub.texture_views,
        hub.bind_groups,
        hub.render_pipelines,
        hub.samplers,
        hub.shader_modules,
        hub.command_buffers,
    ]
    .map(|entry| entry.num_kept_from_user)
}

async fn setup_device(
    adapter: &wgpu::Adapter,
    pixels: &[u8],
    width: u32,
    height: u32,
) -> anyhow::Result<(wgpu::Device, wgpu::Queue, Vec<wgpu::Texture>)> {
    let (device, queue) = adapter.request_device(&Default::default()).await?;
    let mut inputs = Vec::new();
    for scale in [1, 3] {
        let (w, h) = (width * scale, height * scale);
        let input = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Camera effect soak input"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut scaled = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let index = ((y / scale * width + x / scale) * 4) as usize;
                scaled.extend_from_slice(&pixels[index..index + 4]);
            }
        }
        queue.write_texture(
            input.as_image_copy(),
            &scaled,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            input.size(),
        );
        inputs.push(input);
    }
    queue.submit([]);
    device.poll(wgpu::PollType::Wait)?;
    Ok((device, queue, inputs))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 7,
        "usage: soak-effects INPUT.rgba WIDTH HEIGHT SECONDS_PER_CYCLE CYCLES preview|studio|recreate"
    );
    let width: u32 = args[2].parse()?;
    let height: u32 = args[3].parse()?;
    let seconds: u64 = args[4].parse()?;
    let cycles: usize = args[5].parse()?;
    let synchronous = match args[6].as_str() {
        "preview" | "recreate" => false,
        "studio" => true,
        _ => anyhow::bail!("unknown processing mode"),
    };
    ensure!(width > 0 && height > 0 && seconds > 0 && cycles > 0);
    let pixels = std::fs::read(&args[1])?;
    ensure!(pixels.len() == (width * height * 4) as usize);
    let instance = wgpu::Instance::default();
    let adapter = instance.request_adapter(&Default::default()).await?;
    let empty = resources(&instance);
    let mut gpu = None;
    println!(
        "pid={} empty={empty:?} heap_mib={:?}",
        std::process::id(),
        heap_mib()
    );
    let started = Instant::now();
    let frame_interval = Duration::from_secs_f64(1.0 / 30.0);
    for cycle in 0..cycles {
        if gpu.is_none() {
            gpu = Some(setup_device(&adapter, &pixels, width, height).await?);
        }
        let (device, queue, inputs) = gpu.as_ref().expect("device initialized above");
        let baseline = resources(&instance);
        let mut processor = BlurProcessor::new(device, wgpu::TextureFormat::Rgba8Unorm)?;
        processor.set_frame_synchronous(synchronous);
        processor.set_inference_interval(Duration::from_millis(33));
        let cycle_start = Instant::now();
        let mut frame = 0;
        let mut processing_ms = 0.0;
        while cycle_start.elapsed() < Duration::from_secs(seconds) {
            let frame_start = Instant::now();
            let mode = match frame / 60 % 3 {
                0 => BlurMode::Remove,
                1 => BlurMode::Light,
                _ => BlurMode::Heavy,
            };
            let input = &inputs[frame / 150 % inputs.len()];
            if synchronous {
                processor.set_frame_time(frame as f32 / 30.0);
            }
            let _ = processor.process(device, queue, input, mode);
            device.poll(wgpu::PollType::Wait)?;
            processor
                .output_status()
                .context("missing output status")?
                .applied_at(Instant::now(), Duration::from_secs(1))
                .map_err(|error| anyhow::anyhow!("effect output unavailable: {error:?}"))?;
            processing_ms += frame_start.elapsed().as_secs_f64() * 1000.0;
            frame += 1;
            if frame % 150 == 0 {
                println!(
                    "active cycle={cycle} elapsed={:.2} frames={frame} mean_ms={:.2} resources={:?} heap_mib={:?}",
                    started.elapsed().as_secs_f64(),
                    processing_ms / frame as f64,
                    resources(&instance),
                    heap_mib(),
                );
            }
            std::thread::sleep(frame_interval.saturating_sub(frame_start.elapsed()));
        }
        drop(processor);
        queue.submit([]);
        device.poll(wgpu::PollType::Wait)?;
        let released = resources(&instance);
        println!(
            "released cycle={cycle} elapsed={:.2} frames={frame} resources={released:?} heap_mib={:?}",
            started.elapsed().as_secs_f64(),
            heap_mib(),
        );
        ensure!(
            released == baseline,
            "GPU resources retained after teardown"
        );
        if args[6] == "recreate" {
            gpu = None;
            let released = resources(&instance);
            println!(
                "device_released cycle={cycle} resources={released:?} heap_mib={:?}",
                heap_mib()
            );
            ensure!(
                released == empty,
                "GPU resources retained after device teardown"
            );
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    println!(
        "complete elapsed={:.2} heap_mib={:?}",
        started.elapsed().as_secs_f64(),
        heap_mib()
    );
    if let Ok(seconds) = std::env::var("CAP_EFFECTS_SOAK_HOLD_SECONDS") {
        std::thread::sleep(Duration::from_secs(seconds.parse()?));
    }
    Ok(())
}
