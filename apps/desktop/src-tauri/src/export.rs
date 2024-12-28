use crate::{
    get_video_metadata, upsert_editor_instance, windows::ShowCapWindow, RenderProgress,
    VideoRecordingMetadata, VideoType,
};
use cap_project::ProjectConfiguration;
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn export_video(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
    progress: tauri::ipc::Channel<RenderProgress>,
    force: bool,
    use_custom_muxer: bool,
) -> Result<PathBuf, String> {
    let metadata = match get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen)).await {
        Ok(meta) => meta,
        Err(e) => {
            sentry::capture_message(&format!("Failed to get video metadata: {}", e), sentry::Level::Error);
            return Err("Failed to read video metadata. The recording may be from an incompatible version.".to_string());
        }
    };

    let VideoRecordingMetadata { duration, .. } = metadata;

    // Calculate total frames with ceiling to ensure we don't exceed 100%
    let total_frames = ((duration * 30.0).ceil() as u32).max(1);

    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;

    let output_path = editor_instance.meta().output_path();

    // If the file exists and we're not forcing a re-render, return it
    if output_path.exists() && !force {
        return Ok(output_path);
    }

    progress
        .send(RenderProgress::EstimatedTotalFrames { total_frames })
        .ok();

    let exporter = cap_export::Exporter::new(
        project,
        output_path.clone(),
        move |frame_index| {
            // Ensure progress never exceeds total frames
            let current_frame = (frame_index + 1).min(total_frames);
            progress
                .send(RenderProgress::FrameRendered {
                    current_frame,
                })
                .ok();
        },
        editor_instance.project_path.clone(),
        editor_instance.meta(),
        editor_instance.render_constants.clone(),
        &editor_instance.segments,
    )
    .map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    let result = if use_custom_muxer {
        exporter.export_with_custom_muxer().await
    } else {
        exporter.export_with_ffmpeg_cli().await
    };

    match result {
        Ok(_) => {
            ShowCapWindow::PrevRecordings.show(&app).ok();
            Ok(output_path)
        }
        Err(e) => {
            sentry::capture_message(&e.to_string(), sentry::Level::Error);
            Err(e.to_string())
        }
    }
}
