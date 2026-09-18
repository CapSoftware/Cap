use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use base64::Engine;
use cap_enc_ffmpeg::remux::get_media_duration;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Window, path::BaseDirectory};

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

struct WaveformCancellation {
    flag: Arc<AtomicBool>,
    wake: tokio::sync::Notify,
}

impl WaveformCancellation {
    fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.wake.notify_one();
    }
}

type WaveformRequests = HashMap<u64, Arc<WaveformCancellation>>;

static ACTIVE_WAVEFORMS: LazyLock<Mutex<HashMap<String, WaveformRequests>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_WAVEFORM_REQUEST: AtomicU64 = AtomicU64::new(0);

struct WaveformRequest {
    id: u64,
    window_label: String,
    cancellation: Arc<WaveformCancellation>,
}

impl WaveformRequest {
    fn new(window_label: &str) -> Result<Self, String> {
        let id = NEXT_WAVEFORM_REQUEST.fetch_add(1, Ordering::Relaxed);
        let cancellation = Arc::new(WaveformCancellation {
            flag: Arc::new(AtomicBool::new(false)),
            wake: tokio::sync::Notify::new(),
        });
        ACTIVE_WAVEFORMS
            .lock()
            .map_err(|error| format!("Waveform request registry unavailable: {error}"))?
            .entry(window_label.to_string())
            .or_default()
            .insert(id, cancellation.clone());
        Ok(Self {
            id,
            window_label: window_label.to_string(),
            cancellation,
        })
    }
}

impl Drop for WaveformRequest {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Ok(mut active) = ACTIVE_WAVEFORMS.lock()
            && let Some(requests) = active.get_mut(&self.window_label)
        {
            requests.remove(&self.id);
            if requests.is_empty() {
                active.remove(&self.window_label);
            }
        }
    }
}

pub fn cancel_imported_waveforms_for_window(window_label: &str) {
    if let Ok(active) = ACTIVE_WAVEFORMS.lock()
        && let Some(requests) = active.get(window_label)
    {
        for cancellation in requests.values() {
            cancellation.cancel();
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_imported_waveforms(window: Window) {
    cancel_imported_waveforms_for_window(window.label());
}

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

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(editor_instance, window))]
pub async fn get_imported_waveform(
    editor_instance: WindowEditorInstance,
    window: Window,
    path: String,
) -> Result<String, String> {
    let request = WaveformRequest::new(window.label())?;
    let _slot = tokio::select! {
        permit = cap_audio::imported_waveform_slots().acquire() => {
            permit.map_err(|error| format!("Waveform worker unavailable: {error}"))?
        }
        _ = request.cancellation.wake.notified() => {
            return Err("Waveform request cancelled".into());
        }
    };
    if request.cancellation.flag.load(Ordering::Acquire) {
        return Err("Waveform request cancelled".into());
    }
    let project_path = editor_instance.project_path.clone();
    let cancellation = request.cancellation.flag.clone();
    let peaks = tokio::task::spawn_blocking(move || {
        cap_audio::imported_waveform(&project_path, &path, cancellation)
    })
    .await
    .map_err(|error| format!("Waveform task failed: {error}"))??;
    if request.cancellation.flag.load(Ordering::Acquire) {
        return Err("Waveform request cancelled".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(peaks.as_ref()))
}

#[cfg(test)]
mod waveform_tests {
    use super::*;

    #[tokio::test]
    async fn closing_editor_cancels_queued_waveforms_and_clears_registry() {
        let request = WaveformRequest::new("waveform-test-editor").unwrap();
        cancel_imported_waveforms_for_window("waveform-test-editor");
        request.cancellation.wake.notified().await;
        assert!(request.cancellation.flag.load(Ordering::Acquire));
        drop(request);
        assert!(
            ACTIVE_WAVEFORMS
                .lock()
                .unwrap()
                .get("waveform-test-editor")
                .is_none()
        );
    }
}
