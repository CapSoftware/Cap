#[cfg(target_os = "windows")]
mod benchmark {
    use cap_frame_converter::{
        AsyncConverterPool, ConversionConfig, ConverterPoolConfig, DropStrategy, FrameConverter,
        SwscaleConverter,
    };
    use ffmpeg::{format::Pixel, frame};
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    const INPUT_FORMAT: Pixel = Pixel::YUYV422;
    const OUTPUT_FORMAT: Pixel = Pixel::NV12;
    const RESOLUTIONS: [(u32, u32); 2] = [(1280, 720), (1920, 1080)];
    const WARMUP_FRAMES: usize = 10;
    const MEASURED_FRAMES: usize = 120;
    const POOL_MEASURED_FRAMES: usize = 60;
    const MAX_IN_FLIGHT: usize = 8;

    fn create_frame(format: Pixel, width: u32, height: u32) -> frame::Video {
        let mut frame = frame::Video::new(format, width, height);
        for plane in 0..frame.planes() {
            for (index, byte) in frame.data_mut(plane).iter_mut().enumerate() {
                *byte = ((index * 17 + plane * 31) % 256) as u8;
            }
        }
        frame.set_pts(Some(0));
        frame
    }

    fn conversion_config(width: u32, height: u32) -> ConversionConfig {
        ConversionConfig::new(INPUT_FORMAT, width, height, OUTPUT_FORMAT, width, height)
    }

    fn benchmark_single_threaded(
        converter: &dyn FrameConverter,
        config: &ConversionConfig,
    ) -> Duration {
        for _ in 0..WARMUP_FRAMES {
            let frame = create_frame(config.input_format, config.input_width, config.input_height);
            let _ = converter.convert(frame).expect("warmup conversion failed");
        }

        let mut total = Duration::ZERO;
        for _ in 0..MEASURED_FRAMES {
            let frame = create_frame(config.input_format, config.input_width, config.input_height);
            let start = Instant::now();
            let _ = converter.convert(frame).expect("conversion failed");
            total += start.elapsed();
        }
        total
    }

    fn pool_config(worker_count: usize) -> ConverterPoolConfig {
        ConverterPoolConfig {
            worker_count,
            input_capacity: MAX_IN_FLIGHT * 2,
            output_capacity: MAX_IN_FLIGHT * 2,
            drop_strategy: DropStrategy::DropOldest,
            frame_pool_capacity: MAX_IN_FLIGHT * 2,
        }
    }

    fn measure_pool(pool: AsyncConverterPool, config: &ConversionConfig) -> (Duration, Duration) {
        let mut frames = (0..WARMUP_FRAMES + POOL_MEASURED_FRAMES)
            .map(|_| create_frame(config.input_format, config.input_width, config.input_height))
            .collect::<Vec<_>>();

        for sequence in 0..WARMUP_FRAMES {
            let frame = frames.pop().expect("warmup frame");
            pool.submit(frame, sequence as u64)
                .expect("warmup submit failed");
        }
        for _ in 0..WARMUP_FRAMES {
            pool.recv_timeout(Duration::from_secs(5))
                .expect("warmup conversion timed out");
        }

        let start = Instant::now();
        let mut next_sequence = 0usize;
        let mut in_flight = 0usize;
        let mut received = 0usize;
        let mut conversion_time = Duration::ZERO;

        while received < POOL_MEASURED_FRAMES {
            while in_flight < MAX_IN_FLIGHT && next_sequence < POOL_MEASURED_FRAMES {
                let frame = frames.pop().expect("measurement frame");
                pool.submit(frame, next_sequence as u64)
                    .expect("submit failed");
                next_sequence += 1;
                in_flight += 1;
            }

            let converted = pool
                .recv_timeout(Duration::from_secs(5))
                .expect("conversion timed out");
            conversion_time += converted.conversion_duration;
            in_flight -= 1;
            received += 1;
        }

        (
            start.elapsed(),
            conversion_time / POOL_MEASURED_FRAMES as u32,
        )
    }

    fn benchmark_pool(
        converter: Arc<dyn FrameConverter>,
        config: &ConversionConfig,
        worker_count: usize,
    ) -> (Duration, Duration) {
        measure_pool(
            AsyncConverterPool::new(converter, pool_config(worker_count)),
            config,
        )
    }

    fn benchmark_pool_from_config(
        config: &ConversionConfig,
        worker_count: usize,
    ) -> (Duration, Duration) {
        let pool = AsyncConverterPool::from_config(config.clone(), pool_config(worker_count))
            .expect("converter pool from config");
        measure_pool(pool, config)
    }

    fn print_pool_result(label: &str, (elapsed, conversion_time): (Duration, Duration)) {
        let per_frame = elapsed / POOL_MEASURED_FRAMES as u32;
        println!(
            "{label}: wall {:?}/frame ({:.1} fps), convert {:?}",
            per_frame,
            1.0 / per_frame.as_secs_f64(),
            conversion_time
        );
    }

    pub fn run() {
        ffmpeg::init().expect("failed to initialize ffmpeg");
        let single_threaded_only = std::env::var_os("BENCH_SINGLE_ONLY").is_some();

        println!("D3D11 frame conversion benchmark");
        println!("Input: {INPUT_FORMAT:?}, output: {OUTPUT_FORMAT:?}\n");

        for (width, height) in RESOLUTIONS {
            let config = conversion_config(width, height);
            println!("--- {width}x{height} ---");

            let swscale = SwscaleConverter::new(config.clone()).expect("swscale converter");
            let swscale_time = benchmark_single_threaded(&swscale, &config);
            let swscale_per_frame = swscale_time / MEASURED_FRAMES as u32;
            println!(
                "swscale single-thread: {:>10?}/frame ({:>6.1} fps)",
                swscale_per_frame,
                1.0 / swscale_per_frame.as_secs_f64()
            );

            match cap_frame_converter::D3D11Converter::new(config.clone()) {
                Ok(d3d11) => {
                    let d3d11_time = benchmark_single_threaded(&d3d11, &config);
                    let d3d11_per_frame = d3d11_time / MEASURED_FRAMES as u32;
                    println!(
                        "d3d11 single-thread:  {:>10?}/frame ({:>6.1} fps, {:.1}x)",
                        d3d11_per_frame,
                        1.0 / d3d11_per_frame.as_secs_f64(),
                        swscale_per_frame.as_secs_f64() / d3d11_per_frame.as_secs_f64()
                    );

                    if !single_threaded_only {
                        let d3d11: Arc<dyn FrameConverter> = Arc::new(d3d11);
                        for worker_count in [1, 2, 4] {
                            print_pool_result(
                                &format!("d3d11 pool ({worker_count} workers, shared)"),
                                benchmark_pool(Arc::clone(&d3d11), &config, worker_count),
                            );
                        }
                        drop(d3d11);

                        for worker_count in [1, 2, 4] {
                            print_pool_result(
                                &format!("d3d11 pool ({worker_count} workers, config)"),
                                benchmark_pool_from_config(&config, worker_count),
                            );
                        }
                    }
                }
                Err(error) => println!("d3d11 unavailable: {error}"),
            }

            if !single_threaded_only {
                let swscale: Arc<dyn FrameConverter> = Arc::new(swscale);
                for worker_count in [1, 2, 4] {
                    print_pool_result(
                        &format!("swscale pool ({worker_count} workers)"),
                        benchmark_pool(Arc::clone(&swscale), &config, worker_count),
                    );
                }
            }

            println!();
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    benchmark::run();
}

#[cfg(not(target_os = "windows"))]
fn main() {
    println!("D3D11 benchmark is only available on Windows");
}
