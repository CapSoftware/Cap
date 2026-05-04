use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{
        camera::{self, DeviceOrModelID},
        microphone,
    },
    memory_profiling::{CpuTracker, get_process_stats},
    screen_capture::ScreenCaptureTarget,
};
use kameo::Actor;
use scap_targets::Display;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

async fn profile_recording(
    label: &str,
    duration_secs: u64,
    include_camera: bool,
    include_mic: bool,
) {
    println!("\n{}", "=".repeat(60));
    println!("  {label} ({duration_secs}s)");
    println!("{}\n", "=".repeat(60));

    let mut cpu = CpuTracker::new();
    cpu.sample();

    let dir = tempfile::tempdir().expect("Failed to create tempdir");

    let mut builder = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(true);

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
    println!("Starting recording...");

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
    let sample_interval = Duration::from_secs(2);
    let mut next_sample = start + sample_interval;

    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_millis(100)).await;

        if Instant::now() >= next_sample {
            cpu.sample();
            let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
            if let Some(stats) = get_process_stats() {
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

    println!("\nStopping recording...");
    let stop_start = Instant::now();
    cpu.sample();

    let _ = handle.stop().await.expect("Failed to stop recording");

    let stop_duration = stop_start.elapsed();
    cpu.sample();

    if let Some(feed) = camera_feed_ref.take() {
        let _ = feed.ask(camera::RemoveInput).await;
    }
    if let Some(feed) = mic_feed_ref.take() {
        let _ = feed.ask(microphone::RemoveInput).await;
    }

    println!("Stop took: {stop_duration:?}");

    tokio::time::sleep(Duration::from_secs(1)).await;
    cpu.sample();

    cpu.print_report();

    std::mem::forget(dir);
}

async fn profile_idle_with_camera(duration_secs: u64) {
    println!("\n{}", "=".repeat(60));
    println!("  IDLE WITH CAMERA PREVIEW ({duration_secs}s)");
    println!("{}\n", "=".repeat(60));

    let mut cpu = CpuTracker::new();
    cpu.sample();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("No camera found");
        return;
    };
    println!("Camera: {}", camera_info.display_name());

    let feed = CameraFeed::spawn(CameraFeed::default());
    let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);

    feed.ask(camera::AddSender(frame_tx))
        .await
        .expect("AddSender failed");

    feed.ask(camera::SetInput {
        settings: None,
        id: DeviceOrModelID::from_info(&camera_info),
    })
    .await
    .expect("SetInput send failed")
    .await
    .expect("SetInput failed");

    let start = Instant::now();
    let mut frame_count = 0u64;
    let mut next_sample = start + Duration::from_secs(2);

    while start.elapsed() < Duration::from_secs(duration_secs) {
        match frame_rx.try_recv() {
            Ok(_) => frame_count += 1,
            Err(flume::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            Err(flume::TryRecvError::Disconnected) => break,
        }

        if Instant::now() >= next_sample {
            cpu.sample();
            let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
            if let Some(stats) = get_process_stats() {
                let fps = frame_count as f64 / start.elapsed().as_secs_f64();
                println!(
                    "[{:>5.1}s] CPU: {:>5.1}%  RSS: {:>6.1} MB  Threads: {}  Camera FPS: {:.1}",
                    start.elapsed().as_secs_f64(),
                    cpu_pct,
                    stats.resident_mb,
                    stats.thread_count,
                    fps,
                );
            }
            next_sample = Instant::now() + Duration::from_secs(2);
        }
    }

    feed.ask(camera::RemoveInput)
        .await
        .expect("RemoveInput failed");
    drop(frame_rx);

    cpu.sample();
    cpu.print_report();

    println!("\nCamera frames: {frame_count}");
    println!(
        "Effective FPS: {:.1}",
        frame_count as f64 / duration_secs as f64
    );
}

async fn profile_baseline(duration_secs: u64) {
    println!("\n{}", "=".repeat(60));
    println!("  BASELINE (idle process, {duration_secs}s)");
    println!("{}\n", "=".repeat(60));

    let mut cpu = CpuTracker::new();
    cpu.sample();

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(duration_secs) {
        tokio::time::sleep(Duration::from_secs(2)).await;
        cpu.sample();
        let cpu_pct = cpu.latest_cpu_percent().unwrap_or(0.0);
        if let Some(stats) = get_process_stats() {
            println!(
                "[{:>5.1}s] CPU: {:>5.1}%  RSS: {:>6.1} MB  Threads: {}",
                start.elapsed().as_secs_f64(),
                cpu_pct,
                stats.resident_mb,
                stats.thread_count,
            );
        }
    }

    cpu.print_report();
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

    println!("=== Cap CPU Profiler ===\n");
    println!("Mode: {mode}");
    println!("Duration: {duration}s per test");
    println!(
        "CPU cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );
    println!("Platform: {}\n", std::env::consts::OS);

    match mode {
        "baseline" => {
            profile_baseline(duration).await;
        }
        "camera" => {
            profile_idle_with_camera(duration).await;
        }
        "screen-only" => {
            profile_recording("SCREEN ONLY RECORDING", duration, false, false).await;
        }
        "full" => {
            profile_recording("FULL RECORDING (screen+camera+mic)", duration, true, true).await;
        }
        _ => {
            profile_baseline(5).await;
            profile_idle_with_camera(duration).await;
            profile_recording("SCREEN ONLY RECORDING", duration, false, false).await;
            profile_recording("FULL RECORDING (screen+camera+mic)", duration, true, true).await;
        }
    }

    println!("\n=== CPU Profiling Complete ===");
    Ok(())
}
