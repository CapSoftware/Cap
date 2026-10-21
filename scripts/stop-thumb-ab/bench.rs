
#[cfg(test)]
mod stop_bench {
    use super::*;

    fn project_for(
        source: &std::path::Path,
        dir: &std::path::Path,
    ) -> cap_project::StudioRecordingMeta {
        use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta};

        std::fs::create_dir_all(dir.join("content")).unwrap();
        std::fs::copy(source, dir.join("content/display.mp4")).unwrap();
        let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "display": { "path": "content/display.mp4", "fps": 30 }
        }))
        .unwrap();
        RecordingMeta {
            platform: None,
            project_path: dir.to_path_buf(),
            pretty_name: "Bench".into(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(meta.clone())),
            upload: None,
        }
        .save_for_project()
        .unwrap();
        cap_project::ProjectConfiguration::default()
            .write(dir)
            .unwrap();
        meta
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "stop bench"]
    async fn bench_studio_stop_to_idle() {
        let _ = ffmpeg::init();
        let label = std::env::var("CAP_STOP_BENCH_LABEL").unwrap();
        let round = std::env::var("CAP_STOP_BENCH_ROUND").unwrap();
        let runs: usize = std::env::var("CAP_STOP_BENCH_RUNS").unwrap().parse().unwrap();
        let root = PathBuf::from(std::env::var("CAP_STOP_BENCH_DIR").unwrap());
        let sources = std::env::var("CAP_STOP_BENCH_SOURCES").unwrap();
        for source in sources.split(',') {
            let source = std::path::Path::new(source);
            let name = source.file_stem().unwrap().to_string_lossy().to_string();
            for run in 0..runs {
                let dir = root.join(format!("{label}-{round}-{run}-{name}.cap"));
                let meta = project_for(source, &dir);
                let thumbnail = crate::library::bundle_thumbnail_path(&dir);
                let completed = studio_recording::CompletedRecording {
                    project_path: dir.clone(),
                    meta,
                    cursor_data: Default::default(),
                    clean_stopped: None,
                };
                let (publisher, finalization) = StudioFinalization::channel(dir.clone(), 1);
                publisher.capture_stopped();
                let started = std::time::Instant::now();
                let task = tokio::spawn(finalize_studio(
                    completed,
                    ScreenCaptureTarget::CameraOnly,
                    Some(publisher),
                    None,
                ));
                finalization.wait().await.unwrap();
                let editor_ms = started.elapsed().as_secs_f64() * 1e3;
                task.await.unwrap().unwrap();
                let idle_ms = started.elapsed().as_secs_f64() * 1e3;
                while !thumbnail.is_file() {
                    assert!(started.elapsed() < std::time::Duration::from_secs(60));
                    tokio::time::sleep(std::time::Duration::from_micros(500)).await;
                }
                let thumbnail_ms = started.elapsed().as_secs_f64() * 1e3;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let image = image::open(&thumbnail).unwrap().into_rgb8();
                let (width, height) = image.dimensions();
                let bytes = std::fs::metadata(&thumbnail).unwrap().len();
                println!(
                    "STOPBENCH,{label},{round},{run},{name},{width}x{height},{bytes},{editor_ms:.2},{idle_ms:.2},{thumbnail_ms:.2}"
                );
                std::fs::remove_dir_all(&dir).unwrap();
            }
        }
    }
}
