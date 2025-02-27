use crate::{
    create_editor_instance_impl, get_video_metadata, recordings_path, windows::ShowCapWindow,
    AuthStore, RenderProgress, VideoType,
};
use cap_editor::EditorInstance;
use cap_project::{ProjectConfiguration, RecordingMeta, XY};
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn export_video(
    app: AppHandle,
    video_id: String,
    progress: tauri::ipc::Channel<RenderProgress>,
    force: bool,
    fps: u32,
    resolution_base: XY<u32>,
) -> Result<PathBuf, String> {
    let editor_instance = create_editor_instance_impl(&app, &video_id).await?;

    let screen_metadata =
        match get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen)).await {
            Ok(meta) => meta,
            Err(e) => {
                sentry::capture_message(
                    &format!("Failed to get video metadata: {}", e),
                    sentry::Level::Error,
                );
                return Err(
                "Failed to read video metadata. The recording may be from an incompatible version."
                    .to_string(),
            );
            }
        };

    // Get camera metadata if it exists
    let camera_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Camera))
            .await
            .ok();

    // Use the longer duration between screen and camera
    let duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    let total_frames = editor_instance.get_total_frames(fps);

    let output_path = editor_instance.meta().output_path();

    // If the file exists and we're not forcing a re-render, return it
    if output_path.exists() && !force {
        return Ok(output_path);
    }

    progress
        .send(RenderProgress::EstimatedTotalFrames { total_frames })
        .ok();

    // Create a modified project configuration that accounts for different video lengths
    let mut modified_project = editor_instance.project_config.1.borrow().clone();
    if let Some(timeline) = &mut modified_project.timeline {
        // Ensure timeline duration matches the longest video
        for segment in timeline.segments.iter_mut() {
            if segment.end > duration {
                segment.end = duration;
            }
        }
    }

    let is_upgraded = AuthStore::get(&app)
        .ok()
        .flatten()
        .map(|auth| auth.is_upgraded())
        .unwrap_or(false);

    let exporter = cap_export::Exporter::new(
        modified_project,
        output_path.clone(),
        move |frame_index| {
            // Ensure progress never exceeds total frames
            let current_frame = (frame_index + 1).min(total_frames);
            progress
                .send(RenderProgress::FrameRendered { current_frame })
                .ok();
        },
        editor_instance.project_path.clone(),
        editor_instance.meta(),
        editor_instance.render_constants.clone(),
        &editor_instance.segments,
        fps,
        resolution_base,
        is_upgraded,
    )
    .await
    .map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    let result = exporter.export_with_custom_muxer().await;

    match result {
        Ok(_) => {
            ShowCapWindow::RecordingsOverlay.show(&app).ok();
            Ok(output_path)
        }
        Err(e) => {
            sentry::capture_message(&e.to_string(), sentry::Level::Error);
            Err(e.to_string())
        }
    }
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
    app: AppHandle,
    video_id: String,
    resolution: XY<u32>,
    fps: u32,
) -> Result<ExportEstimates, String> {
    let screen_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen)).await?;
    let camera_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Camera))
            .await
            .ok();

    let raw_duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    let project_path = EditorInstance::project_path(&recordings_path(&app), &video_id);
    let meta = RecordingMeta::load_for_project(&project_path).unwrap();
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
