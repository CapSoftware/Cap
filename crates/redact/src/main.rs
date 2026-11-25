use std::{
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use cap_project::{
    RedactCategory,
    redaction::{REDACTIONS_FILE, Redactions},
};
use cap_redact::{Analyzer, OcrModel, Stats, segment_sources};

const USAGE: &str = "usage:
  cap-redact analyze <project.cap | video> --model <dir> [--categories a,b] [--out <redactions.json>] [--force] [--stats]
  cap-redact classify --model-free [--categories a,b] < lines.txt";

fn main() -> ExitCode {
    let level = if std::env::var_os("CAP_REDACT_DEBUG").is_some() {
        tracing::Level::DEBUG
    } else {
        tracing::Level::WARN
    };
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_writer(std::io::stderr)
        .init();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.first().map(String::as_str) {
        Some("analyze") => analyze(&args[1..]),
        Some("classify") => classify(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

struct Options {
    input: Option<PathBuf>,
    model: Option<PathBuf>,
    categories: Option<Vec<RedactCategory>>,
    out: Option<PathBuf>,
    force: bool,
    stats: bool,
}

fn parse(args: &[String]) -> anyhow::Result<Options> {
    let mut options = Options {
        input: None,
        model: None,
        categories: None,
        out: None,
        force: false,
        stats: false,
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--model" => options.model = iter.next().map(PathBuf::from),
            "--out" => options.out = iter.next().map(PathBuf::from),
            "--categories" => {
                let value = iter.next().map(String::as_str).unwrap_or_default();
                let mut categories = Vec::new();
                for name in value.split(',').filter(|n| !n.trim().is_empty()) {
                    categories.push(
                        RedactCategory::parse(name)
                            .ok_or_else(|| anyhow::anyhow!("unknown category {name:?}"))?,
                    );
                }
                options.categories = Some(categories);
            }
            "--force" => options.force = true,
            "--stats" => options.stats = true,
            "--model-free" => {}
            other if other.starts_with("--") => anyhow::bail!("unknown option {other}\n{USAGE}"),
            other => options.input = Some(PathBuf::from(other)),
        }
    }
    Ok(options)
}

fn analyze(args: &[String]) -> anyhow::Result<()> {
    let options = parse(args)?;
    let input = options
        .input
        .ok_or_else(|| anyhow::anyhow!("missing input\n{USAGE}"))?;
    let model_dir = options
        .model
        .ok_or_else(|| anyhow::anyhow!("missing --model\n{USAGE}"))?;
    let out = options.out.unwrap_or_else(|| {
        if input.is_dir() {
            input.join(REDACTIONS_FILE)
        } else {
            input.with_extension("redactions.json")
        }
    });
    let sources = segment_sources(&input)?;
    let load_started = Instant::now();
    let mut model = OcrModel::load(&model_dir)?;
    let load_time = load_started.elapsed();
    let previous = if options.force {
        None
    } else {
        std::fs::read(&out)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Redactions>(&bytes).ok())
    };
    let mut stats = Stats::default();
    let started = Instant::now();
    let mut analyzer = Analyzer::new(&mut model);
    let mut last_print = Instant::now();
    let mut redactions = analyzer.analyze(
        &sources,
        previous.as_ref(),
        |progress| {
            if options.stats && last_print.elapsed() > Duration::from_secs(2) {
                last_print = Instant::now();
                eprintln!(
                    "segment {} at {:.1}s, {} regions",
                    progress.segment,
                    progress.source_time,
                    progress.snapshot.regions.len()
                );
            }
        },
        &mut stats,
    )?;
    let wall = started.elapsed();
    if let Some(categories) = &options.categories {
        redactions
            .regions
            .retain(|region| categories.contains(&region.category));
    }
    let json = serde_json::to_vec_pretty(&redactions)?;
    let temp = out.with_extension("json.tmp");
    std::fs::write(&temp, json)?;
    std::fs::rename(&temp, &out)?;
    if options.stats {
        let seconds = stats.source_seconds.max(1e-6);
        eprintln!("detector {}", model.detector());
        eprintln!(
            "model load {:.2}s; analysed {:.1}s of video in {:.2}s ({:.3}x realtime, {:.2}s per minute)",
            load_time.as_secs_f64(),
            seconds,
            wall.as_secs_f64(),
            wall.as_secs_f64() / seconds,
            wall.as_secs_f64() / seconds * 60.0
        );
        eprintln!(
            "frames {} duplicates {} detections {} det_mpx {:.1} lines {} reused {} ({:.1}%) cache {} hw_decode {}",
            stats.frames,
            stats.duplicates,
            stats.detections,
            stats.det_pixels / 1e6,
            stats.lines,
            stats.reused,
            100.0 * stats.reused as f64 / stats.lines.max(1) as f64,
            stats.cache_entries,
            stats.hardware_decode
        );
        eprintln!(
            "decode {:.2}s gray {:.2}s rgb {:.2}s change {:.2}s detect {:.2}s recognize {:.2}s classify {:.2}s compile {:.2}s frame_wait {:.2}s",
            stats.decode.as_secs_f64(),
            stats.gray.as_secs_f64(),
            stats.rgb.as_secs_f64(),
            stats.track.as_secs_f64(),
            stats.detect.as_secs_f64(),
            stats.recognize.as_secs_f64(),
            stats.classify.as_secs_f64(),
            stats.compile.as_secs_f64(),
            stats.frame_wait.as_secs_f64()
        );
        let mut costs = stats.frame_costs.clone();
        costs.sort();
        let at = |q: f64| {
            costs
                .get(((costs.len() as f64 - 1.0) * q).round() as usize)
                .map_or(0.0, |d| d.as_secs_f64() * 1e3)
        };
        eprintln!(
            "analysis prepare {:.2}s finish {:.2}s prepare_wait {:.2}s",
            stats.prepare.as_secs_f64(),
            stats.finish.as_secs_f64(),
            stats.decode_wait.as_secs_f64()
        );
        eprintln!(
            "frame ms p50 {:.2} p90 {:.2} p99 {:.2} max {:.2}",
            at(0.5),
            at(0.9),
            at(0.99),
            at(1.0)
        );
        eprintln!("regions {} -> {}", redactions.regions.len(), out.display());
    }
    Ok(())
}

fn classify(args: &[String]) -> anyhow::Result<()> {
    let options = parse(args)?;
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    for line in input.lines() {
        let findings = cap_redact::classify_line(line)
            .into_iter()
            .filter(|f| {
                options
                    .categories
                    .as_ref()
                    .is_none_or(|categories| categories.contains(&f.category))
            })
            .map(|f| {
                serde_json::json!({
                    "category": f.category.as_str(),
                    "start": f.start,
                    "end": f.end,
                })
            })
            .collect::<Vec<_>>();
        println!("{}", serde_json::to_string(&findings)?);
    }
    Ok(())
}
