//! Headless end-to-end verification for the native x11rb screen-capture path.
//!
//! Records the primary X11 display (run under Xvfb), stops cleanly, and asserts
//! the produced `.cap` is COMPLETE — i.e. the exact failure modes reported on
//! 0.5.2 Linux (recording bails with "FFmpeg was built without x11grab", or the
//! `.cap` is left InProgress with an incomplete manifest) do NOT happen.
//!
//! Exits 0 on success, non-zero with a diagnostic on failure.
//!
//!   DISPLAY=:99 cargo run -p cap-recording --example linux-x11-e2e

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("linux-x11-e2e: skipped (not Linux)");
}

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() {
    use std::path::Path;
    use std::time::Duration;
    use std::{fs, process};

    use cap_recording::screen_capture::ScreenCaptureTarget;
    use cap_recording::studio_recording;
    use scap_targets::Display;

    unsafe { std::env::set_var("RUST_LOG", "info,cap_recording=debug") };
    tracing_subscriber::fmt::init();

    let fail = |msg: String| -> ! {
        eprintln!("\n❌ LINUX X11 E2E FAILED: {msg}");
        process::exit(1);
    };

    let display = Display::primary();
    eprintln!("Primary display id: {:?}", display.id());

    let out_root = std::env::temp_dir().join("cap-linux-x11-e2e");
    let _ = fs::remove_dir_all(&out_root);
    fs::create_dir_all(&out_root).unwrap();
    let out = out_root.join("recording.cap");

    eprintln!("Recording primary display to {} ...", out.display());

    let handle = match studio_recording::Actor::builder(
        out.clone(),
        ScreenCaptureTarget::Display { id: display.id() },
    )
    .with_system_audio(false)
    .with_keyboard_capture(false)
    .with_max_fps(30)
    .build()
    .await
    {
        Ok(handle) => handle,
        Err(error) => fail(format!(
            "failed to START recording (capture setup): {error:#}"
        )),
    };

    eprintln!("Recording started; capturing for 4s...");
    tokio::time::sleep(Duration::from_secs(4)).await;

    if let Err(error) = handle.stop().await {
        fail(format!("failed to STOP/finalize recording: {error:#}"));
    }
    eprintln!("Recording stopped cleanly.");

    // ---- Validate recording-meta.json (must NOT be InProgress; segments present) ----
    let meta_path = out.join("recording-meta.json");
    let meta_raw = fs::read_to_string(&meta_path)
        .unwrap_or_else(|e| fail(format!("recording-meta.json unreadable: {e}")));
    eprintln!("\n--- recording-meta.json ---\n{meta_raw}\n");
    let meta: serde_json::Value = serde_json::from_str(&meta_raw)
        .unwrap_or_else(|e| fail(format!("recording-meta.json invalid JSON: {e}")));

    let status = meta
        .get("status")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    if status == "InProgress" || status == "<missing>" {
        fail(format!(
            "recording-meta.json status is '{status}' (expected a finalized status). \
             This is the exact 0.5.2 symptom of a never-finalized .cap."
        ));
    }
    let segments = meta.get("segments").and_then(|v| v.as_array());
    match segments {
        Some(segs) if !segs.is_empty() => {
            eprintln!("recording-meta status='{status}', segments={}", segs.len())
        }
        _ => fail("recording-meta.json has empty top-level segments[]".into()),
    }

    // ---- Validate the display manifest (must be is_complete:true with real media) ----
    let manifest_path = out.join("content/segments/segment-0/display/manifest.json");
    let manifest_raw = fs::read_to_string(&manifest_path).unwrap_or_else(|e| {
        fail(format!(
            "display manifest unreadable ({}): {e}",
            manifest_path.display()
        ))
    });
    eprintln!("--- display manifest.json ---\n{manifest_raw}\n");
    let manifest: serde_json::Value = serde_json::from_str(&manifest_raw)
        .unwrap_or_else(|e| fail(format!("manifest invalid JSON: {e}")));

    if manifest.get("is_complete").and_then(|v| v.as_bool()) != Some(true) {
        fail("display manifest is_complete != true (incomplete capture)".into());
    }

    let seg_dir = manifest_path.parent().unwrap();
    let mut total_bytes: u64 = 0;
    let mut total_duration = 0f64;
    let mut complete_segments = 0usize;
    if let Some(segs) = manifest.get("segments").and_then(|v| v.as_array()) {
        for seg in segs {
            if seg.get("is_complete").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            complete_segments += 1;
            total_duration += seg.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if let Some(path) = seg.get("path").and_then(|v| v.as_str()) {
                let p = seg_dir.join(path);
                let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if size == 0 {
                    fail(format!("segment media {} is missing/empty", p.display()));
                }
                total_bytes += size;
            }
        }
    }

    // init segment must exist and be non-empty
    if let Some(init) = manifest.get("init_segment").and_then(|v| v.as_str()) {
        let p = seg_dir.join(init);
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            fail(format!("init segment {} is missing/empty", p.display()));
        }
        total_bytes += size;
    }

    if complete_segments == 0 || total_duration <= 0.0 {
        fail(format!(
            "no complete media segments captured (segments={complete_segments}, duration={total_duration:.3}s)"
        ));
    }

    // codec_info sanity (proves frames were captured at real dimensions)
    let codec = manifest.get("codec_info");
    let w = codec
        .and_then(|c| c.get("width"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let h = codec
        .and_then(|c| c.get("height"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if w == 0 || h == 0 {
        fail(format!("manifest codec_info has zero dimensions ({w}x{h})"));
    }

    eprintln!("\n✅ LINUX X11 E2E PASSED");
    eprintln!("   status               : {status}");
    eprintln!("   complete media segs  : {complete_segments}");
    eprintln!("   captured duration    : {total_duration:.3}s");
    eprintln!("   capture dimensions   : {w}x{h}");
    eprintln!("   media bytes written  : {total_bytes}");
    eprintln!("   output               : {}", out.display());

    let _ = Path::new(&out); // keep for inspection
}
