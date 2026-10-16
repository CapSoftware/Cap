//! Case results, the strict expected-failure list and the JSON report.
//!
//! Every case ends in [`settle`]: its failure classes are judged against
//! `crates/verify/expectations.toml` with the shared strict rules of
//! `cap-verify-expect` (a listed class passes as XFAIL, a listed class that
//! no longer occurs fails with "remove this xfail", any other failure fails
//! with the exact mismatches and a one-line local repro command), and the
//! result is written as a JSON record to `CAP_VERIFY_REPORT_DIR`.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Instant,
};

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

/// Classes that measure wall-clock behaviour of the runner as much as of Cap
/// (real-time playback delivering fewer frames than it should). Only these
/// may become inconclusive, and only under proven starvation.
const WALL_CLOCK_CLASSES: &[&str] = &["dropped"];

/// Set by scripts/verify/retry.py when it reruns a test once.
fn retrying() -> bool {
    std::env::var("CAP_VERIFY_RETRY").as_deref() == Ok("1")
}

pub struct Case {
    pub id: String,
    started: Instant,
    machine: crate::sentinel::Mark,
    pub streams: Vec<StreamReport>,
    pub problems: Vec<String>,
    /// The class of each entry of `problems` (a stream report's classes,
    /// comma-separated).
    pub problem_classes: Vec<String>,
    /// Failure classes seen (see `expectations.toml`).
    pub classes: BTreeSet<String>,
    /// First problem per class (the draft reason when blessing).
    class_problems: BTreeMap<String, String>,
    pub notes: Vec<String>,
    /// Classes this case could not measure because an earlier check failed
    /// -> why (see `cap_verify_expect::Unobserved`).
    pub unobserved: BTreeMap<String, String>,
    /// Set when this runner cannot run the case at all (for example no
    /// D3D11 video device for Media Foundation on a GPU-less Windows VM).
    pub unsupported: Option<String>,
}

/// Scratch (export-order proof): the case running in this process, for the
/// output hash log.
pub static CURRENT_CASE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

impl Case {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        if let Ok(mut current) = CURRENT_CASE.lock() {
            current.clone_from(&id);
        }
        eprintln!("[cap-verify] case {id} ({})", platform());
        Self {
            id,
            started: Instant::now(),
            machine: crate::sentinel::mark(),
            streams: Vec::new(),
            problems: Vec::new(),
            problem_classes: Vec::new(),
            classes: Default::default(),
            class_problems: Default::default(),
            notes: Vec::new(),
            unobserved: Default::default(),
            unsupported: None,
        }
    }

    /// Marks the case as impossible on this machine. With
    /// `CAP_VERIFY_REQUIRE_SUPPORTED=1` (runners that must have every path)
    /// it is a failure of class `unsupported` instead.
    pub fn unsupported(&mut self, reason: impl Into<String>) {
        let reason = reason.into();
        if std::env::var("CAP_VERIFY_REQUIRE_SUPPORTED").as_deref() == Ok("1") {
            self.problem(
                "unsupported",
                format!("unsupported on this machine: {reason}"),
            );
        } else {
            self.unsupported = Some(reason);
        }
    }

    /// Records a failure of the given class (`error`, `frame-count`,
    /// `nondeterministic`, ...).
    pub fn problem(&mut self, class: &str, text: impl Into<String>) {
        let text = text.into();
        self.classes.insert(class.to_string());
        self.class_problems
            .entry(class.to_string())
            .or_insert_with(|| text.clone());
        self.problem_classes.push(class.to_string());
        self.problems.push(text);
    }

    /// Records that `class` could not be measured because the check it
    /// depends on failed. The case must also report that failure: an
    /// unobserved class never makes a case pass, it only stops an expected
    /// failure of `class` from counting as fixed.
    pub fn unobserved(&mut self, class: &str, why: impl Into<String>) {
        self.unobserved
            .entry(class.to_string())
            .or_insert_with(|| why.into());
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
                ("blend", report.blend_weight),
            ] {
                if n > 0 {
                    self.classes.insert(class.to_string());
                    self.class_problems
                        .entry(class.to_string())
                        .or_insert_with(|| report.summary());
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

pub use cap_verify_expect::{Xfail, glob_match};

/// Expectations file, relative to the repository root.
const EXPECTATIONS: &str = "crates/verify/expectations.toml";

pub fn expectations_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("expectations.toml")
}

pub fn load_expectations() -> Vec<Xfail> {
    cap_verify_expect::load(&expectations_path())
}

/// Entries that apply to `id` on this platform.
pub fn xfails_for(id: &str) -> Vec<Xfail> {
    let platform = platform();
    load_expectations()
        .into_iter()
        .filter(|x| x.matches(id, platform))
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

/// Whether a case runs: `CAP_VERIFY_CASE`, `CAP_VERIFY_SKIP` and
/// `CAP_VERIFY_SHARD` (see `cap_verify_expect::case_selected`).
pub fn selected(id: &str) -> bool {
    cap_verify_expect::case_selected(id)
}

fn write_result(
    result: &CaseResult,
    classes: &BTreeMap<String, String>,
    unobserved: &BTreeMap<String, String>,
    machine: &crate::sentinel::Window,
) {
    use cap_verify_expect::{Outcome, Record};
    let record = Record {
        suite: "cap-verify".into(),
        expectations: EXPECTATIONS.into(),
        case: result.id.clone(),
        platform: result.platform.clone(),
        tier: match result.tier {
            Tier::Fast => "fast".into(),
            Tier::Full => "full".into(),
        },
        outcome: match result.outcome.as_str() {
            "pass" => Outcome::Pass,
            "unsupported" => Outcome::Unsupported,
            "xfail" => Outcome::Xfail,
            "XPASS" => Outcome::Xpass,
            "inconclusive" => Outcome::Inconclusive,
            _ => Outcome::Fail,
        },
        failures: classes
            .keys()
            .map(|class| (class.clone(), Default::default()))
            .collect(),
        seeds_ran: None,
        unobserved: unobserved.clone(),
        problems: classes.clone(),
        summary: result.summary.clone(),
        repro: result.repro.clone(),
        seconds: result.seconds,
    };
    let extra = serde_json::json!({
        "streams": result.streams,
        "notes": result.notes,
        "machine": machine,
    });
    cap_verify_expect::write_records(&[(record, extra)]);
}

/// Settles a case against the expectations file. Returns an error message
/// when the test must fail.
pub fn settle(mut case: Case) -> Result<CaseResult, String> {
    let measured: Vec<String> = case
        .unobserved
        .keys()
        .filter(|class| case.classes.contains(*class))
        .cloned()
        .collect();
    for class in measured {
        case.unobserved.remove(&class);
    }
    if !case.unobserved.is_empty() && !case.failed() {
        let classes: Vec<&String> = case.unobserved.keys().collect();
        case.problem(
            "harness",
            format!("{classes:?} reported unmeasurable without the failure that prevented it"),
        );
    }
    let xfails = xfails_for(&case.id);
    let failed = case.failed();
    let repro = repro_command(&case.id);
    let platform = platform();
    let ran = cap_verify_expect::Ran::from([(case.id.clone(), None)]);
    let observed: cap_verify_expect::Observed = case
        .classes
        .iter()
        .map(|class| ((case.id.clone(), class.clone()), Default::default()))
        .collect();
    let unobserved: cap_verify_expect::Unobserved = case
        .unobserved
        .keys()
        .map(|class| (case.id.clone(), class.clone()))
        .collect();
    let verdict =
        cap_verify_expect::judge_observing(&xfails, platform, &ran, &observed, &unobserved);
    let mut unexpected: Vec<&String> = verdict.unexpected.iter().map(|u| &u.class).collect();
    let fixed: Vec<&Xfail> = verdict.fixed.iter().map(|f| &f.xfail).collect();
    // Machine starvation excuses only wall-clock classes, and only until the
    // retry: content, frame identity, timestamps and sync never.
    let machine = crate::sentinel::window(case.machine);
    case.notes.push(machine.describe());
    let wall_clock_only = !unexpected.is_empty()
        && unexpected
            .iter()
            .all(|class| WALL_CLOCK_CLASSES.contains(&class.as_str()));
    let environment = String::from("environment");
    let inconclusive = wall_clock_only && machine.starved() && !retrying();
    if wall_clock_only && machine.starved() && retrying() {
        case.problem(
            "environment",
            format!(
                "inconclusive again on retry ({}): the machine starved this case twice",
                machine.describe()
            ),
        );
        unexpected = vec![&environment];
    }
    let outcome = if case.unsupported.is_some() && !failed {
        "unsupported"
    } else if inconclusive {
        "inconclusive"
    } else if !unexpected.is_empty() {
        "FAIL"
    } else if !fixed.is_empty() {
        "XPASS"
    } else if failed {
        "xfail"
    } else {
        "pass"
    };
    let mut summary = if let Some(reason) = case.unsupported.as_ref().filter(|_| !failed) {
        format!("not run: {reason}")
    } else if failed {
        case.problems.join("\n  ")
    } else {
        let streams: Vec<String> = case
            .streams
            .iter()
            .map(|s| format!("{} ({} unchecked)", s.summary(), s.unchecked))
            .collect();
        format!("all checks passed: {}", streams.join(", "))
    };
    for (class, why) in &case.unobserved {
        summary.push_str(&format!("\n  ({class} not measured: {why})"));
    }
    for x in &xfails {
        summary.push_str(&format!(
            "\n  (expected {}{}: {} {})",
            x.class,
            if x.flaky { ", flaky" } else { "" },
            x.reason,
            x.link
        ));
    }
    let result = CaseResult {
        id: case.id.clone(),
        platform: platform.to_string(),
        tier: tier(),
        passed: matches!(outcome, "pass" | "xfail" | "unsupported"),
        summary: summary.clone(),
        streams: case.streams,
        notes: case.notes,
        seconds: case.started.elapsed().as_secs_f64(),
        repro: repro.clone(),
        outcome: outcome.to_string(),
    };
    write_result(&result, &case.class_problems, &case.unobserved, &machine);
    eprintln!(
        "[cap-verify] {outcome} {} in {:.1}s\n  {summary}",
        result.id, result.seconds
    );
    match outcome {
        "inconclusive" => Err(format!(
            "case {} inconclusive: {} failed while the machine starved the process ({}); retried once by scripts/verify/retry.py\n  repro: {repro}",
            result.id,
            unexpected
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            machine.describe()
        )),
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
