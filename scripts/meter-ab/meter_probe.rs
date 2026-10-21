use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

static MAIN_RENDERS: AtomicU64 = AtomicU64::new(0);
static MIC: AtomicBool = AtomicBool::new(false);
static LEVEL_PUSHES: AtomicU64 = AtomicU64::new(0);

pub fn count_render(mic: bool) {
    MAIN_RENDERS.fetch_add(1, Ordering::Relaxed);
    MIC.store(mic, Ordering::Relaxed);
}

pub fn start_reporter() {
    let _reporter = std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            eprintln!(
                "METERPROBE main_renders={} mic={} pushes={}",
                MAIN_RENDERS.swap(0, Ordering::Relaxed),
                MIC.load(Ordering::Relaxed),
                LEVEL_PUSHES.swap(0, Ordering::Relaxed),
            );
        }
    });
}

pub fn feed(profile: &str, mut push: impl FnMut(Instant, f64)) {
    let start = Instant::now();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    loop {
        std::thread::sleep(Duration::from_millis(10));
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let jitter = ((seed >> 33) as f64 / (1u64 << 31) as f64) * 2.0 - 1.0;
        let t = start.elapsed().as_secs_f64();
        let db = match profile {
            "silence" => -96.0,
            "hiss" => -70.0 + 4.0 * jitter,
            "room" => -54.0 + 4.0 * jitter,
            _ => -24.0 + 14.0 * (t * std::f64::consts::TAU * 0.5).sin() + 3.0 * jitter,
        };
        LEVEL_PUSHES.fetch_add(1, Ordering::Relaxed);
        push(Instant::now(), db.clamp(-96.0, 0.0));
    }
}
