use cap_export::{ExporterBase, mov::MovExportSettings};
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
            "pretty_name": "MOV cancellation",
            "display": { "path": "display.mp4", "fps": 10 }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn assert_playable_mov(path: &Path) {
    let decoded = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
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
            .build_video_only(),
    )
    .await
    .unwrap();
    Box::pin(
        MovExportSettings {
            fps: 10,
            resolution_base: XY::new(64, 64),
            cursor_only: true,
        }
        .export(base, on_progress),
    )
    .await
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn cancelled_mov_preserves_existing_destination() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mov");
    fs::write(&output, b"existing export").unwrap();

    assert!(export(&project, &output, |frame| frame < 2).await.is_err());

    assert_eq!(fs::read(&output).unwrap(), b"existing export");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn dropped_export_keeps_temporary_output_owned_by_encoder() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mov");
    fs::write(&output, b"existing export").unwrap();

    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn(async move {
        let mut started_tx = Some(started_tx);
        export(&project, &output, move |_| {
            if let Some(started_tx) = started_tx.take() {
                let _ = started_tx.send(());
            }
            release_rx.recv().unwrap();
            false
        })
        .await
    });

    started_rx.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let temporary_exists = fs::read_dir(directory.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".cap-export-")
    });
    release_tx.send(()).unwrap();

    assert!(temporary_exists);
    assert_eq!(
        fs::read(directory.path().join("export.mov")).unwrap(),
        b"existing export"
    );
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn finished_mov_replaces_existing_destination() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mov");
    fs::write(&output, b"existing export").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let destination = output.clone();

    let result = export(&project, &output, move |_| {
        assert_eq!(fs::read(&destination).unwrap(), b"existing export");
        true
    })
    .await
    .unwrap();

    assert_eq!(result, output);
    assert_playable_mov(&output);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn mov_reports_destination_replacement_failure() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mov");
    fs::create_dir(&output).unwrap();

    assert!(export(&project, &output, |_| true).await.is_err());

    assert!(output.is_dir());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn finished_mov_creates_new_destination() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mov");
    let destination = output.clone();

    let result = export(&project, &output, move |_| {
        assert!(!destination.exists());
        true
    })
    .await
    .unwrap();

    assert_eq!(result, output);
    assert_playable_mov(&output);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}
