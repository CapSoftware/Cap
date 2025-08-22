use crate::{FramesRendered, get_video_metadata};
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

    let _ = progress.send(FramesRendered {
        rendered_count: 0,
        total_frames,
    });

    let output_path = match settings {
        ExportSettings::Mp4(settings) => {
            settings
                .export(exporter_base, move |frame_index| {
                    // Ensure progress never exceeds total frames
                    let _ = progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    });
                })
                .await
        }
        ExportSettings::Gif(settings) => {
            settings
                .export(exporter_base, move |frame_index| {
                    // Ensure progress never exceeds total frames
                    let _ = progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    });
                })
                .await
        }
    }
    .map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    info!("Exported to {} completed", output_path.display());

    Ok(output_path)
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
}

// This will need to be refactored at some point to be more accurate.
#[tauri::command]
#[specta::specta]
pub async fn get_export_estimates(
    path: PathBuf,
    resolution: XY<u32>,
    fps: u32,
) -> Result<ExportEstimates, String> {
    let metadata = get_video_metadata(path.clone()).await?;

    let meta = RecordingMeta::load_for_project(&path).unwrap();
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };

    let (width, height) = (resolution.x, resolution.y);

    let base_bitrate = if width <= 1280 && height <= 720 {
        4_000_000.0
    } else if width <= 1920 && height <= 1080 {
        8_000_000.0
    } else if width <= 2560 && height <= 1440 {
        14_000_000.0
    } else {
        20_000_000.0
    };

    let fps_factor = (fps as f64) / 30.0;
    let video_bitrate = base_bitrate * fps_factor;

    let audio_bitrate = 192_000.0;

    let total_bitrate = video_bitrate + audio_bitrate;

    let estimated_size_mb = (total_bitrate * duration_seconds) / (8.0 * 1024.0 * 1024.0);

    let base_factor = match (width, height) {
        (w, h) if w <= 1280 && h <= 720 => 0.43,
        (w, h) if w <= 1920 && h <= 1080 => 0.64,
        (w, h) if w <= 2560 && h <= 1440 => 0.75,
        _ => 0.86,
    };

    let processing_time = duration_seconds * base_factor * fps_factor;
    let overhead_time = 0.0;

    let estimated_time_seconds = processing_time + overhead_time;

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}
