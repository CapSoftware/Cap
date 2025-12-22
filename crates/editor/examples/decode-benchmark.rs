use cap_rendering::decoder::{AsyncVideoDecoderHandle, spawn_decoder};
use std::path::PathBuf;
use std::time::Instant;
use tokio::runtime::Runtime;

#[derive(Debug, Clone)]
struct BenchmarkConfig {
    video_path: PathBuf,
    fps: u32,
    iterations: usize,
}

#[derive(Debug, Default)]
struct BenchmarkResults {
    decoder_creation_ms: f64,
    sequential_decode_times_ms: Vec<f64>,
    sequential_fps: f64,
    seek_times_by_distance: Vec<(f32, f64)>,
    random_access_times_ms: Vec<f64>,
    random_access_avg_ms: f64,
    cache_hits: usize,
    cache_misses: usize,
}

impl BenchmarkResults {
    fn print_report(&self) {
        println!("\n{}", "=".repeat(60));
        println!("           VIDEO DECODE BENCHMARK RESULTS");
        println!("{}\n", "=".repeat(60));

        println!("DECODER CREATION");
        println!(
            "  Time to create decoder: {:.2}ms",
            self.decoder_creation_ms
        );
        println!();

        println!("SEQUENTIAL DECODE PERFORMANCE");
        if !self.sequential_decode_times_ms.is_empty() {
            let avg: f64 = self.sequential_decode_times_ms.iter().sum::<f64>()
                / self.sequential_decode_times_ms.len() as f64;
            let min = self
                .sequential_decode_times_ms
                .iter()
                .cloned()
                .fold(f64::INFINITY, f64::min);
            let max = self
                .sequential_decode_times_ms
                .iter()
                .cloned()
                .fold(f64::NEG_INFINITY, f64::max);
            println!(
                "  Frames decoded: {}",
                self.sequential_decode_times_ms.len()
            );
            println!("  Avg decode time: {:.2}ms", avg);
            println!("  Min decode time: {:.2}ms", min);
            println!("  Max decode time: {:.2}ms", max);
            println!("  Effective FPS: {:.1}", self.sequential_fps);
        }
        println!();

        println!("SEEK PERFORMANCE (by distance)");
        if !self.seek_times_by_distance.is_empty() {
            println!("  {:>10} | {:>12}", "Distance(s)", "Time(ms)");
            println!("  {}-+-{}", "-".repeat(10), "-".repeat(12));
            for (distance, time) in &self.seek_times_by_distance {
                println!("  {:>10.1} | {:>12.2}", distance, time);
            }
        }
        println!();

        println!("RANDOM ACCESS PERFORMANCE");
        if !self.random_access_times_ms.is_empty() {
            let avg = self.random_access_times_ms.iter().sum::<f64>()
                / self.random_access_times_ms.len() as f64;
            let min = self
                .random_access_times_ms
                .iter()
                .cloned()
                .fold(f64::INFINITY, f64::min);
            let max = self
                .random_access_times_ms
                .iter()
                .cloned()
                .fold(f64::NEG_INFINITY, f64::max);
            println!("  Samples: {}", self.random_access_times_ms.len());
            println!("  Avg access time: {:.2}ms", avg);
            println!("  Min access time: {:.2}ms", min);
            println!("  Max access time: {:.2}ms", max);
            println!(
                "  P50: {:.2}ms",
                percentile(&self.random_access_times_ms, 50.0)
            );
            println!(
                "  P95: {:.2}ms",
                percentile(&self.random_access_times_ms, 95.0)
            );
            println!(
                "  P99: {:.2}ms",
                percentile(&self.random_access_times_ms, 99.0)
            );
        }
        println!();

        let total = self.cache_hits + self.cache_misses;
        if total > 0 {
            println!("CACHE STATISTICS");
            println!(
                "  Hits: {} ({:.1}%)",
                self.cache_hits,
                100.0 * self.cache_hits as f64 / total as f64
            );
            println!(
                "  Misses: {} ({:.1}%)",
                self.cache_misses,
                100.0 * self.cache_misses as f64 / total as f64
            );
        }

        println!("\n{}\n", "=".repeat(60));
    }
}

fn percentile(data: &[f64], p: f64) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn benchmark_decoder_creation(path: &PathBuf, fps: u32, iterations: usize) -> f64 {
    let mut total_ms = 0.0;

    for i in 0..iterations {
        let start = Instant::now();
        let decoder = spawn_decoder("benchmark", path.clone(), fps, 0.0).await;
        let elapsed = start.elapsed();

        match decoder {
            Ok(_) => {
                total_ms += elapsed.as_secs_f64() * 1000.0;
            }
            Err(e) => {
                if i == 0 {
                    eprintln!("Failed to create decoder: {}", e);
                    return -1.0;
                }
            }
        }
    }

    total_ms / iterations as f64
}

async fn benchmark_sequential_decode(
    decoder: &AsyncVideoDecoderHandle,
    fps: u32,
    frame_count: usize,
    start_time: f32,
) -> (Vec<f64>, f64) {
    let mut times = Vec::with_capacity(frame_count);
    let overall_start = Instant::now();

    for i in 0..frame_count {
        let time = start_time + (i as f32 / fps as f32);
        let start = Instant::now();
        let _frame = decoder.get_frame(time).await;
        let elapsed = start.elapsed();
        times.push(elapsed.as_secs_f64() * 1000.0);
    }

    let overall_elapsed = overall_start.elapsed();
    let effective_fps = frame_count as f64 / overall_elapsed.as_secs_f64();

    (times, effective_fps)
}

async fn benchmark_seek(
    decoder: &AsyncVideoDecoderHandle,
    _fps: u32,
    from_time: f32,
    to_time: f32,
) -> f64 {
    let _ = decoder.get_frame(from_time).await;

    let start = Instant::now();
    let _frame = decoder.get_frame(to_time).await;
    let elapsed = start.elapsed();

    elapsed.as_secs_f64() * 1000.0
}

async fn benchmark_random_access(
    decoder: &AsyncVideoDecoderHandle,
    _fps: u32,
    duration_secs: f32,
    sample_count: usize,
) -> Vec<f64> {
    let mut times = Vec::with_capacity(sample_count);

    let golden_ratio = 1.618033988749895_f32;
    let mut position = 0.0_f32;

    for _ in 0..sample_count {
        position = (position + golden_ratio * duration_secs) % duration_secs;
        let start = Instant::now();
        let _frame = decoder.get_frame(position).await;
        let elapsed = start.elapsed();
        times.push(elapsed.as_secs_f64() * 1000.0);
    }

    times
}

async fn run_full_benchmark(config: BenchmarkConfig) -> BenchmarkResults {
    let mut results = BenchmarkResults::default();

    println!(
        "Starting benchmark with video: {}",
        config.video_path.display()
    );
    println!("FPS: {}, Iterations: {}", config.fps, config.iterations);
    println!();

    println!("[1/5] Benchmarking decoder creation...");
    results.decoder_creation_ms =
        benchmark_decoder_creation(&config.video_path, config.fps, 3).await;
    if results.decoder_creation_ms < 0.0 {
        eprintln!("Failed to benchmark decoder creation");
        return results;
    }
    println!("      Done: {:.2}ms avg", results.decoder_creation_ms);

    println!("[2/5] Creating decoder for remaining tests...");
    let decoder = match spawn_decoder("benchmark", config.video_path.clone(), config.fps, 0.0).await
    {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to create decoder: {}", e);
            return results;
        }
    };
    println!("      Done");

    println!("[3/5] Benchmarking sequential decode (100 frames from start)...");
    let (seq_times, seq_fps) = benchmark_sequential_decode(&decoder, config.fps, 100, 0.0).await;
    results.sequential_decode_times_ms = seq_times;
    results.sequential_fps = seq_fps;
    println!("      Done: {:.1} effective FPS", seq_fps);

    println!("[4/5] Benchmarking seek performance...");
    let seek_distances = vec![0.5, 1.0, 2.0, 5.0, 10.0, 30.0];
    for distance in seek_distances {
        let seek_time = benchmark_seek(&decoder, config.fps, 0.0, distance).await;
        results.seek_times_by_distance.push((distance, seek_time));
        println!("      {:.1}s seek: {:.2}ms", distance, seek_time);
    }

    println!("[5/5] Benchmarking random access (50 samples)...");
    let video_duration = 60.0f32;
    results.random_access_times_ms =
        benchmark_random_access(&decoder, config.fps, video_duration, 50).await;
    results.random_access_avg_ms = if results.random_access_times_ms.is_empty() {
        0.0
    } else {
        results.random_access_times_ms.iter().sum::<f64>()
            / results.random_access_times_ms.len() as f64
    };
    println!("      Done: {:.2}ms avg", results.random_access_avg_ms);

    results
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let video_path = args
        .iter()
        .position(|a| a == "--video")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .expect("Usage: decode-benchmark --video <path> [--fps <fps>] [--iterations <n>]");

    let fps = args
        .iter()
        .position(|a| a == "--fps")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    let iterations = args
        .iter()
        .position(|a| a == "--iterations")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);

    let config = BenchmarkConfig {
        video_path,
        fps,
        iterations,
    };

    let rt = Runtime::new().expect("Failed to create Tokio runtime");
    let results = rt.block_on(run_full_benchmark(config));

    results.print_report();
}
