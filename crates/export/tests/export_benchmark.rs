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

pub fn get_recordings_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    for app_name in ["Cap - Development", "Cap"] {
        if let Some(proj_dirs) = ProjectDirs::from("so", "cap", app_name) {
            candidates.push(proj_dirs.data_dir().join("recordings"));
        }
    }

    if let Some(base_dirs) = BaseDirs::new() {
        let data_dir = base_dirs.data_dir();
        for identifier in ["so.cap.desktop.dev", "so.cap.desktop"] {
            candidates.push(data_dir.join(identifier).join("recordings"));
        }
    }

    candidates.into_iter().find(|dir| dir.exists())
}

pub fn list_recordings() -> Vec<PathBuf> {
    let Some(recordings_dir) = get_recordings_dir() else {
        return Vec::new();
    };

    let Ok(entries) = fs::read_dir(&recordings_dir) else {
        return Vec::new();
    };

    let mut recordings: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();

            if !path.is_dir() {
                return None;
            }

            if !path.join("project-config.json").exists()
                || !path.join("recording-meta.json").exists()
            {
                return None;
            }

            let created = path
                .metadata()
                .and_then(|m| m.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            Some((created, path))
        })
        .collect();

    recordings.sort_by(|a, b| b.0.cmp(&a.0));

    recordings.into_iter().map(|(_, path)| path).collect()
}
