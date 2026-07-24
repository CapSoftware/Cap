use cap_enc_ffmpeg::{
    AudioEncoder,
    h264::{H264EncoderBuilder, H264Preset},
    opus::OpusEncoder,
    remux::{get_media_duration, probe_video_can_decode},
};
use cap_media_info::{AudioInfo, FFRational, Pixel, VideoInfo, ensure_even};
use cap_project::{
    AudioMeta, ClipConfiguration, CursorEvents, CursorMeta, Cursors, InstantRecordingMeta,
    MultipleSegment, MultipleSegments, Platform, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, SingleSegment, StudioRecordingMeta, StudioRecordingStatus,
    TimelineConfiguration, TimelineSegment, VideoMeta, XY,
};
use ffmpeg::{
    ChannelLayout,
    codec::{self as avcodec},
    format::{self as avformat},
};
use image::ImageEncoder;
use relative_path::{Component as RelativeComponent, RelativePathBuf};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
};
use tauri::{AppHandle, Manager, Window};
use tauri_specta::Event;
use tracing::{debug, error, info};

use crate::{
    create_screenshot,
    editor_window::EditorInstances,
    windows::{CapWindowId, EditorWindowIds},
};

const VIDEO_IMPORT_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const AUDIO_IMPORT_EXTENSIONS: &[&str] = &["ogg", "m4a", "mp3", "wav", "aac", "flac"];
const KEYBOARD_IMPORT_EXTENSIONS: &[&str] = &["bin", "json"];
const CURSOR_EVENTS_IMPORT_EXTENSIONS: &[&str] = &["json"];
const MAX_IMAGE_DIMENSION: u32 = 16_384;

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub enum ImportStage {
    Probing,
    Converting,
    Finalizing,
    Complete,
    Failed,
}

#[derive(Serialize, Deserialize, Type, tauri_specta::Event, Clone, Debug)]
pub struct VideoImportProgress {
    pub project_path: String,
    pub stage: ImportStage,
    pub progress: f64,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("Failed to open video file: {0}")]
    OpenFailed(String),
    #[error("No video stream found in file")]
    NoVideoStream,
    #[error("Failed to create decoder: {0}")]
    DecoderFailed(String),
    #[error("Failed to create encoder: {0}")]
    EncoderFailed(String),
    #[error("Failed to create project directory: {0}")]
    DirectoryFailed(std::io::Error),
    #[error("FFmpeg error: {0}")]
    Ffmpeg(#[from] ffmpeg::Error),
    #[error("Transcoding failed: {0}")]
    TranscodeFailed(String),
}

fn emit_progress(
    app: &AppHandle,
    project_path: &str,
    stage: ImportStage,
    progress: f64,
    message: &str,
) {
    let _ = VideoImportProgress {
        project_path: project_path.to_string(),
        stage,
        progress,
        message: message.to_string(),
    }
    .emit(app);
}

fn check_project_exists(project_path: &Path) -> bool {
    project_path.exists() && project_path.join("recording-meta.json").exists()
}

fn generate_project_name(source_path: &Path) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Video");

    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d at %H.%M.%S").to_string();

    format!("{stem} {date_str}")
}

fn generate_image_project_name(source_path: &Path) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Image");

    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d at %H.%M.%S").to_string();

    format!("{stem} {date_str}")
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

fn has_supported_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| {
            extensions
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
}

pub fn is_supported_video_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, VIDEO_IMPORT_EXTENSIONS)
}

pub fn is_supported_image_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, IMAGE_IMPORT_EXTENSIONS)
}

fn is_mp4_import_path(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
}

fn is_cap_project_path(path: &Path) -> bool {
    path.is_dir() && path.join("recording-meta.json").is_file()
}

fn normalized_metadata_relative_path(
    path: &RelativePathBuf,
    asset_kind: &str,
) -> Result<RelativePathBuf, String> {
    let normalized = path.as_str().replace('\\', "/");
    let path = RelativePathBuf::from(normalized);
    let raw = path.as_str();
    if raw.is_empty()
        || raw.starts_with('/')
        || raw.contains(':')
        || path
            .components()
            .any(|component| matches!(component, RelativeComponent::ParentDir))
    {
        return Err(format!(
            "Invalid {asset_kind} path in recording metadata: {raw}"
        ));
    }

    Ok(path)
}

fn source_asset_path(
    source_project_path: &Path,
    source_relative_path: &RelativePathBuf,
    asset_kind: &str,
    allowed_extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let source_relative_path = normalized_metadata_relative_path(source_relative_path, asset_kind)?;

    if !has_supported_extension(Path::new(source_relative_path.as_str()), allowed_extensions) {
        return Err(format!(
            "Unsupported {asset_kind} file type: {}",
            source_relative_path.as_str()
        ));
    }

    let source_path = source_relative_path.to_path(source_project_path);
    if !source_path.is_file() {
        return Ok(None);
    }

    let source_root = source_project_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve source project path: {e}"))?;
    let canonical_source_path = source_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {asset_kind} path: {e}"))?;

    if !canonical_source_path.starts_with(&source_root) {
        return Err(format!(
            "{asset_kind} path escapes source project: {}",
            source_relative_path.as_str()
        ));
    }

    Ok(Some(canonical_source_path))
}

fn required_source_asset_path(
    source_project_path: &Path,
    source_relative_path: &RelativePathBuf,
    asset_kind: &str,
    allowed_extensions: &[&str],
) -> Result<PathBuf, String> {
    source_asset_path(
        source_project_path,
        source_relative_path,
        asset_kind,
        allowed_extensions,
    )?
    .ok_or_else(|| {
        format!(
            "Missing {asset_kind} file: {}",
            source_relative_path.to_path(source_project_path).display()
        )
    })
}

fn legacy_cursor_relative_path(path: &str) -> Result<RelativePathBuf, String> {
    normalized_metadata_relative_path(&RelativePathBuf::from(path), "cursor image")
}

fn editor_project_path_from_window(window: &Window) -> Result<PathBuf, String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|e| e.to_string())?
    else {
        return Err("Import can only be started from an editor window".to_string());
    };

    let window_ids = EditorWindowIds::get(window.app_handle());
    let window_ids = window_ids
        .ids
        .lock()
        .map_err(|_| "Editor window registry unavailable".to_string())?;

    window_ids
        .iter()
        .find(|(_, window_id)| *window_id == id)
        .map(|(path, _)| path.clone())
        .ok_or_else(|| "Editor project path not found".to_string())
}

fn same_project_path(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a == b
}

fn ensure_multiple_segments(meta: &mut RecordingMeta) -> Result<&mut MultipleSegments, String> {
    let RecordingMetaInner::Studio(studio_meta) = &mut meta.inner else {
        return Err("Instant mode recordings cannot be edited".to_string());
    };

    if let StudioRecordingMeta::SingleSegment { segment } = studio_meta.as_ref() {
        let segment = segment.clone();
        **studio_meta = StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: segment.display,
                    camera: segment.camera,
                    mic: segment.audio,
                    system_audio: None,
                    cursor: segment.cursor,
                    keyboard: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::Complete),
            },
        };
    }

    match studio_meta.as_mut() {
        StudioRecordingMeta::MultipleSegments { inner } => Ok(inner),
        StudioRecordingMeta::SingleSegment { .. } => {
            Err("Failed to normalize project recording segments".to_string())
        }
    }
}

fn get_video_duration_secs(path: &Path) -> Result<f64, String> {
    get_media_duration(path)
        .map(|duration| duration.as_secs_f64())
        .ok_or_else(|| format!("Could not determine video duration: {}", path.display()))
}

fn full_timeline_for_segments(
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration = get_video_duration_secs(&segment.display.path.to_path(project_path))?;
            Ok(TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: duration,
                name: None,
                speed_audio_mode: None,
            })
        })
        .collect()
}

fn get_source_video_duration_secs(
    source_meta: &RecordingMeta,
    video: &VideoMeta,
) -> Result<f64, String> {
    let source_path = required_source_asset_path(
        &source_meta.project_path,
        &video.path,
        "video",
        VIDEO_IMPORT_EXTENSIONS,
    )?;
    get_video_duration_secs(&source_path)
}

fn full_timeline_for_source_segments(
    source_meta: &RecordingMeta,
    segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration = get_source_video_duration_secs(source_meta, &segment.display)?;
            Ok(TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: duration,
                name: None,
                speed_audio_mode: None,
            })
        })
        .collect()
}

fn ensure_project_timeline<'a>(
    config: &'a mut ProjectConfiguration,
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<&'a mut TimelineConfiguration, String> {
    if config.timeline.is_none() {
        config.timeline = Some(TimelineConfiguration {
            segments: full_timeline_for_segments(project_path, segments)?,
            transitions: Vec::new(),
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
        });
    }

    config
        .timeline
        .as_mut()
        .ok_or_else(|| "Failed to prepare project timeline".to_string())
}

fn add_clip_configs(
    config: &mut ProjectConfiguration,
    base_index: u32,
    segments: &[MultipleSegment],
) {
    for (offset, segment) in segments.iter().enumerate() {
        let index = base_index + offset as u32;
        let offsets = segment.calculate_audio_offsets();

        if let Some(existing) = config.clips.iter_mut().find(|clip| clip.index == index) {
            existing.offsets = offsets;
            existing.offsets_auto_calculated = true;
        } else {
            config.clips.push(ClipConfiguration {
                index,
                offsets,
                offsets_auto_calculated: true,
            });
        }
    }
}

fn unique_segment_dir(
    project_path: &Path,
    index: u32,
) -> Result<(PathBuf, String), std::io::Error> {
    let segments_root = project_path.join("content").join("segments");
    std::fs::create_dir_all(&segments_root)?;

    let mut counter = 0;
    loop {
        let name = if counter == 0 {
            format!("segment-{index}")
        } else {
            format!("segment-{index}-import-{counter}")
        };
        let path = segments_root.join(&name);
        if !path.exists() {
            std::fs::create_dir_all(&path)?;
            return Ok((path, format!("content/segments/{name}")));
        }
        counter += 1;
    }
}

fn relative_file_extension(path: &RelativePathBuf, fallback: &str) -> String {
    Path::new(path.as_str())
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn relative_file_name(path: &RelativePathBuf, fallback: &str) -> String {
    Path::new(path.as_str())
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn unique_file_name(dir: &Path, preferred: &str) -> String {
    let sanitized = sanitize_filename(preferred);
    let sanitized = if sanitized.is_empty() {
        "file".to_string()
    } else {
        sanitized
    };

    let path = Path::new(&sanitized);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("file")
        .to_string();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut counter = 0;
    loop {
        let candidate = if counter == 0 {
            sanitized.clone()
        } else if let Some(extension) = &extension {
            format!("{stem}-{counter}.{extension}")
        } else {
            format!("{stem}-{counter}")
        };

        if !dir.join(&candidate).exists() {
            return candidate;
        }

        counter += 1;
    }
}

fn copy_file_to_relative_path(
    source_path: &Path,
    target_project_path: &Path,
    target_relative_path: &RelativePathBuf,
) -> Result<(), String> {
    let target_path = target_relative_path.to_path(target_project_path);

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create import directory: {e}"))?;
    }

    std::fs::copy(source_path, &target_path)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy {}: {e}", source_path.display()))
}

fn copy_video_meta(
    source_project_path: &Path,
    target_project_path: &Path,
    source: &VideoMeta,
    target_relative_dir: &str,
    name: &str,
    required: bool,
) -> Result<Option<VideoMeta>, String> {
    let Some(source_path) = source_asset_path(
        source_project_path,
        &source.path,
        "video",
        VIDEO_IMPORT_EXTENSIONS,
    )?
    else {
        if required {
            return Err(format!(
                "Missing video file: {}",
                source.path.to_path(source_project_path).display()
            ));
        }
        return Ok(None);
    };

    let can_decode = probe_video_can_decode(&source_path)
        .map_err(|e| format!("Cannot decode video {}: {e}", source_path.display()))?;
    if !can_decode {
        if required {
            return Err(format!("Unsupported video file: {}", source_path.display()));
        }
        return Ok(None);
    }

    let extension = relative_file_extension(&source.path, "mp4");
    let target_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/{name}.{extension}"));
    copy_file_to_relative_path(&source_path, target_project_path, &target_relative_path)?;

    let mut copied = source.clone();
    copied.path = target_relative_path;
    Ok(Some(copied))
}

fn copy_audio_meta(
    source_project_path: &Path,
    target_project_path: &Path,
    source: &AudioMeta,
    target_relative_dir: &str,
    name: &str,
) -> Result<Option<AudioMeta>, String> {
    let Some(source_path) = source_asset_path(
        source_project_path,
        &source.path,
        "audio",
        AUDIO_IMPORT_EXTENSIONS,
    )?
    else {
        return Ok(None);
    };

    let extension = relative_file_extension(&source.path, "ogg");
    let target_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/{name}.{extension}"));
    copy_file_to_relative_path(&source_path, target_project_path, &target_relative_path)?;

    let mut copied = source.clone();
    copied.path = target_relative_path;
    Ok(Some(copied))
}

fn copy_keyboard_path(
    source_meta: &RecordingMeta,
    source_segment: &MultipleSegment,
    target_project_path: &Path,
    target_relative_dir: &str,
) -> Result<Option<RelativePathBuf>, String> {
    if let Some(source_relative_path) = &source_segment.keyboard {
        let file_name =
            relative_file_name(source_relative_path, cap_project::KEYBOARD_EVENTS_FILE_NAME);
        let Some(source_path) = source_asset_path(
            &source_meta.project_path,
            source_relative_path,
            "keyboard events",
            KEYBOARD_IMPORT_EXTENSIONS,
        )?
        else {
            return Ok(None);
        };

        let target_relative_path = RelativePathBuf::from(format!(
            "{target_relative_dir}/{}",
            sanitize_filename(&file_name)
        ));
        copy_file_to_relative_path(&source_path, target_project_path, &target_relative_path)?;

        return Ok(Some(target_relative_path));
    };

    let Some(display_dir) = source_segment.display.path.parent() else {
        return Ok(None);
    };

    for file_name in [
        cap_project::KEYBOARD_EVENTS_FILE_NAME,
        cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME,
    ] {
        let source_relative_path = display_dir.join(file_name);
        let Some(source_path) = source_asset_path(
            &source_meta.project_path,
            &source_relative_path,
            "keyboard events",
            KEYBOARD_IMPORT_EXTENSIONS,
        )?
        else {
            continue;
        };

        let target_relative_path = RelativePathBuf::from(format!(
            "{target_relative_dir}/{}",
            sanitize_filename(file_name)
        ));
        copy_file_to_relative_path(&source_path, target_project_path, &target_relative_path)?;

        return Ok(Some(target_relative_path));
    }

    Ok(None)
}

fn normalize_cursors_to_correct(cursors: &mut Cursors) -> &mut HashMap<String, CursorMeta> {
    if let Cursors::Old(old) = cursors {
        let converted = old
            .iter()
            .map(|(id, path)| {
                (
                    id.clone(),
                    CursorMeta {
                        image_path: RelativePathBuf::from(path.as_str()),
                        hotspot: XY::new(0.0, 0.0),
                        shape: None,
                    },
                )
            })
            .collect();
        *cursors = Cursors::Correct(converted);
    }

    match cursors {
        Cursors::Correct(map) => map,
        Cursors::Old(_) => unreachable!(),
    }
}

fn unique_cursor_id(
    cursors: &HashMap<String, CursorMeta>,
    import_token: &str,
    source_id: &str,
) -> String {
    let source_id = if source_id.is_empty() {
        "cursor"
    } else {
        source_id
    };
    let base = format!("{import_token}-{source_id}");
    if !cursors.contains_key(&base) {
        return base;
    }

    let mut counter = 1;
    loop {
        let candidate = format!("{base}-{counter}");
        if !cursors.contains_key(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn copy_source_cursor_images(
    source_meta: &RecordingMeta,
    source_cursors: &Cursors,
    target_project_path: &Path,
    target_cursors: &mut Cursors,
    import_token: &str,
) -> Result<HashMap<String, String>, String> {
    let target_cursor_dir = target_project_path.join("content").join("cursors");
    std::fs::create_dir_all(&target_cursor_dir)
        .map_err(|e| format!("Failed to create cursor directory: {e}"))?;

    let target_cursors = normalize_cursors_to_correct(target_cursors);
    let mut id_map = HashMap::new();

    match source_cursors {
        Cursors::Correct(source_map) => {
            for (source_id, cursor) in source_map {
                let Some(source_path) = source_asset_path(
                    &source_meta.project_path,
                    &cursor.image_path,
                    "cursor image",
                    IMAGE_IMPORT_EXTENSIONS,
                )?
                else {
                    continue;
                };

                let new_id = unique_cursor_id(target_cursors, import_token, source_id);
                let source_file_name = relative_file_name(&cursor.image_path, "cursor.png");
                let target_file_name =
                    unique_file_name(&target_cursor_dir, &format!("{new_id}-{source_file_name}"));
                let target_relative_path =
                    RelativePathBuf::from(format!("content/cursors/{target_file_name}"));

                copy_file_to_relative_path(
                    &source_path,
                    target_project_path,
                    &target_relative_path,
                )?;

                target_cursors.insert(
                    new_id.clone(),
                    CursorMeta {
                        image_path: target_relative_path,
                        hotspot: cursor.hotspot,
                        shape: cursor.shape,
                    },
                );
                id_map.insert(source_id.clone(), new_id);
            }
        }
        Cursors::Old(source_map) => {
            for (source_id, source_path) in source_map {
                let source_relative_path = legacy_cursor_relative_path(source_path)?;
                let Some(source_path) = source_asset_path(
                    &source_meta.project_path,
                    &source_relative_path,
                    "cursor image",
                    IMAGE_IMPORT_EXTENSIONS,
                )?
                else {
                    continue;
                };

                let new_id = unique_cursor_id(target_cursors, import_token, source_id);
                let source_file_name = relative_file_name(&source_relative_path, "cursor.png");
                let target_file_name =
                    unique_file_name(&target_cursor_dir, &format!("{new_id}-{source_file_name}"));
                let target_relative_path =
                    RelativePathBuf::from(format!("content/cursors/{target_file_name}"));

                copy_file_to_relative_path(
                    &source_path,
                    target_project_path,
                    &target_relative_path,
                )?;

                target_cursors.insert(
                    new_id.clone(),
                    CursorMeta {
                        image_path: target_relative_path,
                        hotspot: XY::new(0.0, 0.0),
                        shape: None,
                    },
                );
                id_map.insert(source_id.clone(), new_id);
            }
        }
    }

    Ok(id_map)
}

fn copy_cursor_events_path(
    source_meta: &RecordingMeta,
    source_relative_path: &RelativePathBuf,
    target_project_path: &Path,
    target_relative_dir: &str,
    cursor_id_map: &HashMap<String, String>,
) -> Result<Option<RelativePathBuf>, String> {
    let Some(source_path) = source_asset_path(
        &source_meta.project_path,
        source_relative_path,
        "cursor events",
        CURSOR_EVENTS_IMPORT_EXTENSIONS,
    )?
    else {
        return Ok(None);
    };

    let target_relative_path = RelativePathBuf::from(format!("{target_relative_dir}/cursor.json"));
    let target_path = target_relative_path.to_path(target_project_path);
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cursor event directory: {e}"))?;
    }

    if cursor_id_map.is_empty() {
        std::fs::copy(&source_path, &target_path)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy cursor events: {e}"))?;
        return Ok(Some(target_relative_path));
    }

    match CursorEvents::load_from_file(&source_path) {
        Ok(mut events) => {
            for event in &mut events.moves {
                if let Some(new_id) = cursor_id_map.get(&event.cursor_id) {
                    event.cursor_id = new_id.clone();
                }
            }
            for event in &mut events.clicks {
                if let Some(new_id) = cursor_id_map.get(&event.cursor_id) {
                    event.cursor_id = new_id.clone();
                }
            }

            let file = std::fs::File::create(&target_path)
                .map_err(|e| format!("Failed to create cursor event file: {e}"))?;
            serde_json::to_writer_pretty(file, &events)
                .map_err(|e| format!("Failed to write cursor event file: {e}"))?;
        }
        Err(_) => {
            std::fs::copy(&source_path, &target_path)
                .map(|_| ())
                .map_err(|e| format!("Failed to copy cursor events: {e}"))?;
        }
    }

    Ok(Some(target_relative_path))
}

fn single_segment_to_multiple(segment: &SingleSegment) -> MultipleSegment {
    MultipleSegment {
        display: segment.display.clone(),
        camera: segment.camera.clone(),
        mic: segment.audio.clone(),
        system_audio: None,
        cursor: segment.cursor.clone(),
        keyboard: None,
    }
}

fn studio_segments_for_import(studio_meta: &StudioRecordingMeta) -> Vec<MultipleSegment> {
    match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            vec![single_segment_to_multiple(segment)]
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.clone(),
    }
}

fn source_timeline_segments_for_import(
    source_meta: &RecordingMeta,
    source_segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    let source_config = ProjectConfiguration::load(&source_meta.project_path).unwrap_or_default();
    let Some(timeline) = source_config.timeline else {
        return full_timeline_for_source_segments(source_meta, source_segments);
    };

    if timeline.segments.is_empty() {
        return full_timeline_for_source_segments(source_meta, source_segments);
    }

    let mut duration_cache = HashMap::new();
    let mut imported_segments = Vec::new();

    for segment in timeline.segments {
        let source_index = segment.recording_clip;
        let Some(source_segment) = source_segments.get(source_index as usize) else {
            continue;
        };

        let max_duration = if let Some(duration) = duration_cache.get(&source_index) {
            *duration
        } else {
            let duration = get_source_video_duration_secs(source_meta, &source_segment.display)?;
            duration_cache.insert(source_index, duration);
            duration
        };

        if max_duration <= 0.0 {
            continue;
        }

        let raw_start = if segment.start.is_finite() {
            segment.start
        } else {
            0.0
        };
        let raw_end = if segment.end.is_finite() {
            segment.end
        } else {
            max_duration
        };
        let start = raw_start.clamp(0.0, max_duration);
        let end = raw_end.clamp(start, max_duration);
        if end <= start {
            continue;
        }

        imported_segments.push(TimelineSegment {
            recording_clip: source_index,
            timescale: if segment.timescale.is_finite() && segment.timescale > 0.0 {
                segment.timescale
            } else {
                1.0
            },
            start,
            end,
            name: None,
            speed_audio_mode: None,
        });
    }

    if imported_segments.is_empty() {
        full_timeline_for_source_segments(source_meta, source_segments)
    } else {
        Ok(imported_segments)
    }
}

fn copy_source_segment(
    source_meta: &RecordingMeta,
    source_segment: &MultipleSegment,
    target_project_path: &Path,
    target_relative_dir: &str,
    cursor_id_map: &HashMap<String, String>,
) -> Result<MultipleSegment, String> {
    let display = copy_video_meta(
        &source_meta.project_path,
        target_project_path,
        &source_segment.display,
        target_relative_dir,
        "display",
        true,
    )?
    .ok_or_else(|| "Missing display video".to_string())?;

    let camera = source_segment
        .camera
        .as_ref()
        .map(|camera| {
            copy_video_meta(
                &source_meta.project_path,
                target_project_path,
                camera,
                target_relative_dir,
                "camera",
                false,
            )
        })
        .transpose()?
        .flatten();

    let mic = source_segment
        .mic
        .as_ref()
        .map(|mic| {
            copy_audio_meta(
                &source_meta.project_path,
                target_project_path,
                mic,
                target_relative_dir,
                "mic",
            )
        })
        .transpose()?
        .flatten();

    let system_audio = source_segment
        .system_audio
        .as_ref()
        .map(|system_audio| {
            copy_audio_meta(
                &source_meta.project_path,
                target_project_path,
                system_audio,
                target_relative_dir,
                "system-audio",
            )
        })
        .transpose()?
        .flatten();

    let cursor = source_segment
        .cursor
        .as_ref()
        .map(|cursor| {
            copy_cursor_events_path(
                source_meta,
                cursor,
                target_project_path,
                target_relative_dir,
                cursor_id_map,
            )
        })
        .transpose()?
        .flatten();

    let keyboard = copy_keyboard_path(
        source_meta,
        source_segment,
        target_project_path,
        target_relative_dir,
    )?;

    Ok(MultipleSegment {
        display,
        camera,
        mic,
        system_audio,
        cursor,
        keyboard,
    })
}

fn get_video_stream_info(
    input: &avformat::context::Input,
) -> Result<(usize, VideoInfo), ImportError> {
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or(ImportError::NoVideoStream)?;

    let stream_index = stream.index();
    let decoder_ctx = avcodec::Context::from_parameters(stream.parameters())
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;
    let decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;

    let rate = stream.avg_frame_rate();
    let time_base = stream.time_base();

    let pixel_format = match decoder.format() {
        ffmpeg::format::Pixel::YUV420P => Pixel::YUV420P,
        ffmpeg::format::Pixel::NV12 => Pixel::NV12,
        ffmpeg::format::Pixel::BGRA => Pixel::BGRA,
        ffmpeg::format::Pixel::RGBA => Pixel::RGBA,
        ffmpeg::format::Pixel::RGB24 => Pixel::RGB24,
        ffmpeg::format::Pixel::BGR24 => Pixel::BGR24,
        _ => Pixel::YUV420P,
    };

    Ok((
        stream_index,
        VideoInfo {
            pixel_format,
            width: decoder.width(),
            height: decoder.height(),
            time_base: FFRational(time_base.numerator(), time_base.denominator()),
            frame_rate: FFRational(rate.numerator(), rate.denominator()),
        },
    ))
}

fn get_audio_stream_info(input: &avformat::context::Input) -> Option<(usize, AudioInfo)> {
    let stream = input.streams().best(ffmpeg::media::Type::Audio)?;
    let stream_index = stream.index();

    let decoder_ctx = avcodec::Context::from_parameters(stream.parameters()).ok()?;
    let decoder = decoder_ctx.decoder().audio().ok()?;

    let audio_info = AudioInfo::from_decoder(&decoder).ok()?;

    Some((stream_index, audio_info))
}

fn transcode_video(
    app: &AppHandle,
    source_path: &Path,
    output_path: &Path,
    audio_output_path: Option<&Path>,
    project_path_str: &str,
    project_path: &Path,
) -> Result<(u32, Option<u32>), ImportError> {
    use std::time::Duration as StdDuration;

    let mut input =
        avformat::input(source_path).map_err(|e| ImportError::OpenFailed(e.to_string()))?;

    let (video_stream_index, video_info) = get_video_stream_info(&input)?;
    let audio_stream_info = get_audio_stream_info(&input);

    let output_width = ensure_even(video_info.width);
    let output_height = ensure_even(video_info.height);
    let fps = if video_info.frame_rate.1 > 0 {
        ((video_info.frame_rate.0 as f64 / video_info.frame_rate.1 as f64).round() as u32)
            .clamp(1, 120)
    } else {
        30
    };

    let duration = get_media_duration(source_path);
    let total_frames = duration
        .map(|d| (d.as_secs_f64() * fps as f64) as u64)
        .unwrap_or(1000);

    let video_decoder_ctx =
        avcodec::Context::from_parameters(input.stream(video_stream_index).unwrap().parameters())
            .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;
    let mut video_decoder = video_decoder_ctx
        .decoder()
        .video()
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;

    let video_time_base = input.stream(video_stream_index).unwrap().time_base();

    let mut audio_decoder = audio_stream_info.as_ref().and_then(|(idx, _)| {
        let stream = input.stream(*idx)?;
        let decoder_ctx = avcodec::Context::from_parameters(stream.parameters()).ok()?;
        let mut decoder = decoder_ctx.decoder().audio().ok()?;
        if decoder.channel_layout().is_empty() {
            decoder.set_channel_layout(ChannelLayout::default(decoder.channels() as i32));
        }
        decoder.set_packet_time_base(stream.time_base());
        Some((*idx, decoder, stream.time_base()))
    });

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(ImportError::DirectoryFailed)?;
    }

    let mut output =
        avformat::output(output_path).map_err(|e| ImportError::EncoderFailed(e.to_string()))?;

    let encoder_video_info = VideoInfo {
        pixel_format: Pixel::YUV420P,
        width: output_width,
        height: output_height,
        time_base: video_info.time_base,
        frame_rate: FFRational(fps as i32, 1),
    };

    let mut video_encoder = H264EncoderBuilder::new(encoder_video_info)
        .with_preset(H264Preset::Medium)
        .with_output_size(output_width, output_height)
        .map_err(|e| ImportError::EncoderFailed(e.to_string()))?
        .build(&mut output)
        .map_err(|e| ImportError::EncoderFailed(e.to_string()))?;

    let mut audio_output: Option<avformat::context::Output> = None;
    let mut audio_encoder: Option<Box<dyn AudioEncoder + Send>> = None;
    let sample_rate = if let Some((_, audio_info)) = &audio_stream_info {
        if let Some(audio_path) = audio_output_path {
            let mut audio_out = avformat::output(audio_path).map_err(|e| {
                ImportError::EncoderFailed(format!("Failed to create audio output: {e}"))
            })?;

            audio_encoder = Some(Box::new(
                OpusEncoder::init(*audio_info, &mut audio_out)
                    .map_err(|e| ImportError::EncoderFailed(e.to_string()))?,
            ));
            audio_out.write_header().map_err(|e| {
                ImportError::EncoderFailed(format!("Failed to write audio header: {e}"))
            })?;
            audio_output = Some(audio_out);
        }
        Some(audio_info.sample_rate)
    } else {
        None
    };

    output
        .write_header()
        .map_err(|e| ImportError::EncoderFailed(format!("Failed to write header: {e}")))?;

    let mut video_frame = ffmpeg::frame::Video::empty();
    let mut audio_frame = ffmpeg::frame::Audio::empty();
    let mut frames_processed = 0u64;
    let mut last_progress = 0.0;

    let mut scaler: Option<ffmpeg::software::scaling::Context> = None;

    for (stream, packet) in input.packets() {
        let stream_index = stream.index();

        if stream_index == video_stream_index {
            video_decoder.send_packet(&packet)?;

            while video_decoder.receive_frame(&mut video_frame).is_ok() {
                let timestamp = video_frame.pts().unwrap_or(0);
                let time_secs = timestamp as f64 * video_time_base.numerator() as f64
                    / video_time_base.denominator().max(1) as f64;
                let duration = StdDuration::from_secs_f64(time_secs.max(0.0));

                let frame_to_encode = if video_frame.format() != ffmpeg::format::Pixel::YUV420P
                    || video_frame.width() != output_width
                    || video_frame.height() != output_height
                {
                    if scaler.is_none() {
                        scaler = Some(
                            ffmpeg::software::scaling::Context::get(
                                video_frame.format(),
                                video_frame.width(),
                                video_frame.height(),
                                ffmpeg::format::Pixel::YUV420P,
                                output_width,
                                output_height,
                                ffmpeg::software::scaling::Flags::BILINEAR,
                            )
                            .map_err(|e| {
                                ImportError::TranscodeFailed(format!(
                                    "Failed to create scaler: {e}"
                                ))
                            })?,
                        );
                    }
                    let scaler = scaler.as_mut().unwrap();

                    let mut scaled_frame = ffmpeg::frame::Video::empty();
                    scaled_frame.set_format(ffmpeg::format::Pixel::YUV420P);
                    scaled_frame.set_width(output_width);
                    scaled_frame.set_height(output_height);
                    let ret =
                        unsafe { ffmpeg::ffi::av_frame_get_buffer(scaled_frame.as_mut_ptr(), 0) };
                    if ret < 0 {
                        return Err(ImportError::TranscodeFailed(
                            "Failed to allocate frame buffer".to_string(),
                        ));
                    }

                    scaler.run(&video_frame, &mut scaled_frame)?;
                    scaled_frame.set_pts(video_frame.pts());
                    scaled_frame
                } else {
                    video_frame.clone()
                };

                video_encoder
                    .queue_frame(frame_to_encode, duration, &mut output)
                    .map_err(|e| ImportError::TranscodeFailed(e.to_string()))?;

                frames_processed += 1;

                let progress = (frames_processed as f64 / total_frames as f64).min(0.99);
                if progress - last_progress >= 0.01 {
                    last_progress = progress;

                    if !check_project_exists(project_path) {
                        info!("Import cancelled: project directory was deleted");
                        return Err(ImportError::TranscodeFailed("Import cancelled".to_string()));
                    }

                    emit_progress(
                        app,
                        project_path_str,
                        ImportStage::Converting,
                        progress,
                        &format!("Converting video... {}%", (progress * 100.0) as u32),
                    );
                }
            }
        } else if let Some((audio_idx, decoder, _)) = audio_decoder.as_mut()
            && stream_index == *audio_idx
            && let (Some(encoder), Some(audio_out)) =
                (audio_encoder.as_mut(), audio_output.as_mut())
        {
            decoder.send_packet(&packet)?;

            while decoder.receive_frame(&mut audio_frame).is_ok() {
                encoder.send_frame(audio_frame.clone(), audio_out);
            }
        }
    }

    video_decoder.send_eof()?;
    while video_decoder.receive_frame(&mut video_frame).is_ok() {
        let timestamp = video_frame.pts().unwrap_or(0);
        let time_secs = timestamp as f64 * video_time_base.numerator() as f64
            / video_time_base.denominator().max(1) as f64;
        let duration = StdDuration::from_secs_f64(time_secs.max(0.0));

        let frame_to_encode = if video_frame.format() != ffmpeg::format::Pixel::YUV420P
            || video_frame.width() != output_width
            || video_frame.height() != output_height
        {
            if let Some(scaler) = &mut scaler {
                let mut scaled_frame = ffmpeg::frame::Video::empty();
                scaled_frame.set_format(ffmpeg::format::Pixel::YUV420P);
                scaled_frame.set_width(output_width);
                scaled_frame.set_height(output_height);
                let ret = unsafe { ffmpeg::ffi::av_frame_get_buffer(scaled_frame.as_mut_ptr(), 0) };
                if ret < 0 {
                    return Err(ImportError::TranscodeFailed(
                        "Failed to allocate frame buffer".to_string(),
                    ));
                }
                scaler.run(&video_frame, &mut scaled_frame)?;
                scaled_frame.set_pts(video_frame.pts());
                scaled_frame
            } else {
                video_frame.clone()
            }
        } else {
            video_frame.clone()
        };

        video_encoder
            .queue_frame(frame_to_encode, duration, &mut output)
            .map_err(|e| ImportError::TranscodeFailed(e.to_string()))?;
    }

    if let Some((_, decoder, _)) = audio_decoder.as_mut() {
        decoder.send_eof()?;
        while decoder.receive_frame(&mut audio_frame).is_ok() {
            if let (Some(encoder), Some(audio_out)) =
                (audio_encoder.as_mut(), audio_output.as_mut())
            {
                encoder.send_frame(audio_frame.clone(), audio_out);
            }
        }
    }

    video_encoder
        .flush(&mut output)
        .map_err(|e| ImportError::TranscodeFailed(format!("Failed to flush video: {e}")))?;

    if let (Some(encoder), Some(audio_out)) = (&mut audio_encoder, &mut audio_output) {
        encoder
            .flush(audio_out)
            .map_err(|e| ImportError::TranscodeFailed(format!("Failed to flush audio: {e}")))?;
        audio_out.write_trailer().map_err(|e| {
            ImportError::TranscodeFailed(format!("Failed to write audio trailer: {e}"))
        })?;
    }

    output
        .write_trailer()
        .map_err(|e| ImportError::TranscodeFailed(format!("Failed to write trailer: {e}")))?;

    drop(output);

    if let Ok(file) = std::fs::File::open(output_path) {
        let _ = file.sync_all();
    }
    if let Some(audio_path) = audio_output_path
        && let Ok(file) = std::fs::File::open(audio_path)
    {
        let _ = file.sync_all();
    }

    Ok((fps, sample_rate))
}

#[tauri::command]
#[specta::specta]
pub async fn start_video_import(app: AppHandle, source_path: PathBuf) -> Result<PathBuf, String> {
    info!("Starting video import from: {:?}", source_path);

    let recordings_dir = crate::general_settings::GeneralSettingsStore::recordings_dir(&app);

    let project_name = generate_project_name(&source_path);
    let sanitized_name = sanitize_filename(&project_name);
    let project_dir_name = format!("{sanitized_name}.cap");

    let mut project_path = recordings_dir.join(&project_dir_name);
    let mut counter = 1;
    while project_path.exists() {
        let new_name = format!("{sanitized_name} ({counter}).cap");
        project_path = recordings_dir.join(new_name);
        counter += 1;
    }

    let project_path_str = project_path.to_string_lossy().to_string();

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Probing,
        0.0,
        "Analyzing video file...",
    );

    let can_decode =
        probe_video_can_decode(&source_path).map_err(|e| format!("Cannot decode video: {e}"))?;

    if !can_decode {
        emit_progress(
            &app,
            &project_path_str,
            ImportStage::Failed,
            0.0,
            "Video format not supported",
        );
        return Err("Video format not supported or file is corrupted".to_string());
    }

    std::fs::create_dir_all(&project_path).map_err(|e| e.to_string())?;

    let segment_dir = project_path
        .join("content")
        .join("segments")
        .join("segment-0");
    std::fs::create_dir_all(&segment_dir).map_err(|e| e.to_string())?;

    let output_video_path = segment_dir.join("display.mp4");
    let output_audio_path = segment_dir.join("audio.ogg");

    let initial_meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.clone(),
        pretty_name: project_name.clone(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: RelativePathBuf::from("content/segments/segment-0/display.mp4"),
                        fps: 30,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: None,
                    mic: None,
                    system_audio: None,
                    cursor: None,
                    keyboard: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::InProgress),
            },
        })),
        upload: None,
    };

    initial_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save initial metadata: {e:?}"))?;

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Converting,
        0.0,
        "Starting conversion...",
    );

    let return_path = project_path.clone();

    tokio::spawn(async move {
        let app_clone = app.clone();
        let project_path_str_clone = project_path_str.clone();
        let source_path_clone = source_path.clone();
        let output_path_clone = output_video_path.clone();
        let audio_path_clone = output_audio_path.clone();
        let project_path_clone = project_path.clone();

        if !check_project_exists(&project_path) {
            info!("Import aborted before start: project directory missing");
            return;
        }

        let result = tokio::task::spawn_blocking(move || {
            transcode_video(
                &app_clone,
                &source_path_clone,
                &output_path_clone,
                Some(&audio_path_clone),
                &project_path_str_clone,
                &project_path_clone,
            )
        })
        .await;

        match result {
            Ok(Ok((fps, sample_rate))) => {
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Finalizing,
                    0.95,
                    "Creating project metadata...",
                );

                let audio_file_size = std::fs::metadata(&output_audio_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                const MIN_VALID_AUDIO_SIZE: u64 = 1000;
                let system_audio =
                    if sample_rate.is_some() && audio_file_size > MIN_VALID_AUDIO_SIZE {
                        Some(AudioMeta {
                            path: RelativePathBuf::from("content/segments/segment-0/audio.ogg"),
                            start_time: Some(0.0),
                            device_id: None,
                            gap_summary: None,
                        })
                    } else {
                        None
                    };

                let meta = RecordingMeta {
                    platform: Some(Platform::default()),
                    project_path: project_path.clone(),
                    pretty_name: project_name,
                    sharing: None,
                    inner: RecordingMetaInner::Studio(Box::new(
                        StudioRecordingMeta::MultipleSegments {
                            inner: MultipleSegments {
                                segments: vec![MultipleSegment {
                                    display: VideoMeta {
                                        path: RelativePathBuf::from(
                                            "content/segments/segment-0/display.mp4",
                                        ),
                                        fps,
                                        start_time: Some(0.0),
                                        device_id: None,
                                    },
                                    camera: None,
                                    mic: None,
                                    system_audio,
                                    cursor: None,
                                    keyboard: None,
                                }],
                                cursors: Cursors::default(),
                                status: Some(StudioRecordingStatus::Complete),
                            },
                        },
                    )),
                    upload: None,
                };

                if let Err(e) = meta.save_for_project() {
                    error!("Failed to save metadata: {:?}", e);
                    emit_progress(
                        &app,
                        &project_path_str,
                        ImportStage::Failed,
                        0.0,
                        &format!("Failed to save metadata: {e:?}"),
                    );
                    return;
                }

                let screenshots_dir = project_path.join("screenshots");
                if let Err(e) = std::fs::create_dir_all(&screenshots_dir) {
                    error!("Failed to create screenshots directory: {:?}", e);
                } else {
                    let display_screenshot = screenshots_dir.join("display.jpg");
                    let video_path = output_video_path.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            create_screenshot(video_path, display_screenshot, None).await
                        {
                            error!("Failed to create thumbnail for imported video: {}", e);
                        }
                    });
                }

                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Complete,
                    1.0,
                    "Import complete!",
                );

                info!("Video import complete: {:?}", project_path);
            }
            Ok(Err(e)) => {
                error!("Transcoding failed: {}", e);
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Failed,
                    0.0,
                    &e.to_string(),
                );
            }
            Err(e) => {
                error!("Transcoding task panicked: {}", e);
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Failed,
                    0.0,
                    &format!("Transcoding task failed: {e}"),
                );
            }
        }
    });

    Ok(return_path)
}

async fn append_mp4_to_editor_project(
    app: AppHandle,
    target_project_path: PathBuf,
    source_path: PathBuf,
) -> Result<usize, String> {
    if !is_mp4_import_path(&source_path) {
        return Err("Select an MP4 video file to import".to_string());
    }

    let mut target_meta = RecordingMeta::load_for_project(&target_project_path)
        .map_err(|e| format!("Failed to load target project metadata: {e}"))?;
    let mut config = ProjectConfiguration::load(&target_project_path).unwrap_or_default();
    let existing_segments = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.clone()
    };
    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?;

    let new_index = existing_segments.len() as u32;
    let (_, target_relative_dir) = unique_segment_dir(&target_project_path, new_index)
        .map_err(|e| format!("Failed to create imported segment directory: {e}"))?;

    let output_video_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/display.mp4"));
    let output_audio_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/audio.ogg"));
    let output_video_path = output_video_relative_path.to_path(&target_project_path);
    let output_audio_path = output_audio_relative_path.to_path(&target_project_path);
    let project_path_str = target_project_path.to_string_lossy().to_string();

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Probing,
        0.0,
        "Analyzing video file...",
    );

    let can_decode =
        probe_video_can_decode(&source_path).map_err(|e| format!("Cannot decode video: {e}"))?;
    if !can_decode {
        return Err("Video format not supported or file is corrupted".to_string());
    }

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Converting,
        0.0,
        "Starting conversion...",
    );

    let app_for_transcode = app.clone();
    let source_path_for_transcode = source_path.clone();
    let output_video_path_for_transcode = output_video_path.clone();
    let output_audio_path_for_transcode = output_audio_path.clone();
    let project_path_str_for_transcode = project_path_str.clone();
    let target_project_path_for_transcode = target_project_path.clone();

    let (fps, sample_rate) = tokio::task::spawn_blocking(move || {
        transcode_video(
            &app_for_transcode,
            &source_path_for_transcode,
            &output_video_path_for_transcode,
            Some(&output_audio_path_for_transcode),
            &project_path_str_for_transcode,
            &target_project_path_for_transcode,
        )
    })
    .await
    .map_err(|e| format!("Video import task failed: {e}"))?
    .map_err(|e| e.to_string())?;

    let duration = get_video_duration_secs(&output_video_path)?;
    let audio_file_size = std::fs::metadata(&output_audio_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    const MIN_VALID_AUDIO_SIZE: u64 = 1000;
    let system_audio = if sample_rate.is_some() && audio_file_size > MIN_VALID_AUDIO_SIZE {
        Some(AudioMeta {
            path: output_audio_relative_path,
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
        })
    } else {
        None
    };

    let imported_segment = MultipleSegment {
        display: VideoMeta {
            path: output_video_relative_path,
            fps,
            start_time: Some(0.0),
            device_id: None,
        },
        camera: None,
        mic: None,
        system_audio,
        cursor: None,
        keyboard: None,
    };

    {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.push(imported_segment.clone());
    }

    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?
        .segments
        .push(TimelineSegment {
            recording_clip: new_index,
            timescale: 1.0,
            start: 0.0,
            end: duration,
            name: None,
            speed_audio_mode: None,
        });
    add_clip_configs(
        &mut config,
        new_index,
        std::slice::from_ref(&imported_segment),
    );

    target_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {e:?}"))?;
    config
        .write(&target_project_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Complete,
        1.0,
        "Import complete!",
    );

    Ok(1)
}

async fn append_cap_project_to_editor_project(
    app: AppHandle,
    target_project_path: PathBuf,
    source_project_path: PathBuf,
) -> Result<usize, String> {
    let source_meta = RecordingMeta::load_for_project(&source_project_path)
        .map_err(|e| format!("Failed to load source project metadata: {e}"))?;

    let RecordingMetaInner::Studio(source_studio_meta) = &source_meta.inner else {
        return match &source_meta.inner {
            RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
                append_mp4_to_editor_project(app, target_project_path, source_meta.output_path())
                    .await
            }
            RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                Err("Source Cap project is still recording".to_string())
            }
            RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) => {
                Err(format!("Source Cap project failed: {error}"))
            }
            RecordingMetaInner::Studio(_) => unreachable!(),
        };
    };

    let source_segments = studio_segments_for_import(source_studio_meta);
    if source_segments.is_empty() {
        return Err("Source Cap project has no recording segments".to_string());
    }

    let source_timeline = source_timeline_segments_for_import(&source_meta, &source_segments)?;
    let source_cursors = match source_studio_meta.as_ref() {
        StudioRecordingMeta::MultipleSegments { inner } => Some(&inner.cursors),
        StudioRecordingMeta::SingleSegment { .. } => None,
    };

    let mut target_meta = RecordingMeta::load_for_project(&target_project_path)
        .map_err(|e| format!("Failed to load target project metadata: {e}"))?;
    let mut config = ProjectConfiguration::load(&target_project_path).unwrap_or_default();
    let existing_segments = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.clone()
    };
    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?;

    let (base_index, copied_segments, source_to_target_index) = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        let base_index = inner.segments.len() as u32;
        let import_token = format!("import-{}", uuid::Uuid::new_v4().simple());
        let cursor_id_map = if let Some(source_cursors) = source_cursors {
            copy_source_cursor_images(
                &source_meta,
                source_cursors,
                &target_project_path,
                &mut inner.cursors,
                &import_token,
            )?
        } else {
            HashMap::new()
        };

        let mut copied_segments = Vec::new();
        let mut source_to_target_index = HashMap::new();

        for (source_index, source_segment) in source_segments.iter().enumerate() {
            let target_index = base_index + copied_segments.len() as u32;
            let (_, target_relative_dir) =
                unique_segment_dir(&target_project_path, target_index)
                    .map_err(|e| format!("Failed to create imported segment directory: {e}"))?;
            let copied_segment = copy_source_segment(
                &source_meta,
                source_segment,
                &target_project_path,
                &target_relative_dir,
                &cursor_id_map,
            )?;

            inner.segments.push(copied_segment.clone());
            copied_segments.push(copied_segment);
            source_to_target_index.insert(source_index as u32, target_index);
        }

        (base_index, copied_segments, source_to_target_index)
    };

    if copied_segments.is_empty() {
        return Err("Source Cap project has no importable recording segments".to_string());
    }

    {
        let timeline =
            ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?;
        for source_segment in source_timeline {
            let Some(target_index) = source_to_target_index.get(&source_segment.recording_clip)
            else {
                continue;
            };

            timeline.segments.push(TimelineSegment {
                recording_clip: *target_index,
                timescale: source_segment.timescale,
                start: source_segment.start,
                end: source_segment.end,
                name: None,
                speed_audio_mode: source_segment.speed_audio_mode,
            });
        }
    }

    add_clip_configs(&mut config, base_index, &copied_segments);

    target_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {e:?}"))?;
    config
        .write(&target_project_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;

    Ok(copied_segments.len())
}

#[tauri::command]
#[specta::specta]
pub async fn add_existing_recording_to_editor(
    window: Window,
    source_path: PathBuf,
) -> Result<u32, String> {
    let target_project_path = editor_project_path_from_window(&window)?;

    if same_project_path(&target_project_path, &source_path) {
        return Err("Cannot import a recording into itself".to_string());
    }

    let app = window.app_handle().clone();
    let imported_count = if is_mp4_import_path(&source_path) {
        append_mp4_to_editor_project(app, target_project_path, source_path).await?
    } else if is_cap_project_path(&source_path) {
        crate::wait_for_recording_ready(&app, &source_path).await?;
        append_cap_project_to_editor_project(app, target_project_path, source_path).await?
    } else {
        return Err("Select an MP4 file or a Cap project folder".to_string());
    };
    let imported_count =
        u32::try_from(imported_count).map_err(|_| "Too many recordings imported".to_string())?;

    EditorInstances::remove(window).await;

    Ok(imported_count)
}

#[tauri::command]
#[specta::specta]
pub async fn start_image_import(app: AppHandle, source_path: PathBuf) -> Result<PathBuf, String> {
    info!("Starting image import from: {:?}", source_path);

    if !source_path.is_file() {
        return Err("Image file does not exist".to_string());
    }

    let source_path_for_decode = source_path.clone();
    let (image_width, image_height, image_data) =
        tokio::task::spawn_blocking(move || -> Result<(u32, u32, Vec<u8>), String> {
            let image = image::ImageReader::open(&source_path_for_decode)
                .map_err(|e| format!("Failed to open image: {e}"))?
                .with_guessed_format()
                .map_err(|e| format!("Failed to detect image format: {e}"))?
                .decode()
                .map_err(|e| format!("Failed to decode image: {e}"))?;

            let width = image.width();
            let height = image.height();

            if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
                return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
            }

            if width
                .checked_mul(height)
                .and_then(|p| p.checked_mul(4))
                .is_none()
            {
                return Err(format!("Image dimensions overflow: {width}x{height}"));
            }

            let rgba = image.to_rgba8();

            Ok((width, height, rgba.into_raw()))
        })
        .await
        .map_err(|e| format!("Failed to import image: {e}"))??;

    let screenshots_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("screenshots");
    std::fs::create_dir_all(&screenshots_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;

    let project_name = generate_image_project_name(&source_path);
    let filename = project_name.replace(":", ".");
    let filename = format!("{}.cap", sanitize_filename::sanitize(&filename));
    let project_path = screenshots_dir.join(cap_utils::ensure_unique_filename(
        &filename,
        &screenshots_dir,
    )?);
    std::fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create screenshot project directory: {e}"))?;

    let image_filename = "original.png";
    let image_path = project_path.join(image_filename);
    let image_path_for_write = image_path.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&image_path_for_write)
            .map_err(|e| format!("Failed to create imported image file: {e}"))?;
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            image::codecs::png::CompressionType::Default,
            image::codecs::png::FilterType::Adaptive,
        );

        ImageEncoder::write_image(
            encoder,
            &image_data,
            image_width,
            image_height,
            image::ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("Failed to encode imported image: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to write imported image: {e}"))??;

    let video_meta = VideoMeta {
        path: RelativePathBuf::from(image_filename),
        fps: 0,
        start_time: Some(0.0),
        device_id: None,
    };

    let segment = SingleSegment {
        display: video_meta,
        camera: None,
        audio: None,
        cursor: None,
    };

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.clone(),
        pretty_name: project_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::SingleSegment { segment })),
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save screenshot metadata: {e:?}"))?;

    ProjectConfiguration::default()
        .write(&project_path)
        .map_err(|e| format!("Failed to save screenshot project config: {e}"))?;

    let _ = crate::NewScreenshotAdded {
        path: image_path.clone(),
    }
    .emit(&app);

    Ok(image_path)
}

#[tauri::command]
#[specta::specta]
pub async fn check_import_ready(project_path: PathBuf) -> Result<bool, String> {
    debug!("check_import_ready called for: {:?}", project_path);

    let meta = match RecordingMeta::load_for_project(&project_path) {
        Ok(m) => m,
        Err(e) => {
            debug!("check_import_ready: meta load failed: {:?}", e);
            return Ok(false);
        }
    };

    let is_complete = match &meta.inner {
        RecordingMetaInner::Studio(studio) => {
            matches!(studio.status(), StudioRecordingStatus::Complete)
        }
        RecordingMetaInner::Instant(instant) => {
            matches!(instant, InstantRecordingMeta::Complete { .. })
        }
    };

    if !is_complete {
        debug!("check_import_ready: not complete yet");
        return Ok(false);
    }

    let video_path = project_path
        .join("content")
        .join("segments")
        .join("segment-0")
        .join("display.mp4");

    if !video_path.exists() {
        debug!(
            "check_import_ready: video path doesn't exist: {:?}",
            video_path
        );
        return Ok(false);
    }

    let can_decode = probe_video_can_decode(&video_path);
    debug!(
        "check_import_ready: probe_video_can_decode result: {:?}",
        can_decode
    );
    if !can_decode.unwrap_or(false) {
        return Ok(false);
    }

    let duration = get_media_duration(&video_path);
    debug!(
        "check_import_ready: get_media_duration result: {:?}",
        duration
    );
    if duration.is_none() {
        return Ok(false);
    }

    debug!("check_import_ready: all checks passed, returning true");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_asset_path_allows_file_inside_source_project() {
        let source_project = tempfile::tempdir().unwrap();
        let source_relative_path = RelativePathBuf::from("content/segments/segment-0/display.mp4");
        let source_path = source_relative_path.to_path(source_project.path());
        std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        std::fs::write(&source_path, b"video").unwrap();

        let resolved = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "video",
            VIDEO_IMPORT_EXTENSIONS,
        )
        .unwrap()
        .unwrap();

        assert_eq!(resolved, source_path.canonicalize().unwrap());
    }

    #[test]
    fn source_asset_path_allows_backslash_separators() {
        let source_project = tempfile::tempdir().unwrap();
        let source_relative_path =
            RelativePathBuf::from("content\\segments\\segment-0\\display.mp4");
        let source_path = RelativePathBuf::from("content/segments/segment-0/display.mp4")
            .to_path(source_project.path());
        std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        std::fs::write(&source_path, b"video").unwrap();

        let resolved = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "video",
            VIDEO_IMPORT_EXTENSIONS,
        )
        .unwrap()
        .unwrap();

        assert_eq!(resolved, source_path.canonicalize().unwrap());
    }

    #[test]
    fn source_asset_path_rejects_parent_traversal() {
        let source_project = tempfile::tempdir().unwrap();
        let source_relative_path = RelativePathBuf::from("../secret.mp4");

        let error = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "video",
            VIDEO_IMPORT_EXTENSIONS,
        )
        .unwrap_err();

        assert!(error.contains("Invalid video path"));
    }

    #[test]
    fn source_asset_path_rejects_absolute_path() {
        let source_project = tempfile::tempdir().unwrap();
        let source_relative_path = RelativePathBuf::from("/tmp/secret.mp4");

        let error = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "video",
            VIDEO_IMPORT_EXTENSIONS,
        )
        .unwrap_err();

        assert!(error.contains("Invalid video path"));
    }

    #[test]
    fn legacy_cursor_relative_path_rejects_windows_absolute_path() {
        let error = legacy_cursor_relative_path("C:\\Users\\me\\cursor.png").unwrap_err();

        assert!(error.contains("Invalid cursor image path"));
    }

    #[test]
    fn source_asset_path_rejects_unsupported_extension() {
        let source_project = tempfile::tempdir().unwrap();
        let source_relative_path = RelativePathBuf::from("content/segments/segment-0/display.txt");

        let error = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "video",
            VIDEO_IMPORT_EXTENSIONS,
        )
        .unwrap_err();

        assert!(error.contains("Unsupported video file type"));
    }

    #[cfg(unix)]
    #[test]
    fn source_asset_path_rejects_symlink_escape() {
        let source_project = tempfile::tempdir().unwrap();
        let external_dir = tempfile::tempdir().unwrap();
        let external_file = external_dir.path().join("cursor.png");
        std::fs::write(&external_file, b"cursor").unwrap();

        let source_relative_path = RelativePathBuf::from("content/cursors/cursor.png");
        let source_path = source_relative_path.to_path(source_project.path());
        std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&external_file, &source_path).unwrap();

        let error = source_asset_path(
            source_project.path(),
            &source_relative_path,
            "cursor image",
            IMAGE_IMPORT_EXTENSIONS,
        )
        .unwrap_err();

        assert!(error.contains("cursor image path escapes source project"));
    }
}
