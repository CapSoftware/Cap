use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{
        camera::{self, DeviceOrModelID},
        microphone,
    },
    memory_profiling::{
        CycleTestConfig, CycleTestResult, LeakVerdict, MemoryProfiler, get_memory_usage,
        print_channel_stats,
    },
    screen_capture::ScreenCaptureTarget,
};
use kameo::Actor;
use scap_targets::Display;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

async fn test_camera_cycles(config: &CycleTestConfig) -> CycleTestResult {
    println!("\n{}", "=".repeat(60));
    println!("  CAMERA START/STOP CYCLE TEST ({} cycles)", config.cycles);
    println!("{}\n", "=".repeat(60));

    let mut cycle_memories = Vec::new();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("No camera found, skipping");
        return CycleTestResult::from_memories(vec![]);
    };

    println!("Camera: {}", camera_info.display_name());
    let camera_id = DeviceOrModelID::from_info(&camera_info);

    for cycle in 0..config.cycles {
        let before = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);

        let feed = CameraFeed::spawn(CameraFeed::default());
        let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);

        feed.ask(camera::AddSender(frame_tx))
            .await
            .expect("AddSender failed");

        feed.ask(camera::SetInput {
            id: camera_id.clone(),
        })
        .await
        .expect("SetInput send failed")
        .await
        .expect("SetInput failed");

        let active_deadline = Instant::now() + config.active_duration;
        let mut frame_count = 0u64;

        while Instant::now() < active_deadline {
            match frame_rx.try_recv() {
                Ok(_) => frame_count += 1,
                Err(flume::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Err(flume::TryRecvError::Disconnected) => break,
            }
        }

        print_channel_stats("camera_rx", frame_rx.len(), Some(4));

        feed.ask(camera::RemoveInput)
            .await
            .expect("RemoveInput failed");

        drop(frame_rx);

        tokio::time::sleep(config.idle_duration).await;

        let after = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);
        let delta = after - before;
        println!(
            "  Cycle {}/{}: {frame_count} frames, memory {before:.1} -> {after:.1} MB ({delta:+.1})",
            cycle + 1,
            config.cycles
        );
        cycle_memories.push((before, after));
    }

    CycleTestResult::from_memories(cycle_memories)
}

async fn test_microphone_cycles(config: &CycleTestConfig) -> CycleTestResult {
    println!("\n{}", "=".repeat(60));
    println!(
        "  MICROPHONE START/STOP CYCLE TEST ({} cycles)",
        config.cycles
    );
    println!("{}\n", "=".repeat(60));

    let mut cycle_memories = Vec::new();

    let Some((mic_name, _, _)) = MicrophoneFeed::default_device() else {
        println!("No microphone found, skipping");
        return CycleTestResult::from_memories(vec![]);
    };

    println!("Microphone: {mic_name}");

    for cycle in 0..config.cycles {
        let before = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);

        let error_sender = flume::unbounded().0;
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));

        mic_feed
            .ask(microphone::SetInput {
                label: mic_name.clone(),
            })
            .await
            .expect("SetInput send failed")
            .await
            .expect("SetInput failed");

        tokio::time::sleep(config.active_duration).await;

        mic_feed
            .ask(microphone::RemoveInput)
            .await
            .expect("RemoveInput failed");

        tokio::time::sleep(config.idle_duration).await;

        let after = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);
        let delta = after - before;
        println!(
            "  Cycle {}/{}: memory {before:.1} -> {after:.1} MB ({delta:+.1})",
            cycle + 1,
            config.cycles
        );
        cycle_memories.push((before, after));
    }

    CycleTestResult::from_memories(cycle_memories)
}

async fn test_recording_cycles(
    config: &CycleTestConfig,
    include_camera: bool,
    include_mic: bool,
) -> CycleTestResult {
    let label = match (include_camera, include_mic) {
        (true, true) => "FULL RECORDING (screen+camera+mic)",
        (true, false) => "RECORDING (screen+camera)",
        (false, true) => "RECORDING (screen+mic)",
        (false, false) => "RECORDING (screen only)",
    };

    println!("\n{}", "=".repeat(60));
    println!("  {label} CYCLE TEST ({} cycles)", config.cycles);
    println!("{}\n", "=".repeat(60));

    let mut cycle_memories = Vec::new();

    for cycle in 0..config.cycles {
        let before = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);

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
            let feed = CameraFeed::spawn(CameraFeed::default());
            feed.ask(camera::SetInput {
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
            let error_sender = flume::unbounded().0;
            let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));
            mic_feed
                .ask(microphone::SetInput { label: mic_name })
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

        tokio::time::sleep(config.active_duration).await;

        let mid_memory = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);

        let _result = handle.stop().await.expect("Failed to stop recording");

        if let Some(feed) = camera_feed_ref.take() {
            let _ = feed.ask(camera::RemoveInput).await;
        }
        if let Some(feed) = mic_feed_ref.take() {
            let _ = feed.ask(microphone::RemoveInput).await;
        }

        tokio::time::sleep(config.idle_duration).await;
        std::mem::forget(dir);

        let after = get_memory_usage()
            .map(|s| s.primary_metric())
            .unwrap_or(0.0);
        let delta = after - before;
        println!(
            "  Cycle {}/{}: memory {before:.1} -> {mid_memory:.1} (active) -> {after:.1} MB (stopped) ({delta:+.1})",
            cycle + 1,
            config.cycles
        );
        cycle_memories.push((before, after));
    }

    CycleTestResult::from_memories(cycle_memories)
}

async fn test_sustained_recording(duration_secs: u64, include_camera: bool, include_mic: bool) {
    println!("\n{}", "=".repeat(60));
    println!("  SUSTAINED RECORDING TEST ({duration_secs}s)");
    println!("{}\n", "=".repeat(60));

    let mut profiler = MemoryProfiler::new();
    profiler.sample();

    let dir = tempfile::tempdir().expect("Failed to create tempdir");

    let mut builder = cap_recording::studio_recording::Actor::builder(
        dir.path().into(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(true);

    if include_camera && let Some(camera_info) = cap_camera::list_cameras().next() {
        println!("Camera: {}", camera_info.display_name());
        let feed = CameraFeed::spawn(CameraFeed::default());
        feed.ask(camera::SetInput {
            id: DeviceOrModelID::from_info(&camera_info),
        })
        .await
        .expect("camera SetInput send failed")
        .await
        .expect("camera SetInput failed");

        tokio::time::sleep(Duration::from_millis(500)).await;
        let lock = feed.ask(camera::Lock).await.expect("camera Lock failed");
        builder = builder.with_camera_feed(Arc::new(lock));
    }

    if include_mic && let Some((mic_name, _, _)) = MicrophoneFeed::default_device() {
        println!("Microphone: {mic_name}");
        let error_sender = flume::unbounded().0;
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_sender));
        mic_feed
            .ask(microphone::SetInput { label: mic_name })
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

    println!("\nStarting recording...");
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
    let mut next_sample = Instant::now() + Duration::from_secs(2);

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
            next_sample = Instant::now() + Duration::from_secs(2);
        }
    }

    println!("\nStopping recording...");
    profiler.sample();
    let _ = handle.stop().await.expect("Failed to stop recording");

    tokio::time::sleep(Duration::from_secs(2)).await;
    profiler.sample();

    profiler.print_report();

    let result = profiler.check_for_leaks();
    println!("\nFinal verdict: {}", result.verdict);

    std::mem::forget(dir);
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
        .unwrap_or(10u64);

    let cycles = args
        .iter()
        .position(|a| a == "--cycles")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(5u32);

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("all");

    let no_camera = args.contains(&"--no-camera".to_string());
    let no_mic = args.contains(&"--no-mic".to_string());

    let cycle_config = CycleTestConfig {
        cycles,
        active_duration: Duration::from_secs(duration),
        idle_duration: Duration::from_secs(2),
    };

    println!("=== Cap Memory Stress Test ===\n");
    println!("Mode: {mode}");
    println!("Cycles: {cycles}");
    println!("Active duration per cycle: {duration}s");
    println!("Camera: {}", if no_camera { "disabled" } else { "enabled" });
    println!(
        "Microphone: {}",
        if no_mic { "disabled" } else { "enabled" }
    );
    #[cfg(feature = "memory-profiling")]
    println!("dhat heap profiling: ENABLED");
    #[cfg(not(feature = "memory-profiling"))]
    println!("dhat heap profiling: disabled (enable with --features memory-profiling)");

    let mut all_results: Vec<(&str, CycleTestResult)> = Vec::new();

    match mode {
        "camera" => {
            let result = test_camera_cycles(&cycle_config).await;
            result.print_report("Camera");
            all_results.push(("Camera", result));
        }
        "mic" => {
            let result = test_microphone_cycles(&cycle_config).await;
            result.print_report("Microphone");
            all_results.push(("Microphone", result));
        }
        "recording" => {
            let result = test_recording_cycles(&cycle_config, !no_camera, !no_mic).await;
            result.print_report("Recording");
            all_results.push(("Recording", result));
        }
        "screen-only" => {
            let result = test_recording_cycles(&cycle_config, false, false).await;
            result.print_report("Screen Only Recording");
            all_results.push(("Screen Only", result));
        }
        "sustained" => {
            let sustained_duration = duration * cycles as u64;
            test_sustained_recording(sustained_duration, !no_camera, !no_mic).await;
        }
        _ => {
            if !no_camera {
                let result = test_camera_cycles(&cycle_config).await;
                result.print_report("Camera");
                all_results.push(("Camera", result));
            }

            if !no_mic {
                let result = test_microphone_cycles(&cycle_config).await;
                result.print_report("Microphone");
                all_results.push(("Microphone", result));
            }

            let result = test_recording_cycles(&cycle_config, false, false).await;
            result.print_report("Screen Only Recording");
            all_results.push(("Screen Only", result));

            let result = test_recording_cycles(&cycle_config, !no_camera, !no_mic).await;
            result.print_report("Full Recording");
            all_results.push(("Full Recording", result));

            let sustained_duration = duration * 3;
            test_sustained_recording(sustained_duration, !no_camera, !no_mic).await;
        }
    }

    if !all_results.is_empty() {
        println!("\n{}", "=".repeat(60));
        println!("  FINAL SUMMARY");
        println!("{}\n", "=".repeat(60));

        let mut any_leaks = false;
        for (name, result) in &all_results {
            let status = match result.verdict {
                LeakVerdict::Clean => "PASS",
                LeakVerdict::PossibleLeak => "WARN",
                LeakVerdict::Leak => "FAIL",
                LeakVerdict::SevereLeak => "FAIL",
            };
            println!(
                "  [{status}] {name}: {:.2} MB/cycle, total {:.1} MB over {} cycles",
                result.per_cycle_growth_mb,
                result.total_growth_mb,
                result.cycle_memories.len()
            );
            if result.verdict != LeakVerdict::Clean {
                any_leaks = true;
            }
        }

        if any_leaks {
            println!("\n*** MEMORY ISSUES DETECTED - See individual test reports above ***");
            #[cfg(not(feature = "memory-profiling"))]
            println!("TIP: Re-run with --features memory-profiling for heap allocation details");
        } else {
            println!("\nAll subsystems passed memory checks.");
        }
    }

    Ok(())
}
