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

use cap_verify_expect::{
    Evidence, Observed, Outcome, Ran, Record, bless_with, header, load, parse, render,
};

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
    evidence: Evidence,
    problems: BTreeMap<(String, String), String>,
}

#[derive(serde::Deserialize)]
struct SourceRecord {
    #[serde(flatten)]
    record: Record,
    #[serde(default)]
    host: Option<String>,
}

type HostRuns = BTreeMap<(String, Option<String>), Run>;
type Runs = BTreeMap<String, HostRuns>;

fn add_record(runs: &mut Runs, source: SourceRecord) {
    let SourceRecord { record, host } = source;
    if matches!(record.outcome, Outcome::Unsupported | Outcome::Inconclusive) {
        return;
    }
    let host = host
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty() && h != "unknown");
    let run = runs
        .entry(record.expectations.clone())
        .or_default()
        .entry((record.platform.clone(), host))
        .or_default();
    let ran = run.ran.entry(record.case.clone()).or_insert(None);
    if let Some(seeds) = &record.seeds_ran {
        ran.get_or_insert_with(BTreeSet::new).extend(seeds);
    }
    for class in record.unobserved.keys() {
        run.evidence
            .unobserved
            .insert((record.case.clone(), class.clone()));
    }
    if record.starved {
        run.evidence.starved.insert(record.case.clone());
    }
    for (class, metrics) in &record.measures {
        let entry = run
            .evidence
            .measures
            .entry((record.case.clone(), class.clone()))
            .or_default();
        for (metric, range) in metrics {
            entry
                .entry(metric.clone())
                .and_modify(|r| {
                    r.include(range.min);
                    r.include(range.max);
                })
                .or_insert(*range);
        }
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

fn proposals(
    entries: &[cap_verify_expect::Xfail],
    runs: &HostRuns,
) -> Vec<cap_verify_expect::Xfail> {
    let mut entries = entries.to_vec();
    for ((platform, host), run) in runs {
        entries = bless_with(
            &entries,
            platform,
            host.as_deref(),
            &run.ran,
            &run.observed,
            &run.evidence,
            &run.problems,
        );
    }
    entries
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
    let mut runs = Runs::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let record: SourceRecord = match serde_json::from_str(line) {
                Ok(record) => record,
                Err(e) => {
                    eprintln!("{}: skipping a record: {e}", file.display());
                    continue;
                }
            };
            add_record(&mut runs, record);
        }
    }
    let root = repo_root();
    for (expectations, platforms) in &runs {
        let path = root.join(expectations);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let before = load(&path);
        let entries = proposals(&before, platforms);
        let added = entries.iter().filter(|e| !before.contains(e)).count();
        let removed = before.iter().filter(|e| !entries.contains(e)).count();
        let platform_list: Vec<_> = platforms.keys().collect();
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

#[cfg(test)]
mod tests {
    use super::*;
    use cap_verify_expect::{Metrics, Range};

    fn source_record(source_host: Option<&str>, failure: Option<f64>) -> SourceRecord {
        let mut value = serde_json::json!({
            "suite": "recording",
            "expectations": "expectations.toml",
            "case": "a",
            "platform": "macos",
            "outcome": if failure.is_some() { "xfail" } else { "pass" },
        });
        if let Some(host) = source_host {
            value["host"] = host.into();
        }
        if let Some(value_seen) = failure {
            value["failures"] = serde_json::json!({ "sync": [] });
            value["measures"] = serde_json::json!({ "sync": { "ms": [value_seen, value_seen] } });
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn mixed_host_records_keep_separate_measurements_and_expectations() {
        let entries = parse(
            "[[xfail]]\ncase = \"a\"\nclass = \"sync\"\nplatforms = [\"macos\"]\nhosts = [\"local\", \"github-hosted\"]\nbound = { ms = [-5, 5] }\nreason = \"known offset\"\n",
        )
        .unwrap();
        let mut runs = Runs::new();
        add_record(&mut runs, source_record(Some("local"), Some(3.0)));
        add_record(&mut runs, source_record(Some("blacksmith"), Some(10.0)));
        add_record(&mut runs, source_record(Some("github-hosted"), None));
        let host_runs = &runs["expectations.toml"];
        assert_eq!(host_runs.len(), 3);
        let proposed = proposals(&entries, host_runs);
        assert_eq!(proposed.len(), 2);
        let local = proposed.iter().find(|x| x.hosts == ["local"]).unwrap();
        assert_eq!(local.bound, entries[0].bound);
        assert_eq!(local.reason, entries[0].reason);
        let blacksmith = proposed.iter().find(|x| x.hosts == ["blacksmith"]).unwrap();
        assert_eq!(blacksmith.bound["ms"], Range::at(10.0));
        assert!(blacksmith.reason.starts_with("TODO:"));
    }

    #[test]
    fn legacy_and_unknown_host_records_never_use_the_invoking_host() {
        let entries = parse(
            "[[xfail]]\ncase = \"a\"\nclass = \"sync\"\nhosts = [\"local\", \"github-hosted\"]\nreason = \"known offset\"\n",
        )
        .unwrap();
        for host in [None, Some(""), Some("unknown")] {
            let mut runs = Runs::new();
            add_record(&mut runs, source_record(host, None));
            add_record(&mut runs, source_record(Some("blacksmith"), None));
            let host_runs = &runs["expectations.toml"];
            assert!(host_runs.contains_key(&("macos".into(), None)));
            assert_eq!(proposals(&entries, host_runs), entries);
        }
    }

    #[test]
    fn expanded_signature_requires_a_new_explanation() {
        let entries = parse(
            "[[xfail]]\ncase = \"a\"\nclass = \"sync\"\nbound = { ms = [-5, 5] }\nreason = \"known offset\"\n",
        )
        .unwrap();
        let ran = Ran::from([("a".into(), None)]);
        let observed = Observed::from([(("a".into(), "sync".into()), BTreeSet::new())]);
        let evidence = Evidence {
            measures: BTreeMap::from([(
                ("a".into(), "sync".into()),
                Metrics::from([("ms".into(), Range::at(10.0))]),
            )]),
            ..Default::default()
        };
        let proposals = bless_with(
            &entries,
            "macos",
            Some("local"),
            &ran,
            &observed,
            &evidence,
            &BTreeMap::new(),
        );
        assert_eq!(proposals.len(), 2);
        assert!(proposals.contains(&entries[0]));
        let path = std::env::temp_dir().join(format!(
            "cap-verify-explanation-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, render(&proposals)).unwrap();
        let status = check_command(&[path.to_string_lossy().into_owned()]);
        std::fs::remove_file(path).unwrap();
        assert_eq!(status, ExitCode::FAILURE);

        let retained = bless_with(
            &entries,
            "macos",
            Some("local"),
            &ran,
            &observed,
            &Evidence {
                measures: BTreeMap::from([(
                    ("a".into(), "sync".into()),
                    Metrics::from([("ms".into(), Range::at(3.0))]),
                )]),
                ..Default::default()
            },
            &BTreeMap::new(),
        );
        assert_eq!(retained, entries);
    }
}
