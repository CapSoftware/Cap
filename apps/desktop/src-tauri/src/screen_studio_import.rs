use cap_project::{
    AspectRatio, CursorClickEvent, CursorEvents, CursorMeta, CursorMoveEvent, Cursors,
    KeyPressEvent, KeyboardEvents, MultipleSegment, MultipleSegments, Platform,
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus, VideoMeta, XY,
};
use relative_path::RelativePathBuf;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tracing::{info, warn};

const SEGMENT_DIR: &str = "content/segments/segment-0";

struct Session {
    output: Option<String>,
    start_ms: f64,
    bounds: Option<(f64, f64, f64, f64)>,
    frame_rate: Option<f64>,
}

fn sessions_by_type(metadata: &Value) -> HashMap<String, Session> {
    let mut sessions = HashMap::new();
    for recorder in metadata["recorders"].as_array().into_iter().flatten() {
        let Some(kind) = recorder["type"].as_str() else {
            continue;
        };
        let Some(session) = recorder["sessions"].as_array().and_then(|s| s.first()) else {
            continue;
        };
        let bounds = session.get("bounds").and_then(|b| {
            Some((
                b["x"].as_f64()?,
                b["y"].as_f64()?,
                b["width"].as_f64()?,
                b["height"].as_f64()?,
            ))
        });
        sessions.insert(
            kind.to_string(),
            Session {
                output: session["outputFilename"].as_str().map(str::to_string),
                start_ms: session["processTimeStartMs"].as_f64().unwrap_or(0.0),
                bounds,
                frame_rate: session["deviceFrameRate"].as_f64(),
            },
        );
    }
    sessions
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn read_events(path: &Path) -> Vec<Value> {
    read_json(path)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn video_fps(path: &Path, fallback: Option<f64>) -> u32 {
    let measured = ffmpeg::format::input(path).ok().and_then(|input| {
        let stream = input.streams().best(ffmpeg::media::Type::Video)?;
        let rate = stream.avg_frame_rate();
        (rate.denominator() != 0)
            .then(|| f64::from(rate.numerator()) / f64::from(rate.denominator()))
    });
    measured
        .or(fallback)
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .map_or(30, |fps| fps.round().clamp(1.0, 240.0) as u32)
}

fn clone_into(source: &Path, destination: &Path) -> Result<(), String> {
    // std::fs::copy uses clonefile on APFS, so multi-gigabyte recordings
    // import instantly without taking extra disk space.
    std::fs::copy(source, destination)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy {}: {e}", source.display()))
}

fn system_cursor_shape(id: &str) -> Option<&'static str> {
    Some(match id {
        "arrow" => "Arrow",
        "contextualMenu" => "ContextualMenu",
        "closedHand" => "ClosedHand",
        "crosshair" => "Crosshair",
        "disappearingItem" => "DisappearingItem",
        "dragCopy" => "DragCopy",
        "dragLink" => "DragLink",
        "iBeam" => "IBeam",
        "openHand" => "OpenHand",
        "operationNotAllowed" => "OperationNotAllowed",
        "pointingHand" => "PointingHand",
        "resizeDown" => "ResizeDown",
        "resizeLeft" => "ResizeLeft",
        "resizeLeftRight" => "ResizeLeftRight",
        "resizeRight" => "ResizeRight",
        "resizeUp" => "ResizeUp",
        "resizeUpDown" => "ResizeUpDown",
        "iBeamCursorForVerticalLayout" => "IBeamVerticalForVerticalLayout",
        _ => return None,
    })
}

fn modifier_key(modifier: &str) -> Option<(&'static str, &'static str)> {
    Some(match modifier {
        "command" => ("Meta", "Meta"),
        "shift" => ("LShift", "LShift"),
        "option" | "alt" => ("LAlt", "LAlt"),
        "control" | "ctrl" => ("LControl", "LControl"),
        _ => return None,
    })
}

fn character_key(character: &str) -> (String, String) {
    let named = |name: &str| (name.to_string(), name.to_string());
    match character {
        " " => named("Space"),
        "\u{7f}" | "\u{8}" => named("Backspace"),
        "\r" | "\n" | "\u{3}" => named("Enter"),
        "\t" | "\u{19}" => named("Tab"),
        "\u{1b}" => named("Escape"),
        "\u{f700}" => named("Up"),
        "\u{f701}" => named("Down"),
        "\u{f702}" => named("Left"),
        "\u{f703}" => named("Right"),
        "\u{f728}" => named("Delete"),
        "\u{f729}" => named("Home"),
        "\u{f72b}" => named("End"),
        "\u{f72c}" => named("PageUp"),
        "\u{f72d}" => named("PageDown"),
        "`" => ("`".into(), "Grave".into()),
        "-" => ("-".into(), "Minus".into()),
        "=" => ("=".into(), "Equal".into()),
        "[" => ("[".into(), "LeftBracket".into()),
        "]" => ("]".into(), "RightBracket".into()),
        "\\" => ("\\".into(), "BackSlash".into()),
        ";" => (";".into(), "Semicolon".into()),
        "'" => ("'".into(), "Apostrophe".into()),
        "," => (",".into(), "Comma".into()),
        "." => (".".into(), "Dot".into()),
        "/" => ("/".into(), "Slash".into()),
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_digit() => (c.to_string(), format!("Key{c}")),
                (Some(c), None) if c.is_ascii_alphabetic() => (
                    c.to_ascii_lowercase().to_string(),
                    c.to_ascii_uppercase().to_string(),
                ),
                _ => (other.to_string(), other.to_string()),
            }
        }
    }
}

fn convert_keystrokes(events: &[Value], start_ms: f64) -> KeyboardEvents {
    let mut presses = Vec::new();
    let mut held_modifiers = BTreeSet::<String>::new();
    for event in events {
        let Some(time) = event["processTimeMs"].as_f64() else {
            continue;
        };
        let time_ms = (time - start_ms).max(0.0);
        let modifiers: BTreeSet<String> = event["activeModifiers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str().map(str::to_string))
            .collect();
        for released in held_modifiers.difference(&modifiers) {
            if let Some((key, code)) = modifier_key(released) {
                presses.push(KeyPressEvent {
                    key: key.into(),
                    key_code: code.into(),
                    time_ms,
                    down: false,
                });
            }
        }
        for pressed in modifiers.difference(&held_modifiers) {
            if let Some((key, code)) = modifier_key(pressed) {
                presses.push(KeyPressEvent {
                    key: key.into(),
                    key_code: code.into(),
                    time_ms,
                    down: true,
                });
            }
        }
        held_modifiers = modifiers;

        let down = match event["type"].as_str() {
            Some("keyDown") => true,
            Some("keyUp") => false,
            _ => continue,
        };
        if down && event["isARepeat"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(character) = event["character"].as_str().filter(|c| !c.is_empty()) else {
            continue;
        };
        let (key, key_code) = character_key(character);
        presses.push(KeyPressEvent {
            key,
            key_code,
            time_ms,
            down,
        });
    }
    let end_ms = presses.last().map_or(0.0, |p| p.time_ms);
    for held in held_modifiers {
        if let Some((key, code)) = modifier_key(&held) {
            presses.push(KeyPressEvent {
                key: key.into(),
                key_code: code.into(),
                time_ms: end_ms,
                down: false,
            });
        }
    }
    KeyboardEvents { presses }
}

fn aspect_ratio(project: &Value) -> Option<AspectRatio> {
    let config = &project["json"]["config"];
    let ratio = &config["defaultOutputAspectRatio"];
    let (x, y) = (ratio["x"].as_f64()?, ratio["y"].as_f64()?);
    let matches = |a: f64, b: f64| (x * b - y * a).abs() < 1e-6;
    if matches(9.0, 16.0) {
        Some(AspectRatio::Vertical)
    } else if matches(16.0, 9.0) {
        Some(AspectRatio::Wide)
    } else if matches(1.0, 1.0) {
        Some(AspectRatio::Square)
    } else if matches(4.0, 3.0) {
        Some(AspectRatio::Classic)
    } else if matches(3.0, 4.0) {
        Some(AspectRatio::Tall)
    } else {
        None
    }
}

fn unique_project_path(recordings_dir: &Path, name: &str) -> PathBuf {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let mut path = recordings_dir.join(format!("{sanitized}.cap"));
    let mut counter = 1;
    while path.exists() {
        path = recordings_dir.join(format!("{sanitized} ({counter}).cap"));
        counter += 1;
    }
    path
}

pub async fn import_project(recordings_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let recording_dir = source.join("recording");
    let metadata = read_json(&recording_dir.join("metadata.json"))?;
    let sessions = sessions_by_type(&metadata);
    let display = sessions
        .get("display")
        .ok_or("This Screen Studio project has no screen recording")?;
    let display_file = display
        .output
        .as_deref()
        .ok_or("The screen recording file is missing from metadata.json")?;
    let display_source = recording_dir.join(display_file);
    if !display_source.exists() {
        return Err(format!(
            "Screen recording not found: {}. Open the project in Screen Studio once so it finishes processing, then try again.",
            display_source.display()
        ));
    }
    let (bounds_x, bounds_y, bounds_w, bounds_h) = display
        .bounds
        .ok_or("The screen size is missing from metadata.json")?;
    let origin_ms = display.start_ms;

    let project = read_json(&source.join("project.json")).unwrap_or(Value::Null);
    let pretty_name = project["json"]["name"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            source
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Screen Studio import".to_string());

    let project_path = unique_project_path(recordings_dir, &pretty_name);
    let segment_dir = project_path.join(SEGMENT_DIR);
    std::fs::create_dir_all(&segment_dir).map_err(|e| e.to_string())?;
    let relative = |file: &str| RelativePathBuf::from(format!("{SEGMENT_DIR}/{file}"));
    let offset_secs = |session: &Session| Some(((session.start_ms - origin_ms) / 1000.0).max(0.0));

    clone_into(&display_source, &segment_dir.join("display.mp4"))?;
    let display_meta = VideoMeta {
        path: relative("display.mp4"),
        fps: video_fps(&display_source, None),
        start_time: offset_secs(display),
        device_id: None,
    };

    let optional_media =
        |kind: &str, name: &str| -> Result<Option<(RelativePathBuf, &Session, PathBuf)>, String> {
            let Some(session) = sessions.get(kind) else {
                return Ok(None);
            };
            let Some(file) = session.output.as_deref() else {
                return Ok(None);
            };
            let source_file = recording_dir.join(file);
            if !source_file.exists() {
                warn!(kind, file, "Screen Studio media file missing; skipping");
                return Ok(None);
            }
            let extension = Path::new(file)
                .extension()
                .map_or("mp4".to_string(), |e| e.to_string_lossy().to_string());
            let file_name = format!("{name}.{extension}");
            clone_into(&source_file, &segment_dir.join(&file_name))?;
            Ok(Some((relative(&file_name), session, source_file)))
        };

    let camera =
        optional_media("webcam", "camera")?.map(|(path, session, source_file)| VideoMeta {
            path,
            fps: video_fps(&source_file, session.frame_rate),
            start_time: offset_secs(session),
            device_id: None,
        });
    let mic = optional_media("microphone", "audio-input")?.map(|(path, session, _)| {
        cap_project::AudioMeta {
            path,
            start_time: offset_secs(session),
            device_id: None,
            gap_summary: None,
        }
    });
    let system_audio = optional_media("systemAudio", "system_audio")?.map(|(path, session, _)| {
        cap_project::AudioMeta {
            path,
            start_time: offset_secs(session),
            device_id: None,
            gap_summary: None,
        }
    });

    // Input events carry the same process clock as the media sessions, so
    // measuring them from the display start lines the cursor up with frames.
    let input_start_ms = origin_ms;
    let (moves_file, clicks_file, keys_file) = metadata["recorders"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["type"] == "input")
        .and_then(|r| r["sessions"].as_array()?.first().cloned())
        .map(|s| {
            (
                s["mouseMovesFilename"].as_str().map(str::to_string),
                s["mouseClicksFilename"].as_str().map(str::to_string),
                s["keyStrokesFilename"].as_str().map(str::to_string),
            )
        })
        .unwrap_or((None, None, None));

    let cursor_infos: HashMap<String, Value> = read_events(&recording_dir.join("cursors.json"))
        .into_iter()
        .filter_map(|info| Some((info["id"].as_str()?.to_string(), info)))
        .collect();
    let mut cursor_ids: HashMap<String, String> = HashMap::new();
    let mut cursor_metas: HashMap<String, CursorMeta> = HashMap::new();
    let cursors_dir = project_path.join("content").join("cursors");
    let mut register_cursor = |ss_id: &str| -> String {
        if let Some(id) = cursor_ids.get(ss_id) {
            return id.clone();
        }
        let id = cursor_ids.len().to_string();
        cursor_ids.insert(ss_id.to_string(), id.clone());
        let image = recording_dir.join("cursors").join(format!("{ss_id}.png"));
        let info = cursor_infos.get(ss_id);
        if image.exists() && std::fs::create_dir_all(&cursors_dir).is_ok() {
            let file_name = format!("cursor_{id}.png");
            if clone_into(&image, &cursors_dir.join(&file_name)).is_ok() {
                let hotspot = info
                    .and_then(|info| {
                        let width = info["standardSize"]["width"].as_f64()?;
                        let height = info["standardSize"]["height"].as_f64()?;
                        Some(XY::new(
                            info["hotSpot"]["x"].as_f64()? / width.max(1.0),
                            info["hotSpot"]["y"].as_f64()? / height.max(1.0),
                        ))
                    })
                    .unwrap_or(XY::new(0.0, 0.0));
                let shape = system_cursor_shape(ss_id).and_then(|variant| {
                    serde_json::from_value(Value::String(format!("MacOS|{variant}"))).ok()
                });
                cursor_metas.insert(
                    id.clone(),
                    CursorMeta {
                        image_path: RelativePathBuf::from(format!("content/cursors/{file_name}")),
                        hotspot,
                        shape,
                    },
                );
            }
        }
        id
    };

    let normalize = |x: f64, y: f64| {
        (
            (x - bounds_x) / bounds_w.max(1.0),
            (y - bounds_y) / bounds_h.max(1.0),
        )
    };
    let modifiers = |event: &Value| -> Vec<String> {
        event["activeModifiers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str().map(str::to_string))
            .collect()
    };

    let mut cursor_events = CursorEvents::default();
    for event in moves_file
        .map(|f| read_events(&recording_dir.join(f)))
        .unwrap_or_default()
    {
        let (Some(time), Some(x), Some(y)) = (
            event["processTimeMs"].as_f64(),
            event["x"].as_f64(),
            event["y"].as_f64(),
        ) else {
            continue;
        };
        let (x, y) = normalize(x, y);
        cursor_events.moves.push(CursorMoveEvent {
            active_modifiers: modifiers(&event),
            cursor_id: register_cursor(event["cursorId"].as_str().unwrap_or("arrow")),
            time_ms: (time - input_start_ms).max(0.0),
            x,
            y,
        });
    }
    for event in clicks_file
        .map(|f| read_events(&recording_dir.join(f)))
        .unwrap_or_default()
    {
        let Some(time) = event["processTimeMs"].as_f64() else {
            continue;
        };
        let down = match event["type"].as_str() {
            Some("mouseDown") => true,
            Some("mouseUp") => false,
            _ => continue,
        };
        let cursor_num = match event["button"].as_str() {
            Some("right") => 1,
            Some("middle") | Some("other") => 2,
            _ => 0,
        };
        cursor_events.clicks.push(CursorClickEvent {
            active_modifiers: modifiers(&event),
            cursor_num,
            cursor_id: register_cursor(event["cursorId"].as_str().unwrap_or("arrow")),
            time_ms: (time - input_start_ms).max(0.0),
            down,
        });
    }
    cursor_events
        .moves
        .sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    cursor_events
        .clicks
        .sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

    let cursor = if cursor_events.moves.is_empty() && cursor_events.clicks.is_empty() {
        None
    } else {
        let json = serde_json::to_vec(&cursor_events).map_err(|e| e.to_string())?;
        std::fs::write(segment_dir.join("cursor.json"), json).map_err(|e| e.to_string())?;
        Some(relative("cursor.json"))
    };

    let keyboard = {
        let events = keys_file
            .map(|f| read_events(&recording_dir.join(f)))
            .unwrap_or_default();
        let keyboard = convert_keystrokes(&events, input_start_ms);
        if keyboard.presses.is_empty() {
            None
        } else {
            keyboard.write_to_file(&segment_dir.join(cap_project::KEYBOARD_EVENTS_FILE_NAME))?;
            Some(relative(cap_project::KEYBOARD_EVENTS_FILE_NAME))
        }
    };

    let meta = RecordingMeta {
        platform: Some(Platform::MacOS),
        project_path: project_path.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: display_meta,
                    camera,
                    mic,
                    system_audio,
                    cursor,
                    keyboard,
                    display_notch: None,
                }],
                cursors: Cursors::Correct(cursor_metas),
                status: Some(StudioRecordingStatus::Complete),
            },
        })),
        upload: None,
    };
    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording metadata: {e:?}"))?;

    if let Some(aspect_ratio) = aspect_ratio(&project) {
        let config = ProjectConfiguration {
            aspect_ratio: Some(aspect_ratio),
            ..Default::default()
        };
        config
            .write(&project_path)
            .map_err(|e| format!("Failed to save project settings: {e}"))?;
    }

    let screenshots_dir = project_path.join("screenshots");
    if std::fs::create_dir_all(&screenshots_dir).is_ok()
        && let Err(error) = crate::create_screenshot(
            segment_dir.join("display.mp4"),
            screenshots_dir.join("display.jpg"),
            None,
        )
        .await
    {
        warn!(%error, "Failed to create thumbnail for Screen Studio import");
    }

    info!(source = %source.display(), project = %project_path.display(), "Imported Screen Studio project");
    Ok(project_path)
}

#[tauri::command]
#[specta::specta]
pub async fn import_screen_studio_project(
    app: AppHandle,
    source_path: PathBuf,
) -> Result<PathBuf, String> {
    let recordings_dir = crate::general_settings::GeneralSettingsStore::recordings_dir(&app);
    std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
    import_project(&recordings_dir, &source_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keystrokes_emit_modifier_presses_and_skip_repeats() {
        let events: Vec<Value> = serde_json::from_str(
            r#"[
                {"activeModifiers":["command"],"character":"c","isARepeat":false,"processTimeMs":1100,"type":"keyDown"},
                {"activeModifiers":["command"],"character":"c","isARepeat":true,"processTimeMs":1150,"type":"keyDown"},
                {"activeModifiers":["command"],"character":"c","isARepeat":false,"processTimeMs":1200,"type":"keyUp"},
                {"activeModifiers":[],"character":" ","isARepeat":false,"processTimeMs":1300,"type":"keyDown"}
            ]"#,
        )
        .unwrap();
        let keyboard = convert_keystrokes(&events, 1000.0);
        let summary: Vec<(String, bool, f64)> = keyboard
            .presses
            .iter()
            .map(|p| (p.key_code.clone(), p.down, p.time_ms))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("Meta".to_string(), true, 100.0),
                ("C".to_string(), true, 100.0),
                ("C".to_string(), false, 200.0),
                ("Meta".to_string(), false, 300.0),
                ("Space".to_string(), true, 300.0),
            ]
        );
    }

    #[tokio::test]
    #[ignore = "imports a real project named by CAP_SCREEN_STUDIO_PROJECT"]
    async fn imports_a_real_screen_studio_project() {
        let Ok(source) = std::env::var("CAP_SCREEN_STUDIO_PROJECT") else {
            return;
        };
        let output = tempfile::tempdir().unwrap();
        let output_dir = std::env::var("CAP_SCREEN_STUDIO_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| output.path().to_path_buf());
        let project = import_project(&output_dir, Path::new(&source))
            .await
            .unwrap();
        let meta = RecordingMeta::load_for_project(&project).unwrap();
        let RecordingMetaInner::Studio(studio) = &meta.inner else {
            panic!("expected a studio recording");
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_ref() else {
            panic!("expected multiple segments");
        };
        let segment = &inner.segments[0];
        assert!(project.join(segment.display.path.as_str()).exists());
        let cursor =
            CursorEvents::load_from_file(&project.join(segment.cursor.as_ref().unwrap().as_str()))
                .unwrap();
        assert!(!cursor.moves.is_empty());
        println!(
            "display fps {} camera {:?} mic {} system {} moves {} clicks {} keyboard {:?} cursors {}",
            segment.display.fps,
            segment.camera.as_ref().map(|c| c.fps),
            segment.mic.is_some(),
            segment.system_audio.is_some(),
            cursor.moves.len(),
            cursor.clicks.len(),
            segment.keyboard,
            match &inner.cursors {
                Cursors::Correct(map) => map.len(),
                Cursors::Old(map) => map.len(),
            },
        );
    }

    #[test]
    fn vertical_output_maps_to_vertical_aspect() {
        let project: Value = serde_json::from_str(
            r#"{"json":{"config":{"defaultOutputAspectRatio":{"x":9,"y":16}}}}"#,
        )
        .unwrap();
        assert!(matches!(
            aspect_ratio(&project),
            Some(AspectRatio::Vertical)
        ));
    }
}
