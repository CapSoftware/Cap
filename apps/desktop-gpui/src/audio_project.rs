use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

use cap_export::{
    audio::AudioExportFormat,
    audio_project::{AudioProjectError, AudioProjectSources, create_audio_only_project},
};
use gpui::{App, Window};

use crate::{app_windows, i18n::tr, platform};

/// Builds an audio-only project from `sources` in the recordings folder and
/// opens it in the editor. The work runs off the UI thread; a failure is
/// reported in a dialog.
pub fn open_audio_in_editor(sources: AudioProjectSources, pretty_name: String, cx: &mut App) {
    let created = cx.background_executor().spawn(async move {
        let recordings_dir = crate::recording::recordings_dir();
        std::fs::create_dir_all(&recordings_dir).map_err(|error| error.to_string())?;
        let folder = sanitize_filename::sanitize(&pretty_name);
        // A free name is only a hint: another import can claim it first, and
        // creation then refuses it, so pick again.
        let mut attempts = 0;
        loop {
            let name =
                cap_utils::ensure_unique_filename(&format!("{folder}.cap"), &recordings_dir)?;
            let project_path = recordings_dir.join(name);
            match create_audio_only_project(&project_path, &pretty_name, &sources) {
                Ok(_) => break Ok(project_path),
                Err(AudioProjectError::Exists(_)) if attempts < 8 => attempts += 1,
                Err(error) => break Err(error.to_string()),
            }
        }
    });
    cx.spawn(async move |cx| match created.await {
        Ok(project_path) => {
            tracing::info!(path = %project_path.display(), "created audio-only project");
            cx.update(|cx| {
                crate::import::refresh_libraries(cx);
                app_windows::open_editor(project_path, cx);
            });
        }
        Err(error) => {
            tracing::error!(error, "could not create an audio-only project");
            crate::import::show_error_dialog(tr::import::audio_failed(&error));
        }
    })
    .detach();
}

/// Asks where to save, then writes the project's edited sound there as MP3,
/// or WAV when the chosen name ends in `.wav`.
pub fn save_audio_as(project_path: PathBuf, window: &mut Window, cx: &mut App) {
    let pretty_name = cap_project::RecordingMeta::load_for_project(&project_path)
        .map(|meta| meta.pretty_name)
        .unwrap_or_else(|_| "Cap Recording".into());
    window
        .spawn(cx, async move |cx| {
            let default = crate::editor_export::export_file_name(&pretty_name, "mp3");
            #[cfg(target_os = "macos")]
            let chosen = {
                let _ = &cx;
                platform::try_save_file_panel(&default, &["mp3", "wav"])
                    .ok()
                    .flatten()
            };
            #[cfg(not(target_os = "macos"))]
            let chosen = platform::save_file_panel_async(&default, &["mp3", "wav"], cx).await;
            let Some(output) = chosen else {
                return;
            };
            let format = output
                .extension()
                .and_then(|extension| extension.to_str())
                .and_then(AudioExportFormat::from_extension)
                .unwrap_or(AudioExportFormat::Mp3);
            let output = output.with_extension(format.extension());
            let Ok(export) = cx.update(|_, cx| {
                gpui_tokio::Tokio::spawn(
                    cx,
                    cap_export::audio::export_audio(
                        project_path,
                        None,
                        format,
                        output,
                        Arc::new(AtomicBool::new(false)),
                        |_| {},
                    ),
                )
            }) else {
                return;
            };
            match export.await {
                Ok(Ok(path)) => {
                    tracing::info!(path = %path.display(), "saved project audio");
                    crate::app_sounds::play_notification();
                }
                Ok(Err(error)) => {
                    tracing::error!(%error, "could not save project audio");
                    crate::import::show_error_dialog(error.to_string());
                }
                Err(error) => {
                    tracing::error!(%error, "the audio save task ended without a result")
                }
            }
        })
        .detach();
}
