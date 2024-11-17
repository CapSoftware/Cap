use cap_media::{feeds::*, sources::*};

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_screens() -> Vec<CaptureScreen> {
    ScreenCaptureSource::<AVFrameCapture>::list_screens()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_windows() -> Vec<CaptureWindow> {
    ScreenCaptureSource::<AVFrameCapture>::list_windows()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<String> {
    CameraFeed::list_cameras()
}
