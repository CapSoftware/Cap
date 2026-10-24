//! Runs the real cursor recorder on the primary display and reports the CPU
//! the process spent while it polled. Leave the mouse alone while it runs.
//!
//! cargo run -p cap-recording --release --example cursor-poll-benchmark -- --keyboard off --seconds 30

use cap_recording::{
    cursor::{CursorCaptureTarget, IncrementalCaptureOutputs, spawn_cursor_recorder},
    screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use std::time::{Duration, Instant};

#[cfg(unix)]
fn process_cpu() -> Option<Duration> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage fills the struct it is given.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let time = |tv: libc::timeval| {
        Duration::from_secs(tv.tv_sec as u64) + Duration::from_micros(tv.tv_usec as u64)
    };
    Some(time(usage.ru_utime) + time(usage.ru_stime))
}

#[cfg(not(unix))]
fn process_cpu() -> Option<Duration> {
    None
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let keyboard = arg("--keyboard").as_deref() != Some("off");
    let seconds: u64 = arg("--seconds").and_then(|s| s.parse().ok()).unwrap_or(30);

    let display = Display::primary();
    let crop_bounds = ScreenCaptureTarget::Display { id: display.id() }
        .cursor_crop()
        .ok_or_else(|| anyhow::anyhow!("No crop bounds for the primary display"))?;
    let dir = tempfile::tempdir()?;

    let started_cpu = process_cpu();
    let started = Instant::now();
    let mut actor = spawn_cursor_recorder(
        CursorCaptureTarget {
            crop_bounds,
            display,
            #[cfg(target_os = "linux")]
            window: None,
        },
        dir.path().join("cursors"),
        Default::default(),
        0,
        cap_timestamp::Timestamps::now(),
        None,
        IncrementalCaptureOutputs {
            cursor: None,
            keyboard: None,
        },
        keyboard,
    );
    std::thread::sleep(Duration::from_secs(seconds));
    actor.stop();
    let wall = started.elapsed();
    let cpu = process_cpu()
        .zip(started_cpu)
        .map(|(now, started)| now.saturating_sub(started).as_secs_f64());
    let response = futures::executor::block_on(actor.rx.clone())
        .map_err(|_| anyhow::anyhow!("The cursor recorder exited without a response"))?;

    let keys: Vec<String> = response
        .keyboard_presses
        .iter()
        .map(|press| format!("{} {}", press.key_code, press.down))
        .collect();

    println!(
        "{}",
        serde_json::json!({
            "keyboard": keyboard,
            "wallSecs": wall.as_secs_f64(),
            "cpuMs": cpu.map(|cpu| cpu * 1000.0),
            "cpuPercent": cpu.map(|cpu| cpu / wall.as_secs_f64() * 100.0),
            "moves": response.moves.len(),
            "clicks": response.clicks.len(),
            "keys": keys,
        })
    );
    Ok(())
}
