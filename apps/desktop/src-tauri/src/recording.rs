use std::{path::PathBuf, sync::Arc};

use crate::{
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot,
    export::export_video,
    general_settings::GeneralSettingsStore,
    notifications, open_editor, open_external_link,
    presets::PresetsStore,
    upload::get_s3_config,
    upload_exported_video, web_api,
    windows::{CapWindowId, ShowCapWindow},
    App, CurrentRecordingChanged, MutableState, NewStudioRecordingAdded, PreCreatedVideo,
    RecordingStarted, RecordingStopped, UploadMode,
};
use cap_fail::fail;
use cap_media::{feeds::CameraFeed, sources::ScreenCaptureTarget};
use cap_media::{
    platform::Bounds,
    sources::{CaptureScreen, CaptureWindow},
};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment, ZoomSegment, XY,
};
use cap_recording::{
    instant_recording::{CompletedInstantRecording, InstantRecordingHandle},
    CompletedStudioRecording, RecordingError, RecordingMode, RecordingOptions,
    StudioRecordingHandle,
};
use cap_rendering::ProjectRecordings;
use cap_utils::spawn_actor;
use clipboard_rs::{Clipboard, ClipboardContext};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tracing::info;

pub enum RecordingActor {
    Instant(InstantRecordingHandle),
    Studio(StudioRecordingHandle),
}

impl RecordingActor {
    pub fn capture_target(&self) -> &ScreenCaptureTarget {
        match self {
            Self::Instant(a) => &a.options.capture_target,
            Self::Studio(a) => &a.options.capture_target,
        }
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        match self {
            Self::Instant(a) => a.pause().await,
            Self::Studio(a) => a.pause().await,
        }
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        match self {
            Self::Instant(a) => a.resume().await,
            Self::Studio(a) => a.resume().await,
        }
    }

    pub async fn stop(&self) -> Result<CompletedRecording, RecordingError> {
        Ok(match self {
            Self::Instant(a) => CompletedRecording::Instant(a.stop().await?),
            Self::Studio(a) => CompletedRecording::Studio(a.stop().await?),
        })
    }

    pub fn bounds(&self) -> &Bounds {
        match self {
            Self::Instant(a) => &a.bounds,
            Self::Studio(a) => &a.bounds,
        }
    }
}

pub enum CompletedRecording {
    Instant(CompletedInstantRecording),
    Studio(CompletedStudioRecording),
}

impl CompletedRecording {
    pub fn id(&self) -> &String {
        match self {
            Self::Instant(a) => &a.id,
            Self::Studio(a) => &a.id,
        }
    }

    pub fn project_path(&self) -> &PathBuf {
        match self {
            Self::Instant(a) => &a.project_path,
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
pub async fn start_recording(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    recording_options: Option<RecordingOptions>,
) -> Result<(), String> {
    let mut state = state_mtx.write().await;

    let recording_options = recording_options.unwrap_or(state.recording_options.clone());
    state.recording_options = recording_options.clone();

    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    let camera_window = CapWindowId::Camera.get(&app);
    match recording_options.mode {
        RecordingMode::Instant => {
            match AuthStore::get(&app) {
                Ok(Some(_)) => {
                    // Pre-create the video and get the shareable link
                    if let Ok(s3_config) = get_s3_config(&app, false, None).await {
                        let link = web_api::make_url(format!("/s/{}", s3_config.id()));

                        state.pre_created_video = Some(PreCreatedVideo {
                            id: s3_config.id().to_string(),
                            link: link.clone(),
                            config: s3_config,
                        });
                        info!("Pre-created shareable link: {}", link);
                    }
                }
                // Allow the recording to proceed without error for any signed-in user
                _ => {
                    // User is not signed in
                    ShowCapWindow::SignIn.show(&app).ok();
                    Err("Please sign in to use instant recording")?;
                }
            }

            if let Some(window) = camera_window {
                let _ = window.set_content_protected(false);
            }
        }
        RecordingMode::Studio => {
            if let Some(window) = camera_window {
                let _ = window.set_content_protected(true);
            }
        }
    }

    if matches!(
        recording_options.capture_target,
        ScreenCaptureTarget::Window { .. } | ScreenCaptureTarget::Area { .. }
    ) {
        let _ = ShowCapWindow::WindowCaptureOccluder.show(&app);
    }

    drop(state);

    println!("spawning actor");

    // done in spawn to catch panics just in case
    let actor_done_rx = spawn_actor({
        let state_mtx = Arc::clone(&state_mtx);
        async move {
            fail!("recording::spawn_actor");
            let mut state = state_mtx.write().await;

            let (actor, actor_done_rx) = match recording_options.mode {
                RecordingMode::Studio => {
                    let (actor, actor_done_rx) = cap_recording::spawn_studio_recording_actor(
                        id,
                        recording_dir,
                        recording_options.clone(),
                        state.camera_feed.clone(),
                        state.audio_input_feed.clone(),
                    )
                    .await
                    .map_err(|e| e.to_string())?;

                    (RecordingActor::Studio(actor), actor_done_rx)
                }
                RecordingMode::Instant => {
                    let (actor, actor_done_rx) =
                        cap_recording::instant_recording::spawn_instant_recording_actor(
                            id,
                            recording_dir,
                            recording_options.clone(),
                            state.audio_input_feed.clone(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;

                    (RecordingActor::Instant(actor), actor_done_rx)
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
    completed_recording: Option<CompletedRecording>,
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

    if let Some(completed_recording) = completed_recording {
        handle_recording_finish(&app, completed_recording, state).await?;
    };

    AppSounds::StopRecording.play();

    CurrentRecordingChanged.emit(&app).ok();

    Ok(())
}

// runs when a recording successfully finishes
async fn handle_recording_finish(
    app: &AppHandle,
    completed_recording: CompletedRecording,
    state: &mut App,
) -> Result<(), String> {
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
        CompletedRecording::Instant(recording) => {
            recording.project_path.join("./content/output.mp4")
        }
    };

    let display_screenshot = screenshots_dir.join("display.jpg");
    create_screenshot(display_output_path, display_screenshot.clone(), None).await?;

    let meta_inner = match completed_recording {
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

            RecordingMetaInner::Studio(recording.meta)
        }
        CompletedRecording::Instant(recording) => {
            if let Some(pre_created_video) = state.pre_created_video.take() {
                spawn_actor({
                    let app = app.clone();
                    async move {
                        // Copy link to clipboard
                        let _ = app.clipboard().write_text(pre_created_video.link.clone());

                        // Send notification for shareable link
                        notifications::send_notification(
                            &app,
                            notifications::NotificationType::ShareableLinkCopied,
                        );

                        // Open the pre-created shareable link
                        open_external_link(app.clone(), pre_created_video.link.clone()).ok();

                        // Start the upload process in the background with retry mechanism
                        let app = app.clone();

                        tauri::async_runtime::spawn(async move {
                            let max_retries = 3;
                            let mut retry_count = 0;

                            while retry_count < max_retries {
                                match upload_exported_video(
                                    app.clone(),
                                    id.clone(),
                                    UploadMode::Initial {
                                        pre_created_video: Some(pre_created_video.clone()),
                                    },
                                )
                                .await
                                {
                                    Ok(_) => {
                                        println!("Video uploaded successfully");
                                        // Don't send notification here since we already did it above
                                        break;
                                    }
                                    Err(e) => {
                                        retry_count += 1;
                                        println!(
                                            "Error during auto-upload (attempt {}/{}): {}",
                                            retry_count, max_retries, e
                                        );

                                        if retry_count < max_retries {
                                            tokio::time::sleep(std::time::Duration::from_secs(5))
                                                .await;
                                        } else {
                                            println!("Max retries reached. Upload failed.");
                                            notifications::send_notification(
                                                &app,
                                                notifications::NotificationType::UploadFailed,
                                            );
                                        }
                                    }
                                }
                            }
                        });
                    }
                });
            }

            RecordingMetaInner::Instant(recording.meta)
        }
    };

    let _ = RecordingStopped {
        path: recording_dir.clone(),
    }
    .emit(app);

    let meta = RecordingMeta {
        project_path: recording_dir,
        sharing: None,
        pretty_name: format!(
            "Cap {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        inner: meta_inner,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e}"))?;

    Ok(())
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
