use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;
use cap_utils::list_recordings;

async fn run_export(project_path: PathBuf) -> Result<(PathBuf, Duration, u32), String> {
    let exporter_base = ExporterBase::builder(project_path.clone())
        .build()
        .await
        .map_err(|err| format!("Exporter build error: {err}"))?;

    let settings = Mp4ExportSettings {
        fps: 60,
        resolution_base: XY::new(1920, 1080),
        compression: ExportCompression::Minimal,
    };

    let start = Instant::now();
    let last_frame = Arc::new(AtomicU32::new(0));
    let frame_counter = Arc::clone(&last_frame);

    let output_path = settings
        .export(exporter_base, move |frame| {
            frame_counter.store(frame, Ordering::Relaxed)
        })
        .await
        .map_err(|err| format!("Exporter error: {err}"))?;

    let elapsed = start.elapsed();
    let frames = last_frame.load(Ordering::Relaxed);

    if frames == 0 {
        return Err("No frames were rendered during export".into());
    }

    Ok((output_path, elapsed, frames))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn export_latest_recording_benchmark() -> Result<(), Box<dyn std::error::Error>> {
    let recordings = list_recordings();

    println!("Found {} recordings", recordings.len());

    if recordings.is_empty() {
        return Err(
            "No recordings found. Add a Cap recording before running this benchmark.".into(),
        );
    }

    let Some(project_path) = recordings.first() else {
        unreachable!("recordings list cannot be empty here");
    };

    println!("Using project: {}", project_path.display());

    let (output_path, duration, frames) = run_export(project_path.clone()).await?;

    let fps = frames as f64 / duration.as_secs_f64();
    println!(
        "Export completed in {:.2?} ({} frames, {:.2} fps). Output: {}",
        duration,
        frames,
        fps,
        output_path.display()
    );

    Ok(())
}
