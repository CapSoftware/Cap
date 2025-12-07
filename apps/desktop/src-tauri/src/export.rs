use crate::{FramesRendered, get_video_metadata};
use cap_export::ExporterBase;
use cap_project::RecordingMeta;
use serde::Deserialize;
use specta::Type;
use std::path::PathBuf;
use tracing::{info, instrument};

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
#[instrument(skip(progress))]
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
                    progress
                        .send(FramesRendered {
                            rendered_count: (frame_index + 1).min(total_frames),
                            total_frames,
                        })
                        .is_ok()
                })
                .await
        }
        ExportSettings::Gif(settings) => {
            settings
                .export(exporter_base, move |frame_index| {
                    // Ensure progress never exceeds total frames
                    progress
                        .send(FramesRendered {
                            rendered_count: (frame_index + 1).min(total_frames),
                            total_frames,
                        })
                        .is_ok()
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

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_export_estimates(
    path: PathBuf,
    settings: ExportSettings,
) -> Result<ExportEstimates, String> {
    let metadata = get_video_metadata(path.clone()).await?;

    let meta = RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())?;
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };

    let (resolution, fps) = match &settings {
        ExportSettings::Mp4(s) => (s.resolution_base, s.fps),
        ExportSettings::Gif(s) => (s.resolution_base, s.fps),
    };

    let (width, height) = (resolution.x, resolution.y);
    let total_pixels = (width * height) as f64;
    let fps_f64 = fps as f64;
    let total_frames = (duration_seconds * fps_f64).ceil();

    let (estimated_size_mb, time_factor) = match &settings {
        ExportSettings::Mp4(mp4_settings) => {
            let bits_per_pixel = mp4_settings.compression.bits_per_pixel() as f64;
            let video_bitrate = total_pixels * bits_per_pixel * fps_f64;
            let audio_bitrate = 192_000.0;
            let total_bitrate = video_bitrate + audio_bitrate;
            let size_mb = (total_bitrate * duration_seconds) / (8.0 * 1024.0 * 1024.0);

            let base_time_factor = match (width, height) {
                (w, h) if w <= 1280 && h <= 720 => 0.35,
                (w, h) if w <= 1920 && h <= 1080 => 0.50,
                (w, h) if w <= 2560 && h <= 1440 => 0.65,
                _ => 0.80,
            };

            let compression_factor = match mp4_settings.compression {
                cap_export::mp4::ExportCompression::Minimal => 1.0,
                cap_export::mp4::ExportCompression::Social => 1.1,
                cap_export::mp4::ExportCompression::Web => 1.15,
                cap_export::mp4::ExportCompression::Potato => 1.2,
            };

            (size_mb, base_time_factor * compression_factor)
        }
        ExportSettings::Gif(_) => {
            let bytes_per_frame = total_pixels * 0.5;
            let size_mb = (bytes_per_frame * total_frames) / (1024.0 * 1024.0);

            let base_time_factor = match (width, height) {
                (w, h) if w <= 1280 && h <= 720 => 0.8,
                (w, h) if w <= 1920 && h <= 1080 => 1.2,
                _ => 1.5,
            };

            (size_mb, base_time_factor)
        }
    };

    let fps_factor = fps_f64 / 30.0;
    let estimated_time_seconds = duration_seconds * time_factor * fps_factor;

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}
