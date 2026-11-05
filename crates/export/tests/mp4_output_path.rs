use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings, turbo::TurboOptions},
};
use cap_project::{ProjectConfiguration, XY};
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{Arc, atomic::AtomicBool},
};

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

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn cancelled_mp4_preserves_the_previous_export() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mp4");
    fs::copy(project.join("display.mp4"), &output).unwrap();
    let previous = fs::read(&output).unwrap();
    let result = export_prepared(&project, &output, false, |frame| frame < 2).await;

    assert!(result.is_err(), "cancelled export returned {result:?}");
    assert!(
        fs::read(&output).unwrap() == previous,
        "cancelling a replacement export changed the previous video"
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

async fn export_prepared(
    project: &Path,
    output: &Path,
    turbo: bool,
    on_progress: impl FnMut(u32) -> bool + Send + 'static,
) -> Result<std::path::PathBuf, String> {
    let base = Box::pin(
        ExporterBase::builder(project.to_path_buf())
            .with_config(ProjectConfiguration::default())
            .with_output_path(output.to_path_buf())
            .build_for_mp4(Arc::new(AtomicBool::new(false))),
    )
    .await
    .unwrap();
    let settings = Mp4ExportSettings {
        fps: 10,
        resolution_base: XY::new(64, 64),
        compression: ExportCompression::Maximum,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    };
    if turbo {
        Box::pin(settings.export_prepared_turbo(
            base,
            TurboOptions {
                chunks: Some(1),
                strict: true,
            },
            on_progress,
        ))
        .await
    } else {
        Box::pin(settings.export_prepared(base, on_progress)).await
    }
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn cancelled_turbo_mp4_preserves_the_previous_export() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mp4");
    fs::copy(project.join("display.mp4"), &output).unwrap();
    let previous = fs::read(&output).unwrap();

    let result = export_prepared(&project, &output, true, |frame| frame < 2).await;

    assert!(result.is_err(), "cancelled export returned {result:?}");
    assert!(
        fs::read(&output).unwrap() == previous,
        "cancelling a replacement export changed the previous video"
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn finished_mp4_replaces_the_previous_export_only_after_encoding() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);

    for turbo in [false, true] {
        let output = directory.path().join("export.mp4");
        fs::write(&output, b"previous export").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let destination = output.clone();
        let result = export_prepared(&project, &output, turbo, move |_| {
            assert_eq!(fs::read(&destination).unwrap(), b"previous export");
            true
        })
        .await
        .unwrap();

        assert_eq!(result, output);
        let decoded = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&output)
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        assert!(
            decoded.status.success(),
            "{}",
            String::from_utf8_lossy(&decoded.stderr)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&output).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}

#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn mp4_does_not_replace_a_destination_created_while_exporting() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);

    for turbo in [false, true] {
        let output = directory.path().join("export.mp4");
        let destination = output.clone();
        let result = export_prepared(&project, &output, turbo, move |_| {
            fs::write(&destination, b"another export").unwrap();
            true
        })
        .await;

        assert!(
            result.is_err(),
            "export overwrote a new destination: {result:?}"
        );
        assert_eq!(fs::read(&output).unwrap(), b"another export");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
        fs::remove_file(output).unwrap();
    }
}

#[cfg(feature = "test-hooks")]
#[tokio::test]
#[ignore = "requires ffmpeg and a wgpu adapter"]
async fn mp4_replacement_restarts_after_encoder_failure() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project.cap");
    create_project(&project);
    let output = directory.path().join("export.mp4");
    fs::write(&output, b"previous export").unwrap();
    let mut base = Box::pin(
        ExporterBase::builder(project)
            .with_config(ProjectConfiguration::default())
            .with_output_path(output.clone())
            .build_for_mp4(Arc::new(AtomicBool::new(false))),
    )
    .await
    .unwrap();
    base.fail_video_encoder_at(2);
    let destination = output.clone();
    let export = Mp4ExportSettings {
        fps: 10,
        resolution_base: XY::new(64, 64),
        compression: ExportCompression::Maximum,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    }
    .export_prepared(base, move |_| {
        assert_eq!(fs::read(&destination).unwrap(), b"previous export");
        true
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), Box::pin(export))
        .await
        .expect("encoder failure must not leave the renderer blocked")
        .unwrap();

    assert_eq!(result, output);
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "10");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}
