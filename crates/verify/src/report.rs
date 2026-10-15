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
    /// The class of each entry of `problems` (a stream report's classes,
    /// comma-separated).
    pub problem_classes: Vec<String>,
    /// Failure classes seen (see `expectations.toml`).
    pub classes: std::collections::BTreeSet<String>,
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
            problem_classes: Vec::new(),
            classes: Default::default(),
            notes: Vec::new(),
        }
    }

    /// Records a failure of the given class (`error`, `frame-count`,
    /// `nondeterministic`, ...).
    pub fn problem(&mut self, class: &str, text: impl Into<String>) {
        self.classes.insert(class.to_string());
        self.problem_classes.push(class.to_string());
        self.problems.push(text.into());
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }

    pub fn stream(&mut self, report: StreamReport) {
        if !report.passed() {
            let mut classes = Vec::new();
            for (class, n) in [
                ("stale", report.stale),
                ("future", report.ahead),
                ("wrong-segment", report.wrong_segment),
                ("unreadable", report.unreadable),
                ("missing", report.missing),
                ("unexpected", report.unexpected),
            ] {
                if n > 0 {
                    self.classes.insert(class.to_string());
                    classes.push(class);
                }
            }
            self.problem_classes.push(classes.join(","));
            self.problems.push(report.summary());
        }
        self.streams.push(report);
    }

    pub fn failed(&self) -> bool {
        !self.problems.is_empty()
    }
}

/// One `[[xfail]]` entry of `crates/verify/expectations.toml` (the same
/// shape as the decoder model's expectations file).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Xfail {
    /// Case id, `*` globs allowed.
    pub case: String,
    /// Failure class that must still occur.
    pub class: String,
    pub reason: String,
    #[serde(default)]
    pub link: String,
    /// Platforms the entry applies to (`macos`, `linux`, `windows`); empty
    /// means all.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
    /// Timing-dependent: the case may pass or fail with this class. Use only
    /// with a measured flake rate in the reason.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flaky: bool,
}

#[derive(Deserialize)]
struct ExpectationsFile {
    #[serde(default)]
    xfail: Vec<Xfail>,
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("expectations.toml")
}

pub fn load_expectations() -> Vec<Xfail> {
    let text = std::fs::read_to_string(expectations_path()).unwrap_or_default();
    match toml::from_str::<ExpectationsFile>(&text) {
        Ok(file) => file.xfail,
        Err(error) => panic!("{}: {error}", expectations_path().display()),
    }
}

/// Entries that apply to `id` on this platform.
pub fn xfails_for(id: &str) -> Vec<Xfail> {
    let platform = platform();
    load_expectations()
        .into_iter()
        .filter(|x| {
            glob_match(&x.case, id)
                && (x.platforms.is_empty() || x.platforms.iter().any(|p| p == platform))
        })
        .collect()
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
    let xfails = xfails_for(&case.id);
    let failed = case.failed();
    let repro = repro_command(&case.id);
    let unexpected: Vec<&String> = case
        .classes
        .iter()
        .filter(|class| !xfails.iter().any(|x| &x.class == *class))
        .collect();
    let fixed: Vec<&Xfail> = xfails
        .iter()
        .filter(|x| !x.flaky && !case.classes.contains(&x.class))
        .collect();
    let outcome = if !unexpected.is_empty() {
        "FAIL"
    } else if !fixed.is_empty() {
        "XPASS"
    } else if failed {
        "xfail"
    } else {
        "pass"
    };
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
    for x in &xfails {
        summary.push_str(&format!(
            "\n  (expected {}{}: {} {})",
            x.class,
            if x.flaky { ", flaky" } else { "" },
            x.reason,
            x.link
        ));
    }
    let blessing = std::env::var_os("CAP_VERIFY_BLESS").is_some();
    if blessing && failed {
        bless(&case);
    }
    let result = CaseResult {
        id: case.id.clone(),
        platform: platform().to_string(),
        tier: tier(),
        passed: blessing || matches!(outcome, "pass" | "xfail"),
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
    if blessing {
        return Ok(result);
    }
    match outcome {
        "FAIL" => Err(format!(
            "case {} failed ({}):\n  {summary}\n  repro: {repro}",
            result.id,
            unexpected
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        "XPASS" => Err(format!(
            "case {} no longer fails with {}: remove that xfail from {}\n  repro: {repro}",
            result.id,
            fixed
                .iter()
                .map(|x| x.class.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            expectations_path().display()
        )),
        _ => Ok(result),
    }
}

/// `CAP_VERIFY_BLESS=<dir>`: record every failing case's classes as draft
/// `[[xfail]]` entries (one file per process) instead of failing.
fn bless(case: &Case) {
    let Some(dir) = std::env::var_os("CAP_VERIFY_BLESS") else {
        return;
    };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("bless-{}-{}.toml", platform(), std::process::id()));
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    else {
        return;
    };
    let reason = case.problems.first().cloned().unwrap_or_default();
    for class in &case.classes {
        let entry = Xfail {
            case: case.id.clone(),
            class: class.clone(),
            reason: reason.clone(),
            link: String::new(),
            platforms: vec![platform().to_string()],
            flaky: false,
        };
        if let Ok(text) = toml::to_string(&entry) {
            let _ = writeln!(f, "[[xfail]]\n{text}");
        }
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
