use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

#[derive(Clone)]
struct PlaybackCsvRow {
    mode: String,
    run_label: String,
    video: String,
    effective_fps: f64,
    decode_p95_ms: f64,
    missed_deadlines: usize,
    seek_distance_s: Option<f64>,
    seek_avg_ms: Option<f64>,
    seek_p95_ms: Option<f64>,
    seek_max_ms: Option<f64>,
    seek_samples: usize,
    seek_failures: usize,
}

#[derive(Clone, Copy)]
struct SequentialSummary {
    samples: usize,
    effective_fps: f64,
    decode_p95_ms: f64,
    missed_deadlines: usize,
}

#[derive(Clone, Copy)]
struct SeekSummary {
    distance_millis: i64,
    samples: usize,
    seek_avg_ms: f64,
    seek_p95_ms: f64,
    seek_max_ms: f64,
    seek_samples: usize,
    seek_failures: usize,
}

#[derive(Clone)]
struct SummaryEntry {
    label: String,
    video: String,
    sequential: SequentialSummary,
    seeks: Vec<SeekSummary>,
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

fn median_usize(values: &[usize]) -> usize {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort();
    let index = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[index - 1] + sorted[index]) / 2
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

fn parse_csv_line(line: &str) -> Option<PlaybackCsvRow> {
    let fields = line.split(',').collect::<Vec<_>>();
    if fields.len() < 22 {
        return None;
    }
    if fields.first().copied() == Some("timestamp_ms") {
        return None;
    }

    let mode = fields[1].trim_matches('"').to_string();
    if mode != "sequential" && mode != "seek" {
        return None;
    }

    let run_label = fields[2].trim_matches('"');
    let seek_distance_s = parse_optional_f64(fields[16]);
    let seek_avg_ms = parse_optional_f64(fields[17]);
    let seek_p95_ms = parse_optional_f64(fields[18]);
    let seek_max_ms = parse_optional_f64(fields[19]);

    Some(PlaybackCsvRow {
        mode,
        run_label: if run_label.is_empty() {
            "unlabeled".to_string()
        } else {
            run_label.to_string()
        },
        video: fields[3].trim_matches('"').to_string(),
        effective_fps: fields[10].parse::<f64>().ok()?,
        decode_p95_ms: fields[13].parse::<f64>().ok()?,
        missed_deadlines: fields[9].parse::<usize>().ok()?,
        seek_distance_s,
        seek_avg_ms,
        seek_p95_ms,
        seek_max_ms,
        seek_samples: parse_optional_usize(fields[20]).unwrap_or(0),
        seek_failures: parse_optional_usize(fields[21]).unwrap_or(0),
    })
}

fn parse_csv_file(path: &PathBuf) -> Result<Vec<PlaybackCsvRow>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read {} / {error}", path.display()))?;
    Ok(contents.lines().filter_map(parse_csv_line).collect())
}

fn summarize(rows: &[PlaybackCsvRow]) -> Option<(SequentialSummary, Vec<SeekSummary>)> {
    let sequential_rows = rows
        .iter()
        .filter(|row| row.mode == "sequential")
        .collect::<Vec<_>>();
    if sequential_rows.is_empty() {
        return None;
    }

    let sequential = SequentialSummary {
        samples: sequential_rows.len(),
        effective_fps: median_f64(
            &sequential_rows
                .iter()
                .map(|row| row.effective_fps)
                .collect::<Vec<_>>(),
        ),
        decode_p95_ms: median_f64(
            &sequential_rows
                .iter()
                .map(|row| row.decode_p95_ms)
                .collect::<Vec<_>>(),
        ),
        missed_deadlines: median_usize(
            &sequential_rows
                .iter()
                .map(|row| row.missed_deadlines)
                .collect::<Vec<_>>(),
        ),
    };

    let mut seek_groups = BTreeMap::<i64, Vec<&PlaybackCsvRow>>::new();
    for row in rows.iter().filter(|row| row.mode == "seek") {
        let Some(distance) = row.seek_distance_s else {
            continue;
        };
        let distance_millis = (distance * 1000.0).round() as i64;
        seek_groups.entry(distance_millis).or_default().push(row);
    }

    let seeks = seek_groups
        .into_iter()
        .map(|(distance_millis, rows)| SeekSummary {
            distance_millis,
            samples: rows.len(),
            seek_avg_ms: median_f64(
                &rows
                    .iter()
                    .filter_map(|row| row.seek_avg_ms)
                    .collect::<Vec<_>>(),
            ),
            seek_p95_ms: median_f64(
                &rows
                    .iter()
                    .filter_map(|row| row.seek_p95_ms)
                    .collect::<Vec<_>>(),
            ),
            seek_max_ms: median_f64(
                &rows
                    .iter()
                    .filter_map(|row| row.seek_max_ms)
                    .collect::<Vec<_>>(),
            ),
            seek_samples: rows.iter().map(|row| row.seek_samples).sum(),
            seek_failures: rows.iter().map(|row| row.seek_failures).sum(),
        })
        .collect::<Vec<_>>();

    Some((sequential, seeks))
}

fn group_by_label_and_video(
    rows: &[PlaybackCsvRow],
) -> BTreeMap<(String, String), Vec<PlaybackCsvRow>> {
    rows.iter().fold(
        BTreeMap::<(String, String), Vec<PlaybackCsvRow>>::new(),
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

fn print_summary(label: &str, video: &str, sequential: SequentialSummary, seeks: &[SeekSummary]) {
    println!(
        "{label} video={video}: sequential_samples={} effective_fps={:.2} decode_p95={:.2}ms missed_deadlines={}",
        sequential.samples,
        sequential.effective_fps,
        sequential.decode_p95_ms,
        sequential.missed_deadlines
    );
    for seek in seeks {
        println!(
            "{label} video={video} seek_distance={}s: samples={} seek_avg={:.2}ms seek_p95={:.2}ms seek_max={:.2}ms seek_rows_samples={} seek_failures={}",
            format_distance(seek.distance_millis),
            seek.samples,
            seek.seek_avg_ms,
            seek.seek_p95_ms,
            seek.seek_max_ms,
            seek.seek_samples,
            seek.seek_failures
        );
    }
}

fn print_delta(
    baseline_label: &str,
    candidate_label: &str,
    video: &str,
    baseline: SequentialSummary,
    candidate: SequentialSummary,
) {
    println!(
        "delta({candidate_label}-{baseline_label}) video={video}: effective_fps={:+.2} decode_p95={:+.2}ms missed_deadlines={:+}",
        candidate.effective_fps - baseline.effective_fps,
        candidate.decode_p95_ms - baseline.decode_p95_ms,
        candidate.missed_deadlines as i64 - baseline.missed_deadlines as i64
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
        "delta({candidate_label}-{baseline_label}) video={video} seek_distance={}s: seek_avg={:+.2}ms seek_p95={:+.2}ms seek_max={:+.2}ms",
        format_distance(distance_millis),
        candidate.seek_avg_ms - baseline.seek_avg_ms,
        candidate.seek_p95_ms - baseline.seek_p95_ms,
        candidate.seek_max_ms - baseline.seek_max_ms
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
        "samples",
        "effective_fps",
        "decode_p95_ms",
        "missed_deadlines",
        "seek_avg_ms",
        "seek_p95_ms",
        "seek_max_ms",
        "seek_samples",
        "seek_failures",
        "baseline_label",
        "candidate_label",
        "delta_effective_fps",
        "delta_decode_p95_ms",
        "delta_missed_deadlines",
        "delta_seek_avg_ms",
        "delta_seek_p95_ms",
        "delta_seek_max_ms",
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
            "{timestamp_ms},summary_sequential,\"{}\",\"{}\",\"\",{},{:.3},{:.3},{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
            entry.label,
            entry.video,
            entry.sequential.samples,
            entry.sequential.effective_fps,
            entry.sequential.decode_p95_ms,
            entry.sequential.missed_deadlines
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;

        for seek in &entry.seeks {
            writeln!(
                file,
                "{timestamp_ms},summary_seek,\"{}\",\"{}\",{},{},\"\",\"\",\"\",{:.3},{:.3},{:.3},{},{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"",
                entry.label,
                entry.video,
                format_distance(seek.distance_millis),
                seek.samples,
                seek.seek_avg_ms,
                seek.seek_p95_ms,
                seek.seek_max_ms,
                seek.seek_samples,
                seek.seek_failures
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
    baseline: SequentialSummary,
    candidate: SequentialSummary,
    baseline_seeks: &[SeekSummary],
    candidate_seeks: &[SeekSummary],
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
        "{timestamp_ms},delta_sequential,\"\",\"{}\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",{:.3},{:.3},{},\"\",\"\",\"\"",
        video,
        baseline_label,
        candidate_label,
        candidate.effective_fps - baseline.effective_fps,
        candidate.decode_p95_ms - baseline.decode_p95_ms,
        candidate.missed_deadlines as i64 - baseline.missed_deadlines as i64
    )
    .map_err(|error| format!("write {} / {error}", path.display()))?;

    let baseline_by_distance = baseline_seeks
        .iter()
        .map(|seek| (seek.distance_millis, *seek))
        .collect::<BTreeMap<_, _>>();
    let candidate_by_distance = candidate_seeks
        .iter()
        .map(|seek| (seek.distance_millis, *seek))
        .collect::<BTreeMap<_, _>>();
    for (distance_millis, baseline_seek) in baseline_by_distance {
        let Some(candidate_seek) = candidate_by_distance.get(&distance_millis) else {
            continue;
        };
        writeln!(
            file,
            "{timestamp_ms},delta_seek,\"\",\"{}\",{},\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",\"\",\"\",\"\",{:.3},{:.3},{:.3}",
            video,
            format_distance(distance_millis),
            baseline_label,
            candidate_label,
            candidate_seek.seek_avg_ms - baseline_seek.seek_avg_ms,
            candidate_seek.seek_p95_ms - baseline_seek.seek_p95_ms,
            candidate_seek.seek_max_ms - baseline_seek.seek_max_ms
        )
        .map_err(|error| format!("write {} / {error}", path.display()))?;
    }

    Ok(())
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(
            "Usage: playback-csv-report --csv <path> [--csv <path> ...] [--label <run-label>] [--baseline-label <run-label> --candidate-label <run-label>] [--output-csv <path>]"
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

    let mut all_rows = Vec::<PlaybackCsvRow>::new();
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
            let Some((sequential, seeks)) = summarize(&rows) else {
                continue;
            };
            print_summary(&label, &video, sequential, &seeks);
            summary_entries.push(SummaryEntry {
                label: label.clone(),
                video,
                sequential,
                seeks,
            });
        }
    } else {
        for ((group_label, video), rows) in grouped_rows.clone() {
            let Some((sequential, seeks)) = summarize(&rows) else {
                continue;
            };
            print_summary(&group_label, &video, sequential, &seeks);
            summary_entries.push(SummaryEntry {
                label: group_label,
                video,
                sequential,
                seeks,
            });
        }
    }

    if summary_entries.is_empty() {
        eprintln!("No summaries produced");
        std::process::exit(1);
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
            .collect::<BTreeMap<_, _>>();
        let candidate_groups = grouped_rows
            .iter()
            .filter(|((label_key, _), _)| label_key == &candidate_label)
            .map(|((_, video), rows)| (video.clone(), rows.clone()))
            .collect::<BTreeMap<_, _>>();

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
            let Some((baseline_summary, baseline_seeks)) = summarize(&baseline_rows) else {
                continue;
            };
            let Some((candidate_summary, candidate_seeks)) = summarize(candidate_rows) else {
                continue;
            };
            print_delta(
                &baseline_label,
                &candidate_label,
                &video,
                baseline_summary,
                candidate_summary,
            );
            let baseline_seek_map = baseline_seeks
                .iter()
                .map(|seek| (seek.distance_millis, *seek))
                .collect::<BTreeMap<_, _>>();
            for candidate_seek in &candidate_seeks {
                let Some(baseline_seek) = baseline_seek_map.get(&candidate_seek.distance_millis)
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
            if let Some(path) = &output_csv
                && let Err(error) = append_delta_csv(
                    path,
                    &baseline_label,
                    &candidate_label,
                    &video,
                    baseline_summary,
                    candidate_summary,
                    &baseline_seeks,
                    &candidate_seeks,
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
        SummaryEntry, append_delta_csv, append_summary_csv, group_by_label_and_video,
        parse_csv_line, summarize,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_sequential_csv_line() {
        let line = "1771042665305,sequential,\"linux-pass-a\",\"/tmp/cap-bench-1080p60.mp4\",60,240,10,240,0,1,59.982,4.001,1.355,2.566,4.269,5.252,\"\",\"\",\"\",\"\",\"\",\"\"";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(row.mode, "sequential");
        assert_eq!(row.run_label, "linux-pass-a");
        assert!((row.effective_fps - 59.982).abs() < f64::EPSILON);
        assert_eq!(row.seek_distance_s, None);
    }

    #[test]
    fn parses_seek_csv_line() {
        let line = "1771042665305,seek,\"linux-pass-a\",\"/tmp/cap-bench-1080p60.mp4\",60,240,10,240,0,1,59.982,4.001,1.355,2.566,4.269,5.252,2.000,149.213,364.124,364.124,10,0";
        let row = parse_csv_line(line).expect("expected row");
        assert_eq!(row.mode, "seek");
        assert_eq!(row.seek_samples, 10);
        assert_eq!(row.seek_failures, 0);
        assert_eq!(row.seek_distance_s, Some(2.0));
    }

    #[test]
    fn summarizes_sequential_and_seek_medians() {
        let rows = vec![
            super::PlaybackCsvRow {
                mode: "sequential".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                effective_fps: 59.0,
                decode_p95_ms: 3.0,
                missed_deadlines: 1,
                seek_distance_s: None,
                seek_avg_ms: None,
                seek_p95_ms: None,
                seek_max_ms: None,
                seek_samples: 0,
                seek_failures: 0,
            },
            super::PlaybackCsvRow {
                mode: "sequential".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                effective_fps: 61.0,
                decode_p95_ms: 2.0,
                missed_deadlines: 3,
                seek_distance_s: None,
                seek_avg_ms: None,
                seek_p95_ms: None,
                seek_max_ms: None,
                seek_samples: 0,
                seek_failures: 0,
            },
            super::PlaybackCsvRow {
                mode: "seek".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                effective_fps: 60.0,
                decode_p95_ms: 0.0,
                missed_deadlines: 0,
                seek_distance_s: Some(2.0),
                seek_avg_ms: Some(100.0),
                seek_p95_ms: Some(120.0),
                seek_max_ms: Some(130.0),
                seek_samples: 10,
                seek_failures: 0,
            },
            super::PlaybackCsvRow {
                mode: "seek".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                effective_fps: 60.0,
                decode_p95_ms: 0.0,
                missed_deadlines: 0,
                seek_distance_s: Some(2.0),
                seek_avg_ms: Some(140.0),
                seek_p95_ms: Some(180.0),
                seek_max_ms: Some(190.0),
                seek_samples: 10,
                seek_failures: 1,
            },
        ];
        let (sequential, seeks) = summarize(&rows).expect("summary");
        assert_eq!(sequential.samples, 2);
        assert!((sequential.effective_fps - 60.0).abs() < f64::EPSILON);
        assert_eq!(sequential.missed_deadlines, 2);
        assert_eq!(seeks.len(), 1);
        assert_eq!(seeks[0].distance_millis, 2000);
        assert_eq!(seeks[0].seek_samples, 20);
        assert_eq!(seeks[0].seek_failures, 1);
        assert!((seeks[0].seek_avg_ms - 120.0).abs() < f64::EPSILON);
    }

    #[test]
    fn groups_rows_by_label_and_video() {
        let rows = vec![
            super::PlaybackCsvRow {
                mode: "sequential".to_string(),
                run_label: "label-a".to_string(),
                video: "video-1".to_string(),
                effective_fps: 60.0,
                decode_p95_ms: 2.0,
                missed_deadlines: 0,
                seek_distance_s: None,
                seek_avg_ms: None,
                seek_p95_ms: None,
                seek_max_ms: None,
                seek_samples: 0,
                seek_failures: 0,
            },
            super::PlaybackCsvRow {
                mode: "sequential".to_string(),
                run_label: "label-a".to_string(),
                video: "video-2".to_string(),
                effective_fps: 60.0,
                decode_p95_ms: 2.0,
                missed_deadlines: 0,
                seek_distance_s: None,
                seek_avg_ms: None,
                seek_p95_ms: None,
                seek_max_ms: None,
                seek_samples: 0,
                seek_failures: 0,
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
        let path = PathBuf::from(format!("/tmp/playback-csv-report-{unique}.csv"));

        let sequential = super::SequentialSummary {
            samples: 2,
            effective_fps: 60.0,
            decode_p95_ms: 2.0,
            missed_deadlines: 1,
        };
        let seeks = vec![super::SeekSummary {
            distance_millis: 2000,
            samples: 2,
            seek_avg_ms: 120.0,
            seek_p95_ms: 150.0,
            seek_max_ms: 170.0,
            seek_samples: 20,
            seek_failures: 0,
        }];

        append_summary_csv(
            &path,
            &[SummaryEntry {
                label: "label-a".to_string(),
                video: "video-1".to_string(),
                sequential,
                seeks: seeks.clone(),
            }],
        )
        .expect("summary csv");

        append_delta_csv(
            &path,
            "baseline",
            "candidate",
            "video-1",
            sequential,
            sequential,
            &seeks,
            &seeks,
        )
        .expect("delta csv");

        let contents = fs::read_to_string(&path).expect("read csv");
        let rows = contents.lines().collect::<Vec<_>>();
        assert_eq!(rows.len(), 5);
        assert!(rows[0].contains("timestamp_ms,mode,label,video"));
        assert!(rows[1].contains("summary_sequential"));
        assert!(rows[2].contains("summary_seek"));
        assert!(rows[3].contains("delta_sequential"));
        assert!(rows[4].contains("delta_seek"));

        let _ = fs::remove_file(path);
    }
}
