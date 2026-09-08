//! Repro for CapSoftware/Cap#2132: repeatedly enumerate cameras while
//! watching threads, handles and private bytes of this process from outside
//! (Process Explorer, or `Get-Process -Id <pid>` in a loop).
//!
//! Usage: enumeration_leak.exe [mf|ds|both] [iterations] [sleep_ms]
//!
//! `mf` and `ds` isolate the Media Foundation and DirectShow halves of
//! `get_devices()`; whichever mode grows is the leaking half. The printed
//! per-enumeration wall time also rises as leaked threads and handles
//! accumulate.

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "both".into());
    let iterations: usize = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let sleep_ms: u64 = std::env::args()
        .nth(3)
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);

    println!(
        "pid {} mode={mode} iterations={iterations} sleep_ms={sleep_ms}",
        std::process::id()
    );

    let _ = cap_camera_directshow::initialize_directshow();
    let _ = cap_camera_mediafoundation::initialize_mediafoundation();

    for i in 1..=iterations {
        let start = std::time::Instant::now();

        let devices = match mode.as_str() {
            "mf" => cap_camera_mediafoundation::DeviceSourcesIterator::new()
                .map(|devices| devices.count())
                .unwrap_or(0),
            "ds" => cap_camera_directshow::VideoInputDeviceIterator::new()
                .map(|devices| devices.count())
                .unwrap_or(0),
            _ => cap_camera_windows::get_devices()
                .map(|devices| devices.len())
                .unwrap_or(0),
        };

        println!(
            "{i}: {devices} device(s) in {}ms",
            start.elapsed().as_millis()
        );
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
    }

    println!("done");
}
