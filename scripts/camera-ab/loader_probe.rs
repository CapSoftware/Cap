use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static PAINTS: AtomicU64 = AtomicU64::new(0);

pub fn count_paint() {
    PAINTS.fetch_add(1, Ordering::Relaxed);
}

pub fn start_reporter() {
    let _reporter = std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            eprintln!(
                "LOADERPROBE paints={}",
                PAINTS.swap(0, Ordering::Relaxed)
            );
        }
    });
}
