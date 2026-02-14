use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

#[derive(Clone)]
struct DecodeCsvRow {
    mode: String,
    run_label: String,
    video: String,
    distance_s: Option<f64>,
    burst_size: Option<usize>,
    samples: usize,
    failures: usize,
    avg_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
    sequential_fps: Option<f64>,
}

#[derive(Clone, Copy)]
struct CoreSummary {
    decoder_creation_ms: f64,
    sequential_fps: f64,
    sequential_decode_p95_ms: f64,
    random_access_avg_ms: f64,
    random_access_p95_ms: f64,
}

#[derive(Clone, Copy)]
struct SeekSummary {
    distance_millis: i64,
    rows: usize,
    samples: usize,
    failures: usize,
    avg_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

#[derive(Clone)]
struct DuplicateSummary {
    mode: String,
    burst_size: usize,
    rows: usize,
    samples: usize,
    failures: usize,
    avg_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

#[derive(Clone)]
struct SummaryEntry {
    label: String,
    video: String,
    core: CoreSummary,
    seeks: Vec<SeekSummary>,
    duplicates: Vec<DuplicateSummary>,
}

fn median_f64(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[index - 1] + sorted[index]) / 2.0
    } else {
        sorted[index]
    }
}

fn parse_optional_f64(field: &str) -> Option<f64> {
    let value = field.trim_matches('"');
    if value.is_empty() {
        None
    } else {
        value.parse::<f64>().ok()
    }
}

fn parse_optional_usize(field: &str) -> Option<usize> {
    let value = field.trim_matches('"');
    if value.is_empty() {
        None
    } else {
        value.parse::<usize>().ok()
    }
}

fn parse_csv_line(line: &str) -> Option<DecodeCsvRow> {
    let fields = line.split(',').collect::<Vec<_>>();
    if fields.len() < 19 {
        return None;
    }
    if fields.first().copied() == Some("timestamp_ms") {
        return None;
    }

    let mode = fields[1].trim_matches('"').to_string();
    if mode != "decoder_creation"
        && mode != "sequential"
        && mode != "seek"
        && mode != "random_access"
        && mode != "duplicate_batch"
        && mode != "duplicate_request"
    {
        return None;
    }

    let run_label = fields[2].trim_matches('"');

    Some(DecodeCsvRow {
        mode,
        run_label: if run_label.is_empty() {
            "unlabeled".to_string()
        } else {
            run_label.to_string()
        },
        video: fields[3].trim_matches('"').to_string(),
        distance_s: parse_optional_f64(fields[7]),
        burst_size: parse_optional_usize(fields[8]),
        samples: fields[9].parse::<usize>().ok()?,
        failures: fields[10].parse::<usize>().ok()?,
        avg_ms: fields[11].parse::<f64>().ok()?,
        p95_ms: fields[12].parse::<f64>().ok()?,
        p99_ms: fields[13].parse::<f64>().ok()?,
        max_ms: fields[14].parse::<f64>().ok()?,
        sequential_fps: parse_optional_f64(fields[15]),
    })
}

fn parse_csv_file(path: &PathBuf) -> Result<Vec<DecodeCsvRow>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read {} / {error}", path.display()))?;
    Ok(contents.lines().filter_map(parse_csv_line).collect())
}

fn summarize(
    rows: &[DecodeCsvRow],
) -> Option<(CoreSummary, Vec<SeekSummary>, Vec<DuplicateSummary>)> {
    let sequential_rows = rows
        .iter()
        .filter(|row| row.mode == "sequential")
        .collect::<Vec<_>>();
    if sequential_rows.is_empty() {
        return None;
    }

    let decoder_rows = rows
        .iter()
        .filter(|row| row.mode == "decoder_creation")
        .collect::<Vec<_>>();
    let random_rows = rows
        .iter()
        .filter(|row| row.mode == "random_access")
        .collect::<Vec<_>>();

    let core = CoreSummary {
        decoder_creation_ms: median_f64(
            &decoder_rows
                .iter()
                .map(|row| row.avg_ms)
                .collect::<Vec<_>>(),
        ),
        sequential_fps: median_f64(
            &sequential_rows
                .iter()
                .filter_map(|row| row.sequential_fps)
                .collect::<Vec<_>>(),
        ),
        sequential_decode_p95_ms: median_f64(
            &sequential_rows
                .iter()
                .map(|row| row.p95_ms)
                .collect::<Vec<_>>(),
        ),
        random_access_avg_ms: median_f64(
            &random_rows.iter().map(|row| row.avg_ms).collect::<Vec<_>>(),
        ),
        random_access_p95_ms: median_f64(
            &random_rows.iter().map(|row| row.p95_ms).collect::<Vec<_>>(),
        ),
    };

    let mut seek_groups = BTreeMap::<i64, Vec<&DecodeCsvRow>>::new();
    for row in rows.iter().filter(|row| row.mode == "seek") {
        let Some(distance) = row.distance_s else {
            continue;
        };
        let distance_millis = (distance * 1000.0).round() as i64;
        seek_groups.entry(distance_millis).or_default().push(row);
    }
    let seeks = seek_groups
        .into_iter()
        .map(|(distance_millis, rows)| SeekSummary {
            distance_millis,
            rows: rows.len(),
            samples: rows.iter().map(|row| row.samples).sum(),
            failures: rows.iter().map(|row| row.failures).sum(),
            avg_ms: median_f64(&rows.iter().map(|row| row.avg_ms).collect::<Vec<_>>()),
            p95_ms: median_f64(&rows.iter().map(|row| row.p95_ms).collect::<Vec<_>>()),
            p99_ms: median_f64(&rows.iter().map(|row| row.p99_ms).collect::<Vec<_>>()),
            max_ms: median_f64(&rows.iter().map(|row| row.max_ms).collect::<Vec<_>>()),
        })
        .collect::<Vec<_>>();

    let mut duplicate_groups = BTreeMap::<(String, usize), Vec<&DecodeCsvRow>>::new();
    for row in rows
        .iter()
        .filter(|row| row.mode == "duplicate_batch" || row.mode == "duplicate_request")
    {
        let Some(burst_size) = row.burst_size else {
            continue;
        };
        duplicate_groups
            .entry((row.mode.clone(), burst_size))
            .or_default()
            .push(row);
    }
    let duplicates = duplicate_groups
        .into_iter()
        .map(|((mode, burst_size), rows)| DuplicateSummary {
            mode,
            burst_size,
            rows: rows.len(),
            samples: rows.iter().map(|row| row.samples).sum(),
            failures: rows.iter().map(|row| row.failures).sum(),
            avg_ms: median_f64(&rows.iter().map(|row| row.avg_ms).collect::<Vec<_>>()),
            p95_ms: median_f64(&rows.iter().map(|row| row.p95_ms).collect::<Vec<_>>()),
            p99_ms: median_f64(&rows.iter().map(|row| row.p99_ms).collect::<Vec<_>>()),
            max_ms: median_f64(&rows.iter().map(|row| row.max_ms).collect::<Vec<_>>()),
        })
        .collect::<Vec<_>>();

    Some((core, seeks, duplicates))
}

fn group_by_label_and_video(
    rows: &[DecodeCsvRow],
) -> BTreeMap<(String, String), Vec<DecodeCsvRow>> {
    rows.iter().fold(
        BTreeMap::<(String, String), Vec<DecodeCsvRow>>::new(),
        |mut acc, row| {
            acc.entry((row.run_label.clone(), row.video.clone()))
                .or_default()
                .push(row.clone());
            acc
        },
    )
}

fn format_distance(distance_millis: i64) -> String {
    format!("{:.3}", distance_millis as f64 / 1000.0)
}

fn print_summary(entry: &SummaryEntry) {
    println!(
        "{} video={}: decoder_creation={:.2}ms sequential_fps={:.2} sequential_decode_p95={:.2}ms random_access_avg={:.2}ms random_access_p95={:.2}ms",
        entry.label,
        entry.video,
        entry.core.decoder_creation_ms,
        entry.core.sequential_fps,
        entry.core.sequential_decode_p95_ms,
        entry.core.random_access_avg_ms,
        entry.core.random_access_p95_ms
    );
    for seek in &entry.seeks {
        println!(
            "{} video={} seek_distance={}s: rows={} samples={} failures={} avg={:.2}ms p95={:.2}ms p99={:.2}ms max={:.2}ms",
            entry.label,
            entry.video,
            format_distance(seek.distance_millis),
            seek.rows,
            seek.samples,
            seek.failures,
            seek.avg_ms,
            seek.p95_ms,
            seek.p99_ms,
            seek.max_ms
        );
    }
    for duplicate in &entry.duplicates {
        println!(
            "{} video={} {} burst={}: rows={} samples={} failures={} avg={:.2}ms p95={:.2}ms p99={:.2}ms max={:.2}ms",
            entry.label,
            entry.video,
            duplicate.mode,
            duplicate.burst_size,
            duplicate.rows,
            duplicate.samples,
            duplicate.failures,
            duplicate.avg_ms,
            duplicate.p95_ms,
            duplicate.p99_ms,
            duplicate.max_ms
        );
    }
}

fn print_delta(
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    baseline: CoreSummary,
    candidate: CoreSummary,
) {
    println!(
        "delta({candidate_label}-{baseline_label}) video={video}: decoder_creation={:+.2}ms sequential_fps={:+.2} sequential_decode_p95={:+.2}ms random_access_avg={:+.2}ms random_access_p95={:+.2}ms",
        candidate.decoder_creation_ms - baseline.decoder_creation_ms,
        candidate.sequential_fps - baseline.sequential_fps,
        candidate.sequential_decode_p95_ms - baseline.sequential_decode_p95_ms,
        candidate.random_access_avg_ms - baseline.random_access_avg_ms,
        candidate.random_access_p95_ms - baseline.random_access_p95_ms
    );
}

fn print_seek_delta(
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    distance_millis: i64,
    baseline: SeekSummary,
    candidate: SeekSummary,
) {
    println!(
        "delta({candidate_label}-{baseline_label}) video={video} seek_distance={}s: avg={:+.2}ms p95={:+.2}ms p99={:+.2}ms max={:+.2}ms",
        format_distance(distance_millis),
        candidate.avg_ms - baseline.avg_ms,
        candidate.p95_ms - baseline.p95_ms,
        candidate.p99_ms - baseline.p99_ms,
        candidate.max_ms - baseline.max_ms
    );
}

fn print_duplicate_delta(
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    mode: &str,
    burst_size: usize,
    baseline: &DuplicateSummary,
    candidate: &DuplicateSummary,
) {
    println!(
        "delta({candidate_label}-{baseline_label}) video={video} {mode} burst={burst_size}: avg={:+.2}ms p95={:+.2}ms p99={:+.2}ms max={:+.2}ms",
        candidate.avg_ms - baseline.avg_ms,
        candidate.p95_ms - baseline.p95_ms,
        candidate.p99_ms - baseline.p99_ms,
        candidate.max_ms - baseline.max_ms
    );
}

fn write_csv_header(path: &PathBuf, file: &mut std::fs::File) -> Result<(), String> {
    if path.exists() && path.metadata().map(|meta| meta.len()).unwrap_or(0) > 0 {
        return Ok(());
    }
    let header = [
        "timestamp_ms",
        "mode",
        "label",
        "video",
        "distance_s",
        "duplicate_mode",
        "burst_size",
        "rows",
        "samples",
        "failures",
        "decoder_creation_ms",
        "sequential_fps",
        "sequential_decode_p95_ms",
        "random_access_avg_ms",
        "random_access_p95_ms",
        "avg_ms",
        "p95_ms",
        "p99_ms",
        "max_ms",
        "baseline_label",
        "candidate_label",
        "delta_decoder_creation_ms",
        "delta_sequential_fps",
        "delta_sequential_decode_p95_ms",
        "delta_random_access_avg_ms",
        "delta_random_access_p95_ms",
        "delta_avg_ms",
        "delta_p95_ms",
        "delta_p99_ms",
        "delta_max_ms",
    ]
    .join(",");
    writeln!(file, "{header}").map_err(|error| format!("write {} / {error}", path.display()))
}

fn append_summary_csv(path: &PathBuf, summaries: &[SummaryEntry]) -> Result<(), String> {
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

    for entry in summaries {
        writeln!(
            file,
            "{timestamp_ms},summary_core,\"{}\",\"{}\",\"\",\"\",\"\",\"\",\"\",\"\",{:.3},{:.3},{:.3},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
            entry.label,
            entry.video,
            entry.core.decoder_creation_ms,
            entry.core.sequential_fps,
            entry.core.sequential_decode_p95_ms,
            entry.core.random_access_avg_ms,
            entry.core.random_access_p95_ms
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;

        for seek in &entry.seeks {
            writeln!(
                file,
                "{timestamp_ms},summary_seek,\"{}\",\"{}\",{},\"\",\"\",{},{},{},\"\",\"\",\"\",\"\",\"\",{:.3},{:.3},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
                entry.label,
                entry.video,
                format_distance(seek.distance_millis),
                seek.rows,
                seek.samples,
                seek.failures,
                seek.avg_ms,
                seek.p95_ms,
                seek.p99_ms,
                seek.max_ms
            )
            .map_err(|error| format!("write {} / {error}", path.display()))?;
        }

        for duplicate in &entry.duplicates {
            writeln!(
                file,
                "{timestamp_ms},summary_duplicate,\"{}\",\"{}\",\"\",\"{}\",{},{},{},{},\"\",\"\",\"\",\"\",\"\",{:.3},{:.3},{:.3},{:.3},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
                entry.label,
                entry.video,
                duplicate.mode,
                duplicate.burst_size,
                duplicate.rows,
                duplicate.samples,
                duplicate.failures,
                duplicate.avg_ms,
                duplicate.p95_ms,
                duplicate.p99_ms,
                duplicate.max_ms
            )
            .map_err(|error| format!("write {} / {error}", path.display()))?;
        }
    }

    Ok(())
}

fn append_delta_csv(
    path: &PathBuf,
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    baseline: &SummaryEntry,
    candidate: &SummaryEntry,
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

    writeln!(
        file,
        "{timestamp_ms},delta_core,\"\",\"{}\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",{:.3},{:.3},{:.3},{:.3},{:.3},\"\",\"\",\"\",\"\"",
        video,
        baseline_label,
        candidate_label,
        candidate.core.decoder_creation_ms - baseline.core.decoder_creation_ms,
        candidate.core.sequential_fps - baseline.core.sequential_fps,
        candidate.core.sequential_decode_p95_ms - baseline.core.sequential_decode_p95_ms,
        candidate.core.random_access_avg_ms - baseline.core.random_access_avg_ms,
        candidate.core.random_access_p95_ms - baseline.core.random_access_p95_ms
    )
    .map_err(|error| format!("write {} / {error}", path.display()))?;

    let baseline_seeks = baseline
        .seeks
        .iter()
        .map(|seek| (seek.distance_millis, *seek))
        .collect::<BTreeMap<_, _>>();
    let candidate_seeks = candidate
        .seeks
        .iter()
        .map(|seek| (seek.distance_millis, *seek))
        .collect::<BTreeMap<_, _>>();

    for (distance_millis, baseline_seek) in baseline_seeks {
        let Some(candidate_seek) = candidate_seeks.get(&distance_millis) else {
            continue;
        };
        writeln!(
            file,
            "{timestamp_ms},delta_seek,\"\",\"{}\",{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",\"\",\"\",\"\",\"\",\"\",{:.3},{:.3},{:.3},{:.3}",
            video,
            format_distance(distance_millis),
            baseline_label,
            candidate_label,
            candidate_seek.avg_ms - baseline_seek.avg_ms,
            candidate_seek.p95_ms - baseline_seek.p95_ms,
            candidate_seek.p99_ms - baseline_seek.p99_ms,
            candidate_seek.max_ms - baseline_seek.max_ms
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    let baseline_duplicates = baseline
        .duplicates
        .iter()
        .map(|duplicate| ((duplicate.mode.clone(), duplicate.burst_size), duplicate))
        .collect::<BTreeMap<_, _>>();
    let candidate_duplicates = candidate
        .duplicates
        .iter()
        .map(|duplicate| ((duplicate.mode.clone(), duplicate.burst_size), duplicate))
        .collect::<BTreeMap<_, _>>();

    for ((mode, burst_size), baseline_duplicate) in baseline_duplicates {
        let Some(candidate_duplicate) = candidate_duplicates.get(&(mode.clone(), burst_size))
        else {
            continue;
        };
        writeln!(
            file,
            "{timestamp_ms},delta_duplicate,\"\",\"{}\",\"\",\"{}\",{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",\"\",\"\",\"\",\"\",\"\",{:.3},{:.3},{:.3},{:.3}",
            video,
            mode,
            burst_size,
            baseline_label,
            candidate_label,
            candidate_duplicate.avg_ms - baseline_duplicate.avg_ms,
            candidate_duplicate.p95_ms - baseline_duplicate.p95_ms,
            candidate_duplicate.p99_ms - baseline_duplicate.p99_ms,
            candidate_duplicate.max_ms - baseline_duplicate.max_ms
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    Ok(())
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
            "Usage: decode-csv-report --csv <path> [--csv <path> ...] [--label <run-label>] [--baseline-label <run-label> --candidate-label <run-label>] [--output-csv <path>]"
        );
        std::process::exit(1);
    }

    let mut csv_paths = Vec::<PathBuf>::new();
    let mut label: Option<String> = None;
    let mut baseline_label: Option<String> = None;
    let mut candidate_label: Option<String> = None;
    let mut output_csv: Option<PathBuf> = None;

    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--csv" => {
                if let Some(value) = args.get(index + 1) {
                    csv_paths.push(PathBuf::from(value));
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --csv");
                std::process::exit(1);
            }
            "--label" => {
                if let Some(value) = args.get(index + 1) {
                    label = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --label");
                std::process::exit(1);
            }
            "--baseline-label" => {
                if let Some(value) = args.get(index + 1) {
                    baseline_label = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --baseline-label");
                std::process::exit(1);
            }
            "--candidate-label" => {
                if let Some(value) = args.get(index + 1) {
                    candidate_label = Some(value.clone());
                    index += 2;
                    continue;
                }
                eprintln!("Missing value for --candidate-label");
                std::process::exit(1);
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
            unknown => {
                eprintln!("Unknown argument: {unknown}");
                std::process::exit(1);
            }
        }
    }

    if csv_paths.is_empty() {
        eprintln!("At least one --csv path is required");
        std::process::exit(1);
    }

    let mut all_rows = Vec::<DecodeCsvRow>::new();
    for path in &csv_paths {
        match parse_csv_file(path) {
            Ok(mut rows) => all_rows.append(&mut rows),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }

    if all_rows.is_empty() {
        eprintln!("No rows found");
        std::process::exit(1);
    }

    let grouped = group_by_label_and_video(&all_rows);
    let mut summaries = Vec::<SummaryEntry>::new();

    if let Some(label) = label {
        for ((group_label, video), rows) in grouped.iter() {
            if group_label != &label {
                continue;
            }
            let Some((core, seeks, duplicates)) = summarize(rows) else {
                continue;
            };
            summaries.push(SummaryEntry {
                label: group_label.clone(),
                video: video.clone(),
                core,
                seeks,
                duplicates,
            });
        }
        if summaries.is_empty() {
            eprintln!("No rows found for label: {label}");
            std::process::exit(1);
        }
    } else {
        for ((group_label, video), rows) in grouped.iter() {
            let Some((core, seeks, duplicates)) = summarize(rows) else {
                continue;
            };
            summaries.push(SummaryEntry {
                label: group_label.clone(),
                video: video.clone(),
                core,
                seeks,
                duplicates,
            });
        }
    }

    if summaries.is_empty() {
        eprintln!("No summaries produced");
        std::process::exit(1);
    }

    for summary in &summaries {
        print_summary(summary);
    }

    if let Some(path) = &output_csv
        && let Err(error) = append_summary_csv(path, &summaries)
    {
        eprintln!("{error}");
        std::process::exit(1);
    }

    if let (Some(baseline_label), Some(candidate_label)) = (baseline_label, candidate_label) {
        let baseline_by_video = summaries
            .iter()
            .filter(|entry| entry.label == baseline_label)
            .map(|entry| (entry.video.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();
        let candidate_by_video = summaries
            .iter()
            .filter(|entry| entry.label == candidate_label)
            .map(|entry| (entry.video.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();

        if baseline_by_video.is_empty() {
            eprintln!("No rows found for baseline label: {baseline_label}");
            std::process::exit(1);
        }
        if candidate_by_video.is_empty() {
            eprintln!("No rows found for candidate label: {candidate_label}");
            std::process::exit(1);
        }

        let mut compared = false;
        for (video, baseline) in baseline_by_video {
            let Some(candidate) = candidate_by_video.get(&video) else {
                continue;
            };
            print_delta(
                &baseline_label,
                &candidate_label,
                &video,
                baseline.core,
                candidate.core,
            );

            let baseline_seeks = baseline
                .seeks
                .iter()
                .map(|seek| (seek.distance_millis, *seek))
                .collect::<BTreeMap<_, _>>();
            for candidate_seek in &candidate.seeks {
                let Some(baseline_seek) = baseline_seeks.get(&candidate_seek.distance_millis)
                else {
                    continue;
                };
                print_seek_delta(
                    &baseline_label,
                    &candidate_label,
                    &video,
                    candidate_seek.distance_millis,
                    *baseline_seek,
                    *candidate_seek,
                );
            }

            let baseline_duplicates = baseline
                .duplicates
                .iter()
                .map(|duplicate| ((duplicate.mode.clone(), duplicate.burst_size), duplicate))
                .collect::<BTreeMap<_, _>>();
            for candidate_duplicate in &candidate.duplicates {
                let key = (
                    candidate_duplicate.mode.clone(),
                    candidate_duplicate.burst_size,
                );
                let Some(baseline_duplicate) = baseline_duplicates.get(&key) else {
                    continue;
                };
                print_duplicate_delta(
                    &baseline_label,
                    &candidate_label,
                    &video,
                    &candidate_duplicate.mode,
                    candidate_duplicate.burst_size,
                    baseline_duplicate,
                    candidate_duplicate,
                );
            }

            if let Some(path) = &output_csv
                && let Err(error) = append_delta_csv(
                    path,
                    &baseline_label,
                    &candidate_label,
                    &video,
                    &baseline,
                    candidate,
                )
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
            compared = true;
        }

        if !compared {
            eprintln!("No overlapping videos found between baseline and candidate labels");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SummaryEntry, append_delta_csv, append_summary_csv, parse_csv_line, summarize};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_sequential_row() {
        let line = "1771054846650,sequential,\"linux-pass\",\"/tmp/cap-bench-1080p60.mp4\",60,3,2,\"\",\"\",100,0,2.651,3.532,4.851,5.979,377.112,10.276,0,0";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(row.mode, "sequential");
        assert_eq!(row.run_label, "linux-pass");
        assert_eq!(row.samples, 100);
        assert_eq!(row.failures, 0);
        assert_eq!(row.sequential_fps, Some(377.112));
    }

    #[test]
    fn summarizes_modes() {
        let rows = vec![
            super::DecodeCsvRow {
                mode: "decoder_creation".to_string(),
                run_label: "a".to_string(),
                video: "v".to_string(),
                distance_s: None,
                burst_size: None,
                samples: 1,
                failures: 0,
                avg_ms: 10.0,
                p95_ms: 10.0,
                p99_ms: 10.0,
                max_ms: 10.0,
                sequential_fps: None,
            },
            super::DecodeCsvRow {
                mode: "sequential".to_string(),
                run_label: "a".to_string(),
                video: "v".to_string(),
                distance_s: None,
                burst_size: None,
                samples: 100,
                failures: 0,
                avg_ms: 2.5,
                p95_ms: 3.5,
                p99_ms: 5.0,
                max_ms: 6.0,
                sequential_fps: Some(380.0),
            },
            super::DecodeCsvRow {
                mode: "seek".to_string(),
                run_label: "a".to_string(),
                video: "v".to_string(),
                distance_s: Some(2.0),
                burst_size: None,
                samples: 3,
                failures: 0,
                avg_ms: 150.0,
                p95_ms: 200.0,
                p99_ms: 200.0,
                max_ms: 200.0,
                sequential_fps: Some(380.0),
            },
            super::DecodeCsvRow {
                mode: "random_access".to_string(),
                run_label: "a".to_string(),
                video: "v".to_string(),
                distance_s: None,
                burst_size: None,
                samples: 50,
                failures: 0,
                avg_ms: 120.0,
                p95_ms: 300.0,
                p99_ms: 350.0,
                max_ms: 360.0,
                sequential_fps: Some(380.0),
            },
            super::DecodeCsvRow {
                mode: "duplicate_batch".to_string(),
                run_label: "a".to_string(),
                video: "v".to_string(),
                distance_s: None,
                burst_size: Some(8),
                samples: 10,
                failures: 0,
                avg_ms: 5.0,
                p95_ms: 7.0,
                p99_ms: 7.5,
                max_ms: 8.0,
                sequential_fps: Some(380.0),
            },
        ];
        let (core, seeks, duplicates) = summarize(&rows).expect("summary");
        assert!((core.decoder_creation_ms - 10.0).abs() < f64::EPSILON);
        assert!((core.sequential_fps - 380.0).abs() < f64::EPSILON);
        assert_eq!(seeks.len(), 1);
        assert_eq!(seeks[0].distance_millis, 2000);
        assert_eq!(duplicates.len(), 1);
        assert_eq!(duplicates[0].burst_size, 8);
    }

    #[test]
    fn writes_summary_and_delta_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/decode-csv-report-{unique}.csv"));

        let summary = SummaryEntry {
            label: "label-a".to_string(),
            video: "video-1".to_string(),
            core: super::CoreSummary {
                decoder_creation_ms: 10.0,
                sequential_fps: 380.0,
                sequential_decode_p95_ms: 3.5,
                random_access_avg_ms: 120.0,
                random_access_p95_ms: 300.0,
            },
            seeks: vec![super::SeekSummary {
                distance_millis: 2000,
                rows: 1,
                samples: 3,
                failures: 0,
                avg_ms: 150.0,
                p95_ms: 200.0,
                p99_ms: 200.0,
                max_ms: 200.0,
            }],
            duplicates: vec![super::DuplicateSummary {
                mode: "duplicate_batch".to_string(),
                burst_size: 8,
                rows: 1,
                samples: 10,
                failures: 0,
                avg_ms: 5.0,
                p95_ms: 7.0,
                p99_ms: 7.5,
                max_ms: 8.0,
            }],
        };

        append_summary_csv(&path, std::slice::from_ref(&summary)).expect("summary csv");
        append_delta_csv(
            &path,
            "baseline",
            "candidate",
            "video-1",
            &summary,
            &summary,
        )
        .expect("delta csv");

        let contents = fs::read_to_string(&path).expect("read csv");
        let lines = contents.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 7);
        assert!(lines[0].contains("timestamp_ms,mode,label,video"));
        assert!(lines[1].contains("summary_core"));
        assert!(lines[2].contains("summary_seek"));
        assert!(lines[3].contains("summary_duplicate"));
        assert!(lines[4].contains("delta_core"));
        assert!(lines[5].contains("delta_seek"));
        assert!(lines[6].contains("delta_duplicate"));

        let _ = fs::remove_file(path);
    }
}
