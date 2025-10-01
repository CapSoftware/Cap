use cap_fail::fail;
use cap_project::{
    CursorClickEvent, CursorMoveEvent, Platform, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, SharingMeta, StudioRecordingMeta, TimelineConfiguration,
    TimelineSegment, ZoomMode, ZoomSegment, cursor::CursorEvents,
};
use cap_project::cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS;
use cap_recording::{
    RecordingError, RecordingMode,
    feeds::{camera, microphone},
    instant_recording,
    sources::{CaptureDisplay, CaptureWindow, ScreenCaptureTarget, screen_capture},
    studio_recording,
};
use cap_rendering::ProjectRecordingsMeta;
use cap_utils::{ensure_dir, spawn_actor};
use serde::Deserialize;
use specta::Type;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    str::FromStr,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder};
use tauri_specta::Event;
use tracing::{debug, error, info};

use crate::{
    App, CurrentRecordingChanged, MutableState, NewStudioRecordingAdded, RecordingState,
    RecordingStopped, VideoUploadInfo,
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot,
    general_settings::{GeneralSettingsStore, PostDeletionBehaviour, PostStudioRecordingBehaviour},
    open_external_link,
    presets::PresetsStore,
    upload::{
        InstantMultipartUpload, build_video_meta, create_or_get_video, prepare_screenshot_upload,
        upload_video,
    },
    web_api::ManagerExt,
    windows::{CapWindowId, ShowCapWindow},
};

pub enum InProgressRecording {
    Instant {
        target_name: String,
        handle: instant_recording::ActorHandle,
        progressive_upload: Option<InstantMultipartUpload>,
        video_upload_info: VideoUploadInfo,
        inputs: StartRecordingInputs,
        recording_dir: PathBuf,
    },
    Studio {
        target_name: String,
        handle: studio_recording::ActorHandle,
        inputs: StartRecordingInputs,
        recording_dir: PathBuf,
    },
}

impl InProgressRecording {
    pub fn capture_target(&self) -> &ScreenCaptureTarget {
        match self {
            Self::Instant { handle, .. } => &handle.capture_target,
            Self::Studio { handle, .. } => &handle.capture_target,
        }
    }

    pub fn inputs(&self) -> &StartRecordingInputs {
        match self {
            Self::Instant { inputs, .. } => inputs,
            Self::Studio { inputs, .. } => inputs,
        }
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        match self {
            Self::Instant { handle, .. } => handle.pause().await,
            Self::Studio { handle, .. } => handle.pause().await,
        }
    }

    pub async fn resume(&self) -> Result<(), String> {
        match self {
            Self::Instant { handle, .. } => handle.resume().await.map_err(|e| e.to_string()),
            Self::Studio { handle, .. } => handle.resume().await.map_err(|e| e.to_string()),
        }
    }

    pub fn recording_dir(&self) -> &PathBuf {
        match self {
            Self::Instant { recording_dir, .. } => recording_dir,
            Self::Studio { recording_dir, .. } => recording_dir,
        }
    }

    pub async fn stop(self) -> Result<CompletedRecording, RecordingError> {
        Ok(match self {
            Self::Instant {
                handle,
                progressive_upload,
                video_upload_info,
                target_name,
                ..
            } => CompletedRecording::Instant {
                recording: handle.stop().await?,
                progressive_upload,
                video_upload_info,
                target_name,
            },
            Self::Studio {
                handle,
                target_name,
                ..
            } => CompletedRecording::Studio {
                recording: handle.stop().await?,
                target_name,
            },
        })
    }

    pub async fn cancel(self) -> Result<(), RecordingError> {
        match self {
            Self::Instant { handle, .. } => handle.cancel().await,
            Self::Studio { handle, .. } => handle.cancel().await,
        }
    }

    pub fn mode(&self) -> RecordingMode {
        match self {
            Self::Instant { .. } => RecordingMode::Instant,
            Self::Studio { .. } => RecordingMode::Studio,
        }
    }
}

pub enum CompletedRecording {
    Instant {
        recording: instant_recording::CompletedRecording,
        target_name: String,
        progressive_upload: Option<InstantMultipartUpload>,
        video_upload_info: VideoUploadInfo,
    },
    Studio {
        recording: studio_recording::CompletedStudioRecording,
        target_name: String,
    },
}

impl CompletedRecording {
    pub fn project_path(&self) -> &PathBuf {
        match self {
            Self::Instant { recording, .. } => &recording.project_path,
            Self::Studio { recording, .. } => &recording.project_path,
        }
    }

    pub fn target_name(&self) -> &String {
        match self {
            Self::Instant { target_name, .. } => target_name,
            Self::Studio { target_name, .. } => target_name,
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
pub async fn list_capture_displays() -> Vec<CaptureDisplay> {
    screen_capture::list_displays()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub async fn list_capture_windows() -> Vec<CaptureWindow> {
    screen_capture::list_windows()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<cap_camera::CameraInfo> {
    cap_camera::list_cameras().collect()
}

#[derive(Deserialize, Type, Clone, Debug)]
pub struct StartRecordingInputs {
    pub capture_target: ScreenCaptureTarget,
    #[serde(default)]
    pub capture_system_audio: bool,
    pub mode: RecordingMode,
}

#[derive(tauri_specta::Event, specta::Type, Clone, Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum RecordingEvent {
    Countdown { value: u32 },
    Started,
    Stopped,
    Failed { error: String },
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(name = "recording", skip_all)]
pub async fn start_recording(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    inputs: StartRecordingInputs,
) -> Result<(), String> {
    if !matches!(state_mtx.read().await.recording_state, RecordingState::None) {
        return Err("Recording already in progress".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let general_settings = GeneralSettingsStore::get(&app).ok().flatten();
    let general_settings = general_settings.as_ref();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    ensure_dir(&recording_dir).map_err(|e| format!("Failed to create recording directory: {e}"))?;
    state_mtx
        .write()
        .await
        .add_recording_logging_handle(&recording_dir.join("recording-logs.log"))
        .await?;

    let target_name = {
        let title = inputs.capture_target.title();

        match inputs.capture_target.clone() {
            ScreenCaptureTarget::Area { .. } => title.unwrap_or_else(|| "Area".to_string()),
            ScreenCaptureTarget::Window { .. } => title.unwrap_or_else(|| "Window".to_string()),
            ScreenCaptureTarget::Display { .. } => title.unwrap_or_else(|| "Screen".to_string()),
        }
    };

    if let Some(window) = CapWindowId::Camera.get(&app) {
        let _ = window.set_content_protected(matches!(inputs.mode, RecordingMode::Studio));
    }

    let video_upload_info = match inputs.mode {
        RecordingMode::Instant => {
            match AuthStore::get(&app).ok().flatten() {
                Some(_) => {
                    // Pre-create the video and get the shareable link
                    if let Ok(s3_config) = create_or_get_video(
                        &app,
                        false,
                        None,
                        Some(format!(
                            "{target_name} {}",
                            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                        )),
                        None,
                    )
                    .await
                    {
                        let link = app.make_app_url(format!("/s/{}", s3_config.id())).await;
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
                    return Err("Please sign in to use instant recording".to_string());
                }
            }
        }
        RecordingMode::Studio => None,
    };

    match &inputs.capture_target {
        ScreenCaptureTarget::Window { id: _id } => {
            if let Some(show) = inputs
                .capture_target
                .display()
                .map(|d| ShowCapWindow::WindowCaptureOccluder { screen_id: d.id() })
            {
                let _ = show.show(&app).await;
            }
        }
        ScreenCaptureTarget::Area { screen, .. } => {
            let _ = ShowCapWindow::WindowCaptureOccluder {
                screen_id: screen.clone(),
            }
            .show(&app)
            .await;
        }
        _ => {}
    }

    // Set pending state BEFORE closing main window and starting countdown
    state_mtx
        .write()
        .await
        .set_pending_recording(inputs.mode, inputs.capture_target.clone());

    let countdown = general_settings.and_then(|v| v.recording_countdown);
    for (id, win) in app
        .webview_windows()
        .iter()
        .filter_map(|(label, win)| CapWindowId::from_str(label).ok().map(|id| (id, win)))
    {
        if matches!(id, CapWindowId::TargetSelectOverlay { .. }) {
            win.close().ok();
        }
    }
    let _ = ShowCapWindow::InProgressRecording { countdown }
        .show(&app)
        .await;

    if let Some(window) = CapWindowId::Main.get(&app) {
        let _ = general_settings
            .map(|v| v.main_window_recording_start_behaviour)
            .unwrap_or_default()
            .perform(&window);
    }

    if let Some(countdown) = countdown {
        for t in 0..countdown {
            let _ = RecordingEvent::Countdown {
                value: countdown - t,
            }
            .emit(&app);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    let (finish_upload_tx, finish_upload_rx) = flume::bounded(1);
    let progressive_upload = video_upload_info
        .as_ref()
        .filter(|_| matches!(inputs.mode, RecordingMode::Instant))
        .map(|video_upload_info| {
            InstantMultipartUpload::spawn(
                app.clone(),
                id.clone(),
                recording_dir.join("content/output.mp4"),
                video_upload_info.clone(),
                Some(finish_upload_rx),
            )
        });

    debug!("spawning start_recording actor");

    // done in spawn to catch panics just in case
    let spawn_actor_res = async {
        spawn_actor({
            let state_mtx = Arc::clone(&state_mtx);
            let general_settings = general_settings.cloned();
            async move {
                fail!("recording::spawn_actor");
                let mut state = state_mtx.write().await;

                use kameo::error::SendError;
                let mic_feed = match state.mic_feed.ask(microphone::Lock).await {
                    Ok(lock) => Some(Arc::new(lock)),
                    Err(SendError::HandlerError(microphone::LockFeedError::NoInput)) => None,
                    Err(e) => return Err(e.to_string()),
                };

                let camera_feed = match state.camera_feed.ask(camera::Lock).await {
                    Ok(lock) => Some(Arc::new(lock)),
                    Err(SendError::HandlerError(camera::LockFeedError::NoInput)) => None,
                    Err(e) => return Err(e.to_string()),
                };

                let (actor, actor_done_rx) = match inputs.mode {
                    RecordingMode::Studio => {
                        let mut builder = studio_recording::Actor::builder(
                            recording_dir.clone(),
                            inputs.capture_target.clone(),
                        )
                        .with_system_audio(inputs.capture_system_audio)
                        .with_custom_cursor(
                            general_settings
                                .map(|s| s.custom_cursor_capture)
                                .unwrap_or_default(),
                        );

                        if let Some(camera_feed) = camera_feed {
                            builder = builder.with_camera_feed(camera_feed);
                        }

                        if let Some(mic_feed) = mic_feed {
                            builder = builder.with_mic_feed(mic_feed);
                        }

                        let (handle, actor_done_rx) = builder.build().await.map_err(|e| {
                            error!("Failed to spawn studio recording actor: {e}");
                            e.to_string()
                        })?;

                        (
                            InProgressRecording::Studio {
                                handle,
                                target_name,
                                inputs,
                                recording_dir: recording_dir.clone(),
                            },
                            actor_done_rx,
                        )
                    }
                    RecordingMode::Instant => {
                        let Some(video_upload_info) = video_upload_info.clone() else {
                            return Err("Video upload info not found".to_string());
                        };

                        let mut builder = instant_recording::Actor::builder(
                            recording_dir.clone(),
                            inputs.capture_target.clone(),
                        )
                        .with_system_audio(inputs.capture_system_audio);

                        if let Some(mic_feed) = mic_feed {
                            builder = builder.with_mic_feed(mic_feed);
                        }

                        let (handle, actor_done_rx) = builder.build().await.map_err(|e| {
                            error!("Failed to spawn studio recording actor: {e}");
                            e.to_string()
                        })?;

                        (
                            InProgressRecording::Instant {
                                handle,
                                progressive_upload,
                                video_upload_info,
                                target_name,
                                inputs,
                                recording_dir: recording_dir.clone(),
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
        .map_err(|e| format!("Failed to spawn recording actor: {e}"))?
    }
    .await;

    let actor_done_rx = match spawn_actor_res {
        Ok(rx) => rx,
        Err(e) => {
            let _ = RecordingEvent::Failed { error: e.clone() }.emit(&app);

            let mut dialog = MessageDialogBuilder::new(
                app.dialog().clone(),
                "An error occurred".to_string(),
                e.clone(),
            )
            .kind(tauri_plugin_dialog::MessageDialogKind::Error);

            if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
                dialog = dialog.parent(&window);
            }

            dialog.blocking_show();

            let mut state = state_mtx.write().await;
            let _ = handle_recording_end(app, None, &mut state).await;

            return Err(e);
        }
    };

    let _ = RecordingEvent::Started.emit(&app);

    spawn_actor({
        let app = app.clone();
        let state_mtx = Arc::clone(&state_mtx);
        async move {
            fail!("recording::wait_actor_done");
            let res = actor_done_rx.await;
            info!("recording wait actor done: {:?}", &res);
            match res {
                Ok(Ok(_)) => {
                    let _ = finish_upload_tx.send(());
                    let _ = RecordingEvent::Stopped.emit(&app);
                }
                Ok(Err(e)) => {
                    let mut state = state_mtx.write().await;

                    let _ = RecordingEvent::Failed { error: e.clone() }.emit(&app);

                    let mut dialog = MessageDialogBuilder::new(
                        app.dialog().clone(),
                        "An error occurred".to_string(),
                        e,
                    )
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error);

                    if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
                        dialog = dialog.parent(&window);
                    }

                    dialog.blocking_show();

                    // this clears the current recording for us
                    handle_recording_end(app, None, &mut state).await.ok();
                }
                // Actor hasn't errored, it's just finished
                v => {
                    info!("recording actor ended: {v:?}");
                }
            }
        }
    });

    AppSounds::StartRecording.play();

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn pause_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording_mut() {
        recording.pause().await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn resume_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording_mut() {
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

#[tauri::command]
#[specta::specta]
pub async fn restart_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let Some(recording) = state.write().await.clear_current_recording() else {
        return Err("No recording in progress".to_string());
    };

    let _ = CurrentRecordingChanged.emit(&app);

    let inputs = recording.inputs().clone();

    let _ = recording.cancel().await;

    tokio::time::sleep(Duration::from_millis(1000)).await;

    start_recording(app.clone(), state, inputs).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let recording_data = {
        let mut app_state = state.write().await;
        if let Some(recording) = app_state.clear_current_recording() {
            let recording_dir = recording.recording_dir().clone();
            let video_id = match &recording {
                InProgressRecording::Instant {
                    video_upload_info, ..
                } => Some(video_upload_info.id.clone()),
                _ => None,
            };
            Some((recording, recording_dir, video_id))
        } else {
            None
        }
    };

    if let Some((recording, recording_dir, video_id)) = recording_data {
        CurrentRecordingChanged.emit(&app).ok();
        RecordingStopped {}.emit(&app).ok();

        let _ = recording.cancel().await;

        std::fs::remove_dir_all(&recording_dir).ok();

        if let Some(id) = video_id {
            let _ = app
                .authed_api_request(
                    format!("/api/desktop/video/delete?videoId={id}"),
                    |c, url| c.delete(url),
                )
                .await;
        }

        // Check user's post-deletion behavior setting
        let settings = GeneralSettingsStore::get(&app)
            .ok()
            .flatten()
            .unwrap_or_default();

        if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
            let _ = window.close();
        }

        match settings.post_deletion_behaviour {
            PostDeletionBehaviour::DoNothing => {}
            PostDeletionBehaviour::ReopenRecordingWindow => {
                let _ = ShowCapWindow::Main {
                    init_target_mode: None,
                }
                .show(&app)
                .await;
            }
        }
    }

    Ok(())
}

// runs when a recording ends, whether from success or failure
async fn handle_recording_end(
    handle: AppHandle,
    recording: Option<CompletedRecording>,
    app: &mut App,
) -> Result<(), String> {
    // Clear current recording, just in case :)
    app.clear_current_recording();

    let res = if let Some(recording) = recording {
        // we delay reporting errors here so that everything else happens first
        Some(handle_recording_finish(&handle, recording).await)
    } else {
        None
    };

    let _ = RecordingStopped.emit(&handle);

    let _ = app.recording_logging_handle.reload(None);

    if let Some(window) = CapWindowId::InProgressRecording.get(&handle) {
        let _ = window.close();
    }

    if let Some(window) = CapWindowId::Main.get(&handle) {
        window.unminimize().ok();
    } else {
        if let Some(v) = CapWindowId::Camera.get(&handle) {
            let _ = v.close();
        }
        let _ = app.mic_feed.ask(microphone::RemoveInput).await;
        let _ = app.camera_feed.ask(camera::RemoveInput).await;
        if let Some(win) = CapWindowId::Camera.get(&handle) {
            win.close().ok();
        }
    }

    CurrentRecordingChanged.emit(&handle).ok();

    if let Some(res) = res {
        res?;
    }

    Ok(())
}

// runs when a recording successfully finishes
async fn handle_recording_finish(
    app: &AppHandle,
    completed_recording: CompletedRecording,
) -> Result<(), String> {
    let recording_dir = completed_recording.project_path().clone();

    let screenshots_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshots_dir).ok();

    let display_output_path = match &completed_recording {
        CompletedRecording::Studio { recording, .. } => match &recording.meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                segment.display.path.to_path(&recording_dir)
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => {
                inner.segments[0].display.path.to_path(&recording_dir)
            }
        },
        CompletedRecording::Instant { recording, .. } => {
            recording.project_path.join("./content/output.mp4")
        }
    };

    let display_screenshot = screenshots_dir.join("display.jpg");
    let screenshot_task = tokio::spawn(create_screenshot(
        display_output_path,
        display_screenshot.clone(),
        None,
    ));

    let target_name = completed_recording.target_name().clone();

    let (meta_inner, sharing) = match completed_recording {
        CompletedRecording::Studio { recording, .. } => {
            let recordings = ProjectRecordingsMeta::new(&recording_dir, &recording.meta)?;

            let config = project_config_from_recording(
                app,
                &recording,
                &recordings,
                PresetsStore::get_default_preset(app)?.map(|p| p.config),
            );

            config.write(&recording_dir).map_err(|e| e.to_string())?;

            (RecordingMetaInner::Studio(recording.meta), None)
        }
        CompletedRecording::Instant {
            recording,
            progressive_upload,
            video_upload_info,
            ..
        } => {
            // shareable_link = Some(video_upload_info.link.clone());
            let app = app.clone();
            let output_path = recording_dir.join("content/output.mp4");

            let _ = open_external_link(app.clone(), video_upload_info.link.clone());

            spawn_actor({
                let video_upload_info = video_upload_info.clone();

                async move {
                    if let Some(progressive_upload) = progressive_upload {
                        let video_upload_succeeded = match progressive_upload
                            .handle
                            .await
                            .map_err(|e| e.to_string())
                            .and_then(|r| r)
                        {
                            Ok(()) => {
                                info!(
                                    "Not attempting instant recording upload as progressive upload succeeded"
                                );
                                true
                            }
                            Err(e) => {
                                error!("Progressive upload failed: {}", e);
                                false
                            }
                        };

                        let _ = screenshot_task.await;

                        if video_upload_succeeded {
                            let resp = prepare_screenshot_upload(
                                &app,
                                &video_upload_info.config.clone(),
                                display_screenshot,
                            )
                            .await;

                            match resp {
                                Ok(r)
                                    if r.status().as_u16() >= 200 && r.status().as_u16() < 300 =>
                                {
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
                            let meta = build_video_meta(&output_path).ok();
                            // The upload_video function handles screenshot upload, so we can pass it along
                            match upload_video(
                                &app,
                                video_upload_info.id.clone(),
                                output_path,
                                Some(video_upload_info.config.clone()),
                                Some(display_screenshot.clone()),
                                meta,
                                None,
                            )
                            .await
                            {
                                Ok(_) => {
                                    info!(
                                        "Final video upload with screenshot completed successfully"
                                    )
                                }
                                Err(e) => {
                                    error!("Error in final upload with screenshot: {}", e)
                                }
                            }
                        }
                    }
                }
            });

            (
                RecordingMetaInner::Instant(recording.meta),
                Some(SharingMeta {
                    link: video_upload_info.link,
                    id: video_upload_info.id,
                }),
            )
        }
    };

    let date_time = if cfg!(windows) {
        // Windows doesn't support colon in file paths
        chrono::Local::now().format("%Y-%m-%d %H.%M.%S")
    } else {
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    };

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.clone(),
        sharing,
        pretty_name: format!("{target_name} {date_time}"),
        inner: meta_inner,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e}"))?;

    if let RecordingMetaInner::Studio(_) = meta.inner {
        match GeneralSettingsStore::get(app)
            .ok()
            .flatten()
            .map(|v| v.post_studio_recording_behaviour)
            .unwrap_or(PostStudioRecordingBehaviour::OpenEditor)
        {
            PostStudioRecordingBehaviour::OpenEditor => {
                let _ = ShowCapWindow::Editor {
                    project_path: recording_dir,
                }
                .show(app)
                .await;
            }
            PostStudioRecordingBehaviour::ShowOverlay => {
                let _ = ShowCapWindow::RecordingsOverlay.show(app).await;

                let app = AppHandle::clone(app);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1000)).await;

                    let _ = NewStudioRecordingAdded {
                        path: recording_dir.clone(),
                    }
                    .emit(&app);
                });
            }
        };
    }

    // Play sound to indicate recording has stopped
    AppSounds::StopRecording.play();

    Ok(())
}

/// Core logic for generating zoom segments based on mouse click events.
/// This is an experimental feature that automatically creates zoom effects
/// around user interactions to highlight important moments.
fn generate_zoom_segments_from_clicks_impl(
    mut clicks: Vec<CursorClickEvent>,
    mut moves: Vec<CursorMoveEvent>,
    max_duration: f64,
) -> Vec<ZoomSegment> {
    const STOP_PADDING_SECONDS: f64 = 0.8;
    const CLICK_PRE_PADDING: f64 = 0.6;
    const CLICK_POST_PADDING: f64 = 1.6;
    const MOVEMENT_PRE_PADDING: f64 = 0.4;
    const MOVEMENT_POST_PADDING: f64 = 1.2;
    const MERGE_GAP_THRESHOLD: f64 = 0.6;
    const MIN_SEGMENT_DURATION: f64 = 1.3;
    const MOVEMENT_WINDOW_SECONDS: f64 = 1.2;
    const MOVEMENT_EVENT_DISTANCE_THRESHOLD: f64 = 0.025;
    const MOVEMENT_WINDOW_DISTANCE_THRESHOLD: f64 = 0.1;

    if max_duration <= 0.0 {
        return Vec::new();
    }

    // We trim the tail of the recording to avoid using the final
    // "stop recording" click as a zoom target.
    let activity_end_limit = if max_duration > STOP_PADDING_SECONDS {
        max_duration - STOP_PADDING_SECONDS
    } else {
        max_duration
    };

    if activity_end_limit <= f64::EPSILON {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    moves.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Remove trailing click-down events that are too close to the end.
    while let Some(index) = clicks.iter().rposition(|c| c.down) {
        let time_secs = clicks[index].time_ms / 1000.0;
        if time_secs > activity_end_limit {
            clicks.remove(index);
        } else {
            break;
        }
    }

    let mut intervals: Vec<(f64, f64)> = Vec::new();

    for click in clicks.into_iter().filter(|c| c.down) {
        let time = click.time_ms / 1000.0;
        if time >= activity_end_limit {
            continue;
        }

        let start = (time - CLICK_PRE_PADDING).max(0.0);
        let end = (time + CLICK_POST_PADDING).min(activity_end_limit);

        if end > start {
            intervals.push((start, end));
        }
    }

    let mut last_move_by_cursor: HashMap<String, (f64, f64, f64)> = HashMap::new();
    let mut distance_window: VecDeque<(f64, f64)> = VecDeque::new();
    let mut window_distance = 0.0_f64;

    for mv in moves.iter() {
        let time = mv.time_ms / 1000.0;
        if time >= activity_end_limit {
            break;
        }

        let distance = if let Some((_, last_x, last_y)) = last_move_by_cursor.get(&mv.cursor_id) {
            let dx = mv.x - last_x;
            let dy = mv.y - last_y;
            (dx * dx + dy * dy).sqrt()
        } else {
            0.0
        };

        last_move_by_cursor.insert(mv.cursor_id.clone(), (time, mv.x, mv.y));

        if distance <= f64::EPSILON {
            continue;
        }

        distance_window.push_back((time, distance));
        window_distance += distance;

        while let Some(&(old_time, old_distance)) = distance_window.front() {
            if time - old_time > MOVEMENT_WINDOW_SECONDS {
                distance_window.pop_front();
                window_distance -= old_distance;
            } else {
                break;
            }
        }

        if window_distance < 0.0 {
            window_distance = 0.0;
        }

        let significant_movement =
            distance >= MOVEMENT_EVENT_DISTANCE_THRESHOLD
                || window_distance >= MOVEMENT_WINDOW_DISTANCE_THRESHOLD;

        if !significant_movement {
            continue;
        }

        let start = (time - MOVEMENT_PRE_PADDING).max(0.0);
        let end = (time + MOVEMENT_POST_PADDING).min(activity_end_limit);

        if end > start {
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return Vec::new();
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut() {
            if interval.0 <= last.1 + MERGE_GAP_THRESHOLD {
                last.1 = last.1.max(interval.1);
                continue;
            }
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .filter_map(|(start, end)| {
            let duration = end - start;
            if duration < MIN_SEGMENT_DURATION {
                return None;
            }

            Some(ZoomSegment {
                start,
                end,
                amount: 2.0,
                mode: ZoomMode::Auto,
            })
        })
        .collect()
}

/// Generates zoom segments based on mouse click events during recording.
/// Used during the recording completion process.
pub fn generate_zoom_segments_from_clicks(
    recording: &studio_recording::CompletedStudioRecording,
    recordings: &ProjectRecordingsMeta,
) -> Vec<ZoomSegment> {
    // Build a temporary RecordingMeta so we can use the common implementation
    let recording_meta = RecordingMeta {
        platform: None,
        project_path: recording.project_path.clone(),
        pretty_name: String::new(),
        sharing: None,
        inner: RecordingMetaInner::Studio(recording.meta.clone()),
    };

    generate_zoom_segments_for_project(&recording_meta, recordings)
}

/// Generates zoom segments from clicks for an existing project.
/// Used in the editor context where we have RecordingMeta.
pub fn generate_zoom_segments_for_project(
    recording_meta: &RecordingMeta,
    recordings: &ProjectRecordingsMeta,
) -> Vec<ZoomSegment> {
    let RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        return Vec::new();
    };

    let mut all_clicks = Vec::new();
    let mut all_moves = Vec::new();

    match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            if let Some(cursor_path) = &segment.cursor {
                let mut events = CursorEvents::load_from_file(&recording_meta.path(cursor_path))
                    .unwrap_or_default();
                let pointer_ids = studio_meta.pointer_cursor_ids();
                let pointer_ids_ref = (!pointer_ids.is_empty()).then_some(&pointer_ids);
                events.stabilize_short_lived_cursor_shapes(
                    pointer_ids_ref,
                    SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
                );
                all_clicks = events.clicks;
                all_moves = events.moves;
            }
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            for segment in inner.segments.iter() {
                let events = segment.cursor_events(recording_meta);
                all_clicks.extend(events.clicks);
                all_moves.extend(events.moves);
            }
        }
    }

    generate_zoom_segments_from_clicks_impl(all_clicks, all_moves, recordings.duration())
}

fn project_config_from_recording(
    app: &AppHandle,
    completed_recording: &studio_recording::CompletedStudioRecording,
    recordings: &ProjectRecordingsMeta,
    default_config: Option<ProjectConfiguration>,
) -> ProjectConfiguration {
    let settings = GeneralSettingsStore::get(app)
        .unwrap_or(None)
        .unwrap_or_default();

    let mut config = default_config.unwrap_or_default();

    let timeline_segments = recordings
        .segments
        .iter()
        .enumerate()
        .map(|(i, segment)| TimelineSegment {
            recording_segment: i as u32,
            start: 0.0,
            end: segment.duration(),
            timescale: 1.0,
        })
        .collect::<Vec<_>>();

    let zoom_segments = if settings.auto_zoom_on_clicks {
        generate_zoom_segments_from_clicks(completed_recording, recordings)
    } else {
        Vec::new()
    };

    if !zoom_segments.is_empty() {
        config.cursor.size = 200;
    }

    config.timeline = Some(TimelineConfiguration {
        segments: timeline_segments,
        zoom_segments,
        scene_segments: Vec::new(),
    });

    config
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_event(time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 0,
            cursor_id: "default".to_string(),
            time_ms,
            down: true,
        }
    }

    fn move_event(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "default".to_string(),
            time_ms,
            x,
            y,
        }
    }

    #[test]
    fn skips_trailing_stop_click() {
        let segments = generate_zoom_segments_from_clicks_impl(
            vec![click_event(11_900.0)],
            vec![],
            12.0,
        );

        assert!(segments.is_empty(), "expected trailing stop click to be ignored");
    }

    #[test]
    fn generates_segment_for_sustained_activity() {
        let clicks = vec![click_event(1_200.0), click_event(4_200.0)];
        let moves = vec![
            move_event(1_500.0, 0.10, 0.12),
            move_event(1_720.0, 0.42, 0.45),
            move_event(1_940.0, 0.74, 0.78),
        ];

        let segments = generate_zoom_segments_from_clicks_impl(clicks, moves, 20.0);

        assert!(!segments.is_empty(), "expected activity to produce zoom segments");
        let first = &segments[0];
        assert!(first.start < first.end);
        assert!(first.end - first.start >= 1.3);
        assert!(first.end <= 19.5);
    }

    #[test]
    fn ignores_cursor_jitter() {
        let jitter_moves = (0..30)
            .map(|i| {
                let t = 1_000.0 + (i as f64) * 30.0;
                let delta = (i as f64) * 0.0004;
                move_event(t, 0.5 + delta, 0.5)
            })
            .collect::<Vec<_>>();

        let segments = generate_zoom_segments_from_clicks_impl(Vec::new(), jitter_moves, 15.0);

        assert!(segments.is_empty(), "small jitter should not generate segments");
    }
}
