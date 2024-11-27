#[cfg(test)]
mod tests {
    use super::*;
    use tauri::AppHandle;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_start_recording() {
        let app = AppHandle::default();
        let state = MutableState::default();
        let result = start_recording(app, state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_stop_recording() {
        let app = AppHandle::default();
        let state = MutableState::default();
        let result = stop_recording(app, state).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_copy_file_to_path() {
        let app = AppHandle::default();
        let src = "test_src.txt".to_string();
        let dst = "test_dst.txt".to_string();
        let result = copy_file_to_path(app, src, dst).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_copy_screenshot_to_clipboard() {
        let app = AppHandle::default();
        let path = PathBuf::from("test_screenshot.png");
        let result = copy_screenshot_to_clipboard(app, path).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_export_video() {
        let app = AppHandle::default();
        let video_id = "test_video_id".to_string();
        let project = ProjectConfiguration::default();
        let progress = tauri::ipc::Channel::new(|_| Ok(()));
        let result = export_video(app, video_id, project, progress, true).await;
        assert!(result.is_ok());
    }
}
