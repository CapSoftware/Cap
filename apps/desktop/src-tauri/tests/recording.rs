use cap_desktop_lib::{
    recording::{start_recording, stop_recording, StartRecordingInputs},
    RecordingMode,
};
use common::setup_test_app;
use scap_targets::available_displays;
use tauri::Manager;

mod common;

#[tokio::test]
async fn test_start_and_stop_recording() {
    let app = setup_test_app();
    let window = app.get_window("main").unwrap();

    let displays = available_displays().unwrap();
    let first_display = displays.first().expect("No display found");

    let inputs = StartRecordingInputs {
        mode: RecordingMode::Instant,
        target: cap_recording::sources::ScreenCaptureTarget::Display {
            id: first_display.id(),
        },
        ..Default::default()
    };

    let app_handle = app.handle().clone();
    let state = app.state::<tauri::async_runtime::Mutex<cap_desktop_lib::App>>();

    start_recording(app_handle.clone(), state.clone(), inputs)
        .await
        .expect("Failed to start recording");

    let result = stop_recording(app_handle, state)
        .await
        .expect("Failed to stop recording");

    assert!(result.is_some(), "Stopping the recording did not return a completed recording");
}
