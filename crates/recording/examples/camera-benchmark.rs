use cap_camera::CameraInfo;
use cap_recording::{
    CameraFeed,
    benchmark::{BenchmarkConfig, EncoderInfo, PipelineMetrics},
    feeds::camera::{self, DeviceOrModelID},
};
use ffmpeg::format::Pixel;
use kameo::Actor;
use std::{
    fmt::Display,
    time::{Duration, Instant},
};
use tracing::{info, warn};

struct CameraSelection(CameraInfo);

impl Display for CameraSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let model_id = self
            .0
            .model_id()
            .map(|m| m.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        write!(f, "{} ({})", self.0.display_name(), model_id)
    }
}

fn print_camera_info(info: &CameraInfo) {
    println!("\nCamera: {}", info.display_name());
    println!("Model ID: {:?}", info.model_id());

    if let Some(formats) = info.formats() {
        println!("\nAvailable formats:");
        for (i, format) in formats.into_iter().take(10).enumerate() {
            println!(
                "  {}. {}x{} @ {:.1} fps",
                i + 1,
                format.width(),
                format.height(),
                format.frame_rate()
            );
        }
    }
}

async fn run_camera_frame_rate_test(
    camera_info: &CameraInfo,
    duration_secs: u64,
) -> (u64, f64, Vec<Duration>) {
    let feed = CameraFeed::spawn(CameraFeed::default());

    feed.ask(camera::SetInput {
        id: DeviceOrModelID::from_info(camera_info),
    })
    .await
    .expect("Failed to send SetInput")
    .await
    .expect("SetInput failed");

    let (tx, rx) = flume::bounded(256);
    feed.ask(camera::AddSender(tx))
        .await
        .expect("Failed to add sender");

    tokio::time::sleep(Duration::from_millis(100)).await;

    let start = Instant::now();
    let deadline = start + Duration::from_secs(duration_secs);
    let mut frame_count = 0u64;
    let mut inter_frame_times = Vec::new();
    let mut last_frame_time = Instant::now();

    info!("Measuring camera frame rate for {}s...", duration_secs);

    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(_frame) => {
                let now = Instant::now();
                if frame_count > 0 {
                    inter_frame_times.push(now.duration_since(last_frame_time));
                }
                last_frame_time = now;
                frame_count += 1;
            }
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }

    let elapsed = start.elapsed();
    let fps = frame_count as f64 / elapsed.as_secs_f64();

    (frame_count, fps, inter_frame_times)
}

async fn run_camera_encoding_benchmark(
    camera_info: &CameraInfo,
    config: &BenchmarkConfig,
) -> cap_recording::benchmark::MetricsSnapshot {
    use cap_frame_converter::{
        AsyncConverterPool, ConversionConfig, ConverterPoolConfig, DropStrategy,
    };

    let metrics = PipelineMetrics::new();

    let feed = CameraFeed::spawn(CameraFeed::default());

    feed.ask(camera::SetInput {
        id: DeviceOrModelID::from_info(camera_info),
    })
    .await
    .expect("Failed to send SetInput")
    .await
    .expect("SetInput failed");

    let (tx, rx) = flume::bounded(256);
    feed.ask(camera::AddSender(tx))
        .await
        .expect("Failed to add sender");

    tokio::time::sleep(Duration::from_millis(500)).await;

    let first_frame = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("No frame from camera");
    let input_format = first_frame.inner.format();
    let width = first_frame.inner.width();
    let height = first_frame.inner.height();

    println!("\nCamera frame format: {input_format:?} {width}x{height}");

    let output_format = Pixel::NV12;
    let needs_conversion = input_format != output_format;

    let pool = if needs_conversion {
        let conversion_config =
            ConversionConfig::new(input_format, width, height, output_format, width, height);

        let pool_config = ConverterPoolConfig {
            worker_count: 4,
            input_capacity: 120,
            output_capacity: 90,
            drop_strategy: DropStrategy::DropOldest,
        };

        let pool = AsyncConverterPool::from_config(conversion_config, pool_config)
            .expect("Failed to create converter pool");

        Some(pool)
    } else {
        println!("No conversion needed (passthrough)");
        None
    };

    let mut output =
        ffmpeg::format::output_as("/dev/null", "mp4").expect("Failed to create dummy output");
    let video_info = cap_media_info::VideoInfo {
        width,
        height,
        pixel_format: input_format,
        frame_rate: (30, 1).into(),
        time_base: (1, 30).into(),
    };

    let mut encoder = cap_enc_ffmpeg::h264::H264Encoder::builder(video_info)
        .with_external_conversion()
        .build(&mut output)
        .expect("Failed to create encoder");

    output.write_header().ok();

    info!("Warming up for {}s...", config.warmup_secs);
    let warmup_deadline = Instant::now() + Duration::from_secs(config.warmup_secs);
    let mut warmup_submitted = 0u64;

    while Instant::now() < warmup_deadline {
        if let Ok(frame) = rx.recv_timeout(Duration::from_millis(50)) {
            if let Some(ref pool) = pool {
                let _ = pool.submit(frame.inner, 0);
                warmup_submitted += 1;
                while let Some(converted) = pool.try_recv() {
                    let _ = encoder.queue_preconverted_frame(
                        converted.frame,
                        Duration::ZERO,
                        &mut output,
                    );
                }
            } else {
                let _ = encoder.queue_frame(frame.inner, Duration::ZERO, &mut output);
            }
        }
    }

    if let Some(ref pool) = pool {
        let drain_start = Instant::now();
        loop {
            let stats = pool.stats();
            let pending =
                warmup_submitted.saturating_sub(stats.frames_converted + stats.frames_dropped);
            if pending == 0 || drain_start.elapsed() > Duration::from_secs(1) {
                break;
            }
            if let Some(converted) = pool.try_recv() {
                let _ =
                    encoder.queue_preconverted_frame(converted.frame, Duration::ZERO, &mut output);
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        while pool.try_recv().is_some() {}
    }

    info!("Running benchmark for {}s...", config.duration_secs);
    metrics.start();

    let benchmark_deadline = Instant::now() + Duration::from_secs(config.duration_secs);
    let mut sequence = 1u64;

    while Instant::now() < benchmark_deadline {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => {
                metrics.record_frame_received();

                if let Some(ref pool) = pool {
                    match pool.submit(frame.inner, sequence) {
                        Ok(()) => {}
                        Err(_) => {
                            metrics.record_dropped_input();
                            continue;
                        }
                    }

                    while let Some(converted) = pool.try_recv() {
                        if converted.sequence == 0 {
                            continue;
                        }

                        metrics.record_frame_converted(converted.conversion_duration);

                        let encode_start = Instant::now();
                        let timestamp =
                            Duration::from_micros(converted.frame.pts().unwrap_or(0) as u64);

                        match encoder.queue_preconverted_frame(
                            converted.frame,
                            timestamp,
                            &mut output,
                        ) {
                            Ok(()) => {
                                let encode_duration = encode_start.elapsed();
                                let pipeline_latency = converted.submit_time.elapsed();
                                metrics.record_frame_encoded(encode_duration, pipeline_latency);
                            }
                            Err(e) => {
                                warn!("Encode error: {}", e);
                                metrics.record_dropped_output();
                            }
                        }
                    }
                } else {
                    let encode_start = Instant::now();
                    let timestamp = Duration::from_micros(sequence * 33333);

                    match encoder.queue_frame(frame.inner, timestamp, &mut output) {
                        Ok(()) => {
                            let encode_duration = encode_start.elapsed();
                            metrics.record_frame_encoded(encode_duration, encode_duration);
                        }
                        Err(e) => {
                            warn!("Encode error: {}", e);
                            metrics.record_dropped_output();
                        }
                    }
                }

                sequence += 1;
            }
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }

    if let Some(pool) = pool {
        let drain_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < drain_deadline {
            if let Some(converted) = pool.recv_timeout(Duration::from_millis(50)) {
                if converted.sequence == 0 {
                    continue;
                }

                metrics.record_frame_converted(converted.conversion_duration);

                let encode_start = Instant::now();
                let timestamp = Duration::from_micros(converted.frame.pts().unwrap_or(0) as u64);
                if let Ok(()) =
                    encoder.queue_preconverted_frame(converted.frame, timestamp, &mut output)
                {
                    let encode_duration = encode_start.elapsed();
                    let pipeline_latency = converted.submit_time.elapsed();
                    metrics.record_frame_encoded(encode_duration, pipeline_latency);
                }
            } else {
                break;
            }
        }
    }

    metrics.stop();
    let _ = encoder.flush(&mut output);
    let _ = output.write_trailer();

    metrics.snapshot()
}

#[tokio::main]
async fn main() {
    ffmpeg::init().expect("Failed to init ffmpeg");
    tracing_subscriber::fmt::init();

    println!("=== Cap Camera Encoding Benchmark ===\n");

    let encoder_info = EncoderInfo::detect();
    encoder_info.print_info();

    println!(
        "\nCPU Cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );
    println!("Platform: {}\n", std::env::consts::OS);

    let cameras: Vec<_> = cap_camera::list_cameras().map(CameraSelection).collect();

    if cameras.is_empty() {
        println!("No cameras found!");
        return;
    }

    println!("Available cameras:");
    for (i, cam) in cameras.iter().enumerate() {
        println!("  {}. {}", i + 1, cam);
    }

    let args: Vec<String> = std::env::args().collect();

    let camera_index = args
        .iter()
        .position(|a| a == "--camera")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<usize>().ok())
        .map(|i| i.saturating_sub(1))
        .unwrap_or(0);

    let camera = cameras.get(camera_index).expect("Invalid camera index");
    print_camera_info(&camera.0);

    let config = BenchmarkConfig {
        duration_secs: args
            .iter()
            .position(|a| a == "--duration")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(10),
        warmup_secs: 2,
        target_fps: 30,
        camera_resolution: None,
        output_json: args.contains(&"--json".to_string()),
    };

    println!("\n=== Frame Rate Test ===");
    let (frames, fps, inter_frame_times) = run_camera_frame_rate_test(&camera.0, 3).await;
    println!("Frames captured: {frames}");
    println!("Average FPS: {fps:.1}");

    if !inter_frame_times.is_empty() {
        let avg_interval: Duration =
            inter_frame_times.iter().sum::<Duration>() / inter_frame_times.len() as u32;
        let max_interval = inter_frame_times.iter().max().unwrap();
        let min_interval = inter_frame_times.iter().min().unwrap();

        println!("Inter-frame timing:");
        println!("  Average: {avg_interval:?}");
        println!("  Min: {min_interval:?}");
        println!("  Max: {max_interval:?}");

        let mut sorted = inter_frame_times.clone();
        sorted.sort();
        let p99_idx = (sorted.len() as f64 * 0.99) as usize;
        if p99_idx < sorted.len() {
            println!("  P99: {:?}", sorted[p99_idx]);
        }

        let jitter: f64 = inter_frame_times
            .iter()
            .map(|d| (d.as_secs_f64() - avg_interval.as_secs_f64()).powi(2))
            .sum::<f64>()
            / inter_frame_times.len() as f64;
        println!("  Jitter (stddev): {:.2}ms", jitter.sqrt() * 1000.0);
    }

    println!("\n=== Full Encoding Pipeline Benchmark ===");
    let result = run_camera_encoding_benchmark(&camera.0, &config).await;

    result.print_report();

    if config.output_json {
        println!("\n--- JSON Output ---");
        println!("{}", result.to_json());
    }
}
