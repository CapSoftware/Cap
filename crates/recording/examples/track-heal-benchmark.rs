use std::{path::PathBuf, time::Instant};

use cap_recording::track_heal::heal_stretched_tracks;

fn read_bytes() -> Option<u64> {
    std::fs::read_to_string("/proc/self/io")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("rchar: "))
        .and_then(|value| value.trim().parse().ok())
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let path = args.next().map(PathBuf::from).ok_or_else(|| {
        anyhow::anyhow!("Pass a Studio project (.cap) and optionally a run count")
    })?;
    let runs: usize = args
        .next()
        .and_then(|runs| runs.to_str()?.parse().ok())
        .unwrap_or(1);
    ffmpeg::init()?;
    for run in 0..runs {
        let bytes_before = read_bytes();
        let started = Instant::now();
        let healed = heal_stretched_tracks(&path)?;
        let elapsed = started.elapsed();
        let bytes_read = bytes_before
            .zip(read_bytes())
            .map(|(before, after)| after - before);
        println!(
            "{}",
            serde_json::json!({
                "run": run,
                "elapsedMs": elapsed.as_secs_f64() * 1000.0,
                "bytesRead": bytes_read,
                "healed": healed,
            })
        );
    }
    Ok(())
}
