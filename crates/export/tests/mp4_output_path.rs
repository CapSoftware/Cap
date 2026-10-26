use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::{ProjectConfiguration, XY};
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
            "pretty_name": "MP4 output path",
            "display": { "path": "display.mp4", "fps": 10 }
        }))
        .unwrap(),
    )
    .unwrap();
}

async fn export(project: &Path, output: &Path) -> Result<std::path::PathBuf, String> {
    let base = Box::pin(
        ExporterBase::builder(project.to_path_buf())
            .with_config(ProjectConfiguration::default())
            .with_output_path(output.to_path_buf())
            .build(),
    )
    .await
    .unwrap();
    Box::pin(
        Mp4ExportSettings {
            fps: 10,
            resolution_base: XY::new(64, 64),
            compression: ExportCompression::Maximum,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            optimize_filesize: false,
        }
        .export(base, |_| true),
    )
    .await
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn mp4_export_returns_the_path_it_wrote() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);

    for requested in ["export.gif", "export.webm", "export"] {
        let written = export(&project, &directory.path().join(requested))
            .await
            .unwrap();
        assert_eq!(written, directory.path().join("export.mp4"), "{requested}");
        assert!(written.is_file(), "{requested}");
        assert!(!directory.path().join(requested).exists(), "{requested}");
        fs::remove_file(&written).unwrap();
    }
}
