use cap_audio::AudioData;
use cap_rendering::decoder::spawn_decoder;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;

#[derive(Debug, Clone)]
struct Config {
    video_path: PathBuf,
    audio_path: Option<PathBuf>,
    fps: u32,
    max_frames: usize,
    seek_iterations: usize,
    output_csv: Option<PathBuf>,
    run_label: Option<String>,
}

#[derive(Debug, Default)]
struct SeekDistanceStats {
    distance_secs: f32,
    samples_ms: Vec<f64>,
    failures: usize,
}

#[derive(Debug, Default)]
struct PlaybackStats {
    decoded_frames: usize,
    failed_frames: usize,
    missed_deadlines: usize,
    decode_times_ms: Vec<f64>,
    sequential_elapsed_secs: f64,
    effective_fps: f64,
    seek_stats: Vec<SeekDistanceStats>,
}

#[derive(Clone, Copy)]
struct DecodeSummary {
    avg: f64,
    p95: f64,
    p99: f64,
    max: f64,
}

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
            duration_str.trim().parse().unwrap_or(0.0)
        }
        _ => 0.0,
    }
}

fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut filtered: Vec<f64> = samples.iter().copied().filter(|v| !v.is_nan()).collect();
    if filtered.is_empty() {
        return 0.0;
    }
    filtered.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((p / 100.0) * (filtered.len() - 1) as f64).round() as usize;
    filtered[idx.min(filtered.len() - 1)]
}

fn playback_run_label(config: &Config) -> String {
    config
        .run_label
        .as_ref()
        .cloned()
        .or_else(|| std::env::var("CAP_PLAYBACK_BENCHMARK_RUN_LABEL").ok())
        .unwrap_or_default()
}

fn decode_summary(stats: &PlaybackStats) -> Option<DecodeSummary> {
    if stats.decode_times_ms.is_empty() {
        return None;
    }
    let avg = stats.decode_times_ms.iter().sum::<f64>() / stats.decode_times_ms.len() as f64;
    let max = stats
        .decode_times_ms
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    Some(DecodeSummary {
        avg,
        p95: percentile(&stats.decode_times_ms, 95.0),
        p99: percentile(&stats.decode_times_ms, 99.0),
        max: if max.is_finite() { max } else { 0.0 },
    })
}

fn write_csv(path: &PathBuf, config: &Config, stats: &PlaybackStats) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;
    if path.exists() && path.metadata().map(|meta| meta.len()).unwrap_or(0) == 0 {
        let header = [
            "timestamp_ms",
            "mode",
            "run_label",
            "video",
            "fps",
            "max_frames",
            "seek_iterations",
            "decoded_frames",
            "failed_frames",
            "missed_deadlines",
            "effective_fps",
            "sequential_elapsed_s",
            "decode_avg_ms",
            "decode_p95_ms",
            "decode_p99_ms",
            "decode_max_ms",
            "seek_distance_s",
            "seek_avg_ms",
            "seek_p95_ms",
            "seek_max_ms",
            "seek_samples",
            "seek_failures",
        ]
        .join(",");
        writeln!(file, "{header}").map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let run_label = playback_run_label(config);
    let decode = decode_summary(stats).unwrap_or(DecodeSummary {
        avg: 0.0,
        p95: 0.0,
        p99: 0.0,
        max: 0.0,
    });

    writeln!(
        file,
        "{timestamp_ms},sequential,\"{}\",\"{}\",{},{},{},{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\"",
        run_label,
        config.video_path.display(),
        config.fps,
        config.max_frames,
        config.seek_iterations,
        stats.decoded_frames,
        stats.failed_frames,
        stats.missed_deadlines,
        stats.effective_fps,
        stats.sequential_elapsed_secs,
        decode.avg,
        decode.p95,
        decode.p99,
        decode.max
    )
    .map_err(|error| format!("write {} / {error}", path.display()))?;

    for seek in &stats.seek_stats {
        let seek_avg = if seek.samples_ms.is_empty() {
            0.0
        } else {
            seek.samples_ms.iter().sum::<f64>() / seek.samples_ms.len() as f64
        };
        let seek_max = seek
            .samples_ms
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        writeln!(
            file,
            "{timestamp_ms},seek,\"{}\",\"{}\",{},{},{},{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{}",
            run_label,
            config.video_path.display(),
            config.fps,
            config.max_frames,
            config.seek_iterations,
            stats.decoded_frames,
            stats.failed_frames,
            stats.missed_deadlines,
            stats.effective_fps,
            stats.sequential_elapsed_secs,
            decode.avg,
            decode.p95,
            decode.p99,
            decode.max,
            seek.distance_secs,
            seek_avg,
            percentile(&seek.samples_ms, 95.0),
            if seek_max.is_finite() { seek_max } else { 0.0 },
            seek.samples_ms.len(),
            seek.failures
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    Ok(())
}

async fn run_playback_benchmark(config: &Config) -> Result<PlaybackStats, String> {
    let mut stats = PlaybackStats::default();
    let decoder = spawn_decoder(
        "benchmark",
        config.video_path.clone(),
        config.fps,
        0.0,
        false,
    )
    .await
    .map_err(|e| format!("Failed to create decoder: {e}"))?;

    let duration_secs = get_video_duration(&config.video_path);
    if duration_secs <= 0.0 {
        return Err("Unable to determine video duration".to_string());
    }

    let total_frames = ((duration_secs as f64 * config.fps as f64).ceil() as usize)
        .max(1)
        .min(config.max_frames);
    let frame_interval = Duration::from_secs_f64(1.0 / config.fps as f64);

    let start = Instant::now();
    for frame_idx in 0..total_frames {
        let frame_deadline = start + frame_interval.mul_f64(frame_idx as f64);
        if Instant::now() < frame_deadline {
            tokio::time::sleep_until(tokio::time::Instant::from_std(frame_deadline)).await;
        }

        let frame_time = frame_idx as f32 / config.fps as f32;
        let decode_start = Instant::now();
        if decoder.get_frame(frame_time).await.is_some() {
            stats.decoded_frames += 1;
            let decode_ms = decode_start.elapsed().as_secs_f64() * 1000.0;
            stats.decode_times_ms.push(decode_ms);
            if Instant::now() > frame_deadline + frame_interval {
                stats.missed_deadlines += 1;
            }
        } else {
            stats.failed_frames += 1;
        }
    }

    stats.sequential_elapsed_secs = start.elapsed().as_secs_f64();
    if stats.sequential_elapsed_secs > 0.0 {
        stats.effective_fps = stats.decoded_frames as f64 / stats.sequential_elapsed_secs;
    }

    let seek_points = [0.5_f32, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0];
    for point in seek_points {
        if point >= duration_secs {
            continue;
        }
        let mut seek_stats = SeekDistanceStats {
            distance_secs: point,
            ..Default::default()
        };
        let seek_target_ceiling = (duration_secs - 0.01).max(0.0);
        let start_ceiling = (duration_secs - point - 0.01).max(0.0);
        for _ in 0..config.seek_iterations {
            let iteration = (seek_stats.samples_ms.len() + seek_stats.failures) as f32;
            let from_time = if start_ceiling > 0.0 {
                (iteration * 0.618_034 * start_ceiling) % start_ceiling
            } else {
                0.0
            };
            let to_time = (from_time + point).min(seek_target_ceiling);
            if decoder.get_frame(from_time).await.is_none() {
                seek_stats.failures += 1;
                continue;
            }
            let seek_start = Instant::now();
            if decoder.get_frame(to_time).await.is_some() {
                let seek_ms = seek_start.elapsed().as_secs_f64() * 1000.0;
                seek_stats.samples_ms.push(seek_ms);
            } else {
                seek_stats.failures += 1;
            }
        }
        stats.seek_stats.push(seek_stats);
    }

    Ok(stats)
}

fn print_report(config: &Config, stats: &PlaybackStats) {
    println!("\n{}", "=".repeat(68));
    println!("Playback Benchmark Report");
    println!("{}", "=".repeat(68));
    println!("Video: {}", config.video_path.display());
    println!("Target FPS: {}", config.fps);
    println!("Frame Budget: {:.2}ms", 1000.0 / config.fps as f64);
    println!("Seek Iterations: {}", config.seek_iterations);

    println!("\nSequential Playback Simulation");
    println!("Decoded Frames: {}", stats.decoded_frames);
    println!("Failed Frames: {}", stats.failed_frames);
    println!("Missed Deadlines: {}", stats.missed_deadlines);
    println!("Elapsed: {:.2}s", stats.sequential_elapsed_secs);
    println!("Effective FPS: {:.2}", stats.effective_fps);

    if !stats.decode_times_ms.is_empty() {
        let avg = stats.decode_times_ms.iter().sum::<f64>() / stats.decode_times_ms.len() as f64;
        let min = stats
            .decode_times_ms
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        let max = stats
            .decode_times_ms
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        println!("Decode avg: {:.2}ms", avg);
        println!("Decode min: {:.2}ms", min);
        println!(
            "Decode p95: {:.2}ms",
            percentile(&stats.decode_times_ms, 95.0)
        );
        println!(
            "Decode p99: {:.2}ms",
            percentile(&stats.decode_times_ms, 99.0)
        );
        println!("Decode max: {:.2}ms", max);
    }

    if !stats.seek_stats.is_empty() {
        println!("\nSeek Samples");
        println!(
            "{:>5} | {:>8} | {:>8} | {:>8} | {:>7} | {:>8}",
            "Secs", "Avg(ms)", "P95(ms)", "Max(ms)", "Samples", "Failures"
        );
        println!(
            "{}-+-{}-+-{}-+-{}-+-{}-+-{}",
            "-".repeat(5),
            "-".repeat(8),
            "-".repeat(8),
            "-".repeat(8),
            "-".repeat(7),
            "-".repeat(8)
        );
        for stats_for_distance in &stats.seek_stats {
            let avg = if stats_for_distance.samples_ms.is_empty() {
                0.0
            } else {
                stats_for_distance.samples_ms.iter().sum::<f64>()
                    / stats_for_distance.samples_ms.len() as f64
            };
            let max = stats_for_distance
                .samples_ms
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            let p95 = percentile(&stats_for_distance.samples_ms, 95.0);
            println!(
                "{:>5.1} | {:>8.2} | {:>8.2} | {:>8.2} | {:>7} | {:>8}",
                stats_for_distance.distance_secs,
                avg,
                p95,
                if max.is_finite() { max } else { 0.0 },
                stats_for_distance.samples_ms.len(),
                stats_for_distance.failures
            );
        }
    }

    if let Some(audio_path) = &config.audio_path {
        match AudioData::from_file(audio_path) {
            Ok(audio) => {
                let audio_duration = audio.sample_count() as f64 / AudioData::SAMPLE_RATE as f64;
                let video_duration = get_video_duration(&config.video_path) as f64;
                let diff_ms = (audio_duration - video_duration).abs() * 1000.0;
                println!("\nAudio Duration Comparison");
                println!("Audio: {:.3}s", audio_duration);
                println!("Video: {:.3}s", video_duration);
                println!("Difference: {:.2}ms", diff_ms);
            }
            Err(err) => {
                println!("\nAudio Duration Comparison");
                println!("Failed to load audio {}: {}", audio_path.display(), err);
            }
        }
    }

    println!("{}", "=".repeat(68));
}

fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();
    let mut video_path: Option<PathBuf> = None;
    let mut audio_path: Option<PathBuf> = None;
    let mut fps = 60_u32;
    let mut max_frames = 600_usize;
    let mut seek_iterations = 10_usize;
    let mut output_csv: Option<PathBuf> = None;
    let mut run_label: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--video" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --video".to_string());
                }
                video_path = Some(PathBuf::from(&args[i]));
            }
            "--audio" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --audio".to_string());
                }
                audio_path = Some(PathBuf::from(&args[i]));
            }
            "--fps" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --fps".to_string());
                }
                fps = args[i]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --fps value".to_string())?;
            }
            "--max-frames" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --max-frames".to_string());
                }
                max_frames = args[i]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --max-frames value".to_string())?;
            }
            "--seek-iterations" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --seek-iterations".to_string());
                }
                seek_iterations = args[i]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --seek-iterations value".to_string())?;
            }
            "--output-csv" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --output-csv".to_string());
                }
                output_csv = Some(PathBuf::from(&args[i]));
            }
            "--run-label" => {
                i += 1;
                if i >= args.len() {
                    return Err("Missing value for --run-label".to_string());
                }
                run_label = Some(args[i].clone());
            }
            "--help" | "-h" => {
                println!(
                    "Usage: playback-benchmark --video <path> [--audio <path>] [--fps <n>] [--max-frames <n>] [--seek-iterations <n>] [--output-csv <path>] [--run-label <label>]"
                );
                std::process::exit(0);
            }
            unknown => {
                return Err(format!("Unknown argument: {unknown}"));
            }
        }
        i += 1;
    }

    let video_path = video_path.ok_or_else(|| "Missing required --video".to_string())?;
    if !video_path.exists() {
        return Err(format!(
            "Video path does not exist: {}",
            video_path.display()
        ));
    }

    Ok(Config {
        video_path,
        audio_path,
        fps,
        max_frames,
        seek_iterations,
        output_csv,
        run_label,
    })
}

fn main() {
    let config = match parse_args() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    let rt = Runtime::new().expect("Failed to create tokio runtime");
    match rt.block_on(run_playback_benchmark(&config)) {
        Ok(stats) => {
            print_report(&config, &stats);
            if let Some(path) = &config.output_csv
                && let Err(err) = write_csv(path, &config, &stats)
            {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
