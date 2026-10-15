//! `cap-verify-expect check <file>...` validates expectations files.
//! `cap-verify-expect bless <report dir or .jsonl>...` rewrites every
//! expectations file named in the records so those runs pass exactly. Records
//! from several platforms (for example the CI report artifacts of all three
//! OSes) can be blessed in one call; each platform only changes its own
//! entries.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::ExitCode,
};

use cap_verify_expect::{Observed, Ran, Record, bless, header, load, parse, render};

fn collect(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        entries.sort();
        for entry in entries {
            collect(&entry, out);
        }
    } else if path.extension().is_some_and(|ext| ext == "jsonl") {
        out.push(path.to_path_buf());
    }
}

fn repo_root() -> PathBuf {
    std::env::var_os("CAP_VERIFY_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

#[derive(Default)]
struct Run {
    ran: Ran,
    observed: Observed,
    problems: BTreeMap<(String, String), String>,
}

fn bless_command(inputs: &[String]) -> ExitCode {
    let mut files = Vec::new();
    for input in inputs {
        collect(Path::new(input), &mut files);
    }
    if files.is_empty() {
        eprintln!("no .jsonl records under {inputs:?}");
        return ExitCode::FAILURE;
    }
    let mut runs: BTreeMap<String, BTreeMap<String, Run>> = BTreeMap::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let record: Record = match serde_json::from_str(line) {
                Ok(record) => record,
                Err(e) => {
                    eprintln!("{}: skipping a record: {e}", file.display());
                    continue;
                }
            };
            let run = runs
                .entry(record.expectations.clone())
                .or_default()
                .entry(record.platform.clone())
                .or_default();
            let ran = run.ran.entry(record.case.clone()).or_insert(None);
            if let Some(seeds) = &record.seeds_ran {
                ran.get_or_insert_with(BTreeSet::new).extend(seeds);
            }
            for (class, seeds) in &record.failures {
                run.observed
                    .entry((record.case.clone(), class.clone()))
                    .or_default()
                    .extend(seeds);
                if let Some(problem) = record.problems.get(class) {
                    run.problems
                        .entry((record.case.clone(), class.clone()))
                        .or_insert_with(|| problem.clone());
                }
            }
        }
    }
    let root = repo_root();
    for (expectations, platforms) in &runs {
        let path = root.join(expectations);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let before = load(&path);
        let mut entries = before.clone();
        for (platform, run) in platforms {
            entries = bless(&entries, platform, &run.ran, &run.observed, &run.problems);
        }
        let added = entries.iter().filter(|e| !before.contains(e)).count();
        let removed = before.iter().filter(|e| !entries.contains(e)).count();
        let platform_list: Vec<&String> = platforms.keys().collect();
        if added == 0 && removed == 0 {
            println!("{expectations}: unchanged ({platform_list:?})");
            continue;
        }
        if let Err(e) = std::fs::write(&path, format!("{}{}", header(&text), render(&entries))) {
            eprintln!("{}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!(
            "{expectations}: {removed} entries removed or changed, {added} written ({platform_list:?}); review the diff and fill in TODO reasons"
        );
    }
    ExitCode::SUCCESS
}

fn check_command(paths: &[String]) -> ExitCode {
    let mut ok = true;
    for path in paths {
        match std::fs::read_to_string(path)
            .map_err(|e| e.to_string())
            .and_then(|t| parse(&t))
        {
            Ok(entries) => {
                let todo = entries
                    .iter()
                    .filter(|e| e.reason.starts_with("TODO"))
                    .count();
                if todo > 0 {
                    eprintln!("{path}: {todo} entries still have a TODO reason");
                    ok = false;
                } else {
                    println!("{path}: {} entries", entries.len());
                }
            }
            Err(e) => {
                eprintln!("{path}: {e}");
                ok = false;
            }
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((command, rest)) if command == "bless" && !rest.is_empty() => bless_command(rest),
        Some((command, rest)) if command == "check" && !rest.is_empty() => check_command(rest),
        _ => {
            eprintln!(
                "usage: cap-verify-expect bless <report dir | .jsonl>...\n       cap-verify-expect check <expectations.toml>..."
            );
            ExitCode::from(2)
        }
    }
}
