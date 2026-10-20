//! Run: cargo run --release --example export-benchmark -- <project.cap> [WIDTH] [HEIGHT] [FPS] [RUNS]

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

#[cfg(unix)]
fn cpu_secs() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    let usage = unsafe { usage.assume_init() };
    let secs = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1_000_000.0;
    secs(usage.ru_utime) + secs(usage.ru_stime)
}

#[cfg(windows)]
fn cpu_secs() -> f64 {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };

    let empty = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (empty, empty, empty, empty);
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    let secs = |time: FILETIME| {
        ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) as f64
            / 10_000_000.0
    };
    secs(kernel) + secs(user)
}

async fn run(project_path: PathBuf, size: XY<u32>, fps: u32, runs: u32) -> anyhow::Result<()> {
    let output_dir = tempfile::tempdir()?;
    for run in 0..runs {
        let output_path = output_dir.path().join(format!("run-{run}.mp4"));
        let cancel = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let cpu_started = cpu_secs();
        let base = ExporterBase::builder(project_path.clone())
            .with_output_path(output_path.clone())
            .build_for_mp4(cancel)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let total = base.total_frames(fps);
        let prepared_ms = started.elapsed().as_secs_f64() * 1000.0;
        let path = Mp4ExportSettings {
            fps,
            resolution_base: size,
            compression: ExportCompression::Maximum,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            optimize_filesize: false,
        }
        .export_prepared(base, |_| true)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
        let wall = started.elapsed().as_secs_f64();
        let cpu = cpu_secs() - cpu_started;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        println!(
            "{}",
            serde_json::json!({
                "run": run,
                "frames": total,
                "width": size.x,
                "height": size.y,
                "fps": fps,
                "prepareMs": prepared_ms,
                "wallSecs": wall,
                "exportFps": f64::from(total) / wall,
                "cpuSecs": cpu,
                "bytes": bytes,
            })
        );
    }
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
    let mut number = |default: u32| {
        arguments
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let size = XY::new(number(1920), number(1080));
    let fps = number(60);
    let runs = number(3).max(1);

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()?
        .block_on(run(project_path, size, fps, runs))
}
