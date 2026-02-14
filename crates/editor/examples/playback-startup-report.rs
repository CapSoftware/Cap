use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::PathBuf,
};

#[derive(Default)]
struct EventStats {
    decode_startup_ms: Vec<f64>,
    render_startup_ms: Vec<f64>,
    audio_stream_startup_ms: Vec<f64>,
    audio_prerender_startup_ms: Vec<f64>,
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((percentile / 100.0) * (sorted.len().saturating_sub(1) as f64)).round() as usize;
    sorted[index.min(sorted.len().saturating_sub(1))]
}

fn parse_startup_ms(line: &str) -> Option<f64> {
    if let Some(index) = line.find("startup_ms=") {
        let start = index + "startup_ms=".len();
        let tail = &line[start..];
        let end = tail
            .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
            .unwrap_or(tail.len());
        return tail[..end].parse::<f64>().ok();
    }

    if let Some(index) = line.find("\"startup_ms\":") {
        let start = index + "\"startup_ms\":".len();
        let tail = line[start..].trim_start();
        let end = tail
            .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
            .unwrap_or(tail.len());
        return tail[..end].parse::<f64>().ok();
    }

    None
}

fn print_metric(name: &str, values: &[f64]) {
    if values.is_empty() {
        println!("{name}: no samples");
        return;
    }

    let avg = values.iter().sum::<f64>() / values.len() as f64;
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let p50 = percentile(values, 50.0);
    let p95 = percentile(values, 95.0);

    println!(
        "{name}: samples={} avg={avg:.2}ms p50={p50:.2}ms p95={p95:.2}ms min={min:.2}ms max={max:.2}ms",
        values.len()
    );
}

fn parse_log(path: &PathBuf, stats: &mut EventStats) -> Result<(), String> {
    let file = File::open(path).map_err(|error| format!("open {} / {error}", path.display()))?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.map_err(|error| format!("read {} / {error}", path.display()))?;

        if let Some((event, startup_ms)) = parse_csv_startup_event(&line) {
            match event {
                "first_decoded_frame" => stats.decode_startup_ms.push(startup_ms),
                "first_rendered_frame" => stats.render_startup_ms.push(startup_ms),
                "audio_streaming_callback" => stats.audio_stream_startup_ms.push(startup_ms),
                "audio_prerender_callback" => stats.audio_prerender_startup_ms.push(startup_ms),
                _ => {}
            }
            continue;
        }

        let Some(startup_ms) = parse_startup_ms(&line) else {
            continue;
        };

        if line.contains("Playback first decoded frame ready") {
            stats.decode_startup_ms.push(startup_ms);
        } else if line.contains("Playback first frame rendered") {
            stats.render_startup_ms.push(startup_ms);
        } else if line.contains("Audio streaming callback started") {
            stats.audio_stream_startup_ms.push(startup_ms);
        } else if line.contains("Audio pre-rendered callback started") {
            stats.audio_prerender_startup_ms.push(startup_ms);
        }
    }

    Ok(())
}

fn parse_csv_startup_event(line: &str) -> Option<(&str, f64)> {
    let mut parts = line.splitn(4, ',');
    let _timestamp = parts.next()?;
    let event = parts.next()?;
    let startup_ms = parts.next()?.parse::<f64>().ok()?;
    Some((event, startup_ms))
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!("Usage: playback-startup-report --log <path> [--log <path> ...]");
        std::process::exit(1);
    }

    let mut logs = Vec::<PathBuf>::new();
    let mut index = 0usize;

    while index < args.len() {
        if args[index] == "--log" {
            if let Some(value) = args.get(index + 1) {
                logs.push(PathBuf::from(value));
                index += 2;
                continue;
            }
            eprintln!("Missing value for --log");
            std::process::exit(1);
        }

        eprintln!("Unknown argument: {}", args[index]);
        std::process::exit(1);
    }

    let mut stats = EventStats::default();
    for log in &logs {
        if let Err(error) = parse_log(log, &mut stats) {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }

    println!("Playback startup metrics");
    print_metric("first decoded frame", &stats.decode_startup_ms);
    print_metric("first rendered frame", &stats.render_startup_ms);
    print_metric("audio streaming callback", &stats.audio_stream_startup_ms);
    print_metric(
        "audio pre-rendered callback",
        &stats.audio_prerender_startup_ms,
    );
}
