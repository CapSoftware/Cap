use std::path::PathBuf;

use cap_enc_ffmpeg::remux::get_media_duration;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, path::BaseDirectory};

use crate::editor_window::WindowEditorInstance;

const AUDIO_IMPORT_EXTENSIONS: &[&str] = &["ogg", "m4a", "mp3", "wav", "aac", "flac"];

/// Built-in music tracks bundled as Tauri resources under `assets/music/{id}.mp3`.
/// `id` doubles as the bundled file stem so the resource path is derivable.
const AUDIO_LIBRARY: &[(&str, &str)] = &[
    ("lofi-beats-mirostar", "Lofi Beats"),
    ("raindrops-lofi-sleep-bluelike", "Raindrops"),
    ("sunday-mood-lofi-cafe-upbeat-bluelike", "Sunday Mood"),
    ("good-night-lofi-cozy-chill-fassounds", "Good Night"),
    (
        "ambient-trap-empty-streets-dreamstate-openmindaudio",
        "Empty Streets",
    ),
    ("lofi-study-calm-peaceful-chill-hop-fassounds", "Study"),
    ("lofi-cinematic-pulsebox", "Cinematic"),
    ("lofi-hip-hop-leberch", "Hip Hop"),
    ("cassette-retrositive", "Cassette"),
    ("lofi-smooth-pulsebox", "Smooth"),
];

const AUDIO_LIBRARY_CATEGORY: &str = "Lo-Fi";

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioLibraryTrack {
    pub id: String,
    pub name: String,
    pub category: String,
}

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAudioTrack {
    /// Path relative to the project directory, e.g. `assets/audio/<file>`.
    pub path: String,
    pub name: String,
    pub duration: f64,
}

#[tauri::command]
#[specta::specta]
pub fn list_audio_library() -> Vec<AudioLibraryTrack> {
    AUDIO_LIBRARY
        .iter()
        .map(|(id, name)| AudioLibraryTrack {
            id: (*id).to_string(),
            name: (*name).to_string(),
            category: AUDIO_LIBRARY_CATEGORY.to_string(),
        })
        .collect()
}

fn probe_duration(path: &std::path::Path) -> f64 {
    get_media_duration(path)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, editor_instance))]
pub async fn add_audio_library_track(
    app: AppHandle,
    editor_instance: WindowEditorInstance,
    id: String,
) -> Result<ImportedAudioTrack, String> {
    let (_, name) = AUDIO_LIBRARY
        .iter()
        .find(|(track_id, _)| *track_id == id)
        .ok_or_else(|| format!("Unknown library track: {id}"))?;
    let name = (*name).to_string();

    let source = app
        .path()
        .resolve(format!("assets/music/{id}.mp3"), BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve bundled track: {e}"))?;

    let project_path = editor_instance.project_path.clone();

    tokio::task::spawn_blocking(move || {
        let audio_dir = project_path.join("assets").join("audio");
        std::fs::create_dir_all(&audio_dir)
            .map_err(|e| format!("Failed to create audio directory: {e}"))?;

        // Stable name so re-adding a library track reuses the existing copy.
        let dest_name = format!("library-{id}.mp3");
        let dest = audio_dir.join(&dest_name);

        if !dest.exists() {
            std::fs::copy(&source, &dest).map_err(|e| {
                format!(
                    "Failed to copy bundled track from {}: {e}",
                    source.display()
                )
            })?;
        }

        Ok(ImportedAudioTrack {
            path: format!("assets/audio/{dest_name}"),
            name,
            duration: probe_duration(&dest),
        })
    })
    .await
    .map_err(|e| format!("Audio import task failed: {e}"))?
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(editor_instance))]
pub async fn import_audio_track_file(
    editor_instance: WindowEditorInstance,
    source_path: String,
) -> Result<ImportedAudioTrack, String> {
    let source = PathBuf::from(&source_path);

    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .ok_or_else(|| "Audio file has no extension".to_string())?;

    if !AUDIO_IMPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("Unsupported audio format: .{extension}"));
    }

    let display_name = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Audio")
        .to_string();

    let project_path = editor_instance.project_path.clone();

    tokio::task::spawn_blocking(move || {
        if !source.exists() {
            return Err(format!("Audio file not found: {}", source.display()));
        }

        let audio_dir = project_path.join("assets").join("audio");
        std::fs::create_dir_all(&audio_dir)
            .map_err(|e| format!("Failed to create audio directory: {e}"))?;

        let dest_name = format!("{}.{extension}", uuid::Uuid::new_v4());
        let dest = audio_dir.join(&dest_name);
        std::fs::copy(&source, &dest).map_err(|e| format!("Failed to copy audio file: {e}"))?;

        Ok(ImportedAudioTrack {
            path: format!("assets/audio/{dest_name}"),
            name: display_name,
            duration: probe_duration(&dest),
        })
    })
    .await
    .map_err(|e| format!("Audio import task failed: {e}"))?
}
