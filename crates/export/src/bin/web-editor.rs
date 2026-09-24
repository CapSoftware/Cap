use std::{
    collections::{BTreeSet, HashMap, HashSet},
    env,
    error::Error,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use cap_editor::{AudioOutput, EditorInstance, default_screen_recording_project_config};
use cap_export::{
    ExporterBase,
    estimates::estimate_export_web,
    make_cursor_only_project,
    preview::{ExportPreviewSettings, render_preview_with_config},
    settings::ExportSettings,
};
use cap_project::{
    AudioMeta, ClipConfiguration, CursorClickEvent, CursorEvents, CursorMeta, CursorMoveEvent,
    Cursors, InstantRecordingMeta, KeyPressEvent, KeyboardEvents, MultipleSegment,
    MultipleSegments, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration, VideoMeta, VoiceIsolation,
    XY,
};
use image::ImageDecoder;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebEditorSourceManifest {
    version: u8,
    title: String,
    display_path: PathBuf,
    display_fps: u32,
    camera_path: Option<PathBuf>,
    camera_fps: Option<u32>,
    camera_offset_ms: Option<i64>,
    mic_path: Option<PathBuf>,
    mic_offset_ms: Option<i64>,
    system_audio_path: Option<PathBuf>,
    system_audio_offset_ms: Option<i64>,
    input_events_path: Option<PathBuf>,
    mixed_audio_in_display: bool,
    audio_default: Option<WebEditorAudioDefault>,
    initial_project_config: Option<ProjectConfiguration>,
    legacy_edit_spec: Option<LegacyEditSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebEditorAudioDefault {
    enabled_by_default: bool,
    isolation: VoiceIsolation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEditSpec {
    version: u8,
    source_duration: f64,
    keep_ranges: Vec<LegacyKeepRange>,
}

#[derive(Deserialize)]
struct LegacyKeepRange {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebInputHeader {
    version: u8,
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebInputEvent {
    kind: String,
    time_ms: f64,
    x: Option<f64>,
    y: Option<f64>,
    cursor: Option<String>,
    button: Option<u8>,
    key: Option<String>,
    code: Option<String>,
    modifiers: Vec<String>,
}

struct WebInputData {
    platform: Platform,
    cursor: CursorEvents,
    keyboard: KeyboardEvents,
    styles: BTreeSet<&'static str>,
}

#[derive(Default)]
struct StagedWebInput {
    cursor_path: Option<String>,
    keyboard_path: Option<String>,
    cursors: Cursors,
}

fn web_cursor_style(cursor: &str) -> io::Result<&'static str> {
    match cursor {
        "auto" | "default" => Ok("default"),
        "pointer" => Ok("pointer"),
        "text" => Ok("text"),
        "crosshair" => Ok("crosshair"),
        "grab" => Ok("grab"),
        "grabbing" => Ok("grabbing"),
        "not-allowed" => Ok("not-allowed"),
        "ew-resize" => Ok("ew-resize"),
        "ns-resize" => Ok("ns-resize"),
        _ => Err(invalid_input("Unsupported web cursor shape")),
    }
}

fn safe_web_keyboard_key(key: &str, code: &str) -> bool {
    match key {
        "Escape" | "Tab" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft"
        | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" => code == key,
        "Enter" => matches!(code, "Enter" | "NumpadEnter"),
        "Shift" => matches!(code, "ShiftLeft" | "ShiftRight"),
        "Control" => matches!(code, "ControlLeft" | "ControlRight"),
        "Alt" => matches!(code, "AltLeft" | "AltRight"),
        "Meta" => matches!(code, "MetaLeft" | "MetaRight"),
        _ => {
            code == key
                && key
                    .strip_prefix('F')
                    .and_then(|value| value.parse::<u8>().ok())
                    .is_some_and(|number| (1..=24).contains(&number))
        }
    }
}

fn load_web_input_events(path: &Path) -> Result<WebInputData, Box<dyn Error>> {
    if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
        return Err(invalid_input("Input event source must be NDJSON").into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || !(1..=64 * 1024 * 1024).contains(&metadata.len()) {
        return Err(invalid_input("Input event source exceeds the supported size").into());
    }
    let mut lines = BufReader::new(File::open(path)?).lines();
    let header_line = lines
        .next()
        .ok_or_else(|| invalid_input("Input event source is empty"))??;
    if header_line.len() > 256 {
        return Err(invalid_input("Input event header exceeds the supported size").into());
    }
    let header: WebInputHeader = serde_json::from_str(&header_line)?;
    if header.version != 1 || header.platform.len() > 64 {
        return Err(invalid_input("Unsupported input event source version").into());
    }
    let platform = if header.platform.starts_with("Mac") {
        Platform::MacOS
    } else if header.platform.starts_with("Win") {
        Platform::Windows
    } else if header.platform.starts_with("Linux") {
        Platform::Linux
    } else {
        return Err(invalid_input("Unsupported input event platform").into());
    };
    let mut cursor = CursorEvents::default();
    let mut keyboard = KeyboardEvents::default();
    let mut styles = BTreeSet::new();
    for (index, line) in lines.enumerate() {
        if index >= 500_000 {
            return Err(invalid_input("Input event count exceeds the supported limit").into());
        }
        let line = line?;
        if line.len() > 1024 || line.is_empty() {
            return Err(invalid_input("Input event line is invalid").into());
        }
        let event: WebInputEvent = serde_json::from_str(&line)?;
        if !event.time_ms.is_finite()
            || !(0.0..=86_400_000.0).contains(&event.time_ms)
            || event.modifiers.len() > 4
            || event.modifiers.iter().any(|modifier| {
                !matches!(modifier.as_str(), "Meta" | "LControl" | "LAlt" | "LShift")
            })
        {
            return Err(invalid_input("Input event timestamp or modifiers are invalid").into());
        }
        match event.kind.as_str() {
            "move" | "down" | "up" => {
                let (Some(x), Some(y), Some(cursor_name), Some(button)) =
                    (event.x, event.y, event.cursor, event.button)
                else {
                    return Err(invalid_input("Pointer event is incomplete").into());
                };
                if !x.is_finite()
                    || !y.is_finite()
                    || !(-1.0..=2.0).contains(&x)
                    || !(-1.0..=2.0).contains(&y)
                    || button > 4
                    || event.key.is_some()
                    || event.code.is_some()
                {
                    return Err(invalid_input("Pointer event is invalid").into());
                }
                let style = web_cursor_style(&cursor_name)?;
                styles.insert(style);
                let cursor_id = format!("web-{style}");
                if event.kind == "move" {
                    cursor.moves.push(CursorMoveEvent {
                        active_modifiers: event.modifiers,
                        cursor_id,
                        time_ms: event.time_ms,
                        x,
                        y,
                    });
                } else {
                    cursor.clicks.push(CursorClickEvent {
                        active_modifiers: event.modifiers,
                        cursor_num: button,
                        cursor_id,
                        time_ms: event.time_ms,
                        down: event.kind == "down",
                    });
                }
            }
            "keyDown" | "keyUp" => {
                let (Some(key), Some(code)) = (event.key, event.code) else {
                    return Err(invalid_input("Keyboard event is incomplete").into());
                };
                if key.len() > 64
                    || code.len() > 64
                    || !safe_web_keyboard_key(&key, &code)
                    || event.x.is_some()
                    || event.y.is_some()
                    || event.cursor.is_some()
                    || event.button.is_some()
                {
                    return Err(invalid_input("Keyboard event is invalid").into());
                }
                keyboard.presses.push(KeyPressEvent {
                    key,
                    key_code: code,
                    time_ms: event.time_ms,
                    down: event.kind == "keyDown",
                });
            }
            _ => return Err(invalid_input("Unsupported input event kind").into()),
        }
    }
    cursor
        .moves
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    cursor
        .clicks
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    keyboard
        .presses
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    Ok(WebInputData {
        platform,
        cursor,
        keyboard,
        styles,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebEditorClipManifest {
    version: u8,
    clips: Vec<WebEditorClipSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebEditorClipSource {
    display_path: PathBuf,
    duration: f64,
    fps: u32,
    has_audio: bool,
    camera_path: Option<PathBuf>,
    camera_fps: Option<u32>,
    camera_offset_ms: Option<i64>,
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn next_path(args: &mut impl Iterator<Item = OsString>, name: &str) -> io::Result<PathBuf> {
    args.next()
        .map(PathBuf::from)
        .ok_or_else(|| invalid_input(format!("Missing {name}")))
}

fn media_extension(source: &Path, allowed: &[&str]) -> io::Result<String> {
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| invalid_input("Media source has no extension"))?
        .to_ascii_lowercase();
    if !allowed.contains(&extension.as_str()) {
        return Err(invalid_input(format!(
            "Unsupported media source extension: {extension}"
        )));
    }
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(invalid_input(
            "Media source must be a nonempty regular file",
        ));
    }
    Ok(extension)
}

fn stage_media(source: &Path, destination: &Path) -> io::Result<()> {
    if fs::hard_link(source, destination).is_ok() {
        return Ok(());
    }
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()
}

fn stage_audio(
    source: &Path,
    segment_dir: &Path,
    name: &str,
    offset_ms: i64,
) -> io::Result<AudioMeta> {
    let extension = media_extension(source, &["webm", "mp4", "wav", "ogg", "m4a", "mp3"])?;
    let file_name = format!("{name}.{extension}");
    stage_media(source, &segment_dir.join(&file_name))?;
    Ok(AudioMeta {
        path: format!("content/segments/segment-0/{file_name}").into(),
        start_time: Some(offset_ms as f64 / 1000.0),
        device_id: None,
        gap_summary: None,
    })
}

fn web_cursor_asset(
    platform: &Platform,
    style: &str,
) -> io::Result<(&'static [u8], &'static str, XY<f64>)> {
    let asset = match platform {
        Platform::Windows => match style {
            "default" => (
                include_bytes!("../../assets/web-cursors/windows-default.png").as_slice(),
                "Windows|Arrow",
                XY::new(0.288, 0.189),
            ),
            "pointer" | "grab" | "grabbing" => (
                include_bytes!("../../assets/web-cursors/windows-pointer.png").as_slice(),
                "Windows|Hand",
                XY::new(0.441, 0.143),
            ),
            "text" => (
                include_bytes!("../../assets/web-cursors/windows-text.png").as_slice(),
                "Windows|IBeam",
                XY::new(0.490, 0.471),
            ),
            "crosshair" => (
                include_bytes!("../../assets/web-cursors/windows-crosshair.png").as_slice(),
                "Windows|Cross",
                XY::new(0.5, 0.5),
            ),
            "not-allowed" => (
                include_bytes!("../../assets/web-cursors/windows-not-allowed.png").as_slice(),
                "Windows|No",
                XY::new(0.5, 0.5),
            ),
            "ew-resize" => (
                include_bytes!("../../assets/web-cursors/windows-ew-resize.png").as_slice(),
                "Windows|SizeWE",
                XY::new(0.5, 0.5),
            ),
            "ns-resize" => (
                include_bytes!("../../assets/web-cursors/windows-ns-resize.png").as_slice(),
                "Windows|SizeNS",
                XY::new(0.5, 0.5),
            ),
            _ => return Err(invalid_input("Unsupported Windows cursor style")),
        },
        Platform::MacOS | Platform::Linux => match style {
            "default" => (
                include_bytes!("../../assets/web-cursors/mac-default.png").as_slice(),
                "MacOS|Arrow",
                XY::new(0.302, 0.226),
            ),
            "pointer" => (
                include_bytes!("../../assets/web-cursors/mac-pointer.png").as_slice(),
                "MacOS|PointingHand",
                XY::new(0.342, 0.172),
            ),
            "text" => (
                include_bytes!("../../assets/web-cursors/mac-text.png").as_slice(),
                "MacOS|IBeam",
                XY::new(0.484, 0.520),
            ),
            "crosshair" => (
                include_bytes!("../../assets/web-cursors/mac-crosshair.png").as_slice(),
                "MacOS|Crosshair",
                XY::new(0.52, 0.51),
            ),
            "grab" => (
                include_bytes!("../../assets/web-cursors/mac-grab.png").as_slice(),
                "MacOS|OpenHand",
                XY::new(0.5, 0.5),
            ),
            "grabbing" => (
                include_bytes!("../../assets/web-cursors/mac-grabbing.png").as_slice(),
                "MacOS|ClosedHand",
                XY::new(0.5, 0.5),
            ),
            "not-allowed" => (
                include_bytes!("../../assets/web-cursors/mac-not-allowed.png").as_slice(),
                "MacOS|OperationNotAllowed",
                XY::new(0.24, 0.1),
            ),
            "ew-resize" => (
                include_bytes!("../../assets/web-cursors/mac-ew-resize.png").as_slice(),
                "MacOS|ResizeLeftRight",
                XY::new(0.5, 0.5),
            ),
            "ns-resize" => (
                include_bytes!("../../assets/web-cursors/mac-ns-resize.png").as_slice(),
                "MacOS|ResizeUpDown",
                XY::new(0.5, 0.5),
            ),
            _ => return Err(invalid_input("Unsupported Mac cursor style")),
        },
    };
    Ok(asset)
}

fn stage_web_input(
    project_path: &Path,
    segment_dir: &Path,
    data: &WebInputData,
) -> Result<StagedWebInput, Box<dyn Error>> {
    if !data.cursor.moves.is_empty() || !data.cursor.clicks.is_empty() {
        let cursor_dir = project_path.join("content/cursors");
        fs::create_dir_all(&cursor_dir)?;
        let mut cursors = HashMap::new();
        for &style in &data.styles {
            let (image, shape_name, hotspot) = web_cursor_asset(&data.platform, style)?;
            let image_name = format!("web-{style}.png");
            fs::write(cursor_dir.join(&image_name), image)?;
            let shape = serde_json::from_value(serde_json::Value::String(shape_name.to_owned()))?;
            cursors.insert(
                format!("web-{style}"),
                CursorMeta {
                    image_path: format!("content/cursors/{image_name}").into(),
                    hotspot,
                    shape: Some(shape),
                },
            );
        }
        serde_json::to_writer(File::create(segment_dir.join("cursor.json"))?, &data.cursor)?;
        return Ok(StagedWebInput {
            cursor_path: Some("content/segments/segment-0/cursor.json".to_owned()),
            keyboard_path: stage_web_keyboard(segment_dir, &data.keyboard)?,
            cursors: Cursors::Correct(cursors),
        });
    }
    Ok(StagedWebInput {
        keyboard_path: stage_web_keyboard(segment_dir, &data.keyboard)?,
        ..Default::default()
    })
}

fn stage_web_keyboard(segment_dir: &Path, keyboard: &KeyboardEvents) -> io::Result<Option<String>> {
    if keyboard.presses.is_empty() {
        return Ok(None);
    }
    keyboard
        .write_to_file(&segment_dir.join("keyboard.bin"))
        .map_err(invalid_input)?;
    Ok(Some("content/segments/segment-0/keyboard.bin".to_owned()))
}

fn prepare(project_path: &Path, manifest_path: &Path) -> Result<(), Box<dyn Error>> {
    let manifest: WebEditorSourceManifest = serde_json::from_reader(File::open(manifest_path)?)?;
    if manifest.version != 1 {
        return Err(invalid_input("Unsupported web editor source manifest version").into());
    }
    if manifest.display_fps == 0 || manifest.camera_fps == Some(0) {
        return Err(invalid_input("Source frame rate must be positive").into());
    }
    if manifest.camera_path.is_some() != manifest.camera_fps.is_some() {
        return Err(invalid_input("Camera source and frame rate must be paired").into());
    }
    if manifest.camera_path.is_some() != manifest.camera_offset_ms.is_some() {
        return Err(invalid_input("Camera source and offset must be paired").into());
    }
    if manifest
        .camera_offset_ms
        .is_some_and(|offset| !(-30_000..=30_000).contains(&offset))
    {
        return Err(invalid_input("Camera offset exceeds the supported range").into());
    }
    if manifest.mic_path.is_some() != manifest.mic_offset_ms.is_some()
        || manifest.system_audio_path.is_some() != manifest.system_audio_offset_ms.is_some()
    {
        return Err(invalid_input("Audio source and offset must be paired").into());
    }
    if manifest
        .mic_offset_ms
        .into_iter()
        .chain(manifest.system_audio_offset_ms)
        .any(|offset| !(-30_000..=30_000).contains(&offset))
    {
        return Err(invalid_input("Audio offset exceeds the supported range").into());
    }
    if manifest.mixed_audio_in_display
        && (manifest.mic_path.is_some() || manifest.system_audio_path.is_some())
    {
        return Err(invalid_input("Mixed display audio cannot be added twice").into());
    }

    let display_extension = media_extension(&manifest.display_path, &["webm", "mp4"])?;
    if let Some(camera_path) = &manifest.camera_path {
        media_extension(camera_path, &["webm", "mp4"])?;
    }
    if let Some(mic_path) = &manifest.mic_path {
        media_extension(mic_path, &["webm", "mp4", "wav", "ogg", "m4a", "mp3"])?;
    }
    if let Some(system_audio_path) = &manifest.system_audio_path {
        media_extension(
            system_audio_path,
            &["webm", "mp4", "wav", "ogg", "m4a", "mp3"],
        )?;
    }
    let input_data = manifest
        .input_events_path
        .as_deref()
        .map(load_web_input_events)
        .transpose()?;

    fs::create_dir(project_path)?;
    let segment_dir = project_path.join("content/segments/segment-0");
    fs::create_dir_all(&segment_dir)?;
    let display_name = format!("display.{display_extension}");
    stage_media(&manifest.display_path, &segment_dir.join(&display_name))?;
    let display_relative = format!("content/segments/segment-0/{display_name}");

    let camera = if let Some(source) = &manifest.camera_path {
        let extension = media_extension(source, &["webm", "mp4"])?;
        let file_name = format!("camera.{extension}");
        stage_media(source, &segment_dir.join(&file_name))?;
        Some(VideoMeta {
            path: format!("content/segments/segment-0/{file_name}").into(),
            fps: manifest.camera_fps.unwrap_or(manifest.display_fps),
            start_time: Some(manifest.camera_offset_ms.unwrap_or(0) as f64 / 1000.0),
            device_id: None,
        })
    } else {
        None
    };
    let mic = manifest
        .mic_path
        .as_ref()
        .map(|source| {
            stage_audio(
                source,
                &segment_dir,
                "mic",
                manifest.mic_offset_ms.unwrap_or(0),
            )
        })
        .transpose()?;
    let system_audio = if manifest.mixed_audio_in_display {
        Some(AudioMeta {
            path: display_relative.clone().into(),
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
        })
    } else {
        manifest
            .system_audio_path
            .as_ref()
            .map(|source| {
                stage_audio(
                    source,
                    &segment_dir,
                    "system-audio",
                    manifest.system_audio_offset_ms.unwrap_or(0),
                )
            })
            .transpose()?
    };
    let staged_input = input_data
        .as_ref()
        .map(|data| stage_web_input(project_path, &segment_dir, data))
        .transpose()?
        .unwrap_or_default();

    let recording_meta = RecordingMeta {
        platform: input_data.as_ref().map(|data| data.platform.clone()),
        project_path: project_path.to_path_buf(),
        pretty_name: manifest.title,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: display_relative.into(),
                        fps: manifest.display_fps,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera,
                    mic,
                    system_audio,
                    cursor: staged_input.cursor_path.map(Into::into),
                    keyboard: staged_input.keyboard_path.map(Into::into),
                    display_notch: None,
                }],
                cursors: staged_input.cursors,
                status: Some(StudioRecordingStatus::Complete),
            },
        })),
        upload: None,
    };
    if manifest.initial_project_config.is_some() && manifest.legacy_edit_spec.is_some() {
        return Err(invalid_input("Legacy edits cannot replace a saved editor project").into());
    }
    let saved_config = manifest.initial_project_config.is_some();
    let mut config = manifest
        .initial_project_config
        .unwrap_or_else(default_screen_recording_project_config);
    if !saved_config && let Some(audio_default) = manifest.audio_default {
        config.audio.improve = audio_default.enabled_by_default;
        config.audio.isolation = audio_default.isolation;
    }
    if let Some(spec) = manifest.legacy_edit_spec {
        if spec.version != 1
            || !spec.source_duration.is_finite()
            || !(0.0..=86_400.0).contains(&spec.source_duration)
            || spec.source_duration == 0.0
            || spec.keep_ranges.is_empty()
            || spec.keep_ranges.len() > 1000
        {
            return Err(invalid_input("Invalid legacy editor timeline").into());
        }
        let mut previous_end = 0.0;
        let mut segments = Vec::with_capacity(spec.keep_ranges.len());
        for range in spec.keep_ranges {
            if !range.start.is_finite()
                || !range.end.is_finite()
                || range.start < previous_end
                || range.end - range.start < 0.05
                || range.end > spec.source_duration + 0.001
            {
                return Err(invalid_input("Invalid legacy editor keep range").into());
            }
            segments.push(serde_json::json!({
                "recordingSegment": 0,
                "timescale": 1.0,
                "start": range.start,
                "end": range.end,
            }));
            previous_end = range.end;
        }
        config.timeline = Some(serde_json::from_value::<TimelineConfiguration>(
            serde_json::json!({"segments": segments, "zoomSegments": []}),
        )?);
    }
    config.write(project_path)?;
    recording_meta.save_for_project()?;
    println!(
        "{}",
        serde_json::json!({
            "projectPath": project_path,
            "display": manifest.display_path,
            "camera": manifest.camera_path,
        })
    );
    Ok(())
}

fn staged_clip_video(project_path: &Path, source: &Path) -> io::Result<String> {
    if source.parent() != Some(project_path.join("content/videos").as_path()) {
        return Err(invalid_input(
            "Recording clip is outside staged editor videos",
        ));
    }
    media_extension(source, &["mp4", "webm"])
}

fn inspect_cap_audio(source_path: &Path) -> Result<(), Box<dyn Error>> {
    if !source_path.is_dir() || !source_path.join("recording-meta.json").is_file() {
        return Err(invalid_input("Source Cap project is unavailable").into());
    }
    let source_meta = RecordingMeta::load_for_project(source_path)?;
    let segments = match &source_meta.inner {
        RecordingMetaInner::Studio(source_studio) => {
            source_studio
                .ensure_ordinary_media_access(source_path)
                .map_err(invalid_input)?;
            match source_studio.as_ref() {
                StudioRecordingMeta::SingleSegment { segment } => {
                    vec![serde_json::json!({
                        "display": &segment.display,
                        "camera": &segment.camera,
                        "mic": &segment.audio,
                        "system_audio": null,
                    })]
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .map(|segment| {
                        serde_json::json!({
                            "display": &segment.display,
                            "camera": &segment.camera,
                            "mic": &segment.mic,
                            "system_audio": &segment.system_audio,
                        })
                    })
                    .collect(),
            }
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
            vec![serde_json::json!({
                "display": { "path": "content/output.mp4", "start_time": 0.0 },
                "camera": null,
                "mic": null,
                "system_audio": { "path": "content/output.mp4", "start_time": 0.0 },
            })]
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
            return Err(invalid_input("Cannot inspect a recording in progress").into());
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Failed { .. }) => {
            return Err(invalid_input("Cannot inspect a failed recording").into());
        }
    };
    if segments.is_empty() || segments.len() > 1000 {
        return Err(invalid_input("Source Cap project has no importable clips").into());
    }
    println!("{}", serde_json::json!({ "segments": segments }));
    Ok(())
}

fn append_clips(
    project_path: &Path,
    manifest_path: &Path,
    allow_existing_segments: bool,
) -> Result<(), Box<dyn Error>> {
    let manifest: WebEditorClipManifest = serde_json::from_reader(File::open(manifest_path)?)?;
    if manifest.version != 1 || manifest.clips.is_empty() || manifest.clips.len() > 49 {
        return Err(invalid_input("Invalid web editor clip manifest").into());
    }
    let mut meta = RecordingMeta::load_for_project(project_path)?;
    let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
        return Err(invalid_input("Editor project is not a Studio recording").into());
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        return Err(invalid_input("Editor project has no recording segments").into());
    };
    if !allow_existing_segments && inner.segments.len() != 1 {
        return Err(invalid_input("Editor clip manifest cannot be applied twice").into());
    }
    if allow_existing_segments && manifest.clips.len() != 1 {
        return Err(invalid_input("Ordered editor clip import must contain one clip").into());
    }
    let mut config = ProjectConfiguration::load(project_path)?;
    let mut seen = HashSet::new();
    for clip in manifest.clips {
        if !clip.duration.is_finite()
            || !(0.0..=86_400.0).contains(&clip.duration)
            || clip.duration == 0.0
            || !(1..=120).contains(&clip.fps)
            || clip.camera_path.is_some() != clip.camera_fps.is_some()
            || clip.camera_path.is_some() != clip.camera_offset_ms.is_some()
            || clip.camera_fps.is_some_and(|fps| !(1..=120).contains(&fps))
            || clip
                .camera_offset_ms
                .is_some_and(|offset| !(-30_000..=30_000).contains(&offset))
            || !seen.insert(clip.display_path.clone())
        {
            return Err(invalid_input("Invalid recording clip source").into());
        }
        let display_extension = staged_clip_video(project_path, &clip.display_path)?;
        let camera_extension = clip
            .camera_path
            .as_ref()
            .map(|path| staged_clip_video(project_path, path))
            .transpose()?;
        let index = inner.segments.len();
        let segment_dir = project_path.join(format!("content/segments/segment-{index}"));
        fs::create_dir(&segment_dir)?;
        let display_name = format!("display.{display_extension}");
        stage_media(&clip.display_path, &segment_dir.join(&display_name))?;
        let display_relative = format!("content/segments/segment-{index}/{display_name}");
        let camera = if let (Some(path), Some(extension)) =
            (&clip.camera_path, camera_extension.as_deref())
        {
            let camera_name = format!("camera.{extension}");
            stage_media(path, &segment_dir.join(&camera_name))?;
            Some(VideoMeta {
                path: format!("content/segments/segment-{index}/{camera_name}").into(),
                fps: clip.camera_fps.unwrap_or(clip.fps),
                start_time: Some(clip.camera_offset_ms.unwrap_or(0) as f64 / 1000.0),
                device_id: None,
            })
        } else {
            None
        };
        let segment = MultipleSegment {
            display: VideoMeta {
                path: display_relative.clone().into(),
                fps: clip.fps,
                start_time: Some(0.0),
                device_id: None,
            },
            camera,
            mic: None,
            system_audio: clip.has_audio.then(|| AudioMeta {
                path: display_relative.into(),
                start_time: Some(0.0),
                device_id: None,
                gap_summary: None,
            }),
            cursor: None,
            keyboard: None,
            display_notch: None,
        };
        let clip_index = u32::try_from(index)?;
        if !config.clips.iter().any(|saved| saved.index == clip_index) {
            config.clips.push(ClipConfiguration {
                index: clip_index,
                offsets: segment.calculate_audio_offsets(),
                offsets_auto_calculated: true,
            });
        }
        inner.segments.push(segment);
    }
    let clip_count = inner.segments.len() - 1;
    config.write(project_path)?;
    meta.save_for_project()?;
    println!("{}", serde_json::json!({ "clipCount": clip_count }));
    Ok(())
}

fn read_config(path: &Path) -> Result<ProjectConfiguration, Box<dyn Error>> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}

fn inspect_image(path: &Path) -> Result<(), Box<dyn Error>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 * 1024 {
        return Err(invalid_input("Invalid image file size").into());
    }
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let extension = match reader.format() {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Gif) => "gif",
        Some(image::ImageFormat::Bmp) => "bmp",
        Some(image::ImageFormat::Tiff) => "tiff",
        _ => return Err(invalid_input("Unsupported or damaged image format").into()),
    };
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (source_width, source_height) = decoder.dimensions();
    if source_width == 0
        || source_height == 0
        || u64::from(source_width) * u64::from(source_height) > 16_777_216
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return Err(invalid_input("Image dimensions are too large").into());
    }
    let orientation = decoder.orientation()?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    println!(
        "{}",
        serde_json::json!({
            "extension": extension,
            "width": decoded.width(),
            "height": decoded.height(),
        })
    );
    Ok(())
}

async fn preview(
    project_path: PathBuf,
    config_path: &Path,
    time: f64,
    settings_path: &Path,
    output_path: &Path,
) -> Result<(), Box<dyn Error>> {
    if !time.is_finite() || time < 0.0 {
        return Err(invalid_input("Preview time must be finite and nonnegative").into());
    }
    let settings: ExportPreviewSettings = serde_json::from_reader(File::open(settings_path)?)?;
    if settings.fps == 0 || settings.resolution_base.x == 0 || settings.resolution_base.y == 0 {
        return Err(invalid_input("Preview settings must have positive dimensions").into());
    }
    let config = read_config(config_path)?;
    let result = render_preview_with_config(project_path, config, time, settings, true).await?;
    let bytes = STANDARD.decode(result.jpeg_base64.as_bytes())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    println!(
        "{}",
        serde_json::json!({
            "actualWidth": result.actual_width,
            "actualHeight": result.actual_height,
            "frameRenderTimeMs": result.frame_render_time_ms,
            "totalFrames": result.total_frames,
            "estimatedSizeMb": result.estimated_size_mb,
            "outputPath": output_path,
        })
    );
    Ok(())
}

async fn export(
    project_path: PathBuf,
    config_path: &Path,
    settings_path: &Path,
    output_path: PathBuf,
) -> Result<(), Box<dyn Error>> {
    let settings: ExportSettings = serde_json::from_reader(File::open(settings_path)?)?;
    let resolution = match settings {
        ExportSettings::Mp4(settings) => settings.resolution_base,
        ExportSettings::Gif(settings) => settings.resolution_base,
        ExportSettings::Mov(settings) => settings.resolution_base,
    };
    if !(1..=60).contains(&settings.fps())
        || resolution.x == 0
        || resolution.y == 0
        || resolution.x > 3840
        || resolution.y > 2160
    {
        return Err(invalid_input("Export settings have invalid frame rate or dimensions").into());
    }
    let config = if settings.cursor_only() {
        make_cursor_only_project(read_config(config_path)?)
    } else {
        read_config(config_path)?
    };
    let base = ExporterBase::builder(project_path)
        .with_config(config)
        .with_output_path(output_path)
        .with_force_ffmpeg_decoder(true)
        .build()
        .await?;
    let total_frames = base.total_frames(settings.fps());
    println!(
        "{}",
        serde_json::json!({ "rendered_count": 0, "total_frames": total_frames })
    );
    let progress = move |frame_index: u32| {
        println!(
            "{}",
            serde_json::json!({
                "rendered_count": (frame_index + 1).min(total_frames),
                "total_frames": total_frames,
            })
        );
        true
    };
    let rendered = match settings {
        ExportSettings::Mp4(settings) => settings.export(base, progress).await,
        ExportSettings::Gif(settings) => settings.export(base, progress).await,
        ExportSettings::Mov(settings) => settings.export(base, progress).await,
    }
    .map_err(io::Error::other)?;
    println!("{}", serde_json::json!({ "outputPath": rendered }));
    Ok(())
}

async fn estimate(
    project_path: PathBuf,
    config_path: &Path,
    settings_path: &Path,
) -> Result<(), Box<dyn Error>> {
    let settings: ExportSettings = serde_json::from_reader(File::open(settings_path)?)?;
    let resolution = match settings {
        ExportSettings::Mp4(settings) => settings.resolution_base,
        ExportSettings::Gif(settings) => settings.resolution_base,
        ExportSettings::Mov(settings) => settings.resolution_base,
    };
    if !(1..=60).contains(&settings.fps())
        || resolution.x == 0
        || resolution.y == 0
        || resolution.x > 3840
        || resolution.y > 2160
    {
        return Err(
            invalid_input("Estimate settings have invalid frame rate or dimensions").into(),
        );
    }
    let config = read_config(config_path)?;
    let editor = EditorInstance::new_with_audio_output(
        project_path,
        |_| {},
        Box::new(|_, _| {}),
        None,
        Arc::new(AudioOutput::new_headless(Box::new(|_, _| {}))),
    )
    .await
    .map_err(io::Error::other)?;
    let result = estimate_export_web(
        editor,
        config,
        settings,
        Arc::new(AtomicBool::new(false)),
        |value| {
            println!(
                "{}",
                serde_json::json!({ "kind": "estimate", "value": value })
            )
        },
    )
    .await
    .map_err(io::Error::other)?;
    println!(
        "{}",
        serde_json::json!({ "kind": "result", "value": result })
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let command = args
        .next()
        .ok_or_else(|| invalid_input("Missing command"))?;
    match command.to_string_lossy().as_ref() {
        "inspect-image" => {
            let path = next_path(&mut args, "image path")?;
            inspect_image(&path)?;
        }
        "prepare" => {
            let project_path = next_path(&mut args, "project path")?;
            let manifest_path = next_path(&mut args, "source manifest path")?;
            prepare(&project_path, &manifest_path)?;
        }
        "append-clips" => {
            let project_path = next_path(&mut args, "project path")?;
            let manifest_path = next_path(&mut args, "clip manifest path")?;
            append_clips(&project_path, &manifest_path, false)?;
        }
        "append-clip" => {
            let project_path = next_path(&mut args, "project path")?;
            let manifest_path = next_path(&mut args, "clip manifest path")?;
            append_clips(&project_path, &manifest_path, true)?;
        }
        "append-cap" => {
            let project_path = next_path(&mut args, "project path")?;
            let source_path = next_path(&mut args, "source Cap project path")?;
            if !source_path.is_dir() || !source_path.join("recording-meta.json").is_file() {
                return Err(invalid_input("Source Cap project is unavailable").into());
            }
            if project_path.canonicalize()? == source_path.canonicalize()? {
                return Err(invalid_input("Cannot import a recording into itself").into());
            }
            let source_meta = RecordingMeta::load_for_project(&source_path)?;
            let clip_count = match &source_meta.inner {
                RecordingMetaInner::Studio(source_studio) => {
                    source_studio
                        .ensure_ordinary_media_access(&source_path)
                        .map_err(invalid_input)?;
                    cap_editor::append_studio_cap_project_to_editor_project(
                        project_path,
                        source_path,
                    )
                    .map_err(invalid_input)?
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
                    cap_editor::append_instant_cap_project_to_editor_project(
                        project_path,
                        source_path,
                    )
                    .map_err(invalid_input)?
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                    return Err(invalid_input("Cannot import a recording in progress").into());
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Failed { .. }) => {
                    return Err(invalid_input("Cannot import a failed recording").into());
                }
            };
            println!("{}", serde_json::json!({ "clipCount": clip_count }));
        }
        "inspect-cap-audio" => {
            let source_path = next_path(&mut args, "source Cap project path")?;
            inspect_cap_audio(&source_path)?;
        }
        "preview" => {
            let project_path = next_path(&mut args, "project path")?;
            let config_path = next_path(&mut args, "project configuration path")?;
            let frame_time = args
                .next()
                .ok_or_else(|| invalid_input("Missing preview frame time"))?
                .to_string_lossy()
                .parse::<f64>()?;
            let settings_path = next_path(&mut args, "preview settings path")?;
            let output_path = next_path(&mut args, "preview output path")?;
            preview(
                project_path,
                &config_path,
                frame_time,
                &settings_path,
                &output_path,
            )
            .await?;
        }
        "export" => {
            let project_path = next_path(&mut args, "project path")?;
            let config_path = next_path(&mut args, "project configuration path")?;
            let settings_path = next_path(&mut args, "export settings path")?;
            let output_path = next_path(&mut args, "export output path")?;
            export(project_path, &config_path, &settings_path, output_path).await?;
        }
        "estimate" => {
            let project_path = next_path(&mut args, "project path")?;
            let config_path = next_path(&mut args, "project configuration path")?;
            let settings_path = next_path(&mut args, "export settings path")?;
            estimate(project_path, &config_path, &settings_path).await?;
        }
        _ => return Err(invalid_input("Unknown web editor command").into()),
    }
    if args.next().is_some() {
        return Err(invalid_input("Unexpected extra arguments").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_browser_input_as_native_editor_events() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("events.ndjson");
        fs::write(
            &source,
            concat!(
                "{\"version\":1,\"platform\":\"MacIntel\"}\n",
                "{\"kind\":\"move\",\"timeMs\":12,\"x\":0.25,\"y\":0.5,\"cursor\":\"pointer\",\"button\":0,\"modifiers\":[]}\n",
                "{\"kind\":\"down\",\"timeMs\":13,\"x\":0.25,\"y\":0.5,\"cursor\":\"pointer\",\"button\":0,\"modifiers\":[]}\n",
                "{\"kind\":\"up\",\"timeMs\":20,\"x\":0.25,\"y\":0.5,\"cursor\":\"pointer\",\"button\":0,\"modifiers\":[]}\n",
                "{\"kind\":\"keyDown\",\"timeMs\":21,\"key\":\"Escape\",\"code\":\"Escape\",\"modifiers\":[]}\n",
            ),
        )
        .unwrap();
        let data = load_web_input_events(&source).unwrap();
        assert!(matches!(data.platform, Platform::MacOS));
        assert_eq!(data.cursor.moves.len(), 1);
        assert_eq!(data.cursor.clicks.len(), 2);
        assert!(data.cursor.clicks[0].down);
        assert!(!data.cursor.clicks[1].down);
        assert_eq!(data.keyboard.presses.len(), 1);
        assert_eq!(data.keyboard.presses[0].key_code, "Escape");
        assert!(data.styles.contains("pointer"));
    }

    #[test]
    fn rejects_incomplete_or_private_input_events() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("events.ndjson");
        fs::write(
            &source,
            concat!(
                "{\"version\":1,\"platform\":\"MacIntel\"}\n",
                "{\"kind\":\"keyDown\",\"timeMs\":21,\"key\":\"secret\",\"code\":\"\",\"modifiers\":[],\"text\":\"secret\"}\n",
            ),
        )
        .unwrap();
        assert!(load_web_input_events(&source).is_err());
        fs::write(
            &source,
            concat!(
                "{\"version\":1,\"platform\":\"MacIntel\"}\n",
                "{\"kind\":\"keyDown\",\"timeMs\":21,\"key\":\"k\",\"code\":\"KeyK\",\"modifiers\":[]}\n",
            ),
        )
        .unwrap();
        assert!(load_web_input_events(&source).is_err());
    }
}
