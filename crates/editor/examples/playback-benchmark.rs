use cap_audio::AudioData;
use cap_rendering::decoder::spawn_decoder;
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
}

#[derive(Debug, Default)]
struct PlaybackStats {
    decoded_frames: usize,
    failed_frames: usize,
    missed_deadlines: usize,
    decode_times_ms: Vec<f64>,
    sequential_elapsed_secs: f64,
    effective_fps: f64,
    seek_samples_ms: Vec<(f32, f64)>,
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
        let seek_start = Instant::now();
        let _ = decoder.get_frame(point).await;
        let seek_ms = seek_start.elapsed().as_secs_f64() * 1000.0;
        stats.seek_samples_ms.push((point, seek_ms));
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

    if !stats.seek_samples_ms.is_empty() {
        println!("\nSeek Samples");
        for (secs, ms) in &stats.seek_samples_ms {
            println!("{:>5.1}s -> {:>8.2}ms", secs, ms);
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
            "--help" | "-h" => {
                println!(
                    "Usage: playback-benchmark --video <path> [--audio <path>] [--fps <n>] [--max-frames <n>]"
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
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
