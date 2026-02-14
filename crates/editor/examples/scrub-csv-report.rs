use std::fs::OpenOptions;
use std::io::Write;
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
    short_seek_p95_ms: f64,
    medium_seek_p95_ms: f64,
    long_seek_p95_ms: f64,
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
    short_seek_p95_ms: f64,
    medium_seek_p95_ms: f64,
    long_seek_p95_ms: f64,
    successful_requests: usize,
    failed_requests: usize,
}

#[derive(Clone)]
struct SummaryEntry {
    label: String,
    video: String,
    summary: Summary,
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
    let short_seek_p95 = rows
        .iter()
        .map(|row| row.short_seek_p95_ms)
        .collect::<Vec<_>>();
    let medium_seek_p95 = rows
        .iter()
        .map(|row| row.medium_seek_p95_ms)
        .collect::<Vec<_>>();
    let long_seek_p95 = rows
        .iter()
        .map(|row| row.long_seek_p95_ms)
        .collect::<Vec<_>>();

    Some(Summary {
        samples: rows.len(),
        all_avg_ms: median(&all_avg),
        all_p95_ms: median(&all_p95),
        last_avg_ms: median(&last_avg),
        last_p95_ms: median(&last_p95),
        short_seek_p95_ms: median(&short_seek_p95),
        medium_seek_p95_ms: median(&medium_seek_p95),
        long_seek_p95_ms: median(&long_seek_p95),
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
    let has_latest_first_threshold_columns = fields.get(44).is_some();
    let (
        all_avg_index,
        all_p95_index,
        last_avg_index,
        last_p95_index,
        successful_requests_index,
        failed_requests_index,
        short_seek_p95_index,
        medium_seek_p95_index,
        long_seek_p95_index,
    ) = if has_latest_first_threshold_columns {
        (16, 17, 20, 21, 24, 25, 27, 33, 39)
    } else {
        (14, 15, 18, 19, 22, 23, 25, 31, 37)
    };
    let latest_first_disabled = fields
        .get(44)
        .or_else(|| fields.get(42))
        .map(|value| value.trim_matches('"'))
        .unwrap_or_default();
    let latest_first_min_requests = if has_latest_first_threshold_columns {
        fields
            .get(14)
            .map(|value| value.trim_matches('"'))
            .unwrap_or_default()
    } else {
        ""
    };
    let latest_first_min_span_frames = if has_latest_first_threshold_columns {
        fields
            .get(15)
            .map(|value| value.trim_matches('"'))
            .unwrap_or_default()
    } else {
        ""
    };
    let run_label = fields[3].trim_matches('"');
    let config_label = format!(
        "cfg(disabled={},min_pixels={},min_requests={},min_span={},latest_first_min_requests={},latest_first_min_span={},latest_first={})",
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
        },
        if latest_first_min_requests.is_empty() {
            "default"
        } else {
            latest_first_min_requests
        },
        if latest_first_min_span_frames.is_empty() {
            "default"
        } else {
            latest_first_min_span_frames
        },
        if latest_first_disabled.is_empty() {
            "default"
        } else {
            latest_first_disabled
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
        all_avg_ms: fields.get(all_avg_index)?.parse::<f64>().ok()?,
        all_p95_ms: fields.get(all_p95_index)?.parse::<f64>().ok()?,
        last_avg_ms: fields.get(last_avg_index)?.parse::<f64>().ok()?,
        last_p95_ms: fields.get(last_p95_index)?.parse::<f64>().ok()?,
        short_seek_p95_ms: fields
            .get(short_seek_p95_index)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0),
        medium_seek_p95_ms: fields
            .get(medium_seek_p95_index)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0),
        long_seek_p95_ms: fields
            .get(long_seek_p95_index)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0),
        successful_requests: fields
            .get(successful_requests_index)?
            .parse::<usize>()
            .ok()?,
        failed_requests: fields.get(failed_requests_index)?.parse::<usize>().ok()?,
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

fn write_csv_header(path: &PathBuf, file: &mut std::fs::File) -> Result<(), String> {
    if path.exists() && path.metadata().map(|meta| meta.len()).unwrap_or(0) > 0 {
        return Ok(());
    }
    let header = [
        "timestamp_ms",
        "mode",
        "label",
        "video",
        "samples",
        "all_avg_ms",
        "all_p95_ms",
        "last_avg_ms",
        "last_p95_ms",
        "short_seek_p95_ms",
        "medium_seek_p95_ms",
        "long_seek_p95_ms",
        "successful_requests",
        "failed_requests",
        "baseline_label",
        "candidate_label",
        "delta_all_avg_ms",
        "delta_all_p95_ms",
        "delta_last_avg_ms",
        "delta_last_p95_ms",
        "delta_short_seek_p95_ms",
        "delta_medium_seek_p95_ms",
        "delta_long_seek_p95_ms",
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
            "{timestamp_ms},summary,\"{}\",\"{}\",{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
            entry.label,
            entry.video,
            entry.summary.samples,
            entry.summary.all_avg_ms,
            entry.summary.all_p95_ms,
            entry.summary.last_avg_ms,
            entry.summary.last_p95_ms,
            entry.summary.short_seek_p95_ms,
            entry.summary.medium_seek_p95_ms,
            entry.summary.long_seek_p95_ms,
            entry.summary.successful_requests,
            entry.summary.failed_requests
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    Ok(())
}

fn append_delta_csv(
    path: &PathBuf,
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    baseline: Summary,
    candidate: Summary,
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
        "{timestamp_ms},delta,\"\",\"{}\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3}",
        video,
        baseline_label,
        candidate_label,
        candidate.all_avg_ms - baseline.all_avg_ms,
        candidate.all_p95_ms - baseline.all_p95_ms,
        candidate.last_avg_ms - baseline.last_avg_ms,
        candidate.last_p95_ms - baseline.last_p95_ms,
        candidate.short_seek_p95_ms - baseline.short_seek_p95_ms,
        candidate.medium_seek_p95_ms - baseline.medium_seek_p95_ms,
        candidate.long_seek_p95_ms - baseline.long_seek_p95_ms
    )
    .map_err(|error| format!("write {} / {error}", path.display()))
}

fn print_summary(label: &str, video: &str, summary: Summary) {
    println!(
        "{label} video={video}: samples={} all_avg={:.2}ms all_p95={:.2}ms last_avg={:.2}ms last_p95={:.2}ms short_p95={:.2}ms medium_p95={:.2}ms long_p95={:.2}ms successful={} failed={}",
        summary.samples,
        summary.all_avg_ms,
        summary.all_p95_ms,
        summary.last_avg_ms,
        summary.last_p95_ms,
        summary.short_seek_p95_ms,
        summary.medium_seek_p95_ms,
        summary.long_seek_p95_ms,
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
        "delta({candidate_label}-{baseline_label}) video={video}: all_avg={:+.2}ms all_p95={:+.2}ms last_avg={:+.2}ms last_p95={:+.2}ms short_p95={:+.2}ms medium_p95={:+.2}ms long_p95={:+.2}ms",
        candidate.all_avg_ms - baseline.all_avg_ms,
        candidate.all_p95_ms - baseline.all_p95_ms,
        candidate.last_avg_ms - baseline.last_avg_ms,
        candidate.last_p95_ms - baseline.last_p95_ms,
        candidate.short_seek_p95_ms - baseline.short_seek_p95_ms,
        candidate.medium_seek_p95_ms - baseline.medium_seek_p95_ms,
        candidate.long_seek_p95_ms - baseline.long_seek_p95_ms
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
            "Usage: scrub-csv-report --csv <path> [--csv <path> ...] [--label <run-label>] [--baseline-label <run-label> --candidate-label <run-label>] [--output-csv <path>]"
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

    let mut summary_entries = Vec::<SummaryEntry>::new();
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
                summary_entries.push(SummaryEntry {
                    label: label.clone(),
                    video,
                    summary,
                });
            }
        }
    } else {
        for ((group_label, video), rows) in grouped_rows.clone() {
            if let Some(summary) = summarize(&rows) {
                print_summary(&group_label, &video, summary);
                summary_entries.push(SummaryEntry {
                    label: group_label,
                    video,
                    summary,
                });
            }
        }
    }

    if let Some(path) = &output_csv
        && let Err(error) = append_summary_csv(path, &summary_entries)
    {
        eprintln!("{error}");
        std::process::exit(1);
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
            if let Some(path) = &output_csv
                && let Err(error) = append_delta_csv(
                    path,
                    &baseline_label,
                    &candidate_label,
                    &video,
                    baseline_summary,
                    candidate_summary,
                )
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
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
    use super::{
        append_delta_csv, append_summary_csv, group_by_label_and_video, parse_csv_line, summarize,
        SummaryEntry,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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
            "cfg(disabled=default,min_pixels=2000000,min_requests=7,min_span=20,latest_first_min_requests=default,latest_first_min_span=default,latest_first=default)"
        );
    }

    #[test]
    fn parses_latest_first_flag_from_extended_rows() {
        let line = "1771039415444,aggregate,0,\"\",\"/tmp/cap-bench-1080p60.mp4\",60,6,12,2.000,2,\"\",\"2000000\",\"7\",\"20\",\"3\",\"30\",199.009,410.343,410.344,410.346,213.930,410.343,410.343,410.343,144,0,199.009,410.343,410.344,410.346,120,0,220.009,430.343,430.344,430.346,20,0,240.009,450.343,450.344,450.346,4,0,\"1\"";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(
            row.run_label,
            "cfg(disabled=default,min_pixels=2000000,min_requests=7,min_span=20,latest_first_min_requests=3,latest_first_min_span=30,latest_first=1)"
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
                short_seek_p95_ms: 15.0,
                medium_seek_p95_ms: 25.0,
                long_seek_p95_ms: 35.0,
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
                short_seek_p95_ms: 17.0,
                medium_seek_p95_ms: 27.0,
                long_seek_p95_ms: 37.0,
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
                short_seek_p95_ms: 13.0,
                medium_seek_p95_ms: 23.0,
                long_seek_p95_ms: 33.0,
                successful_requests: 8,
                failed_requests: 0,
            },
        ];
        let summary = summarize(&rows).expect("expected summary");
        assert_eq!(summary.samples, 3);
        assert!((summary.all_avg_ms - 10.0).abs() < f64::EPSILON);
        assert!((summary.last_avg_ms - 28.0).abs() < f64::EPSILON);
        assert!((summary.medium_seek_p95_ms - 25.0).abs() < f64::EPSILON);
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
                short_seek_p95_ms: 15.0,
                medium_seek_p95_ms: 25.0,
                long_seek_p95_ms: 35.0,
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
                short_seek_p95_ms: 17.0,
                medium_seek_p95_ms: 27.0,
                long_seek_p95_ms: 37.0,
                successful_requests: 12,
                failed_requests: 0,
            },
        ];
        let groups = group_by_label_and_video(&rows);
        assert_eq!(groups.len(), 2);
        assert!(groups.contains_key(&("label-a".to_string(), "video-1".to_string())));
        assert!(groups.contains_key(&("label-a".to_string(), "video-2".to_string())));
    }

    #[test]
    fn writes_summary_and_delta_csv_rows() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("timestamp")
            .as_nanos();
        let path = PathBuf::from(format!("/tmp/scrub-csv-report-{unique}.csv"));

        let summary = super::Summary {
            samples: 3,
            all_avg_ms: 10.0,
            all_p95_ms: 20.0,
            last_avg_ms: 30.0,
            last_p95_ms: 40.0,
            short_seek_p95_ms: 15.0,
            medium_seek_p95_ms: 25.0,
            long_seek_p95_ms: 35.0,
            successful_requests: 30,
            failed_requests: 1,
        };
        append_summary_csv(
            &path,
            &[SummaryEntry {
                label: "label-a".to_string(),
                video: "video-1".to_string(),
                summary,
            }],
        )
        .expect("write summary rows");

        append_delta_csv(&path, "base", "candidate", "video-1", summary, summary)
            .expect("write delta row");

        let contents = fs::read_to_string(&path).expect("read csv");
        let rows = contents.lines().collect::<Vec<_>>();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].contains("timestamp_ms,mode,label,video"));
        assert!(rows[1].contains("summary"));
        assert!(rows[2].contains("delta"));

        let _ = fs::remove_file(path);
    }
}
