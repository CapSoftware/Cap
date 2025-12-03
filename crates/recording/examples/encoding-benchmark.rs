use cap_frame_converter::{
    AsyncConverterPool, ConversionConfig, ConverterPoolConfig, DropStrategy,
};
use cap_recording::benchmark::{BenchmarkConfig, EncoderInfo, MetricsSnapshot, PipelineMetrics};
use ffmpeg::format::Pixel;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tracing::info;

fn create_test_frame(
    format: Pixel,
    width: u32,
    height: u32,
    frame_num: u64,
) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(format, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = ((i
                .wrapping_mul(17)
                .wrapping_add(plane_idx * 31)
                .wrapping_add(frame_num as usize))
                % 256) as u8;
        }
    }
    frame.set_pts(Some((frame_num * 33333) as i64));
    frame
}

struct MockEncoder {
    encode_time: Duration,
    frames_encoded: AtomicU64,
}

impl MockEncoder {
    fn new(encode_time: Duration) -> Self {
        Self {
            encode_time,
            frames_encoded: AtomicU64::new(0),
        }
    }

    fn encode(&self, _frame: ffmpeg::frame::Video) -> Duration {
        let start = Instant::now();
        std::thread::sleep(self.encode_time);
        self.frames_encoded.fetch_add(1, Ordering::Relaxed);
        start.elapsed()
    }
}

fn run_synthetic_benchmark(
    config: &BenchmarkConfig,
    input_format: Pixel,
    output_format: Pixel,
    width: u32,
    height: u32,
    simulated_encode_time: Duration,
    worker_count: usize,
) -> MetricsSnapshot {
    let metrics = PipelineMetrics::new();
    let conversion_config =
        ConversionConfig::new(input_format, width, height, output_format, width, height);

    let pool_config = ConverterPoolConfig {
        worker_count,
        input_capacity: 120,
        output_capacity: 90,
        drop_strategy: DropStrategy::DropOldest,
    };

    let pool = AsyncConverterPool::from_config(conversion_config, pool_config)
        .expect("Failed to create converter pool");

    let encoder = Arc::new(MockEncoder::new(simulated_encode_time));

    let frame_interval = Duration::from_secs_f64(1.0 / config.target_fps as f64);
    let total_frames = config.duration_secs * config.target_fps as u64;
    let warmup_frames = config.warmup_secs * config.target_fps as u64;

    info!(
        "Running synthetic benchmark: {}x{} {:?} -> {:?}",
        width, height, input_format, output_format
    );
    info!(
        "Duration: {}s, Target FPS: {}, Simulated encode time: {:?}",
        config.duration_secs, config.target_fps, simulated_encode_time
    );

    if config.warmup_secs > 0 {
        info!("Warmup: {} frames...", warmup_frames);
        for i in 0..warmup_frames {
            let frame = create_test_frame(input_format, width, height, i);
            let _ = pool.submit(frame, i);
            std::thread::sleep(frame_interval);
            while let Some(converted) = pool.try_recv() {
                let _ = encoder.encode(converted.frame);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
        while pool.try_recv().is_some() {}
    }

    metrics.start();

    let start = Instant::now();
    let mut next_frame_time = start;
    let mut frame_sequence = 0u64;

    for _ in 0..total_frames {
        let now = Instant::now();
        if now < next_frame_time {
            std::thread::sleep(next_frame_time - now);
        }
        next_frame_time += frame_interval;

        let frame = create_test_frame(input_format, width, height, frame_sequence);
        let receive_time = Instant::now();
        metrics.record_frame_received();

        match pool.submit(frame, frame_sequence) {
            Ok(()) => {}
            Err(_) => {
                metrics.record_dropped_input();
            }
        }

        while let Some(converted) = pool.try_recv() {
            let conversion_end = Instant::now();
            let conversion_duration = conversion_end.duration_since(receive_time);
            metrics.record_frame_converted(conversion_duration);

            let encode_start = Instant::now();
            let encode_duration = encoder.encode(converted.frame);
            let pipeline_latency = encode_start.elapsed() + conversion_duration;
            metrics.record_frame_encoded(encode_duration, pipeline_latency);
        }

        frame_sequence += 1;
    }

    let drain_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < drain_deadline {
        if let Some(converted) = pool.recv_timeout(Duration::from_millis(100)) {
            let encode_start = Instant::now();
            let encode_duration = encoder.encode(converted.frame);
            metrics.record_frame_converted(Duration::from_millis(1));
            metrics.record_frame_encoded(encode_duration, encode_start.elapsed());
        } else {
            let stats = pool.stats();
            let pending = stats
                .frames_received
                .saturating_sub(stats.frames_converted + stats.frames_dropped);
            if pending == 0 {
                break;
            }
        }
    }

    metrics.stop();
    let pool_stats = pool.stats();

    let snapshot = metrics.snapshot();

    info!(
        "Pool stats: received={}, converted={}, dropped={}",
        pool_stats.frames_received, pool_stats.frames_converted, pool_stats.frames_dropped
    );

    snapshot
}

fn benchmark_conversion_formats(config: &BenchmarkConfig) {
    let formats = [
        (
            Pixel::UYVY422,
            Pixel::NV12,
            "UYVY422 -> NV12 (macOS camera typical)",
        ),
        (
            Pixel::YUYV422,
            Pixel::NV12,
            "YUYV422 -> NV12 (Windows camera typical)",
        ),
        (Pixel::BGRA, Pixel::NV12, "BGRA -> NV12 (screen capture)"),
        (Pixel::NV12, Pixel::NV12, "NV12 -> NV12 (passthrough)"),
        (Pixel::YUV420P, Pixel::NV12, "YUV420P -> NV12"),
    ];

    println!("\n=== Format Conversion Benchmarks ===\n");

    for (input, output, name) in formats {
        println!("Testing: {}", name);

        let mut cfg = config.clone();
        cfg.duration_secs = 5;

        let result = run_synthetic_benchmark(
            &cfg,
            input,
            output,
            1920,
            1080,
            Duration::from_micros(500),
            4,
        );

        println!(
            "  FPS: {:.1}, Dropped: {} ({:.2}%), Avg Conv: {:?}",
            result.effective_fps(),
            result.total_frames_dropped(),
            result.drop_rate(),
            result.avg_conversion_time().unwrap_or_default()
        );
        println!();
    }
}

fn benchmark_encode_times(config: &BenchmarkConfig) {
    let encode_times = [
        Duration::from_micros(100),
        Duration::from_micros(500),
        Duration::from_millis(1),
        Duration::from_millis(2),
        Duration::from_millis(5),
        Duration::from_millis(10),
        Duration::from_millis(16),
        Duration::from_millis(33),
    ];

    println!("\n=== Encode Time Impact Analysis ===\n");
    println!("Testing how different encode times affect frame drops at 30 FPS");
    println!("(Frame budget at 30 FPS = 33.3ms)\n");

    for encode_time in encode_times {
        let mut cfg = config.clone();
        cfg.duration_secs = 5;

        let result = run_synthetic_benchmark(
            &cfg,
            Pixel::UYVY422,
            Pixel::NV12,
            1920,
            1080,
            encode_time,
            4,
        );

        let status = if result.drop_rate() < 1.0 {
            "✓"
        } else {
            "✗"
        };

        println!(
            "  {:>6?} encode: FPS {:.1}, Drops {:.1}% {}",
            encode_time,
            result.effective_fps(),
            result.drop_rate(),
            status
        );
    }
}

fn benchmark_worker_counts(config: &BenchmarkConfig) {
    let worker_counts = [1, 2, 4, 6, 8];

    println!("\n=== Worker Count Optimization ===\n");
    println!("Testing conversion pool with different worker counts\n");

    for workers in worker_counts {
        let mut cfg = config.clone();
        cfg.duration_secs = 5;

        let result = run_synthetic_benchmark(
            &cfg,
            Pixel::UYVY422,
            Pixel::NV12,
            1920,
            1080,
            Duration::from_millis(2),
            workers,
        );

        println!(
            "  {} workers: FPS {:.1}, Drops {:.1}%, Avg Conv {:?}",
            workers,
            result.effective_fps(),
            result.drop_rate(),
            result.avg_conversion_time().unwrap_or_default()
        );
    }
}

fn benchmark_resolutions(config: &BenchmarkConfig) {
    let resolutions = [
        (640, 480, "480p"),
        (1280, 720, "720p"),
        (1920, 1080, "1080p"),
        (2560, 1440, "1440p"),
        (3840, 2160, "4K"),
    ];

    println!("\n=== Resolution Impact ===\n");

    for (width, height, name) in resolutions {
        let mut cfg = config.clone();
        cfg.duration_secs = 5;

        let result = run_synthetic_benchmark(
            &cfg,
            Pixel::UYVY422,
            Pixel::NV12,
            width,
            height,
            Duration::from_millis(2),
            4,
        );

        println!(
            "  {} ({}x{}): FPS {:.1}, Drops {:.1}%, Conv {:?}",
            name,
            width,
            height,
            result.effective_fps(),
            result.drop_rate(),
            result.avg_conversion_time().unwrap_or_default()
        );
    }
}

fn run_full_benchmark(config: &BenchmarkConfig) {
    println!("\n=== Full Production Simulation ===\n");

    let encoder_info = EncoderInfo::detect();
    encoder_info.print_info();
    println!();

    let result = run_synthetic_benchmark(
        config,
        Pixel::UYVY422,
        Pixel::NV12,
        1920,
        1080,
        Duration::from_millis(2),
        4,
    );

    result.print_report();

    if config.output_json {
        println!("\n--- JSON Output ---");
        println!("{}", result.to_json());
    }
}

fn main() {
    ffmpeg::init().expect("Failed to init ffmpeg");
    tracing_subscriber::fmt::init();

    println!("=== Cap Encoding Pipeline Benchmark ===\n");

    let encoder_info = EncoderInfo::detect();
    encoder_info.print_info();

    println!("\nSystem Info:");
    println!(
        "  CPU Cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );
    println!("  Platform: {}", std::env::consts::OS);
    println!();

    let args: Vec<String> = std::env::args().collect();

    let config = BenchmarkConfig {
        duration_secs: args
            .iter()
            .position(|a| a == "--duration")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(10),
        warmup_secs: 2,
        target_fps: args
            .iter()
            .position(|a| a == "--fps")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(30),
        camera_resolution: None,
        output_json: args.contains(&"--json".to_string()),
    };

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("full");

    match mode {
        "formats" => benchmark_conversion_formats(&config),
        "encode" => benchmark_encode_times(&config),
        "workers" => benchmark_worker_counts(&config),
        "resolutions" => benchmark_resolutions(&config),
        "full" | _ => {
            benchmark_conversion_formats(&config);
            benchmark_encode_times(&config);
            benchmark_worker_counts(&config);
            benchmark_resolutions(&config);
            run_full_benchmark(&config);
        }
    }
}
