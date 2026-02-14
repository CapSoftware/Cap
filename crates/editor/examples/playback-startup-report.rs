use std::{
    collections::BTreeMap,
    fs::File,
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
};

#[derive(Default)]
struct EventStats {
    decode_startup_ms: Vec<f64>,
    render_startup_ms: Vec<f64>,
    audio_stream_startup_ms: Vec<f64>,
    audio_prerender_startup_ms: Vec<f64>,
}

impl EventStats {
    fn total_samples(&self) -> usize {
        self.decode_startup_ms.len()
            + self.render_startup_ms.len()
            + self.audio_stream_startup_ms.len()
            + self.audio_prerender_startup_ms.len()
    }
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

#[derive(Clone, Copy)]
struct DeltaSummary {
    baseline: MetricSummary,
    candidate: MetricSummary,
    avg_delta: f64,
    p95_delta: f64,
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
    if summarize(baseline).is_none() {
        println!("{name}: no baseline samples");
        return;
    }
    if summarize(candidate).is_none() {
        println!("{name}: no candidate samples");
        return;
    }
    let delta = summarize_delta(baseline, candidate).expect("validated summaries");
    let avg_pct = if delta.baseline.avg.abs() > f64::EPSILON {
        delta.avg_delta / delta.baseline.avg * 100.0
    } else {
        0.0
    };
    let p95_pct = if delta.baseline.p95.abs() > f64::EPSILON {
        delta.p95_delta / delta.baseline.p95 * 100.0
    } else {
        0.0
    };

    println!(
        "{name}: avg_delta={avg_delta:.2}ms ({avg_pct:+.1}%) p95_delta={p95_delta:.2}ms ({p95_pct:+.1}%) baseline_samples={} candidate_samples={}",
        delta.baseline.samples,
        delta.candidate.samples,
        avg_delta = delta.avg_delta,
        p95_delta = delta.p95_delta
    );
}

fn summarize_delta(baseline: &[f64], candidate: &[f64]) -> Option<DeltaSummary> {
    let baseline_summary = summarize(baseline)?;
    let candidate_summary = summarize(candidate)?;
    Some(DeltaSummary {
        avg_delta: candidate_summary.avg - baseline_summary.avg,
        p95_delta: candidate_summary.p95 - baseline_summary.p95,
        baseline: baseline_summary,
        candidate: candidate_summary,
    })
}

fn parse_log(
    path: &PathBuf,
    stats: &mut EventStats,
    run_id_filter: Option<&str>,
) -> Result<usize, String> {
    let file = File::open(path).map_err(|error| format!("open {} / {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut matched = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|error| format!("read {} / {error}", path.display()))?;

        if let Some((event, startup_ms, run_id)) = parse_csv_startup_event(&line) {
            if let Some(filter) = run_id_filter {
                if run_id != Some(filter) {
                    continue;
                }
            }
            match event {
                "first_decoded_frame" => {
                    stats.decode_startup_ms.push(startup_ms);
                    matched += 1;
                }
                "first_rendered_frame" => {
                    stats.render_startup_ms.push(startup_ms);
                    matched += 1;
                }
                "audio_streaming_callback" => {
                    stats.audio_stream_startup_ms.push(startup_ms);
                    matched += 1;
                }
                "audio_prerender_callback" => {
                    stats.audio_prerender_startup_ms.push(startup_ms);
                    matched += 1;
                }
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
            matched += 1;
        } else if line.contains("Playback first frame rendered") {
            stats.render_startup_ms.push(startup_ms);
            matched += 1;
        } else if line.contains("Audio streaming callback started") {
            stats.audio_stream_startup_ms.push(startup_ms);
            matched += 1;
        } else if line.contains("Audio pre-rendered callback started") {
            stats.audio_prerender_startup_ms.push(startup_ms);
            matched += 1;
        }
    }

    Ok(matched)
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

fn collect_run_id_counts(path: &PathBuf) -> Result<BTreeMap<String, usize>, String> {
    let file = File::open(path).map_err(|error| format!("open {} / {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut counts = BTreeMap::<String, usize>::new();

    for line in reader.lines() {
        let line = line.map_err(|error| format!("read {} / {error}", path.display()))?;
        if let Some((_, _, run_id)) = parse_csv_startup_event(&line)
            && let Some(run_id) = run_id
        {
            let entry = counts.entry(run_id.to_string()).or_insert(0);
            *entry += 1;
        }
    }

    Ok(counts)
}

fn collect_run_id_metrics(path: &PathBuf) -> Result<BTreeMap<String, EventStats>, String> {
    let file = File::open(path).map_err(|error| format!("open {} / {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut metrics = BTreeMap::<String, EventStats>::new();

    for line in reader.lines() {
        let line = line.map_err(|error| format!("read {} / {error}", path.display()))?;
        if let Some((event, startup_ms, run_id)) = parse_csv_startup_event(&line)
            && let Some(run_id) = run_id
        {
            let stats = metrics.entry(run_id.to_string()).or_default();
            match event {
                "first_decoded_frame" => stats.decode_startup_ms.push(startup_ms),
                "first_rendered_frame" => stats.render_startup_ms.push(startup_ms),
                "audio_streaming_callback" => stats.audio_stream_startup_ms.push(startup_ms),
                "audio_prerender_callback" => stats.audio_prerender_startup_ms.push(startup_ms),
                _ => {}
            }
        }
    }

    Ok(metrics)
}

fn metric_brief(values: &[f64]) -> String {
    summarize(values)
        .map(|summary| {
            format!(
                "samples={} avg={:.2}ms p95={:.2}ms",
                summary.samples, summary.avg, summary.p95
            )
        })
        .unwrap_or_else(|| "samples=0".to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioStartupPath {
    None,
    Streaming,
    Prerendered,
    Mixed,
}

fn detect_audio_startup_path(stats: &EventStats) -> (AudioStartupPath, usize, usize) {
    let streaming_samples = stats.audio_stream_startup_ms.len();
    let prerendered_samples = stats.audio_prerender_startup_ms.len();

    let path = match (streaming_samples > 0, prerendered_samples > 0) {
        (true, true) => AudioStartupPath::Mixed,
        (true, false) => AudioStartupPath::Streaming,
        (false, true) => AudioStartupPath::Prerendered,
        (false, false) => AudioStartupPath::None,
    };

    (path, streaming_samples, prerendered_samples)
}

fn audio_startup_path_label(path: AudioStartupPath) -> &'static str {
    match path {
        AudioStartupPath::None => "none",
        AudioStartupPath::Streaming => "streaming",
        AudioStartupPath::Prerendered => "prerendered",
        AudioStartupPath::Mixed => "mixed",
    }
}

fn write_csv_header(path: &PathBuf, file: &mut File) -> Result<(), String> {
    if path.exists() && path.metadata().map(|meta| meta.len()).unwrap_or(0) > 0 {
        return Ok(());
    }
    let header = [
        "timestamp_ms",
        "mode",
        "metric",
        "run_id",
        "baseline_run_id",
        "candidate_run_id",
        "samples",
        "avg_ms",
        "p95_ms",
        "baseline_samples",
        "baseline_avg_ms",
        "baseline_p95_ms",
        "candidate_samples",
        "candidate_avg_ms",
        "candidate_p95_ms",
        "avg_delta_ms",
        "p95_delta_ms",
    ]
    .join(",");
    writeln!(file, "{header}").map_err(|error| format!("write {} / {error}", path.display()))
}

fn append_aggregate_csv(
    path: &PathBuf,
    run_id: Option<&str>,
    metrics: &[(&str, &[f64])],
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;
    write_csv_header(path, &mut file)?;
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    for (name, values) in metrics {
        if let Some(summary) = summarize(values) {
            writeln!(
                file,
                "{timestamp_ms},aggregate,\"{}\",\"{}\",\"\",\"\",{},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
                name,
                run_id.unwrap_or(""),
                summary.samples,
                summary.avg,
                summary.p95
            )
            .map_err(|error| format!("write {} / {error}", path.display()))?;
        }
    }

    Ok(())
}

fn append_delta_csv(
    path: &PathBuf,
    baseline_run_id: Option<&str>,
    candidate_run_id: Option<&str>,
    metrics: &[(&str, &[f64], &[f64])],
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;
    write_csv_header(path, &mut file)?;
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    for (name, baseline_values, candidate_values) in metrics {
        if let Some(delta) = summarize_delta(baseline_values, candidate_values) {
            writeln!(
                file,
                "{timestamp_ms},delta,\"{}\",\"\",\"{}\",\"{}\",\"\",\"\",\"\",{},{:.3},{:.3},{},{:.3},{:.3},{:.3},{:.3}",
                name,
                baseline_run_id.unwrap_or(""),
                candidate_run_id.unwrap_or(""),
                delta.baseline.samples,
                delta.baseline.avg,
                delta.baseline.p95,
                delta.candidate.samples,
                delta.candidate.avg,
                delta.candidate.p95,
                delta.avg_delta,
                delta.p95_delta
            )
            .map_err(|error| format!("write {} / {error}", path.display()))?;
        }
    }

    Ok(())
}

fn append_run_counts_csv(path: &PathBuf, counts: &BTreeMap<String, usize>) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;
    write_csv_header(path, &mut file)?;
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    for (run_id, count) in counts {
        writeln!(
            file,
            "{timestamp_ms},run_count,\"run_count\",\"{}\",\"\",\"\",{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
            run_id,
            count
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    Ok(())
}

fn append_run_metrics_csv(
    path: &PathBuf,
    metrics_by_run_id: &BTreeMap<String, EventStats>,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {} / {error}", path.display()))?;
    write_csv_header(path, &mut file)?;
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    for (run_id, stats) in metrics_by_run_id {
        let metric_rows = [
            ("first decoded frame", stats.decode_startup_ms.as_slice()),
            ("first rendered frame", stats.render_startup_ms.as_slice()),
            (
                "audio streaming callback",
                stats.audio_stream_startup_ms.as_slice(),
            ),
            (
                "audio pre-rendered callback",
                stats.audio_prerender_startup_ms.as_slice(),
            ),
        ];

        for (name, values) in metric_rows {
            if let Some(summary) = summarize(values) {
                writeln!(
                    file,
                    "{timestamp_ms},run_metric,\"{}\",\"{}\",\"\",\"\",{},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
                    name,
                    run_id,
                    summary.samples,
                    summary.avg,
                    summary.p95
                )
                .map_err(|error| format!("write {} / {error}", path.display()))?;
            }
        }
    }

    Ok(())
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
            "Usage: playback-startup-report [--log <path> ...] [--run-id <id>] [--list-runs] [--list-run-metrics] [--output-csv <path>] [--baseline-log <path> ... --candidate-log <path> ...] [--baseline-run-id <id>] [--candidate-run-id <id>]"
        );
        std::process::exit(1);
    }

    let mut logs = Vec::<PathBuf>::new();
    let mut baseline_logs = Vec::<PathBuf>::new();
    let mut candidate_logs = Vec::<PathBuf>::new();
    let mut run_id: Option<String> = None;
    let mut baseline_run_id: Option<String> = None;
    let mut candidate_run_id: Option<String> = None;
    let mut list_runs = false;
    let mut list_run_metrics = false;
    let mut output_csv: Option<PathBuf> = None;
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
            "--list-runs" => {
                list_runs = true;
                index += 1;
                continue;
            }
            "--list-run-metrics" => {
                list_run_metrics = true;
                index += 1;
                continue;
            }
            "--output-csv" => {
                if let Some(value) = args.get(index + 1) {
                    output_csv = Some(PathBuf::from(value));
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --output-csv");
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

    if list_runs && (!baseline_logs.is_empty() || !candidate_logs.is_empty()) {
        eprintln!("--list-runs supports only --log inputs");
        std::process::exit(1);
    }

    if list_run_metrics && (!baseline_logs.is_empty() || !candidate_logs.is_empty()) {
        eprintln!("--list-run-metrics supports only --log inputs");
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
        if list_run_metrics {
            let mut aggregated = BTreeMap::<String, EventStats>::new();
            for log in &logs {
                match collect_run_id_metrics(log) {
                    Ok(metrics) => {
                        for (run_id_key, stats) in metrics {
                            let entry = aggregated.entry(run_id_key).or_default();
                            entry.decode_startup_ms.extend(stats.decode_startup_ms);
                            entry.render_startup_ms.extend(stats.render_startup_ms);
                            entry
                                .audio_stream_startup_ms
                                .extend(stats.audio_stream_startup_ms);
                            entry
                                .audio_prerender_startup_ms
                                .extend(stats.audio_prerender_startup_ms);
                        }
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
            }

            println!("Startup trace run-id metrics");
            if aggregated.is_empty() {
                println!("no run ids found");
            } else {
                for (run_id_key, stats) in &aggregated {
                    let (audio_path, stream_samples, prerendered_samples) =
                        detect_audio_startup_path(stats);
                    println!(
                        "{}: decoded[{}] rendered[{}] audio_stream[{}] audio_prerender[{}] audio_path={} stream_samples={} prerender_samples={}",
                        run_id_key,
                        metric_brief(&stats.decode_startup_ms),
                        metric_brief(&stats.render_startup_ms),
                        metric_brief(&stats.audio_stream_startup_ms),
                        metric_brief(&stats.audio_prerender_startup_ms),
                        audio_startup_path_label(audio_path),
                        stream_samples,
                        prerendered_samples,
                    );
                }
            }
            if let Some(path) = &output_csv
                && let Err(error) = append_run_metrics_csv(path, &aggregated)
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }

        if list_runs {
            let mut aggregated = BTreeMap::<String, usize>::new();
            for log in &logs {
                match collect_run_id_counts(log) {
                    Ok(counts) => {
                        for (run_id_key, count) in counts {
                            let entry = aggregated.entry(run_id_key).or_insert(0);
                            *entry += count;
                        }
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
            }

            println!("Startup trace run-id counts");
            if aggregated.is_empty() {
                println!("no run ids found");
            } else {
                for (run_id_key, count) in &aggregated {
                    println!("{run_id_key}: {count}");
                }
            }
            if let Some(path) = &output_csv
                && let Err(error) = append_run_counts_csv(path, &aggregated)
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }

        let mut stats = EventStats::default();
        let mut matched = 0usize;
        for log in &logs {
            match parse_log(log, &mut stats, run_id.as_deref()) {
                Ok(count) => {
                    matched += count;
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        if run_id.is_some() && matched == 0 {
            eprintln!("No startup samples matched the requested --run-id");
            std::process::exit(1);
        }

        println!("Playback startup metrics");
        print_metric("first decoded frame", &stats.decode_startup_ms);
        print_metric("first rendered frame", &stats.render_startup_ms);
        print_metric("audio streaming callback", &stats.audio_stream_startup_ms);
        print_metric(
            "audio pre-rendered callback",
            &stats.audio_prerender_startup_ms,
        );
        let (audio_path, stream_samples, prerendered_samples) = detect_audio_startup_path(&stats);
        println!(
            "audio startup path: {} (stream_samples={} prerender_samples={})",
            audio_startup_path_label(audio_path),
            stream_samples,
            prerendered_samples
        );

        if let Some(path) = &output_csv {
            let metrics = [
                ("first decoded frame", stats.decode_startup_ms.as_slice()),
                ("first rendered frame", stats.render_startup_ms.as_slice()),
                (
                    "audio streaming callback",
                    stats.audio_stream_startup_ms.as_slice(),
                ),
                (
                    "audio pre-rendered callback",
                    stats.audio_prerender_startup_ms.as_slice(),
                ),
            ];
            if let Err(error) = append_aggregate_csv(path, run_id.as_deref(), &metrics) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }

    if !baseline_logs.is_empty() {
        let mut baseline_stats = EventStats::default();
        let baseline_filter = baseline_run_id.as_deref().or(run_id.as_deref());
        let mut baseline_matched = 0usize;
        for log in &baseline_logs {
            match parse_log(log, &mut baseline_stats, baseline_filter) {
                Ok(count) => {
                    baseline_matched += count;
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        if baseline_filter.is_some() && baseline_matched == 0 {
            eprintln!("No baseline startup samples matched the requested run id filter");
            std::process::exit(1);
        }
        let mut candidate_stats = EventStats::default();
        let candidate_filter = candidate_run_id.as_deref().or(run_id.as_deref());
        let mut candidate_matched = 0usize;
        for log in &candidate_logs {
            match parse_log(log, &mut candidate_stats, candidate_filter) {
                Ok(count) => {
                    candidate_matched += count;
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        if candidate_filter.is_some() && candidate_matched == 0 {
            eprintln!("No candidate startup samples matched the requested run id filter");
            std::process::exit(1);
        }
        if baseline_stats.total_samples() == 0 || candidate_stats.total_samples() == 0 {
            eprintln!("No startup samples available for baseline/candidate comparison");
            std::process::exit(1);
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
        let (baseline_audio_path, baseline_stream_samples, baseline_prerendered_samples) =
            detect_audio_startup_path(&baseline_stats);
        let (candidate_audio_path, candidate_stream_samples, candidate_prerendered_samples) =
            detect_audio_startup_path(&candidate_stats);
        println!(
            "audio startup path baseline={} (stream_samples={} prerender_samples={}) candidate={} (stream_samples={} prerender_samples={})",
            audio_startup_path_label(baseline_audio_path),
            baseline_stream_samples,
            baseline_prerendered_samples,
            audio_startup_path_label(candidate_audio_path),
            candidate_stream_samples,
            candidate_prerendered_samples
        );

        if let Some(path) = &output_csv {
            let metrics = [
                (
                    "first decoded frame",
                    baseline_stats.decode_startup_ms.as_slice(),
                    candidate_stats.decode_startup_ms.as_slice(),
                ),
                (
                    "first rendered frame",
                    baseline_stats.render_startup_ms.as_slice(),
                    candidate_stats.render_startup_ms.as_slice(),
                ),
                (
                    "audio streaming callback",
                    baseline_stats.audio_stream_startup_ms.as_slice(),
                    candidate_stats.audio_stream_startup_ms.as_slice(),
                ),
                (
                    "audio pre-rendered callback",
                    baseline_stats.audio_prerender_startup_ms.as_slice(),
                    candidate_stats.audio_prerender_startup_ms.as_slice(),
                ),
            ];
            if let Err(error) = append_delta_csv(path, baseline_filter, candidate_filter, &metrics)
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AudioStartupPath, EventStats, append_aggregate_csv, append_delta_csv,
        append_run_counts_csv, append_run_metrics_csv, collect_run_id_metrics,
        detect_audio_startup_path, parse_csv_startup_event, parse_log, parse_startup_ms, summarize,
        summarize_delta,
    };
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
    fn summarizes_deltas() {
        let delta = summarize_delta(&[100.0, 120.0], &[80.0, 90.0]).expect("expected delta");
        assert!((delta.avg_delta + 25.0).abs() < f64::EPSILON);
        assert!((delta.p95_delta + 30.0).abs() < f64::EPSILON);
    }

    #[test]
    fn detects_audio_startup_path_modes() {
        let mut none = EventStats::default();
        let (none_path, none_streaming, none_prerendered) = detect_audio_startup_path(&none);
        assert_eq!(none_path, AudioStartupPath::None);
        assert_eq!(none_streaming, 0);
        assert_eq!(none_prerendered, 0);

        none.audio_stream_startup_ms.push(100.0);
        let (streaming_path, streaming_count, streaming_prerendered) =
            detect_audio_startup_path(&none);
        assert_eq!(streaming_path, AudioStartupPath::Streaming);
        assert_eq!(streaming_count, 1);
        assert_eq!(streaming_prerendered, 0);

        let mut prerendered = EventStats::default();
        prerendered.audio_prerender_startup_ms.push(120.0);
        let (prerendered_path, prerendered_streaming, prerendered_count) =
            detect_audio_startup_path(&prerendered);
        assert_eq!(prerendered_path, AudioStartupPath::Prerendered);
        assert_eq!(prerendered_streaming, 0);
        assert_eq!(prerendered_count, 1);

        let mut mixed = EventStats::default();
        mixed.audio_stream_startup_ms.extend([100.0, 102.0]);
        mixed.audio_prerender_startup_ms.push(130.0);
        let (mixed_path, mixed_streaming, mixed_prerendered) = detect_audio_startup_path(&mixed);
        assert_eq!(mixed_path, AudioStartupPath::Mixed);
        assert_eq!(mixed_streaming, 2);
        assert_eq!(mixed_prerendered, 1);
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

    #[test]
    fn writes_aggregate_and_delta_csv_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/playback-startup-report-csv-{unique}.csv"));

        append_aggregate_csv(
            &path,
            Some("macos-pass-1"),
            &[("first decoded frame", &[100.0, 120.0])],
        )
        .expect("write aggregate rows");

        append_delta_csv(
            &path,
            Some("baseline"),
            Some("candidate"),
            &[("first decoded frame", &[100.0, 120.0], &[80.0, 90.0])],
        )
        .expect("write delta rows");

        let contents = fs::read_to_string(&path).expect("read csv contents");
        let rows = contents.lines().collect::<Vec<_>>();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].contains("timestamp_ms,mode,metric"));
        assert!(rows[1].contains("aggregate"));
        assert!(rows[2].contains("delta"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn collects_run_id_metrics() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/playback-startup-metrics-{unique}.csv"));
        let contents = [
            "1739530000000,first_decoded_frame,100.0,1,run-a",
            "1739530000001,first_rendered_frame,120.0,1,run-a",
            "1739530000002,first_decoded_frame,80.0,1,run-b",
        ]
        .join("\n");
        fs::write(&path, contents).expect("write startup csv");

        let metrics = collect_run_id_metrics(&path).expect("collect run metrics");
        assert_eq!(metrics.len(), 2);
        assert_eq!(
            metrics
                .get("run-a")
                .map(|stats| stats.decode_startup_ms.clone()),
            Some(vec![100.0])
        );
        assert_eq!(
            metrics
                .get("run-b")
                .map(|stats| stats.decode_startup_ms.clone()),
            Some(vec![80.0])
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn writes_run_count_and_run_metric_csv_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/playback-startup-run-modes-{unique}.csv"));

        let mut counts = std::collections::BTreeMap::new();
        counts.insert("run-a".to_string(), 4usize);
        append_run_counts_csv(&path, &counts).expect("write run counts");

        let mut stats_map = std::collections::BTreeMap::new();
        let mut stats = EventStats::default();
        stats.decode_startup_ms = vec![100.0, 120.0];
        stats_map.insert("run-a".to_string(), stats);
        append_run_metrics_csv(&path, &stats_map).expect("write run metrics");

        let contents = fs::read_to_string(&path).expect("read csv");
        assert!(contents.contains(",run_count,"));
        assert!(contents.contains(",run_metric,"));

        let _ = fs::remove_file(path);
    }
}
