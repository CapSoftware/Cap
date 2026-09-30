//! Writes a browser recording's Cap project files (recording metadata, project
//! configuration and pointer input) around media staged by the caller. The
//! editor worker stages the media next to them; the render farm names the
//! files its manifest provides.

use std::{
    collections::HashMap,
    error::Error,
    fs::{self, File},
    io::{self, BufReader},
    path::Path,
};

use cap_editor::default_screen_recording_project_config;
use cap_project::{
    AudioMeta, CursorMeta, Cursors, KeyboardEvents, MultipleSegment, MultipleSegments,
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus, TimelineConfiguration, VideoMeta, VoiceIsolation,
    web_input::{MAX_WEB_INPUT_BYTES, WebInputData, parse_web_input_events, web_cursor_asset},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebEditorAudioDefault {
    pub enabled_by_default: bool,
    pub isolation: VoiceIsolation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEditSpec {
    pub version: u8,
    pub source_duration: f64,
    pub keep_ranges: Vec<LegacyKeepRange>,
}

#[derive(Deserialize)]
pub struct LegacyKeepRange {
    pub start: f64,
    pub end: f64,
}

/// A video already staged in the project, by its project-relative path.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProjectVideo {
    pub path: String,
    pub fps: u32,
    #[serde(default)]
    pub offset_ms: i64,
}

/// An audio track already staged in the project, by its project-relative path.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProjectAudio {
    pub path: String,
    pub offset_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProjectSources {
    pub title: String,
    pub display: WebProjectVideo,
    pub camera: Option<WebProjectVideo>,
    pub mic: Option<WebProjectAudio>,
    pub system_audio: Option<WebProjectAudio>,
    pub audio_default: Option<WebEditorAudioDefault>,
    pub initial_project_config: Option<ProjectConfiguration>,
    pub legacy_edit_spec: Option<LegacyEditSpec>,
}

#[derive(Default)]
struct StagedWebInput {
    cursor_path: Option<String>,
    keyboard_path: Option<String>,
    cursors: Cursors,
}

pub fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub fn load_web_input_events(path: &Path) -> Result<WebInputData, Box<dyn Error>> {
    if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
        return Err(invalid_input("Input event source must be NDJSON").into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || !(1..=MAX_WEB_INPUT_BYTES).contains(&metadata.len()) {
        return Err(invalid_input("Input event source exceeds the supported size").into());
    }
    Ok(parse_web_input_events(BufReader::new(File::open(path)?))?)
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

fn audio_meta(audio: &WebProjectAudio) -> AudioMeta {
    AudioMeta {
        path: audio.path.clone().into(),
        start_time: Some(audio.offset_ms as f64 / 1000.0),
        device_id: None,
        gap_summary: None,
    }
}

/// Writes `recording-meta.json`, `project-config.json` and the pointer input
/// files for a single-segment browser recording whose media is at the given
/// project-relative paths.
pub fn write_web_project(
    project_path: &Path,
    sources: WebProjectSources,
    input_data: Option<&WebInputData>,
) -> Result<(), Box<dyn Error>> {
    let segment_dir = project_path.join("content/segments/segment-0");
    fs::create_dir_all(&segment_dir)?;
    let staged_input = input_data
        .map(|data| stage_web_input(project_path, &segment_dir, data))
        .transpose()?
        .unwrap_or_default();

    let recording_meta = RecordingMeta {
        platform: input_data.map(|data| data.platform.clone()),
        project_path: project_path.to_path_buf(),
        pretty_name: sources.title,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: sources.display.path.clone().into(),
                        fps: sources.display.fps,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: sources.camera.as_ref().map(|camera| VideoMeta {
                        path: camera.path.clone().into(),
                        fps: camera.fps,
                        start_time: Some(camera.offset_ms as f64 / 1000.0),
                        device_id: None,
                    }),
                    mic: sources.mic.as_ref().map(audio_meta),
                    system_audio: sources.system_audio.as_ref().map(audio_meta),
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
    if sources.initial_project_config.is_some() && sources.legacy_edit_spec.is_some() {
        return Err(invalid_input("Legacy edits cannot replace a saved editor project").into());
    }
    let saved_config = sources.initial_project_config.is_some();
    let mut config = sources
        .initial_project_config
        .unwrap_or_else(default_screen_recording_project_config);
    if !saved_config && let Some(audio_default) = sources.audio_default {
        config.audio.improve = audio_default.enabled_by_default;
        config.audio.isolation = audio_default.isolation;
    }
    if let Some(spec) = sources.legacy_edit_spec {
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
    Ok(())
}

/// The configuration a recording with no saved project opens with.
pub fn default_web_project_config() -> ProjectConfiguration {
    default_screen_recording_project_config()
}
