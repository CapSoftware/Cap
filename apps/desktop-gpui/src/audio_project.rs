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

/// A failure to show as it is: both lines are already in the person's
/// language, and whatever explains it went to the log.
pub struct Shown {
    pub title: &'static str,
    pub message: &'static str,
}

impl Shown {
    fn show(&self) {
        platform::alert_dialog(self.title, self.message);
    }
}

enum OpenFailure {
    Shown(Shown),
    Other(String),
}

impl From<String> for OpenFailure {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

/// Builds an audio-only project from `sources` in the recordings folder and
/// opens it in the editor. The work runs off the UI thread; a failure is
/// reported in a dialog.
pub fn open_audio_in_editor(sources: AudioProjectSources, pretty_name: String, cx: &mut App) {
    open_prepared_audio_in_editor(move || Ok((sources, ())), pretty_name, cx);
}

/// [`open_audio_in_editor`] for sources that take work to produce, such as a
/// note recorded in several pieces. `prepare` runs off the UI thread, and
/// what it returns beside the sources (a scratch folder, say) is dropped once
/// the project has its own copies.
pub fn open_prepared_audio_in_editor<Keep: Send + 'static>(
    prepare: impl FnOnce() -> Result<(AudioProjectSources, Keep), Shown> + Send + 'static,
    pretty_name: String,
    cx: &mut App,
) {
    let created = cx.background_executor().spawn(async move {
        let (sources, _keep) = prepare().map_err(OpenFailure::Shown)?;
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
                Err(error) => break Err(OpenFailure::Other(error.to_string())),
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
        Err(OpenFailure::Shown(shown)) => shown.show(),
        Err(OpenFailure::Other(error)) => {
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
    save_prepared_audio_as(pretty_name, move || Ok((project_path, ())), window, cx);
}

/// [`save_audio_as`] for a project made only once a place is chosen.
/// `prepare` runs off the UI thread after the save panel closes, and what it
/// returns beside the project path is kept until the file is written.
pub fn save_prepared_audio_as<Keep: Send + 'static>(
    pretty_name: String,
    prepare: impl FnOnce() -> Result<(PathBuf, Keep), Shown> + Send + 'static,
    window: &mut Window,
    cx: &mut App,
) {
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
            let Ok(prepared) =
                cx.update(|_, cx| cx.background_executor().spawn(async move { prepare() }))
            else {
                return;
            };
            let (project_path, _keep) = match prepared.await {
                Ok(prepared) => prepared,
                Err(shown) => {
                    shown.show();
                    return;
                }
            };
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
                    Shown {
                        title: tr::editor::export::audio::failed_title(),
                        message: tr::editor::export::audio::failed_message(),
                    }
                    .show();
                }
                Err(error) => {
                    tracing::error!(%error, "the audio save task ended without a result")
                }
            }
        })
        .detach();
}
