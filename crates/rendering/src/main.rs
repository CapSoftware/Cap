use std::path::PathBuf;

use cap_project::{BackgroundSource, ProjectConfiguration, RecordingMeta};
use cap_rendering::{render_video_to_file, OnTheFlyVideoDecoderActor};

#[tokio::main]
async fn main() {
    let project_path = PathBuf::from(
        r#"/Users/brendonovich/Library/Application Support/so.cap.desktop-solid/recordings/414f2abd-8186-479f-85e7-08a64411a33c.cap"#,
    );

    let mut project: ProjectConfiguration = ProjectConfiguration::default();

    project.camera.position.x = cap_project::CameraXPosition::Right;
    project.camera.position.y = cap_project::CameraYPosition::Top;
    project.camera.rounding = 0;
    project.camera.mirror = false;

    project.background.source = BackgroundSource::Gradient {
        from: [71, 133, 255],
        to: [255, 71, 102],
    };
    project.background.rounding = 0;
    project.background.padding = 0;

    let meta: RecordingMeta = serde_json::from_str(
        &std::fs::read_to_string(project_path.join("recording-meta.json")).unwrap(),
    )
    .unwrap();

    render_video_to_file(
        cap_rendering::RenderOptions {
            screen_recording_path: project_path.join("content/display.mp4"),
            webcam_recording_path: project_path.join("content/camera.mp4"),
            camera_size: meta.camera.map(|c| (c.width, c.height)).unwrap_or_default(),
            screen_size: (meta.display.width, meta.display.height),
            output_size: (1920, 1080),
        },
        project,
        project_path.join("output/result.mp4"),
        OnTheFlyVideoDecoderActor::new(project_path.join("content/display.mp4").clone()),
        OnTheFlyVideoDecoderActor::new(project_path.join("content/camera.mp4").clone()),
    )
    .await
    .ok();
}