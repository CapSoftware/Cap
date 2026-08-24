//! Splits the camera-enumeration leak between the Media Foundation and
//! DirectShow halves of `get_devices()`.
//!
//! Usage: enumeration_leak.exe [mf|ds|both] [iterations]
//!
//! Sample handles/threads from outside while it runs; whichever mode grows is
//! the leaking half.

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "both".into());
    let iterations: usize = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);

    println!("pid {} mode={mode} iterations={iterations}", std::process::id());

    let _ = cap_camera_directshow::initialize_directshow();
    let _ = cap_camera_mediafoundation::initialize_mediafoundation();

    for i in 1..=iterations {
        let n = match mode.as_str() {
            "mf" => cap_camera_mediafoundation::DeviceSourcesIterator::new()
                .map(|it| it.count())
                .unwrap_or(0),

            "ds" => cap_camera_directshow::VideoInputDeviceIterator::new()
                .map(|it| it.count())
                .unwrap_or(0),

            _ => cap_camera_windows::get_devices().map(|d| d.len()).unwrap_or(0),
        };

        println!("{i}: {n} device(s)");
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }

    println!("done");
}
