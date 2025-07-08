use crate::{get_video_metadata, FramesRendered};
use cap_export::ExporterBase;
use cap_project::{RecordingMeta, XY};
use serde::Deserialize;
use specta::Type;
use std::path::PathBuf;
use tracing::info;

#[derive(Deserialize, Clone, Copy, Debug, Type)]
#[serde(tag = "format")]
pub enum ExportSettings {
    Mp4(cap_export::mp4::Mp4ExportSettings),
    Gif(cap_export::gif::GifExportSettings),
}

impl ExportSettings {
    fn fps(&self) -> u32 {
        match self {
            ExportSettings::Mp4(settings) => settings.fps,
            ExportSettings::Gif(settings) => settings.fps,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn export_video(
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
) -> Result<PathBuf, String> {
    let exporter_base = ExporterBase::builder(project_path)
        .build()
        .await
        .map_err(|e| {
            sentry::capture_message(&e.to_string(), sentry::Level::Error);
            e.to_string()
        })?;

    let total_frames = exporter_base.total_frames(settings.fps());

    // Send initial progress state
    let _ = progress.send(FramesRendered {
        rendered_count: 0,
        total_frames,
    });

    // The callback that will be called by the exporter on each rendered frame.
    let on_progress = move |frame_index: u32| {
        // Sending progress might fail if the frontend window is closed.
        // In that case, we should signal to the exporter to stop.
        let result = progress.send(FramesRendered {
            rendered_count: (frame_index + 1).min(total_frames),
            total_frames,
        });

        // Returning 'true' to continue, 'false' to cancel.
        // This requires the `export` method in the `cap_export` crate
        // to check the boolean return of its progress callback.
        result.is_ok()
    };

    let output_path_result = match settings {
        ExportSettings::Mp4(settings) => settings.export(exporter_base, on_progress).await,
        ExportSettings::Gif(settings) => settings.export(exporter_base, on_progress).await,
    };

    let output_path = output_path_result.map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    info!("Export to {} completed", output_path.display());

    Ok(output_path)
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
}

// This command has been refactored to use more robust calculations instead of magic numbers.
#[tauri::command]
#[specta::specta]
pub async fn get_export_estimates(
    path: PathBuf,
    resolution: XY<u32>,
    fps: u32,
) -> Result<ExportEstimates, String> {
    let screen_metadata = get_video_metadata(path.clone()).await?;
    let camera_metadata = get_video_metadata(path.clone()).await.ok();

    let raw_duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    let meta = RecordingMeta::load_for_project(&path).unwrap();
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline
            .segments
            .iter()
            .map(|s| (s.end - s.start) / s.timescale)
            .sum()
    } else {
        raw_duration
    };

    let (width, height) = (resolution.x, resolution.y);
    let total_pixels = (width * height) as f64;

    // --- Refactored Size Estimation ---
    // Estimate bitrate based on a quality factor per megapixel. This is more robust
    // than hardcoded resolution tiers. 2.0 is a reasonable factor for good quality H.264.
    const BITS_PER_MEGAPIXEL_PER_SECOND: f64 = 2_000_000.0;
    let video_bitrate = (total_pixels / 1_000_000.0) * BITS_PER_MEGAPIXEL_PER_SECOND;

    // Adjust bitrate for frame rate. A higher FPS needs more bits.
    // We'll use a standard 30fps as the baseline.
    let fps_factor = (fps as f64 / 30.0).max(1.0);
    let adjusted_video_bitrate = video_bitrate * fps_factor;

    const AUDIO_BITRATE: f64 = 192_000.0; // 192 kbps is standard for good quality audio.
    let total_bitrate = adjusted_video_bitrate + AUDIO_BITRATE;

    // Size in Megabytes = (Total bits per second * duration) / (bits in a byte * bytes in a MB)
    let estimated_size_mb = (total_bitrate * duration_seconds) / (8.0 * 1024.0 * 1024.0);

    // --- Refactored Time Estimation ---
    // Estimate processing time based on total pixels and a baseline processing speed.
    // This assumes a certain number of megapixels can be processed per second.
    // This value is an empirical guess and can be tuned.
    const MEGAPIXELS_PROCESSED_PER_SECOND: f64 = 25.0;
    let processing_time = (total_pixels / 1_000_000.0) / MEGAPIXELS_PROCESSED_PER_SECOND * duration_seconds;
    
    // Add a small constant overhead for file I/O and muxing.
    const OVERHEAD_TIME_SECONDS: f64 = 2.0;
    let estimated_time_seconds = processing_time + OVERHEAD_TIME_SECONDS;

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}
