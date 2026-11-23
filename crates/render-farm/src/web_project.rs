use std::{
    collections::HashMap,
    fs::{self, File},
    io::BufReader,
    path::Path,
};

use anyhow::{Context, Result, bail};
use cap_editor::default_screen_recording_project_config;
use cap_project::{
    CursorMeta, Cursors, KeyboardEvents, ProjectConfiguration, RecordingMeta,
    TimelineConfiguration, VoiceIsolation,
    web_input::{MAX_WEB_INPUT_BYTES, WebInputData, parse_web_input_events, web_cursor_asset},
};
use serde::Deserialize;
use serde_json::{Value, json};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebProjectVideo {
    pub path: String,
    pub fps: u32,
    #[serde(default)]
    pub offset_ms: i64,
}

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

const SEGMENT: &str = "content/segments/segment-0";

pub fn load_web_input_events(path: &Path) -> Result<WebInputData> {
    if path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
        bail!("Input event source must be NDJSON");
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || !(1..=MAX_WEB_INPUT_BYTES).contains(&metadata.len()) {
        bail!("Input event source exceeds the supported size");
    }
    parse_web_input_events(BufReader::new(File::open(path)?))
        .map_err(|error| anyhow::anyhow!("{error}"))
}

fn stage_web_input(
    project_path: &Path,
    segment_dir: &Path,
    data: &WebInputData,
) -> Result<StagedWebInput> {
    let keyboard_path = stage_web_keyboard(segment_dir, &data.keyboard)?;
    if data.cursor.moves.is_empty() && data.cursor.clicks.is_empty() {
        return Ok(StagedWebInput {
            keyboard_path,
            ..Default::default()
        });
    }
    let cursor_dir = project_path.join("content/cursors");
    fs::create_dir_all(&cursor_dir)?;
    let mut cursors = HashMap::new();
    for &style in &data.styles {
        let (image, shape_name, hotspot) =
            web_cursor_asset(&data.platform, style).map_err(|error| anyhow::anyhow!("{error}"))?;
        let image_name = format!("web-{style}.png");
        fs::write(cursor_dir.join(&image_name), image)?;
        let shape = serde_json::from_value(Value::String(shape_name.to_owned()))?;
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
    Ok(StagedWebInput {
        cursor_path: Some(format!("{SEGMENT}/cursor.json")),
        keyboard_path,
        cursors: Cursors::Correct(cursors),
    })
}

fn stage_web_keyboard(segment_dir: &Path, keyboard: &KeyboardEvents) -> Result<Option<String>> {
    if keyboard.presses.is_empty() {
        return Ok(None);
    }
    keyboard
        .write_to_file(&segment_dir.join("keyboard.bin"))
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(Some(format!("{SEGMENT}/keyboard.bin")))
}

fn video_meta(video: &WebProjectVideo) -> Value {
    json!({
        "path": video.path,
        "fps": video.fps,
        "start_time": video.offset_ms as f64 / 1000.0,
    })
}

fn audio_meta(audio: &WebProjectAudio) -> Value {
    json!({
        "path": audio.path,
        "start_time": audio.offset_ms as f64 / 1000.0,
    })
}

fn legacy_timeline(spec: LegacyEditSpec) -> Result<TimelineConfiguration> {
    if spec.version != 1
        || !spec.source_duration.is_finite()
        || !(0.0..=86_400.0).contains(&spec.source_duration)
        || spec.source_duration == 0.0
        || spec.keep_ranges.is_empty()
        || spec.keep_ranges.len() > 1000
    {
        bail!("Invalid legacy editor timeline");
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
            bail!("Invalid legacy editor keep range");
        }
        segments.push(json!({
            "recordingSegment": 0,
            "timescale": 1.0,
            "start": range.start,
            "end": range.end,
        }));
        previous_end = range.end;
    }
    Ok(serde_json::from_value(
        json!({ "segments": segments, "zoomSegments": [] }),
    )?)
}

pub fn write_web_project(
    project_path: &Path,
    sources: WebProjectSources,
    input_data: Option<&WebInputData>,
) -> Result<()> {
    if sources.initial_project_config.is_some() && sources.legacy_edit_spec.is_some() {
        bail!("Legacy edits cannot replace a saved editor project");
    }
    let segment_dir = project_path.join(SEGMENT);
    fs::create_dir_all(&segment_dir)?;
    let staged_input = input_data
        .map(|data| stage_web_input(project_path, &segment_dir, data))
        .transpose()?
        .unwrap_or_default();

    let mut segment = json!({
        "display": {
            "path": sources.display.path,
            "fps": sources.display.fps,
            "start_time": 0.0,
        },
    });
    if let Some(camera) = &sources.camera {
        segment["camera"] = video_meta(camera);
    }
    if let Some(mic) = &sources.mic {
        segment["mic"] = audio_meta(mic);
    }
    if let Some(system_audio) = &sources.system_audio {
        segment["system_audio"] = audio_meta(system_audio);
    }
    if let Some(cursor) = &staged_input.cursor_path {
        segment["cursor"] = json!(cursor);
    }
    if let Some(keyboard) = &staged_input.keyboard_path {
        segment["keyboard"] = json!(keyboard);
    }
    let mut recording_meta: RecordingMeta = serde_json::from_value(json!({
        "platform": input_data.map(|data| &data.platform),
        "pretty_name": sources.title,
        "segments": [segment],
        "cursors": staged_input.cursors,
        "status": { "status": "Complete" },
    }))
    .context("recording metadata")?;
    recording_meta.project_path = project_path.to_path_buf();

    let saved_config = sources.initial_project_config.is_some();
    let mut config = sources
        .initial_project_config
        .unwrap_or_else(default_screen_recording_project_config);
    if !saved_config && let Some(audio_default) = sources.audio_default {
        config.audio.improve = audio_default.enabled_by_default;
        config.audio.isolation = audio_default.isolation;
    }
    if let Some(spec) = sources.legacy_edit_spec {
        config.timeline = Some(legacy_timeline(spec)?);
    }
    config.write(project_path)?;
    recording_meta
        .save_for_project()
        .map_err(|error| anyhow::anyhow!("save recording metadata: {error}"))?;
    Ok(())
}
