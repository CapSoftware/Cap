use cap_desktop_lib::{
    export::{export_project, ExportInput},
    ProjectConfiguration,
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
        project_path: project_path.to_str().unwrap().to_string(),
        ..Default::default()
    };

    let result = export_project(app_handle, export_input).await;
    assert!(result.is_ok(), "Failed to export (save/render) file");

    let output_path = result.unwrap();
    assert!(
        fs::metadata(output_path).is_ok(),
        "Exported file does not exist"
    );
}
