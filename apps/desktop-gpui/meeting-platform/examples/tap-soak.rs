#[cfg(target_os = "macos")]
fn main() {
    use std::{
        process::Command,
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::Duration,
    };

    fn resident_kb() -> u64 {
        Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|output| String::from_utf8_lossy(&output.stdout).trim().parse().ok())
            .unwrap_or(0)
    }

    let mut args = std::env::args().skip(1);
    let cycles: u32 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    let hold_ms: u64 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(150);
    let linger: u64 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    let frames = Arc::new(AtomicU64::new(0));
    let mut failures = 0u32;
    println!("start rss={}kB", resident_kb());
    for cycle in 1..=cycles {
        match cap_meeting_platform::SystemAudioTap::start(true, {
            let frames = frames.clone();
            move |chunk| {
                frames.fetch_add(chunk.samples.len() as u64, Ordering::Relaxed);
            }
        }) {
            Ok(tap) => {
                std::thread::sleep(Duration::from_millis(hold_ms));
                drop(tap);
            }
            Err(error) => {
                failures += 1;
                println!("cycle {cycle} failed: {error}");
            }
        }
        if cycle % 10 == 0 || cycle == cycles {
            println!(
                "cycle {cycle} rss={}kB frames={} failures={failures}",
                resident_kb(),
                frames.load(Ordering::Relaxed)
            );
        }
    }
    if linger > 0 {
        println!(
            "lingering {linger}s for inspection, pid {}",
            std::process::id()
        );
        std::thread::sleep(Duration::from_secs(linger));
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {}
