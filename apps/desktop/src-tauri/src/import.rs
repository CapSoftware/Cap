pub async fn from(
    app: AppHandle,
    path: PathBuf,
    channel: Channel<UploadProgress>,
) -> Result<UploadResult, String> {
    // Importing always requires Pro
    {
        let Ok(Some(auth)) = AuthStore::get(&app) else {
            AuthStore::set(&app, None).map_err(|e| e.to_string())?;
            return Ok(UploadResult::NotAuthenticated);
        };

        if !auth.is_upgraded() {
            return Ok(UploadResult::UpgradeRequired);
        }
    }

    // Validate source file exists and is a valid video
    if !path.exists() {
        return Err("Source video file does not exist".to_string());
    }

    if !is_valid_video(&path) {
        return Err("Source file is not a valid video".to_string());
    }

    // Build metadata to check duration for plan constraints
    let source_metadata =
        build_video_meta(&path).map_err(|err| format!("Error getting source video meta: {err}"))?;

    // 2) Create new project dir
    let id = uuid::Uuid::new_v4().to_string();
    let recording_dir = recordings_path(&app).join(format!("{id}.cap"));
    std::fs::create_dir_all(&recording_dir)
        .map_err(|e| format!("Failed to create recording directory: {e}"))?;

    // 3) Transcode input to standard MP4
    let output_dir = recording_dir.join("output");
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {e}"))?;
    let output_mp4 = output_dir.join("result.mp4");

    transcode_to_mp4(&path, &output_mp4).await?;

    // 4) Generate thumbnail
    let screenshot_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshot_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;
    let screenshot_path = screenshot_dir.join("display.jpg");

    create_screenshot(output_mp4.clone(), screenshot_path.clone(), None).await?;

    // 5) Create and persist RecordingMeta (Studio SingleSegment)
    let pretty_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Video")
        .to_string();

    use cap_project::*;
    let mut meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.clone(),
        sharing: None,
        pretty_name: pretty_name.clone(),
        inner: RecordingMetaInner::Studio(StudioRecordingMeta::SingleSegment {
            segment: SingleSegment {
                display: VideoMeta {
                    path: RelativePathBuf::from_path("output/result.mp4").unwrap(),
                    fps: 30, // Standard fps as per spec
                    start_time: None,
                },
                camera: None,
                audio: None,
                cursor: None,
            },
        }),
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e:?}"))?;

    // 6) Create/get S3 upload config
    let s3_meta = build_video_meta(&output_mp4)
        .map_err(|err| format!("Error getting output video meta: {err}"))?;

    let s3_config = create_or_get_video(
        &app,
        false,
        None,
        Some(meta.pretty_name.clone()),
        Some(s3_meta.clone()),
    )
    .await?;

    // 7) Persist upload state to meta and save
    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: output_mp4.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: recording_dir.clone(),
    });
    meta.save_for_project()
        .map_err(|e| error!("Failed to save recording meta: {e}"))
        .ok();

    // 8) Upload (single-part)
    match upload_video(
        &app,
        s3_config.id.clone(),
        output_mp4,
        screenshot_path,
        s3_meta,
        Some(channel.clone()),
    )
    .await
    {
        Ok(uploaded_video) => {
            channel.send(UploadProgress { progress: 1.0 }).ok();

            meta.upload = Some(UploadMeta::Complete);
            meta.sharing = Some(SharingMeta {
                link: uploaded_video.link.clone(),
                id: uploaded_video.id.clone(),
            });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            let _ = app
                .state::<ArcLock<ClipboardContext>>()
                .write()
                .await
                .set_text(uploaded_video.link.clone());

            NotificationType::ShareableLinkCopied.send(&app);
            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(e) => {
            error!("Failed to upload video: {e}");

            NotificationType::UploadFailed.send(&app);

            meta.upload = Some(UploadMeta::Failed { error: e.clone() });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            Err(e)
        }
    }
}
