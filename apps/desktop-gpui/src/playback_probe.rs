use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub const NAMES: [&str; 9] = [
    "root_renders",
    "header_renders",
    "toolbar_renders",
    "transport_renders",
    "sidebar_renders",
    "timeline_renders",
    "preview_renders",
    "seeks",
    "presented",
];

static COUNTERS: [AtomicU64; 9] = [const { AtomicU64::new(0) }; 9];

struct SeekState {
    pending: Option<(u32, Instant)>,
    latencies_us: Vec<f64>,
    satisfied: u64,
}

static SEEK: Mutex<SeekState> = Mutex::new(SeekState {
    pending: None,
    latencies_us: Vec::new(),
    satisfied: 0,
});

pub fn root() {
    COUNTERS[0].fetch_add(1, Ordering::Relaxed);
}

pub fn section(index: usize) {
    COUNTERS[1 + index].fetch_add(1, Ordering::Relaxed);
}

pub fn preview() {
    COUNTERS[6].fetch_add(1, Ordering::Relaxed);
}

pub fn seek(frame: u32) {
    tracing::info!(target: "cap_probe", frame, "ui seek");
    COUNTERS[7].fetch_add(1, Ordering::Relaxed);
    let mut state = SEEK.lock().unwrap();
    if state.pending.is_none_or(|(pending, _)| pending != frame) {
        state.pending = Some((frame, Instant::now()));
    }
}

pub fn presented(frame: u32) {
    tracing::info!(target: "cap_probe", frame, "ui presented");
    COUNTERS[8].fetch_add(1, Ordering::Relaxed);
    let mut state = SEEK.lock().unwrap();
    if let Some((pending, at)) = state.pending
        && pending == frame
    {
        state.pending = None;
        state.satisfied += 1;
        state.latencies_us.push(at.elapsed().as_secs_f64() * 1e6);
    }
}

pub fn snapshot() -> [u64; 9] {
    std::array::from_fn(|index| COUNTERS[index].load(Ordering::Relaxed))
}

pub fn take_seek_latencies() -> (u64, Vec<f64>) {
    let mut state = SEEK.lock().unwrap();
    state.pending = None;
    let satisfied = std::mem::take(&mut state.satisfied);
    (satisfied, std::mem::take(&mut state.latencies_us))
}

pub fn thread_cpu_ns() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

pub fn process_cpu_ns() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let tv = |t: libc::timeval| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1000;
    tv(usage.ru_utime) + tv(usage.ru_stime)
}
