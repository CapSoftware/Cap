use cap_fail::fail;
use cap_project::{
    CursorClickEvent, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    SharingMeta, StudioRecordingMeta, TimelineConfiguration, TimelineSegment, ZoomMode,
    ZoomSegment, cursor::CursorEvents,
};
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
use std::{path::PathBuf, str::FromStr, sync::Arc, time::Duration};
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
        recording: studio_recording::CompletedRecording,
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
                        let mut builder = studio_recording::_Actor::builder(
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
    recordings: &ProjectRecordingsMeta,
) -> Vec<ZoomSegment> {
    const ZOOM_SEGMENT_AFTER_CLICK_PADDING: f64 = 1.5;
    const ZOOM_SEGMENT_BEFORE_CLICK_PADDING: f64 = 0.8;
    const ZOOM_DURATION: f64 = 1.0;
    const CLICK_GROUP_THRESHOLD: f64 = 0.6; // seconds
    const MIN_SEGMENT_PADDING: f64 = 2.0; // minimum gap between segments

    let max_duration = recordings.duration();

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut segments = Vec::<ZoomSegment>::new();

    // Generate segments around mouse clicks
    for click in &clicks {
        if !click.down {
            continue;
        }

        let time = click.time_ms / 1000.0;

        let proposed_start = (time - ZOOM_SEGMENT_BEFORE_CLICK_PADDING).max(0.0);
        let proposed_end = (time + ZOOM_SEGMENT_AFTER_CLICK_PADDING).min(max_duration);

        if let Some(last) = segments.last_mut() {
            // Merge if within group threshold OR if segments would be too close together
            if time <= last.end + CLICK_GROUP_THRESHOLD
                || proposed_start <= last.end + MIN_SEGMENT_PADDING
            {
                last.end = proposed_end;
                continue;
            }
        }

        if time < max_duration - ZOOM_DURATION {
            segments.push(ZoomSegment {
                start: proposed_start,
                end: proposed_end,
                amount: 2.0,
                mode: ZoomMode::Auto,
            });
        }
    }

    segments
}

/// Generates zoom segments based on mouse click events during recording.
/// Used during the recording completion process.
pub fn generate_zoom_segments_from_clicks(
    recording: &studio_recording::CompletedRecording,
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

    let all_events = match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            if let Some(cursor_path) = &segment.cursor {
                CursorEvents::load_from_file(&recording_meta.path(cursor_path))
                    .unwrap_or_default()
                    .clicks
            } else {
                vec![]
            }
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => inner
            .segments
            .iter()
            .flat_map(|s| s.cursor_events(recording_meta).clicks)
            .collect(),
    };

    generate_zoom_segments_from_clicks_impl(all_events, recordings)
}

fn project_config_from_recording(
    app: &AppHandle,
    completed_recording: &studio_recording::CompletedRecording,
    recordings: &ProjectRecordingsMeta,
    default_config: Option<ProjectConfiguration>,
) -> ProjectConfiguration {
    let settings = GeneralSettingsStore::get(app)
        .unwrap_or(None)
        .unwrap_or_default();

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
            zoom_segments: if settings.auto_zoom_on_clicks {
                generate_zoom_segments_from_clicks(completed_recording, recordings)
            } else {
                Vec::new()
            },
            scene_segments: Vec::new(),
        }),
        ..default_config.unwrap_or_default()
    }
}
