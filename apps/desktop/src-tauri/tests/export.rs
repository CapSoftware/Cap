use cap_desktop_lib::{
    ProjectConfiguration,
    export::{ExportInput, export_project},
};
use common::setup_test_app;
use std::fs;
use tempfile::tempdir;

mod common;

#[tokio::test]
async fn test_save_and_render_file() {
    let app = setup_test_app();
    let app_handle = app.handle().clone();

    let dir = tempdir().unwrap();
    let project_path = dir.path().join("test_project");
    fs::create_dir_all(&project_path).unwrap();

    let config = ProjectConfiguration::default();
    // Write the config to the canonical location expected by the export logic.
    config.write(&project_path).expect("failed to write project-config.json");
    let export_input = ExportInput {
        project_path: project_path.to_string_lossy().into_owned(),
        ..Default::default()
    };

    let output_path = export_project(app_handle, export_input)
        .await
        .expect("Failed to export (save/render) file");

    let meta = fs::metadata(&output_path).expect("Exported file does not exist");
    assert!(meta.is_file(), "Exported path is not a file");
    assert_eq!(
        output_path.extension().and_then(|s| s.to_str()),
        Some("mp4")
    );
}
