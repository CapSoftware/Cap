use cap_rendering::decoder::{AsyncVideoDecoderHandle, spawn_decoder};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use tokio::runtime::Runtime;

const DEFAULT_DURATION_SECS: f32 = 60.0;

fn get_video_duration(path: &Path) -> f32 {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let duration_str = String::from_utf8_lossy(&output.stdout);
            duration_str.trim().parse().unwrap_or(DEFAULT_DURATION_SECS)
        }
        _ => {
            eprintln!(
                "Warning: Could not determine video duration via ffprobe, using default {DEFAULT_DURATION_SECS}s"
            );
            DEFAULT_DURATION_SECS
        }
    }
}

#[derive(Debug, Clone)]
struct BenchmarkConfig {
    video_path: PathBuf,
    fps: u32,
    iterations: usize,
    seek_iterations: usize,
}

#[derive(Debug, Default)]
struct SeekDistanceStats {
    distance_secs: f32,
    samples_ms: Vec<f64>,
    failures: usize,
}

#[derive(Debug, Default)]
struct BenchmarkResults {
    decoder_creation_ms: f64,
    sequential_decode_times_ms: Vec<f64>,
    sequential_fps: f64,
    sequential_failures: usize,
    seek_stats: Vec<SeekDistanceStats>,
    random_access_times_ms: Vec<f64>,
    random_access_avg_ms: f64,
    random_access_failures: usize,
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
        if !self.sequential_decode_times_ms.is_empty() || self.sequential_failures > 0 {
            let avg: f64 = if self.sequential_decode_times_ms.is_empty() {
                0.0
            } else {
                self.sequential_decode_times_ms.iter().sum::<f64>()
                    / self.sequential_decode_times_ms.len() as f64
            };
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
            if self.sequential_failures > 0 {
                println!("  Frames failed: {}", self.sequential_failures);
            }
            println!("  Avg decode time: {avg:.2}ms");
            println!("  Min decode time: {min:.2}ms");
            println!("  Max decode time: {max:.2}ms");
            println!("  Effective FPS: {:.1}", self.sequential_fps);
        }
        println!();

        println!("SEEK PERFORMANCE (by distance)");
        if !self.seek_stats.is_empty() {
            println!(
                "  {:>10} | {:>12} | {:>12} | {:>12} | {:>7} | {:>8}",
                "Distance(s)", "Avg(ms)", "P95(ms)", "Max(ms)", "Samples", "Failures"
            );
            println!(
                "  {}-+-{}-+-{}-+-{}-+-{}-+-{}",
                "-".repeat(10),
                "-".repeat(12),
                "-".repeat(12),
                "-".repeat(12),
                "-".repeat(7),
                "-".repeat(8)
            );
            for stats in &self.seek_stats {
                let avg = if stats.samples_ms.is_empty() {
                    0.0
                } else {
                    stats.samples_ms.iter().sum::<f64>() / stats.samples_ms.len() as f64
                };
                let max = stats
                    .samples_ms
                    .iter()
                    .copied()
                    .fold(f64::NEG_INFINITY, f64::max);
                let p95 = percentile(&stats.samples_ms, 95.0);
                println!(
                    "  {:>10.1} | {:>12.2} | {:>12.2} | {:>12.2} | {:>7} | {:>8}",
                    stats.distance_secs,
                    avg,
                    p95,
                    if max.is_finite() { max } else { 0.0 },
                    stats.samples_ms.len(),
                    stats.failures
                );
            }
        }
        println!();

        println!("RANDOM ACCESS PERFORMANCE");
        if !self.random_access_times_ms.is_empty() || self.random_access_failures > 0 {
            let avg = if self.random_access_times_ms.is_empty() {
                0.0
            } else {
                self.random_access_times_ms.iter().sum::<f64>()
                    / self.random_access_times_ms.len() as f64
            };
            let min = self
                .random_access_times_ms
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min);
            let max = self
                .random_access_times_ms
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            println!("  Samples: {}", self.random_access_times_ms.len());
            if self.random_access_failures > 0 {
                println!("  Failures: {}", self.random_access_failures);
            }
            println!("  Avg access time: {avg:.2}ms");
            println!("  Min access time: {min:.2}ms");
            println!("  Max access time: {max:.2}ms");
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
    let filtered: Vec<f64> = data.iter().copied().filter(|x| !x.is_nan()).collect();
    if filtered.is_empty() {
        return 0.0;
    }
    let mut sorted = filtered;
    sorted.sort_by(|a, b| {
        a.partial_cmp(b)
            .expect("NaN values should have been filtered out")
    });
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn benchmark_decoder_creation(path: &Path, fps: u32, iterations: usize) -> f64 {
    let mut total_ms = 0.0;

    for i in 0..iterations {
        let start = Instant::now();
        let decoder = spawn_decoder("benchmark", path.to_path_buf(), fps, 0.0, false).await;
        let elapsed = start.elapsed();

        match decoder {
            Ok(_) => {
                total_ms += elapsed.as_secs_f64() * 1000.0;
            }
            Err(e) => {
                if i == 0 {
                    eprintln!("Failed to create decoder: {e}");
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
) -> (Vec<f64>, f64, usize) {
    let mut times = Vec::with_capacity(frame_count);
    let mut failures = 0;
    let overall_start = Instant::now();

    for i in 0..frame_count {
        let time = start_time + (i as f32 / fps as f32);
        let start = Instant::now();
        match decoder.get_frame(time).await {
            Some(_frame) => {
                let elapsed = start.elapsed();
                times.push(elapsed.as_secs_f64() * 1000.0);
            }
            None => {
                failures += 1;
                eprintln!("Failed to get frame at time {time:.3}s");
            }
        }
    }

    let overall_elapsed = overall_start.elapsed();
    let successful_frames = frame_count - failures;
    let effective_fps = if overall_elapsed.as_secs_f64() > 0.0 {
        successful_frames as f64 / overall_elapsed.as_secs_f64()
    } else {
        0.0
    };

    (times, effective_fps, failures)
}

async fn benchmark_seek(
    decoder: &AsyncVideoDecoderHandle,
    _fps: u32,
    from_time: f32,
    to_time: f32,
) -> Option<f64> {
    if decoder.get_frame(from_time).await.is_none() {
        eprintln!("Failed to get initial frame at time {from_time:.3}s for seek benchmark");
        return None;
    }

    let start = Instant::now();
    match decoder.get_frame(to_time).await {
        Some(_frame) => {
            let elapsed = start.elapsed();
            Some(elapsed.as_secs_f64() * 1000.0)
        }
        None => {
            eprintln!("Failed to get frame at time {to_time:.3}s for seek benchmark");
            None
        }
    }
}

async fn benchmark_random_access(
    decoder: &AsyncVideoDecoderHandle,
    _fps: u32,
    duration_secs: f32,
    sample_count: usize,
) -> (Vec<f64>, usize) {
    let mut times = Vec::with_capacity(sample_count);
    let mut failures = 0;

    let golden_ratio = 1.618_034_f32;
    let mut position = 0.0_f32;

    for _ in 0..sample_count {
        position = (position + golden_ratio * duration_secs) % duration_secs;
        let start = Instant::now();
        match decoder.get_frame(position).await {
            Some(_frame) => {
                let elapsed = start.elapsed();
                times.push(elapsed.as_secs_f64() * 1000.0);
            }
            None => {
                failures += 1;
                eprintln!("Failed to get frame at position {position:.3}s during random access");
            }
        }
    }

    (times, failures)
}

async fn run_full_benchmark(config: BenchmarkConfig) -> BenchmarkResults {
    let mut results = BenchmarkResults::default();

    println!(
        "Starting benchmark with video: {}",
        config.video_path.display()
    );
    println!(
        "FPS: {}, Iterations: {}, Seek Iterations: {}",
        config.fps, config.iterations, config.seek_iterations
    );
    println!();

    println!("[1/5] Benchmarking decoder creation...");
    results.decoder_creation_ms =
        benchmark_decoder_creation(&config.video_path, config.fps, config.iterations).await;
    if results.decoder_creation_ms < 0.0 {
        eprintln!("Failed to benchmark decoder creation");
        return results;
    }
    println!("      Done: {:.2}ms avg", results.decoder_creation_ms);

    println!("[2/5] Creating decoder for remaining tests...");
    let decoder = match spawn_decoder(
        "benchmark",
        config.video_path.clone(),
        config.fps,
        0.0,
        false,
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to create decoder: {e}");
            return results;
        }
    };
    println!("      Done");

    let video_duration = get_video_duration(&config.video_path);
    println!("Detected video duration: {video_duration:.2}s");
    println!();

    println!("[3/5] Benchmarking sequential decode (100 frames from start)...");
    let (seq_times, seq_fps, seq_failures) =
        benchmark_sequential_decode(&decoder, config.fps, 100, 0.0).await;
    results.sequential_decode_times_ms = seq_times;
    results.sequential_fps = seq_fps;
    results.sequential_failures = seq_failures;
    println!("      Done: {seq_fps:.1} effective FPS");
    if seq_failures > 0 {
        println!("      Warning: {seq_failures} frames failed to decode");
    }

    println!("[4/5] Benchmarking seek performance...");
    let seek_distances: Vec<f32> = vec![0.5, 1.0, 2.0, 5.0, 10.0, 30.0]
        .into_iter()
        .filter(|&d| d <= video_duration)
        .collect();
    for distance in seek_distances {
        let mut stats = SeekDistanceStats {
            distance_secs: distance,
            ..Default::default()
        };
        let seek_target_ceiling = (video_duration - 0.01).max(0.0);
        let start_ceiling = (video_duration - distance - 0.01).max(0.0);
        for _ in 0..config.seek_iterations {
            let iteration = (stats.samples_ms.len() + stats.failures) as f32;
            let from_time = if start_ceiling > 0.0 {
                (iteration * 0.618_034 * start_ceiling) % start_ceiling
            } else {
                0.0
            };
            let to_time = (from_time + distance).min(seek_target_ceiling);
            match benchmark_seek(&decoder, config.fps, from_time, to_time).await {
                Some(seek_time) => stats.samples_ms.push(seek_time),
                None => stats.failures += 1,
            }
        }
        let avg = if stats.samples_ms.is_empty() {
            0.0
        } else {
            stats.samples_ms.iter().sum::<f64>() / stats.samples_ms.len() as f64
        };
        let p95 = percentile(&stats.samples_ms, 95.0);
        println!(
            "      {distance:.1}s seek: avg {avg:.2}ms, p95 {p95:.2}ms ({} samples, {} failures)",
            stats.samples_ms.len(),
            stats.failures
        );
        results.seek_stats.push(stats);
    }

    println!("[5/5] Benchmarking random access (50 samples)...");
    let (random_times, random_failures) =
        benchmark_random_access(&decoder, config.fps, video_duration, 50).await;
    results.random_access_times_ms = random_times;
    results.random_access_failures = random_failures;
    results.random_access_avg_ms = if results.random_access_times_ms.is_empty() {
        0.0
    } else {
        results.random_access_times_ms.iter().sum::<f64>()
            / results.random_access_times_ms.len() as f64
    };
    println!("      Done: {:.2}ms avg", results.random_access_avg_ms);
    if random_failures > 0 {
        println!("      Warning: {random_failures} random accesses failed");
    }

    results
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let video_path = args
        .iter()
        .position(|a| a == "--video")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .expect("Usage: decode-benchmark --video <path> [--fps <fps>] [--iterations <n>] [--seek-iterations <n>]");

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

    let seek_iterations = args
        .iter()
        .position(|a| a == "--seek-iterations")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let config = BenchmarkConfig {
        video_path,
        fps,
        iterations,
        seek_iterations,
    };

    let rt = Runtime::new().expect("Failed to create Tokio runtime");
    let results = rt.block_on(run_full_benchmark(config));

    results.print_report();
}
