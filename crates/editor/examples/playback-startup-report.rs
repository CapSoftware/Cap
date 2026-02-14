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

fn parse_log(
    path: &PathBuf,
    stats: &mut EventStats,
    run_id_filter: Option<&str>,
) -> Result<(), String> {
    let file = File::open(path).map_err(|error| format!("open {} / {error}", path.display()))?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.map_err(|error| format!("read {} / {error}", path.display()))?;

        if let Some((event, startup_ms, run_id)) = parse_csv_startup_event(&line) {
            if let Some(filter) = run_id_filter {
                if run_id != Some(filter) {
                    continue;
                }
            }
            match event {
                "first_decoded_frame" => stats.decode_startup_ms.push(startup_ms),
                "first_rendered_frame" => stats.render_startup_ms.push(startup_ms),
                "audio_streaming_callback" => stats.audio_stream_startup_ms.push(startup_ms),
                "audio_prerender_callback" => stats.audio_prerender_startup_ms.push(startup_ms),
                _ => {}
            }
            continue;
        }

        if run_id_filter.is_some() {
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

fn parse_csv_startup_event(line: &str) -> Option<(&str, f64, Option<&str>)> {
    let mut parts = line.splitn(5, ',');
    let _timestamp = parts.next()?;
    let event = parts.next()?;
    let startup_ms = parts.next()?.parse::<f64>().ok()?;
    let _frame = parts.next()?;
    let run_id = parts
        .next()
        .and_then(|value| if value.is_empty() { None } else { Some(value) });
    Some((event, startup_ms, run_id))
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
            "Usage: playback-startup-report [--log <path> ...] [--run-id <id>] [--baseline-log <path> ... --candidate-log <path> ...] [--baseline-run-id <id>] [--candidate-run-id <id>]"
        );
        std::process::exit(1);
    }

    let mut logs = Vec::<PathBuf>::new();
    let mut baseline_logs = Vec::<PathBuf>::new();
    let mut candidate_logs = Vec::<PathBuf>::new();
    let mut run_id: Option<String> = None;
    let mut baseline_run_id: Option<String> = None;
    let mut candidate_run_id: Option<String> = None;
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
            "--run-id" => {
                if let Some(value) = args.get(index + 1) {
                    run_id = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --run-id");
                std::process::exit(1);
            }
            "--baseline-run-id" => {
                if let Some(value) = args.get(index + 1) {
                    baseline_run_id = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --baseline-run-id");
                std::process::exit(1);
            }
            "--candidate-run-id" => {
                if let Some(value) = args.get(index + 1) {
                    candidate_run_id = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --candidate-run-id");
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

    if baseline_logs.is_empty() && baseline_run_id.is_some() {
        eprintln!("--baseline-run-id requires --baseline-log");
        std::process::exit(1);
    }

    if candidate_logs.is_empty() && candidate_run_id.is_some() {
        eprintln!("--candidate-run-id requires --candidate-log");
        std::process::exit(1);
    }

    if !logs.is_empty() {
        let mut stats = EventStats::default();
        for log in &logs {
            if let Err(error) = parse_log(log, &mut stats, run_id.as_deref()) {
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
        let baseline_filter = baseline_run_id.as_deref().or(run_id.as_deref());
        for log in &baseline_logs {
            if let Err(error) = parse_log(log, &mut baseline_stats, baseline_filter) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        let mut candidate_stats = EventStats::default();
        let candidate_filter = candidate_run_id.as_deref().or(run_id.as_deref());
        for log in &candidate_logs {
            if let Err(error) = parse_log(log, &mut candidate_stats, candidate_filter) {
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
    use super::{EventStats, parse_csv_startup_event, parse_log, parse_startup_ms, summarize};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_csv_startup_event() {
        let parsed = parse_csv_startup_event("1739530000000,first_rendered_frame,123.456,42");
        assert!(parsed.is_some());
        let (event, startup_ms, run_id) = parsed.expect("expected CSV startup event");
        assert_eq!(event, "first_rendered_frame");
        assert!((startup_ms - 123.456).abs() < f64::EPSILON);
        assert_eq!(run_id, None);
    }

    #[test]
    fn parses_csv_startup_event_with_run_id() {
        let parsed =
            parse_csv_startup_event("1739530000000,first_rendered_frame,123.456,42,macos-pass-1");
        assert!(parsed.is_some());
        let (event, startup_ms, run_id) = parsed.expect("expected CSV startup event");
        assert_eq!(event, "first_rendered_frame");
        assert!((startup_ms - 123.456).abs() < f64::EPSILON);
        assert_eq!(run_id, Some("macos-pass-1"));
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

    #[test]
    fn filters_csv_by_run_id() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/playback-startup-report-{unique}.csv"));
        let contents = [
            "1739530000000,first_decoded_frame,100.0,1,baseline",
            "1739530000001,first_decoded_frame,60.0,1,candidate",
            "1739530000002,audio_streaming_callback,130.0,1,baseline",
            "1739530000003,audio_streaming_callback,80.0,1,candidate",
        ]
        .join("\n");
        fs::write(&path, contents).expect("write startup csv");

        let mut baseline = EventStats::default();
        parse_log(&path, &mut baseline, Some("baseline")).expect("parse baseline");
        assert_eq!(baseline.decode_startup_ms, vec![100.0]);
        assert_eq!(baseline.audio_stream_startup_ms, vec![130.0]);

        let mut candidate = EventStats::default();
        parse_log(&path, &mut candidate, Some("candidate")).expect("parse candidate");
        assert_eq!(candidate.decode_startup_ms, vec![60.0]);
        assert_eq!(candidate.audio_stream_startup_ms, vec![80.0]);

        let _ = fs::remove_file(path);
    }
}
