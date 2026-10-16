//! Machine-starvation sentinel for the engine suites.
//!
//! A test that measures wall-clock behaviour (real-time playback) can fail
//! because the runner stopped scheduling the process, not because Cap is
//! wrong. To tell the two apart from evidence rather than by guessing, every
//! test process runs one high-priority thread that sleeps a fixed short
//! interval and records how late it wakes. A wake gap of
//! [`STARVATION_GAP_MS`] or more means the machine did not run the process
//! for that long. The series is kept in memory for [`crate::report`] (per
//! case) and appended to `<CAP_VERIFY_REPORT_DIR>/sentinel-<pid>.log`, so a
//! test killed by its timeout still leaves its evidence.
//!
//! Only classes that legitimately depend on wall-clock timing may be excused
//! by starvation, and only after a retry (see `scripts/verify/retry.py`).
//! Content, frame identity, export timestamps and sync never are.

use std::{
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// The sentinel's sleep.
const PERIOD: Duration = Duration::from_millis(2);
/// Gaps at or above this are kept (Windows timers tick at about 15.6 ms, so a
/// healthy sentinel there wakes up to about 32 ms apart).
const RECORD_GAP_MS: f64 = 50.0;
/// A wake gap this long during a case proves the machine starved it (the
/// real-capture freeze sentinel uses the same limit).
pub const STARVATION_GAP_MS: f64 = 100.0;

struct State {
    started: Instant,
    gaps: Mutex<Vec<(f64, f64)>>,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| {
        let state = State {
            started: Instant::now(),
            gaps: Mutex::new(Vec::new()),
        };
        let log = std::env::var_os("CAP_VERIFY_REPORT_DIR").and_then(|dir| {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).ok()?;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(format!("sentinel-{}.log", std::process::id())))
                .ok()?;
            let args: Vec<String> = std::env::args().skip(1).collect();
            let exe = std::env::current_exe()
                .ok()
                .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                .unwrap_or_default();
            let _ = writeln!(
                file,
                "{}",
                serde_json::json!({ "pid": std::process::id(), "exe": exe, "args": args })
            );
            Some(file)
        });
        let _ = std::thread::Builder::new()
            .name("cap-verify-sentinel".into())
            .spawn(move || run(log));
        state
    })
}

/// How often the log records that the process is still alive, so a test
/// killed by its timeout leaves the time of its end (scripts/verify/retry.py
/// only excuses a failure whose stall overlaps the time before it).
const HEARTBEAT: Duration = Duration::from_secs(2);

fn run(mut log: Option<std::fs::File>) {
    raise_priority();
    let state = state();
    let mut last = Instant::now();
    let mut beat = Instant::now();
    loop {
        std::thread::sleep(PERIOD);
        let now = Instant::now();
        let gap_ms = now.duration_since(last).as_secs_f64() * 1000.0;
        last = now;
        if now.duration_since(beat) >= HEARTBEAT {
            beat = now;
            if let Some(file) = log.as_mut() {
                let _ = writeln!(
                    file,
                    "{}",
                    serde_json::json!({ "alive": now.duration_since(state.started).as_secs_f64() })
                );
            }
        }
        if gap_ms >= RECORD_GAP_MS {
            let at = now.duration_since(state.started).as_secs_f64() - gap_ms / 1000.0;
            if let Ok(mut gaps) = state.gaps.lock() {
                gaps.push((at, gap_ms));
            }
            if let Some(file) = log.as_mut() {
                let _ = writeln!(
                    file,
                    "{}",
                    serde_json::json!({ "at": at, "gap_ms": gap_ms })
                );
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn raise_priority() {
    let _ = crate::sched::request_realtime(PERIOD.as_secs_f64(), 0.000_5);
}

#[cfg(windows)]
fn raise_priority() {
    unsafe extern "system" {
        fn GetCurrentThread() -> isize;
        fn SetThreadPriority(thread: isize, priority: i32) -> i32;
    }
    const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;
    // SAFETY: GetCurrentThread returns a pseudo handle that needs no close.
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn raise_priority() {}

/// Start of a measured window (a case).
#[derive(Clone, Copy)]
pub struct Mark {
    at: f64,
    cpu: Option<f64>,
    wall: Instant,
}

/// What the sentinel saw during a window.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Window {
    pub seconds: f64,
    /// Process CPU time over wall time (all threads; above 1 on several cores).
    pub cpu_per_wall: Option<f64>,
    pub max_gap_ms: f64,
    /// Wake gaps of at least 50 ms: (seconds since the window started, ms).
    pub gaps: Vec<(f64, f64)>,
}

impl Window {
    pub fn starved(&self) -> bool {
        self.max_gap_ms >= STARVATION_GAP_MS
    }

    pub fn describe(&self) -> String {
        let over = self
            .gaps
            .iter()
            .filter(|(_, gap)| *gap >= STARVATION_GAP_MS)
            .count();
        format!(
            "machine: sentinel longest wake gap {:.0} ms, {over} at or over {STARVATION_GAP_MS:.0} ms, CPU/wall {}",
            self.max_gap_ms,
            self.cpu_per_wall
                .map_or("unknown".to_string(), |r| format!("{r:.2}"))
        )
    }
}

pub fn mark() -> Mark {
    let state = state();
    Mark {
        at: state.started.elapsed().as_secs_f64(),
        cpu: process_cpu_secs(),
        wall: Instant::now(),
    }
}

pub fn window(since: Mark) -> Window {
    let state = state();
    let now = state.started.elapsed().as_secs_f64();
    let gaps: Vec<(f64, f64)> = state
        .gaps
        .lock()
        .map(|gaps| {
            gaps.iter()
                .filter(|(at, gap)| at + gap / 1000.0 >= since.at && *at <= now)
                .map(|(at, gap)| ((at - since.at).max(0.0), *gap))
                .collect()
        })
        .unwrap_or_default();
    let seconds = since.wall.elapsed().as_secs_f64();
    let cpu_per_wall = since
        .cpu
        .zip(process_cpu_secs())
        .map(|(start, end)| (end - start) / seconds.max(1e-6));
    Window {
        seconds,
        cpu_per_wall,
        max_gap_ms: gaps.iter().map(|(_, gap)| *gap).fold(0.0, f64::max),
        gaps,
    }
}

/// User plus system CPU time of this process.
#[cfg(unix)]
fn process_cpu_secs() -> Option<f64> {
    unsafe extern "C" {
        fn getrusage(who: i32, usage: *mut i64) -> i32;
    }
    // struct rusage starts with two struct timeval (user, system), 16 bytes
    // each on 64-bit macOS and Linux; the rest is longs. A larger buffer
    // keeps the call in bounds on either.
    let mut usage = [0i64; 32];
    // SAFETY: RUSAGE_SELF (0) and a buffer larger than struct rusage.
    if unsafe { getrusage(0, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // tv_usec is 32 bits on macOS (then padding), 64 on Linux.
    let usec = |v: i64| (v & 0xffff_ffff) as f64 / 1e6;
    Some(usage[0] as f64 + usec(usage[1]) + usage[2] as f64 + usec(usage[3]))
}

#[cfg(windows)]
fn process_cpu_secs() -> Option<f64> {
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessTimes(
            process: isize,
            creation: *mut u64,
            exit: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    // SAFETY: FILETIME is two u32 in little-endian order, the same layout as
    // a u64; GetCurrentProcess returns a pseudo handle that needs no close.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    (ok != 0).then(|| (kernel + user) as f64 / 1e7)
}
