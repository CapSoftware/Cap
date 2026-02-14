use std::path::PathBuf;

#[derive(Clone)]
struct ScrubCsvRow {
    scope: String,
    run_label: String,
    video: String,
    all_avg_ms: f64,
    all_p95_ms: f64,
    last_avg_ms: f64,
    last_p95_ms: f64,
    successful_requests: usize,
    failed_requests: usize,
}

#[derive(Clone, Copy)]
struct Summary {
    samples: usize,
    all_avg_ms: f64,
    all_p95_ms: f64,
    last_avg_ms: f64,
    last_p95_ms: f64,
    successful_requests: usize,
    failed_requests: usize,
}

fn median(values: &[f64]) -> f64 {
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

fn summarize(rows: &[ScrubCsvRow]) -> Option<Summary> {
    if rows.is_empty() {
        return None;
    }

    let all_avg = rows.iter().map(|row| row.all_avg_ms).collect::<Vec<_>>();
    let all_p95 = rows.iter().map(|row| row.all_p95_ms).collect::<Vec<_>>();
    let last_avg = rows.iter().map(|row| row.last_avg_ms).collect::<Vec<_>>();
    let last_p95 = rows.iter().map(|row| row.last_p95_ms).collect::<Vec<_>>();

    Some(Summary {
        samples: rows.len(),
        all_avg_ms: median(&all_avg),
        all_p95_ms: median(&all_p95),
        last_avg_ms: median(&last_avg),
        last_p95_ms: median(&last_p95),
        successful_requests: rows.iter().map(|row| row.successful_requests).sum(),
        failed_requests: rows.iter().map(|row| row.failed_requests).sum(),
    })
}

fn parse_csv_line(line: &str) -> Option<ScrubCsvRow> {
    let fields = line.split(',').collect::<Vec<_>>();
    if fields.len() < 24 {
        return None;
    }
    if fields.first().copied() == Some("timestamp_ms") {
        return None;
    }

    let supersede_disabled = fields[10].trim_matches('"');
    let supersede_min_pixels = fields[11].trim_matches('"');
    let supersede_min_requests = fields[12].trim_matches('"');
    let supersede_min_span_frames = fields[13].trim_matches('"');
    let run_label = fields[3].trim_matches('"');
    let config_label = format!(
        "cfg(disabled={},min_pixels={},min_requests={},min_span={})",
        if supersede_disabled.is_empty() {
            "default"
        } else {
            supersede_disabled
        },
        if supersede_min_pixels.is_empty() {
            "default"
        } else {
            supersede_min_pixels
        },
        if supersede_min_requests.is_empty() {
            "default"
        } else {
            supersede_min_requests
        },
        if supersede_min_span_frames.is_empty() {
            "default"
        } else {
            supersede_min_span_frames
        }
    );

    Some(ScrubCsvRow {
        scope: fields[1].to_string(),
        run_label: if run_label.is_empty() {
            config_label
        } else {
            run_label.to_string()
        },
        video: fields[4].trim_matches('"').to_string(),
        all_avg_ms: fields[14].parse::<f64>().ok()?,
        all_p95_ms: fields[15].parse::<f64>().ok()?,
        last_avg_ms: fields[18].parse::<f64>().ok()?,
        last_p95_ms: fields[19].parse::<f64>().ok()?,
        successful_requests: fields[22].parse::<usize>().ok()?,
        failed_requests: fields[23].parse::<usize>().ok()?,
    })
}

fn parse_csv_file(path: &PathBuf) -> Result<Vec<ScrubCsvRow>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read {} / {error}", path.display()))?;
    Ok(contents
        .lines()
        .filter_map(parse_csv_line)
        .filter(|row| row.scope == "aggregate")
        .collect())
}

fn print_summary(label: &str, video: &str, summary: Summary) {
    println!(
        "{label} video={video}: samples={} all_avg={:.2}ms all_p95={:.2}ms last_avg={:.2}ms last_p95={:.2}ms successful={} failed={}",
        summary.samples,
        summary.all_avg_ms,
        summary.all_p95_ms,
        summary.last_avg_ms,
        summary.last_p95_ms,
        summary.successful_requests,
        summary.failed_requests
    );
}

fn print_delta(
    baseline_label: &str,
    baseline: Summary,
    candidate_label: &str,
    candidate: Summary,
    video: &str,
) {
    println!(
        "delta({candidate_label}-{baseline_label}) video={video}: all_avg={:+.2}ms all_p95={:+.2}ms last_avg={:+.2}ms last_p95={:+.2}ms",
        candidate.all_avg_ms - baseline.all_avg_ms,
        candidate.all_p95_ms - baseline.all_p95_ms,
        candidate.last_avg_ms - baseline.last_avg_ms,
        candidate.last_p95_ms - baseline.last_p95_ms
    );
}

fn group_by_label_and_video(
    rows: &[ScrubCsvRow],
) -> std::collections::BTreeMap<(String, String), Vec<ScrubCsvRow>> {
    rows.iter().fold(
        std::collections::BTreeMap::<(String, String), Vec<ScrubCsvRow>>::new(),
        |mut acc, row| {
            acc.entry((row.run_label.clone(), row.video.clone()))
                .or_default()
                .push(row.clone());
            acc
        },
    )
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
            "Usage: scrub-csv-report --csv <path> [--csv <path> ...] [--label <run-label>] [--baseline-label <run-label> --candidate-label <run-label>]"
        );
        std::process::exit(1);
    }

    let mut csv_paths = Vec::<PathBuf>::new();
    let mut label: Option<String> = None;
    let mut baseline_label: Option<String> = None;
    let mut candidate_label: Option<String> = None;

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

    let mut all_rows = Vec::<ScrubCsvRow>::new();
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
        eprintln!("No aggregate rows found");
        std::process::exit(1);
    }

    let grouped_rows = group_by_label_and_video(&all_rows);

    if let Some(label) = label {
        let rows = grouped_rows
            .iter()
            .filter(|((group_label, _), _)| group_label == &label)
            .map(|((_, video), rows)| (video.clone(), rows.clone()))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            eprintln!("No rows found for label: {label}");
            std::process::exit(1);
        }
        for (video, rows) in rows {
            if let Some(summary) = summarize(&rows) {
                print_summary(&label, &video, summary);
            }
        }
    } else {
        for ((group_label, video), rows) in grouped_rows.clone() {
            if let Some(summary) = summarize(&rows) {
                print_summary(&group_label, &video, summary);
            }
        }
    }

    if let (Some(baseline_label), Some(candidate_label)) = (baseline_label, candidate_label) {
        let baseline_groups = grouped_rows
            .iter()
            .filter(|((label_key, _), _)| label_key == &baseline_label)
            .map(|((_, video), rows)| (video.clone(), rows.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let candidate_groups = grouped_rows
            .iter()
            .filter(|((label_key, _), _)| label_key == &candidate_label)
            .map(|((_, video), rows)| (video.clone(), rows.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        if baseline_groups.is_empty() {
            eprintln!("No rows found for baseline label: {baseline_label}");
            std::process::exit(1);
        }
        if candidate_groups.is_empty() {
            eprintln!("No rows found for candidate label: {candidate_label}");
            std::process::exit(1);
        }

        let mut printed = false;
        for (video, baseline_rows) in baseline_groups {
            let Some(candidate_rows) = candidate_groups.get(&video) else {
                continue;
            };
            let Some(baseline_summary) = summarize(&baseline_rows) else {
                continue;
            };
            let Some(candidate_summary) = summarize(candidate_rows) else {
                continue;
            };
            print_delta(
                &baseline_label,
                baseline_summary,
                &candidate_label,
                candidate_summary,
                &video,
            );
            printed = true;
        }
        if !printed {
            eprintln!("No overlapping videos found between baseline and candidate labels");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{group_by_label_and_video, parse_csv_line, summarize};

    #[test]
    fn parses_aggregate_csv_line() {
        let line = "1771039415444,aggregate,0,\"linux-pass-a\",\"/tmp/cap-bench-1080p60.mp4\",60,6,12,2.000,2,\"\",\"\",\"\",\"\",199.009,410.343,410.344,410.346,213.930,410.343,410.343,410.343,144,0";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(row.scope, "aggregate");
        assert_eq!(row.run_label, "linux-pass-a");
        assert!((row.last_avg_ms - 213.93).abs() < f64::EPSILON);
        assert_eq!(row.successful_requests, 144);
    }

    #[test]
    fn falls_back_to_config_label_when_run_label_missing() {
        let line = "1771039415444,aggregate,0,\"\",\"/tmp/cap-bench-1080p60.mp4\",60,6,12,2.000,2,\"\",\"2000000\",\"7\",\"20\",199.009,410.343,410.344,410.346,213.930,410.343,410.343,410.343,144,0";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(
            row.run_label,
            "cfg(disabled=default,min_pixels=2000000,min_requests=7,min_span=20)"
        );
    }

    #[test]
    fn summarizes_medians() {
        let rows = vec![
            super::ScrubCsvRow {
                scope: "aggregate".to_string(),
                run_label: "x".to_string(),
                video: "v".to_string(),
                all_avg_ms: 10.0,
                all_p95_ms: 20.0,
                last_avg_ms: 30.0,
                last_p95_ms: 40.0,
                successful_requests: 10,
                failed_requests: 0,
            },
            super::ScrubCsvRow {
                scope: "aggregate".to_string(),
                run_label: "x".to_string(),
                video: "v".to_string(),
                all_avg_ms: 12.0,
                all_p95_ms: 24.0,
                last_avg_ms: 28.0,
                last_p95_ms: 42.0,
                successful_requests: 12,
                failed_requests: 1,
            },
            super::ScrubCsvRow {
                scope: "aggregate".to_string(),
                run_label: "x".to_string(),
                video: "v".to_string(),
                all_avg_ms: 8.0,
                all_p95_ms: 16.0,
                last_avg_ms: 26.0,
                last_p95_ms: 38.0,
                successful_requests: 8,
                failed_requests: 0,
            },
        ];
        let summary = summarize(&rows).expect("expected summary");
        assert_eq!(summary.samples, 3);
        assert!((summary.all_avg_ms - 10.0).abs() < f64::EPSILON);
        assert!((summary.last_avg_ms - 28.0).abs() < f64::EPSILON);
        assert_eq!(summary.successful_requests, 30);
        assert_eq!(summary.failed_requests, 1);
    }

    #[test]
    fn groups_rows_by_label_and_video() {
        let rows = vec![
            super::ScrubCsvRow {
                scope: "aggregate".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                all_avg_ms: 10.0,
                all_p95_ms: 20.0,
                last_avg_ms: 30.0,
                last_p95_ms: 40.0,
                successful_requests: 10,
                failed_requests: 0,
            },
            super::ScrubCsvRow {
                scope: "aggregate".to_string(),
                run_label: "label-a".to_string(),
                video: "video-2".to_string(),
                all_avg_ms: 12.0,
                all_p95_ms: 24.0,
                last_avg_ms: 28.0,
                last_p95_ms: 42.0,
                successful_requests: 12,
                failed_requests: 0,
            },
        ];
        let groups = group_by_label_and_video(&rows);
        assert_eq!(groups.len(), 2);
        assert!(groups.contains_key(&("label-a".to_string(), "video-1".to_string())));
        assert!(groups.contains_key(&("label-a".to_string(), "video-2".to_string())));
    }
}
