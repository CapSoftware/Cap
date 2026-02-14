use cap_rendering::decoder::spawn_decoder;
use futures::future::join_all;
use std::fs::OpenOptions;
use std::io::Write;
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
    runs: usize,
    output_csv: Option<PathBuf>,
    run_label: Option<String>,
}

#[derive(Debug, Default)]
struct ScrubStats {
    last_request_latency_ms: Vec<f64>,
    request_latency_ms: Vec<f64>,
    failed_requests: usize,
    successful_requests: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct ScrubSummary {
    all_avg_ms: f64,
    all_p95_ms: f64,
    all_p99_ms: f64,
    all_max_ms: f64,
    last_avg_ms: f64,
    last_p95_ms: f64,
    last_p99_ms: f64,
    last_max_ms: f64,
    successful_requests: usize,
    failed_requests: usize,
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

fn summarize(stats: &ScrubStats) -> ScrubSummary {
    let all_avg_ms = if stats.request_latency_ms.is_empty() {
        0.0
    } else {
        stats.request_latency_ms.iter().sum::<f64>() / stats.request_latency_ms.len() as f64
    };

    let all_max_ms = stats
        .request_latency_ms
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);

    let last_avg_ms = if stats.last_request_latency_ms.is_empty() {
        0.0
    } else {
        stats.last_request_latency_ms.iter().sum::<f64>()
            / stats.last_request_latency_ms.len() as f64
    };

    let last_max_ms = stats
        .last_request_latency_ms
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);

    ScrubSummary {
        all_avg_ms,
        all_p95_ms: percentile(&stats.request_latency_ms, 95.0),
        all_p99_ms: percentile(&stats.request_latency_ms, 99.0),
        all_max_ms: if all_max_ms.is_finite() {
            all_max_ms
        } else {
            0.0
        },
        last_avg_ms,
        last_p95_ms: percentile(&stats.last_request_latency_ms, 95.0),
        last_p99_ms: percentile(&stats.last_request_latency_ms, 99.0),
        last_max_ms: if last_max_ms.is_finite() {
            last_max_ms
        } else {
            0.0
        },
        successful_requests: stats.successful_requests,
        failed_requests: stats.failed_requests,
    }
}

fn median_of(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut values = samples.to_vec();
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn aggregate_summaries(summaries: &[ScrubSummary]) -> ScrubSummary {
    if summaries.is_empty() {
        return ScrubSummary::default();
    }

    let all_avg_ms = summaries.iter().map(|s| s.all_avg_ms).collect::<Vec<_>>();
    let all_p95_ms = summaries.iter().map(|s| s.all_p95_ms).collect::<Vec<_>>();
    let all_p99_ms = summaries.iter().map(|s| s.all_p99_ms).collect::<Vec<_>>();
    let all_max_ms = summaries.iter().map(|s| s.all_max_ms).collect::<Vec<_>>();
    let last_avg_ms = summaries.iter().map(|s| s.last_avg_ms).collect::<Vec<_>>();
    let last_p95_ms = summaries.iter().map(|s| s.last_p95_ms).collect::<Vec<_>>();
    let last_p99_ms = summaries.iter().map(|s| s.last_p99_ms).collect::<Vec<_>>();
    let last_max_ms = summaries.iter().map(|s| s.last_max_ms).collect::<Vec<_>>();

    ScrubSummary {
        all_avg_ms: median_of(&all_avg_ms),
        all_p95_ms: median_of(&all_p95_ms),
        all_p99_ms: median_of(&all_p99_ms),
        all_max_ms: median_of(&all_max_ms),
        last_avg_ms: median_of(&last_avg_ms),
        last_p95_ms: median_of(&last_p95_ms),
        last_p99_ms: median_of(&last_p99_ms),
        last_max_ms: median_of(&last_max_ms),
        successful_requests: summaries.iter().map(|s| s.successful_requests).sum(),
        failed_requests: summaries.iter().map(|s| s.failed_requests).sum(),
    }
}

fn scrub_env_value(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

fn scrub_run_label(config: &Config) -> String {
    config
        .run_label
        .as_ref()
        .cloned()
        .or_else(|| std::env::var("CAP_SCRUB_BENCHMARK_RUN_LABEL").ok())
        .unwrap_or_default()
}

fn write_csv(
    path: &PathBuf,
    config: &Config,
    summaries: &[ScrubSummary],
    aggregate: ScrubSummary,
) -> Result<(), String> {
    let file_exists = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;

    if !file_exists {
        let header = [
            "timestamp_ms",
            "scope",
            "run_index",
            "run_label",
            "video",
            "fps",
            "bursts",
            "burst_size",
            "sweep_seconds",
            "runs",
            "supersede_disabled",
            "supersede_min_pixels",
            "supersede_min_requests",
            "supersede_min_span_frames",
            "all_avg_ms",
            "all_p95_ms",
            "all_p99_ms",
            "all_max_ms",
            "last_avg_ms",
            "last_p95_ms",
            "last_p99_ms",
            "last_max_ms",
            "successful_requests",
            "failed_requests",
        ]
        .join(",");
        writeln!(file, "{header}")
            .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    let supersede_disabled = scrub_env_value("CAP_FFMPEG_SCRUB_SUPERSEDE_DISABLED");
    let supersede_min_pixels = scrub_env_value("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS");
    let supersede_min_requests = scrub_env_value("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS");
    let supersede_min_span_frames = scrub_env_value("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES");
    let run_label = scrub_run_label(config);
    let common_prefix = format!(
        "{timestamp_ms},{{scope}},{{run_index}},\"{}\",\"{}\",{},{},{},{:.3},{},\"{}\",\"{}\",\"{}\",\"{}\"",
        run_label,
        config.video_path.display(),
        config.fps,
        config.bursts,
        config.burst_size,
        config.sweep_seconds,
        config.runs,
        supersede_disabled,
        supersede_min_pixels,
        supersede_min_requests,
        supersede_min_span_frames
    );

    for (index, summary) in summaries.iter().enumerate() {
        writeln!(
            file,
            "{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{}",
            common_prefix
                .replace("{scope}", "run")
                .replace("{run_index}", &(index + 1).to_string()),
            summary.all_avg_ms,
            summary.all_p95_ms,
            summary.all_p99_ms,
            summary.all_max_ms,
            summary.last_avg_ms,
            summary.last_p95_ms,
            summary.last_p99_ms,
            summary.last_max_ms,
            summary.successful_requests,
            summary.failed_requests
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    writeln!(
        file,
        "{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{}",
        common_prefix
            .replace("{scope}", "aggregate")
            .replace("{run_index}", "0"),
        aggregate.all_avg_ms,
        aggregate.all_p95_ms,
        aggregate.all_p99_ms,
        aggregate.all_max_ms,
        aggregate.last_avg_ms,
        aggregate.last_p95_ms,
        aggregate.last_p99_ms,
        aggregate.last_max_ms,
        aggregate.successful_requests,
        aggregate.failed_requests
    )
    .map_err(|error| format!("write {} / {error}", path.display()))?;

    Ok(())
}

fn print_report(config: &Config, summaries: &[ScrubSummary]) -> ScrubSummary {
    let stats = aggregate_summaries(summaries);
    println!("\n{}", "=".repeat(68));
    println!("Scrub Burst Benchmark Report");
    println!("{}", "=".repeat(68));
    println!("Video: {}", config.video_path.display());
    println!("FPS: {}", config.fps);
    println!("Bursts: {}", config.bursts);
    println!("Burst size: {}", config.burst_size);
    println!("Sweep seconds: {:.2}", config.sweep_seconds);
    println!("Runs: {}", config.runs);
    println!("Successful requests: {}", stats.successful_requests);
    println!("Failed requests: {}", stats.failed_requests);

    if config.runs > 1 {
        println!("\nPer-run last-request average latency");
        for (index, summary) in summaries.iter().enumerate() {
            println!("  run {:>2}: {:.2}ms", index + 1, summary.last_avg_ms);
        }
    }

    println!("\nAll Request Latency (median across runs)");
    println!("  avg: {:.2}ms", stats.all_avg_ms);
    println!("  p95: {:.2}ms", stats.all_p95_ms);
    println!("  p99: {:.2}ms", stats.all_p99_ms);
    println!("  max: {:.2}ms", stats.all_max_ms);

    println!("\nLast Request In Burst Latency (median across runs)");
    println!("  avg: {:.2}ms", stats.last_avg_ms);
    println!("  p95: {:.2}ms", stats.last_p95_ms);
    println!("  p99: {:.2}ms", stats.last_p99_ms);
    println!("  max: {:.2}ms", stats.last_max_ms);

    println!("{}", "=".repeat(68));
    stats
}

fn parse_args() -> Result<Config, String> {
    let args = std::env::args().collect::<Vec<_>>();
    let mut video_path: Option<PathBuf> = None;
    let mut fps = 60u32;
    let mut bursts = 50usize;
    let mut burst_size = 12usize;
    let mut sweep_seconds = 2.0f32;
    let mut runs = 1usize;
    let mut output_csv: Option<PathBuf> = None;
    let mut run_label: Option<String> = None;

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
            "--runs" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --runs".to_string());
                }
                runs = args[index]
                    .parse::<usize>()
                    .map_err(|_| "invalid value for --runs".to_string())?;
            }
            "--output-csv" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --output-csv".to_string());
                }
                output_csv = Some(PathBuf::from(&args[index]));
            }
            "--run-label" => {
                index += 1;
                if index >= args.len() {
                    return Err("missing value for --run-label".to_string());
                }
                run_label = Some(args[index].clone());
            }
            "--help" | "-h" => {
                println!(
                    "Usage: scrub-benchmark --video <path> [--fps <n>] [--bursts <n>] [--burst-size <n>] [--sweep-seconds <n>] [--runs <n>] [--output-csv <path>] [--run-label <label>]"
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
    if runs == 0 {
        return Err("--runs must be > 0".to_string());
    }

    Ok(Config {
        video_path,
        fps,
        bursts,
        burst_size,
        sweep_seconds,
        runs,
        output_csv,
        run_label,
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
    let mut summaries = Vec::with_capacity(config.runs);
    for run in 0..config.runs {
        match runtime.block_on(run_scrub_benchmark(&config)) {
            Ok(stats) => {
                let summary = summarize(&stats);
                if config.runs > 1 {
                    println!(
                        "Completed run {}/{}: last-request avg {:.2}ms",
                        run + 1,
                        config.runs,
                        summary.last_avg_ms
                    );
                }
                summaries.push(summary);
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }

    let aggregate = print_report(&config, &summaries);
    if let Some(path) = &config.output_csv
        && let Err(error) = write_csv(path, &config, &summaries, aggregate)
    {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
