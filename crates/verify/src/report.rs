//! Case results, the strict expected-failure list and the JSON report.
//!
//! Every case ends in [`finish`]: a failing case listed in
//! `crates/verify/expectations.txt` passes as XFAIL, a listed case that
//! passes fails ("remove this xfail"), and any other failure fails with the
//! exact mismatches and a one-line local repro command.

use std::{io::Write, path::PathBuf, time::Instant};

use serde::{Deserialize, Serialize};

use crate::oracle::StreamReport;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Fast,
    Full,
}

/// `CAP_VERIFY_TIER=full` selects the merge-gate/nightly tier; anything else
/// (or unset) is the fast PR tier.
pub fn tier() -> Tier {
    match std::env::var("CAP_VERIFY_TIER").as_deref() {
        Ok("full") => Tier::Full,
        _ => Tier::Fast,
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaseResult {
    pub id: String,
    pub platform: String,
    pub tier: Tier,
    pub passed: bool,
    pub summary: String,
    pub streams: Vec<StreamReport>,
    pub notes: Vec<String>,
    pub seconds: f64,
    pub repro: String,
    pub outcome: String,
}

pub struct Case {
    pub id: String,
    started: Instant,
    pub streams: Vec<StreamReport>,
    pub problems: Vec<String>,
    pub notes: Vec<String>,
}

impl Case {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        eprintln!("[cap-verify] case {id} ({})", platform());
        Self {
            id,
            started: Instant::now(),
            streams: Vec::new(),
            problems: Vec::new(),
            notes: Vec::new(),
        }
    }

    pub fn problem(&mut self, text: impl Into<String>) {
        self.problems.push(text.into());
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }

    pub fn stream(&mut self, report: StreamReport) {
        if !report.passed() {
            self.problems.push(report.summary());
        }
        self.streams.push(report);
    }

    pub fn failed(&self) -> bool {
        !self.problems.is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct Xfail {
    pub line: usize,
    pub pattern: String,
    pub platforms: Vec<String>,
    pub reason: String,
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            let Some(stripped) = rest.strip_prefix(part) else {
                return false;
            };
            rest = stripped;
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(at) = rest.find(part) else {
                return false;
            };
            rest = &rest[at + part.len()..];
        }
    }
    true
}

pub fn expectations_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("expectations.txt")
}

/// Parses `expectations.txt`: `<case glob> <platforms|all> <reason...>`.
pub fn load_expectations() -> Vec<Xfail> {
    let text = std::fs::read_to_string(expectations_path()).unwrap_or_default();
    text.lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let mut fields = line.split_whitespace();
            let pattern = fields.next()?.to_string();
            let platforms = fields.next()?.split(',').map(str::to_string).collect();
            let reason = fields.collect::<Vec<_>>().join(" ");
            Some(Xfail {
                line: i + 1,
                pattern,
                platforms,
                reason,
            })
        })
        .collect()
}

pub fn lookup_xfail(id: &str) -> Option<Xfail> {
    let platform = platform();
    load_expectations().into_iter().find(|x| {
        glob_match(&x.pattern, id) && x.platforms.iter().any(|p| p == "all" || p == platform)
    })
}

fn repro_command(id: &str) -> String {
    let test = id.split('/').next().unwrap_or("export");
    format!(
        "CAP_VERIFY_CASE='{id}' CAP_VERIFY_TIER={} cargo test -p cap-verify --test {test} -- --nocapture",
        match tier() {
            Tier::Fast => "fast",
            Tier::Full => "full",
        }
    )
}

/// Whether a case id is selected by `CAP_VERIFY_CASE` (glob, default all).
pub fn selected(id: &str) -> bool {
    match std::env::var("CAP_VERIFY_CASE") {
        Ok(pattern) if !pattern.is_empty() => pattern.split(',').any(|p| glob_match(p, id)),
        _ => true,
    }
}

fn write_result(result: &CaseResult) {
    let Some(dir) = std::env::var_os("CAP_VERIFY_REPORT_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("{}.jsonl", std::process::id()));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        && let Ok(line) = serde_json::to_string(result)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Settles a case against the expectations file. Returns an error message
/// when the test must fail.
pub fn settle(case: Case) -> Result<CaseResult, String> {
    let xfail = lookup_xfail(&case.id);
    let failed = case.failed();
    let mut summary = if failed {
        case.problems.join("\n  ")
    } else {
        let streams: Vec<String> = case
            .streams
            .iter()
            .map(|s| format!("{} ({} unchecked)", s.summary(), s.unchecked))
            .collect();
        format!("all checks passed: {}", streams.join(", "))
    };
    let repro = repro_command(&case.id);
    let outcome = match (&xfail, failed) {
        (None, false) => "pass",
        (Some(_), true) => "xfail",
        (None, true) => "FAIL",
        (Some(_), false) => "XPASS",
    };
    if let Some(x) = &xfail {
        summary = format!(
            "{summary}\n  (expected failure, expectations.txt:{}: {})",
            x.line, x.reason
        );
    }
    let result = CaseResult {
        id: case.id.clone(),
        platform: platform().to_string(),
        tier: tier(),
        passed: matches!(outcome, "pass" | "xfail"),
        summary: summary.clone(),
        streams: case.streams,
        notes: case.notes,
        seconds: case.started.elapsed().as_secs_f64(),
        repro: repro.clone(),
        outcome: outcome.to_string(),
    };
    write_result(&result);
    eprintln!(
        "[cap-verify] {outcome} {} in {:.1}s\n  {summary}",
        result.id, result.seconds
    );
    match outcome {
        "FAIL" => Err(format!(
            "case {} failed:\n  {summary}\n  repro: {repro}",
            result.id
        )),
        "XPASS" => Err(format!(
            "case {} now passes: remove its xfail ({}:{})\n  repro: {repro}",
            result.id,
            expectations_path().display(),
            xfail.map_or(0, |x| x.line)
        )),
        _ => Ok(result),
    }
}

#[cfg(test)]
mod tests {
    use super::glob_match;

    #[test]
    fn globs() {
        assert!(glob_match("export/*", "export/basic/mp4"));
        assert!(glob_match("export/*/avf", "export/jitter/avf"));
        assert!(!glob_match("export/*/avf", "export/jitter/ffmpeg"));
        assert!(glob_match("a", "a"));
        assert!(!glob_match("a", "ab"));
    }
}
