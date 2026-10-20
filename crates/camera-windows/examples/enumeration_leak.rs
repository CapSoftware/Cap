//! Repro for CapSoftware/Cap#2132: repeatedly enumerate cameras while
//! watching threads, handles and private bytes of this process from outside
//! (Process Explorer, or `Get-Process -Id <pid>` in a loop).
//!
//! Usage: enumeration_leak.exe [mf|ds|both|mf-formats|ds-formats|formats] [iterations] [sleep_ms]
//!
//! `mf` and `ds` isolate the Media Foundation and DirectShow halves of
//! `get_devices()`; whichever mode grows is the leaking half. The printed
//! per-enumeration wall time also rises as leaked threads and handles
//! accumulate.

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
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

    if !matches!(
        mode.as_str(),
        "mf" | "ds" | "both" | "mf-formats" | "ds-formats" | "formats"
    ) {
        return Err(format!("Unknown enumeration mode: {mode}").into());
    }
    cap_camera_directshow::initialize_directshow()?;
    cap_camera_mediafoundation::initialize_mediafoundation()?;

    for i in 1..=iterations {
        let start = std::time::Instant::now();

        let mut format_count = 0;
        let devices = match mode.as_str() {
            "mf" => cap_camera_mediafoundation::DeviceSourcesIterator::new()?.count(),
            "ds" => cap_camera_directshow::VideoInputDeviceIterator::new()?.count(),
            "mf-formats" => {
                let mut count = 0;
                for device in cap_camera_mediafoundation::DeviceSourcesIterator::new()? {
                    let formats = device.formats().map(Iterator::count);
                    device.shutdown();
                    format_count += formats?;
                    count += 1;
                }
                count
            }
            "ds-formats" => {
                let mut count = 0;
                for device in cap_camera_directshow::VideoInputDeviceIterator::new()? {
                    format_count += device
                        .media_types()
                        .ok_or("Could not read DirectShow formats")?
                        .count();
                    count += 1;
                }
                count
            }
            "formats" => {
                let devices = cap_camera_windows::get_devices()?;
                let count = devices.len();
                for device in devices {
                    format_count += device.into_formats().len();
                }
                count
            }
            _ => cap_camera_windows::get_devices()?.len(),
        };
        if devices == 0 {
            return Err(
                "No cameras found; this run cannot validate camera resource stability".into(),
            );
        }
        if mode.ends_with("formats") && format_count == 0 {
            return Err(
                "No camera formats found; format-probe validation requires a usable camera".into(),
            );
        }

        println!(
            "{i}: {devices} device(s), {format_count} format(s) in {}ms",
            start.elapsed().as_millis()
        );
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
    }

    println!("done");
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Camera enumeration leak validation requires Windows");
    std::process::exit(1);
}
