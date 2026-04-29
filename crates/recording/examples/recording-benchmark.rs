use cap_recording::{
    CameraFeed,
    benchmark::{BenchmarkConfig, EncoderInfo},
    feeds::camera::{self, DeviceOrModelID},
    screen_capture::ScreenCaptureTarget,
};
use kameo::Actor;
use scap_targets::Display;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::info;

async fn run_recording_benchmark(
    config: &BenchmarkConfig,
    include_camera: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let encoder_info = EncoderInfo::detect();
    encoder_info.print_info();

    let dir = tempfile::tempdir()?;
    info!("Recording to: {}", dir.path().display());

    let mut builder = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    );

    if include_camera {
        if let Some(camera_info) = cap_camera::list_cameras().next() {
            println!("\nUsing camera: {}", camera_info.display_name());

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
            println!("\nNo camera found, running without camera");
        }
    }

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

    tokio::time::sleep(Duration::from_secs(config.duration_secs)).await;

    println!("Stopping recording...");
    let stop_start = Instant::now();

    let result = handle.stop().await?;
    let stop_duration = stop_start.elapsed();
    let total_duration = start.elapsed();

    println!("\n=== Recording Benchmark Results ===\n");
    println!("Recording duration: {:.2}s", config.duration_secs);
    println!("Stop/finalize time: {stop_duration:?}");
    println!("Total time: {total_duration:?}");
    println!("Output path: {}", result.project_path.display());

    let content_dir = result
        .project_path
        .join("content")
        .join("segments")
        .join("segment-0");

    if let Ok(metadata) = std::fs::metadata(content_dir.join("display.mp4")) {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        let bitrate_mbps = size_mb * 8.0 / config.duration_secs as f64;
        println!("\nScreen recording:");
        println!("  Size: {size_mb:.2} MB");
        println!("  Bitrate: {bitrate_mbps:.2} Mbps");
    }

    if include_camera && let Ok(metadata) = std::fs::metadata(content_dir.join("camera.mp4")) {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        let bitrate_mbps = size_mb * 8.0 / config.duration_secs as f64;
        println!("\nCamera recording:");
        println!("  Size: {size_mb:.2} MB");
        println!("  Bitrate: {bitrate_mbps:.2} Mbps");
    }

    std::mem::forget(dir);

    Ok(())
}

async fn run_pause_resume_benchmark(duration_secs: u64) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Pause/Resume Benchmark ===\n");

    let dir = tempfile::tempdir()?;

    let handle = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .build(
        #[cfg(target_os = "macos")]
        Some(cap_recording::SendableShareableContent::from(
            cidre::sc::ShareableContent::current().await?,
        )),
    )
    .await?;

    let segment_duration = duration_secs / 4;

    println!("Recording segment 1...");
    tokio::time::sleep(Duration::from_secs(segment_duration)).await;

    println!("Pausing...");
    let pause_start = Instant::now();
    handle.pause().await?;
    println!("Pause took: {:?}", pause_start.elapsed());

    tokio::time::sleep(Duration::from_secs(1)).await;

    println!("Resuming...");
    let resume_start = Instant::now();
    handle.resume().await?;
    println!("Resume took: {:?}", resume_start.elapsed());

    println!("Recording segment 2...");
    tokio::time::sleep(Duration::from_secs(segment_duration)).await;

    println!("Stopping...");
    let stop_start = Instant::now();
    let _ = handle.stop().await?;
    println!("Stop took: {:?}", stop_start.elapsed());

    std::mem::forget(dir);

    Ok(())
}

async fn stress_test_recording(
    cycles: u32,
    cycle_duration_secs: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Recording Stress Test ===\n");
    println!("Running {cycles} cycles of {cycle_duration_secs}s recordings\n");

    let mut start_times = Vec::new();
    let mut stop_times = Vec::new();

    for i in 0..cycles {
        println!("Cycle {}/{}...", i + 1, cycles);

        let dir = tempfile::tempdir()?;

        let start = Instant::now();
        let handle = cap_recording::studio_recording::Actor::builder(
            dir.path().into(),
            ScreenCaptureTarget::Display {
                id: Display::primary().id(),
            },
        )
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current().await?,
            )),
        )
        .await?;
        start_times.push(start.elapsed());

        tokio::time::sleep(Duration::from_secs(cycle_duration_secs)).await;

        let stop_start = Instant::now();
        let _ = handle.stop().await?;
        stop_times.push(stop_start.elapsed());

        std::mem::forget(dir);
    }

    println!("\n=== Stress Test Results ===\n");

    let avg_start: Duration = start_times.iter().sum::<Duration>() / cycles;
    let max_start = start_times.iter().max().unwrap();
    let min_start = start_times.iter().min().unwrap();

    println!("Start times:");
    println!("  Average: {avg_start:?}");
    println!("  Min: {min_start:?}");
    println!("  Max: {max_start:?}");

    let avg_stop: Duration = stop_times.iter().sum::<Duration>() / cycles;
    let max_stop = stop_times.iter().max().unwrap();
    let min_stop = stop_times.iter().min().unwrap();

    println!("\nStop times:");
    println!("  Average: {avg_stop:?}");
    println!("  Min: {min_stop:?}");
    println!("  Max: {max_stop:?}");

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { std::env::set_var("RUST_LOG", "info") };
    tracing_subscriber::fmt::init();

    println!("=== Cap Recording Benchmark ===\n");

    let args: Vec<String> = std::env::args().collect();

    let config = BenchmarkConfig {
        duration_secs: args
            .iter()
            .position(|a| a == "--duration")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(10),
        warmup_secs: 0,
        target_fps: 30,
        camera_resolution: None,
        output_json: args.contains(&"--json".to_string()),
    };

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("full");

    let include_camera = args.contains(&"--camera".to_string());

    match mode {
        "screen" => {
            println!("Mode: Screen only recording");
            run_recording_benchmark(&config, false).await?;
        }
        "camera" => {
            println!("Mode: Screen + Camera recording");
            run_recording_benchmark(&config, true).await?;
        }
        "pause" => {
            println!("Mode: Pause/Resume test");
            run_pause_resume_benchmark(config.duration_secs).await?;
        }
        "stress" => {
            println!("Mode: Stress test");
            let cycles = args
                .iter()
                .position(|a| a == "--cycles")
                .and_then(|i| args.get(i + 1))
                .and_then(|s| s.parse().ok())
                .unwrap_or(5);
            stress_test_recording(cycles, config.duration_secs).await?;
        }
        _ => {
            println!("Mode: Full benchmark suite\n");

            println!("--- Screen Recording ---");
            run_recording_benchmark(&config, false).await?;

            if include_camera {
                println!("\n--- Screen + Camera Recording ---");
                run_recording_benchmark(&config, true).await?;
            }

            println!("\n--- Pause/Resume Test ---");
            run_pause_resume_benchmark(8).await?;
        }
    }

    println!("\n=== Benchmark Complete ===");

    Ok(())
}
