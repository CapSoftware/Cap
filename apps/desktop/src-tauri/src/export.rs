use crate::{
    get_video_metadata, upsert_editor_instance, windows::ShowCapWindow, RenderProgress, VideoType,
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
) -> Result<PathBuf, String> {
    sentry::configure_scope(|scope| {
        scope.set_tag("cmd", "export_video");
    });

    let (duration, _size) =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen))
            .await
            .unwrap();

    // 30 FPS (calculated for output video)
    let total_frames = (duration * 30.0).round() as u32;

    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;

    let output_path = editor_instance.meta().output_path();

    // If the file exists, return it immediately
    if output_path.exists() && !force {
        return Ok(output_path);
    }

    progress
        .send(RenderProgress::EstimatedTotalFrames { total_frames })
        .ok();

    cap_export::export_video_to_file(
        project,
        output_path.clone(),
        move |current_frame| {
            progress
                .send(RenderProgress::FrameRendered { current_frame })
                .ok();
        },
        &editor_instance.project_path,
        editor_instance.meta(),
        editor_instance.render_constants.clone(),
        &editor_instance.segments,
    )
    .await
    .map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    ShowCapWindow::PrevRecordings.show(&app).ok();

    Ok(output_path)
}
