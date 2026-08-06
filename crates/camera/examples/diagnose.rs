//! Non-interactive camera diagnostics: lists every camera with its formats
//! (including the native pixel format on macOS), then runs a short capture
//! test against each device and reports whether frames actually arrive.
//!
//! Usage:
//!   cargo run -p cap-camera --example diagnose            # list + capture test all cameras
//!   cargo run -p cap-camera --example diagnose -- "FaceTime"  # only cameras whose name matches
//!   cargo run -p cap-camera --example diagnose -- --list  # list only, no capture
//!   cargo run -p cap-camera --example diagnose -- --compat  # capture in compatibility mode

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use cap_camera::{CameraInfo, CaptureMode, Format};

const CAPTURE_TEST_DURATION: Duration = Duration::from_secs(3);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let list_only = args.iter().any(|a| a == "--list");
    let mode = if args.iter().any(|a| a == "--compat") {
        CaptureMode::Compatibility
    } else {
        CaptureMode::Native
    };
    let name_filter = args.iter().find(|a| !a.starts_with("--")).cloned();

    print_authorization_status();

    let cameras: Vec<CameraInfo> = cap_camera::list_cameras().collect();
    if cameras.is_empty() {
        println!("No cameras found");
        return;
    }

    for camera in &cameras {
        println!(
            "== {} (device_id={:?}, model_id={:?})",
            camera.display_name(),
            camera.device_id(),
            camera.model_id().map(|m| m.to_string()),
        );

        match camera.formats() {
            Some(formats) if !formats.is_empty() => {
                for format in &formats {
                    println!(
                        "   {}x{} @{}fps{}",
                        format.width(),
                        format.height(),
                        format.frame_rate(),
                        native_format_suffix(format),
                    );
                }
            }
            _ => println!("   <no formats reported>"),
        }
    }

    if list_only {
        return;
    }

    for camera in &cameras {
        if let Some(filter) = &name_filter
            && !camera
                .display_name()
                .to_lowercase()
                .contains(&filter.to_lowercase())
        {
            continue;
        }

        capture_test(camera, mode);
    }
}

fn native_format_suffix(format: &Format) -> String {
    #[cfg(target_os = "macos")]
    {
        let mut fourcc = format.native().format_desc().media_sub_type().to_be_bytes();
        format!(" [{}]", cidre::four_cc_to_str(&mut fourcc))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = format;
        String::new()
    }
}

fn print_authorization_status() {
    #[cfg(target_os = "macos")]
    {
        use cidre::av;
        match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::video()) {
            Ok(status) => println!("Camera authorization status: {status:?}"),
            Err(err) => println!("Camera authorization status unavailable: {err:?}"),
        }
    }
}

fn pick_test_format(formats: &[Format]) -> Option<Format> {
    let mut candidates: Vec<Format> = formats
        .iter()
        .filter(|f| {
            f.width() <= 1280
                && f.height() <= 720
                && f.frame_rate() >= 24.0
                && f.frame_rate() <= 30.0
        })
        .cloned()
        .collect();

    if candidates.is_empty() {
        candidates = formats.to_vec();
    }

    candidates.sort_by(|a, b| {
        (b.width() * b.height())
            .cmp(&(a.width() * a.height()))
            .then(
                (a.frame_rate() - 30.0)
                    .abs()
                    .partial_cmp(&(b.frame_rate() - 30.0).abs())
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    candidates.into_iter().next()
}

fn capture_test(camera: &CameraInfo, mode: CaptureMode) {
    let Some(formats) = camera.formats().filter(|f| !f.is_empty()) else {
        println!(
            "-- {}: skipping capture test (no formats)",
            camera.display_name()
        );
        return;
    };

    let Some(format) = pick_test_format(&formats) else {
        println!(
            "-- {}: skipping capture test (no candidate format)",
            camera.display_name()
        );
        return;
    };

    println!(
        "-- {}: capturing {}x{} @{}fps{} for {:?} ({mode:?} mode)",
        camera.display_name(),
        format.width(),
        format.height(),
        format.frame_rate(),
        native_format_suffix(&format),
        CAPTURE_TEST_DURATION,
    );

    let frame_count = Arc::new(AtomicU64::new(0));
    let first_frame: Arc<Mutex<Option<(Duration, String)>>> = Arc::new(Mutex::new(None));

    let started_at = Instant::now();
    let cb_count = frame_count.clone();
    let cb_first = first_frame.clone();

    let handle = camera.start_capturing_with_mode(format, mode, move |frame| {
        cb_count.fetch_add(1, Ordering::Relaxed);
        let mut first = cb_first.lock().unwrap();
        if first.is_none() {
            *first = Some((started_at.elapsed(), describe_frame(&frame)));
        }
    });

    let handle = match handle {
        Ok(handle) => handle,
        Err(err) => {
            println!("   FAILED to start capture: {err}");
            return;
        }
    };

    std::thread::sleep(CAPTURE_TEST_DURATION);
    let _ = handle.stop_capturing();

    let total = frame_count.load(Ordering::Relaxed);
    match first_frame.lock().unwrap().take() {
        Some((latency, desc)) => {
            println!("   OK: {total} frames, first after {latency:?}, delivered {desc}")
        }
        None => println!("   NO FRAMES received within {CAPTURE_TEST_DURATION:?}"),
    }
}

fn describe_frame(frame: &cap_camera::CapturedFrame) -> String {
    #[cfg(target_os = "macos")]
    {
        let sample_buf = frame.native().sample_buf();
        let Some(desc) = sample_buf.format_desc() else {
            return "<no format desc>".to_string();
        };
        let mut fourcc = desc.media_sub_type().to_be_bytes();
        let dims = frame
            .native()
            .image_buf()
            .map(|buf| format!("{}x{}", buf.width(), buf.height()))
            .unwrap_or_else(|| "<no image buf>".to_string());
        format!("{} [{}]", dims, cidre::four_cc_to_str(&mut fourcc))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = frame;
        "<frame>".to_string()
    }
}
