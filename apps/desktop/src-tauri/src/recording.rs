use std::time::Instant;

use crate::{
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot,
    export::export_video,
    general_settings::GeneralSettingsStore,
    list_recordings, notifications, open_editor, open_external_link, platform,
    upload::get_s3_config,
    upload_exported_video, web_api,
    windows::{CapWindowId, ShowCapWindow},
    App, CurrentRecordingChanged, MutableState, NewRecordingAdded, PreCreatedVideo,
    RecordingStarted, RecordingStopped, UploadMode,
};
use cap_flags::FLAGS;
use cap_media::feeds::CameraFeed;
use cap_media::sources::{AVFrameCapture, CaptureScreen, CaptureWindow, ScreenCaptureSource};
use cap_project::{
    Content, ProjectConfiguration, TimelineConfiguration, TimelineSegment, ZoomSegment,
};
use cap_recording::CompletedRecording;
use cap_rendering::ProjectRecordings;
use clipboard_rs::{Clipboard, ClipboardContext};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_screens() -> Vec<CaptureScreen> {
    ScreenCaptureSource::<AVFrameCapture>::list_screens()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_windows() -> Vec<CaptureWindow> {
    ScreenCaptureSource::<AVFrameCapture>::list_windows()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<String> {
    CameraFeed::list_cameras()
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

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

    if auto_create_shareable_link {
        sentry::configure_scope(|scope| {
            scope.set_tag("task", "auto_create_shareable_link");
        });

        if let Ok(Some(auth)) = AuthStore::get(&app) {
            if auth.is_upgraded() {
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
    }

    let actor = cap_recording::spawn_recording_actor(
        id,
        recording_dir,
        state.start_recording_options.clone(),
        state.camera_feed.clone(),
        state.audio_input_feed.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    state.set_current_recording(actor);

    if let Some(window) = CapWindowId::Main.get(&app) {
        window.minimize().ok();
    }

    if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
        window.eval("window.location.reload()").unwrap();
        window.show().unwrap();
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

    let now = Instant::now();
    let completed_recording = current_recording.stop().await.map_err(|e| e.to_string())?;
    println!("stopped recording in {:?}", now.elapsed());

    if let Some(window) = CapWindowId::InProgressRecording.get(&app) {
        window.hide().unwrap();
    }

    if let Some(window) = CapWindowId::Main.get(&app) {
        window.unminimize().ok();
    }

    let screenshots_dir = completed_recording.recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshots_dir).ok();

    let display_output_path = match &completed_recording.meta.content {
        Content::SingleSegment { segment } => {
            segment.path(&completed_recording.meta, &segment.display.path)
        }
        Content::MultipleSegments { inner } => {
            inner.path(&completed_recording.meta, &inner.segments[0].display.path)
        }
    };

    let display_screenshot = screenshots_dir.join("display.jpg");
    let now = Instant::now();
    create_screenshot(display_output_path, display_screenshot.clone(), None).await?;
    println!("created screenshot in {:?}", now.elapsed());

    // let thumbnail = screenshots_dir.join("thumbnail.png");
    // let now = Instant::now();
    // create_thumbnail(display_screenshot, thumbnail, (100, 100)).await?;
    // println!("created thumbnail in {:?}", now.elapsed());

    let recording_dir = completed_recording.recording_dir.clone();

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

    let recordings = ProjectRecordings::new(&completed_recording.meta);

    let config = project_config_from_recording(&completed_recording, &recordings);

    config
        .write(&completed_recording.recording_dir)
        .map_err(|e| e.to_string())?;

    AppSounds::StopRecording.play();

    if let Some((settings, auth)) = GeneralSettingsStore::get(&app)
        .ok()
        .flatten()
        .zip(AuthStore::get(&app).ok().flatten())
    {
        if auth.is_upgraded() && settings.auto_create_shareable_link {
            if let Some(pre_created_video) = state.pre_created_video.take() {
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
                open_external_link(app.clone(), pre_created_video.link.clone()).ok();

                // Start the upload process in the background with retry mechanism
                let app = app.clone();

                tauri::async_runtime::spawn(async move {
                    let max_retries = 3;
                    let mut retry_count = 0;

                    export_video(
                        app.clone(),
                        completed_recording.id.clone(),
                        config,
                        tauri::ipc::Channel::new(|_| Ok(())),
                        true,
                        true,
                    )
                    .await
                    .ok();

                    while retry_count < max_retries {
                        match upload_exported_video(
                            app.clone(),
                            completed_recording.id.clone(),
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
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
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
        } else if settings.open_editor_after_recording {
            open_editor(app.clone(), completed_recording.id);
        }
    }

    CurrentRecordingChanged.emit(&app).ok();

    Ok(())
}

fn generate_zoom_segments_from_clicks(
    recording: &CompletedRecording,
    recordings: &ProjectRecordings,
) -> Vec<ZoomSegment> {
    let mut segments = vec![];

    if !FLAGS.zoom {
        return vec![];
    };

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
) -> ProjectConfiguration {
    ProjectConfiguration {
        timeline: Some(TimelineConfiguration {
            segments: recordings
                .segments
                .iter()
                .enumerate()
                .map(|(i, segment)| TimelineSegment {
                    recording_segment: Some(i as u32),
                    start: 0.0,
                    end: segment.duration(),
                    timescale: 1.0,
                })
                .collect(),
            zoom_segments: generate_zoom_segments_from_clicks(&completed_recording, &recordings),
        }),
        ..Default::default()
    }
}
