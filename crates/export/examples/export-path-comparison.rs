use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

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
    let mode = args.next().expect("eager or streaming");
    assert!(mode == "eager" || mode == "streaming");
    let root = PathBuf::from(args.next().expect("project path"));
    let output = PathBuf::from(args.next().expect("unused output path"));
    assert!(!output.exists());
    let first_progress = Arc::new(AtomicU64::new(u64::MAX));
    let recorded = first_progress.clone();
    let start = Instant::now();
    let on_progress = move |_| {
        let _ = recorded.compare_exchange(
            u64::MAX,
            start.elapsed().as_micros() as u64,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
        true
    };
    let builder = ExporterBase::builder(root)
        .with_output_path(output.clone())
        .with_force_ffmpeg_decoder(true);
    let settings = Mp4ExportSettings {
        fps: 15,
        resolution_base: XY::new(640, 360),
        compression: ExportCompression::Web,
        custom_bpp: None,
        force_ffmpeg_decoder: true,
        optimize_filesize: false,
    };
    let prepared_seconds;
    let streaming;
    if mode == "streaming" {
        let base = builder
            .build_for_mp4(Arc::new(AtomicBool::new(false)))
            .await
            .expect("prepare streaming");
        prepared_seconds = start.elapsed().as_secs_f64();
        streaming = base.uses_streaming_audio();
        settings
            .export_prepared(base, on_progress)
            .await
            .expect("export streaming");
    } else {
        let base = builder.build().await.expect("prepare eager");
        prepared_seconds = start.elapsed().as_secs_f64();
        streaming = false;
        settings
            .export(base, on_progress)
            .await
            .expect("export eager");
    }
    let elapsed = start.elapsed().as_secs_f64();
    let maxrss_kib = std::fs::read_to_string("/proc/self/status")
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
    println!(
        "EXPORT_PATH {}",
        serde_json::json!({"mode":mode.to_string_lossy(), "streaming_audio":streaming,"prepare_seconds":prepared_seconds,"total_seconds":elapsed,"first_progress_seconds":first_progress.load(Ordering::Relaxed) as f64 / 1_000_000.0,"maxrss_kib":maxrss_kib,"output":output})
    );
}
