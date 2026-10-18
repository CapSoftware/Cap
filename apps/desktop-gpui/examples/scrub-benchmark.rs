//! Paused-scrub benchmark: drags the playhead through an `EditorInstance` the
//! way the editor's ruler drag does (`preview_tx` pushes at the 60 fps preview
//! clock and the default Half preview size), on the app's two-worker runtime,
//! and reports per-frame request-to-frame latency at several depths into the
//! recording plus the process CPU time spent dragging.
//!
//! The editor can write `project-config.json` back into the project, so point
//! it at a copy rather than a recording in the library.
//!
//! Run: cargo run --release --example scrub-benchmark -- <project.cap> [STEPS] [STEP_FRAMES]

use std::{path::PathBuf, sync::Arc, time::Duration, time::Instant};

use cap_editor::{AudioOutput, EditorFrameFormat, EditorFrameOutput, EditorInstance};
use cap_project::XY;

const PREVIEW_FPS: u32 = 60;
const PREVIEW_RESOLUTION: XY<u32> = XY { x: 1248, y: 702 };
const REGION_FRACTIONS: [f64; 5] = [0.02, 0.17, 0.5, 0.83, 0.98];

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

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
}

fn frame_number(output: &EditorFrameOutput) -> u32 {
    match output {
        EditorFrameOutput::Rgba(frame) => frame.frame_number,
        EditorFrameOutput::Nv12(frame) => frame.frame_number,
        #[cfg(target_os = "macos")]
        EditorFrameOutput::Surface(frame) => frame.frame_number,
    }
}

async fn render(
    instance: &EditorInstance,
    frames: &flume::Receiver<u32>,
    frame: u32,
) -> anyhow::Result<f64> {
    while frames.try_recv().is_ok() {}
    let requested = Instant::now();
    instance
        .preview_tx
        .send_modify(|value| *value = Some((frame, PREVIEW_FPS, PREVIEW_RESOLUTION)));
    loop {
        let rendered = tokio::time::timeout(Duration::from_secs(30), frames.recv_async())
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for frame {frame}"))??;
        if rendered == frame {
            return Ok(requested.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

async fn run(project_path: PathBuf, steps: u32, step_frames: u32) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    let format = EditorFrameFormat::BgraSurface;
    #[cfg(not(target_os = "macos"))]
    let format = EditorFrameFormat::Rgba;

    let (frame_tx, frame_rx) = flume::unbounded::<u32>();
    let audio_output = Arc::new(AudioOutput::new_headless(Box::new(|_samples, _at| {})));
    let instance = EditorInstance::new_with_audio_output_and_frame_format(
        project_path.clone(),
        |_state| {},
        Box::new(move |output, _layout| {
            let _ = frame_tx.send(frame_number(&output));
        }),
        None,
        format,
        audio_output,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    let duration = instance
        .project_config
        .1
        .borrow()
        .timeline
        .as_ref()
        .map_or(0.0, |timeline| timeline.duration());
    let last_frame = ((duration * PREVIEW_FPS as f64) as u32).saturating_sub(1);
    let drag_frames = steps.saturating_mul(step_frames);
    anyhow::ensure!(
        drag_frames <= last_frame,
        "a {drag_frames}-frame drag does not fit in this {duration:.1}s project; pass fewer STEPS or STEP_FRAMES"
    );
    render(&instance, &frame_rx, 0).await?;

    let mut regions = Vec::new();
    let mut drag = Vec::new();
    let mut drag_cpu_secs = 0.0;
    for fraction in REGION_FRACTIONS {
        let start = ((last_frame as f64 * fraction) as u32).min(last_frame - drag_frames);
        let seek_ms = render(&instance, &frame_rx, start).await?;
        let cpu_started = cpu_secs();
        let mut latencies = Vec::with_capacity(steps as usize);
        for step in 1..=steps {
            latencies.push(render(&instance, &frame_rx, start + step * step_frames).await?);
        }
        drag_cpu_secs += cpu_secs() - cpu_started;
        drag.extend_from_slice(&latencies);
        latencies.sort_by(f64::total_cmp);
        regions.push(serde_json::json!({
            "atSecs": start as f64 / PREVIEW_FPS as f64,
            "seekMs": seek_ms,
            "dragMedianMs": percentile(&latencies, 0.5),
            "dragP95Ms": percentile(&latencies, 0.95),
        }));
    }
    drag.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({
            "project": project_path,
            "durationSecs": duration,
            "steps": steps,
            "stepFrames": step_frames,
            "regions": regions,
            "dragMedianMs": percentile(&drag, 0.5),
            "dragP95Ms": percentile(&drag, 0.95),
            "dragCpuSecs": drag_cpu_secs,
        })
    );
    instance.dispose().await;
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
    let steps = arguments
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(30u32)
        .max(1);
    let step_frames = arguments
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4u32)
        .max(1);

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()?
        .block_on(run(project_path, steps, step_frames))
}
