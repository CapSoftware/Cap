use std::{path::PathBuf, sync::Arc};

use crate::{
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot,
    general_settings::GeneralSettingsStore,
    open_editor, open_external_link,
    presets::PresetsStore,
    upload::{get_s3_config, prepare_screenshot_upload, upload_video, InstantMultipartUpload},
    web_api,
    windows::{CapWindowId, ShowCapWindow},
    App, CurrentRecordingChanged, DynLoggingLayer, MutableState, NewStudioRecordingAdded,
    RecordingStarted, RecordingStopped, VideoUploadInfo,
};
use cap_fail::fail;
use cap_media::{feeds::CameraFeed, sources::ScreenCaptureTarget};
use cap_media::{
    platform::Bounds,
    sources::{CaptureScreen, CaptureWindow},
};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, SharingMeta, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment, ZoomSegment,
};
use cap_recording::{
    instant_recording::{CompletedInstantRecording, InstantRecordingHandle},
    CompletedStudioRecording, RecordingError, RecordingMode, RecordingOptions,
    StudioRecordingHandle,
};
use cap_rendering::ProjectRecordings;
use cap_utils::{ensure_dir, spawn_actor};
use objc2_app_kit::NSWindow;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tracing::{error, info};
use tracing_subscriber::Layer;

pub enum InProgressRecording {
    Instant {
        handle: InstantRecordingHandle,
        progressive_upload: Option<InstantMultipartUpload>,
        video_upload_info: VideoUploadInfo,
    },
    Studio {
        handle: StudioRecordingHandle,
    },
}

impl InProgressRecording {
    pub fn capture_target(&self) -> &ScreenCaptureTarget {
        match self {
            Self::Instant { handle, .. } => &handle.options.capture_target,
            Self::Studio { handle } => &handle.options.capture_target,
        }
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        match self {
            Self::Instant { handle, .. } => handle.pause().await,
            Self::Studio { handle } => handle.pause().await,
        }
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        match self {
            Self::Instant { handle, .. } => handle.resume().await,
            Self::Studio { handle } => handle.resume().await,
        }
    }

    pub async fn stop(self) -> Result<CompletedRecording, RecordingError> {
        Ok(match self {
            Self::Instant {
                handle,
                progressive_upload,
                video_upload_info,
            } => CompletedRecording::Instant {
                recording: handle.stop().await?,
                progressive_upload,
                video_upload_info,
            },
            Self::Studio { handle } => CompletedRecording::Studio(handle.stop().await?),
        })
    }

    pub fn bounds(&self) -> &Bounds {
        match self {
            Self::Instant { handle, .. } => &handle.bounds,
            Self::Studio { handle } => &handle.bounds,
        }
    }
}

pub enum CompletedRecording {
    Instant {
        recording: CompletedInstantRecording,
        progressive_upload: Option<InstantMultipartUpload>,
        video_upload_info: VideoUploadInfo,
    },
    Studio(CompletedStudioRecording),
}

impl CompletedRecording {
    pub fn id(&self) -> &String {
        match self {
            Self::Instant { recording, .. } => &recording.id,
            Self::Studio(a) => &a.id,
        }
    }

    pub fn project_path(&self) -> &PathBuf {
        match self {
            Self::Instant { recording, .. } => &recording.project_path,
            Self::Studio(a) => &a.project_path,
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_screens() -> Vec<CaptureScreen> {
    cap_media::sources::list_screens()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_windows() -> Vec<CaptureWindow> {
    cap_media::sources::list_windows()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<String> {
    CameraFeed::list_cameras()
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(name = "recording", skip_all)]
pub async fn start_recording(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    recording_options: Option<RecordingOptions>,
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    ensure_dir(&recording_dir).map_err(|e| format!("Failed to create recording directory: {e}"))?;
    let logfile = std::fs::File::create(recording_dir.join("recording-logs.log"))
        .map_err(|e| format!("Failed to create logfile: {e}"))?;

    let mut state = state_mtx.write().await;

    state
        .recording_logging_handle
        .reload(Some(Box::new(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(logfile),
        ) as DynLoggingLayer))
        .map_err(|e| format!("Failed to reload logging layer: {e}"))?;

    let recording_options = recording_options.unwrap_or(state.recording_options.clone());
    state.recording_options = recording_options.clone();

    if let Some(window) = CapWindowId::Camera.get(&app) {
        let _ =
            window.set_content_protected(matches!(recording_options.mode, RecordingMode::Studio));
    }

    let video_upload_info = match recording_options.mode {
        RecordingMode::Instant => {
            match AuthStore::get(&app).ok().flatten() {
                Some(_) => {
                    // Pre-create the video and get the shareable link
                    if let Ok(s3_config) = get_s3_config(&app, false, None).await {
                        let link = web_api::make_url(format!("/s/{}", s3_config.id()));
                        info!("Pre-created shareable link: {}", link);

                        Some(VideoUploadInfo {
                            id: s3_config.id().to_string(),
                            link: link.clone(),
                            config: s3_config,
                        })
                    } else {
                        None
                    }
                }
                // Allow the recording to proceed without error for any signed-in user
                _ => {
                    // User is not signed in
                    ShowCapWindow::SignIn.show(&app).ok();
                    return Err("Please sign in to use instant recording".to_string());
                }
            }
        }
        RecordingMode::Studio => None,
    };

    if matches!(
        recording_options.capture_target,
        ScreenCaptureTarget::Window { .. } | ScreenCaptureTarget::Area { .. }
    ) {
        let _ = ShowCapWindow::WindowCaptureOccluder.show(&app);
    }

    let (finish_upload_tx, finish_upload_rx) = flume::bounded(1);
    let progressive_upload = video_upload_info
        .as_ref()
        .filter(|_| matches!(recording_options.mode, RecordingMode::Instant))
        .map(|video_upload_info| {
            InstantMultipartUpload::spawn(
                app.clone(),
                id.clone(),
                recording_dir.join("content/output.mp4"),
                video_upload_info.clone(),
                Some(finish_upload_rx),
            )
        });

    drop(state);

    println!("spawning actor");

    // done in spawn to catch panics just in case
    let actor_done_rx = spawn_actor({
        let state_mtx = Arc::clone(&state_mtx);
        let app = app.clone();
        async move {
            fail!("recording::spawn_actor");
            let mut state = state_mtx.write().await;

            let (actor, actor_done_rx) = match recording_options.mode {
                RecordingMode::Studio => {
                    let (handle, actor_done_rx) = cap_recording::spawn_studio_recording_actor(
                        id.clone(),
                        recording_dir.clone(),
                        recording_options.clone(),
                        state.camera_feed.clone(),
                        state.audio_input_feed.clone(),
                    )
                    .await
                    .map_err(|e| {
                        error!("Failed to spawn studio recording actor: {e}");
                        e.to_string()
                    })?;

                    (InProgressRecording::Studio { handle }, actor_done_rx)
                }
                RecordingMode::Instant => {
                    let Some(video_upload_info) = video_upload_info.clone() else {
                        return Err("Video upload info not found".to_string());
                    };

                    let (handle, actor_done_rx) =
                        cap_recording::instant_recording::spawn_instant_recording_actor(
                            id.clone(),
                            recording_dir.clone(),
                            recording_options.clone(),
                            state.audio_input_feed.as_ref(),
                        )
                        .await
                        .map_err(|e| {
                            error!("Failed to spawn studio recording actor: {e}");
                            e.to_string()
                        })?;

                    (
                        InProgressRecording::Instant {
                            handle,
                            progressive_upload,
                            video_upload_info,
                        },
                        actor_done_rx,
                    )
                }
            };

            state.set_current_recording(actor);

            Ok::<_, String>(actor_done_rx)
        }
    })
    .await
    .map_err(|e| format!("Failed to spawn recording actor: {}", e))??;

    spawn_actor({
        let app = app.clone();
        let state_mtx = Arc::clone(&state_mtx);
        async move {
            fail!("recording::wait_actor_done");
            actor_done_rx.await.ok();

            let _ = finish_upload_tx.send(());

            let mut state = state_mtx.write().await;

            // this clears the current recording for us
            handle_recording_end(app, None, &mut state).await.ok();
        }
    });

    if let Some(window) = CapWindowId::Main.get(&app) {
        window.minimize().ok();
    }

    if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
        window.eval("window.location.reload()").ok();
    } else {
        ShowCapWindow::InProgressRecording { position: None }
            .show(&app)
            .ok();
    }

    AppSounds::StartRecording.play();

    RecordingStarted.emit(&app).ok();

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn pause_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording.as_mut() {
        recording.pause().await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn resume_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording.as_mut() {
        recording.resume().await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;
    let Some(current_recording) = state.clear_current_recording() else {
        return Err("Recording not in progress".to_string())?;
    };

    let completed_recording = current_recording.stop().await.map_err(|e| e.to_string())?;

    handle_recording_end(app, Some(completed_recording), &mut state).await?;

    Ok(())
}

// runs when a recording ends, whether from success or failure
async fn handle_recording_end(
    app: AppHandle,
    recording: Option<CompletedRecording>,
    state: &mut App,
) -> Result<(), String> {
    // Clear current recording, just in case :)
    state.current_recording.take();

    if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
        window.hide().unwrap();
    }

    if let Some(window) = CapWindowId::Main.get(&app) {
        window.unminimize().ok();
    }

    // Store the link for opening later if we have one from an instant recording
    let mut shareable_link = None;

    if let Some(recording) = recording {
        shareable_link = handle_recording_finish(&app, recording).await?;
    };

    state.recording_logging_handle.reload(None);

    // Play sound to indicate recording has stopped
    AppSounds::StopRecording.play();

    // Now that recording has fully stopped and sound has played, open the link if available
    if let Some(link) = shareable_link {
        // Open link after sound plays, giving user clear indication recording has ended
        open_external_link(app.clone(), link).ok();
    }

    CurrentRecordingChanged.emit(&app).ok();

    Ok(())
}

// runs when a recording successfully finishes
async fn handle_recording_finish(
    app: &AppHandle,
    completed_recording: CompletedRecording,
) -> Result<Option<String>, String> {
    let recording_dir = completed_recording.project_path().clone();
    let id = completed_recording.id().clone();

    let screenshots_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshots_dir).ok();

    let display_output_path = match &completed_recording {
        CompletedRecording::Studio(recording) => match &recording.meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                segment.display.path.to_path(&recording_dir)
            }
            StudioRecordingMeta::MultipleSegments { inner } => {
                inner.segments[0].display.path.to_path(&recording_dir)
            }
        },
        CompletedRecording::Instant { recording, .. } => {
            recording.project_path.join("./content/output.mp4")
        }
    };

    let display_screenshot = screenshots_dir.join("display.jpg");
    create_screenshot(display_output_path, display_screenshot.clone(), None).await?;

    let mut shareable_link = None;

    let (meta_inner, sharing) = match completed_recording {
        CompletedRecording::Studio(recording) => {
            let recordings = ProjectRecordings::new(&recording_dir, &recording.meta);

            let config = project_config_from_recording(
                &recording,
                &recordings,
                PresetsStore::get_default_preset(&app)?.map(|p| p.config),
            );

            config.write(&recording_dir).map_err(|e| e.to_string())?;

            if let Some(settings) = GeneralSettingsStore::get(&app).ok().flatten() {
                if settings.open_editor_after_recording {
                    open_editor(app.clone(), id.clone());
                }
            };

            ShowCapWindow::RecordingsOverlay.show(&app).ok();

            let _ = NewStudioRecordingAdded {
                path: recording_dir.clone(),
            }
            .emit(app);

            (RecordingMetaInner::Studio(recording.meta), None)
        }
        CompletedRecording::Instant {
            recording,
            progressive_upload,
            video_upload_info,
        } => {
            shareable_link = Some(video_upload_info.link.clone());
            let app = app.clone();
            let output_path = recording_dir.join("content/output.mp4");

            {
                let video_upload_info = video_upload_info.clone();
                spawn_actor(async move {
                    if let Some(progressive_upload) = progressive_upload {
                        let video_upload_succeeded = match progressive_upload
                            .handle
                            .await
                            .map_err(|e| e.to_string())
                            .and_then(|r| r)
                        {
                            Ok(()) => {
                                info!("Not attempting instant recording upload as progressive upload succeeded");
                                true
                            }
                            Err(e) => {
                                error!("Progressive upload failed: {}", e);
                                false
                            }
                        };

                        if video_upload_succeeded {
                            let (screenshot_url, screenshot_form) = match prepare_screenshot_upload(
                                &app,
                                &video_upload_info.config.clone(),
                                display_screenshot,
                            )
                            .await
                            {
                                Ok(v) => v,
                                Err(e) => {
                                    error!("Failed to prepare screenshot upload: {e}");
                                    return;
                                }
                            };

                            let resp = reqwest::Client::new()
                                .post(screenshot_url)
                                .multipart(screenshot_form)
                                .send()
                                .await;

                            match resp {
                                Ok(r) if r.status() == 200 => {
                                    info!("Screenshot uploaded successfully");
                                }
                                Ok(r) => {
                                    error!("Failed to upload screenshot: {}", r.status());
                                }
                                Err(e) => {
                                    error!("Failed to upload screenshot: {e}");
                                }
                            }
                        } else {
                            // The upload_video function handles screenshot upload, so we can pass it along
                            match upload_video(
                                &app,
                                video_upload_info.id.clone(),
                                output_path,
                                Some(video_upload_info.config.clone()),
                                Some(display_screenshot.clone()),
                            )
                            .await
                            {
                                Ok(_) => {
                                    info!(
                                        "Final video upload with screenshot completed successfully"
                                    )
                                }
                                Err(e) => error!("Error in final upload with screenshot: {}", e),
                            }
                        }
                    }
                });
            }

            (
                RecordingMetaInner::Instant(recording.meta),
                Some(SharingMeta {
                    link: video_upload_info.link,
                    id: video_upload_info.id,
                }),
            )
        }
    };

    let _ = RecordingStopped {
        path: recording_dir.clone(),
    }
    .emit(app);

    let meta = RecordingMeta {
        project_path: recording_dir,
        sharing,
        pretty_name: format!(
            "Cap {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        inner: meta_inner,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e}"))?;

    Ok(shareable_link)
}

fn generate_zoom_segments_from_clicks(
    recording: &CompletedStudioRecording,
    recordings: &ProjectRecordings,
) -> Vec<ZoomSegment> {
    let mut segments = vec![];

    let max_duration = recordings.duration();

    const ZOOM_SEGMENT_AFTER_CLICK_PADDING: f64 = 1.5;

    // single-segment only
    // for click in &recording.cursor_data.clicks {
    //     let time = click.process_time_ms / 1000.0;

    //     if segments.last().is_none() {
    //         segments.push(ZoomSegment {
    //             start: (click.process_time_ms / 1000.0 - (ZOOM_DURATION + 0.2)).max(0.0),
    //             end: click.process_time_ms / 1000.0 + ZOOM_SEGMENT_AFTER_CLICK_PADDING,
    //             amount: 2.0,
    //         });
    //     } else {
    //         let last_segment = segments.last_mut().unwrap();

    //         if click.down {
    //             if last_segment.end > time {
    //                 last_segment.end =
    //                     (time + ZOOM_SEGMENT_AFTER_CLICK_PADDING).min(recordings.duration());
    //             } else if time < max_duration - ZOOM_DURATION {
    //                 segments.push(ZoomSegment {
    //                     start: (time - ZOOM_DURATION).max(0.0),
    //                     end: time + ZOOM_SEGMENT_AFTER_CLICK_PADDING,
    //                     amount: 2.0,
    //                 });
    //             }
    //         } else {
    //             last_segment.end =
    //                 (time + ZOOM_SEGMENT_AFTER_CLICK_PADDING).min(recordings.duration());
    //         }
    //     }
    // }

    segments
}

fn project_config_from_recording(
    completed_recording: &CompletedStudioRecording,
    recordings: &ProjectRecordings,
    default_config: Option<ProjectConfiguration>,
) -> ProjectConfiguration {
    ProjectConfiguration {
        timeline: Some(TimelineConfiguration {
            segments: recordings
                .segments
                .iter()
                .enumerate()
                .map(|(i, segment)| TimelineSegment {
                    recording_segment: i as u32,
                    start: 0.0,
                    end: segment.duration(),
                    timescale: 1.0,
                })
                .collect(),
            zoom_segments: generate_zoom_segments_from_clicks(&completed_recording, &recordings),
        }),
        ..default_config.unwrap_or_default()
    }
}
