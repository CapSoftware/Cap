use cap_project::RecordingMeta;
use std::path::PathBuf;
use tauri::Manager;
use tracing::{error, info};
use uuid::Uuid;

#[tauri::command]
pub fn get_projects_dir(app: tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data.join("recordings"))
}

#[tauri::command]
#[specta::specta]
pub async fn import_video_to_project(
    app: tauri::AppHandle,
    video_path: PathBuf,
) -> Result<String, String> {
    info!("Attempting to import video from path: {:?}", video_path);

    // Verify the video file exists and is MP4
    if !video_path.exists() {
        let err = format!("Video path {:?} not found!", video_path);
        error!("{}", err);
        return Err(err);
    }

    if video_path.extension().and_then(|ext| ext.to_str()) != Some("mp4") {
        return Err("Only MP4 files are supported".to_string());
    }

    let project_id = Uuid::new_v4().to_string();
    info!("Generated project ID: {}", project_id);

    // Create the project directory with .cap extension
    let project_dir = get_projects_dir(app)?.join(format!("{}.cap", project_id));
    info!("Project directory: {:?}", project_dir);

    std::fs::create_dir_all(&project_dir).map_err(|e| {
        let err = format!("Failed to create project directory: {}", e);
        error!("{}", err);
        err
    })?;

    let content_dir = project_dir.join("content");
    info!("Creating content directory: {:?}", content_dir);

    std::fs::create_dir_all(&content_dir).map_err(|e| {
        let err = format!("Failed to create content directory: {}", e);
        error!("{}", err);
        err
    })?;

    // Always copy to display.mp4
    let project_video_path = content_dir.join("display.mp4");
    info!("Copying video to: {:?}", project_video_path);

    std::fs::copy(&video_path, &project_video_path).map_err(|e| {
        let err = format!("Failed to copy video file: {}", e);
        error!("{}", err);
        err
    })?;

    // Create project metadata
    let meta = RecordingMeta {
        project_path: project_dir.clone(),
        sharing: None,
        pretty_name: format!(
            "Imported Video {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        display: cap_project::Display {
            path: PathBuf::from("content").join("display.mp4"), // Always use display.mp4
        },
        camera: None,
        audio: None,
        segments: vec![],
        cursor: None,
    };

    meta.save_for_project();
    info!("Project metadata saved successfully");

    Ok(project_id)
}
