use cap_export::{ExporterBase, gif::GifExportSettings};
use cap_project::{ProjectConfiguration, XY};
use image::AnimationDecoder;
use std::{fs, path::Path, process::Command};

fn create_project(path: &Path) {
    fs::create_dir_all(path).unwrap();
    let video = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x64:rate=10:duration=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
        ])
        .arg(path.join("display.mp4"))
        .output()
        .unwrap();
    assert!(
        video.status.success(),
        "{}",
        String::from_utf8_lossy(&video.stderr)
    );
    fs::write(
        path.join("recording-meta.json"),
        serde_json::to_vec(&serde_json::json!({
            "pretty_name": "GIF cancellation",
            "display": { "path": "display.mp4", "fps": 10 }
        }))
        .unwrap(),
    )
    .unwrap();
}

async fn export(
    project: &Path,
    output: &Path,
    on_progress: impl FnMut(u32) -> bool + Send + 'static,
) -> Result<std::path::PathBuf, String> {
    let base = Box::pin(
        ExporterBase::builder(project.to_path_buf())
            .with_config(ProjectConfiguration::default())
            .with_output_path(output.to_path_buf())
            .build(),
    )
    .await
    .unwrap();
    Box::pin(
        GifExportSettings {
            fps: 10,
            resolution_base: XY::new(64, 64),
            quality: None,
        }
        .export(base, on_progress),
    )
    .await
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn cancelled_gif_leaves_no_partial_destination() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.gif");

    assert!(export(&project, &output, |frame| frame < 2).await.is_err());

    assert!(!output.exists());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn finished_gif_lands_at_the_destination() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.gif");
    let destination = output.clone();

    let result = export(&project, &output, move |_| {
        assert!(!destination.exists());
        true
    })
    .await
    .unwrap();

    assert_eq!(result, output);
    let frames = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
        fs::File::open(output).unwrap(),
    ))
    .unwrap()
    .into_frames()
    .collect_frames()
    .unwrap();
    assert!(!frames.is_empty());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}
