use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{
        camera::{self, DeviceOrModelID},
        microphone,
    },
    memory_profiling::{CpuTracker, MemoryProfiler, get_memory_usage, get_process_stats},
    screen_capture::ScreenCaptureTarget,
};
use kameo::Actor;
use scap_targets::Display;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct RecordingMetrics {
    cpu_samples: Vec<f64>,
    memory_samples: Vec<(f64, f64)>,
    total_file_size_bytes: u64,
    recording_duration_secs: f64,
    stop_duration: Duration,
}

impl RecordingMetrics {
    fn print_summary(&self, label: &str) {
        println!("\n{}", "=".repeat(60));
        println!("  {label} - SUMMARY");
        println!("{}\n", "=".repeat(60));

        let avg_cpu = if self.cpu_samples.is_empty() {
            0.0
        } else {
            self.cpu_samples.iter().sum::<f64>() / self.cpu_samples.len() as f64
        };
        let max_cpu = self.cpu_samples.iter().cloned().fold(0.0_f64, f64::max);
        let min_cpu = self.cpu_samples.iter().cloned().fold(f64::MAX, f64::min);

        let num_cores = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1);

        println!("Duration: {:.1}s", self.recording_duration_secs);
        println!("Stop latency: {:?}", self.stop_duration);

        println!("\nCPU Usage ({num_cores} cores):");
        println!(
            "  Average: {avg_cpu:.1}% ({:.1}% per core)",
            avg_cpu / num_cores as f64
        );
        println!("  Min:     {min_cpu:.1}%");
        println!("  Max:     {max_cpu:.1}%");

        if let (Some(first), Some(last)) = (self.memory_samples.first(), self.memory_samples.last())
        {
            let growth = last.0 - first.0;
            let peak_rss = self
                .memory_samples
                .iter()
                .map(|s| s.1)
                .fold(0.0_f64, f64::max);
            println!("\nMemory:");
            println!("  Start RSS:  {:.1} MB", first.1);
            println!("  End RSS:    {:.1} MB", last.1);
            println!("  Peak RSS:   {peak_rss:.1} MB");
            println!("  Growth:     {growth:+.1} MB");
        }

        if self.total_file_size_bytes > 0 {
            let size_mb = self.total_file_size_bytes as f64 / 1024.0 / 1024.0;
            let bitrate_mbps = (self.total_file_size_bytes as f64 * 8.0)
                / self.recording_duration_secs
                / 1_000_000.0;
            println!("\nFile Size:");
            println!("  Total:   {size_mb:.2} MB");
            println!("  Bitrate: {bitrate_mbps:.2} Mbps");
            println!(
                "  Rate:    {:.2} MB/min",
                size_mb / (self.recording_duration_secs / 60.0)
            );
        }

        let cpu_per_core = avg_cpu / num_cores as f64;
        println!("\nAssessment:");
        if cpu_per_core < 5.0 {
            println!("  CPU:    EXCELLENT (<5% per core)");
        } else if cpu_per_core < 15.0 {
            println!("  CPU:    GOOD (<15% per core)");
        } else if cpu_per_core < 30.0 {
            println!("  CPU:    MODERATE (<30% per core)");
        } else {
            println!("  CPU:    HIGH (>30% per core) - investigate");
        }

        if let Some(last) = self.memory_samples.last() {
            if last.1 < 200.0 {
                println!("  Memory: GOOD (<200 MB RSS)");
            } else if last.1 < 400.0 {
                println!("  Memory: MODERATE (<400 MB RSS)");
            } else {
                println!("  Memory: HIGH (>400 MB RSS) - investigate");
            }
        }

        if self.total_file_size_bytes > 0 {
            let mb_per_min = (self.total_file_size_bytes as f64 / 1024.0 / 1024.0)
                / (self.recording_duration_secs / 60.0);
            if mb_per_min < 30.0 {
                println!("  Size:   EXCELLENT (<30 MB/min)");
            } else if mb_per_min < 60.0 {
                println!("  Size:   GOOD (<60 MB/min)");
            } else if mb_per_min < 120.0 {
                println!("  Size:   MODERATE (<120 MB/min)");
            } else {
                println!("  Size:   HIGH (>120 MB/min) - investigate bitrate");
            }
        }
    }
}

fn measure_output_size(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                total += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            } else if path.is_dir() {
                total += measure_output_size(&path);
            }
        }
    }
    total
}

async fn profile_instant_recording(
    label: &str,
    duration_secs: u64,
    include_camera: bool,
    include_mic: bool,
    max_output_size: Option<u32>,
) -> RecordingMetrics {
    println!("\n{}", "=".repeat(60));
    println!("  {label}");
    println!("  Duration: {duration_secs}s  Camera: {include_camera}  Mic: {include_mic}");
    if let Some(max_size) = max_output_size {
        println!("  Max output width: {max_size}");
    }
    println!("{}\n", "=".repeat(60));

    let mut cpu = CpuTracker::new();
    let mut profiler = MemoryProfiler::new();
    cpu.sample();
    profiler.sample();

    let dir = tempfile::tempdir().expect("Failed to create tempdir");

    let mut builder = cap_recording::instant_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(true);

    if let Some(max_size) = max_output_size {
        builder = builder.with_max_output_size(max_size);
    }

    let mut camera_feed_ref = None;
    let mut mic_feed_ref = None;

    if include_camera && let Some(camera_info) = cap_camera::list_cameras().next() {
        println!("Camera: {}", camera_info.display_name());
        let feed = CameraFeed::spawn(CameraFeed::default());
        feed.ask(camera::SetInput {
            settings: None,
            id: DeviceOrModelID::from_info(&camera_info),
        })
        .await
        .expect("camera SetInput send failed")
        .await
        .expect("camera SetInput failed");

        tokio::time::sleep(Duration::from_millis(500)).await;
        let lock = feed.ask(camera::Lock).await.expect("camera Lock failed");
        builder = builder.with_camera_feed(Arc::new(lock));
        camera_feed_ref = Some(feed);
    }

    if include_mic && let Some((mic_name, _, _)) = MicrophoneFeed::default_device() {
        println!("Microphone: {mic_name}");
        let error_sender = flume::unbounded().0;
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));
        mic_feed
            .ask(microphone::SetInput {
                settings: None,
                label: mic_name.clone(),
            })
            .await
            .expect("mic SetInput send failed")
            .await
            .expect("mic SetInput failed");

        tokio::time::sleep(Duration::from_millis(500)).await;
        let mic_lock = mic_feed
            .ask(microphone::Lock)
            .await
            .expect("mic Lock failed");
        builder = builder.with_mic_feed(Arc::new(mic_lock));
        mic_feed_ref = Some(mic_feed);
    }

    cpu.sample();
    profiler.sample();
    println!("Starting instant recording...");

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current()
                    .await
                    .expect("Failed to get shareable content"),
            )),
        )
        .await
        .expect("Failed to build instant recording");

    let start = Instant::now();
    let sample_interval = Duration::from_secs(2);
    let mut next_sample = start + sample_interval;
    let mut cpu_samples = Vec::new();
    let mut memory_samples = Vec::new();

    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_millis(100)).await;

        if Instant::now() >= next_sample {
            cpu.sample();
            profiler.sample();
            let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
            cpu_samples.push(cpu_pct);

            if let Some(stats) = get_process_stats() {
                let mem = get_memory_usage()
                    .map(|m| m.primary_metric())
                    .unwrap_or(0.0);
                memory_samples.push((mem, stats.resident_mb));

                println!(
                    "[{:>5.1}s] CPU: {:>5.1}%  RSS: {:>6.1} MB  Threads: {}",
                    start.elapsed().as_secs_f64(),
                    cpu_pct,
                    stats.resident_mb,
                    stats.thread_count,
                );
            }
            next_sample = Instant::now() + sample_interval;
        }
    }

    let recording_duration = start.elapsed();
    println!("\nStopping instant recording...");
    let stop_start = Instant::now();
    cpu.sample();

    let completed = handle.stop().await.expect("Failed to stop recording");
    let stop_duration = stop_start.elapsed();
    cpu.sample();
    profiler.sample();

    if let Some(feed) = camera_feed_ref.take() {
        let _ = feed.ask(camera::RemoveInput).await;
    }
    if let Some(feed) = mic_feed_ref.take() {
        let _ = feed.ask(microphone::RemoveInput).await;
    }

    println!("Stop took: {stop_duration:?}");
    println!("Health: {:?}", completed.health);

    let content_dir = dir.path().join("content");
    let total_size = measure_output_size(&content_dir);
    println!("Output size: {:.2} MB", total_size as f64 / 1024.0 / 1024.0);

    let display_dir = content_dir.join("display");
    if display_dir.exists() {
        let display_size = measure_output_size(&display_dir);
        let segment_count = std::fs::read_dir(&display_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
                    .count()
            })
            .unwrap_or(0);
        println!(
            "  Display: {:.2} MB ({segment_count} segments)",
            display_size as f64 / 1024.0 / 1024.0
        );
    }

    let audio_dir = content_dir.join("audio");
    if audio_dir.exists() {
        let audio_size = measure_output_size(&audio_dir);
        println!("  Audio:   {:.2} MB", audio_size as f64 / 1024.0 / 1024.0);
    }

    tokio::time::sleep(Duration::from_secs(1)).await;
    cpu.sample();
    profiler.sample();

    cpu.print_report();
    profiler.print_report();

    let metrics = RecordingMetrics {
        cpu_samples,
        memory_samples,
        total_file_size_bytes: total_size,
        recording_duration_secs: recording_duration.as_secs_f64(),
        stop_duration,
    };

    std::mem::forget(dir);
    metrics
}

async fn profile_sustained_instant(duration_secs: u64, include_mic: bool) {
    println!("\n{}", "=".repeat(60));
    println!("  SUSTAINED INSTANT RECORDING ({duration_secs}s)");
    println!("{}\n", "=".repeat(60));

    let mut profiler = MemoryProfiler::new();
    profiler.sample();

    let dir = tempfile::tempdir().expect("Failed to create tempdir");

    let mut builder = cap_recording::instant_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(true)
    .with_max_output_size(1920);

    if include_mic && let Some((mic_name, _, _)) = MicrophoneFeed::default_device() {
        println!("Microphone: {mic_name}");
        let error_sender = flume::unbounded().0;
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));
        mic_feed
            .ask(microphone::SetInput {
                label: mic_name,
                settings: None,
            })
            .await
            .expect("mic SetInput send failed")
            .await
            .expect("mic SetInput failed");

        tokio::time::sleep(Duration::from_millis(500)).await;
        let mic_lock = mic_feed
            .ask(microphone::Lock)
            .await
            .expect("mic Lock failed");
        builder = builder.with_mic_feed(Arc::new(mic_lock));
    }

    println!("Starting sustained instant recording...");
    profiler.sample();

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current()
                    .await
                    .expect("Failed to get shareable content"),
            )),
        )
        .await
        .expect("Failed to build recording");

    let start = Instant::now();
    let mut next_sample = Instant::now() + Duration::from_secs(5);

    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_millis(100)).await;

        if Instant::now() >= next_sample {
            profiler.sample();
            if let Some(stats) = get_memory_usage() {
                println!(
                    "[{:>5.1}s] Footprint: {:.1} MB, RSS: {:.1} MB",
                    start.elapsed().as_secs_f64(),
                    stats.footprint_mb.unwrap_or(0.0),
                    stats.resident_mb
                );
            }
            next_sample = Instant::now() + Duration::from_secs(5);
        }
    }

    println!("\nStopping...");
    profiler.sample();
    let _ = handle.stop().await.expect("Failed to stop recording");

    let content_dir = dir.path().join("content");
    let total_size = measure_output_size(&content_dir);
    let mb = total_size as f64 / 1024.0 / 1024.0;
    let bitrate = (total_size as f64 * 8.0) / duration_secs as f64 / 1_000_000.0;
    println!(
        "\nOutput: {mb:.2} MB ({bitrate:.2} Mbps, {:.1} MB/min)",
        mb / (duration_secs as f64 / 60.0)
    );

    tokio::time::sleep(Duration::from_secs(2)).await;
    profiler.sample();

    profiler.print_report();

    let result = profiler.check_for_leaks();
    println!("\nMemory verdict: {}", result.verdict);

    std::mem::forget(dir);
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
        .unwrap_or(30u64);

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("all");

    let no_camera = args.contains(&"--no-camera".to_string());
    let no_mic = args.contains(&"--no-mic".to_string());

    println!("=== Cap Instant Mode Profiler ===\n");
    println!("Mode: {mode}");
    println!("Duration: {duration}s per test");
    println!(
        "CPU cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );
    println!("Platform: {}\n", std::env::consts::OS);

    let mut all_metrics: Vec<(&str, RecordingMetrics)> = Vec::new();

    match mode {
        "screen-only" => {
            let m = profile_instant_recording(
                "INSTANT: SCREEN ONLY",
                duration,
                false,
                false,
                Some(1920),
            )
            .await;
            m.print_summary("INSTANT: SCREEN ONLY");
            all_metrics.push(("Screen Only", m));
        }
        "screen-mic" => {
            let m = profile_instant_recording(
                "INSTANT: SCREEN + MIC",
                duration,
                false,
                true,
                Some(1920),
            )
            .await;
            m.print_summary("INSTANT: SCREEN + MIC");
            all_metrics.push(("Screen + Mic", m));
        }
        "full" => {
            let m = profile_instant_recording(
                "INSTANT: FULL (screen+camera+mic)",
                duration,
                !no_camera,
                !no_mic,
                Some(1920),
            )
            .await;
            m.print_summary("INSTANT: FULL");
            all_metrics.push(("Full", m));
        }
        "sustained" => {
            profile_sustained_instant(duration * 3, !no_mic).await;
        }
        "resolution" => {
            for max_res in [1280, 1920, 2560] {
                let label = format!("INSTANT: SCREEN @ max {max_res}w");
                let m =
                    profile_instant_recording(&label, duration, false, false, Some(max_res)).await;
                m.print_summary(&label);
            }
        }
        _ => {
            let m1 = profile_instant_recording(
                "INSTANT: SCREEN ONLY (1920w max)",
                duration,
                false,
                false,
                Some(1920),
            )
            .await;
            m1.print_summary("INSTANT: SCREEN ONLY");
            all_metrics.push(("Screen Only", m1));

            let m2 = profile_instant_recording(
                "INSTANT: SCREEN + MIC (1920w max)",
                duration,
                false,
                !no_mic,
                Some(1920),
            )
            .await;
            m2.print_summary("INSTANT: SCREEN + MIC");
            all_metrics.push(("Screen + Mic", m2));

            if !no_camera {
                let m3 = profile_instant_recording(
                    "INSTANT: FULL (screen+camera+mic, 1920w max)",
                    duration,
                    true,
                    !no_mic,
                    Some(1920),
                )
                .await;
                m3.print_summary("INSTANT: FULL");
                all_metrics.push(("Full", m3));
            }

            profile_sustained_instant(duration * 2, !no_mic).await;
        }
    }

    if !all_metrics.is_empty() {
        println!("\n{}", "=".repeat(60));
        println!("  COMPARISON TABLE");
        println!("{}\n", "=".repeat(60));

        let num_cores = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1);

        println!(
            "{:<20} {:>10} {:>12} {:>10} {:>12} {:>10}",
            "Test", "Avg CPU%", "CPU/core%", "RSS MB", "Size MB", "MB/min"
        );
        println!("{:-<78}", "");

        for (name, m) in &all_metrics {
            let avg_cpu = if m.cpu_samples.is_empty() {
                0.0
            } else {
                m.cpu_samples.iter().sum::<f64>() / m.cpu_samples.len() as f64
            };
            let rss = m.memory_samples.last().map(|s| s.1).unwrap_or(0.0);
            let size_mb = m.total_file_size_bytes as f64 / 1024.0 / 1024.0;
            let mb_per_min = size_mb / (m.recording_duration_secs / 60.0);

            println!(
                "{:<20} {:>10.1} {:>12.1} {:>10.1} {:>12.2} {:>10.1}",
                name,
                avg_cpu,
                avg_cpu / num_cores as f64,
                rss,
                size_mb,
                mb_per_min,
            );
        }
    }

    println!("\n=== Instant Mode Profiling Complete ===");
    Ok(())
}
