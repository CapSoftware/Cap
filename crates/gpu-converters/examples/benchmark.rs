use cap_gpu_converters::{
    CameraFormat, CameraInput, ConversionPreset, FallbackStrategy, GPUCameraConverter,
};
use std::time::{Duration, Instant};

/// Benchmark configuration
#[derive(Debug, Clone)]
struct BenchmarkConfig {
    width: u32,
    height: u32,
    format: CameraFormat,
    target_width: u32,
    target_height: u32,
    iterations: usize,
    preset: ConversionPreset,
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            format: CameraFormat::NV12,
            target_width: 1280,
            target_height: 720,
            iterations: 100,
            preset: ConversionPreset::Balanced,
        }
    }
}

/// Benchmark results
#[derive(Debug)]
struct BenchmarkResults {
    config: BenchmarkConfig,
    total_duration: Duration,
    average_duration: Duration,
    min_duration: Duration,
    max_duration: Duration,
    throughput_mbps: f64,
    pixels_per_second: f64,
    success_rate: f64,
    gpu_fallback_count: usize,
}

impl BenchmarkResults {
    fn print_summary(&self) {
        println!("\n=== Benchmark Results ===");
        println!("Configuration:");
        println!(
            "  Input: {}x{} {:?}",
            self.config.width, self.config.height, self.config.format
        );
        println!(
            "  Output: {}x{} RGBA",
            self.config.target_width, self.config.target_height
        );
        println!("  Preset: {:?}", self.config.preset);
        println!("  Iterations: {}", self.config.iterations);

        println!("\nPerformance:");
        println!(
            "  Average: {:.2}ms",
            self.average_duration.as_secs_f64() * 1000.0
        );
        println!("  Min: {:.2}ms", self.min_duration.as_secs_f64() * 1000.0);
        println!("  Max: {:.2}ms", self.max_duration.as_secs_f64() * 1000.0);
        println!("  Throughput: {:.2} MB/s", self.throughput_mbps);
        println!("  Pixels/sec: {:.0}", self.pixels_per_second);
        println!("  Success rate: {:.1}%", self.success_rate * 100.0);
        println!("  Total time: {:.2}s", self.total_duration.as_secs_f64());

        if self.gpu_fallback_count > 0 {
            println!("  GPU fallbacks: {}", self.gpu_fallback_count);
        }
    }
}

/// Generate test data for a given format
fn generate_test_data(format: CameraFormat, width: u32, height: u32) -> Vec<u8> {
    let size = (width * height) as usize;

    match format {
        CameraFormat::NV12 => {
            let mut data = vec![128u8; (size as f32 * 1.5) as usize]; // Y + UV planes

            // Generate some pattern in Y plane
            for y in 0..height {
                for x in 0..width {
                    let idx = (y * width + x) as usize;
                    data[idx] = ((x + y) % 256) as u8;
                }
            }

            // Simple UV pattern
            for i in size..(size + size / 2) {
                data[i] = ((i % 256) as u8).wrapping_add(128);
            }

            data
        }
        CameraFormat::UYVY | CameraFormat::YUYV => {
            let mut data = vec![0u8; size * 2];

            for i in (0..data.len()).step_by(4) {
                if format == CameraFormat::UYVY {
                    data[i] = 128; // U
                    data[i + 1] = ((i / 4) % 256) as u8; // Y1
                    data[i + 2] = 128; // V
                    data[i + 3] = ((i / 4 + 1) % 256) as u8; // Y2
                } else {
                    data[i] = ((i / 4) % 256) as u8; // Y1
                    data[i + 1] = 128; // U
                    data[i + 2] = ((i / 4 + 1) % 256) as u8; // Y2
                    data[i + 3] = 128; // V
                }
            }

            data
        }
        CameraFormat::YUV420P => {
            let mut data = vec![0u8; (size as f32 * 1.5) as usize];

            // Y plane
            for i in 0..size {
                data[i] = (i % 256) as u8;
            }

            // U plane
            for i in size..(size + size / 4) {
                data[i] = 128;
            }

            // V plane
            for i in (size + size / 4)..(size + size / 2) {
                data[i] = 128;
            }

            data
        }
        CameraFormat::BGRA | CameraFormat::RGBA => {
            let mut data = vec![0u8; size * 4];

            for i in (0..data.len()).step_by(4) {
                let pixel = i / 4;
                data[i] = (pixel % 256) as u8; // B/R
                data[i + 1] = ((pixel / 256) % 256) as u8; // G
                data[i + 2] = ((pixel / 512) % 256) as u8; // R/B
                data[i + 3] = 255; // A
            }

            data
        }
        CameraFormat::RGB24 => {
            let mut data = vec![0u8; size * 3];

            for i in (0..data.len()).step_by(3) {
                let pixel = i / 3;
                data[i] = (pixel % 256) as u8; // R
                data[i + 1] = ((pixel / 256) % 256) as u8; // G
                data[i + 2] = ((pixel / 512) % 256) as u8; // B
            }

            data
        }
        CameraFormat::Unknown => vec![],
    }
}

/// Run benchmark for a specific configuration
async fn run_benchmark(
    config: BenchmarkConfig,
) -> Result<BenchmarkResults, Box<dyn std::error::Error>> {
    println!(
        "Running benchmark: {}x{} {:?} -> {}x{} RGBA ({} iterations)",
        config.width,
        config.height,
        config.format,
        config.target_width,
        config.target_height,
        config.iterations
    );

    // Create converter with specified preset
    let mut converter = GPUCameraConverter::with_preset(config.preset).await?;

    // Enable CPU fallback for testing
    converter.enable_fallback(FallbackStrategy::CpuConversion);
    converter.enable_performance_tracking();

    // Generate test data
    let test_data = generate_test_data(config.format, config.width, config.height);
    println!("Generated test data: {} bytes", test_data.len());

    let input = CameraInput::new(&test_data, config.format, config.width, config.height);

    // Warm up
    println!("Warming up...");
    for _ in 0..5 {
        let _ = converter
            .convert_and_scale(
                &input,
                config.target_width,
                config.target_height,
                config.preset.scaling_quality(),
            )
            .await;
    }

    // Run benchmark
    println!("Running benchmark...");
    let mut durations = Vec::with_capacity(config.iterations);
    let mut success_count = 0;
    let mut fallback_count = 0;

    let start_time = Instant::now();

    for i in 0..config.iterations {
        if i % (config.iterations / 10) == 0 {
            print!(".");
            std::io::Write::flush(&mut std::io::stdout()).unwrap();
        }

        let iter_start = Instant::now();

        match converter
            .convert_and_scale(
                &input,
                config.target_width,
                config.target_height,
                config.preset.scaling_quality(),
            )
            .await
        {
            Ok(_) => {
                success_count += 1;
                durations.push(iter_start.elapsed());
            }
            Err(_) => {
                fallback_count += 1;
            }
        }
    }

    println!(" Done!");

    let total_duration = start_time.elapsed();

    if durations.is_empty() {
        return Err("All iterations failed".into());
    }

    // Calculate statistics
    let average_duration = total_duration / config.iterations as u32;
    let min_duration = *durations.iter().min().unwrap();
    let max_duration = *durations.iter().max().unwrap();

    // Calculate throughput
    let input_mb = test_data.len() as f64 / (1024.0 * 1024.0);
    let total_mb = input_mb * success_count as f64;
    let throughput_mbps = total_mb / total_duration.as_secs_f64();

    let pixels = (config.width * config.height) as f64;
    let total_pixels = pixels * success_count as f64;
    let pixels_per_second = total_pixels / total_duration.as_secs_f64();

    let success_rate = success_count as f64 / config.iterations as f64;

    // Get performance summary from converter
    if let Some(perf_summary) = converter.get_performance_summary() {
        println!("\nDetailed Performance:");
        println!("{}", perf_summary);
    }

    // Get memory usage
    if let Some(memory_usage) = converter.get_memory_usage() {
        println!("Memory Usage: {}", memory_usage);
    }

    Ok(BenchmarkResults {
        config,
        total_duration,
        average_duration,
        min_duration,
        max_duration,
        throughput_mbps,
        pixels_per_second,
        success_rate,
        gpu_fallback_count: fallback_count,
    })
}

/// Compare different presets
async fn compare_presets() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Preset Comparison ===");

    let base_config = BenchmarkConfig {
        iterations: 50,
        ..Default::default()
    };

    let presets = vec![
        ConversionPreset::Performance,
        ConversionPreset::Balanced,
        ConversionPreset::Quality,
    ];

    for preset in presets {
        let config = BenchmarkConfig {
            preset,
            ..base_config.clone()
        };

        match run_benchmark(config).await {
            Ok(results) => results.print_summary(),
            Err(e) => println!("Benchmark failed for {:?}: {}", preset, e),
        }
    }

    Ok(())
}

/// Test different formats
async fn test_formats() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Format Comparison ===");

    let formats = vec![
        CameraFormat::NV12,
        CameraFormat::UYVY,
        CameraFormat::YUYV,
        CameraFormat::YUV420P,
        CameraFormat::BGRA,
        CameraFormat::RGB24,
    ];

    for format in formats {
        let config = BenchmarkConfig {
            format,
            iterations: 30,
            ..Default::default()
        };

        match run_benchmark(config).await {
            Ok(results) => results.print_summary(),
            Err(e) => println!("Benchmark failed for {:?}: {}", format, e),
        }
    }

    Ok(())
}

/// Test different resolutions
async fn test_resolutions() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Resolution Scaling Test ===");

    let resolutions = vec![
        (640, 480, 1280, 720),    // SD to HD
        (1280, 720, 1920, 1080),  // HD to FHD
        (1920, 1080, 3840, 2160), // FHD to 4K
        (3840, 2160, 1920, 1080), // 4K to FHD (downscale)
    ];

    for (width, height, target_width, target_height) in resolutions {
        let config = BenchmarkConfig {
            width,
            height,
            target_width,
            target_height,
            iterations: 20,
            ..Default::default()
        };

        match run_benchmark(config).await {
            Ok(results) => results.print_summary(),
            Err(e) => println!(
                "Benchmark failed for {}x{}->{}: {}",
                width, height, target_width, e
            ),
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("GPU Video Format Conversion Benchmark");
    println!("=====================================");

    // Test if GPU is available
    match GPUCameraConverter::new().await {
        Ok(converter) => {
            println!("✅ GPU converter initialized successfully");
            if let Some(memory) = converter.get_memory_usage() {
                println!("Initial memory state: {}", memory);
            }
        }
        Err(e) => {
            println!("❌ Failed to initialize GPU converter: {}", e);
            println!("This benchmark requires a GPU with WGPU support");
            return Ok(());
        }
    }

    // Parse command line arguments for specific tests
    let args: Vec<String> = std::env::args().collect();

    if args.len() > 1 {
        match args[1].as_str() {
            "presets" => compare_presets().await?,
            "formats" => test_formats().await?,
            "resolutions" => test_resolutions().await?,
            "all" => {
                compare_presets().await?;
                test_formats().await?;
                test_resolutions().await?;
            }
            _ => {
                println!("Usage: {} [presets|formats|resolutions|all]", args[0]);
                return Ok(());
            }
        }
    } else {
        // Run default benchmark
        let config = BenchmarkConfig::default();
        let results = run_benchmark(config).await?;
        results.print_summary();
    }

    println!("\n✅ Benchmark completed successfully!");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_test_data() {
        let data = generate_test_data(CameraFormat::NV12, 640, 480);
        let expected_size = (640 * 480) as f32 * 1.5;
        assert_eq!(data.len(), expected_size as usize);

        let data = generate_test_data(CameraFormat::RGBA, 100, 100);
        assert_eq!(data.len(), 100 * 100 * 4);
    }

    #[tokio::test]
    #[ignore] // Requires GPU
    async fn test_benchmark_run() {
        let config = BenchmarkConfig {
            width: 320,
            height: 240,
            target_width: 160,
            target_height: 120,
            iterations: 5,
            ..Default::default()
        };

        let result = run_benchmark(config).await;
        assert!(result.is_ok());

        let results = result.unwrap();
        assert!(results.success_rate > 0.0);
        assert!(results.throughput_mbps > 0.0);
    }
}
