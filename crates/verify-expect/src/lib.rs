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
//! starved = true                        # optional, flaky only: applies only
//!                                       # when the case's starvation sentinel
//!                                       # saw the machine stall
//! bound = { frames = 12, delta = 49 }   # the mechanism's signature: each
//!                                       # metric's measured range must lie in
//!                                       # [min, max] (a number is a max)
//! reason = "what is wrong"
//! link = "https://github.com/CapSoftware/Cap/pull/2595"  # empty = no fix yet
//! ```
//!
//! The verdict is strict both ways. A failure class (or seed) that is not
//! listed fails the run, and a listed, non-flaky class (or seed) that no
//! longer fails also fails the run ("remove this xfail"), so fixes stay
//! locked in.
//!
//! An entry excuses a failure only inside its `bound`: the suite measures
//! each failing class (frames affected, source-frame error, milliseconds of
//! offset, ...), and a failure whose measurement falls outside the bound, or
//! that lacks a bounded metric, is a new failure. A file that starts with
//! `require_bound = true` rejects unseeded entries without a bound.
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

/// The machine class from `CAP_VERIFY_HOST` (see [`Xfail::hosts`]); `local`
/// when unset (a developer machine).
pub fn host() -> Option<String> {
    Some(
        std::env::var("CAP_VERIFY_HOST")
            .ok()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "local".to_string()),
    )
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

/// A closed range of measured values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub min: f64,
    pub max: f64,
}

impl Range {
    pub fn at(value: f64) -> Self {
        Self {
            min: value,
            max: value,
        }
    }

    pub fn include(&mut self, value: f64) {
        self.min = self.min.min(value);
        self.max = self.max.max(value);
    }

    fn render(&self) -> String {
        let number = |v: f64| {
            if v.fract() == 0.0 && v.abs() < 1e15 {
                format!("{}", v as i64)
            } else {
                format!("{v}")
            }
        };
        if self.min == f64::NEG_INFINITY {
            number(self.max)
        } else {
            format!("[{}, {}]", number(self.min), number(self.max))
        }
    }

    fn describe(&self) -> String {
        if self.min == self.max {
            format!("{}", self.min)
        } else {
            format!("{}..{}", self.min, self.max)
        }
    }
}

impl Serialize for Range {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        [self.min, self.max].serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Range {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let [min, max] = <[f64; 2]>::deserialize(deserializer)?;
        Ok(Self { min, max })
    }
}

/// An entry's mechanism bound: metric -> allowed range of its measurement.
pub type Bound = BTreeMap<String, Range>;

/// Measured metrics of one failing class: metric -> observed range.
pub type Metrics = BTreeMap<String, Range>;

/// Checks a class's measurements against a bound. The bound is a complete
/// signature: every bounded metric must have been measured with its whole
/// observed range inside, and a measured metric the bound does not name must
/// be exactly zero (a new symptom in the same class is a new failure).
pub fn within(bound: &Bound, measured: Option<&Metrics>) -> Result<(), String> {
    let mut outside = Vec::new();
    for (metric, range) in measured.into_iter().flatten() {
        if !bound.contains_key(metric) && (range.min != 0.0 || range.max != 0.0) {
            outside.push(format!(
                "{metric} {} measured but not bounded",
                range.describe()
            ));
        }
    }
    for (metric, allowed) in bound {
        match measured.and_then(|m| m.get(metric)) {
            None => outside.push(format!("{metric} not measured")),
            Some(seen) => {
                let eps = 1e-9;
                if seen.min < allowed.min - eps || seen.max > allowed.max + eps {
                    outside.push(format!(
                        "{metric} {} outside {}",
                        seen.describe(),
                        if allowed.min == f64::NEG_INFINITY {
                            format!("<= {}", allowed.max)
                        } else {
                            format!("{}..{}", allowed.min, allowed.max)
                        }
                    ));
                }
            }
        }
    }
    if outside.is_empty() {
        Ok(())
    } else {
        Err(outside.join(", "))
    }
}

/// One strict expected failure.
#[derive(Clone, Debug, PartialEq)]
pub struct Xfail {
    pub case: String,
    pub class: String,
    /// Empty means every platform.
    pub platforms: Vec<String>,
    /// `None` means the class must occur (on any seed, for seeded suites).
    pub seeds: Option<BTreeSet<u64>>,
    pub flaky: bool,
    /// Applies only to cases that ran while the starvation sentinel saw the
    /// machine stall (flaky entries only).
    pub starved: bool,
    /// Machine classes the entry applies to, matched against
    /// `CAP_VERIFY_HOST` (CI sets `github-hosted` or `blacksmith`; `local`
    /// when unset); empty means every host. For a defect only one class of machine reaches
    /// (for example the software encoder path of VMs without a hardware
    /// encoder), with the reason in `reason`.
    pub hosts: Vec<String>,
    /// The documented mechanism's bound (empty = unbounded).
    pub bound: Bound,
    pub reason: String,
    pub link: String,
}

impl Xfail {
    pub fn applies_on(&self, platform: &str) -> bool {
        self.applies_on_host(platform, host().as_deref())
    }

    fn applies_on_host(&self, platform: &str, source_host: Option<&str>) -> bool {
        (self.platforms.is_empty() || self.platforms.iter().any(|p| p == platform))
            && (self.hosts.is_empty()
                || source_host.is_some_and(|h| self.hosts.iter().any(|candidate| candidate == h)))
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
    #[serde(default)]
    starved: bool,
    #[serde(default)]
    hosts: Vec<String>,
    #[serde(default)]
    bound: Option<toml::Table>,
    reason: String,
    #[serde(default)]
    link: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default)]
    require_bound: bool,
    #[serde(default)]
    xfail: Vec<RawXfail>,
}

fn parse_bound(case: &str, table: Option<toml::Table>) -> Result<Bound, String> {
    let mut bound = Bound::new();
    let number = |v: &toml::Value| match v {
        toml::Value::Integer(i) => Some(*i as f64),
        toml::Value::Float(f) => Some(*f),
        _ => None,
    };
    for (metric, value) in table.unwrap_or_default() {
        let range = match &value {
            toml::Value::Array(pair) if pair.len() == 2 => {
                match (number(&pair[0]), number(&pair[1])) {
                    (Some(min), Some(max)) if min <= max => Range { min, max },
                    _ => return Err(format!("xfail {case}: bound {metric} must be [min, max]")),
                }
            }
            v => match number(v) {
                Some(max) => Range {
                    min: f64::NEG_INFINITY,
                    max,
                },
                None => {
                    return Err(format!(
                        "xfail {case}: bound {metric} must be a number or [min, max]"
                    ));
                }
            },
        };
        bound.insert(metric, range);
    }
    Ok(bound)
}

pub fn parse(text: &str) -> Result<Vec<Xfail>, String> {
    let file: RawFile = toml::from_str(text).map_err(|e| e.to_string())?;
    let require_bound = file.require_bound;
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
            let bound = parse_bound(&raw.case, raw.bound)?;
            if require_bound && bound.is_empty() && seeds.is_none() {
                return Err(format!(
                    "xfail {}/{}: a bound is required (the documented mechanism's signature: bound = {{ metric = max }} or [min, max])",
                    raw.case, raw.class
                ));
            }
            if raw.starved && !raw.flaky {
                return Err(format!(
                    "xfail {}/{}: starved entries must be flaky",
                    raw.case, raw.class
                ));
            }
            Ok(Xfail {
                case: raw.case,
                class: raw.class,
                platforms: raw.platforms,
                seeds,
                flaky: raw.flaky,
                starved: raw.starved,
                hosts: raw.hosts,
                bound,
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
        if x.starved {
            out.push_str("starved = true\n");
        }
        if !x.hosts.is_empty() {
            let hosts: Vec<String> = x.hosts.iter().map(|h| quote(h)).collect();
            let _ = writeln!(out, "hosts = [{}]", hosts.join(", "));
        }
        if !x.bound.is_empty() {
            let parts: Vec<String> = x
                .bound
                .iter()
                .map(|(metric, range)| format!("{metric} = {}", range.render()))
                .collect();
            let _ = writeln!(out, "bound = {{ {} }}", parts.join(", "));
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
    /// Why matching entries did not excuse it (outside their bound, or the
    /// machine did not starve); empty when no entry names the class.
    pub why: String,
}

#[derive(Clone, Debug, PartialEq)]
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Verdict {
    pub unexpected: Vec<Unexpected>,
    pub fixed: Vec<Fixed>,
    /// Observed failures each excusing entry accepted: (case, class, entry).
    pub excused: Vec<(String, String, Xfail)>,
}

impl Verdict {
    pub fn ok(&self) -> bool {
        self.unexpected.is_empty() && self.fixed.is_empty()
    }
}

/// Measurements of a run's failing classes: `(case, class) -> metrics`.
pub type Measures = BTreeMap<(String, String), Metrics>;

/// What a run knows beyond pass and fail: classes it could not measure, the
/// measured size of each failure, and the cases that ran while the machine
/// starved (the sentinel's evidence).
#[derive(Clone, Debug, Default)]
pub struct Evidence {
    pub unobserved: Unobserved,
    pub measures: Measures,
    pub starved: BTreeSet<String>,
}

/// Whether `x` excuses `class` on `case`: the case must have starved for a
/// starved entry, and the measurements must lie inside the entry's bound.
fn excuses(x: &Xfail, case: &str, class: &str, evidence: &Evidence) -> Result<(), String> {
    if x.starved && !evidence.starved.contains(case) {
        return Err("applies only under a proven machine stall, and the sentinel saw none".into());
    }
    within(
        &x.bound,
        evidence
            .measures
            .get(&(case.to_string(), class.to_string())),
    )
    .map_err(|e| format!("outside the expected bound ({e})"))
}

fn covered_by<'a>(
    xfails: impl Iterator<Item = &'a Xfail>,
    case: &str,
    class: &str,
    platform: &str,
    source_host: Option<&str>,
    seeds: &BTreeSet<u64>,
    evidence: &Evidence,
) -> BTreeSet<u64> {
    let mut covered = BTreeSet::new();
    for x in xfails.filter(|x| {
        x.class == class
            && x.applies_on_host(platform, source_host)
            && glob_match(&x.case, case)
            && excuses(x, case, class, evidence).is_ok()
    }) {
        match &x.seeds {
            None => return seeds.clone(),
            Some(listed) => covered.extend(listed.intersection(seeds).copied()),
        }
    }
    covered
}

/// Classes a case could not measure because an earlier check failed (for
/// example A/V sync when no audio marker could be identified): `(case,
/// class)`. An unobserved class is neither a failure nor a pass, so an xfail
/// for it is not reported as fixed and `bless` leaves it alone. The failure
/// that made it unobservable is judged on its own.
pub type Unobserved = BTreeSet<(String, String)>;

/// Compares the failures of a run with the expectations, on `platform`.
pub fn judge(xfails: &[Xfail], platform: &str, ran: &Ran, observed: &Observed) -> Verdict {
    judge_with(xfails, platform, ran, observed, &Evidence::default())
}

/// [`judge`] for runs where some classes could not be measured.
pub fn judge_observing(
    xfails: &[Xfail],
    platform: &str,
    ran: &Ran,
    observed: &Observed,
    unobserved: &Unobserved,
) -> Verdict {
    let evidence = Evidence {
        unobserved: unobserved.clone(),
        ..Default::default()
    };
    judge_with(xfails, platform, ran, observed, &evidence)
}

/// [`judge`] with measurements, unmeasurable classes and starvation
/// evidence: an entry excuses a failure only inside its bound.
pub fn judge_with(
    xfails: &[Xfail],
    platform: &str,
    ran: &Ran,
    observed: &Observed,
    evidence: &Evidence,
) -> Verdict {
    let mut verdict = Verdict::default();
    for ((case, class), seeds) in observed {
        let named: Vec<&Xfail> = xfails
            .iter()
            .filter(|x| x.class == *class && x.matches(case, platform))
            .collect();
        if named.is_empty() {
            verdict.unexpected.push(Unexpected {
                case: case.clone(),
                class: class.clone(),
                seeds: seeds.clone(),
                why: String::new(),
            });
            continue;
        }
        let covered = covered_by(
            named.iter().copied(),
            case,
            class,
            platform,
            host().as_deref(),
            seeds,
            evidence,
        );
        let excused_fully = seeds.is_empty()
            && named
                .iter()
                .any(|x| x.seeds.is_none() && excuses(x, case, class, evidence).is_ok());
        let uncovered: BTreeSet<u64> = seeds.difference(&covered).copied().collect();
        if !excused_fully && (seeds.is_empty() || !uncovered.is_empty()) {
            let why: Vec<String> = named
                .iter()
                .filter_map(|x| excuses(x, case, class, evidence).err())
                .collect();
            verdict.unexpected.push(Unexpected {
                case: case.clone(),
                class: class.clone(),
                seeds: uncovered,
                why: why.join("; "),
            });
            continue;
        }
        if let Some(x) = named
            .iter()
            .find(|x| excuses(x, case, class, evidence).is_ok())
        {
            verdict
                .excused
                .push((case.clone(), class.clone(), (*x).clone()));
        }
    }
    for x in xfails.iter().filter(|x| !x.flaky && x.applies_on(platform)) {
        for (case, ran_seeds) in ran.iter().filter(|(case, _)| glob_match(&x.case, case)) {
            if evidence
                .unobserved
                .contains(&(case.clone(), x.class.clone()))
            {
                continue;
            }
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

/// Proposes changes for this platform and host without narrowing entries
/// for unobserved hosts, platforms or cases. Links of replaced entries
/// are kept; new proposals get the reason
/// `TODO: <problem>` from `problems`.
pub fn bless(
    xfails: &[Xfail],
    platform: &str,
    ran: &Ran,
    observed: &Observed,
    problems: &BTreeMap<(String, String), String>,
) -> Vec<Xfail> {
    bless_observing(
        xfails,
        platform,
        ran,
        observed,
        &Unobserved::new(),
        problems,
    )
}

/// [`bless`] that keeps entries whose class some matching case could not
/// measure in this run.
pub fn bless_observing(
    xfails: &[Xfail],
    platform: &str,
    ran: &Ran,
    observed: &Observed,
    unobserved: &Unobserved,
    problems: &BTreeMap<(String, String), String>,
) -> Vec<Xfail> {
    let evidence = Evidence {
        unobserved: unobserved.clone(),
        ..Default::default()
    };
    bless_with(
        xfails,
        platform,
        host().as_deref(),
        ran,
        observed,
        &evidence,
        problems,
    )
}

/// [`bless`] with measurements: a failure outside every entry's bound gets a
/// new entry (TODO reason) whose bound is the measured range, to be
/// reviewed against the mechanism. Unknown-host observations cannot remove
/// entries. All-host entries are retained because finite host observations
/// cannot establish their behavior on every possible host.
pub fn bless_with(
    xfails: &[Xfail],
    platform: &str,
    source_host: Option<&str>,
    ran: &Ran,
    observed: &Observed,
    evidence: &Evidence,
    problems: &BTreeMap<(String, String), String>,
) -> Vec<Xfail> {
    let unobserved = &evidence.unobserved;
    let mut out: Vec<Xfail> = Vec::new();
    let mut kept_here: Vec<Xfail> = Vec::new();
    for x in xfails {
        let matched: Vec<(&String, &Option<BTreeSet<u64>>)> = ran
            .iter()
            .filter(|(case, _)| glob_match(&x.case, case))
            .collect();
        let unmeasured = matched
            .iter()
            .any(|(case, _)| unobserved.contains(&((*case).clone(), x.class.clone())));
        if source_host.is_none()
            || x.hosts.is_empty()
            || !x.applies_on_host(platform, source_host)
            || matched.is_empty()
            || x.flaky
            || unmeasured
        {
            out.push(x.clone());
            if x.applies_on_host(platform, source_host) {
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
        let other_hosts: Vec<String> = x
            .hosts
            .iter()
            .filter(|h| Some(h.as_str()) != source_host)
            .cloned()
            .collect();
        if !other_hosts.is_empty() {
            out.push(Xfail {
                platforms: vec![platform.to_string()],
                hosts: other_hosts,
                ..x.clone()
            });
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
                        hosts: source_host.into_iter().map(str::to_string).collect(),
                        ..x.clone()
                    };
                    out.push(entry.clone());
                    kept_here.push(entry);
                }
            }
        }
    }
    for ((case, class), seeds) in observed {
        let covered = covered_by(
            kept_here.iter(),
            case,
            class,
            platform,
            source_host,
            seeds,
            evidence,
        );
        let fully = kept_here.iter().any(|x| {
            x.class == *class
                && x.applies_on_host(platform, source_host)
                && glob_match(&x.case, case)
                && x.seeds.is_none()
                && excuses(x, case, class, evidence).is_ok()
        });
        if fully || (!seeds.is_empty() && covered == *seeds) {
            continue;
        }
        let missing: BTreeSet<u64> = seeds.difference(&covered).copied().collect();
        let previous = xfails.iter().find(|x| {
            x.class == *class
                && x.applies_on_host(platform, source_host)
                && glob_match(&x.case, case)
        });
        let entry = Xfail {
            case: case.clone(),
            class: class.clone(),
            platforms: vec![platform.to_string()],
            seeds: (!seeds.is_empty()).then_some(missing),
            flaky: false,
            starved: false,
            hosts: source_host.into_iter().map(str::to_string).collect(),
            bound: if seeds.is_empty() {
                evidence
                    .measures
                    .get(&(case.clone(), class.clone()))
                    .cloned()
                    .unwrap_or_default()
            } else {
                Bound::new()
            },
            reason: format!(
                "TODO: {}",
                problems
                    .get(&(case.clone(), class.clone()))
                    .map_or("describe the failure", |p| p.as_str())
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
                && e.starved == x.starved
                && e.hosts == x.hosts
                && e.bound == x.bound
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
                && e.starved == x.starved
                && e.hosts == x.hosts
                && e.bound == x.bound
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
    Unsupported,
    /// A wall-clock class failed while the machine starved the process
    /// (cap-verify's sentinel); the test is retried once. Never blessed.
    Inconclusive,
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
    /// Classes this case could not measure -> why (see [`Unobserved`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unobserved: BTreeMap<String, String>,
    /// First problem per class, used as the draft reason when blessing.
    #[serde(default)]
    pub problems: BTreeMap<String, String>,
    /// Measured size of each failing class (see [`within`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub measures: BTreeMap<String, Metrics>,
    /// Failing classes an expectation excused -> "strict", "flaky" or
    /// "flaky, starved".
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub excused: BTreeMap<String, String>,
    /// The case ran while the starvation sentinel saw the machine stall.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub starved: bool,
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
    write_records_to(&dir, records);
}

fn write_records_to(dir: &Path, records: &[(Record, serde_json::Value)]) {
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITER.lock().expect("report writer lock");
    std::fs::create_dir_all(dir).expect("create report directory");
    let Some((first, _)) = records.first() else {
        return;
    };
    let file = dir.join(format!("{}-{}.jsonl", first.suite, std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .expect("open report file");
    for (record, extra) in records {
        let mut value = serde_json::to_value(record).expect("serialize report record");
        value["host"] = serde_json::to_value(host()).expect("serialize report host");
        if let (Some(map), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                map.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let line = format!("{value}\n");
        file.write_all(line.as_bytes())
            .expect("write report record");
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
            starved: false,
            hosts: host().into_iter().collect(),
            bound: Bound::new(),
            reason: "r".into(),
            link: String::new(),
        }
    }

    #[test]
    fn concurrent_reports_remain_complete_json_lines() {
        let dir = std::env::temp_dir().join(format!(
            "cap-verify-reports-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::thread::scope(|scope| {
            for writer in 0..8 {
                let dir = &dir;
                scope.spawn(move || {
                    for index in 0..50 {
                        let record = Record {
                            suite: "concurrent".into(),
                            expectations: "expectations.toml".into(),
                            case: format!("{writer}/{index}"),
                            platform: "windows".into(),
                            tier: "fast".into(),
                            outcome: Outcome::Unsupported,
                            failures: BTreeMap::new(),
                            seeds_ran: None,
                            unobserved: BTreeMap::new(),
                            problems: BTreeMap::new(),
                            measures: BTreeMap::new(),
                            excused: BTreeMap::new(),
                            starved: false,
                            summary: "test record".repeat(100),
                            repro: String::new(),
                            seconds: 0.0,
                        };
                        write_records_to(
                            dir,
                            &[(
                                record,
                                serde_json::json!({"writer": writer, "host": "incorrect"}),
                            )],
                        );
                    }
                });
            }
        });
        let file = dir.join(format!("concurrent-{}.jsonl", std::process::id()));
        let text = std::fs::read_to_string(file).unwrap();
        let cases: BTreeSet<String> = text
            .lines()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(value["host"], serde_json::json!(host()));
                let record: Record = serde_json::from_str(line).unwrap();
                assert_eq!(record.outcome, Outcome::Unsupported);
                record.case
            })
            .collect();
        assert_eq!(text.lines().count(), 400);
        assert_eq!(cases.len(), 400);
        std::fs::remove_dir_all(dir).unwrap();
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
    fn unobserved_classes_are_neither_fixed_nor_blessed_away() {
        let xfails = vec![
            entry("a", "sync", &[], None),
            entry("a", "audio", &[], None),
        ];
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "audio".into()), set(&[]))]);
        let unobserved = Unobserved::from([("a".to_string(), "sync".to_string())]);
        assert!(judge_observing(&xfails, "linux", &ran, &observed, &unobserved).ok());
        let measured = judge(&xfails, "linux", &ran, &observed);
        assert_eq!(measured.fixed.len(), 1);
        assert_eq!(measured.fixed[0].xfail.class, "sync");
        let blessed = bless_observing(
            &xfails,
            "linux",
            &ran,
            &observed,
            &unobserved,
            &BTreeMap::new(),
        );
        assert_eq!(blessed, coalesce(xfails.clone()));
        let unexpected = Observed::from([(("a".into(), "audio".into()), set(&[]))]);
        let verdict = judge_observing(&[], "linux", &ran, &unexpected, &unobserved);
        assert_eq!(
            verdict.unexpected.len(),
            1,
            "the prerequisite failure still fails"
        );
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
        assert_eq!(b_mac.len(), 2);
        assert!(
            b_mac
                .iter()
                .any(|x| x.seeds == Some(set(&[40])) && x.reason == "r")
        );
        assert!(b_mac.iter().any(|x| {
            x.seeds == Some(set(&[2, 3])) && x.reason == "TODO: describe the failure"
        }));
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
    fn bless_requires_an_explanation_on_a_new_platform() {
        let xfails = vec![entry("a", "stale", &["linux", "windows"], None)];
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "stale".into()), set(&[]))]);
        let blessed = bless(&xfails, "macos", &ran, &observed, &BTreeMap::new());
        let mut proposed = entry("a", "stale", &["macos"], None);
        proposed.reason = "TODO: describe the failure".into();
        assert_eq!(blessed, vec![xfails[0].clone(), proposed]);
    }

    #[test]
    fn bless_preserves_unobserved_host_and_platform_slices() {
        let xfail = Xfail {
            hosts: vec!["github-hosted".into(), "local".into()],
            ..entry("a", "stale", &["macos", "windows"], None)
        };
        let ran = Ran::from([("a".into(), None)]);
        let blessed = bless_with(
            &[xfail.clone()],
            "macos",
            Some("local"),
            &ran,
            &Observed::new(),
            &Evidence::default(),
            &BTreeMap::new(),
        );
        assert_eq!(blessed.len(), 2);
        assert!(
            blessed
                .iter()
                .any(|x| x.platforms == ["windows"] && x.hosts == xfail.hosts)
        );
        assert!(
            blessed
                .iter()
                .any(|x| x.platforms == ["macos"] && x.hosts == ["github-hosted"])
        );
        assert!(
            !blessed
                .iter()
                .any(|x| x.applies_on_host("macos", Some("local")))
        );

        let untested = bless_with(
            &[xfail.clone()],
            "macos",
            Some("blacksmith"),
            &ran,
            &Observed::new(),
            &Evidence::default(),
            &BTreeMap::new(),
        );
        assert_eq!(untested, vec![xfail]);
    }

    #[test]
    fn bless_unknown_hosts_cannot_remove_or_narrow_entries() {
        let xfails = vec![
            entry("a", "stale", &["macos"], Some(&[1, 2])),
            Xfail {
                hosts: Vec::new(),
                ..entry("b", "stale", &["macos"], None)
            },
        ];
        let ran = Ran::from([("a".into(), Some(set(&[1, 2]))), ("b".into(), None)]);
        for observed in [
            Observed::new(),
            Observed::from([(("a".into(), "stale".into()), set(&[1]))]),
        ] {
            let blessed = bless_with(
                &xfails,
                "macos",
                None,
                &ran,
                &observed,
                &Evidence::default(),
                &BTreeMap::new(),
            );
            for entry in &xfails {
                assert!(blessed.contains(entry));
            }
        }
        let blessed = bless_with(
            &xfails[1..],
            "macos",
            Some("blacksmith"),
            &ran,
            &Observed::new(),
            &Evidence::default(),
            &BTreeMap::new(),
        );
        assert_eq!(blessed, xfails[1..]);
    }

    fn measured(case: &str, class: &str, metrics: &[(&str, f64, f64)]) -> Evidence {
        let mut evidence = Evidence::default();
        evidence.measures.insert(
            (case.into(), class.into()),
            metrics
                .iter()
                .map(|&(m, min, max)| (m.to_string(), Range { min, max }))
                .collect(),
        );
        evidence
    }

    #[test]
    fn bounds_limit_what_an_entry_excuses() {
        let text = "require_bound = true\n[[xfail]]\ncase = \"a\"\nclass = \"stale\"\nbound = { frames = 12, ms = [-210, -190] }\nreason = \"r\"\n";
        let xfails = parse(text).unwrap();
        assert_eq!(xfails[0].bound["frames"].max, 12.0);
        assert_eq!(xfails[0].bound["ms"].min, -210.0);
        assert_eq!(parse(&render(&xfails)).unwrap(), xfails);
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "stale".into()), set(&[]))]);
        let inside = measured(
            "a",
            "stale",
            &[("frames", 3.0, 12.0), ("ms", -205.0, -195.0)],
        );
        let verdict = judge_with(&xfails, "linux", &ran, &observed, &inside);
        assert!(verdict.ok(), "{verdict:?}");
        assert_eq!(verdict.excused.len(), 1);
        let more = measured(
            "a",
            "stale",
            &[("frames", 13.0, 13.0), ("ms", -200.0, -200.0)],
        );
        let verdict = judge_with(&xfails, "linux", &ran, &observed, &more);
        assert_eq!(verdict.unexpected.len(), 1);
        assert!(
            verdict.unexpected[0].why.contains("frames 13"),
            "{verdict:?}"
        );
        let early = measured(
            "a",
            "stale",
            &[("frames", 1.0, 1.0), ("ms", -300.0, -200.0)],
        );
        assert_eq!(
            judge_with(&xfails, "linux", &ran, &observed, &early)
                .unexpected
                .len(),
            1
        );
        let extra = measured(
            "a",
            "stale",
            &[
                ("frames", 1.0, 1.0),
                ("ms", -200.0, -200.0),
                ("camera-frames", 2.0, 2.0),
            ],
        );
        let verdict = judge_with(&xfails, "linux", &ran, &observed, &extra);
        assert!(
            verdict.unexpected[0].why.contains("camera-frames 2"),
            "{verdict:?}"
        );
        let zero = measured(
            "a",
            "stale",
            &[
                ("frames", 1.0, 1.0),
                ("ms", -200.0, -200.0),
                ("camera-frames", 0.0, 0.0),
            ],
        );
        assert!(judge_with(&xfails, "linux", &ran, &observed, &zero).ok());
        let unmeasured = measured("a", "stale", &[("frames", 1.0, 1.0)]);
        let verdict = judge_with(&xfails, "linux", &ran, &observed, &unmeasured);
        assert!(verdict.unexpected[0].why.contains("ms not measured"));
        assert_eq!(
            judge(&xfails, "linux", &ran, &observed).unexpected.len(),
            1,
            "a bounded entry never excuses an unmeasured failure"
        );
        assert!(
            parse("require_bound = true\n[[xfail]]\ncase = \"a\"\nclass = \"x\"\nreason = \"r\"\n")
                .is_err()
        );
        assert!(
            parse("require_bound = true\n[[xfail]]\ncase = \"a\"\nclass = \"x\"\nseeds = \"1\"\nreason = \"r\"\n").is_ok(),
            "seeded entries are bounded by their seeds"
        );
    }

    #[test]
    fn starved_entries_need_the_sentinel() {
        let text = "[[xfail]]\ncase = \"a\"\nclass = \"error\"\nflaky = true\nstarved = true\nbound = { count = 1 }\nreason = \"r\"\n";
        let xfails = parse(text).unwrap();
        assert!(parse(&text.replace("flaky = true\n", "")).is_err());
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "error".into()), set(&[]))]);
        let mut evidence = measured("a", "error", &[("count", 1.0, 1.0)]);
        assert_eq!(
            judge_with(&xfails, "linux", &ran, &observed, &evidence)
                .unexpected
                .len(),
            1
        );
        evidence.starved.insert("a".into());
        assert!(judge_with(&xfails, "linux", &ran, &observed, &evidence).ok());
        assert!(judge_with(&xfails, "linux", &ran, &Observed::new(), &evidence).ok());
    }

    #[test]
    fn bless_bounds_new_entries_by_their_measurements() {
        let ran = Ran::from([("a".to_string(), None)]);
        let observed = Observed::from([(("a".into(), "sync".into()), set(&[]))]);
        let evidence = measured("a", "sync", &[("ms", -201.0, -199.0)]);
        let blessed = bless_with(
            &[],
            "macos",
            host().as_deref(),
            &ran,
            &observed,
            &evidence,
            &BTreeMap::new(),
        );
        assert_eq!(blessed.len(), 1);
        assert_eq!(
            blessed[0].bound["ms"],
            Range {
                min: -201.0,
                max: -199.0
            }
        );
        assert!(judge_with(&blessed, "macos", &ran, &observed, &evidence).ok());
    }
}
