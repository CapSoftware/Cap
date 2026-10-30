//! Run: cargo run --release -p cap-export --example export-turbo-benchmark -- <project.cap> <output.mp4> [WIDTH] [HEIGHT] [FPS] [standard|turbo]

use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;

/// CPU seconds used and peak resident bytes so far.
#[cfg(unix)]
fn usage() -> (f64, u64) {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    let usage = unsafe { usage.assume_init() };
    let secs = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1_000_000.0;
    #[cfg(target_os = "macos")]
    let peak = usage.ru_maxrss as u64;
    #[cfg(not(target_os = "macos"))]
    let peak = usage.ru_maxrss as u64 * 1024;
    (secs(usage.ru_utime) + secs(usage.ru_stime), peak)
}

#[cfg(not(unix))]
fn usage() -> (f64, u64) {
    (0.0, 0)
}

async fn run(
    project_path: PathBuf,
    output_path: PathBuf,
    size: XY<u32>,
    fps: u32,
    turbo: bool,
) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(&output_path);
    let cancel = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let (cpu_started, _) = usage();
    let base = ExporterBase::builder(project_path)
        .with_output_path(output_path.clone())
        .build_for_mp4(cancel)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let total = base.total_frames(fps);
    let prepared_ms = started.elapsed().as_secs_f64() * 1000.0;
    let settings = Mp4ExportSettings {
        fps,
        resolution_base: size,
        compression: match std::env::var("TURBO_BENCH_COMPRESSION").as_deref() {
            Ok("social") => ExportCompression::Social,
            Ok("web") => ExportCompression::Web,
            Ok("potato") => ExportCompression::Potato,
            _ => ExportCompression::Maximum,
        },
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: std::env::var_os("TURBO_BENCH_OPTIMIZE").is_some(),
    };
    let path = if turbo {
        let options = cap_export::mp4::turbo::TurboOptions {
            chunks: std::env::var("TURBO_BENCH_CHUNKS")
                .ok()
                .and_then(|value| value.parse().ok()),
            strict: true,
        };
        settings
            .export_prepared_turbo(base, options, |_| true)
            .await
    } else {
        settings.export_prepared(base, |_| true).await
    }
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    let wall = started.elapsed().as_secs_f64();
    let (cpu, peak) = usage();
    let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    println!(
        "{}",
        serde_json::json!({
            "mode": if turbo { "turbo" } else { "standard" },
            "frames": total,
            "width": size.x,
            "height": size.y,
            "fps": fps,
            "prepareMs": prepared_ms,
            "wallSecs": wall,
            "exportFps": f64::from(total) / wall,
            "cpuSecs": cpu - cpu_started,
            "peakRssMb": peak as f64 / 1_048_576.0,
            "bytes": bytes,
        })
    );
    Ok(())
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let mut arguments = std::env::args().skip(1);
    let project_path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass a studio .cap project path"))?;
    let output_path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass an output .mp4 path"))?;
    let mut number = |default: u32| {
        arguments
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let size = XY::new(number(1920), number(1080));
    let fps = number(60);
    let turbo = std::env::args().any(|argument| argument == "turbo");

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()?
        .block_on(run(project_path, output_path, size, fps, turbo))
}
