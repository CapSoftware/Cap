use std::time::{Duration, Instant};

use crate::camera_blur_portable::PortableCameraBlur;

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
const CADENCE: Duration = Duration::from_micros(33_333);
const WARMUP: usize = 30;
const MEASURED: usize = 150;

#[cfg(unix)]
fn thread_cpu() -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

#[cfg(unix)]
fn process_cpu() -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

#[cfg(windows)]
fn filetime(ft: windows_sys::Win32::Foundation::FILETIME) -> Duration {
    let ticks = (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime);
    Duration::from_nanos(ticks * 100)
}

#[cfg(windows)]
fn thread_cpu() -> Duration {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    let [creation, exit, kernel, user] = &mut times;
    unsafe { GetThreadTimes(GetCurrentThread(), creation, exit, kernel, user) };
    filetime(times[2]) + filetime(times[3])
}

#[cfg(windows)]
fn process_cpu() -> Duration {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
    let [creation, exit, kernel, user] = &mut times;
    unsafe { GetProcessTimes(GetCurrentProcess(), creation, exit, kernel, user) };
    filetime(times[2]) + filetime(times[3])
}

fn frame(seed: u32) -> gpui::RenderImage {
    let image = image::RgbaImage::from_fn(WIDTH, HEIGHT, |x, y| {
        let inside = (x + seed * 7) % WIDTH < WIDTH / 3 && (y + seed * 3) % HEIGHT < HEIGHT / 2;
        image::Rgba([
            (x * 255 / WIDTH) as u8,
            (y * 255 / HEIGHT) as u8,
            if inside { 230 } else { (seed * 40) as u8 },
            255,
        ])
    });
    gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(image)])
}

fn percentile(values: &mut [f64], p: f64) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if values.is_empty() {
        return f64::NAN;
    }
    values[((values.len() - 1) as f64 * p).round() as usize]
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

//ADAPTER

fn adapter_line() -> String {
    let instance = cap_rendering::create_wgpu_instance_sync();
    let adapter = pollster_block(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: cap_rendering::force_software_wgpu_adapter(),
        compatible_surface: None,
    }));
    match adapter {
        Ok(adapter) => {
            let info = adapter.get_info();
            let bgra = adapter.get_texture_format_features(wgpu::TextureFormat::Bgra8Unorm);
            format!(
                "backend={:?} adapter=\"{}\" device_type={:?} bgra_usages={:?} bgra_filterable={}",
                info.backend,
                info.name,
                info.device_type,
                bgra.allowed_usages,
                bgra.flags
                    .contains(wgpu::TextureFormatFeatureFlags::FILTERABLE)
            )
        }
        Err(error) => format!("adapter_error=\"{error}\""),
    }
}

fn pollster_block<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
#[ignore]
fn blur_ab_bench() {
    let variant = std::env::var("CAP_AB_VARIANT").unwrap_or_default();
    let label = std::env::var("CAP_AB_LABEL").unwrap_or_default();
    let adapter = adapter_line();
    eprintln!("BLURAB-ADAPTER variant={variant} label={label} {adapter}");
    let frames: Vec<_> = (0..4).map(frame).collect();
    let dims = (WIDTH as usize, HEIGHT as usize);
    for mode in [
        cap_camera_effects::BlurMode::Light,
        cap_camera_effects::BlurMode::Heavy,
    ] {
        let mut blur = match PortableCameraBlur::new() {
            Ok(blur) => blur,
            Err(error) => {
                println!("BLURAB variant={variant} label={label} mode={mode:?} skipped=\"{error:#}\"");
                return;
            }
        };
        let mut deadline = Instant::now();
        for index in 0..WARMUP {
            deadline += CADENCE;
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
            step(&mut blur, &frames[index % frames.len()], dims, mode, Instant::now());
        }

        let mut wall = Vec::with_capacity(MEASURED);
        let mut cpu = Vec::with_capacity(MEASURED);
        let mut blocked = Vec::with_capacity(MEASURED);
        let mut latency = Vec::with_capacity(MEASURED);
        let process_before = process_cpu();
        let loop_started = Instant::now();
        deadline = Instant::now();
        for index in 0..MEASURED {
            deadline += CADENCE;
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
            let t0 = Instant::now();
            let c0 = thread_cpu();
            let output = step(&mut blur, &frames[index % frames.len()], dims, mode, t0);
            let c1 = thread_cpu();
            let t1 = Instant::now();
            let wall_us = (t1 - t0).as_secs_f64() * 1e6;
            let cpu_us = (c1 - c0).as_secs_f64() * 1e6;
            wall.push(wall_us);
            cpu.push(cpu_us);
            blocked.push((wall_us - cpu_us).max(0.));
            if let Some(source) = output {
                latency.push((t1 - source).as_secs_f64() * 1e6);
            }
        }
        let loop_seconds = loop_started.elapsed().as_secs_f64();
        let process_us_per_frame =
            (process_cpu() - process_before).as_secs_f64() * 1e6 / MEASURED as f64;

        let flat_started = Instant::now();
        let mut flat_outputs = 0usize;
        for index in 0..MEASURED {
            if step(&mut blur, &frames[index % frames.len()], dims, mode, Instant::now()).is_some()
            {
                flat_outputs += 1;
            }
        }
        let flat_fps = flat_outputs as f64 / flat_started.elapsed().as_secs_f64();

        let cpu_mean = mean(&cpu);
        let wall_mean = mean(&wall);
        let blocked_mean = mean(&blocked);
        println!(
            "BLURAB variant={variant} label={label} mode={mode:?} frames={MEASURED} loop_s={loop_seconds:.2} \
             wall_p50_us={:.0} wall_p95_us={:.0} wall_mean_us={wall_mean:.0} \
             thread_cpu_p50_us={:.0} thread_cpu_mean_us={cpu_mean:.0} \
             blocked_p50_us={:.0} blocked_mean_us={blocked_mean:.0} \
             process_cpu_us_per_frame={process_us_per_frame:.0} \
             latency_p50_us={:.0} latency_p95_us={:.0} flat_out_fps={flat_fps:.1}",
            percentile(&mut wall.clone(), 0.5),
            percentile(&mut wall, 0.95),
            percentile(&mut cpu, 0.5),
            percentile(&mut blocked, 0.5),
            percentile(&mut latency.clone(), 0.5),
            percentile(&mut latency, 0.95),
        );
    }
}
