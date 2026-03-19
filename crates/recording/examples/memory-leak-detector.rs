use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{
        camera::{self, DeviceOrModelID},
        microphone,
    },
    screen_capture::ScreenCaptureTarget,
};
use kameo::Actor;
use scap_targets::Display;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::{info, warn};

const DEFAULT_DURATION_SECS: u64 = 120;

#[cfg(target_os = "macos")]
fn get_memory_usage() -> Option<MemoryStats> {
    use libproc::libproc::pid_rusage::{RUsageInfoV4, pidrusage};

    let pid = std::process::id() as i32;
    let rusage: RUsageInfoV4 = pidrusage(pid).ok()?;

    Some(MemoryStats {
        resident_mb: rusage.ri_resident_size as f64 / 1024.0 / 1024.0,
        footprint_mb: Some(rusage.ri_phys_footprint as f64 / 1024.0 / 1024.0),
        dirty_mb: None,
        compressed_mb: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn get_memory_usage() -> Option<MemoryStats> {
    None
}

#[derive(Debug, Clone, Copy)]
struct MemoryStats {
    resident_mb: f64,
    footprint_mb: Option<f64>,
    #[allow(dead_code)]
    dirty_mb: Option<f64>,
    #[allow(dead_code)]
    compressed_mb: Option<f64>,
}

impl MemoryStats {
    fn primary_metric(&self) -> f64 {
        self.footprint_mb.unwrap_or(self.resident_mb)
    }

    fn metric_name() -> &'static str {
        "Footprint"
    }
}

struct MemoryTracker {
    samples: Vec<(Duration, MemoryStats)>,
    start: Instant,
    baseline: Option<MemoryStats>,
}

impl MemoryTracker {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
            start: Instant::now(),
            baseline: get_memory_usage(),
        }
    }

    fn sample(&mut self) {
        if let Some(stats) = get_memory_usage() {
            self.samples.push((self.start.elapsed(), stats));
        }
    }

    fn print_report(&self) {
        println!("\n=== Memory Usage Report ===\n");

        if let Some(baseline) = self.baseline {
            println!(
                "Baseline: {:.1} MB {} (RSS: {:.1} MB)",
                baseline.primary_metric(),
                MemoryStats::metric_name(),
                baseline.resident_mb
            );
        }

        if self.samples.len() < 2 {
            println!("Not enough samples to analyze");
            return;
        }

        let first = &self.samples[0];
        let last = &self.samples[self.samples.len() - 1];

        let duration_secs = last.0.as_secs_f64() - first.0.as_secs_f64();
        let memory_growth = last.1.primary_metric() - first.1.primary_metric();
        let growth_rate = if duration_secs > 0.0 {
            memory_growth / duration_secs
        } else {
            0.0
        };

        println!("\nMemory Timeline:");
        println!(
            "{:>8} {:>14} {:>10} {:>12}",
            "Time(s)", "Footprint(MB)", "Delta", "RSS(MB)"
        );
        println!("{:-<50}", "");

        let mut prev_memory = first.1.primary_metric();
        for (time, stats) in &self.samples {
            let current = stats.primary_metric();
            let delta = current - prev_memory;
            let delta_str = if delta.abs() > 0.5 {
                format!("{delta:+.1}")
            } else {
                "~0".to_string()
            };
            println!(
                "{:>8.1} {:>14.1} {:>10} {:>12.1}",
                time.as_secs_f64(),
                current,
                delta_str,
                stats.resident_mb
            );
            prev_memory = current;
        }

        println!("\n=== Summary ===");
        println!("Duration: {duration_secs:.1}s");
        println!("Start Footprint: {:.1} MB", first.1.primary_metric());
        println!("End Footprint: {:.1} MB", last.1.primary_metric());
        println!("Total growth: {memory_growth:.1} MB");
        println!(
            "Growth rate: {:.2} MB/s ({:.1} MB/10s)",
            growth_rate,
            growth_rate * 10.0
        );

        if growth_rate > 20.0 {
            println!(
                "\n*** SEVERE MEMORY LEAK: Growth rate > 20 MB/s ({:.0} MB/10s) ***",
                growth_rate * 10.0
            );
        } else if growth_rate > 5.0 {
            println!(
                "\n*** MEMORY LEAK DETECTED: Growth rate > 5 MB/s ({:.0} MB/10s) ***",
                growth_rate * 10.0
            );
        } else if growth_rate > 1.0 {
            println!(
                "\n*** POTENTIAL LEAK: Growth rate > 1 MB/s ({:.1} MB/10s) ***",
                growth_rate * 10.0
            );
        } else {
            println!("\n[OK] Memory appears stable (< 1 MB/s growth)");
        }

        println!(
            "\nPeak Footprint: {:.1} MB",
            self.samples
                .iter()
                .map(|(_, s)| s.primary_metric())
                .fold(0.0_f64, |a, b| a.max(b))
        );
    }
}

async fn run_memory_test(
    duration_secs: u64,
    include_camera: bool,
    include_mic: bool,
    fragmented: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Cap Memory Leak Detector ===\n");
    println!("Configuration:");
    println!("  Duration: {duration_secs}s");
    println!("  Camera: {include_camera}");
    println!("  Microphone: {include_mic}");
    println!("  Fragmented MP4: {fragmented}");
    println!();

    let mut memory_tracker = MemoryTracker::new();
    memory_tracker.sample();

    let dir = tempfile::tempdir()?;
    info!("Recording to: {}", dir.path().display());

    let mut builder = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_fragmented(fragmented)
    .with_system_audio(true);

    if include_camera {
        if let Some(camera_info) = cap_camera::list_cameras().next() {
            println!("Using camera: {}", camera_info.display_name());

            let feed = CameraFeed::spawn(CameraFeed::default());

            feed.ask(camera::SetInput {
                id: DeviceOrModelID::from_info(&camera_info),
            })
            .await?
            .await?;

            tokio::time::sleep(Duration::from_millis(500)).await;

            let lock = feed.ask(camera::Lock).await?;
            builder = builder.with_camera_feed(Arc::new(lock));
        } else {
            warn!("No camera found");
        }
    }

    if include_mic {
        if let Some((mic_name, _, _)) = MicrophoneFeed::default_device() {
            println!("Using microphone: {mic_name}");

            let error_sender = flume::unbounded().0;
            let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));

            mic_feed
                .ask(microphone::SetInput {
                    label: mic_name.clone(),
                })
                .await?
                .await?;

            tokio::time::sleep(Duration::from_millis(500)).await;

            let mic_lock = mic_feed.ask(microphone::Lock).await?;
            builder = builder.with_mic_feed(Arc::new(mic_lock));
        } else {
            warn!("No microphone found");
        }
    }

    memory_tracker.sample();
    println!("\nStarting recording...");
    let start = Instant::now();

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current().await?,
            )),
        )
        .await?;

    let sample_interval = Duration::from_secs(1);
    let mut next_sample = start + sample_interval;

    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_millis(100)).await;

        if Instant::now() >= next_sample {
            memory_tracker.sample();
            let current = get_memory_usage();
            if let Some(stats) = current {
                println!(
                    "[{:>5.1}s] Footprint: {:.1} MB, RSS: {:.1} MB",
                    start.elapsed().as_secs_f64(),
                    stats.footprint_mb.unwrap_or(0.0),
                    stats.resident_mb
                );
            }
            next_sample = Instant::now() + sample_interval;
        }
    }

    println!("\nStopping recording...");
    memory_tracker.sample();

    let stop_start = Instant::now();
    let result = handle.stop().await?;
    let stop_duration = stop_start.elapsed();

    memory_tracker.sample();

    println!("Stop took: {stop_duration:?}");
    println!("Output path: {}", result.project_path.display());

    memory_tracker.print_report();

    std::mem::forget(dir);

    Ok(())
}

async fn run_camera_only_test(duration_secs: u64) -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Camera Only Test (no encoding) ===\n");

    let mut memory_tracker = MemoryTracker::new();
    memory_tracker.sample();

    if let Some(camera_info) = cap_camera::list_cameras().next() {
        println!("Testing camera: {}", camera_info.display_name());

        let feed = CameraFeed::spawn(CameraFeed::default());

        let (frame_tx, frame_rx) = flume::bounded::<cap_recording::NativeCameraFrame>(128);

        feed.ask(camera::AddNativeSender(frame_tx)).await?;

        feed.ask(camera::SetInput {
            id: DeviceOrModelID::from_info(&camera_info),
        })
        .await?
        .await?;

        let start = Instant::now();
        let sample_interval = Duration::from_secs(1);
        let mut next_sample = start + sample_interval;
        let mut frame_count = 0u64;

        while start.elapsed() < Duration::from_secs(duration_secs) {
            match frame_rx.try_recv() {
                Ok(_frame) => {
                    frame_count += 1;
                }
                Err(flume::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Err(flume::TryRecvError::Disconnected) => break,
            }

            if Instant::now() >= next_sample {
                memory_tracker.sample();
                let current = get_memory_usage();
                let queue_len = frame_rx.len();
                if let Some(stats) = current {
                    println!(
                        "[{:>5.1}s] Footprint: {:.1} MB, RSS: {:.1} MB, Frames: {}, Queue: {}",
                        start.elapsed().as_secs_f64(),
                        stats.footprint_mb.unwrap_or(0.0),
                        stats.resident_mb,
                        frame_count,
                        queue_len
                    );
                }
                next_sample = Instant::now() + sample_interval;
            }
        }

        feed.ask(camera::RemoveInput).await?;
    } else {
        println!("No camera found");
    }

    memory_tracker.print_report();
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { std::env::set_var("RUST_LOG", "info,cap_recording=debug") };
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();

    let duration = args
        .iter()
        .position(|a| a == "--duration")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_DURATION_SECS);

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("full");

    let include_camera = !args.contains(&"--no-camera".to_string());
    let include_mic = !args.contains(&"--no-mic".to_string());
    let fragmented = !args.contains(&"--no-fragmented".to_string());

    match mode {
        "full" => {
            run_memory_test(duration, include_camera, include_mic, fragmented).await?;
        }
        "screen-only" => {
            run_memory_test(duration, false, false, fragmented).await?;
        }
        "no-fragmented" => {
            run_memory_test(duration, include_camera, include_mic, false).await?;
        }
        "camera-only" => {
            run_camera_only_test(duration).await?;
        }
        "compare" => {
            println!("=== Comparison Test ===\n");
            println!("First: Testing WITHOUT fragmented MP4...\n");
            run_memory_test(60, include_camera, include_mic, false).await?;

            println!("\n\n====================================\n");
            println!("Second: Testing WITH fragmented MP4...\n");
            run_memory_test(60, include_camera, include_mic, true).await?;
        }
        _ => {
            println!("Cap Memory Leak Detector");
            println!();
            println!("Usage: memory-leak-detector [OPTIONS]");
            println!();
            println!("Options:");
            println!("  --duration <secs>   Test duration (default: {DEFAULT_DURATION_SECS})");
            println!("  --mode <mode>       Test mode:");
            println!("      full            Full recording pipeline with fragmented MP4 (default)");
            println!("      screen-only     Screen recording only (no camera/mic)");
            println!("      no-fragmented   Full recording without fragmented MP4");
            println!("      camera-only     Camera feed only (no encoding)");
            println!("      compare         Run both fragmented and non-fragmented for comparison");
            println!("  --no-camera         Disable camera");
            println!("  --no-mic            Disable microphone");
            println!("  --no-fragmented     Disable fragmented MP4 encoding");
            println!();
            println!("Examples:");
            println!("  # Test full pipeline with camera, mic, fragmented MP4 for 2 minutes");
            println!("  cargo run --example memory-leak-detector -- --duration 120");
            println!();
            println!("  # Test screen-only to isolate the leak");
            println!("  cargo run --example memory-leak-detector -- --mode screen-only");
            println!();
            println!("  # Compare fragmented vs non-fragmented");
            println!("  cargo run --example memory-leak-detector -- --mode compare");
        }
    }

    Ok(())
}
