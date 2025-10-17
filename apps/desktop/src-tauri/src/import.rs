use crate::{
    UploadProgress, UploadResult,
    auth::AuthStore,
    create_screenshot,
    general_settings::GeneralSettingsStore,
    is_valid_video,
    notifications::NotificationType,
    recordings_path,
    upload::{build_video_meta, create_or_get_video, upload_video},
};
use cap_project::{Platform, RecordingMeta, RecordingMetaInner, SharingMeta, UploadMeta};
use clipboard_rs::{Clipboard, ClipboardContext};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use tokio::sync::RwLock;
use tracing::{error, info};
use uuid;

type ArcLock<T> = std::sync::Arc<RwLock<T>>;
type Channel<T> = tauri::ipc::Channel<T>;

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
    let _source_metadata =
        build_video_meta(&path).map_err(|err| format!("Error getting source video meta: {err}"))?;

    // Create new project dir
    let id = uuid::Uuid::new_v4().to_string();
    let recording_dir = recordings_path(&app).join(format!("{id}.cap"));
    std::fs::create_dir_all(&recording_dir)
        .map_err(|e| format!("Failed to create recording directory: {e}"))?;

    // Generate pretty name from source file
    let pretty_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Video")
        .to_string();

    // Create and persist RecordingMeta with Upload type
    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.clone(),
        sharing: None,
        pretty_name: pretty_name.clone(),
        inner: RecordingMetaInner::Upload { from: path.clone() },
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e:?}"))?;

    info!("Created import project at: {:?}", recording_dir);

    // Start transcoding and upload process
    start_transcode_and_upload(app, meta, Some(channel)).await
}

async fn start_transcode_and_upload(
    app: AppHandle,
    mut meta: RecordingMeta,
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadResult, String> {
    let RecordingMetaInner::Upload { from } = &meta.inner else {
        return Err("Expected Upload recording type".to_string());
    };

    let source_path = from.clone();
    let recording_dir = meta.project_path.clone();

    info!("Starting transcode and upload for: {:?}", source_path);

    // Create output directory structure
    let output_dir = recording_dir.join("output");
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {e}"))?;
    let output_mp4 = output_dir.join("result.mp4");

    let screenshot_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshot_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;
    let screenshot_path = screenshot_dir.join("display.jpg");

    // Send initial progress
    if let Some(ref channel) = channel {
        channel.send(UploadProgress { progress: 0.1 }).ok();
    }

    // Transcode input to standard MP4
    transcode_to_mp4(&source_path, &output_mp4).await?;
    if let Some(ref channel) = channel {
        channel.send(UploadProgress { progress: 0.3 }).ok();
    }

    // Generate thumbnail
    create_screenshot(output_mp4.clone(), screenshot_path.clone(), None).await?;
    if let Some(ref channel) = channel {
        channel.send(UploadProgress { progress: 0.4 }).ok();
    }

    // Create S3 upload config
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

    // Persist upload state to meta and save
    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: output_mp4.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: recording_dir.clone(),
    });
    meta.save_for_project()
        .map_err(|e| error!("Failed to save recording meta: {e}"))
        .ok();

    if let Some(ref channel) = channel {
        channel.send(UploadProgress { progress: 0.5 }).ok();
    }

    // Upload video and screenshot
    match upload_video(
        &app,
        s3_config.id.clone(),
        output_mp4,
        screenshot_path,
        s3_meta,
        channel.clone(),
    )
    .await
    {
        Ok(uploaded_video) => {
            if let Some(ref channel) = channel {
                channel.send(UploadProgress { progress: 1.0 }).ok();
            }

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
            info!(
                "Import upload completed successfully: {}",
                uploaded_video.link
            );
            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(e) => {
            error!("Failed to upload imported video: {e}");

            NotificationType::UploadFailed.send(&app);

            meta.upload = Some(UploadMeta::Failed { error: e.clone() });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            Err(e)
        }
    }
}

/// Resume transcoding and uploading for import recordings that were interrupted
/// This is called at startup to handle any imports that were in progress when the app crashed
pub async fn resume_transcoding(app: AppHandle) -> Result<(), String> {
    let recordings_dir = recordings_path(&app);
    if !recordings_dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
            if let Ok(meta) = RecordingMeta::load_for_project(&path) {
                // Check if this is an Upload recording that needs resuming
                if let RecordingMetaInner::Upload { .. } = &meta.inner {
                    match &meta.upload {
                        // No upload started yet - resume from beginning
                        None => {
                            info!("Resuming import transcoding from beginning: {:?}", path);
                            let app_clone = app.clone();
                            tokio::spawn(async move {
                                if let Err(e) = start_transcode_and_upload(
                                    app_clone, meta,
                                    None, // no progress updates for background resume
                                )
                                .await
                                {
                                    error!("Failed to resume import transcoding: {e}");
                                }
                            });
                        }
                        // Upload failed - retry from upload step
                        Some(UploadMeta::Failed { .. }) => {
                            info!("Retrying failed import upload: {:?}", path);
                            let app_clone = app.clone();
                            tokio::spawn(async move {
                                if let Err(e) = start_transcode_and_upload(
                                    app_clone, meta,
                                    None, // no progress updates for background resume
                                )
                                .await
                                {
                                    error!("Failed to retry import upload: {e}");
                                }
                            });
                        }
                        // Upload in progress - resume upload only
                        Some(UploadMeta::SinglePartUpload {
                            video_id,
                            file_path,
                            screenshot_path,
                            recording_dir,
                        }) => {
                            info!("Resuming import upload: {:?}", path);
                            let app_clone = app.clone();
                            let video_id = video_id.clone();
                            let file_path = file_path.clone();
                            let screenshot_path = screenshot_path.clone();
                            let recording_dir = recording_dir.clone();

                            tokio::spawn(async move {
                                if let Ok(s3_meta) = build_video_meta(&file_path)
                                    .map_err(|error| {
                                        error!("Failed to resume import upload - error getting video metadata: {error}");

                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir) {
                                            meta.upload = Some(UploadMeta::Failed { error });
                                            meta.save_for_project()
                                                .map_err(|err| error!("Error saving project metadata: {err}"))
                                                .ok();
                                        }
                                    })
                                {
                                    match upload_video(
                                        &app_clone,
                                        video_id,
                                        file_path,
                                        screenshot_path,
                                        s3_meta,
                                        None,
                                    )
                                    .await
                                    {
                                        Ok(uploaded_video) => {
                                            if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir) {
                                                meta.upload = Some(UploadMeta::Complete);
                                                meta.sharing = Some(SharingMeta {
                                                    link: uploaded_video.link.clone(),
                                                    id: uploaded_video.id.clone(),
                                                });
                                                meta.save_for_project()
                                                    .map_err(|e| error!("Failed to save recording meta: {e}"))
                                                    .ok();
                                            }

                                            let _ = app_clone
                                                .state::<ArcLock<ClipboardContext>>()
                                                .write()
                                                .await
                                                .set_text(uploaded_video.link.clone());

                                            NotificationType::ShareableLinkCopied.send(&app_clone);
                                            info!("Resumed import upload completed successfully: {}", uploaded_video.link);
                                        }
                                        Err(error) => {
                                            error!("Error completing resumed import upload: {error}");

                                            if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir) {
                                                meta.upload = Some(UploadMeta::Failed { error });
                                                meta.save_for_project()
                                                    .map_err(|err| error!("Error saving project metadata: {err}"))
                                                    .ok();
                                            }
                                        }
                                    }
                                }
                            });
                        }
                        // Already complete - nothing to do
                        Some(UploadMeta::Complete) | Some(UploadMeta::MultipartUpload { .. }) => {
                            // MultipartUpload is handled by the existing resume_uploads function
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

async fn transcode_to_mp4(input: &Path, output: &Path) -> Result<(), String> {
    let input = input.to_path_buf();
    let output = output.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut ictx =
            ffmpeg::format::input(&input).map_err(|e| format!("Failed to open input file: {e}"))?;

        let video_stream_index = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| "No video stream found".to_string())?
            .index();

        let video_stream_params = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .parameters();

        let video_stream_time_base = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .time_base();

        let mut octx = ffmpeg::format::output(&output)
            .map_err(|e| format!("Failed to create output context: {e}"))?;

        let global_header = octx
            .format()
            .flags()
            .contains(ffmpeg::format::Flags::GLOBAL_HEADER);

        // Create video encoder (H.264)
        let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::H264)
            .ok_or_else(|| "H.264 encoder not found".to_string())?;

        let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .map_err(|e| format!("Failed to create encoder: {e}"))?;

        let mut decoder = ffmpeg::codec::context::Context::from_parameters(video_stream_params)
            .map_err(|e| format!("Failed to create decoder context: {e}"))?
            .decoder()
            .video()
            .map_err(|e| format!("Failed to create video decoder: {e}"))?;

        // Configure encoder with proper settings
        encoder.set_width(decoder.width());
        encoder.set_height(decoder.height());
        encoder.set_format(ffmpeg::format::Pixel::YUV420P);
        encoder.set_time_base(video_stream_time_base);

        if global_header {
            encoder.set_flags(ffmpeg::codec::flag::Flags::GLOBAL_HEADER);
        }

        let mut encoder = encoder
            .open_as(codec)
            .map_err(|e| format!("Failed to open encoder: {e}"))?;

        let output_video_stream_index = {
            let mut output_video_stream = octx
                .add_stream(codec)
                .map_err(|e| format!("Failed to add output stream: {e}"))?;

            output_video_stream.set_parameters(&encoder);
            output_video_stream.index()
        };

        octx.write_header()
            .map_err(|e| format!("Failed to write header: {e}"))?;

        // Process packets
        let mut decoded_frame = ffmpeg::frame::Video::empty();

        for (stream, packet) in ictx.packets() {
            if stream.index() == video_stream_index {
                decoder
                    .send_packet(&packet)
                    .map_err(|e| format!("Failed to send packet to decoder: {e}"))?;

                while decoder.receive_frame(&mut decoded_frame).is_ok() {
                    encoder
                        .send_frame(&decoded_frame)
                        .map_err(|e| format!("Failed to send frame to encoder: {e}"))?;

                    let mut encoded = ffmpeg::Packet::empty();
                    while encoder.receive_packet(&mut encoded).is_ok() {
                        encoded.set_stream(output_video_stream_index);
                        encoded
                            .write_interleaved(&mut octx)
                            .map_err(|e| format!("Failed to write packet: {e}"))?;
                    }
                }
            }
        }

        // Flush encoder
        encoder
            .send_eof()
            .map_err(|e| format!("Failed to flush encoder: {e}"))?;

        let mut encoded = ffmpeg::Packet::empty();
        while encoder.receive_packet(&mut encoded).is_ok() {
            encoded.set_stream(output_video_stream_index);
            encoded
                .write_interleaved(&mut octx)
                .map_err(|e| format!("Failed to write packet: {e}"))?;
        }

        octx.write_trailer()
            .map_err(|e| format!("Failed to write trailer: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Transcode task failed: {e}"))?
}
