//! Child-process isolation for chaos probes.
//!
//! The parent test re-runs its own binary as a child per probe (and per batch
//! of fuzz seeds), so an abort, a fatal signal, an Objective-C exception or a
//! hang ends the child, never the harness. The child logs one line per event
//! to an append-only file that survives any death: `start`, every `panic` on
//! any thread (through the panic hook), and the probe's `verdict`.

use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use cap_verify::report::{self, Case, Tier};

pub const CHILD_ENV: &str = "CAP_VERIFY_CHAOS_CHILD";
const LOG_ENV: &str = "CAP_VERIFY_CHAOS_LOG";
const SCRATCH_ENV: &str = "CAP_VERIFY_CHAOS_SCRATCH";
const SEEDS_ENV: &str = "CAP_VERIFY_CHAOS_SEEDS";
/// Restricts a fuzz case to one seed (the repro of a seeded failure).
pub const SEED_ENV: &str = "CAP_VERIFY_CHAOS_SEED";
/// Comma-separated mutation indices a fuzz seed applies (shrinking).
pub const KEEP_ENV: &str = "CAP_VERIFY_CHAOS_KEEP";

/// What an engine did with a hostile input.
pub enum Verdict {
    /// It succeeded and the output passed the probe's checks.
    Ok(String),
    /// It refused the input with an error: the resilient outcome.
    Rejected(String),
    /// It reported success but the output is wrong (empty, unreadable, ...).
    Wrong(String),
}

impl Verdict {
    pub fn rejected(error: impl std::fmt::Display) -> Self {
        Verdict::Rejected(one_line(&error.to_string()))
    }
}

pub struct Ctx {
    pub scratch: PathBuf,
    pub seed: u64,
    /// Mutations a fuzz seed keeps (all when `None`).
    pub keep: Option<Vec<usize>>,
}

impl Ctx {
    pub fn path(&self, name: &str) -> PathBuf {
        self.scratch.join(name)
    }

    /// Runs `future` on a fresh multi-threaded runtime like the app's tokio
    /// pool. Leftover tasks are abandoned after a short grace period so a
    /// stuck background task shows up as the probe's own hang only when the
    /// probe awaits it.
    pub fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        let rt = crate::common::runtime();
        let out = rt.block_on(future);
        rt.shutdown_timeout(Duration::from_secs(2));
        out
    }

    pub fn keeps(&self, index: usize) -> bool {
        self.keep.as_ref().is_none_or(|keep| keep.contains(&index))
    }
}

pub type ProbeFn = Arc<dyn Fn(&Ctx) -> anyhow::Result<Verdict> + Send + Sync>;

#[derive(Clone)]
pub struct Probe {
    pub id: String,
    pub full_only: bool,
    pub timeout: Duration,
    /// Fuzz targets: seeds per tier (fast, full). `None` runs once.
    pub seeds: Option<(u64, u64)>,
    pub run: ProbeFn,
}

impl Probe {
    pub fn new(
        id: impl Into<String>,
        timeout_secs: u64,
        run: impl Fn(&Ctx) -> anyhow::Result<Verdict> + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            full_only: false,
            timeout: Duration::from_secs(timeout_secs),
            seeds: None,
            run: Arc::new(run),
        }
    }

    pub fn full(mut self) -> Self {
        self.full_only = true;
        self
    }

    pub fn seeded(mut self, fast: u64, full: u64) -> Self {
        self.seeds = Some((fast, full));
        self
    }
}

pub fn one_line(text: &str) -> String {
    let mut out: String = text
        .chars()
        .map(|c| {
            if c == '\n' || c == '\t' || c == '\r' {
                ' '
            } else {
                c
            }
        })
        .collect();
    if out.len() > 600 {
        let mut cut = 600;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("...");
    }
    out
}

static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
static CURRENT_SEED: AtomicU64 = AtomicU64::new(0);

fn log_line(fields: &[&str]) {
    if let Some(file) = LOG.get() {
        let line = format!("{}\n", fields.join("\t"));
        let mut file = file.lock().unwrap_or_else(|e| e.into_inner());
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        log_line(&[
            "panic",
            &CURRENT_SEED.load(Ordering::SeqCst).to_string(),
            thread.name().unwrap_or("unnamed"),
            &location,
            &one_line(&message),
        ]);
        default(info);
    }));
}

/// The child side: runs only when `CAP_VERIFY_CHAOS_CHILD` names a probe.
pub fn child_main(all: fn() -> Vec<Probe>) {
    let Ok(id) = std::env::var(CHILD_ENV) else {
        return;
    };
    crate::common::init();
    let log = std::env::var(LOG_ENV).expect("chaos child log path");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .expect("chaos child log");
    let _ = LOG.set(Mutex::new(file));
    install_panic_hook();
    let probe = all()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("no chaos probe {id}"));
    let scratch = PathBuf::from(std::env::var(SCRATCH_ENV).expect("chaos scratch"));
    let (first, end) = std::env::var(SEEDS_ENV)
        .ok()
        .and_then(|s| {
            let (a, b) = s.split_once("..")?;
            Some((a.parse().ok()?, b.parse().ok()?))
        })
        .unwrap_or((0u64, 1u64));
    let keep = std::env::var(KEEP_ENV).ok().map(|s| {
        s.split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect::<Vec<usize>>()
    });
    for seed in first..end {
        CURRENT_SEED.store(seed, Ordering::SeqCst);
        log_line(&["start", &seed.to_string()]);
        let dir = scratch.join(format!("s{seed}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("chaos seed scratch");
        let ctx = Ctx {
            scratch: dir.clone(),
            seed,
            keep: keep.clone(),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (probe.run)(&ctx)));
        let (kind, text) = match result {
            Ok(Ok(Verdict::Ok(text))) => ("ok", text),
            Ok(Ok(Verdict::Rejected(text))) => ("rejected", text),
            Ok(Ok(Verdict::Wrong(text))) => ("wrong", text),
            Ok(Err(error)) => ("harness", format!("{error:#}")),
            Err(_) => ("panicked", String::new()),
        };
        log_line(&["verdict", &seed.to_string(), kind, &one_line(&text)]);
        if !keep_scratch() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    log_line(&["end"]);
    // Leftover engine threads must not keep the child alive (or run
    // destructors racing a finished probe).
    std::process::exit(0);
}

/// One seed's outcome as the parent saw it.
#[derive(Clone, Debug)]
pub struct SeedOutcome {
    pub seed: u64,
    /// `pass`, `panic`, `abort`, `objc-exception`, `hang`, `wrong-success`
    /// or `harness`.
    pub class: &'static str,
    pub detail: String,
}

#[derive(Default)]
struct ChildLog {
    started: Vec<u64>,
    panics: BTreeMap<u64, Vec<String>>,
    verdicts: BTreeMap<u64, (String, String)>,
    ended: bool,
}

fn read_log(path: &Path) -> ChildLog {
    let mut log = ChildLog::default();
    let Ok(text) = std::fs::read_to_string(path) else {
        return log;
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["start", seed] => {
                if let Ok(seed) = seed.parse() {
                    log.started.push(seed);
                }
            }
            ["panic", seed, thread, location, message] => {
                if let Ok(seed) = seed.parse() {
                    log.panics.entry(seed).or_default().push(format!(
                        "thread '{thread}' panicked at {location}: {message}"
                    ));
                }
            }
            ["verdict", seed, kind, text] => {
                if let Ok(seed) = seed.parse() {
                    log.verdicts
                        .insert(seed, (kind.to_string(), text.to_string()));
                }
            }
            ["end"] => log.ended = true,
            _ => {}
        }
    }
    log
}

fn stderr_tail(path: &Path) -> String {
    let text = std::fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    let lines: Vec<&str> = text.lines().collect();
    let tail = &lines[lines.len().saturating_sub(12)..];
    one_line(&tail.join(" | "))
}

fn objc_exception(path: &Path) -> Option<String> {
    let text = std::fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    text.lines()
        .find(|l| {
            l.contains("uncaught exception")
                || l.contains("NSException")
                || l.contains("NSInvalidArgumentException")
                || l.contains("NSRangeException")
                || l.contains("NSInternalInconsistencyException")
        })
        .map(one_line)
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

fn signal_name(signal: i32) -> String {
    match signal {
        4 => "SIGILL".into(),
        5 => "SIGTRAP".into(),
        6 => "SIGABRT".into(),
        7 if cfg!(target_os = "linux") => "SIGBUS".into(),
        8 => "SIGFPE".into(),
        9 => "SIGKILL".into(),
        10 if cfg!(target_os = "macos") => "SIGBUS".into(),
        11 => "SIGSEGV".into(),
        other => format!("signal {other}"),
    }
}

pub fn scratch_root() -> PathBuf {
    std::env::var_os("CAP_VERIFY_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("cap-verify-chaos")
}

fn case_dir(id: &str) -> PathBuf {
    scratch_root().join(id.replace('/', "_"))
}

/// Runs seeds `first..end` of `probe` in children, one child per batch: a
/// child that dies or hangs is replaced, starting after the seed it was on.
pub fn run_seeds(probe: &Probe, first: u64, end: u64, keep: Option<&str>) -> Vec<SeedOutcome> {
    let dir = case_dir(&probe.id);
    let _ = std::fs::remove_dir_all(&dir);
    let mut outcomes = Vec::new();
    let mut next = first;
    let mut attempt = 0;
    while next < end {
        attempt += 1;
        let log = dir.join(format!("log-{attempt}.tsv"));
        let stderr = dir.join(format!("stderr-{attempt}.txt"));
        let scratch = dir.join("work");
        if let Err(e) = std::fs::create_dir_all(&scratch) {
            outcomes.push(SeedOutcome {
                seed: next,
                class: "harness",
                detail: format!("scratch: {e}"),
            });
            break;
        }
        let spawned = (|| -> anyhow::Result<std::process::Child> {
            let mut command = Command::new(std::env::current_exe()?);
            command
                .args(["chaos_child", "--exact", "--nocapture", "--test-threads=1"])
                .env(CHILD_ENV, &probe.id)
                .env(LOG_ENV, &log)
                .env(SCRATCH_ENV, &scratch)
                .env(SEEDS_ENV, format!("{next}..{end}"))
                .env("RUST_BACKTRACE", "0")
                .stdout(Stdio::null())
                .stderr(std::fs::File::create(&stderr)?);
            if let Some(keep) = keep {
                command.env(KEEP_ENV, keep);
            }
            if let Ok(muxer) = cap_recording::oop_muxer::resolve_muxer_binary() {
                command.env(cap_recording::oop_muxer::ENV_BIN_PATH, muxer);
            }
            Ok(command.spawn()?)
        })();
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                outcomes.push(SeedOutcome {
                    seed: next,
                    class: "harness",
                    detail: format!("spawn: {e:#}"),
                });
                break;
            }
        };
        let mut current = next;
        let mut seed_started = Instant::now();
        let status = loop {
            if let Ok(Some(status)) = child.try_wait() {
                break Some(status);
            }
            let log = read_log(&log);
            let latest = log.started.last().copied().unwrap_or(next);
            if latest != current {
                current = latest;
                seed_started = Instant::now();
            }
            let finished = log.verdicts.contains_key(&current);
            if !finished && seed_started.elapsed() > probe.timeout {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let parsed = read_log(&log);
        for (&seed, (kind, text)) in &parsed.verdicts {
            let panics = parsed.panics.get(&seed).cloned().unwrap_or_default();
            outcomes.push(if !panics.is_empty() {
                SeedOutcome {
                    seed,
                    class: "panic",
                    detail: panics.join(" || "),
                }
            } else {
                match kind.as_str() {
                    "ok" | "rejected" => SeedOutcome {
                        seed,
                        class: "pass",
                        detail: format!("{kind}: {text}"),
                    },
                    "wrong" => SeedOutcome {
                        seed,
                        class: "wrong-success",
                        detail: text.clone(),
                    },
                    _ => SeedOutcome {
                        seed,
                        class: "harness",
                        detail: format!("{kind}: {text}"),
                    },
                }
            });
        }
        let unfinished = parsed
            .started
            .iter()
            .copied()
            .find(|seed| !parsed.verdicts.contains_key(seed));
        match (status, unfinished) {
            (None, seed) => {
                let seed = seed.unwrap_or(current);
                let mut detail = format!(
                    "no verdict after {:.0} s (killed)",
                    probe.timeout.as_secs_f64()
                );
                if let Some(panics) = parsed.panics.get(&seed) {
                    detail.push_str(&format!("; after {}", panics.join(" || ")));
                }
                outcomes.push(SeedOutcome {
                    seed,
                    class: "hang",
                    detail,
                });
                next = seed + 1;
            }
            (Some(status), Some(seed)) => {
                let tail = stderr_tail(&stderr);
                let panics = parsed.panics.get(&seed).cloned().unwrap_or_default();
                let (class, what) = if let Some(line) = objc_exception(&stderr) {
                    ("objc-exception", line)
                } else if let Some(signal) = signal_of(&status) {
                    ("abort", signal_name(signal))
                } else if !panics.is_empty() {
                    ("panic", format!("exit {status}"))
                } else {
                    ("abort", format!("exit {status}"))
                };
                let mut detail = what;
                if !panics.is_empty() {
                    detail.push_str(&format!("; {}", panics.join(" || ")));
                }
                detail.push_str(&format!("; stderr: {tail}"));
                outcomes.push(SeedOutcome {
                    seed,
                    class,
                    detail,
                });
                next = seed + 1;
            }
            (Some(status), None) => {
                if !parsed.ended || !status.success() {
                    let last = parsed.verdicts.keys().last().copied();
                    let after = last.map_or(next, |s| s + 1);
                    if after >= end {
                        // Every seed has its verdict; the child died on its
                        // way out (an engine thread outliving the probe).
                        let seed = last.unwrap_or(next);
                        let panics = parsed.panics.get(&seed).cloned().unwrap_or_default();
                        if !status.success() {
                            outcomes.push(SeedOutcome {
                                seed,
                                class: if signal_of(&status).is_some() {
                                    "abort"
                                } else {
                                    "panic"
                                },
                                detail: format!(
                                    "child exited {status} after its last verdict; {}; stderr: {}",
                                    panics.join(" || "),
                                    stderr_tail(&stderr)
                                ),
                            });
                        }
                        break;
                    }
                    if parsed.started.is_empty() && attempt > 2 {
                        outcomes.push(SeedOutcome {
                            seed: next,
                            class: "harness",
                            detail: format!(
                                "child exited {status} before its first seed; stderr: {}",
                                stderr_tail(&stderr)
                            ),
                        });
                        break;
                    }
                    next = after;
                } else {
                    break;
                }
            }
        }
    }
    if !keep_scratch() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    outcomes
}

/// Removes mutations from a failing seed while it still fails the same way:
/// one pass, each index dropped once. Returns the indices kept.
fn shrink(probe: &Probe, seed: u64, class: &str, mutations: usize) -> Option<Vec<usize>> {
    if mutations <= 1 || mutations > 24 {
        return None;
    }
    let mut kept: Vec<usize> = (0..mutations).collect();
    let mut index = 0;
    while index < kept.len() {
        let mut trial = kept.clone();
        trial.remove(index);
        let keep: Vec<String> = trial.iter().map(|i| i.to_string()).collect();
        let outcome = run_seeds(probe, seed, seed + 1, Some(&keep.join(",")));
        if outcome.first().is_some_and(|o| o.class == class) {
            kept = trial;
        } else {
            index += 1;
        }
    }
    Some(kept)
}

/// Mutation count of a fuzz seed, as its probe reports it in the verdict
/// text (`mutations=N`).
fn mutation_count(detail: &str) -> Option<usize> {
    detail
        .split_whitespace()
        .find_map(|w| w.strip_prefix("mutations="))
        .and_then(|n| n.trim_end_matches([';', ',']).parse().ok())
}

pub fn run_probe(probe: &Probe, case: &mut Case) {
    let tier = report::tier();
    let (first, end) = match (probe.seeds, std::env::var(SEED_ENV).ok()) {
        (Some(_), Some(seed)) => match seed.parse::<u64>() {
            Ok(seed) => (seed, seed + 1),
            Err(_) => {
                case.problem("harness", format!("{SEED_ENV}={seed} is not a seed"));
                return;
            }
        },
        (Some((fast, full)), None) => (0, if tier == Tier::Full { full } else { fast }),
        (None, _) => (0, 1),
    };
    let keep = std::env::var(KEEP_ENV).ok();
    let mut outcomes = run_seeds(probe, first, end, keep.as_deref());
    // A hang must reproduce: a shared machine can stall a child past its
    // timeout. The rerun's outcome stands, and a hang that does not repeat is
    // noted.
    for outcome in &mut outcomes {
        if outcome.class != "hang" {
            continue;
        }
        let rerun = run_seeds(probe, outcome.seed, outcome.seed + 1, keep.as_deref());
        if let Some(again) = rerun.into_iter().next()
            && again.class != "hang"
        {
            case.note(format!(
                "seed {} hung once ({}) and did not hang on its rerun",
                outcome.seed, outcome.detail
            ));
            *outcome = again;
        }
    }
    let mut passed = 0;
    let mut signatures: BTreeMap<&'static str, usize> = BTreeMap::new();
    for outcome in &outcomes {
        if outcome.class == "pass" {
            passed += 1;
            if probe.seeds.is_none() {
                case.note(outcome.detail.clone());
            }
            continue;
        }
        *signatures.entry(outcome.class).or_default() += 1;
        let mut text = outcome.detail.clone();
        if probe.seeds.is_some() {
            let shrunk = (outcome.class != "hang" && outcome.class != "harness")
                .then(|| {
                    let probe_outcome = run_seeds(probe, outcome.seed, outcome.seed + 1, Some(""));
                    let count = probe_outcome
                        .first()
                        .and_then(|o| mutation_count(&o.detail));
                    count.and_then(|n| shrink(probe, outcome.seed, outcome.class, n))
                })
                .flatten();
            let keep = shrunk
                .map(|k| {
                    format!(
                        " {KEEP_ENV}={}",
                        k.iter()
                            .map(|i| i.to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                })
                .unwrap_or_default();
            text = format!(
                "seed {} ({SEED_ENV}={}{keep}): {text}",
                outcome.seed, outcome.seed
            );
        }
        case.problem(outcome.class, text);
    }
    if probe.seeds.is_some() {
        case.note(format!(
            "seeds {first}..{end}: {passed} clean, failures {signatures:?}"
        ));
    }
}

/// Runs every selected probe whose id starts with `prefix` and settles each
/// as a case.
pub fn run_group(all: fn() -> Vec<Probe>, prefix: &str) {
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    crate::common::init();
    if std::env::var_os(cap_recording::oop_muxer::ENV_BIN_PATH).is_none()
        && let Some(bin) = std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.parent()?.join("cap-muxer")))
            .filter(|p| p.exists())
    {
        let _ = cap_recording::oop_muxer::set_muxer_binary_override(bin);
    }
    let tier = report::tier();
    let probes: Vec<Probe> = all()
        .into_iter()
        .filter(|p| p.id.starts_with(prefix) && report::selected(&p.id))
        .filter(|p| !(p.full_only && tier == Tier::Fast))
        .collect();
    let jobs = std::env::var("CAP_VERIFY_CHAOS_JOBS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| (n.get() / 4).clamp(1, 3))
                .unwrap_or(1)
        })
        .max(1);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failures: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..jobs.min(probes.len().max(1)) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(probe) = probes.get(index) else {
                        break;
                    };
                    let mut case = Case::new(&probe.id);
                    run_probe(probe, &mut case);
                    for note in &case.notes {
                        eprintln!("  note: {note}");
                    }
                    if let Err(e) = report::settle(case) {
                        failures
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push((index, e));
                    }
                }
            });
        }
    });
    let mut failures = failures.into_inner().unwrap_or_else(|e| e.into_inner());
    failures.sort();
    let failures: Vec<String> = failures.into_iter().map(|(_, e)| e).collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn keep_scratch() -> bool {
    std::env::var_os("CAP_VERIFY_CHAOS_KEEP_SCRATCH").is_some()
}
