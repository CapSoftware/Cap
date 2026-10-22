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

struct DrawState {
    shown: Option<u32>,
    line: Option<(f64, f64)>,
    previous: Option<Option<u32>>,
    times: Vec<Instant>,
    line_offsets_ms: Vec<f64>,
    sample_off_frames: u64,
    sample_max_off_frames: u64,
    no_frame: u64,
}

static DRAW: Mutex<DrawState> = Mutex::new(DrawState {
    shown: None,
    line: None,
    previous: None,
    times: Vec::new(),
    line_offsets_ms: Vec::new(),
    sample_off_frames: 0,
    sample_max_off_frames: 0,
    no_frame: 0,
});

pub struct DrawReport {
    pub times: Vec<Instant>,
    pub line_offsets_ms: Vec<f64>,
    pub sample_off_frames: u64,
    pub sample_max_off_frames: u64,
    pub no_frame: u64,
}

pub fn line(sample: f64, drawn: f64) {
    DRAW.lock().unwrap().line = Some((sample, drawn));
}

pub fn draw(playing: bool) {
    let mut guard = DRAW.lock().unwrap();
    let state = &mut *guard;
    if let Some(shown) = state.previous.take()
        && let Some((sample, drawn)) = state.line
    {
        match shown {
            Some(shown) => {
                let frame_time = shown as f64 / 60.0;
                state.line_offsets_ms.push((drawn - frame_time) * 1000.0);
                let off = ((sample * 60.0).round() as i64 - shown as i64).unsigned_abs();
                if off > 0 {
                    state.sample_off_frames += 1;
                }
                state.sample_max_off_frames = state.sample_max_off_frames.max(off);
            }
            None => state.no_frame += 1,
        }
    }
    if playing {
        let shown = state.shown;
        state.previous = Some(shown);
        state.times.push(Instant::now());
    }
}

pub fn take_draws() -> DrawReport {
    let mut state = DRAW.lock().unwrap();
    state.previous = None;
    DrawReport {
        times: std::mem::take(&mut state.times),
        line_offsets_ms: std::mem::take(&mut state.line_offsets_ms),
        sample_off_frames: std::mem::take(&mut state.sample_off_frames),
        sample_max_off_frames: std::mem::take(&mut state.sample_max_off_frames),
        no_frame: std::mem::take(&mut state.no_frame),
    }
}

pub fn vsync_draws(times: &[Instant], period_s: f64) -> f64 {
    let Some(first) = times.first() else {
        return 0.0;
    };
    let phases = 16;
    let mut total = 0usize;
    for phase in 0..phases {
        let offset = period_s * phase as f64 / phases as f64;
        let mut bins: Vec<u64> = times
            .iter()
            .map(|t| ((t.duration_since(*first).as_secs_f64() + offset) / period_s) as u64)
            .collect();
        bins.dedup();
        total += bins.len();
    }
    total as f64 / phases as f64
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
    DRAW.lock().unwrap().shown = Some(frame);
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
