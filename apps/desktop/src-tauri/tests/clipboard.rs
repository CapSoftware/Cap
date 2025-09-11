use cap_desktop_lib::copy_screenshot_to_clipboard;
use common::setup_test_app;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

mod common;

#[tokio::test]
async fn test_copy_to_clipboard() {
    let app = setup_test_app();
    let clipboard_state = app.state();

    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test_image.png");

    // Create a dummy image file
    let mut file = File::create(&file_path).unwrap();
    file.write_all(include_bytes!("./test_image.png"))
        .unwrap();

    let result = copy_screenshot_to_clipboard(
        clipboard_state,
        file_path.to_str().unwrap().to_string(),
    )
    .await;

    assert!(result.is_ok(), "Failed to copy to clipboard");
}
