//! Runs the hover analysis the editor starts in the background on one
//! recording segment, at the same background priority, and reports wall time,
//! CPU time and peak memory. The segment's cached result is ignored.
//!
//! cargo run -p cap-editor --release --example hover-analysis-benchmark -- \
//!   --display <segment>/display.mp4 --cursor <segment>/cursor.json [--offset-ms 0]

use std::{
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

use cap_project::CursorEvents;

#[cfg(unix)]
fn usage() -> (Duration, u64) {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage fills the struct it is given.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let time = |tv: libc::timeval| {
        Duration::from_secs(tv.tv_sec as u64) + Duration::from_micros(tv.tv_usec as u64)
    };
    // ru_maxrss is bytes on macOS and kilobytes on Linux.
    let peak = if cfg!(target_os = "macos") {
        usage.ru_maxrss as u64
    } else {
        usage.ru_maxrss as u64 * 1024
    };
    (time(usage.ru_utime) + time(usage.ru_stime), peak)
}

#[cfg(not(unix))]
fn usage() -> (Duration, u64) {
    (Duration::ZERO, 0)
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let display = PathBuf::from(arg("--display").ok_or("--display <display.mp4> is required")?);
    let cursor_path = PathBuf::from(arg("--cursor").ok_or("--cursor <cursor.json> is required")?);
    let offset_ms: f64 = arg("--offset-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);

    ffmpeg::init().map_err(|e| e.to_string())?;
    let cursor = CursorEvents::load_from_file(&cursor_path)?;
    let cancel = AtomicBool::new(false);
    let (cpu_before, _) = usage();
    let started = Instant::now();
    let analysis = std::thread::spawn(move || {
        cap_editor::hover_analysis::lower_thread_priority();
        cap_editor::hover_analysis::analyze(
            &display,
            &cursor,
            offset_ms,
            &cancel,
            &|| false,
            &mut |_| {},
        )
    });
    let changes = analysis
        .join()
        .map_err(|_| "analysis panicked".to_string())??
        .unwrap_or_default();
    let wall = started.elapsed();
    let (cpu_after, peak) = usage();
    println!(
        "{}",
        serde_json::json!({
            "wallSecs": wall.as_secs_f64(),
            "cpuSecs": cpu_after.saturating_sub(cpu_before).as_secs_f64(),
            "peakRssMb": peak as f64 / 1_048_576.0,
            "changes": changes.len(),
        })
    );
    Ok(())
}
