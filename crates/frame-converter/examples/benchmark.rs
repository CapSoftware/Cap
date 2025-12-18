use cap_frame_converter::{
    AsyncConverterPool, ConversionConfig, ConverterPoolConfig, DropStrategy, FrameConverter,
    SwscaleConverter,
};
use ffmpeg::format::Pixel;
use std::time::{Duration, Instant};

fn create_test_frame(format: Pixel, width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(format, width, height);
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = ((i * 17 + plane_idx * 31) % 256) as u8;
        }
    }
    frame.set_pts(Some(0));
    frame
}

fn benchmark_single_threaded(iterations: u32, config: &ConversionConfig) -> Duration {
    let converter = SwscaleConverter::new(config.clone()).expect("Failed to create converter");

    let mut total_time = Duration::ZERO;
    let mut first_frame = true;

    for _ in 0..iterations {
        let frame = create_test_frame(config.input_format, config.input_width, config.input_height);
        let start = Instant::now();
        let _output = converter.convert(frame).expect("Conversion failed");
        let elapsed = start.elapsed();

        if first_frame {
            println!("  First frame: {elapsed:?}");
            first_frame = false;
        }
        total_time += elapsed;
    }

    total_time
}

fn benchmark_pool(
    frame_count: u32,
    config: &ConversionConfig,
    worker_count: usize,
) -> (Duration, u64, u64) {
    let pool_config = ConverterPoolConfig {
        worker_count,
        input_capacity: 120,
        output_capacity: 120,
        drop_strategy: DropStrategy::DropOldest,
    };

    let pool = AsyncConverterPool::from_config(config.clone(), pool_config)
        .expect("Failed to create pool");

    let start = Instant::now();

    for i in 0..frame_count {
        let mut frame =
            create_test_frame(config.input_format, config.input_width, config.input_height);
        frame.set_pts(Some(i as i64 * 33333));
        pool.submit(frame, i as u64).expect("Submit failed");
    }

    let deadline = Instant::now() + Duration::from_secs(30);

    while Instant::now() < deadline {
        let _ = pool.recv_timeout(Duration::from_millis(100));
        let stats = pool.stats();
        if stats.frames_converted >= frame_count as u64 {
            while pool.try_recv().is_some() {}
            break;
        }
    }

    let elapsed = start.elapsed();
    let stats = pool.stats();

    (elapsed, stats.frames_converted, stats.frames_dropped)
}

fn main() {
    ffmpeg::init().expect("Failed to init ffmpeg");

    println!("=== Camera Frame Conversion Benchmark ===\n");

    let config = ConversionConfig::new(Pixel::UYVY422, 1920, 1080, Pixel::NV12, 1920, 1080);

    println!(
        "Conversion: {:?} {}x{} -> {:?} {}x{}\n",
        config.input_format,
        config.input_width,
        config.input_height,
        config.output_format,
        config.output_width,
        config.output_height
    );

    println!("--- Single-threaded SwScale ---");
    let warmup_iterations = 10;
    let test_iterations = 100;

    println!("Warmup ({warmup_iterations} frames)...");
    let _ = benchmark_single_threaded(warmup_iterations, &config);

    println!("Benchmark ({test_iterations} frames)...");
    let single_time = benchmark_single_threaded(test_iterations, &config);
    let avg_per_frame = single_time / test_iterations;
    let max_fps = 1.0 / avg_per_frame.as_secs_f64();
    println!("  Total time: {single_time:?}");
    println!("  Avg per frame: {avg_per_frame:?}");
    println!("  Max theoretical FPS: {max_fps:.1}");
    println!(
        "  Can sustain 30fps: {}",
        if max_fps >= 30.0 { "YES" } else { "NO" }
    );
    println!();

    let frame_count = 300;

    for worker_count in [1, 2, 4, 6, 8] {
        println!("--- Pool with {worker_count} workers ({frame_count} frames) ---");
        let (elapsed, converted, dropped) = benchmark_pool(frame_count, &config, worker_count);

        let conversion_fps = converted as f64 / elapsed.as_secs_f64();
        println!("  Total time: {elapsed:?}");
        println!("  Converted: {converted}, Dropped: {dropped}");
        println!("  Throughput: {conversion_fps:.1} fps");
        println!(
            "  Can sustain 30fps: {}",
            if conversion_fps >= 30.0 { "YES" } else { "NO" }
        );
        println!();
    }

    println!("--- Alternative Format Tests ---");

    let formats_to_test = [
        (Pixel::UYVY422, Pixel::YUV420P, "UYVY422 -> YUV420P"),
        (Pixel::YUYV422, Pixel::NV12, "YUYV422 -> NV12"),
        (Pixel::BGRA, Pixel::NV12, "BGRA -> NV12"),
    ];

    for (input_format, output_format, name) in formats_to_test {
        let alt_config = ConversionConfig::new(input_format, 1920, 1080, output_format, 1920, 1080);

        if SwscaleConverter::new(alt_config.clone()).is_ok() {
            let time = benchmark_single_threaded(50, &alt_config);
            let avg = time / 50;
            let fps = 1.0 / avg.as_secs_f64();
            println!("  {name}: {fps:.1} fps ({avg:?}/frame)");
        }
    }

    println!("\n--- Real-time Simulations ---");

    for encode_time_ms in [0.1, 1.0, 5.0, 10.0, 20.0] {
        println!("\n  Encode time: {encode_time_ms}ms");
        simulate_realtime_pipeline(
            &config,
            30.0,
            Duration::from_secs(10),
            Duration::from_secs_f64(encode_time_ms / 1000.0),
        );
    }

    println!("\n=== Benchmark Complete ===");
}

fn simulate_realtime_pipeline(
    config: &ConversionConfig,
    target_fps: f64,
    duration: Duration,
    encode_time_per_frame: Duration,
) {
    let frame_interval = Duration::from_secs_f64(1.0 / target_fps);
    let total_frames = (duration.as_secs_f64() * target_fps) as u32;

    let pool_config = ConverterPoolConfig {
        worker_count: 4,
        input_capacity: 60,
        output_capacity: 30,
        drop_strategy: DropStrategy::DropOldest,
    };

    let pool = AsyncConverterPool::from_config(config.clone(), pool_config)
        .expect("Failed to create pool");

    let start = Instant::now();
    let mut next_frame_time = start;
    let mut submitted = 0u32;
    let mut converted = 0u64;
    let mut encode_time_total = Duration::ZERO;

    println!("  Simulating {total_frames} frames at {target_fps:.1} fps over {duration:?}");

    for i in 0..total_frames {
        let now = Instant::now();
        if now < next_frame_time {
            std::thread::sleep(next_frame_time - now);
        }
        next_frame_time += frame_interval;

        let mut frame =
            create_test_frame(config.input_format, config.input_width, config.input_height);
        frame.set_pts(Some(i as i64 * 33333));

        if pool.submit(frame, i as u64).is_ok() {
            submitted += 1;
        }

        while let Some(_converted_frame) = pool.try_recv() {
            converted += 1;
            let encode_start = Instant::now();
            std::thread::sleep(encode_time_per_frame);
            encode_time_total += encode_start.elapsed();
        }
    }

    let drain_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < drain_deadline {
        if pool.recv_timeout(Duration::from_millis(100)).is_some() {
            converted += 1;
        } else {
            break;
        }
    }

    let elapsed = start.elapsed();
    let stats = pool.stats();

    println!("  Elapsed: {elapsed:?}");
    println!(
        "  Submitted: {submitted}, Converted: {converted}, Dropped: {}",
        stats.frames_dropped
    );
    let drop_rate = (stats.frames_dropped as f64 / total_frames as f64) * 100.0;
    println!("  Drop rate: {drop_rate:.1}%");
    println!("  Total encode time: {encode_time_total:?}");

    let expected_duration = Duration::from_secs_f64(total_frames as f64 / target_fps);
    let overhead = if elapsed > expected_duration {
        elapsed - expected_duration
    } else {
        Duration::ZERO
    };
    println!("  Processing overhead: {overhead:?}");

    if stats.frames_dropped == 0 {
        println!("  Result: SUCCESS - No frames dropped!");
    } else {
        println!(
            "  Result: FAILED - {} frames dropped ({:.1}%)",
            stats.frames_dropped,
            (stats.frames_dropped as f64 / total_frames as f64) * 100.0
        );
    }
}
