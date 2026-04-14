use cap_recording::{
    StudioQuality,
    memory_profiling::{CpuTracker, get_process_stats},
    screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

struct RecordingResult {
    quality: StudioQuality,
    fragmented: bool,
    total_duration: Duration,
    stop_duration: Duration,
    output_path: PathBuf,
    screen_size_bytes: u64,
    screen_bitrate_mbps: f64,
    peak_cpu: f64,
    avg_cpu: f64,
    peak_rss_mb: f64,
    recording_secs: f64,
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata().ok();
            if let Some(m) = meta {
                if m.is_file() {
                    total += m.len();
                } else if m.is_dir() {
                    total += dir_size_bytes(&entry.path());
                }
            }
        }
    }
    total
}

fn get_screen_size(project_path: &Path, fragmented: bool) -> u64 {
    let segment_dir = project_path
        .join("content")
        .join("segments")
        .join("segment-0");

    if fragmented {
        dir_size_bytes(&segment_dir.join("display"))
    } else if let Ok(m) = std::fs::metadata(segment_dir.join("display.mp4")) {
        m.len()
    } else {
        0
    }
}

async fn run_recording(
    quality: StudioQuality,
    fragmented: bool,
    duration_secs: u64,
    max_fps: u32,
) -> Result<RecordingResult, Box<dyn std::error::Error>> {
    let quality_label = match quality {
        StudioQuality::Balanced => "Balanced",
        StudioQuality::Ultra => "Ultra",
    };
    let frag_label = if fragmented {
        "fragmented"
    } else {
        "non-fragmented"
    };

    println!("\n  Recording: {quality_label} / {frag_label} / {max_fps}fps / {duration_secs}s");

    let mut cpu = CpuTracker::new();
    cpu.sample();

    let dir = tempfile::tempdir()?;

    let builder = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(false)
    .with_fragmented(fragmented)
    .with_max_fps(max_fps)
    .with_quality(quality);

    println!("  Starting...");

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current()
                    .await
                    .expect("Failed to get shareable content"),
            )),
        )
        .await?;

    let start = Instant::now();
    let sample_interval = Duration::from_secs(2);
    let mut next_sample = start + sample_interval;
    let mut cpu_samples: Vec<f64> = Vec::new();
    let mut peak_rss_mb: f64 = 0.0;

    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_millis(200)).await;

        if Instant::now() >= next_sample {
            cpu.sample();
            let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
            cpu_samples.push(cpu_pct);
            if let Some(stats) = get_process_stats() {
                if stats.resident_mb > peak_rss_mb {
                    peak_rss_mb = stats.resident_mb;
                }
                println!(
                    "    [{:>5.1}s] CPU: {:>5.1}%  RSS: {:>6.1} MB",
                    start.elapsed().as_secs_f64(),
                    cpu_pct,
                    stats.resident_mb,
                );
            }
            next_sample = Instant::now() + sample_interval;
        }
    }

    println!("  Stopping...");
    let stop_start = Instant::now();
    cpu.sample();

    let result = handle.stop().await?;

    let stop_duration = stop_start.elapsed();
    let total_duration = start.elapsed();
    cpu.sample();

    let recording_secs = total_duration.as_secs_f64();
    let screen_size = get_screen_size(&result.project_path, fragmented);
    let screen_size_mb = screen_size as f64 / (1024.0 * 1024.0);
    let screen_bitrate_mbps = screen_size_mb * 8.0 / recording_secs;

    let avg_cpu = if cpu_samples.is_empty() {
        0.0
    } else {
        cpu_samples.iter().sum::<f64>() / cpu_samples.len() as f64
    };
    let peak_cpu = cpu_samples.iter().copied().fold(0.0f64, f64::max);

    println!("  Stop took: {stop_duration:?}");
    println!("  Screen: {screen_size_mb:.2} MB ({screen_bitrate_mbps:.2} Mbps)");

    std::mem::forget(dir);

    Ok(RecordingResult {
        quality,
        fragmented,
        total_duration,
        stop_duration,
        output_path: result.project_path,
        screen_size_bytes: screen_size,
        screen_bitrate_mbps,
        peak_cpu,
        avg_cpu,
        peak_rss_mb,
        recording_secs,
    })
}

fn print_comparison(results: &[RecordingResult]) {
    println!("\n{}", "=".repeat(90));
    println!("  QUALITY COMPARISON RESULTS");
    println!("{}\n", "=".repeat(90));

    println!(
        "{:<28} {:>10} {:>12} {:>10} {:>10} {:>10} {:>10} {:>10}",
        "Mode", "Size (MB)", "Bitrate", "Avg CPU", "Peak CPU", "Peak RSS", "Duration", "Stop Time"
    );
    println!("{}", "-".repeat(120));

    for r in results {
        let quality_label = match r.quality {
            StudioQuality::Balanced => "Balanced",
            StudioQuality::Ultra => "Ultra",
        };
        let frag_label = if r.fragmented { "frag" } else { "mp4" };
        let label = format!("{quality_label} ({frag_label})");
        let size_mb = r.screen_size_bytes as f64 / (1024.0 * 1024.0);

        println!(
            "{:<28} {:>8.2} MB {:>9.2} Mbps {:>8.1}% {:>8.1}% {:>7.1} MB {:>8.1}s {:>10.2?}",
            label,
            size_mb,
            r.screen_bitrate_mbps,
            r.avg_cpu,
            r.peak_cpu,
            r.peak_rss_mb,
            r.recording_secs,
            r.stop_duration
        );
    }

    println!();

    if results.len() >= 2 {
        println!("Pairwise comparisons:");
        for i in 0..results.len() {
            for j in (i + 1)..results.len() {
                let a = &results[i];
                let b = &results[j];
                let a_label = format!(
                    "{} ({})",
                    match a.quality {
                        StudioQuality::Balanced => "Balanced",
                        StudioQuality::Ultra => "Ultra",
                    },
                    if a.fragmented { "frag" } else { "mp4" }
                );
                let b_label = format!(
                    "{} ({})",
                    match b.quality {
                        StudioQuality::Balanced => "Balanced",
                        StudioQuality::Ultra => "Ultra",
                    },
                    if b.fragmented { "frag" } else { "mp4" }
                );

                let size_ratio = b.screen_size_bytes as f64 / a.screen_size_bytes.max(1) as f64;
                let bitrate_ratio = b.screen_bitrate_mbps / a.screen_bitrate_mbps.max(0.01);
                let cpu_diff = b.avg_cpu - a.avg_cpu;

                println!("  {b_label} vs {a_label}:");
                println!("    Size: {size_ratio:.2}x");
                println!("    Bitrate: {bitrate_ratio:.2}x");
                println!(
                    "    CPU delta: {}{:.1}%",
                    if cpu_diff >= 0.0 { "+" } else { "" },
                    cpu_diff
                );
            }
        }
    }

    println!();
    println!("Output paths:");
    for r in results {
        let quality_label = match r.quality {
            StudioQuality::Balanced => "Balanced",
            StudioQuality::Ultra => "Ultra",
        };
        let frag_label = if r.fragmented { "frag" } else { "mp4" };
        println!(
            "  {quality_label} ({frag_label}): {} (total: {:.1?})",
            r.output_path.display(),
            r.total_duration
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { std::env::set_var("RUST_LOG", "info") };
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();

    let duration = args
        .iter()
        .position(|a| a == "--duration")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10u64);

    let max_fps: u32 = args
        .iter()
        .position(|a| a == "--fps")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    let skip_fragmented = args.contains(&"--no-frag".to_string());
    let skip_nonfrag = args.contains(&"--frag-only".to_string());

    let display = Display::primary();
    let phys = display.physical_size();
    let logical = display.logical_size();

    println!("=== Cap Quality Comparison Test ===\n");
    println!("Duration: {duration}s per recording");
    println!("Max FPS: {max_fps}");
    println!(
        "Display: physical {:?}, logical {:?}",
        phys.map(|s| format!("{:.0}x{:.0}", s.width(), s.height())),
        logical.map(|s| format!("{:.0}x{:.0}", s.width(), s.height())),
    );
    println!(
        "CPU cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );

    let mut results = Vec::new();

    if !skip_nonfrag {
        println!("\n{}", "=".repeat(60));
        println!("  NON-FRAGMENTED (crash recovery OFF)");
        println!("{}", "=".repeat(60));

        results.push(run_recording(StudioQuality::Balanced, false, duration, max_fps).await?);
        tokio::time::sleep(Duration::from_secs(2)).await;

        results.push(run_recording(StudioQuality::Ultra, false, duration, max_fps).await?);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    if !skip_fragmented {
        println!("\n{}", "=".repeat(60));
        println!("  FRAGMENTED (crash recovery ON - default)");
        println!("{}", "=".repeat(60));

        results.push(run_recording(StudioQuality::Balanced, true, duration, max_fps).await?);
        tokio::time::sleep(Duration::from_secs(2)).await;

        results.push(run_recording(StudioQuality::Ultra, true, duration, max_fps).await?);
    }

    print_comparison(&results);

    println!("\n=== Quality Comparison Complete ===");

    Ok(())
}
