use cap_export::preview::{ExportPreviewSettings, render_preview, render_preview_with_config};
use cap_project::{ProjectConfiguration, XY};
use std::{path::PathBuf, time::Instant};

fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()
        .unwrap()
        .block_on(run());
}

async fn run() {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().expect("project path"));
    let output = PathBuf::from(args.next().expect("unused result JSON"));
    assert!(!output.exists());
    let with_config = args.next().as_deref() == Some(std::ffi::OsStr::new("config"));
    let settings = ExportPreviewSettings {
        fps: 15,
        resolution_base: XY::new(640, 360),
        compression_bpp: 0.2,
        cursor_only: false,
    };
    let start = Instant::now();
    let result = if with_config {
        let config = ProjectConfiguration::load(&root).unwrap();
        render_preview_with_config(root, config, 1.0, settings, true).await
    } else {
        render_preview(root, 1.0, settings, true).await
    }
    .expect("render preview");
    let elapsed = start.elapsed().as_secs_f64();
    let peak_rss_kib = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmHWM:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        });
    std::fs::write(output, serde_json::to_vec(&result).unwrap()).unwrap();
    println!(
        "PREVIEW_AUDIO {}",
        serde_json::json!({"with_config":with_config,"total_seconds":elapsed,"peak_rss_kib":peak_rss_kib,"width":result.actual_width,"height":result.actual_height,"total_frames":result.total_frames})
    );
}
