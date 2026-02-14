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

#[derive(Clone, Copy)]
struct MetricSummary {
    samples: usize,
    avg: f64,
    p50: f64,
    p95: f64,
    min: f64,
    max: f64,
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
    let Some(summary) = summarize(values) else {
        println!("{name}: no samples");
        return;
    };

    println!(
        "{name}: samples={} avg={:.2}ms p50={:.2}ms p95={:.2}ms min={:.2}ms max={:.2}ms",
        summary.samples, summary.avg, summary.p50, summary.p95, summary.min, summary.max
    );
}

fn summarize(values: &[f64]) -> Option<MetricSummary> {
    if values.is_empty() {
        return None;
    }

    let avg = values.iter().sum::<f64>() / values.len() as f64;
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let p50 = percentile(values, 50.0);
    let p95 = percentile(values, 95.0);

    Some(MetricSummary {
        samples: values.len(),
        avg,
        p50,
        p95,
        min,
        max,
    })
}

fn print_delta(name: &str, baseline: &[f64], candidate: &[f64]) {
    let Some(base_summary) = summarize(baseline) else {
        println!("{name}: no baseline samples");
        return;
    };
    let Some(candidate_summary) = summarize(candidate) else {
        println!("{name}: no candidate samples");
        return;
    };

    let avg_delta = candidate_summary.avg - base_summary.avg;
    let p95_delta = candidate_summary.p95 - base_summary.p95;
    let avg_pct = if base_summary.avg.abs() > f64::EPSILON {
        avg_delta / base_summary.avg * 100.0
    } else {
        0.0
    };
    let p95_pct = if base_summary.p95.abs() > f64::EPSILON {
        p95_delta / base_summary.p95 * 100.0
    } else {
        0.0
    };

    println!(
        "{name}: avg_delta={avg_delta:.2}ms ({avg_pct:+.1}%) p95_delta={p95_delta:.2}ms ({p95_pct:+.1}%) baseline_samples={} candidate_samples={}",
        base_summary.samples, candidate_summary.samples
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
        eprintln!(
            "Usage: playback-startup-report [--log <path> ...] [--baseline-log <path> ... --candidate-log <path> ...]"
        );
        std::process::exit(1);
    }

    let mut logs = Vec::<PathBuf>::new();
    let mut baseline_logs = Vec::<PathBuf>::new();
    let mut candidate_logs = Vec::<PathBuf>::new();
    let mut index = 0usize;

    while index < args.len() {
        match args[index].as_str() {
            "--log" => {
                if let Some(value) = args.get(index + 1) {
                    logs.push(PathBuf::from(value));
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --log");
                std::process::exit(1);
            }
            "--baseline-log" => {
                if let Some(value) = args.get(index + 1) {
                    baseline_logs.push(PathBuf::from(value));
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --baseline-log");
                std::process::exit(1);
            }
            "--candidate-log" => {
                if let Some(value) = args.get(index + 1) {
                    candidate_logs.push(PathBuf::from(value));
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --candidate-log");
                std::process::exit(1);
            }
            _ => {
                eprintln!("Unknown argument: {}", args[index]);
                std::process::exit(1);
            }
        }
    }

    if logs.is_empty() && baseline_logs.is_empty() && candidate_logs.is_empty() {
        eprintln!("No logs provided");
        std::process::exit(1);
    }

    if baseline_logs.is_empty() != candidate_logs.is_empty() {
        eprintln!("Both --baseline-log and --candidate-log must be provided together");
        std::process::exit(1);
    }

    if !logs.is_empty() {
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

    if !baseline_logs.is_empty() {
        let mut baseline_stats = EventStats::default();
        for log in &baseline_logs {
            if let Err(error) = parse_log(log, &mut baseline_stats) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        let mut candidate_stats = EventStats::default();
        for log in &candidate_logs {
            if let Err(error) = parse_log(log, &mut candidate_stats) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }

        println!("Startup delta (candidate - baseline)");
        print_delta(
            "first decoded frame",
            &baseline_stats.decode_startup_ms,
            &candidate_stats.decode_startup_ms,
        );
        print_delta(
            "first rendered frame",
            &baseline_stats.render_startup_ms,
            &candidate_stats.render_startup_ms,
        );
        print_delta(
            "audio streaming callback",
            &baseline_stats.audio_stream_startup_ms,
            &candidate_stats.audio_stream_startup_ms,
        );
        print_delta(
            "audio pre-rendered callback",
            &baseline_stats.audio_prerender_startup_ms,
            &candidate_stats.audio_prerender_startup_ms,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_csv_startup_event, parse_startup_ms, summarize};

    #[test]
    fn parses_csv_startup_event() {
        let parsed = parse_csv_startup_event("1739530000000,first_rendered_frame,123.456,42");
        assert!(parsed.is_some());
        let (event, startup_ms) = parsed.expect("expected CSV startup event");
        assert_eq!(event, "first_rendered_frame");
        assert!((startup_ms - 123.456).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_structured_startup_ms_field() {
        let parsed =
            parse_startup_ms("INFO Playback first frame rendered startup_ms=87.25 frame=1");
        assert!(parsed.is_some());
        let startup_ms = parsed.expect("expected startup_ms");
        assert!((startup_ms - 87.25).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_json_startup_ms_field() {
        let parsed = parse_startup_ms(
            "{\"level\":\"INFO\",\"fields\":{\"startup_ms\":42.5},\"message\":\"Audio streaming callback started\"}",
        );
        assert!(parsed.is_some());
        let startup_ms = parsed.expect("expected startup_ms");
        assert!((startup_ms - 42.5).abs() < f64::EPSILON);
    }

    #[test]
    fn summarizes_metrics() {
        let summary = summarize(&[10.0, 20.0, 30.0]).expect("expected summary");
        assert_eq!(summary.samples, 3);
        assert!((summary.avg - 20.0).abs() < f64::EPSILON);
        assert!((summary.p50 - 20.0).abs() < f64::EPSILON);
    }
}
