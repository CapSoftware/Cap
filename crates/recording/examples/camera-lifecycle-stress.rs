use cap_recording::{
    CameraFeed,
    feeds::camera::{self, DeviceOrModelID},
};
use kameo::Actor;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
fn get_memory_mb() -> Option<f64> {
    use libproc::libproc::pid_rusage::{RUsageInfoV4, pidrusage};
    let pid = std::process::id() as i32;
    let rusage: RUsageInfoV4 = pidrusage(pid).ok()?;
    Some(rusage.ri_phys_footprint as f64 / 1024.0 / 1024.0)
}

#[cfg(not(target_os = "macos"))]
fn get_memory_mb() -> Option<f64> {
    None
}

fn thread_count() -> usize {
    std::fs::read_dir("/proc/self/task")
        .map(|d| d.count())
        .unwrap_or_else(|_| {
            #[cfg(target_os = "macos")]
            {
                use std::process::Command;
                Command::new("ps")
                    .args(["-M", "-p", &std::process::id().to_string()])
                    .output()
                    .ok()
                    .and_then(|o| {
                        String::from_utf8(o.stdout)
                            .ok()
                            .map(|s| s.lines().count().saturating_sub(1))
                    })
                    .unwrap_or(0)
            }
            #[cfg(not(target_os = "macos"))]
            {
                0
            }
        })
}

struct Snapshot {
    label: String,
    memory_mb: f64,
    threads: usize,
    #[allow(dead_code)]
    elapsed: Duration,
}

struct Tracker {
    snapshots: Vec<Snapshot>,
    start: Instant,
}

impl Tracker {
    fn new() -> Self {
        Self {
            snapshots: Vec::new(),
            start: Instant::now(),
        }
    }

    fn snap(&mut self, label: &str) {
        let memory_mb = get_memory_mb().unwrap_or(0.0);
        let threads = thread_count();
        let elapsed = self.start.elapsed();
        println!(
            "  [{:>6.1}s] {:<45} Memory: {:>6.1} MB  Threads: {}",
            elapsed.as_secs_f64(),
            label,
            memory_mb,
            threads,
        );
        self.snapshots.push(Snapshot {
            label: label.to_string(),
            memory_mb,
            threads,
            elapsed,
        });
    }

    fn report(&self) {
        println!("\n{}", "=".repeat(72));
        println!("  SUMMARY");
        println!("{}\n", "=".repeat(72));

        if self.snapshots.len() < 2 {
            println!("  Not enough snapshots.");
            return;
        }

        let first = &self.snapshots[0];
        let last = &self.snapshots[self.snapshots.len() - 1];
        let peak = self
            .snapshots
            .iter()
            .map(|s| s.memory_mb)
            .fold(0.0_f64, f64::max);
        let peak_threads = self.snapshots.iter().map(|s| s.threads).max().unwrap_or(0);
        let end_threads = last.threads;

        println!("  Start memory:    {:>6.1} MB", first.memory_mb);
        println!("  End memory:      {:>6.1} MB", last.memory_mb);
        println!("  Peak memory:     {:>6.1} MB", peak);
        println!(
            "  Net growth:      {:>+6.1} MB",
            last.memory_mb - first.memory_mb
        );
        println!("  Peak threads:    {}", peak_threads);
        println!("  Final threads:   {}", end_threads);

        let cycle_starts: Vec<&Snapshot> = self
            .snapshots
            .iter()
            .filter(|s| s.label.starts_with("Before cycle"))
            .collect();

        if cycle_starts.len() >= 2 {
            let growth_first_to_last =
                cycle_starts.last().unwrap().memory_mb - cycle_starts.first().unwrap().memory_mb;
            let per_cycle = growth_first_to_last / (cycle_starts.len() as f64 - 1.0);

            println!("\n  Per-cycle analysis ({} cycles):", cycle_starts.len());
            println!("    Growth across cycles: {:>+.1} MB", growth_first_to_last);
            println!("    Avg per cycle:        {:>+.2} MB", per_cycle);

            if per_cycle > 5.0 {
                println!(
                    "\n  *** MEMORY LEAK DETECTED: {:>+.1} MB/cycle ***",
                    per_cycle
                );
            } else if per_cycle > 1.0 {
                println!("\n  *** POTENTIAL LEAK: {:>+.1} MB/cycle ***", per_cycle);
            } else {
                println!("\n  [OK] Memory stable across cycles (< 1 MB/cycle)");
            }
        }

        let thread_starts: Vec<&Snapshot> = self
            .snapshots
            .iter()
            .filter(|s| s.label.starts_with("Before cycle"))
            .collect();

        if thread_starts.len() >= 2 {
            let thread_growth = thread_starts.last().unwrap().threads as i64
                - thread_starts.first().unwrap().threads as i64;

            if thread_growth > 2 {
                println!(
                    "  *** THREAD LEAK: {} threads accumulated across cycles ***",
                    thread_growth
                );
            } else {
                println!("  [OK] Thread count stable across cycles");
            }
        }
    }
}

async fn run_lifecycle_stress(
    cycles: usize,
    run_secs: u64,
    pause_secs: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n{}", "=".repeat(72));
    println!("  CAMERA FEED LIFECYCLE STRESS TEST");
    println!(
        "  {} cycles x {}s active + {}s paused",
        cycles, run_secs, pause_secs
    );
    println!("{}\n", "=".repeat(72));

    let mut tracker = Tracker::new();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("  No camera found, aborting.");
        return Ok(());
    };
    println!("  Camera: {}\n", camera_info.display_name());

    let camera_id = DeviceOrModelID::from_info(&camera_info);

    tracker.snap("Baseline (before any camera)");

    let feed = CameraFeed::spawn(CameraFeed::default());
    let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);

    tracker.snap("After CameraFeed actor spawned");

    for cycle in 1..=cycles {
        println!("\n  --- Cycle {cycle}/{cycles} ---");
        tracker.snap(&format!("Before cycle {cycle}"));

        feed.ask(camera::AddSender(frame_tx.clone()))
            .await
            .expect("AddSender failed");

        feed.ask(camera::SetInput {
            settings: None,
            id: camera_id.clone(),
        })
        .await
        .expect("SetInput send failed")
        .await
        .expect("SetInput failed");

        tracker.snap(&format!("Cycle {cycle}: camera active"));

        let start = Instant::now();
        let mut received = 0u64;
        while start.elapsed() < Duration::from_secs(run_secs) {
            match frame_rx.try_recv() {
                Ok(_) => received += 1,
                Err(flume::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(flume::TryRecvError::Disconnected) => break,
            }
        }

        let fps = received as f64 / run_secs as f64;
        println!(
            "    Received {} frames ({:.1} FPS) over {}s",
            received, fps, run_secs
        );

        if received == 0 {
            println!("    *** WARNING: Zero frames received! Camera may be stuck. ***");
        }

        tracker.snap(&format!("Cycle {cycle}: before RemoveInput"));

        let remove_start = Instant::now();
        feed.ask(camera::RemoveInput)
            .await
            .expect("RemoveInput failed");
        let remove_ms = remove_start.elapsed().as_millis();

        if remove_ms > 2000 {
            println!(
                "    *** WARNING: RemoveInput took {}ms (>2s) ***",
                remove_ms
            );
        } else {
            println!("    RemoveInput took {}ms", remove_ms);
        }

        tracker.snap(&format!("Cycle {cycle}: after RemoveInput"));

        if pause_secs > 0 && cycle < cycles {
            println!("    Pausing {}s...", pause_secs);
            tokio::time::sleep(Duration::from_secs(pause_secs)).await;
            tracker.snap(&format!("Cycle {cycle}: after pause"));
        }
    }

    drop(frame_rx);
    tokio::time::sleep(Duration::from_secs(1)).await;
    tracker.snap("After all cycles + 1s settle");

    tracker.report();
    Ok(())
}

async fn run_rapid_toggle(toggles: usize) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n{}", "=".repeat(72));
    println!("  RAPID CAMERA TOGGLE TEST ({} toggles)", toggles);
    println!("{}\n", "=".repeat(72));

    let mut tracker = Tracker::new();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("  No camera found, aborting.");
        return Ok(());
    };
    println!("  Camera: {}\n", camera_info.display_name());

    let camera_id = DeviceOrModelID::from_info(&camera_info);
    let feed = CameraFeed::spawn(CameraFeed::default());
    let (frame_tx, _frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);

    tracker.snap("Baseline");

    for i in 1..=toggles {
        feed.ask(camera::AddSender(frame_tx.clone()))
            .await
            .expect("AddSender failed");

        feed.ask(camera::SetInput {
            settings: None,
            id: camera_id.clone(),
        })
        .await
        .expect("SetInput send failed")
        .await
        .expect("SetInput failed");

        tokio::time::sleep(Duration::from_millis(500)).await;

        feed.ask(camera::RemoveInput)
            .await
            .expect("RemoveInput failed");

        tokio::time::sleep(Duration::from_millis(200)).await;

        if i % 5 == 0 || i == toggles {
            tracker.snap(&format!("After toggle {i}/{toggles}"));
        }
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    tracker.snap("Final (2s after last toggle)");

    tracker.report();
    Ok(())
}

async fn run_setinput_after_unlock(cycles: usize) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n{}", "=".repeat(72));
    println!("  SETINPUT AFTER UNLOCK TEST ({} cycles)", cycles);
    println!("  (Simulates: record → stop → reopen camera)");
    println!("{}\n", "=".repeat(72));

    let mut tracker = Tracker::new();

    let Some(camera_info) = cap_camera::list_cameras().next() else {
        println!("  No camera found, aborting.");
        return Ok(());
    };
    println!("  Camera: {}\n", camera_info.display_name());

    let camera_id = DeviceOrModelID::from_info(&camera_info);

    tracker.snap("Baseline");

    for cycle in 1..=cycles {
        println!("\n  --- Cycle {cycle}/{cycles} ---");

        let feed = CameraFeed::spawn(CameraFeed::default());
        let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);

        feed.ask(camera::AddSender(frame_tx.clone()))
            .await
            .expect("AddSender");

        feed.ask(camera::SetInput {
            settings: None,
            id: camera_id.clone(),
        })
        .await
        .expect("SetInput send")
        .await
        .expect("SetInput init");

        tokio::time::sleep(Duration::from_millis(300)).await;

        let lock = feed.ask(camera::Lock).await.expect("Lock failed");
        println!("    Locked camera for 'recording'");

        tokio::time::sleep(Duration::from_secs(2)).await;

        drop(lock);
        println!("    Unlocked (recording stopped)");

        tokio::time::sleep(Duration::from_millis(500)).await;

        let setinput_start = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            feed.ask(camera::SetInput {
                settings: None,
                id: camera_id.clone(),
            })
            .await
            .expect("SetInput send")
            .await
        })
        .await;

        match result {
            Ok(Ok(_)) => {
                let ms = setinput_start.elapsed().as_millis();
                println!("    SetInput after Unlock: OK ({}ms)", ms);
                if ms > 3000 {
                    println!(
                        "    *** WARNING: SetInput took {}ms (>3s), possible blocking ***",
                        ms
                    );
                }
            }
            Ok(Err(e)) => {
                println!("    *** SetInput after Unlock FAILED: {} ***", e);
            }
            Err(_) => {
                println!("    *** TIMEOUT: SetInput blocked for >10s after Unlock! ***");
                println!("    This is the actor deadlock bug.");
                tracker.snap(&format!("Cycle {cycle}: DEADLOCK"));
                tracker.report();
                return Err("SetInput deadlock after Unlock".into());
            }
        }

        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut drained = 0u64;
        let drain_start = Instant::now();
        while drain_start.elapsed() < Duration::from_secs(1) {
            match frame_rx.try_recv() {
                Ok(_) => drained += 1,
                Err(flume::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(flume::TryRecvError::Disconnected) => break,
            }
        }
        println!("    Drained {drained} frames in 1s after re-SetInput");

        if drained == 0 {
            println!("    *** WARNING: Zero frames after re-SetInput ***");
        }

        feed.ask(camera::RemoveInput).await.expect("RemoveInput");

        drop(frame_rx);
        tokio::time::sleep(Duration::from_millis(500)).await;

        tracker.snap(&format!("Cycle {cycle} complete"));
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    tracker.snap("Final settle");

    tracker.report();
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    unsafe { std::env::set_var("RUST_LOG", "info,cap_recording=debug") };
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();

    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).map(|s| s.as_str()))
        .unwrap_or("all");

    let cycles: usize = args
        .iter()
        .position(|a| a == "--cycles")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let run_secs: u64 = args
        .iter()
        .position(|a| a == "--run-secs")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);

    println!("=== Camera Lifecycle Stress Test ===\n");
    println!("Platform: {}", std::env::consts::OS);
    println!(
        "CPU cores: {}",
        std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1)
    );

    match mode {
        "lifecycle" => {
            run_lifecycle_stress(cycles, run_secs, 1).await?;
        }
        "rapid" => {
            run_rapid_toggle(cycles * 5).await?;
        }
        "unlock" => {
            run_setinput_after_unlock(cycles).await?;
        }
        _ => {
            run_lifecycle_stress(cycles, run_secs, 1).await?;
            run_rapid_toggle(cycles * 3).await?;
            run_setinput_after_unlock(5).await?;
        }
    }

    println!("\n=== Camera Lifecycle Stress Test Complete ===");
    Ok(())
}
