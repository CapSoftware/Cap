use cap_recording::{
    CameraFeed, FFmpegVideoFrame,
    feeds::camera::{self, DeviceOrModelID},
    memory_profiling::{CpuTracker, get_process_stats},
};
use ffmpeg::{format::Pixel, software::scaling};
use kameo::Actor;
use std::time::{Duration, Instant};

struct PreviewMetrics {
    frames_received: u64,
    frames_rendered: u64,
    frames_dropped: u64,
    scale_times_ns: Vec<u64>,
    alloc_sizes: Vec<usize>,
    frame_intervals_ns: Vec<u64>,
}

impl PreviewMetrics {
    fn new() -> Self {
        Self {
            frames_received: 0,
            frames_rendered: 0,
            frames_dropped: 0,
            scale_times_ns: Vec::new(),
            alloc_sizes: Vec::new(),
            frame_intervals_ns: Vec::new(),
        }
    }

    fn print_report(&self, label: &str) {
        println!("\n--- {label} ---");
        println!("  Frames received:  {}", self.frames_received);
        println!("  Frames rendered:  {}", self.frames_rendered);
        println!("  Frames dropped:   {}", self.frames_dropped);

        if self.frames_received > 0 {
            let drop_rate = self.frames_dropped as f64 / self.frames_received as f64 * 100.0;
            println!("  Drop rate:        {drop_rate:.1}%");
        }

        if !self.scale_times_ns.is_empty() {
            let mut sorted = self.scale_times_ns.clone();
            sorted.sort_unstable();
            let avg = sorted.iter().sum::<u64>() / sorted.len() as u64;
            let p50 = sorted[sorted.len() / 2];
            let p95_idx = ((sorted.len() as f64) * 0.95) as usize;
            let p95 = sorted[p95_idx.min(sorted.len() - 1)];
            let p99_idx = ((sorted.len() as f64) * 0.99) as usize;
            let p99 = sorted[p99_idx.min(sorted.len() - 1)];
            let max = *sorted.last().unwrap_or(&0);

            println!("  Scale time avg:   {:.2}ms", avg as f64 / 1_000_000.0);
            println!("  Scale time P50:   {:.2}ms", p50 as f64 / 1_000_000.0);
            println!("  Scale time P95:   {:.2}ms", p95 as f64 / 1_000_000.0);
            println!("  Scale time P99:   {:.2}ms", p99 as f64 / 1_000_000.0);
            println!("  Scale time max:   {:.2}ms", max as f64 / 1_000_000.0);

            let theoretical_fps = 1_000_000_000.0 / avg as f64;
            println!("  Max FPS (scale):  {theoretical_fps:.0}");
        }

        if !self.alloc_sizes.is_empty() {
            let total: usize = self.alloc_sizes.iter().sum();
            let avg = total / self.alloc_sizes.len();
            let total_mb = total as f64 / 1_048_576.0;
            println!(
                "  Allocs:           {} ({:.1} MB total, {:.1} KB avg)",
                self.alloc_sizes.len(),
                total_mb,
                avg as f64 / 1024.0
            );
        }

        if self.frame_intervals_ns.len() > 1 {
            let mut sorted = self.frame_intervals_ns.clone();
            sorted.sort_unstable();
            let avg = sorted.iter().sum::<u64>() / sorted.len() as u64;
            let jitter: f64 = sorted
                .iter()
                .map(|&t| (t as f64 - avg as f64).powi(2))
                .sum::<f64>()
                / sorted.len() as f64;

            println!(
                "  Frame interval:   {:.2}ms avg ({:.1} FPS)",
                avg as f64 / 1_000_000.0,
                1_000_000_000.0 / avg as f64
            );
            println!("  Frame jitter:     {:.2}ms", jitter.sqrt() / 1_000_000.0);
        }
    }
}

fn simulate_native_preview(
    frames: &[FFmpegVideoFrame],
    output_width: u32,
    label: &str,
) -> PreviewMetrics {
    let mut metrics = PreviewMetrics::new();
    let mut scaler = scaling::Context::get(
        Pixel::RGBA,
        1,
        1,
        Pixel::RGBA,
        1,
        1,
        scaling::Flags::empty(),
    )
    .expect("Failed to create scaler");

    let mut resampler_frame: Option<((u32, u32), ffmpeg::frame::Video)> = None;
    let mut last_frame_time: Option<Instant> = None;

    for frame in frames {
        let now = Instant::now();
        metrics.frames_received += 1;

        if let Some(prev) = last_frame_time {
            metrics
                .frame_intervals_ns
                .push(now.duration_since(prev).as_nanos() as u64);
        }
        last_frame_time = Some(now);

        let aspect_ratio = frame.inner.width() as f32 / frame.inner.height() as f32;
        let out_w = output_width;
        let out_h = (output_width as f32 / aspect_ratio) as u32;

        let resample_target =
            resampler_frame.get_or_insert_with(|| ((out_w, out_h), ffmpeg::frame::Video::empty()));
        if resample_target.0 != (out_w, out_h) {
            *resample_target = ((out_w, out_h), ffmpeg::frame::Video::empty());
        }

        scaler.cached(
            frame.inner.format(),
            frame.inner.width(),
            frame.inner.height(),
            Pixel::RGBA,
            out_w,
            out_h,
            scaling::flag::Flags::FAST_BILINEAR,
        );

        let scale_start = Instant::now();
        if scaler.run(&frame.inner, &mut resample_target.1).is_err() {
            metrics.frames_dropped += 1;
            continue;
        }
        let scale_time = scale_start.elapsed();
        metrics.scale_times_ns.push(scale_time.as_nanos() as u64);

        let data = resample_target.1.data(0);
        metrics.alloc_sizes.push(data.len());
        metrics.frames_rendered += 1;
    }

    metrics.print_report(label);
    metrics
}

fn simulate_ws_preview_old(frames: &[FFmpegVideoFrame], label: &str) -> PreviewMetrics {
    let mut metrics = PreviewMetrics::new();
    let mut converter: Option<(Pixel, scaling::Context)> = None;

    for frame in frames {
        metrics.frames_received += 1;

        let current = &frame.inner;
        let mut converted_frame = None;

        if current.format() != Pixel::RGBA || current.width() > 1280 || current.height() > 720 {
            let ctx = match &mut converter {
                Some((fmt, ctx))
                    if *fmt == current.format()
                        && ctx.input().width == current.width()
                        && ctx.input().height == current.height() =>
                {
                    ctx
                }
                _ => {
                    let new_ctx = scaling::Context::get(
                        current.format(),
                        current.width(),
                        current.height(),
                        Pixel::RGBA,
                        1280,
                        (1280.0 / (current.width() as f64 / current.height() as f64)) as u32,
                        scaling::flag::Flags::FAST_BILINEAR,
                    )
                    .expect("Failed to create WS scaler");
                    &mut converter.insert((current.format(), new_ctx)).1
                }
            };

            let scale_start = Instant::now();
            let mut new_frame =
                ffmpeg::frame::Video::new(Pixel::RGBA, ctx.output().width, ctx.output().height);
            if ctx.run(current, &mut new_frame).is_err() {
                metrics.frames_dropped += 1;
                continue;
            }
            metrics
                .scale_times_ns
                .push(scale_start.elapsed().as_nanos() as u64);
            converted_frame = Some(new_frame);
        }

        let current = converted_frame.as_ref().map_or(current, |f| f);

        let alloc_start = Instant::now();
        let vec_copy = current.data(0).to_vec();
        let alloc_time = alloc_start.elapsed();

        let mut packed = Vec::with_capacity(vec_copy.len() + 24);
        packed.extend_from_slice(&vec_copy);
        packed.extend_from_slice(&(current.stride(0) as u32).to_le_bytes());
        packed.extend_from_slice(&current.height().to_le_bytes());
        packed.extend_from_slice(&current.width().to_le_bytes());
        packed.extend_from_slice(&0u32.to_le_bytes());
        packed.extend_from_slice(&0u64.to_le_bytes());

        metrics.alloc_sizes.push(vec_copy.len() + packed.len());

        if (!metrics.scale_times_ns.is_empty() || current.format() == Pixel::RGBA)
            && metrics.scale_times_ns.len() < metrics.frames_received as usize
        {
            metrics.scale_times_ns.push(alloc_time.as_nanos() as u64);
        }

        metrics.frames_rendered += 1;
    }

    metrics.print_report(label);
    metrics
}

fn simulate_ws_preview_optimized(frames: &[FFmpegVideoFrame], label: &str) -> PreviewMetrics {
    let mut metrics = PreviewMetrics::new();
    let mut converter: Option<(Pixel, scaling::Context)> = None;
    let mut reusable_frame: Option<ffmpeg::frame::Video> = None;
    let mut reusable_buffer: Vec<u8> = Vec::new();

    for frame in frames {
        metrics.frames_received += 1;

        let mut current = &frame.inner;
        let needs_convert =
            current.format() != Pixel::RGBA || current.width() > 640 || current.height() > 360;

        if needs_convert {
            let target_width = 640u32.min(current.width());
            let target_height =
                (target_width as f64 / (current.width() as f64 / current.height() as f64)) as u32;

            let ctx = match &mut converter {
                Some((fmt, ctx))
                    if *fmt == current.format()
                        && ctx.input().width == current.width()
                        && ctx.input().height == current.height() =>
                {
                    ctx
                }
                _ => {
                    let new_ctx = scaling::Context::get(
                        current.format(),
                        current.width(),
                        current.height(),
                        Pixel::RGBA,
                        target_width,
                        target_height,
                        scaling::flag::Flags::FAST_BILINEAR,
                    )
                    .expect("Failed to create WS scaler");
                    &mut converter.insert((current.format(), new_ctx)).1
                }
            };

            let out_frame = reusable_frame.get_or_insert_with(|| {
                ffmpeg::frame::Video::new(Pixel::RGBA, ctx.output().width, ctx.output().height)
            });

            let scale_start = Instant::now();
            if ctx.run(current, out_frame).is_err() {
                metrics.frames_dropped += 1;
                continue;
            }
            metrics
                .scale_times_ns
                .push(scale_start.elapsed().as_nanos() as u64);
            current = out_frame;
        }

        let data = current.data(0);
        let total_size = data.len() + 24;

        reusable_buffer.clear();
        reusable_buffer.reserve(total_size);
        reusable_buffer.extend_from_slice(data);
        reusable_buffer.extend_from_slice(&(current.stride(0) as u32).to_le_bytes());
        reusable_buffer.extend_from_slice(&current.height().to_le_bytes());
        reusable_buffer.extend_from_slice(&current.width().to_le_bytes());
        reusable_buffer.extend_from_slice(&0u32.to_le_bytes());
        reusable_buffer.extend_from_slice(&0u64.to_le_bytes());

        metrics.alloc_sizes.push(0);
        metrics.frames_rendered += 1;
    }

    metrics.print_report(label);
    metrics
}

async fn run_camera_capture(duration_secs: u64) -> Vec<FFmpegVideoFrame> {
    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("No camera found");
        return Vec::new();
    };
    println!("Camera: {}", camera_info.display_name());

    let feed = CameraFeed::spawn(CameraFeed::default());
    let (frame_tx, frame_rx) = flume::bounded::<FFmpegVideoFrame>(4);

    feed.ask(camera::AddSender(frame_tx))
        .await
        .expect("AddSender failed");

    feed.ask(camera::SetInput {
        settings: None,
        id: DeviceOrModelID::from_info(&camera_info),
    })
    .await
    .expect("SetInput send failed")
    .await
    .expect("SetInput failed");

    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut frames = Vec::new();
    let start = Instant::now();

    while start.elapsed() < Duration::from_secs(duration_secs) {
        match frame_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => frames.push(frame),
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }

    feed.ask(camera::RemoveInput)
        .await
        .expect("RemoveInput failed");

    println!(
        "Captured {} frames in {:.1}s ({:.1} FPS)",
        frames.len(),
        start.elapsed().as_secs_f64(),
        frames.len() as f64 / start.elapsed().as_secs_f64()
    );

    if let Some(f) = frames.first() {
        println!(
            "Frame format: {:?}, {}x{}",
            f.inner.format(),
            f.inner.width(),
            f.inner.height()
        );
    }

    frames
}

async fn profile_live_preview(duration_secs: u64, output_width: u32) {
    println!("\n{}", "=".repeat(60));
    println!(
        "  LIVE CAMERA PREVIEW PROFILE ({}px, {duration_secs}s)",
        output_width
    );
    println!("{}\n", "=".repeat(60));

    let mut cpu = CpuTracker::new();
    cpu.sample();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("No camera found");
        return;
    };
    println!("Camera: {}", camera_info.display_name());

    let feed = CameraFeed::spawn(CameraFeed::default());
    let (frame_tx, frame_rx) = flume::bounded::<FFmpegVideoFrame>(4);

    feed.ask(camera::AddSender(frame_tx))
        .await
        .expect("AddSender failed");

    feed.ask(camera::SetInput {
        settings: None,
        id: DeviceOrModelID::from_info(&camera_info),
    })
    .await
    .expect("SetInput send failed")
    .await
    .expect("SetInput failed");

    let mut scaler = scaling::Context::get(
        Pixel::RGBA,
        1,
        1,
        Pixel::RGBA,
        1,
        1,
        scaling::Flags::empty(),
    )
    .expect("Failed to create scaler");

    let mut resampler_frame: Option<((u32, u32), ffmpeg::frame::Video)> = None;

    let start = Instant::now();
    let mut frame_count = 0u64;
    let mut scale_total_ns = 0u64;
    let mut frames_dropped = 0u64;
    let mut next_sample = start + Duration::from_secs(2);

    while start.elapsed() < Duration::from_secs(duration_secs) {
        match frame_rx.try_recv() {
            Ok(frame) => {
                frame_count += 1;

                let aspect = frame.inner.width() as f32 / frame.inner.height() as f32;
                let out_w = output_width;
                let out_h = (output_width as f32 / aspect) as u32;

                let target = resampler_frame
                    .get_or_insert_with(|| ((out_w, out_h), ffmpeg::frame::Video::empty()));
                if target.0 != (out_w, out_h) {
                    *target = ((out_w, out_h), ffmpeg::frame::Video::empty());
                }

                scaler.cached(
                    frame.inner.format(),
                    frame.inner.width(),
                    frame.inner.height(),
                    Pixel::RGBA,
                    out_w,
                    out_h,
                    scaling::flag::Flags::FAST_BILINEAR,
                );

                let t = Instant::now();
                if scaler.run(&frame.inner, &mut target.1).is_err() {
                    frames_dropped += 1;
                } else {
                    scale_total_ns += t.elapsed().as_nanos() as u64;
                }

                while frame_rx.try_recv().is_ok() {
                    frames_dropped += 1;
                }
            }
            Err(flume::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            Err(flume::TryRecvError::Disconnected) => break,
        }

        if Instant::now() >= next_sample {
            cpu.sample();
            let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
            if let Some(stats) = get_process_stats() {
                let fps = frame_count as f64 / start.elapsed().as_secs_f64();
                let avg_scale = if frame_count > 0 {
                    scale_total_ns as f64 / frame_count as f64 / 1_000_000.0
                } else {
                    0.0
                };
                println!(
                    "[{:>5.1}s] CPU: {:>5.1}%  RSS: {:>6.1} MB  FPS: {:.1}  Scale: {:.2}ms  Dropped: {}",
                    start.elapsed().as_secs_f64(),
                    cpu_pct,
                    stats.resident_mb,
                    fps,
                    avg_scale,
                    frames_dropped,
                );
            }
            next_sample = Instant::now() + Duration::from_secs(2);
        }
    }

    feed.ask(camera::RemoveInput)
        .await
        .expect("RemoveInput failed");

    cpu.sample();
    cpu.print_report();

    let rendered = frame_count.saturating_sub(frames_dropped);
    println!("\nFrames: {frame_count} received, {rendered} rendered, {frames_dropped} dropped");
    println!(
        "Effective FPS: {:.1}",
        rendered as f64 / duration_secs as f64
    );
    if rendered > 0 {
        println!(
            "Avg scale time: {:.2}ms",
            scale_total_ns as f64 / rendered as f64 / 1_000_000.0
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { std::env::set_var("RUST_LOG", "info") };
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();

    let duration = args
        .iter()
        .position(|a| a == "--duration")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10u64);

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("all");

    println!("=== Camera Preview Performance Benchmark ===\n");
    println!("Mode: {mode}");
    println!("Duration: {duration}s");
    println!(
        "CPU cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );
    println!("Platform: {}\n", std::env::consts::OS);

    match mode {
        "live" => {
            println!("\n{}", "=".repeat(60));
            println!("  LIVE PREVIEW COMPARISON");
            println!("{}", "=".repeat(60));

            profile_live_preview(duration, 1280).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            profile_live_preview(duration, 640).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            profile_live_preview(duration, 320).await;
        }
        "scaling" => {
            println!("\n{}", "=".repeat(60));
            println!("  SCALING BENCHMARK (captured frames)");
            println!("{}", "=".repeat(60));

            let frames = run_camera_capture(duration).await;
            if frames.is_empty() {
                println!("No frames captured");
                return Ok(());
            }

            simulate_native_preview(&frames, 1280, "Native preview @ 1280px (CURRENT)");
            simulate_native_preview(&frames, 640, "Native preview @ 640px");
            simulate_native_preview(&frames, 460, "Native preview @ 460px (2x of 230)");
            simulate_native_preview(&frames, 320, "Native preview @ 320px");
        }
        "ws" => {
            println!("\n{}", "=".repeat(60));
            println!("  WEBSOCKET PREVIEW BENCHMARK");
            println!("{}", "=".repeat(60));

            let frames = run_camera_capture(duration).await;
            if frames.is_empty() {
                println!("No frames captured");
                return Ok(());
            }

            simulate_ws_preview_old(&frames, "WS preview CURRENT (1280, alloc per frame)");
            simulate_ws_preview_optimized(&frames, "WS preview OPTIMIZED (640, reused buffers)");
        }
        _ => {
            let capture_secs = duration.min(5);
            let frames = run_camera_capture(capture_secs).await;
            if frames.is_empty() {
                println!("No frames captured, cannot run benchmarks");
                return Ok(());
            }

            println!("\n{}", "=".repeat(60));
            println!("  NATIVE PREVIEW SCALING COMPARISON");
            println!("{}", "=".repeat(60));

            simulate_native_preview(&frames, 1280, "Native @ 1280px (CURRENT)");
            simulate_native_preview(&frames, 640, "Native @ 640px");
            simulate_native_preview(&frames, 460, "Native @ 460px (2x of default 230)");
            simulate_native_preview(&frames, 320, "Native @ 320px");

            println!("\n{}", "=".repeat(60));
            println!("  WEBSOCKET PREVIEW COMPARISON");
            println!("{}", "=".repeat(60));

            simulate_ws_preview_old(&frames, "WS CURRENT (1280, alloc/frame)");
            simulate_ws_preview_optimized(&frames, "WS OPTIMIZED (640, reuse buffers)");

            println!("\n{}", "=".repeat(60));
            println!("  LIVE PREVIEW CPU PROFILE ({}s per resolution)", duration);
            println!("{}", "=".repeat(60));

            profile_live_preview(duration, 1280).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            profile_live_preview(duration, 640).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            profile_live_preview(duration, 320).await;
        }
    }

    println!("\n=== Camera Preview Benchmark Complete ===");
    Ok(())
}
