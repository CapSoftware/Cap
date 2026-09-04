//! Caption transcription -- the gpui port of the Tauri binary's `captions.rs`
//! model management and transcription pipeline (Whisper + Parakeet), driving
//! the editor's Captions tab.
//!
//! Three pieces, all mirrored from the shipping app so the two binaries share
//! one model library on disk:
//!
//! * **models** -- the catalogue lives in `editor_tabs.rs` (`CAPTION_MODELS`);
//!   the files live in `{appLocalDataDir}/transcription_models/`, the exact
//!   directory the Tauri app resolves (`captions.ts:25,529-535`), so a model
//!   either app downloads is downloaded for both.
//! * **downloads** -- `download_whisper_model` / `download_parakeet_model`
//!   from `captions.rs:2062-2573`, streamed through reqwest with the same URL
//!   tables, part sizes and staging-directory finalisation. Status lives in a
//!   process-global [`Hub`], the stand-in for Tauri's `MODEL_DOWNLOADS` map +
//!   `DownloadProgress` events: the tab polls it instead of listening.
//! * **transcribe** -- `transcribe_audio` (`captions.rs:1315-1439`): mix the
//!   bundle's per-segment mic/system audio to 16kHz mono WAV via ffmpeg, then
//!   run whisper-rs or parakeet-rs with word timestamps and chunk the words
//!   into caption segments. `apply_caption_result` is
//!   `applyCaptionResultToProject` (`captions.ts:469-527`) plus the
//!   `deriveCaptionTrackSegments` projection (`captions.ts:323-366`) that the
//!   Tauri app runs in TypeScript.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use cap_project::{
    CaptionSegment, CaptionSettings, CaptionTrackSegment, CaptionWord, CaptionsData,
    ProjectConfiguration, RecordingMeta, StudioRecordingMeta, TimelineConfiguration,
    TimelineSegment,
};
use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
    software::resampling,
};
use futures_util::StreamExt;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::{editor_timeline::clip_timeline_offsets, store};

// ---------------------------------------------------------------------------
// Model catalogue & shared paths
// ---------------------------------------------------------------------------

/// `CAPTION_MODEL_FOLDER` (`captions.ts:25`).
pub const CAPTION_MODEL_FOLDER: &str = "transcription_models";

/// Every model the catalogue can name, for the disk scan.
const MODEL_NAMES: [&str; 4] = ["best", "best-max", "small", "medium"];

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PARAKEET_UNSUPPORTED_MESSAGE: &str = "Parakeet transcription is not available on Intel macOS";

/// The section of the shared tauri-plugin-store file this app parks its own
/// keys in; the Tauri app ignores sections it does not know. The two key names
/// mirror the `localStorage` keys `CaptionsTab.tsx` persists under.
pub const GPUI_STORE_SECTION: &str = "gpui";
pub const SELECTED_MODEL_KEY: &str = "selectedTranscriptionModel";
pub const SELECTED_LANGUAGE_KEY: &str = "selectedTranscriptionLanguage";

/// `supportsParakeetTranscription` (`captions.ts:54-56`).
pub fn supports_parakeet() -> bool {
    cfg!(not(all(target_os = "macos", target_arch = "x86_64")))
}

/// `PARAKEET_DIR_MODELS` (`captions.ts:26`).
pub fn is_parakeet_model(model: &str) -> bool {
    matches!(model, "best" | "best-max")
}

/// Tauri's `appLocalDataDir()` for the `so.cap.desktop` identifier: on macOS
/// `~/Library/Application Support`, on Windows `%LOCALAPPDATA%` (deliberately
/// *not* the roaming dir [`store::app_data_dir`] uses), on Linux
/// `$XDG_DATA_HOME`/`~/.local/share`.
fn app_local_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop")
}

pub fn models_dir() -> PathBuf {
    app_local_data_dir().join(CAPTION_MODEL_FOLDER)
}

/// `getModelPath` (`captions.ts:529-535`): Parakeet models are directories
/// named `parakeet-{model}`, Whisper models are single `{model}.bin` files.
pub fn model_path(model: &str) -> PathBuf {
    if is_parakeet_model(model) {
        models_dir().join(format!("parakeet-{model}"))
    } else {
        models_dir().join(format!("{model}.bin"))
    }
}

/// `check_model_exists` / `check_parakeet_model_exists`
/// (`captions.rs:2223-2226,2579-2597`).
fn model_files_present(model: &str) -> bool {
    let path = model_path(model);
    if !is_parakeet_model(model) {
        return path.exists();
    }
    if !supports_parakeet() || !path.is_dir() {
        return false;
    }
    let has_vocab = path.join("vocab.txt").exists();
    let has_full_model = path.join("encoder-model.onnx").exists()
        && path.join("encoder-model.onnx.data").exists()
        && path.join("decoder_joint-model.onnx").exists();
    let has_int8_model = path.join("encoder-model.int8.onnx").exists()
        && path.join("decoder_joint-model.int8.onnx").exists();
    has_vocab && (has_full_model || has_int8_model)
}

// ---------------------------------------------------------------------------
// Shared UI state -- the stand-in for Tauri's MODEL_DOWNLOADS + events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadState {
    Downloading,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ModelDownload {
    pub model: String,
    pub state: DownloadState,
    pub progress: f64,
    pub message: String,
}

#[derive(Default)]
struct Hub {
    /// One download at a time -- the tab disables its button while one runs,
    /// so Tauri's per-path map collapses to a single slot here.
    download: Option<ModelDownload>,
    /// `None` until the first disk scan.
    downloaded: Option<HashSet<String>>,
    deleting: Option<String>,
    generating: HashSet<PathBuf>,
    generation_errors: HashMap<PathBuf, String>,
}

impl Hub {
    fn work_in_flight(&self) -> bool {
        self.download
            .as_ref()
            .is_some_and(|download| download.state == DownloadState::Downloading)
            || !self.generating.is_empty()
            || self.deleting.is_some()
    }
}

static HUB: LazyLock<Mutex<Hub>> = LazyLock::new(|| Mutex::new(Hub::default()));

fn hub() -> std::sync::MutexGuard<'static, Hub> {
    HUB.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Everything `render_captions_tab` reads, snapshotted under one lock.
pub struct CaptionsUiSnapshot {
    pub download: Option<ModelDownload>,
    pub downloaded: HashSet<String>,
    pub deleting: Option<String>,
    pub generating: bool,
    pub generation_error: Option<String>,
}

pub fn ui_snapshot(project_path: &Path) -> CaptionsUiSnapshot {
    let hub = hub();
    CaptionsUiSnapshot {
        download: hub.download.clone(),
        downloaded: hub.downloaded.clone().unwrap_or_default(),
        deleting: hub.deleting.clone(),
        generating: hub.generating.contains(project_path),
        generation_error: hub.generation_errors.get(project_path).cloned(),
    }
}

pub fn download_active() -> bool {
    hub()
        .download
        .as_ref()
        .is_some_and(|download| download.state == DownloadState::Downloading)
}

pub fn work_in_flight() -> bool {
    hub().work_in_flight()
}

/// Rescan the catalogue against the disk -- `refreshDownloadedModels`
/// (`CaptionsTab.tsx:481-492`), minus the async round-trips.
pub fn refresh_downloaded_models() {
    let downloaded: HashSet<String> = MODEL_NAMES
        .iter()
        .filter(|model| model_files_present(model))
        .map(|model| (*model).to_string())
        .collect();
    hub().downloaded = Some(downloaded);
}

pub fn begin_download(model: &str) -> bool {
    let mut hub = hub();
    if hub
        .download
        .as_ref()
        .is_some_and(|download| download.state == DownloadState::Downloading)
    {
        return false;
    }
    hub.download = Some(ModelDownload {
        model: model.to_string(),
        state: DownloadState::Downloading,
        progress: 0.0,
        message: "Preparing model download".to_string(),
    });
    true
}

fn set_download_progress(model: &str, progress: f64, message: String) {
    let mut hub = hub();
    if let Some(download) = hub.download.as_mut()
        && download.model == model
        && download.state == DownloadState::Downloading
    {
        download.progress = progress.clamp(0.0, 100.0);
        download.message = message;
    }
}

/// The whole download, run on the tokio runtime; final status lands in the
/// hub the way Tauri's spawned task lands it in `MODEL_DOWNLOADS`
/// (`captions.rs:2079-2100`).
pub async fn run_model_download(model: String) {
    let result = if is_parakeet_model(&model) {
        download_parakeet_model(&model).await
    } else {
        download_whisper_model(&model).await
    };

    let status = match &result {
        Ok(()) => ModelDownload {
            model: model.clone(),
            state: DownloadState::Completed,
            progress: 100.0,
            message: "Download complete".to_string(),
        },
        Err(error) => {
            tracing::error!(model, "caption model download failed: {error}");
            ModelDownload {
                model: model.clone(),
                state: DownloadState::Failed,
                progress: 0.0,
                message: format!("Download failed: {error}"),
            }
        }
    };
    hub().download = Some(status);
    refresh_downloaded_models();
}

pub fn begin_delete(model: &str) -> bool {
    let mut hub = hub();
    if hub.deleting.is_some() {
        return false;
    }
    hub.deleting = Some(model.to_string());
    true
}

/// `delete_whisper_model` / `delete_parakeet_model`
/// (`captions.rs:2231-2245,2613-2628`), run on a background thread.
pub fn run_model_delete(model: &str) {
    if let Err(error) = delete_model_files(model) {
        tracing::warn!(model, "failed to delete caption model: {error}");
    }
    {
        let mut hub = hub();
        if hub.deleting.as_deref() == Some(model) {
            hub.deleting = None;
        }
        // A finished download record for this model no longer matches disk.
        if hub
            .download
            .as_ref()
            .is_some_and(|d| d.model == model && d.state != DownloadState::Downloading)
        {
            hub.download = None;
        }
    }
    refresh_downloaded_models();
}

fn delete_model_files(model: &str) -> Result<(), String> {
    let path = model_path(model);
    if !path.exists() {
        return Err(format!("Model file not found: {}", path.display()));
    }
    if is_parakeet_model(model) {
        invalidate_parakeet_cache_for_dir(&path);
        std::fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete model directory: {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete model file: {e}"))?;
        invalidate_whisper_cache_for_path(&path);
        Ok(())
    }
}

pub fn begin_generation(project_path: &Path) -> bool {
    let mut hub = hub();
    if hub.generating.contains(project_path) {
        return false;
    }
    hub.generation_errors.remove(project_path);
    hub.generating.insert(project_path.to_path_buf());
    true
}

pub fn finish_generation(project_path: &Path, error: Option<String>) {
    let mut hub = hub();
    hub.generating.remove(project_path);
    match error {
        Some(message) => {
            hub.generation_errors
                .insert(project_path.to_path_buf(), message);
        }
        None => {
            hub.generation_errors.remove(project_path);
        }
    }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// `MODEL_DOWNLOAD_REQUEST_TIMEOUT` (`captions.rs:2247`).
const MODEL_DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(60 * 60);

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// `download_whisper_model_to_path` (`captions.rs:2105-2196`), restricted to
/// the two Whisper entries the catalogue offers.
async fn download_whisper_model(model: &str) -> Result<(), String> {
    let model_parts: &[&str] = match model {
        "small" => &[
            "https://github.com/CapSoftware/transcription-models/releases/download/whisper-v1/ggml-small.bin",
        ],
        "medium" => &[
            "https://github.com/CapSoftware/transcription-models/releases/download/whisper-v1/ggml-medium.bin.part0",
            "https://github.com/CapSoftware/transcription-models/releases/download/whisper-v1/ggml-medium.bin.part1",
        ],
        _ => return Err(format!("Unknown Whisper model: {model}")),
    };

    let path = model_path(model);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {e}"))?;
    }

    let total_size = total_content_length(model_parts).await;

    let result = write_whisper_parts(model, model_parts, &path, total_size).await;
    if result.is_err() {
        // Unlike the Tauri version, drop the half-written file: it lives at
        // the final path, and a later existence check would call it a model.
        let _ = std::fs::remove_file(&path);
    }
    result
}

async fn write_whisper_parts(
    model: &str,
    model_parts: &[&str],
    path: &Path,
    total_size: u64,
) -> Result<(), String> {
    let mut file = File::create(path).map_err(|e| format!("Failed to create file: {e}"))?;

    let mut downloaded: u64 = 0;
    let part_count = model_parts.len() as f64;

    for (idx, url) in model_parts.iter().enumerate() {
        let response = HTTP
            .get(*url)
            .timeout(MODEL_DOWNLOAD_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("Failed to download model: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to download model: HTTP {}",
                response.status()
            ));
        }

        let part_size = response.content_length().unwrap_or(0);
        let mut downloaded_part: u64 = 0;
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Error while downloading: {e}"))?;

            file.write_all(&chunk)
                .map_err(|e| format!("Error while writing to file: {e}"))?;

            downloaded = downloaded.saturating_add(chunk.len() as u64);
            downloaded_part = downloaded_part.saturating_add(chunk.len() as u64);

            let progress = if total_size > 0 {
                (downloaded as f64 / total_size as f64) * 100.0
            } else if part_size > 0 {
                ((idx as f64 + downloaded_part as f64 / part_size as f64) / part_count) * 100.0
            } else {
                (idx as f64 / part_count) * 100.0
            };

            set_download_progress(
                model,
                progress,
                format!("Downloading model: {progress:.0}%"),
            );
        }
    }

    file.flush()
        .map_err(|e| format!("Failed to flush file: {e}"))
}

/// `total_content_length` (`captions.rs:2198-2218`).
async fn total_content_length(urls: &[&str]) -> u64 {
    let mut total: u64 = 0;
    for url in urls {
        let Ok(resp) = HTTP
            .head(*url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
        else {
            return 0;
        };
        if !resp.status().is_success() {
            return 0;
        }
        match resp.content_length() {
            Some(size) => total = total.saturating_add(size),
            None => return 0,
        }
    }
    total
}

/// `PARAKEET_TDT_INT8_MODEL_FILES` (`captions.rs:2249-2268`).
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_TDT_INT8_MODEL_FILES: &[(&str, &[&str])] = &[
    (
        "encoder-model.int8.onnx",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/encoder-model.int8.onnx",
        ],
    ),
    (
        "decoder_joint-model.int8.onnx",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/decoder_joint-model.int8.onnx",
        ],
    ),
    (
        "vocab.txt",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/vocab.txt",
        ],
    ),
];

/// `PARAKEET_TDT_FULL_MODEL_FILES` (`captions.rs:2270-2296`).
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_TDT_FULL_MODEL_FILES: &[(&str, &[&str])] = &[
    (
        "encoder-model.onnx",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/encoder-model.onnx",
        ],
    ),
    (
        "encoder-model.onnx.data",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/encoder-model.onnx.data.part0",
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/encoder-model.onnx.data.part1",
        ],
    ),
    (
        "decoder_joint-model.onnx",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/decoder_joint-model.onnx",
        ],
    ),
    (
        "vocab.txt",
        &[
            "https://github.com/CapSoftware/transcription-models/releases/download/parakeet-tdt-v1/vocab.txt",
        ],
    ),
];

/// `PARAKEET_MODEL_CLEANUP_FILES` (`captions.rs:2298-2306`).
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_MODEL_CLEANUP_FILES: &[&str] = &[
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

/// `PARAKEET_KNOWN_PART_SIZES` (`captions.rs:2308-2316`).
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_KNOWN_PART_SIZES: &[(&str, u64)] = &[
    ("encoder-model.int8.onnx", 652_183_999),
    ("decoder_joint-model.int8.onnx", 18_202_004),
    ("encoder-model.onnx", 41_770_866),
    ("encoder-model.onnx.data.part0", 1_300_000_000),
    ("encoder-model.onnx.data.part1", 1_135_420_160),
    ("decoder_joint-model.onnx", 72_520_893),
    ("vocab.txt", 93_939),
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn parakeet_known_part_size(url: &str) -> Option<u64> {
    PARAKEET_KNOWN_PART_SIZES
        .iter()
        .find_map(|(name, size)| url.ends_with(name).then_some(*size))
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn parakeet_model_files_for_dir(
    output_dir: &Path,
) -> &'static [(&'static str, &'static [&'static str])] {
    match output_dir.file_name().and_then(|name| name.to_str()) {
        Some("parakeet-best-max") => PARAKEET_TDT_FULL_MODEL_FILES,
        _ => PARAKEET_TDT_INT8_MODEL_FILES,
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn parakeet_staging_dir(validated_dir: &Path) -> PathBuf {
    validated_dir.with_file_name(format!(
        "{}.downloading",
        validated_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model")
    ))
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
async fn parakeet_model_file_sizes(
    model_files: &'static [(&'static str, &'static [&'static str])],
) -> Result<Vec<(&'static str, u64)>, String> {
    let mut sizes = Vec::with_capacity(model_files.len());
    for (filename, urls) in model_files {
        let mut file_size = 0_u64;
        for url in *urls {
            let resp = HTTP
                .head(*url)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Failed to get size for {filename}: {e}"))?;

            if !resp.status().is_success() {
                return Err(format!(
                    "Failed to get size for {filename}: HTTP {}",
                    resp.status()
                ));
            }

            let part_size = resp
                .content_length()
                .filter(|size| *size > 0)
                .or_else(|| parakeet_known_part_size(url))
                .unwrap_or(0);
            file_size = file_size.saturating_add(part_size);
        }
        sizes.push((*filename, file_size));
    }
    Ok(sizes)
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn parakeet_model_files_match(dir: &Path, expected_files: &[(&str, u64)]) -> bool {
    expected_files.iter().all(|(filename, expected_size)| {
        let Ok(metadata) = std::fs::metadata(dir.join(filename)) else {
            return false;
        };
        metadata.is_file() && (*expected_size == 0 || metadata.len() == *expected_size)
    })
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn finalize_parakeet_model_download(
    validated_dir: &Path,
    staging_dir: &Path,
    model_files: &'static [(&'static str, &'static [&'static str])],
) -> Result<(), String> {
    std::fs::create_dir_all(validated_dir)
        .map_err(|e| format!("Failed to create model directory: {e}"))?;

    for filename in PARAKEET_MODEL_CLEANUP_FILES {
        let file_path = validated_dir.join(filename);
        if file_path.exists() {
            let _ = std::fs::remove_file(&file_path);
        }
    }

    for (filename, _) in model_files {
        let src = staging_dir.join(filename);
        let dst = validated_dir.join(filename);
        std::fs::rename(&src, &dst)
            .map_err(|e| format!("Failed to move {filename} to final location: {e}"))?;
    }

    let _ = std::fs::remove_dir_all(staging_dir);
    Ok(())
}

/// `download_parakeet_model_to_dir` (`captions.rs:2455-2565`): staged into a
/// sibling `.downloading` directory, size-verified, then renamed into place.
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
async fn download_parakeet_model(model: &str) -> Result<(), String> {
    let validated_dir = model_path(model);
    std::fs::create_dir_all(&validated_dir)
        .map_err(|e| format!("Failed to create model directory: {e}"))?;

    let model_files = parakeet_model_files_for_dir(&validated_dir);
    let expected_file_sizes = parakeet_model_file_sizes(model_files).await?;

    let staging_dir = parakeet_staging_dir(&validated_dir);
    if parakeet_model_files_match(&staging_dir, &expected_file_sizes) {
        tracing::info!("Finalizing previously completed Parakeet model download");
        finalize_parakeet_model_download(&validated_dir, &staging_dir, model_files)?;
        invalidate_parakeet_cache_for_dir(&validated_dir);
        return Ok(());
    }

    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to clean staging directory: {e}"))?;
    }
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging directory: {e}"))?;

    let total_size = expected_file_sizes
        .iter()
        .fold(0_u64, |acc, (_, size)| acc.saturating_add(*size));

    let mut downloaded_total: u64 = 0;

    let download_result: Result<(), String> = async {
        for (idx, (filename, urls)) in model_files.iter().enumerate() {
            let file_path = staging_dir.join(filename);
            let mut file = File::create(&file_path)
                .map_err(|e| format!("Failed to create {filename}: {e}"))?;

            for url in *urls {
                tracing::info!("Downloading {filename} part from {url}");

                let response = HTTP
                    .get(*url)
                    .timeout(MODEL_DOWNLOAD_REQUEST_TIMEOUT)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download {filename}: {e}"))?;

                if !response.status().is_success() {
                    return Err(format!(
                        "Failed to download {filename}: HTTP {}",
                        response.status()
                    ));
                }

                let mut stream = response.bytes_stream();
                while let Some(chunk_result) = stream.next().await {
                    let chunk =
                        chunk_result.map_err(|e| format!("Download error for {filename}: {e}"))?;
                    file.write_all(&chunk)
                        .map_err(|e| format!("Write error for {filename}: {e}"))?;

                    downloaded_total = downloaded_total.saturating_add(chunk.len() as u64);

                    let progress = if total_size > 0 {
                        (downloaded_total as f64 / total_size as f64) * 100.0
                    } else {
                        ((idx as f64 + 0.5) / model_files.len() as f64) * 100.0
                    };

                    set_download_progress(
                        model,
                        progress,
                        format!("Downloading {filename}: {progress:.0}%"),
                    );
                }
            }

            file.flush()
                .map_err(|e| format!("Failed to flush {filename}: {e}"))?;

            tracing::info!("Finished downloading {filename}");
        }
        Ok(())
    }
    .await;

    if let Err(e) = &download_result {
        tracing::warn!("Download failed, cleaning up staging directory: {e}");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e.clone());
    }

    if !parakeet_model_files_match(&staging_dir, &expected_file_sizes) {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err("Downloaded model files did not match expected sizes".to_string());
    }

    finalize_parakeet_model_download(&validated_dir, &staging_dir, model_files)?;
    invalidate_parakeet_cache_for_dir(&validated_dir);
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
async fn download_parakeet_model(_model: &str) -> Result<(), String> {
    Err(PARAKEET_UNSUPPORTED_MESSAGE.to_string())
}

// ---------------------------------------------------------------------------
// Engine contexts
// ---------------------------------------------------------------------------

/// `TRANSCRIPTION_LOCK` (`captions.rs:58`): one engine run at a time,
/// process-wide.
static TRANSCRIPTION_LOCK: Mutex<()> = Mutex::new(());

fn lock_transcription_worker_slot() -> std::sync::MutexGuard<'static, ()> {
    TRANSCRIPTION_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

struct CachedWhisperContext {
    model_path: String,
    context: Arc<WhisperContext>,
}

static WHISPER_CONTEXT: LazyLock<Mutex<Option<CachedWhisperContext>>> =
    LazyLock::new(|| Mutex::new(None));

fn invalidate_whisper_cache_for_path(model_path: &Path) {
    let removed = {
        let mut guard = WHISPER_CONTEXT
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if guard
            .as_ref()
            .is_some_and(|cached| Path::new(&cached.model_path) == model_path)
        {
            guard.take()
        } else {
            None
        }
    };
    drop(removed);
}

/// `get_whisper_context_blocking` (`captions.rs:691-707`), keyed by model path
/// so switching small -> medium reloads instead of reusing the stale context.
fn get_whisper_context(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    cap_utils::local_captions::ensure_whisper_cpu_support()?;
    let mut guard = WHISPER_CONTEXT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);

    if let Some(cached) = guard.as_ref()
        && cached.model_path == model_path
    {
        tracing::info!("Reusing cached Whisper context");
        return Ok(cached.context.clone());
    }

    tracing::info!("Initializing Whisper context with model: {model_path}");
    let context = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

    let context = Arc::new(context);
    *guard = Some(CachedWhisperContext {
        model_path: model_path.to_string(),
        context: context.clone(),
    });
    Ok(context)
}

/// `release_whisper_context_after_transcription` (`captions.rs:709-716`):
/// Apple-silicon Macs drop the context after every run to give the memory
/// back; elsewhere it is kept for the next run.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn release_whisper_context_after_transcription() {
    *WHISPER_CONTEXT
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = None;
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn release_whisper_context_after_transcription() {}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
struct CachedParakeetContext {
    model_dir: String,
    model: Arc<Mutex<ParakeetTDT>>,
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
static PARAKEET_CONTEXT: LazyLock<Mutex<Option<CachedParakeetContext>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn invalidate_parakeet_cache_for_dir(model_dir: &Path) {
    let mut guard = PARAKEET_CONTEXT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if guard
        .as_ref()
        .is_some_and(|cached| cached.model_dir.as_str() == model_dir.to_string_lossy().as_ref())
    {
        tracing::info!(
            "Invalidating cached Parakeet context for {}",
            model_dir.display()
        );
        *guard = None;
    }
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn invalidate_parakeet_cache_for_dir(_model_dir: &Path) {}

// ---------------------------------------------------------------------------
// Audio extraction
// ---------------------------------------------------------------------------

/// `cap_audio::AudioData::SAMPLE_RATE` -- the rate every source is decoded to
/// before mixing, matching the Tauri pipeline's intermediate format.
const DECODE_SAMPLE_RATE: u32 = 48_000;
/// `WHISPER_SAMPLE_RATE` (`captions.rs:66`).
const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// `AudioData::from_file` (`crates/audio/src/audio_data.rs:22-95`) transcribed
/// against the same ffmpeg fork: any input decoded to packed f32 at 48kHz,
/// mono stays mono, everything else downmixes to stereo.
fn decode_audio_file(path: &Path) -> Result<(Vec<f32>, usize), String> {
    let mut input_ctx = avformat::input(&path).map_err(|e| format!("Input Open / {e}"))?;
    let input_stream = input_ctx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| "No Stream".to_string())?;

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
        .map_err(|e| format!("Decoder Parameters / {e}"))?;
    let mut decoder = decoder_ctx
        .decoder()
        .audio()
        .map_err(|e| format!("Set Parameters / {e}"))?;

    let source_channels = decoder.channels().max(1);
    if decoder.channel_layout().is_empty() {
        decoder.set_channel_layout(ChannelLayout::default(i32::from(source_channels)));
    }
    decoder.set_packet_time_base(input_stream.time_base());

    let target_channels: u16 = if source_channels <= 1 { 1 } else { 2 };
    let target_channel_layout = ChannelLayout::default(i32::from(target_channels));
    let mut options = ffmpeg::Dictionary::new();
    options.set("filter_size", "128");
    options.set("cutoff", "0.97");

    let mut resampler = resampling::Context::get_with(
        decoder.format(),
        decoder.channel_layout(),
        decoder.rate(),
        avformat::Sample::F32(avformat::sample::Type::Packed),
        target_channel_layout,
        DECODE_SAMPLE_RATE,
        options,
    )
    .map_err(|e| format!("Resampler / {e}"))?;

    let index = input_stream.index();

    let mut decoded_frame = ffmpeg::frame::Audio::empty();
    let mut samples: Vec<f32> = Vec::new();

    for (stream, packet) in input_ctx.packets() {
        if stream.index() != index {
            continue;
        }

        decoder
            .send_packet(&packet)
            .map_err(|e| format!("Send Packet / {e}"))?;

        while decoder.receive_frame(&mut decoded_frame).is_ok() {
            run_decode_resampler(&mut resampler, &decoded_frame, &mut samples)?;
        }
    }

    decoder.send_eof().map_err(|e| format!("Send EOF / {e}"))?;

    while decoder.receive_frame(&mut decoded_frame).is_ok() {
        run_decode_resampler(&mut resampler, &decoded_frame, &mut samples)?;
    }

    flush_decode_resampler(&mut resampler, &mut samples)?;

    Ok((samples, usize::from(target_channels)))
}

fn run_decode_resampler(
    resampler: &mut resampling::Context,
    decoded_frame: &ffmpeg::frame::Audio,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    let target = *resampler.output();
    let capacity = decode_resample_capacity(resampler, decoded_frame.samples());
    let mut resampled_frame =
        ffmpeg::frame::Audio::new(target.format, capacity, target.channel_layout);

    resampler
        .run(decoded_frame, &mut resampled_frame)
        .map_err(|e| format!("Run Resampler / {e}"))?;

    append_resampled_frame(samples, &resampled_frame)
}

fn flush_decode_resampler(
    resampler: &mut resampling::Context,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    for _ in 0..64 {
        let Some(delay) = resampler.delay() else {
            break;
        };
        let target = *resampler.output();
        let capacity = delay
            .output
            .max(1)
            .saturating_add(16)
            .min(i64::from(i32::MAX)) as usize;
        let mut resampled_frame =
            ffmpeg::frame::Audio::new(target.format, capacity, target.channel_layout);
        let remaining = resampler
            .flush(&mut resampled_frame)
            .map_err(|e| format!("Flush Resampler / {e}"))?;

        let output_samples = resampled_frame.samples();
        append_resampled_frame(samples, &resampled_frame)?;

        if remaining.is_none() || output_samples == 0 {
            break;
        }
    }
    Ok(())
}

fn decode_resample_capacity(resampler: &resampling::Context, input_samples: usize) -> usize {
    let src_rate = u64::from(resampler.input().rate.max(1));
    let dst_rate = u64::from(resampler.output().rate.max(1));
    let pending_output_samples = resampler
        .delay()
        .map(|d| d.output.max(0) as u64)
        .unwrap_or(0);
    let resampled_from_input = (input_samples as u64)
        .saturating_mul(dst_rate)
        .div_ceil(src_rate);

    pending_output_samples
        .saturating_add(resampled_from_input)
        .saturating_add(16)
        .min(i32::MAX as u64) as usize
}

fn append_resampled_frame(
    samples: &mut Vec<f32>,
    frame: &ffmpeg::frame::Audio,
) -> Result<(), String> {
    if frame.samples() == 0 {
        return Ok(());
    }

    let byte_len = frame
        .samples()
        .saturating_mul(frame.channels() as usize)
        .saturating_mul(std::mem::size_of::<f32>());
    let data = frame
        .data(0)
        .get(..byte_len)
        .ok_or_else(|| "Resampled frame data shorter than expected".to_string())?;

    // SAFETY: ffmpeg's frame buffers are allocated with av_malloc alignment,
    // and the slice length is a whole number of f32s by construction.
    samples
        .extend(unsafe { std::slice::from_raw_parts(data.as_ptr() as *const f32, byte_len / 4) });
    Ok(())
}

/// `convert_to_mono` (`captions.rs:2701-2718`).
fn convert_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// `mix_samples` (`captions.rs:2720-2726`): average, over the shorter length.
fn mix_samples(dest: &mut [f32], source: &[f32]) {
    for (dest_sample, source_sample) in dest.iter_mut().zip(source) {
        *dest_sample = (*dest_sample + *source_sample) * 0.5;
    }
}

/// `normalize_audio_for_transcription` (`captions.rs:885-915`).
fn normalize_audio_for_transcription(samples: &mut [f32]) -> f32 {
    if samples.is_empty() {
        return 1.0;
    }

    let peak = samples
        .iter()
        .fold(0.0_f32, |max, sample| max.max(sample.abs()));
    if peak <= f32::EPSILON {
        return 1.0;
    }

    let rms =
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt();
    if rms <= f32::EPSILON {
        return 1.0;
    }

    let target_rms = 0.08_f32;
    let desired_gain = (target_rms / rms).clamp(1.0, 8.0);
    let peak_limited_gain = 0.98 / peak;
    let gain = desired_gain.min(peak_limited_gain);

    if (gain - 1.0).abs() > 0.01 {
        for sample in samples {
            *sample = (*sample * gain).clamp(-0.98, 0.98);
        }
    }

    gain
}

fn push_audio_source(sources: &mut Vec<PathBuf>, path: PathBuf) {
    if path.exists() && !sources.contains(&path) {
        sources.push(path);
    }
}

/// The recording-directory arm of `extract_audio_from_video`
/// (`captions.rs:250-517`): per segment, decode system audio then mic
/// (`captions.rs:281-283`), downmix each to mono, average them together,
/// concatenate the segments, normalize, and write a 16kHz mono s16le WAV.
fn extract_project_audio(project_path: &Path, output_path: &Path) -> Result<(), String> {
    ffmpeg::init().map_err(|e| format!("Failed to initialise ffmpeg: {e}"))?;

    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|e| format!("Failed to read recording metadata: {e}"))?;
    let Some(studio) = meta.studio_meta() else {
        return Err("Only studio recordings can be transcribed".to_string());
    };

    let mut segment_sources: Vec<Vec<PathBuf>> = Vec::new();
    match studio {
        StudioRecordingMeta::SingleSegment { segment } => {
            let mut sources = Vec::new();
            if let Some(audio) = &segment.audio {
                push_audio_source(&mut sources, meta.path(&audio.path));
            }
            if !sources.is_empty() {
                segment_sources.push(sources);
            }
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            for segment in &inner.segments {
                let mut sources = Vec::new();
                if let Some(system_audio) = &segment.system_audio {
                    push_audio_source(&mut sources, meta.path(&system_audio.path));
                }
                if let Some(mic) = &segment.mic {
                    push_audio_source(&mut sources, meta.path(&mic.path));
                }
                if !sources.is_empty() {
                    segment_sources.push(sources);
                }
            }
        }
    }

    if segment_sources.is_empty() {
        return Err("No audio sources found in the recording metadata".to_string());
    }

    let mut final_samples: Vec<f32> = Vec::new();

    for sources in &segment_sources {
        let mut segment_samples: Vec<f32> = Vec::new();

        for source in sources {
            match decode_audio_file(source) {
                Ok((samples, channels)) => {
                    let mono_samples = convert_to_mono(&samples, channels);
                    if segment_samples.is_empty() {
                        segment_samples = mono_samples;
                    } else {
                        mix_samples(&mut segment_samples, &mono_samples);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        path = %source.display(),
                        "Failed to process audio source: {error}"
                    );
                }
            }
        }

        final_samples.extend(segment_samples);
    }

    if final_samples.is_empty() {
        return Err("Failed to process any audio sources".to_string());
    }

    let gain = normalize_audio_for_transcription(&mut final_samples);
    if (gain - 1.0).abs() > 0.01 {
        tracing::info!("Applied transcription audio gain: {gain:.2}x");
    }

    write_wav_16k_mono(&final_samples, output_path)
}

/// The WAV encode half of the recording-directory arm
/// (`captions.rs:372-515`): 48kHz f32 mono in, 16kHz s16le mono WAV out.
fn write_wav_16k_mono(mixed_samples: &[f32], output_path: &Path) -> Result<(), String> {
    let mut output =
        avformat::output(&output_path).map_err(|e| format!("Failed to create output file: {e}"))?;

    let codec = avcodec::encoder::find_by_name("pcm_s16le")
        .ok_or_else(|| "PCM encoder not found".to_string())?;

    let mut encoder = avcodec::Context::new()
        .encoder()
        .audio()
        .map_err(|e| format!("Failed to create encoder: {e}"))?;

    encoder.set_rate(WHISPER_SAMPLE_RATE as i32);
    let channel_layout = ChannelLayout::MONO;
    encoder.set_channel_layout(channel_layout);
    encoder.set_format(avformat::Sample::I16(avformat::sample::Type::Packed));

    let mut encoder = encoder
        .open_as(codec)
        .map_err(|e| format!("Failed to open encoder: {e}"))?;

    let mut stream = output
        .add_stream(codec)
        .map_err(|e| format!("Failed to add stream: {e}"))?;
    stream.set_parameters(&encoder);

    output
        .write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    let mut resampler = resampling::Context::get(
        avformat::Sample::F32(avformat::sample::Type::Packed),
        channel_layout,
        DECODE_SAMPLE_RATE,
        avformat::Sample::I16(avformat::sample::Type::Packed),
        channel_layout,
        WHISPER_SAMPLE_RATE,
    )
    .map_err(|e| format!("Failed to create resampler: {e}"))?;

    let frame_size = encoder.frame_size() as usize;
    let frame_size = if frame_size == 0 { 1024 } else { frame_size };

    for chunk in mixed_samples.chunks(frame_size) {
        let mut input_frame = ffmpeg::frame::Audio::new(
            avformat::Sample::F32(avformat::sample::Type::Packed),
            chunk.len(),
            channel_layout,
        );
        input_frame.set_rate(DECODE_SAMPLE_RATE);

        // SAFETY: reinterpreting the f32 chunk as its little-endian bytes for
        // the frame copy, exactly as the Tauri encoder does.
        let bytes = unsafe {
            std::slice::from_raw_parts(chunk.as_ptr() as *const u8, std::mem::size_of_val(chunk))
        };
        input_frame.data_mut(0)[0..bytes.len()].copy_from_slice(bytes);

        let mut output_frame = ffmpeg::frame::Audio::new(
            avformat::Sample::I16(avformat::sample::Type::Packed),
            frame_size,
            ChannelLayout::MONO,
        );
        output_frame.set_rate(WHISPER_SAMPLE_RATE);

        if let Err(error) = resampler.run(&input_frame, &mut output_frame) {
            tracing::error!("Failed to resample chunk: {error}");
            continue;
        }

        if let Err(error) = encoder.send_frame(&output_frame) {
            tracing::error!("Failed to send frame to encoder: {error}");
            continue;
        }

        loop {
            let mut packet = ffmpeg::Packet::empty();
            if encoder.receive_packet(&mut packet).is_err() {
                break;
            }
            if let Err(error) = packet.write_interleaved(&mut output) {
                tracing::error!("Failed to write packet: {error}");
            }
        }
    }

    encoder
        .send_eof()
        .map_err(|e| format!("Failed to send EOF: {e}"))?;

    loop {
        let mut packet = ffmpeg::Packet::empty();
        if encoder.receive_packet(&mut packet).is_err() {
            break;
        }
        packet
            .write_interleaved(&mut output)
            .map_err(|e| format!("Failed to write final packet: {e}"))?;
    }

    output
        .write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

/// `build_initial_prompt` (`captions.rs:1181-1200`).
fn build_initial_prompt(transcription_hints: &[String]) -> Option<String> {
    let mut normalized = Vec::new();

    for hint in transcription_hints {
        let value = hint.replace('\0', "").trim().to_string();
        if value.is_empty() || normalized.contains(&value) {
            continue;
        }
        normalized.push(value);
    }

    if normalized.is_empty() {
        None
    } else {
        Some(format!(
            "Preferred spellings, names, and capitalization for this transcript: {}",
            normalized.join("; ")
        ))
    }
}

/// `general_settings.transcriptionHints`, with the Rust store's own default
/// list when the key is absent (`general_settings.rs:286-293`).
fn transcription_hints() -> Vec<String> {
    let section = store::store_section(store::GENERAL_SETTINGS);
    match section.get("transcriptionHints").and_then(|v| v.as_array()) {
        Some(values) => values
            .iter()
            .filter_map(|value| value.as_str())
            .map(str::to_string)
            .collect(),
        None => vec![
            "Cap".to_string(),
            "TypeScript".to_string(),
            "My Brand Name".to_string(),
            "mywebsite.com".to_string(),
        ],
    }
}

/// `is_special_token` (`captions.rs:718-735`).
fn is_special_token(token_text: &str) -> bool {
    let trimmed = token_text.trim();
    if trimmed.is_empty() {
        return true;
    }
    trimmed.contains('[')
        || trimmed.contains(']')
        || trimmed.contains("_TT_")
        || trimmed.contains("_BEG_")
        || trimmed.contains("<|")
}

/// `process_with_whisper` (`captions.rs:917-1179`).
fn process_with_whisper(
    audio_path: &Path,
    context: Arc<WhisperContext>,
    language: &str,
    transcription_hints: &[String],
) -> Result<Vec<CaptionSegment>, String> {
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: 1.0,
    });

    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true);
    params.set_language(Some(if language == "auto" { "auto" } else { language }));
    params.set_max_len(i32::MAX);

    if let Some(initial_prompt) = build_initial_prompt(transcription_hints) {
        params.set_initial_prompt(&initial_prompt);
    }

    let mut audio_data = Vec::new();
    File::open(audio_path)
        .map_err(|e| format!("Failed to open audio file: {e} at path: {audio_path:?}"))?
        .read_to_end(&mut audio_data)
        .map_err(|e| format!("Failed to read audio file: {e}"))?;

    let mut audio_data_f32: Vec<f32> = audio_data
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
        .collect();

    let gain = normalize_audio_for_transcription(&mut audio_data_f32);
    if (gain - 1.0).abs() > 0.01 {
        tracing::info!("Applied Whisper input gain: {gain:.2}x");
    }

    tracing::info!(
        "Whisper input: {} samples ({:.2}s at {}Hz), language: {language}",
        audio_data_f32.len(),
        audio_data_f32.len() as f32 / WHISPER_SAMPLE_RATE as f32,
        WHISPER_SAMPLE_RATE
    );

    let mut state = context
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    state
        .full(params, &audio_data_f32[..])
        .map_err(|e| format!("Failed to run Whisper transcription: {e}"))?;

    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Failed to get number of segments: {e}"))?;

    let mut segments = Vec::new();

    for i in 0..num_segments {
        let start_i64 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("Failed to get segment start time: {e}"))?;
        let end_i64 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("Failed to get segment end time: {e}"))?;

        let start_time = (start_i64 as f32) / 100.0;
        let end_time = (end_i64 as f32) / 100.0;

        let mut words = Vec::new();
        let num_tokens = state
            .full_n_tokens(i)
            .map_err(|e| format!("Failed to get token count: {e}"))?;

        let mut current_word = String::new();
        let mut word_start: Option<f32> = None;
        let mut word_end: f32 = start_time;

        for t in 0..num_tokens {
            let token_text = state.full_get_token_text(i, t).unwrap_or_default();

            if is_special_token(&token_text) {
                continue;
            }

            let Some(data) = state.full_get_token_data(i, t).ok() else {
                continue;
            };

            let token_start = (data.t0 as f32) / 100.0;
            let token_end = (data.t1 as f32) / 100.0;

            if token_text.starts_with(' ') || token_text.starts_with('\n') {
                if !current_word.is_empty()
                    && let Some(ws) = word_start
                {
                    words.push(CaptionWord {
                        text: current_word.trim().to_string(),
                        start: ws,
                        end: word_end,
                    });
                }
                current_word = token_text.trim().to_string();
                word_start = Some(token_start);
            } else {
                if word_start.is_none() {
                    word_start = Some(token_start);
                }
                current_word.push_str(&token_text);
            }
            word_end = token_end;
        }

        if !current_word.trim().is_empty()
            && let Some(ws) = word_start
        {
            words.push(CaptionWord {
                text: current_word.trim().to_string(),
                start: ws,
                end: word_end,
            });
        }

        let words = normalize_caption_words(words);
        if words.is_empty() {
            continue;
        }

        for (chunk_idx, chunk_words) in caption_word_chunks(&words).into_iter().enumerate() {
            let segment_text = caption_text_from_words(chunk_words);
            let segment_start = chunk_words
                .first()
                .map(|word| word.start)
                .unwrap_or(start_time);
            let segment_end = chunk_words.last().map(|word| word.end).unwrap_or(end_time);

            segments.push(CaptionSegment {
                id: format!("segment-{i}-{chunk_idx}"),
                start: segment_start,
                end: segment_end,
                text: segment_text,
                words: chunk_words.to_vec(),
            });
        }
    }

    tracing::info!(
        "Whisper produced {} caption segments ({} words)",
        segments.len(),
        segments.iter().map(|s| s.words.len()).sum::<usize>()
    );

    Ok(segments)
}

// ---------------------------------------------------------------------------
// Parakeet
// ---------------------------------------------------------------------------

/// `process_with_parakeet` (`captions.rs:1202-1302`).
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn process_with_parakeet(
    audio_path: &Path,
    model_dir: &str,
) -> Result<Vec<CaptionSegment>, String> {
    let cached_model = {
        let guard = PARAKEET_CONTEXT
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        guard.as_ref().and_then(|cached| {
            if cached.model_dir == model_dir {
                Some(Arc::clone(&cached.model))
            } else {
                None
            }
        })
    };

    let model_arc = if let Some(model) = cached_model {
        tracing::info!("Reusing cached Parakeet TDT model");
        model
    } else {
        tracing::info!("Loading Parakeet TDT model from: {model_dir}");
        cap_camera_effects::initialize_onnx_runtime().map_err(|error| format!("{error:#}"))?;
        let model = ParakeetTDT::from_pretrained(model_dir, None).map_err(|e| format!("{e}"))?;
        let loaded_model = Arc::new(Mutex::new(model));

        let mut guard = PARAKEET_CONTEXT
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = guard
            .as_ref()
            .filter(|cached| cached.model_dir == model_dir)
        {
            Arc::clone(&cached.model)
        } else {
            *guard = Some(CachedParakeetContext {
                model_dir: model_dir.to_string(),
                model: Arc::clone(&loaded_model),
            });
            loaded_model
        }
    };

    let result = {
        let mut parakeet = model_arc
            .lock()
            .map_err(|e| format!("Failed to lock Parakeet model: {e}"))?;
        parakeet
            .transcribe_file(audio_path, Some(TimestampMode::Words))
            .map_err(|e| format!("Parakeet transcription failed: {e}"))?
    };

    tracing::info!("Parakeet produced {} timed tokens", result.tokens.len());

    let words = normalize_caption_words(
        result
            .tokens
            .iter()
            .filter(|token| !token.text.trim().is_empty())
            .map(|token| CaptionWord {
                text: token.text.trim().to_string(),
                start: token.start,
                end: token.end,
            })
            .collect(),
    );

    if words.is_empty() {
        return Err("No speech detected in the audio".to_string());
    }

    let mut segments = Vec::new();
    for (chunk_idx, chunk) in caption_word_chunks(&words).into_iter().enumerate() {
        segments.push(CaptionSegment {
            id: format!("segment-{chunk_idx}"),
            start: chunk.first().map_or(0.0, |word| word.start),
            end: chunk.last().map_or(0.0, |word| word.end),
            text: caption_text_from_words(chunk),
            words: chunk.to_vec(),
        });
    }

    Ok(segments)
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn process_with_parakeet(
    _audio_path: &Path,
    _model_dir: &str,
) -> Result<Vec<CaptionSegment>, String> {
    Err(PARAKEET_UNSUPPORTED_MESSAGE.to_string())
}

// ---------------------------------------------------------------------------
// Transcribe entry point
// ---------------------------------------------------------------------------

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `transcribe_audio` (`captions.rs:1315-1439`), minus the Tauri command
/// plumbing. Blocking -- run it on the tokio blocking pool.
pub fn transcribe_blocking(
    project_path: &Path,
    model: &str,
    language: &str,
) -> Result<Vec<CaptionSegment>, String> {
    let model_file = model_path(model);
    if !project_path.exists() {
        return Err(format!(
            "Video file not found at path: {}",
            project_path.display()
        ));
    }
    if !model_files_present(model) {
        return Err(format!(
            "Model file not found at path: {}",
            model_file.display()
        ));
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "cap-gpui-transcription-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temporary directory: {e}"))?;
    let audio_path = temp_dir.join("audio.wav");

    let result = (|| {
        extract_audio_from_video(project_path, &audio_path)?;

        let _guard = lock_transcription_worker_slot();
        if is_parakeet_model(model) {
            tracing::info!("Using Parakeet TDT engine");
            process_with_parakeet(&audio_path, model_file.to_string_lossy().as_ref())
        } else {
            tracing::info!("Using Whisper engine");
            let hints = transcription_hints();
            let context = get_whisper_context(model_file.to_string_lossy().as_ref())?;
            let result = process_with_whisper(&audio_path, context, language, &hints);
            release_whisper_context_after_transcription();
            result
        }
    })();

    let _ = std::fs::remove_dir_all(&temp_dir);

    let segments = result?;
    if segments.is_empty() {
        return Err("No speech detected in the audio".to_string());
    }
    Ok(segments)
}

/// `resolve_audio_extraction_source` (`captions.rs:221-243`), directory arm
/// only -- the gpui editor always opens `.cap` bundles, so a plain media file
/// is refused rather than decoded.
fn extract_audio_from_video(video_path: &Path, output_path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(video_path)
        .map_err(|e| format!("Failed to read video path metadata: {e}"))?;
    if !metadata.is_dir() {
        return Err("Video path is not a recording directory".to_string());
    }
    if !video_path.join("recording-meta.json").is_file() {
        return Err("Recording directory is missing recording-meta.json".to_string());
    }
    extract_project_audio(video_path, output_path)
}

// ---------------------------------------------------------------------------
// Caption words & chunking
// ---------------------------------------------------------------------------

/// `MAX_CAPTION_WORD_DURATION` (`captions.rs:75`): Whisper/Parakeet sometimes
/// stretch a trailing word's end across a following silence, which leaves the
/// rendered caption stuck on screen and duplicates the word across timeline
/// cuts once projected.
pub const MAX_CAPTION_WORD_DURATION: f32 = 2.5;
/// `captions.rs:67-69`.
const TARGET_CAPTION_WORDS_PER_SEGMENT: usize = 6;
const MAX_CAPTION_WORDS_PER_SEGMENT: usize = 8;
const MIN_FINAL_CAPTION_WORDS: usize = 3;

/// `caption_char_attaches_to_previous` (`captions.rs:745-767`).
fn caption_char_attaches_to_previous(value: char) -> bool {
    matches!(
        value,
        ',' | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '%'
            | ')'
            | ']'
            | '}'
            | '\''
            | '’'
            | '、'
            | '。'
            | '！'
            | '？'
            | '；'
            | '：'
            | '，'
    )
}

fn caption_token_attaches_to_previous(text: &str) -> bool {
    text.trim()
        .chars()
        .next()
        .is_some_and(caption_char_attaches_to_previous)
}

/// `caption_boundary_word_is_weak` (`captions.rs:769-801`).
fn caption_boundary_word_is_weak(word: &CaptionWord) -> bool {
    let normalized = word
        .text
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();

    normalized.len() <= 1
        || matches!(
            normalized.as_str(),
            "an" | "as"
                | "at"
                | "be"
                | "by"
                | "do"
                | "he"
                | "if"
                | "in"
                | "is"
                | "it"
                | "me"
                | "my"
                | "of"
                | "on"
                | "or"
                | "so"
                | "to"
                | "up"
                | "we"
        )
}

/// `normalize_caption_words` (`captions.rs:803-831`).
fn normalize_caption_words(words: Vec<CaptionWord>) -> Vec<CaptionWord> {
    let mut normalized: Vec<CaptionWord> = Vec::with_capacity(words.len());

    for word in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }

        if caption_token_attaches_to_previous(text)
            && let Some(previous) = normalized.last_mut()
        {
            previous.text.push_str(text);
            previous.end = word.end;
        } else {
            normalized.push(CaptionWord {
                text: text.to_string(),
                start: word.start,
                end: word.end,
            });
        }
    }

    for word in &mut normalized {
        word.end = word.end.min(word.start + MAX_CAPTION_WORD_DURATION);
    }

    normalized
}

/// `caption_text_from_words` (`captions.rs:833-849`).
fn caption_text_from_words<'a>(words: impl IntoIterator<Item = &'a CaptionWord>) -> String {
    let mut text = String::new();

    for word in words {
        let word_text = word.text.trim();
        if word_text.is_empty() {
            continue;
        }

        if !text.is_empty() && !caption_token_attaches_to_previous(word_text) {
            text.push(' ');
        }
        text.push_str(word_text);
    }

    text
}

/// `caption_word_chunks` (`captions.rs:851-883`).
fn caption_word_chunks(words: &[CaptionWord]) -> Vec<&[CaptionWord]> {
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < words.len() {
        let remaining = words.len() - start;
        if remaining <= TARGET_CAPTION_WORDS_PER_SEGMENT {
            chunks.push(&words[start..]);
            break;
        }

        let mut end = (start + TARGET_CAPTION_WORDS_PER_SEGMENT).min(words.len());
        while end < words.len()
            && caption_boundary_word_is_weak(&words[end - 1])
            && end - start < MAX_CAPTION_WORDS_PER_SEGMENT
        {
            end += 1;
        }

        let remaining_after = words.len() - end;
        if remaining_after > 0
            && remaining_after < MIN_FINAL_CAPTION_WORDS
            && caption_boundary_word_is_weak(&words[end])
        {
            end = words.len();
        }

        chunks.push(&words[start..end]);
        start = end;
    }

    chunks
}

// ---------------------------------------------------------------------------
// Track derivation -- deriveCaptionTrackSegments, in Rust
// ---------------------------------------------------------------------------

/// `CAPTION_EDL_SEPARATOR` (`captions.ts:151`).
const CAPTION_EDL_SEPARATOR: &str = "::edl";

/// `sourceCaptionId` (`captions.ts:166-169`).
pub fn source_caption_id(track_id: &str) -> &str {
    track_id
        .find(CAPTION_EDL_SEPARATOR)
        .map_or(track_id, |index| &track_id[..index])
}

fn mapped_caption_segment_id(base_id: &str, index: usize, total: usize) -> String {
    if total == 1 {
        base_id.to_string()
    } else {
        format!("{base_id}{CAPTION_EDL_SEPARATOR}{index}")
    }
}

/// `clampCaptionSegmentWords` (`captions.ts:36-52`).
fn clamp_caption_segment_words(segment: &CaptionSegment) -> CaptionSegment {
    if segment.words.is_empty() {
        return segment.clone();
    }

    let clamped_words: Vec<CaptionWord> = segment
        .words
        .iter()
        .map(|word| CaptionWord {
            text: word.text.clone(),
            start: word.start,
            end: word.end.min(word.start + MAX_CAPTION_WORD_DURATION),
        })
        .collect();

    let last_word_end = clamped_words.last().map_or(segment.end, |word| word.end);

    CaptionSegment {
        id: segment.id.clone(),
        start: segment.start,
        end: segment.end.min(last_word_end),
        text: segment.text.clone(),
        words: clamped_words,
    }
}

struct SourceToEditedMapping {
    source_start: f64,
    source_end: f64,
    edited_start: f64,
    timescale: f64,
}

/// `buildSourceToEditedMappings` (`captions.ts:98-128`), with the recording
/// offsets built from `editorInstance.recordings.segments[].display.duration`
/// -- here the pre-flight's `clip_display_durations`.
fn build_source_to_edited_mappings(
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<SourceToEditedMapping> {
    let mut recording_offsets = Vec::with_capacity(recording_durations.len());
    let mut cumulative = 0.0;
    for duration in recording_durations {
        recording_offsets.push(cumulative);
        cumulative += duration;
    }

    let edited_offsets = clip_timeline_offsets(timeline);

    timeline
        .segments
        .iter()
        .zip(edited_offsets)
        .map(|(segment, edited_start)| {
            let recording_offset = recording_offsets
                .get(segment.recording_clip as usize)
                .copied()
                .unwrap_or(0.0);
            SourceToEditedMapping {
                source_start: recording_offset + segment.start,
                source_end: recording_offset + segment.end,
                edited_start,
                timescale: segment.timescale,
            }
        })
        .collect()
}

/// `mapTimeRangeWithinMapping` (`captions.ts:130-149`).
fn map_time_range_within_mapping(
    start: f64,
    end: f64,
    mapping: &SourceToEditedMapping,
) -> Option<(f64, f64)> {
    let overlap_start = start.max(mapping.source_start);
    let overlap_end = end.min(mapping.source_end);
    if overlap_start >= overlap_end {
        return None;
    }
    Some((
        mapping.edited_start + (overlap_start - mapping.source_start) / mapping.timescale,
        mapping.edited_start + (overlap_end - mapping.source_start) / mapping.timescale,
    ))
}

/// `effectiveToOutput` (`timeline-holds.ts:54-64`).
fn effective_to_output(holds: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in holds {
        if output >= *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
}

/// `effectiveToOutputEnd` (`timeline-holds.ts:70-80`): an end landing exactly
/// on a hold boundary binds to the content before the pause.
fn effective_to_output_end(holds: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in holds {
        if output > *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
}

struct MappedCaption {
    id: String,
    start: f64,
    end: f64,
    text: String,
    words: Vec<CaptionWord>,
}

/// `mapCaptionsToEditedTimeline` (`captions.ts:171-273`).
fn map_captions_to_edited_timeline(
    raw_segments: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<MappedCaption> {
    let sanitized: Vec<CaptionSegment> = raw_segments
        .iter()
        .map(clamp_caption_segment_words)
        .collect();

    if timeline.segments.is_empty() || recording_durations.is_empty() {
        return sanitized
            .into_iter()
            .map(|segment| MappedCaption {
                id: segment.id,
                start: f64::from(segment.start),
                end: f64::from(segment.end),
                text: segment.text,
                words: segment.words,
            })
            .collect();
    }

    let mappings = build_source_to_edited_mappings(timeline, recording_durations);
    let holds = timeline.hold_windows();
    let hold_adjusted = |start: f64, end: f64| {
        if holds.is_empty() {
            (start, end)
        } else {
            (
                effective_to_output(&holds, start),
                effective_to_output_end(&holds, end),
            )
        }
    };

    let mut result = Vec::new();

    for caption in &sanitized {
        let mut mapped_caption_segments: Vec<MappedCaption> = Vec::new();

        for mapping in &mappings {
            if !caption.words.is_empty() {
                let mut mapped_words = Vec::new();
                for word in &caption.words {
                    let Some((start, end)) = map_time_range_within_mapping(
                        f64::from(word.start),
                        f64::from(word.end),
                        mapping,
                    ) else {
                        continue;
                    };
                    let (start, end) = hold_adjusted(start, end);
                    mapped_words.push(CaptionWord {
                        text: word.text.clone(),
                        start: start as f32,
                        end: end as f32,
                    });
                }

                if mapped_words.is_empty() {
                    continue;
                }

                let start = mapped_words
                    .first()
                    .map_or(f64::from(caption.start), |word| f64::from(word.start));
                let end = mapped_words
                    .last()
                    .map_or(f64::from(caption.end), |word| f64::from(word.end));
                mapped_caption_segments.push(MappedCaption {
                    id: caption.id.clone(),
                    start,
                    end,
                    text: caption_text_from_words(&mapped_words),
                    words: mapped_words,
                });
            } else {
                let Some((start, end)) = map_time_range_within_mapping(
                    f64::from(caption.start),
                    f64::from(caption.end),
                    mapping,
                ) else {
                    continue;
                };
                let (start, end) = hold_adjusted(start, end);
                mapped_caption_segments.push(MappedCaption {
                    id: caption.id.clone(),
                    start,
                    end,
                    text: caption.text.clone(),
                    words: Vec::new(),
                });
            }
        }

        let total = mapped_caption_segments.len();
        for (index, mut segment) in mapped_caption_segments.into_iter().enumerate() {
            segment.id = mapped_caption_segment_id(&caption.id, index, total);
            result.push(segment);
        }
    }

    result
}

/// `deriveCaptionTrackSegments` (`captions.ts:323-366`): project the
/// source-time caption master through the current edit list, carrying per
/// source-caption style overrides across by source id. The previous track is
/// read from `timeline.caption_segments` itself.
pub fn derive_caption_track_segments(
    source_segments: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<CaptionTrackSegment> {
    struct TrackOverrides {
        fade_duration: Option<f32>,
        linger_duration: Option<f32>,
        position: Option<String>,
        color: Option<String>,
        background_color: Option<String>,
        font_size: Option<u32>,
    }

    let mut overrides_by_source_id: HashMap<String, TrackOverrides> = HashMap::new();
    for segment in &timeline.caption_segments {
        overrides_by_source_id
            .entry(source_caption_id(&segment.id).to_string())
            .or_insert_with(|| TrackOverrides {
                fade_duration: segment.fade_duration_override,
                linger_duration: segment.linger_duration_override,
                position: segment.position_override.clone(),
                color: segment.color_override.clone(),
                background_color: segment.background_color_override.clone(),
                font_size: segment.font_size_override,
            });
    }

    let mut mapped =
        map_captions_to_edited_timeline(source_segments, timeline, recording_durations);
    mapped.sort_by(|a, b| a.start.total_cmp(&b.start));

    mapped
        .into_iter()
        .map(|segment| {
            let overrides = overrides_by_source_id.get(source_caption_id(&segment.id));
            CaptionTrackSegment {
                id: segment.id.clone(),
                start: segment.start,
                end: segment.end,
                text: segment.text,
                words: segment.words,
                fade_duration_override: overrides.and_then(|o| o.fade_duration),
                linger_duration_override: overrides.and_then(|o| o.linger_duration),
                position_override: overrides.and_then(|o| o.position.clone()),
                color_override: overrides.and_then(|o| o.color.clone()),
                background_color_override: overrides.and_then(|o| o.background_color.clone()),
                font_size_override: overrides.and_then(|o| o.font_size),
            }
        })
        .collect()
}

/// `heldTimeBefore` (`timeline-holds.ts:45-50`): how much hold-extended
/// output time has passed before `time`.
fn held_time_before(holds: &[(f64, f64)], time: f64) -> f64 {
    holds
        .iter()
        .map(|(start, end)| (time.min(*end) - start).max(0.))
        .sum()
}

/// `mapEditedTimeToSource` (`captions.ts:428-467`) in its `"outgoing"`
/// preference -- the mode the caption override panel uses. The `"incoming"`
/// arm serves only the legacy non-source-timed inversion, which this build
/// never produces.
pub fn map_edited_time_to_source(
    edited_time: f64,
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
    source_range: Option<(f64, f64)>,
) -> Option<f64> {
    let edited_time = edited_time - held_time_before(&timeline.hold_windows(), edited_time);
    let mut fallback = None;
    for mapping in build_source_to_edited_mappings(timeline, recording_durations) {
        let edited_end =
            mapping.edited_start + (mapping.source_end - mapping.source_start) / mapping.timescale;
        if edited_time >= mapping.edited_start && edited_time <= edited_end {
            let source_time =
                mapping.source_start + (edited_time - mapping.edited_start) * mapping.timescale;
            if let Some((range_start, range_end)) = source_range
                && range_start < mapping.source_end
                && range_end > mapping.source_start
            {
                return Some(source_time);
            }
            if fallback.is_none() {
                fallback = Some(source_time);
            }
        }
    }
    fallback
}

/// `syncCaptionWordsWithText` (`captions.ts:593-632`): keep word timings when
/// only spellings changed, otherwise spread the tokens evenly.
pub fn sync_caption_words_with_text(
    text: &str,
    existing: &[CaptionWord],
    start: f64,
    end: f64,
) -> Vec<CaptionWord> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    if existing.len() == tokens.len() {
        return existing
            .iter()
            .zip(&tokens)
            .map(|(word, token)| CaptionWord {
                text: (*token).to_string(),
                start: word.start,
                end: word.end,
            })
            .collect();
    }
    let duration = (end - start).max(0.);
    let step = duration / tokens.len() as f64;
    tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            let source = existing.get(index);
            let word_start = start + step * index as f64;
            let word_end = if index == tokens.len() - 1 {
                end
            } else {
                start + step * (index + 1) as f64
            };
            CaptionWord {
                text: (*token).to_string(),
                start: source.map_or(word_start as f32, |word| word.start),
                end: source.map_or(word_end as f32, |word| word.end),
            }
        })
        .collect()
}

/// `updateSelectedCaption`'s source write-through (`CaptionsTab.tsx:257-315`):
/// after a track segment's start/end/text was edited in output time, route
/// the timing and content back onto the source-time caption master so the
/// edit survives future clip changes. Style overrides stay on the track and
/// are carried across by source id when re-derived.
pub fn write_caption_edit_to_source(
    project: &mut ProjectConfiguration,
    index: usize,
    recording_durations: &[f64],
) {
    let Some(timeline) = project.timeline.as_ref() else {
        return;
    };
    let Some(track_segment) = timeline.caption_segments.get(index) else {
        return;
    };
    let source_id = source_caption_id(&track_segment.id).to_string();
    let (track_start, track_end, track_text) = (
        track_segment.start,
        track_segment.end,
        track_segment.text.clone(),
    );

    let Some(captions) = project.captions.as_mut() else {
        return;
    };
    let timeline = project
        .timeline
        .as_ref()
        .expect("timeline presence was just checked");
    let Some(source) = captions
        .segments
        .iter_mut()
        .find(|segment| segment.id == source_id)
    else {
        return;
    };

    let source_range = Some((f64::from(source.start), f64::from(source.end)));
    if let Some(start) =
        map_edited_time_to_source(track_start, timeline, recording_durations, source_range)
    {
        source.start = start as f32;
    }
    if let Some(end) =
        map_edited_time_to_source(track_end, timeline, recording_durations, source_range)
    {
        source.end = end as f32;
    }
    source.text = track_text;
    source.words = sync_caption_words_with_text(
        &source.text,
        &source.words,
        f64::from(source.start),
        f64::from(source.end),
    );
}

/// `applyCaptionResultToProject` (`captions.ts:469-527`): set the captions
/// block (enabled, preserving existing style settings), mark it source-timed,
/// and re-derive the rendered track through the current edit list.
pub fn apply_caption_result(
    project: &mut ProjectConfiguration,
    segments: Vec<CaptionSegment>,
    recording_durations: &[f64],
    recording_duration: f64,
) {
    let settings = CaptionSettings {
        enabled: true,
        ..project
            .captions
            .as_ref()
            .map(|captions| captions.settings.clone())
            .unwrap_or_default()
    };

    if project.timeline.is_none() {
        project.timeline = Some(TimelineConfiguration {
            segments: vec![TimelineSegment {
                recording_clip: 0,
                timescale: 1.0,
                start: 0.0,
                end: recording_duration,
                name: None,
                speed_audio_mode: None,
            }],
            transitions: Vec::new(),
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
            style_segments: Vec::new(),
            image_segments: Vec::new(),
        });
    }
    let timeline = project
        .timeline
        .as_mut()
        .expect("timeline was just created");

    timeline.caption_segments =
        derive_caption_track_segments(&segments, timeline, recording_durations);

    project.captions = Some(CaptionsData {
        segments,
        settings,
        source_timed: true,
    });
}

/// `getCaptionGenerationErrorMessage` (`captions.ts:634-662`).
pub fn caption_generation_error_message(message: &str) -> String {
    if message.contains("No audio stream found") {
        return "No audio found in the video file".to_string();
    }
    if message.contains("Model file not found") {
        return "Caption model not found. Please download it first".to_string();
    }
    if message.contains("Failed to load Whisper model") {
        return "Failed to load the caption model. Try downloading it again".to_string();
    }
    if message.contains("Parakeet transcription is not available on Intel macOS") {
        return "Parakeet models are not available on Intel Macs. Use a Whisper model instead"
            .to_string();
    }
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, index: usize) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start: index as f32,
            end: index as f32 + 0.5,
        }
    }

    fn timeline(json: serde_json::Value) -> TimelineConfiguration {
        serde_json::from_value(json).expect("fixture parses")
    }

    fn caption(id: &str, start: f32, end: f32, words: &[(&str, f32, f32)]) -> CaptionSegment {
        let words: Vec<CaptionWord> = words
            .iter()
            .map(|(text, start, end)| CaptionWord {
                text: (*text).to_string(),
                start: *start,
                end: *end,
            })
            .collect();
        CaptionSegment {
            id: id.to_string(),
            start,
            end,
            text: caption_text_from_words(&words),
            words,
        }
    }

    // -- captions.rs's own unit tests, carried over --------------------------

    #[test]
    fn normalize_caption_words_attaches_punctuation() {
        let words = normalize_caption_words(vec![
            word("test", 0),
            word(",", 1),
            word("test", 2),
            word(".", 3),
        ]);

        assert_eq!(caption_text_from_words(&words), "test, test.");
        assert_eq!(words.len(), 2);
    }

    #[test]
    fn normalize_caption_words_clamps_inflated_trailing_word() {
        let words = normalize_caption_words(vec![CaptionWord {
            text: "seconds.".to_string(),
            start: 53.92,
            end: 70.16,
        }]);

        assert_eq!(words.len(), 1);
        assert!((words[0].end - (53.92 + MAX_CAPTION_WORD_DURATION)).abs() < 1e-4);
    }

    #[test]
    fn caption_word_chunks_do_not_end_on_short_connector_when_more_words_follow() {
        let words = [
            "This", "is", "where", "we", "record", "I", "want", "clean", "captions",
        ]
        .iter()
        .enumerate()
        .map(|(index, text)| word(text, index))
        .collect::<Vec<_>>();

        let chunks = caption_word_chunks(&words);

        assert_eq!(
            caption_text_from_words(chunks[0]),
            "This is where we record I want"
        );
        assert_eq!(caption_text_from_words(chunks[1]), "clean captions");
    }

    // -- Model paths ----------------------------------------------------------

    #[test]
    fn model_paths_match_the_tauri_layout() {
        let base = models_dir();
        assert!(base.ends_with("so.cap.desktop/transcription_models"));
        assert_eq!(model_path("best"), base.join("parakeet-best"));
        assert_eq!(model_path("best-max"), base.join("parakeet-best-max"));
        assert_eq!(model_path("small"), base.join("small.bin"));
        assert_eq!(model_path("medium"), base.join("medium.bin"));
    }

    #[test]
    fn downloads_generation_and_deletion_block_application_handoffs() {
        let mut state = Hub::default();
        assert!(!state.work_in_flight());

        state.download = Some(ModelDownload {
            model: "small".to_string(),
            state: DownloadState::Downloading,
            progress: 25.0,
            message: "Downloading".to_string(),
        });
        assert!(state.work_in_flight());

        state.download.as_mut().unwrap().state = DownloadState::Completed;
        assert!(!state.work_in_flight());

        state.generating.insert(PathBuf::from("/tmp/recording.cap"));
        assert!(state.work_in_flight());
        state.generating.clear();

        state.deleting = Some("small".to_string());
        assert!(state.work_in_flight());
    }

    #[test]
    fn source_caption_id_strips_the_edl_suffix() {
        assert_eq!(source_caption_id("segment-0-1"), "segment-0-1");
        assert_eq!(source_caption_id("segment-0-1::edl3"), "segment-0-1");
    }

    // -- captions.ts's derivation vitest cases, carried over ------------------

    #[test]
    fn derive_splits_caption_words_across_retained_timeline_ranges() {
        let timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 1.0 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 2.0, "end": 3.0 }
            ],
            "zoomSegments": []
        }));
        let source = vec![caption(
            "caption",
            0.4,
            2.3,
            &[("hello", 0.4, 0.6), ("world", 2.1, 2.3)],
        )];

        let track = derive_caption_track_segments(&source, &timeline, &[4.0]);

        assert_eq!(track.len(), 2);
        assert_eq!(track[0].id, "caption::edl0");
        assert_eq!(track[0].text, "hello");
        assert!((track[0].start - 0.4).abs() < 1e-6);
        assert!((track[0].end - 0.6).abs() < 1e-6);
        assert_eq!(track[1].id, "caption::edl1");
        assert_eq!(track[1].text, "world");
        assert!((track[1].start - 1.1).abs() < 1e-6);
        assert!((track[1].end - 1.3).abs() < 1e-6);
    }

    #[test]
    fn derive_clamps_an_inflated_trailing_word_across_cuts() {
        let timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 1.5 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 10.0, "end": 12.0 }
            ],
            "zoomSegments": []
        }));
        let source = vec![caption(
            "caption",
            0.4,
            16.4,
            &[("a", 0.4, 0.5), ("few", 0.5, 0.8), ("seconds.", 0.8, 16.4)],
        )];

        let track = derive_caption_track_segments(&source, &timeline, &[20.0]);

        assert_eq!(track.len(), 1);
        assert_eq!(track[0].id, "caption");
        assert_eq!(track[0].text, "a few seconds.");
        assert_eq!(track[0].words[2].text, "seconds.");
        assert!((track[0].words[2].end - 1.5).abs() < 1e-4);
    }

    #[test]
    fn derive_projects_captions_into_hold_extended_output_time() {
        let timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 }
            ],
            "zoomSegments": [],
            "textSegments": [
                { "start": 2.0, "end": 5.0, "layout": "fullscreen" }
            ]
        }));

        let after = derive_caption_track_segments(
            &[caption("caption", 4.0, 5.0, &[("later", 4.0, 5.0)])],
            &timeline,
            &[10.0],
        );
        assert_eq!(after.len(), 1);
        assert!((after[0].start - 7.0).abs() < 1e-6);
        assert!((after[0].end - 8.0).abs() < 1e-6);

        let before = derive_caption_track_segments(
            &[caption("caption", 1.0, 2.0, &[("before", 1.0, 2.0)])],
            &timeline,
            &[10.0],
        );
        assert!((before[0].start - 1.0).abs() < 1e-6);
        assert!((before[0].end - 2.0).abs() < 1e-6);

        let across = derive_caption_track_segments(
            &[caption(
                "caption",
                1.0,
                3.0,
                &[("across", 1.0, 2.0), ("it", 2.0, 3.0)],
            )],
            &timeline,
            &[10.0],
        );
        assert_eq!(across.len(), 1);
        assert!((across[0].start - 1.0).abs() < 1e-6);
        assert!((across[0].end - 6.0).abs() < 1e-6);
        assert!((across[0].words[0].end - 2.0).abs() < 1e-4);
        assert!((across[0].words[1].start - 5.0).abs() < 1e-4);
    }

    #[test]
    fn derive_follows_clip_reordering_and_carries_overrides_by_source_id() {
        let mut timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 8.0 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 3.0 }
            ],
            "zoomSegments": []
        }));
        let source = vec![
            caption("capA", 1.0, 2.0, &[("a", 1.0, 2.0)]),
            caption("capB", 6.0, 7.0, &[("b", 6.0, 7.0)]),
        ];

        let track = derive_caption_track_segments(&source, &timeline, &[10.0]);
        assert_eq!(
            track.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["capB", "capA"]
        );
        assert!((track[0].start - 1.0).abs() < 1e-6);
        assert!((track[1].start - 4.0).abs() < 1e-6);

        timeline.caption_segments = track;
        timeline.caption_segments[1].font_size_override = Some(42);

        let rederived = derive_caption_track_segments(&source, &timeline, &[10.0]);
        assert_eq!(
            rederived
                .iter()
                .find(|s| s.id == "capA")
                .and_then(|s| s.font_size_override),
            Some(42)
        );
    }

    #[test]
    fn derive_drops_captions_whose_content_was_cut_out() {
        let timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 3.0 }
            ],
            "zoomSegments": []
        }));
        let source = vec![
            caption("capA", 1.0, 2.0, &[("a", 1.0, 2.0)]),
            caption("capB", 6.0, 7.0, &[("b", 6.0, 7.0)]),
        ];

        let track = derive_caption_track_segments(&source, &timeline, &[10.0]);
        assert_eq!(
            track.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["capA"]
        );
    }

    // -- applyCaptionResultToProject ------------------------------------------

    #[test]
    fn apply_caption_result_enables_captions_and_derives_the_track() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        project.captions = Some(CaptionsData {
            segments: Vec::new(),
            settings: CaptionSettings {
                enabled: false,
                size: 72,
                ..CaptionSettings::default()
            },
            source_timed: false,
        });

        apply_caption_result(
            &mut project,
            vec![caption("segment-0-0", 1.0, 2.0, &[("hello", 1.0, 2.0)])],
            &[10.0],
            10.0,
        );

        let captions = project.captions.as_ref().unwrap();
        assert!(captions.settings.enabled);
        // Existing style settings survive the regenerate.
        assert_eq!(captions.settings.size, 72);
        assert!(captions.source_timed);
        assert_eq!(captions.segments.len(), 1);

        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(track.len(), 1);
        assert_eq!(track[0].id, "segment-0-0");
        assert_eq!(track[0].text, "hello");
    }

    #[test]
    fn apply_caption_result_synthesises_a_timeline_when_missing() {
        let mut project = ProjectConfiguration::default();

        apply_caption_result(
            &mut project,
            vec![caption("segment-0-0", 1.0, 2.0, &[("hello", 1.0, 2.0)])],
            &[10.0],
            10.0,
        );

        let timeline = project.timeline.as_ref().unwrap();
        assert_eq!(timeline.segments.len(), 1);
        assert!((timeline.segments[0].end - 10.0).abs() < 1e-6);
        assert_eq!(timeline.caption_segments.len(), 1);
    }

    #[test]
    fn generation_error_messages_match_the_web_mapping() {
        assert_eq!(
            caption_generation_error_message("No audio stream found in x"),
            "No audio found in the video file"
        );
        assert_eq!(
            caption_generation_error_message("Model file not found at path: /x"),
            "Caption model not found. Please download it first"
        );
        assert_eq!(caption_generation_error_message("boom"), "boom");
    }
}
