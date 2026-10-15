//! Strict expected failures and case records shared by every engine
//! verification suite (the `cap-verify` oracle tests, the decoder model
//! fuzzer, the upload fault suite).
//!
//! Each suite keeps one TOML file of `[[xfail]]` entries:
//!
//! ```toml
//! [[xfail]]
//! case = "export/early-camera/full/*"  # case id, `*` globs allowed
//! class = "future"                      # failure class that must still occur
//! platforms = ["macos"]                 # optional, absent = every platform
//! seeds = "0 3-7"                       # optional, seeded suites only
//! flaky = true                          # optional, may pass (state the rate)
//! reason = "what is wrong"
//! link = "https://github.com/CapSoftware/Cap/pull/2595"  # empty = no fix yet
//! ```
//!
//! The verdict is strict both ways. A failure class (or seed) that is not
//! listed fails the run, and a listed, non-flaky class (or seed) that no
//! longer fails also fails the run ("remove this xfail"), so fixes stay
//! locked in.
//!
//! Every suite writes one JSON line per case ([`Record`]) to
//! `CAP_VERIFY_REPORT_DIR` when it is set. The `cap-verify-expect` binary
//! rewrites the expectations files from those records (`bless`), and
//! `scripts/verify/summary.py` turns them into the CI job summary.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    io::Write as _,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const PLATFORMS: [&str; 3] = ["linux", "macos", "windows"];

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// One strict expected failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Xfail {
    pub case: String,
    pub class: String,
    /// Empty means every platform.
    pub platforms: Vec<String>,
    /// `None` means the class must occur (on any seed, for seeded suites).
    pub seeds: Option<BTreeSet<u64>>,
    pub flaky: bool,
    pub reason: String,
    pub link: String,
}

impl Xfail {
    pub fn applies_on(&self, platform: &str) -> bool {
        self.platforms.is_empty() || self.platforms.iter().any(|p| p == platform)
    }

    pub fn matches(&self, case: &str, platform: &str) -> bool {
        self.applies_on(platform) && glob_match(&self.case, case)
    }

    fn effective_platforms(&self) -> BTreeSet<String> {
        if self.platforms.is_empty() {
            PLATFORMS.iter().map(|p| p.to_string()).collect()
        } else {
            self.platforms.iter().cloned().collect()
        }
    }

    fn with_platforms(&self, platforms: BTreeSet<String>) -> Self {
        let all = platforms.len() == PLATFORMS.len();
        Self {
            platforms: if all {
                Vec::new()
            } else {
                platforms.into_iter().collect()
            },
            ..self.clone()
        }
    }
}

/// `*` matches any run of characters (including `/`).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let Some(mut rest) = text.strip_prefix(parts[0]) else {
        return false;
    };
    let last = parts.len() - 1;
    for part in &parts[1..last] {
        let Some(at) = rest.find(part) else {
            return false;
        };
        rest = &rest[at + part.len()..];
    }
    rest.ends_with(parts[last])
}

/// Case selection shared by every suite:
/// - `CAP_VERIFY_CASE`: comma-separated globs; only matching cases run.
/// - `CAP_VERIFY_SKIP`: comma-separated globs; matching cases are skipped
///   (the per-platform FAST tier trims in `scripts/verify/suites.json`).
/// - `CAP_VERIFY_SHARD=i/n`: only cases whose id hashes to shard `i` (1-based)
///   of `n` run, so one suite can be split across CI jobs case by case.
pub fn case_selected(id: &str) -> bool {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let globs = |value: String| -> Vec<String> {
        value
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    };
    if let Some(only) = env("CAP_VERIFY_CASE")
        && !globs(only).iter().any(|p| glob_match(p, id))
    {
        return false;
    }
    if let Some(skip) = env("CAP_VERIFY_SKIP")
        && globs(skip).iter().any(|p| glob_match(p, id))
    {
        return false;
    }
    match env("CAP_VERIFY_SHARD").and_then(|v| parse_shard(&v)) {
        Some((index, count)) => shard_of(id, count) == index,
        None => true,
    }
}

fn parse_shard(value: &str) -> Option<(u64, u64)> {
    let (index, count) = value.trim().split_once('/')?;
    let (index, count) = (index.parse().ok()?, count.parse().ok()?);
    (count >= 1 && (1..=count).contains(&index)).then_some((index, count))
}

/// 1-based shard of a case id (FNV-1a, stable across platforms and runs).
pub fn shard_of(id: &str, count: u64) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash % count.max(1) + 1
}

pub fn parse_seeds(text: &str) -> Result<BTreeSet<u64>, String> {
    let mut seeds = BTreeSet::new();
    for item in text.split_whitespace() {
        let parse = |value: &str| {
            value
                .parse::<u64>()
                .map_err(|_| format!("bad seed {value:?}"))
        };
        match item.split_once('-') {
            Some((first, last)) => seeds.extend(parse(first)?..=parse(last)?),
            None => {
                seeds.insert(parse(item)?);
            }
        }
    }
    Ok(seeds)
}

pub fn format_seeds(seeds: &BTreeSet<u64>) -> String {
    let mut runs: Vec<(u64, u64)> = Vec::new();
    for &seed in seeds {
        match runs.last_mut() {
            Some((_, last)) if *last + 1 == seed => *last = seed,
            _ => runs.push((seed, seed)),
        }
    }
    runs.iter()
        .map(|&(first, last)| match last - first {
            0 => first.to_string(),
            1 => format!("{first} {last}"),
            _ => format!("{first}-{last}"),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawXfail {
    case: String,
    class: String,
    #[serde(default)]
    platforms: Vec<String>,
    seeds: Option<String>,
    #[serde(default)]
    flaky: bool,
    reason: String,
    #[serde(default)]
    link: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default)]
    xfail: Vec<RawXfail>,
}

pub fn parse(text: &str) -> Result<Vec<Xfail>, String> {
    let file: RawFile = toml::from_str(text).map_err(|e| e.to_string())?;
    file.xfail
        .into_iter()
        .map(|raw| {
            if raw.case.is_empty() || raw.class.is_empty() || raw.reason.is_empty() {
                return Err(format!(
                    "xfail {:?}/{:?}: case, class and reason are required",
                    raw.case, raw.class
                ));
            }
            if let Some(bad) = raw
                .platforms
                .iter()
                .find(|p| !PLATFORMS.contains(&p.as_str()))
            {
                return Err(format!(
                    "xfail {}: unknown platform {bad:?} (use {PLATFORMS:?})",
                    raw.case
                ));
            }
            let seeds = raw
                .seeds
                .as_deref()
                .map(parse_seeds)
                .transpose()
                .map_err(|e| format!("xfail {}: {e}", raw.case))?;
            Ok(Xfail {
                case: raw.case,
                class: raw.class,
                platforms: raw.platforms,
                seeds,
                flaky: raw.flaky,
                reason: raw.reason,
                link: raw.link,
            })
        })
        .collect()
}

/// Loads an expectations file. A missing file is an empty list; a malformed
/// one panics with the path, since a silently ignored entry would hide a
/// regression.
pub fn load(path: &Path) -> Vec<Xfail> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => panic!("{}: {e}", path.display()),
    }
}

fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Renders entries in the canonical layout (one key per line, fixed order).
pub fn render(entries: &[Xfail]) -> String {
    let mut out = String::new();
    for x in entries {
        out.push_str("[[xfail]]\n");
        let _ = writeln!(out, "case = {}", quote(&x.case));
        let _ = writeln!(out, "class = {}", quote(&x.class));
        if !x.platforms.is_empty() {
            let platforms: Vec<String> = x.platforms.iter().map(|p| quote(p)).collect();
            let _ = writeln!(out, "platforms = [{}]", platforms.join(", "));
        }
        if let Some(seeds) = &x.seeds {
            let _ = writeln!(out, "seeds = {}", quote(&format_seeds(seeds)));
        }
        if x.flaky {
            out.push_str("flaky = true\n");
        }
        let _ = writeln!(out, "reason = {}", quote(&x.reason));
        let _ = writeln!(out, "link = {}", quote(&x.link));
        out.push('\n');
    }
    out
}

/// The comment block before the first entry, kept when a file is rewritten.
pub fn header(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        if line.trim() == "[[xfail]]" {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    let trimmed = out.trim_end();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n\n")
    }
}

/// Failures seen in a run: `(case, class) -> failing seeds`. Unseeded suites
/// use an empty seed set.
pub type Observed = BTreeMap<(String, String), BTreeSet<u64>>;

/// Cases that ran: `case -> seeds that ran` (`None` for unseeded cases).
pub type Ran = BTreeMap<String, Option<BTreeSet<u64>>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unexpected {
    pub case: String,
    pub class: String,
    /// Seeds not covered by any xfail (empty for unseeded cases).
    pub seeds: BTreeSet<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fixed {
    pub xfail: Xfail,
    pub case: String,
    /// Listed seeds that passed; `None` when the class did not occur at all.
    pub seeds: Option<BTreeSet<u64>>,
}

impl Fixed {
    pub fn message(&self, file: &str) -> String {
        let seeds = match &self.seeds {
            Some(seeds) => format!(" for seeds {}", format_seeds(seeds)),
            None => String::new(),
        };
        format!(
            "{} no longer fails with {}{seeds}: remove this xfail from {file} ({})",
            self.case, self.xfail.class, self.xfail.reason
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    pub unexpected: Vec<Unexpected>,
    pub fixed: Vec<Fixed>,
}

impl Verdict {
    pub fn ok(&self) -> bool {
        self.unexpected.is_empty() && self.fixed.is_empty()
    }
}

fn covered_by<'a>(
    xfails: impl Iterator<Item = &'a Xfail>,
    case: &str,
    class: &str,
    platform: &str,
    seeds: &BTreeSet<u64>,
) -> BTreeSet<u64> {
    let mut covered = BTreeSet::new();
    for x in xfails.filter(|x| x.class == class && x.matches(case, platform)) {
        match &x.seeds {
            None => return seeds.clone(),
            Some(listed) => covered.extend(listed.intersection(seeds).copied()),
        }
    }
    covered
}

/// Compares the failures of a run with the expectations, on `platform`.
pub fn judge(xfails: &[Xfail], platform: &str, ran: &Ran, observed: &Observed) -> Verdict {
    let mut verdict = Verdict::default();
    for ((case, class), seeds) in observed {
        let has_entry = xfails
            .iter()
            .any(|x| x.class == *class && x.matches(case, platform));
        if !has_entry {
            verdict.unexpected.push(Unexpected {
                case: case.clone(),
                class: class.clone(),
                seeds: seeds.clone(),
            });
            continue;
        }
        let covered = covered_by(xfails.iter(), case, class, platform, seeds);
        let uncovered: BTreeSet<u64> = seeds.difference(&covered).copied().collect();
        if !uncovered.is_empty() {
            verdict.unexpected.push(Unexpected {
                case: case.clone(),
                class: class.clone(),
                seeds: uncovered,
            });
        }
    }
    for x in xfails.iter().filter(|x| !x.flaky && x.applies_on(platform)) {
        for (case, ran_seeds) in ran.iter().filter(|(case, _)| glob_match(&x.case, case)) {
            let seen = observed.get(&(case.clone(), x.class.clone()));
            let seeds = match (&x.seeds, seen) {
                (None, None) => None,
                (None, Some(_)) => continue,
                (Some(listed), seen) => {
                    let passed: BTreeSet<u64> = listed
                        .iter()
                        .filter(|seed| ran_seeds.as_ref().is_none_or(|ran| ran.contains(seed)))
                        .filter(|seed| seen.is_none_or(|seen| !seen.contains(seed)))
                        .copied()
                        .collect();
                    if passed.is_empty() {
                        continue;
                    }
                    Some(passed)
                }
            };
            verdict.fixed.push(Fixed {
                xfail: x.clone(),
                case: case.clone(),
                seeds,
            });
        }
    }
    verdict
}

/// Rewrites `xfails` so that this platform's run passes exactly, without
/// touching what other platforms or cases that did not run expect. Reasons
/// and links of replaced entries are kept; new failures get the reason
/// `TODO: <problem>` from `problems`.
pub fn bless(
    xfails: &[Xfail],
    platform: &str,
    ran: &Ran,
    observed: &Observed,
    problems: &BTreeMap<(String, String), String>,
) -> Vec<Xfail> {
    let mut out: Vec<Xfail> = Vec::new();
    let mut kept_here: Vec<Xfail> = Vec::new();
    for x in xfails {
        let matched: Vec<(&String, &Option<BTreeSet<u64>>)> = ran
            .iter()
            .filter(|(case, _)| glob_match(&x.case, case))
            .collect();
        if !x.applies_on(platform) || matched.is_empty() || x.flaky {
            out.push(x.clone());
            if x.applies_on(platform) {
                kept_here.push(x.clone());
            }
            continue;
        }
        let still_exact = matched.iter().all(|(case, ran_seeds)| {
            let seen = observed.get(&((*case).clone(), x.class.clone()));
            match (&x.seeds, seen) {
                (_, None) => false,
                (None, Some(_)) => true,
                (Some(listed), Some(seen)) => listed
                    .iter()
                    .filter(|s| ran_seeds.as_ref().is_none_or(|r| r.contains(s)))
                    .all(|s| seen.contains(s)),
            }
        });
        if still_exact {
            out.push(x.clone());
            kept_here.push(x.clone());
            continue;
        }
        let mut others = x.effective_platforms();
        others.remove(platform);
        if !others.is_empty() {
            out.push(x.with_platforms(others));
        }
        if let Some(listed) = &x.seeds {
            for (case, ran_seeds) in &matched {
                let not_ran: BTreeSet<u64> = listed
                    .iter()
                    .filter(|s| ran_seeds.as_ref().is_some_and(|r| !r.contains(s)))
                    .copied()
                    .collect();
                if !not_ran.is_empty() {
                    let entry = Xfail {
                        case: (*case).clone(),
                        seeds: Some(not_ran),
                        platforms: vec![platform.to_string()],
                        ..x.clone()
                    };
                    out.push(entry.clone());
                    kept_here.push(entry);
                }
            }
        }
    }
    for ((case, class), seeds) in observed {
        let covered = covered_by(kept_here.iter(), case, class, platform, seeds);
        let fully = kept_here
            .iter()
            .any(|x| x.class == *class && x.matches(case, platform) && x.seeds.is_none());
        if fully || (!seeds.is_empty() && covered == *seeds) {
            continue;
        }
        let missing: BTreeSet<u64> = seeds.difference(&covered).copied().collect();
        let previous = xfails
            .iter()
            .find(|x| x.class == *class && glob_match(&x.case, case));
        let entry = Xfail {
            case: case.clone(),
            class: class.clone(),
            platforms: vec![platform.to_string()],
            seeds: (!seeds.is_empty()).then_some(missing),
            flaky: false,
            reason: previous.map_or_else(
                || {
                    format!(
                        "TODO: {}",
                        problems
                            .get(&(case.clone(), class.clone()))
                            .map_or("describe the failure", |p| p.as_str())
                    )
                },
                |x| x.reason.clone(),
            ),
            link: previous.map_or_else(String::new, |x| x.link.clone()),
        };
        out.push(entry);
    }
    coalesce(out)
}

/// Merges entries that differ only in platforms or in seeds of the same
/// case, then sorts them.
fn coalesce(entries: Vec<Xfail>) -> Vec<Xfail> {
    let mut by_seeds: Vec<Xfail> = Vec::new();
    for x in entries {
        if let Some(existing) = by_seeds.iter_mut().find(|e| {
            e.case == x.case
                && e.class == x.class
                && e.flaky == x.flaky
                && e.reason == x.reason
                && e.link == x.link
                && e.platforms == x.platforms
                && e.seeds.is_some()
                && x.seeds.is_some()
        }) {
            if let (Some(a), Some(b)) = (&mut existing.seeds, &x.seeds) {
                a.extend(b.iter().copied());
            }
        } else {
            by_seeds.push(x);
        }
    }
    let mut merged: Vec<Xfail> = Vec::new();
    for x in by_seeds {
        if let Some(existing) = merged.iter_mut().find(|e| {
            e.case == x.case
                && e.class == x.class
                && e.seeds == x.seeds
                && e.flaky == x.flaky
                && e.reason == x.reason
                && e.link == x.link
        }) {
            let mut platforms = existing.effective_platforms();
            platforms.extend(x.effective_platforms());
            *existing = existing.with_platforms(platforms);
        } else {
            merged.push(x);
        }
    }
    merged.sort_by(|a, b| {
        (&a.case, &a.class, a.effective_platforms()).cmp(&(
            &b.case,
            &b.class,
            b.effective_platforms(),
        ))
    });
    merged.dedup();
    merged
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Pass,
    Xfail,
    Fail,
    Xpass,
}

/// One case's result, written as a JSON line to `CAP_VERIFY_REPORT_DIR`.
/// Suites may add fields (for example per-stream mismatch lists); readers
/// ignore what they do not know.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub suite: String,
    /// Expectations file, relative to the repository root.
    pub expectations: String,
    pub case: String,
    pub platform: String,
    #[serde(default)]
    pub tier: String,
    pub outcome: Outcome,
    /// Failure class -> failing seeds (empty for unseeded cases).
    #[serde(default)]
    pub failures: BTreeMap<String, BTreeSet<u64>>,
    /// Seeds that ran, for seeded cases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeds_ran: Option<BTreeSet<u64>>,
    /// First problem per class, used as the draft reason when blessing.
    #[serde(default)]
    pub problems: BTreeMap<String, String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub repro: String,
    #[serde(default)]
    pub seconds: f64,
}

pub fn report_dir() -> Option<PathBuf> {
    std::env::var_os("CAP_VERIFY_REPORT_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

/// Appends records to `<CAP_VERIFY_REPORT_DIR>/<suite>-<pid>.jsonl` (no-op
/// when the variable is unset). Any extra JSON fields in `extra` are merged
/// into each line.
pub fn write_records(records: &[(Record, serde_json::Value)]) {
    let Some(dir) = report_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let Some((first, _)) = records.first() else {
        return;
    };
    let file = dir.join(format!("{}-{}.jsonl", first.suite, std::process::id()));
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    else {
        return;
    };
    for (record, extra) in records {
        let Ok(mut value) = serde_json::to_value(record) else {
            continue;
        };
        if let (Some(map), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                map.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let _ = writeln!(f, "{value}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(seeds: &[u64]) -> BTreeSet<u64> {
        seeds.iter().copied().collect()
    }

    fn entry(case: &str, class: &str, platforms: &[&str], seeds: Option<&[u64]>) -> Xfail {
        Xfail {
            case: case.into(),
            class: class.into(),
            platforms: platforms.iter().map(|p| p.to_string()).collect(),
            seeds: seeds.map(set),
            flaky: false,
            reason: "r".into(),
            link: String::new(),
        }
    }

    #[test]
    fn globs() {
        assert!(glob_match("export/*", "export/basic/mp4"));
        assert!(glob_match("export/*/avf", "export/jitter/avf"));
        assert!(!glob_match("export/*/avf", "export/jitter/ffmpeg"));
        assert!(glob_match("a*b*c", "abc"));
        assert!(!glob_match("a*b*c", "acb"));
        assert!(glob_match("a", "a"));
        assert!(!glob_match("a", "ab"));
    }

    #[test]
    fn shards_partition_cases() {
        let ids: Vec<String> = (0..200).map(|i| format!("export/case-{i}/avf")).collect();
        let mut counts = [0usize; 3];
        for id in &ids {
            let shard = shard_of(id, 3);
            assert!((1..=3).contains(&shard));
            counts[(shard - 1) as usize] += 1;
        }
        assert!(counts.iter().all(|&n| n > 40), "{counts:?}");
        assert_eq!(parse_shard("2/3"), Some((2, 3)));
        assert_eq!(parse_shard("4/3"), None);
        assert_eq!(parse_shard("0/3"), None);
    }

    #[test]
    fn seed_lists_round_trip() {
        let seeds = parse_seeds("0 2 3 5-9 12").unwrap();
        assert_eq!(seeds, set(&[0, 2, 3, 5, 6, 7, 8, 9, 12]));
        assert_eq!(format_seeds(&seeds), "0 2 3 5-9 12");
    }

    #[test]
    fn file_round_trips_and_rejects_typos() {
        let entries = vec![
            entry("a/*", "stale", &["macos"], Some(&[1, 2, 3])),
            Xfail {
                flaky: true,
                reason: "quote \" and \\ ok".into(),
                link: "https://x".into(),
                ..entry("b", "future", &[], None)
            },
        ];
        assert_eq!(parse(&render(&entries)).unwrap(), entries);
        assert!(parse("[[xfail]]\ncase = \"a\"\nclas = \"x\"\nreason = \"r\"\n").is_err());
        assert!(
            parse(
                "[[xfail]]\ncase = \"a\"\nclass = \"x\"\nreason = \"r\"\nplatforms = [\"osx\"]\n"
            )
            .is_err()
        );
    }

    #[test]
    fn strict_in_both_directions_per_seed() {
        let xfails = vec![entry("a", "stale", &[], Some(&[1, 2]))];
        let ran = Ran::from([("a".to_string(), Some(set(&[0, 1, 2, 3])))]);
        let observed = Observed::from([(("a".into(), "stale".into()), set(&[2, 3]))]);
        let verdict = judge(&xfails, "linux", &ran, &observed);
        assert_eq!(verdict.unexpected.len(), 1);
        assert_eq!(verdict.unexpected[0].seeds, set(&[3]));
        assert_eq!(verdict.fixed.len(), 1);
        assert_eq!(verdict.fixed[0].seeds, Some(set(&[1])));
    }

    #[test]
    fn seeds_that_did_not_run_are_not_fixed() {
        let xfails = vec![entry("a", "stale", &[], Some(&[1, 50]))];
        let ran = Ran::from([("a".to_string(), Some(set(&[0, 1, 2])))]);
        let observed = Observed::from([(("a".into(), "stale".into()), set(&[1]))]);
        assert!(judge(&xfails, "linux", &ran, &observed).ok());
    }

    #[test]
    fn unseeded_globs_and_platforms() {
        let xfails = vec![
            entry("export/x/*", "future", &["macos"], None),
            Xfail {
                flaky: true,
                ..entry("seek/y", "stale", &[], None)
            },
        ];
        let ran = Ran::from([
            ("export/x/avf".to_string(), None),
            ("export/x/ffmpeg".to_string(), None),
            ("seek/y".to_string(), None),
        ]);
        let observed = Observed::from([(("export/x/avf".into(), "future".into()), set(&[]))]);
        let verdict = judge(&xfails, "macos", &ran, &observed);
        assert!(verdict.unexpected.is_empty());
        assert_eq!(verdict.fixed.len(), 1);
        assert_eq!(verdict.fixed[0].case, "export/x/ffmpeg");
        let verdict = judge(&xfails, "linux", &ran, &observed);
        assert_eq!(verdict.unexpected.len(), 1);
        assert!(verdict.fixed.is_empty());
    }

    #[test]
    fn bless_only_touches_this_platform() {
        let xfails = vec![
            entry("a", "stale", &[], None),
            entry("b", "future", &[], Some(&[1, 2, 40])),
            entry("c", "stale", &["windows"], None),
        ];
        let ran = Ran::from([
            ("a".to_string(), None),
            ("b".to_string(), Some(set(&[0, 1, 2, 3]))),
            ("c".to_string(), None),
            ("d".to_string(), None),
        ]);
        let observed = Observed::from([
            (("b".into(), "future".into()), set(&[2, 3])),
            (("d".into(), "missing".into()), set(&[])),
        ]);
        let problems =
            BTreeMap::from([(("d".into(), "missing".into()), "3 frames missing".into())]);
        let blessed = bless(&xfails, "macos", &ran, &observed, &problems);
        assert!(
            judge(&blessed, "macos", &ran, &observed).ok(),
            "{blessed:#?}"
        );
        let a: Vec<&Xfail> = blessed.iter().filter(|x| x.case == "a").collect();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].platforms, vec!["linux", "windows"]);
        assert!(blessed.contains(&entry("c", "stale", &["windows"], None)));
        let b_mac: Vec<&Xfail> = blessed
            .iter()
            .filter(|x| x.case == "b" && x.applies_on("macos"))
            .collect();
        assert_eq!(b_mac.len(), 1);
        assert_eq!(b_mac[0].seeds, Some(set(&[2, 3, 40])));
        let d = blessed.iter().find(|x| x.case == "d").unwrap();
        assert_eq!(d.reason, "TODO: 3 frames missing");
        assert_eq!(d.platforms, vec!["macos"]);
        assert_eq!(
            bless(&blessed, "macos", &ran, &observed, &problems),
            blessed,
            "blessing twice changes nothing"
        );
    }

    #[test]
    fn bless_merges_platforms_back() {
        let xfails = vec![entry("a", "stale", &["linux", "windows"], None)];
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "stale".into()), set(&[]))]);
        let blessed = bless(&xfails, "macos", &ran, &observed, &BTreeMap::new());
        assert_eq!(blessed, vec![entry("a", "stale", &[], None)]);
    }
}
