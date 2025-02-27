use std::{path::PathBuf, sync::Arc, time::Instant};

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
    App, CurrentRecordingChanged, MutableState, NewRecordingAdded, PreCreatedVideo,
    RecordingStarted, RecordingStopped, UploadMode,
};
use cap_fail::fail;
use cap_flags::FLAGS;
use cap_media::sources::{CaptureScreen, CaptureWindow};
use cap_media::{feeds::CameraFeed, sources::ScreenCaptureTarget};
use cap_project::{
    ProjectConfiguration, StudioRecordingMeta, TimelineConfiguration, TimelineSegment, ZoomSegment,
    XY,
};
use cap_recording::CompletedRecording;
use cap_rendering::ProjectRecordings;
use cap_utils::spawn_actor;
use clipboard_rs::{Clipboard, ClipboardContext};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

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
) -> Result<(), String> {
    let mut state = state_mtx.write().await;

    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    // Check if auto_create_shareable_link is true and user is upgraded
    let general_settings = GeneralSettingsStore::get(&app)?;
    let auto_create_shareable_link = general_settings
        .map(|settings| settings.auto_create_shareable_link)
        .unwrap_or(false);

    if let Ok(Some(auth)) = AuthStore::get(&app) {
        if auto_create_shareable_link && auth.is_upgraded() {
            // Pre-create the video and get the shareable link
            if let Ok(s3_config) = get_s3_config(&app, false, None).await {
                let link = web_api::make_url(format!("/s/{}", s3_config.id()));

                state.pre_created_video = Some(PreCreatedVideo {
                    id: s3_config.id().to_string(),
                    link: link.clone(),
                    config: s3_config,
                });

                println!("Pre-created shareable link: {}", link);
            };
        }
    }

    if matches!(
        state.start_recording_options.capture_target,
        ScreenCaptureTarget::Window(_) | ScreenCaptureTarget::Area(_)
    ) {
        let _ = ShowCapWindow::WindowCaptureOccluder.show(&app);
    }

    let (actor, actor_done_rx) = cap_recording::spawn_recording_actor(
        id,
        recording_dir,
        state.start_recording_options.clone(),
        state.camera_feed.clone(),
        state.audio_input_feed.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    state.set_current_recording(actor);
    drop(state);

    spawn_actor({
        let app = app.clone();
        let state_mtx = Arc::clone(&state_mtx);
        async move {
            actor_done_rx.await.ok();

            let mut state = state_mtx.write().await;

            // this clears the current recording for us
            handle_recording_finished(app, None, &mut state).await.ok();
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

    handle_recording_finished(app, Some(completed_recording), &mut state).await?;

    Ok(())
}

async fn handle_recording_finished(
    app: AppHandle,
    completed_recording: Option<cap_recording::CompletedRecording>,
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
        let screenshots_dir = completed_recording.recording_dir.join("screenshots");
        std::fs::create_dir_all(&screenshots_dir).ok();

        let recording_meta = &completed_recording.meta;

        let recording_dir = completed_recording.recording_dir.clone();

        let fire_events = || {
            ShowCapWindow::PrevRecordings.show(&app).ok();

            NewRecordingAdded {
                path: recording_dir.clone(),
            }
            .emit(&app)
            .ok();

            RecordingStopped {
                path: recording_dir,
            }
            .emit(&app)
            .ok();
        };

        match &recording_meta.inner {
            cap_project::RecordingMetaInner::Studio(meta) => {
                let display_output_path = match &meta {
                    StudioRecordingMeta::SingleSegment { segment } => {
                        recording_meta.path(&segment.display.path)
                    }
                    StudioRecordingMeta::MultipleSegments { inner } => {
                        recording_meta.path(&inner.segments[0].display.path)
                    }
                };

                let display_screenshot = screenshots_dir.join("display.jpg");
                create_screenshot(display_output_path, display_screenshot.clone(), None).await?;

                fire_events();

                let recordings = ProjectRecordings::new(&completed_recording.meta, meta);

                let config = project_config_from_recording(
                    &completed_recording,
                    &recordings,
                    PresetsStore::get_default_preset(&app)?.map(|p| p.config),
                );

                config
                    .write(&completed_recording.recording_dir)
                    .map_err(|e| e.to_string())?;

                if let Some(pre_created_video) = state.pre_created_video.take() {
                    let max_fps = meta.max_fps();
                    spawn_actor({
                        let app = app.clone();
                        async move {
                            if let Some((settings, auth)) = GeneralSettingsStore::get(&app)
                                .ok()
                                .flatten()
                                .zip(AuthStore::get(&app).ok().flatten())
                            {
                                if auth.is_upgraded() && settings.auto_create_shareable_link {
                                    // Copy link to clipboard
                                    let _ = app
                                        .state::<MutableState<'_, ClipboardContext>>()
                                        .write()
                                        .await
                                        .set_text(pre_created_video.link.clone());

                                    // Send notification for shareable link
                                    notifications::send_notification(
                                        &app,
                                        notifications::NotificationType::ShareableLinkCopied,
                                    );

                                    // Open the pre-created shareable link
                                    open_external_link(app.clone(), pre_created_video.link.clone())
                                        .ok();

                                    // Start the upload process in the background with retry mechanism
                                    let app = app.clone();

                                    tauri::async_runtime::spawn(async move {
                                        let max_retries = 3;
                                        let mut retry_count = 0;

                                        export_video(
                                            app.clone(),
                                            completed_recording.id.clone(),
                                            tauri::ipc::Channel::new(|_| Ok(())),
                                            true,
                                            max_fps,
                                            XY::new(1920, 1080),
                                        )
                                        .await
                                        .ok();

                                        while retry_count < max_retries {
                                            match upload_exported_video(
                                                app.clone(),
                                                completed_recording.id.clone(),
                                                UploadMode::Initial {
                                                    pre_created_video: Some(
                                                        pre_created_video.clone(),
                                                    ),
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
                                                        tokio::time::sleep(
                                                            std::time::Duration::from_secs(5),
                                                        )
                                                        .await;
                                                    } else {
                                                        println!(
                                                            "Max retries reached. Upload failed."
                                                        );
                                                        notifications::send_notification(
                                                            &app,
                                                            notifications::NotificationType::UploadFailed,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    });
                                } else if settings.open_editor_after_recording {
                                    open_editor(app.clone(), completed_recording.id);
                                }
                            }
                        }
                    });
                }
            }
            cap_project::RecordingMetaInner::Instant(meta) => {
                fire_events();

                dbg!(meta);
            }
        }
    };

    AppSounds::StopRecording.play();

    CurrentRecordingChanged.emit(&app).ok();

    Ok(())
}

fn generate_zoom_segments_from_clicks(
    recording: &CompletedRecording,
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
    completed_recording: &CompletedRecording,
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
