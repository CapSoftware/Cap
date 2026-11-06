//! The editor preview's per-frame buffers (a padded readback, a tight BGRA
//! copy, both written in full and freed) under the Windows heap and mimalloc.
//!
//! Run: cargo run --release --example frame-alloc-benchmark -- [FRAMES]

#[cfg(not(windows))]
fn main() {
    eprintln!("frame-alloc-benchmark measures the Windows heap; run it on Windows.");
}

#[cfg(windows)]
fn main() {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::{hint::black_box, time::Instant};
    use windows_sys::Win32::System::{ProcessStatus::*, Threading::GetCurrentProcess};

    fn page_faults() -> u64 {
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        counters.PageFaultCount as u64
    }

    fn frame(allocator: &dyn GlobalAlloc, width: usize, height: usize) {
        let padded = Layout::array::<u8>((width * 4).div_ceil(256) * 256 * height).unwrap();
        let tight = Layout::array::<u8>(width * 4 * height).unwrap();
        unsafe {
            let readback = allocator.alloc(padded);
            let converted = allocator.alloc(tight);
            assert!(!readback.is_null() && !converted.is_null());
            readback.write_bytes(0x40, padded.size());
            converted.copy_from_nonoverlapping(readback, tight.size());
            black_box(std::slice::from_raw_parts(converted, tight.size()));
            allocator.dealloc(readback, padded);
            allocator.dealloc(converted, tight);
        }
    }

    let frames: usize = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .filter(|&frames| frames > 0)
        .unwrap_or(600);
    let allocators: [(&str, &dyn GlobalAlloc); 2] =
        [("system", &System), ("mimalloc", &mimalloc::MiMalloc)];
    println!(
        "{:<24} {:>10} {:>10} {:>14}",
        "case", "mean us", "p95 us", "faults/frame"
    );
    for (resolution, width, height) in [
        ("half", 1248, 702),
        ("1080p", 1920, 1080),
        ("4k", 3840, 2160),
    ] {
        for (name, allocator) in allocators {
            (0..30).for_each(|_| frame(allocator, width, height));
            let faults = page_faults();
            let mut micros: Vec<f64> = (0..frames)
                .map(|_| {
                    let started = Instant::now();
                    frame(allocator, width, height);
                    started.elapsed().as_secs_f64() * 1e6
                })
                .collect();
            let faults = page_faults().saturating_sub(faults) as f64 / frames as f64;
            micros.sort_by(f64::total_cmp);
            let mean = micros.iter().sum::<f64>() / frames as f64;
            let p95 = micros[(frames - 1) * 95 / 100];
            println!(
                "{:<24} {mean:>10.1} {p95:>10.1} {faults:>14.1}",
                format!("{resolution} {name}")
            );
        }
    }
}
