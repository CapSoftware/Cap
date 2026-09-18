use cap_enc_ffmpeg::remux::{get_media_duration, probe_video_can_decode};
use cap_project::{
    AudioMeta, ClipConfiguration, CursorEvents, CursorMeta, Cursors, InstantRecordingMeta,
    MultipleSegment, MultipleSegments, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    SingleSegment, StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration,
    TimelineSegment, VideoMeta, XY,
};
use relative_path::{Component as RelativeComponent, RelativePathBuf};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

const VIDEO_IMPORT_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const AUDIO_IMPORT_EXTENSIONS: &[&str] = &[
    "ogg", "m4a", "mp3", "wav", "aac", "flac", "mp4", "webm", "mov", "m4v",
];
const KEYBOARD_IMPORT_EXTENSIONS: &[&str] = &["bin", "json"];
const CURSOR_EVENTS_IMPORT_EXTENSIONS: &[&str] = &["json"];

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
                    display_notch: None,
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
                hide_cursor: None,
                volume: None,
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
                hide_cursor: None,
                volume: None,
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
            style_segments: Vec::new(),
            image_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
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
        display_notch: None,
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
            speed_audio_mode: segment.speed_audio_mode,
            hide_cursor: segment.hide_cursor,
            volume: segment.volume,
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

    let system_audio = if let Some(source_audio) = &source_segment.system_audio {
        if source_audio.path == source_segment.display.path {
            let mut copied = source_audio.clone();
            copied.path = display.path.clone();
            Some(copied)
        } else {
            copy_audio_meta(
                &source_meta.project_path,
                target_project_path,
                source_audio,
                target_relative_dir,
                "system-audio",
            )?
        }
    } else {
        None
    };

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
        display_notch: source_segment.display_notch,
    })
}

pub fn append_studio_cap_project_to_editor_project(
    target_project_path: PathBuf,
    source_project_path: PathBuf,
) -> Result<usize, String> {
    let source_meta = RecordingMeta::load_for_project(&source_project_path)
        .map_err(|e| format!("Failed to load source project metadata: {e}"))?;
    let RecordingMetaInner::Studio(source_studio_meta) = &source_meta.inner else {
        return Err("Source Cap project is not a Studio recording".to_string());
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
                hide_cursor: source_segment.hide_cursor,
                volume: source_segment.volume,
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

pub fn append_instant_cap_project_to_editor_project(
    target_project_path: PathBuf,
    source_project_path: PathBuf,
) -> Result<usize, String> {
    let source_meta = RecordingMeta::load_for_project(&source_project_path)
        .map_err(|e| format!("Failed to load source project metadata: {e}"))?;
    let RecordingMetaInner::Instant(InstantRecordingMeta::Complete { fps, .. }) = source_meta.inner
    else {
        return Err("Source Cap project is not a completed Instant recording".to_string());
    };
    if !(1..=120).contains(&fps) {
        return Err("Instant recording frame rate is invalid".to_string());
    }
    let source_path = required_source_asset_path(
        &source_project_path,
        &RelativePathBuf::from("content/output.mp4"),
        "Instant video",
        VIDEO_IMPORT_EXTENSIONS,
    )?;
    let can_decode = probe_video_can_decode(&source_path)
        .map_err(|e| format!("Cannot decode Instant video: {e}"))?;
    if !can_decode {
        return Err("Instant recording video is unsupported or damaged".to_string());
    }
    let duration = get_video_duration_secs(&source_path)?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("Instant recording duration is invalid".to_string());
    }
    let input = ffmpeg::format::input(&source_path)
        .map_err(|e| format!("Failed to inspect Instant recording audio: {e}"))?;
    let has_audio = input.streams().best(ffmpeg::media::Type::Audio).is_some();

    let mut target_meta = RecordingMeta::load_for_project(&target_project_path)
        .map_err(|e| format!("Failed to load target project metadata: {e}"))?;
    let mut config = ProjectConfiguration::load(&target_project_path).unwrap_or_default();
    let existing_segments = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.clone()
    };
    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?;
    let new_index = u32::try_from(existing_segments.len())
        .map_err(|_| "Editor has too many recording segments".to_string())?;
    let (_, relative_dir) = unique_segment_dir(&target_project_path, new_index)
        .map_err(|e| format!("Failed to create Instant import directory: {e}"))?;
    let relative_display = RelativePathBuf::from(format!("{relative_dir}/display.mp4"));
    copy_file_to_relative_path(&source_path, &target_project_path, &relative_display)?;
    let segment = MultipleSegment {
        display: VideoMeta {
            path: relative_display.clone(),
            fps,
            start_time: Some(0.0),
            device_id: None,
        },
        camera: None,
        mic: None,
        system_audio: has_audio.then_some(AudioMeta {
            path: relative_display,
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
        }),
        cursor: None,
        keyboard: None,
        display_notch: None,
    };
    {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.push(segment.clone());
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
            hide_cursor: None,
            volume: None,
        });
    add_clip_configs(&mut config, new_index, std::slice::from_ref(&segment));
    target_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {e:?}"))?;
    config
        .write(&target_project_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;
    Ok(1)
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
