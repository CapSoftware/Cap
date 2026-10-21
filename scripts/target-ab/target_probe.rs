use std::sync::Once;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static RENDERS: AtomicU64 = AtomicU64::new(0);
static DISPLAY_CAPTURES: AtomicU64 = AtomicU64::new(0);
static DISPLAY_US: AtomicU64 = AtomicU64::new(0);
static WINDOW_CAPTURES: AtomicU64 = AtomicU64::new(0);
static WINDOW_US: AtomicU64 = AtomicU64::new(0);
static REPORTER: Once = Once::new();

pub fn count_render() {
    REPORTER.call_once(|| {
        let _reporter = std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                eprintln!(
                    "TPROBE renders={} dcap={} dcap_us={} wcap={} wcap_us={}",
                    RENDERS.swap(0, Ordering::Relaxed),
                    DISPLAY_CAPTURES.swap(0, Ordering::Relaxed),
                    DISPLAY_US.swap(0, Ordering::Relaxed),
                    WINDOW_CAPTURES.swap(0, Ordering::Relaxed),
                    WINDOW_US.swap(0, Ordering::Relaxed),
                );
            }
        });
    });
    RENDERS.fetch_add(1, Ordering::Relaxed);
}

pub async fn display<T>(capture: impl std::future::Future<Output = T>) -> T {
    let start = Instant::now();
    let result = capture.await;
    DISPLAY_CAPTURES.fetch_add(1, Ordering::Relaxed);
    DISPLAY_US.fetch_add(start.elapsed().as_micros() as u64, Ordering::Relaxed);
    result
}

pub async fn window<T>(capture: impl std::future::Future<Output = T>) -> T {
    let start = Instant::now();
    let result = capture.await;
    WINDOW_CAPTURES.fetch_add(1, Ordering::Relaxed);
    WINDOW_US.fetch_add(start.elapsed().as_micros() as u64, Ordering::Relaxed);
    result
}
