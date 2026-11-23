use std::{fs, path::Path};

use cap_meetings::sources::{SourceTurn, Tuning, link, stems};

fn points(markdown: &str) -> Vec<(String, String)> {
    let mut section = String::new();
    let mut out = Vec::new();
    for line in markdown.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Title:") {
            continue;
        }
        if let Some(heading) = line.strip_prefix('#') {
            section = heading.trim_start_matches('#').trim().to_string();
            continue;
        }
        let text = line
            .trim_start_matches("- [ ] ")
            .trim_start_matches("- [x] ")
            .trim_start_matches("- ")
            .replace("**", "");
        if stems(&text).len() >= 3 {
            out.push((section.clone(), text));
        }
    }
    out
}

fn main() {
    let mut args = std::env::args().skip(1);
    let corpus = args.next().expect("corpus dir");
    let notes = args.next().expect("notes dir");
    let grid = args.next().is_some_and(|a| a == "grid");
    let mut meetings: Vec<_> = fs::read_dir(&corpus)
        .expect("corpus")
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .collect();
    meetings.sort();
    let tunings: Vec<Tuning> = if grid {
        let mut all = Vec::new();
        for coverage in [0.4, 0.45, 0.5, 0.55, 0.6] {
            for margin in [0.1, 0.15, 0.2] {
                for shared in [2, 3] {
                    all.push(Tuning {
                        min_coverage: coverage,
                        min_margin: margin,
                        min_shared: shared,
                        ..Tuning::default()
                    });
                }
            }
        }
        all
    } else {
        vec![Tuning::default()]
    };
    for tuning in tunings {
        let mut linked = 0;
        let mut total = 0;
        for meeting in &meetings {
            let transcript = fs::read_to_string(Path::new(&corpus).join(meeting).join("transcript.txt"))
                .unwrap_or_default();
            let Ok(md) = fs::read_to_string(Path::new(&notes).join(format!("{meeting}.md"))) else {
                continue;
            };
            let lines: Vec<(String, String)> = transcript
                .lines()
                .filter_map(|l| {
                    let (who, text) = l.split_once(": ")?;
                    Some((who.to_string(), text.to_string()))
                })
                .collect();
            let turns: Vec<SourceTurn<'_>> = lines
                .iter()
                .map(|(who, text)| SourceTurn {
                    text,
                    speaker: who,
                })
                .collect();
            let pts = points(&md);
            let texts: Vec<&str> = pts.iter().map(|(_, t)| t.as_str()).collect();
            let started = std::time::Instant::now();
            let links = link(&texts, &turns, tuning);
            let ms = started.elapsed().as_secs_f64() * 1000.;
            total += pts.len();
            linked += links.iter().filter(|l| l.is_some()).count();
            if !grid {
                eprintln!("{meeting}: {} turns, {} points, {:.2} ms", turns.len(), pts.len(), ms);
                for (i, ((section, point), l)) in pts.iter().zip(&links).enumerate() {
                    if let Some(l) = l {
                        let src: Vec<String> = (l.turn..l.turn + l.span)
                            .map(|t| format!("{}: {}", lines[t].0, lines[t].1))
                            .collect();
                        println!(
                            "{meeting}\t{i}\t{section}\t{}\t{:.2}\t{point}\t{}",
                            l.turn,
                            l.score,
                            src.join(" || ")
                        );
                    }
                }
            }
        }
        eprintln!(
            "coverage>={:.2} margin>={:.2} shared>={}: {linked}/{total} linked",
            tuning.min_coverage, tuning.min_margin, tuning.min_shared
        );
    }
}
