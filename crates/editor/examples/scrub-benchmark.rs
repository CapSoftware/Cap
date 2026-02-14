use cap_rendering::decoder::spawn_decoder;
use futures::future::join_all;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;
use tokio::runtime::Runtime;

#[derive(Debug, Clone)]
struct Config {
    video_path: PathBuf,
    fps: u32,
    bursts: usize,
    burst_size: usize,
    sweep_seconds: f32,
}

#[derive(Debug, Default)]
struct ScrubStats {
    last_request_latency_ms: Vec<f64>,
    request_latency_ms: Vec<f64>,
    failed_requests: usize,
    successful_requests: usize,
}

fn get_video_duration(path: &PathBuf) -> Result<f32, String> {
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
        .output()
        .map_err(|error| format!("ffprobe spawn failed: {error}"))?;

    if !output.status.success() {
        return Err("ffprobe failed".to_string());
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str
        .trim()
        .parse::<f32>()
        .map_err(|error| format!("invalid duration: {error}"))
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut values = samples.to_vec();
    values.sort_by(f64::total_cmp);
    let index = ((percentile / 100.0) * (values.len().saturating_sub(1) as f64)).round() as usize;
    values[index.min(values.len().saturating_sub(1))]
}

fn generate_burst_targets(
    duration: f32,
    burst_index: usize,
    burst_size: usize,
    sweep: f32,
) -> Vec<f32> {
    let effective_duration = duration.max(0.1);
    let max_target = (effective_duration - 0.01).max(0.0);
    let start = (((burst_index as f32 * 0.618_034) % 1.0) * effective_duration).min(max_target);
    let step = if burst_size > 1 {
        sweep / (burst_size as f32 - 1.0)
    } else {
        0.0
    };

    (0..burst_size)
        .map(|i| (start + step * i as f32).min(max_target))
        .collect()
}

async fn run_scrub_benchmark(config: &Config) -> Result<ScrubStats, String> {
    let duration = get_video_duration(&config.video_path)?;
    if duration <= 0.0 {
        return Err("video duration is zero".to_string());
    }

    let decoder = spawn_decoder(
        "scrub-benchmark",
        config.video_path.clone(),
        config.fps,
        0.0,
        false,
    )
    .await
    .map_err(|error| format!("decoder init failed: {error}"))?;

    let mut stats = ScrubStats::default();

    for burst_index in 0..config.bursts {
        let targets = generate_burst_targets(
            duration,
            burst_index,
            config.burst_size,
            config.sweep_seconds,
        );
        let requests = targets.into_iter().enumerate().map(|(index, target)| {
            let decoder = decoder.clone();
            async move {
                let start = Instant::now();
                let decoded = decoder.get_frame(target).await.is_some();
                let latency_ms = start.elapsed().as_secs_f64() * 1000.0;
                (index, decoded, latency_ms)
            }
        });

        let mut results = join_all(requests).await;
        results.sort_by_key(|(index, _, _)| *index);

        if let Some((_, decoded, latency_ms)) = results.last().copied() {
            if decoded {
                stats.last_request_latency_ms.push(latency_ms);
            }
        }

        for (_, decoded, latency_ms) in results {
            if decoded {
                stats.successful_requests = stats.successful_requests.saturating_add(1);
                stats.request_latency_ms.push(latency_ms);
            } else {
                stats.failed_requests = stats.failed_requests.saturating_add(1);
            }
        }
    }

    Ok(stats)
}

fn print_report(config: &Config, stats: &ScrubStats) {
    println!("\n{}", "=".repeat(68));
    println!("Scrub Burst Benchmark Report");
    println!("{}", "=".repeat(68));
    println!("Video: {}", config.video_path.display());
    println!("FPS: {}", config.fps);
    println!("Bursts: {}", config.bursts);
    println!("Burst size: {}", config.burst_size);
    println!("Sweep seconds: {:.2}", config.sweep_seconds);
    println!("Successful requests: {}", stats.successful_requests);
    println!("Failed requests: {}", stats.failed_requests);

    if !stats.request_latency_ms.is_empty() {
        let avg =
            stats.request_latency_ms.iter().sum::<f64>() / stats.request_latency_ms.len() as f64;
        println!("\nAll Request Latency");
        println!("  avg: {:.2}ms", avg);
        println!(
            "  p95: {:.2}ms",
            percentile(&stats.request_latency_ms, 95.0)
        );
        println!(
            "  p99: {:.2}ms",
            percentile(&stats.request_latency_ms, 99.0)
        );
        println!(
            "  max: {:.2}ms",
            stats
                .request_latency_ms
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
        );
    }

    if !stats.last_request_latency_ms.is_empty() {
        let avg = stats.last_request_latency_ms.iter().sum::<f64>()
            / stats.last_request_latency_ms.len() as f64;
        println!("\nLast Request In Burst Latency");
        println!("  avg: {:.2}ms", avg);
        println!(
            "  p95: {:.2}ms",
            percentile(&stats.last_request_latency_ms, 95.0)
        );
        println!(
            "  p99: {:.2}ms",
            percentile(&stats.last_request_latency_ms, 99.0)
        );
        println!(
            "  max: {:.2}ms",
            stats
                .last_request_latency_ms
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
        );
    }

    println!("{}", "=".repeat(68));
}

fn parse_args() -> Result<Config, String> {
    let args = std::env::args().collect::<Vec<_>>();
    let mut video_path: Option<PathBuf> = None;
    let mut fps = 60u32;
    let mut bursts = 50usize;
    let mut burst_size = 12usize;
    let mut sweep_seconds = 2.0f32;

    let mut index = 1usize;
    while index < args.len() {
        match args[index].as_str() {
            "--video" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --video".to_string());
                }
                video_path = Some(PathBuf::from(&args[index]));
            }
            "--fps" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --fps".to_string());
                }
                fps = args[index]
                    .parse::<u32>()
                    .map_err(|_| "invalid value for --fps".to_string())?;
            }
            "--bursts" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --bursts".to_string());
                }
                bursts = args[index]
                    .parse::<usize>()
                    .map_err(|_| "invalid value for --bursts".to_string())?;
            }
            "--burst-size" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --burst-size".to_string());
                }
                burst_size = args[index]
                    .parse::<usize>()
                    .map_err(|_| "invalid value for --burst-size".to_string())?;
            }
            "--sweep-seconds" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --sweep-seconds".to_string());
                }
                sweep_seconds = args[index]
                    .parse::<f32>()
                    .map_err(|_| "invalid value for --sweep-seconds".to_string())?;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: scrub-benchmark --video <path> [--fps <n>] [--bursts <n>] [--burst-size <n>] [--sweep-seconds <n>]"
                );
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown argument: {unknown}")),
        }
        index += 1;
    }

    let Some(video_path) = video_path else {
        return Err("missing required --video".to_string());
    };
    if !video_path.exists() {
        return Err(format!(
            "video path does not exist: {}",
            video_path.display()
        ));
    }
    if burst_size == 0 {
        return Err("--burst-size must be > 0".to_string());
    }
    if bursts == 0 {
        return Err("--bursts must be > 0".to_string());
    }
    if sweep_seconds <= 0.0 {
        return Err("--sweep-seconds must be > 0".to_string());
    }

    Ok(Config {
        video_path,
        fps,
        bursts,
        burst_size,
        sweep_seconds,
    })
}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let runtime = Runtime::new().expect("failed to create tokio runtime");
    match runtime.block_on(run_scrub_benchmark(&config)) {
        Ok(stats) => print_report(&config, &stats),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
