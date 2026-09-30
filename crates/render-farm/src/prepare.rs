use anyhow::{Context, Result, anyhow, bail};
use cap_editor::{display_video_duration, initial_clip_configuration, initial_timeline};
use cap_export::web_project::{
    WebProjectSources, default_web_project_config, load_web_input_events, write_web_project,
};
use cap_project::RecordingMeta;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Deserialize)]
pub struct PrepareRequest {
    /// Empty directory the project files are written into.
    project: PathBuf,
    sources: WebProjectSources,
    /// The recording's pointer input (NDJSON), already downloaded.
    #[serde(default)]
    input_events: Option<PathBuf>,
    /// Where the display video can be read as recorded (a signed URL), for
    /// the length of a never-edited recording's timeline.
    display_source: String,
    display_content_type: String,
}

fn written_files(root: &Path, dir: &Path, files: &mut Vec<Value>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            written_files(root, &path, files)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("project file name is not UTF-8")?
                .to_owned();
            files.push(json!({ "path": relative, "size": entry.metadata()?.len() }));
        }
    }
    Ok(())
}

/// Writes the project files and lists them, so the coordinator can publish
/// them next to the recording's media.
pub fn prepare(request: PrepareRequest) -> Result<Value> {
    if request.project.exists() && fs::read_dir(&request.project)?.next().is_some() {
        bail!("prepare needs an empty project directory");
    }
    fs::create_dir_all(&request.project)?;
    let input = request
        .input_events
        .as_deref()
        .map(load_web_input_events)
        .transpose()
        .map_err(|error| anyhow!("input events: {error}"))?;
    write_web_project(&request.project, request.sources, input.as_ref())
        .map_err(|error| anyhow!("prepare: {error}"))?;
    fill_session_defaults(
        &request.project,
        &request.display_source,
        &request.display_content_type,
    )?;
    let mut files = Vec::new();
    written_files(&request.project, &request.project, &mut files)?;
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({ "files": files }))
}

/// What an editor session adds when it opens a project: a timeline covering
/// the display video as recorded, and the clips' audio offsets. The worker's
/// render config carries both, so the farm's must too.
fn fill_session_defaults(
    project: &Path,
    display_source: &str,
    display_content_type: &str,
) -> Result<()> {
    let recording_meta =
        RecordingMeta::load_for_project(project).map_err(|error| anyhow!("{error}"))?;
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or_else(|| anyhow!("not a studio recording"))?;
    let mut config = recording_meta.project_config();
    let mut changed = false;
    if config.timeline.is_none()
        && let Some(timeline) = initial_timeline(&recording_meta, studio_meta, |_| {
            recorded_display_duration(project, display_source, display_content_type)
        })
    {
        config.timeline = Some(timeline);
        changed = true;
    }
    if config.clips.is_empty() {
        config.clips = initial_clip_configuration(project, studio_meta);
        changed = true;
    }
    if changed {
        config.write(project)?;
    }
    Ok(())
}

/// Serialized as the editor serializes it, so `f32` fields keep their short
/// form (0.7 rather than 0.699999988079071).
/// The display's length as the editor worker reads it. A browser WebM has no
/// duration in its header, so the worker rewrites it (stream copy) before
/// staging it; this reads the same rewritten file.
fn recorded_display_duration(project: &Path, source: &str, content_type: &str) -> Option<f64> {
    if content_type != "video/webm" {
        return display_video_duration(Path::new(source));
    }
    let finalized = project.parent()?.join("display.finalized.webm");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(source)
        .args(["-map", "0", "-c", "copy", "-f", "webm"])
        .arg(&finalized)
        .status()
        .ok()?;
    let duration = status
        .success()
        .then(|| display_video_duration(&finalized))
        .flatten();
    let _ = fs::remove_file(&finalized);
    duration
}

pub fn default_config() -> Result<Value> {
    Ok(serde_json::from_str(&serde_json::to_string(
        &default_web_project_config(),
    )?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::ProjectConfiguration;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/media-server/src/__tests__/fixtures")
    }

    fn request(
        project: &Path,
        display: &Path,
        content_type: &str,
        input: Option<PathBuf>,
    ) -> PrepareRequest {
        serde_json::from_value(json!({
            "project": project,
            "sources": {
                "title": "Take",
                "display": { "path": "content/segments/segment-0/display.h264.mp4", "fps": 30 },
                "camera": null,
                "mic": { "path": "content/segments/segment-0/mic.mic.opus", "offsetMs": 2 },
                "systemAudio": null,
                "audioDefault": null,
                "initialProjectConfig": null,
                "legacyEditSpec": null
            },
            "input_events": input,
            "display_source": display,
            "display_content_type": content_type,
        }))
        .unwrap()
    }

    #[test]
    fn a_never_edited_recording_opens_on_its_whole_display() {
        let dir = std::env::temp_dir().join(format!("rf-prepare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let events = dir.join("events.ndjson");
        fs::write(
            &events,
            "{\"version\":1,\"platform\":\"MacOS\"}\n{\"kind\":\"move\",\"timeMs\":100,\"x\":0.1,\"y\":0.2,\"cursor\":\"default\",\"button\":0,\"modifiers\":[]}\n",
        )
        .unwrap();
        let display = fixtures().join("test-no-audio.mp4");
        let written = prepare(request(
            &dir.join("project"),
            &display,
            "video/mp4",
            Some(events),
        ))
        .unwrap();
        let paths: Vec<_> = written["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            paths,
            [
                "content/cursors/web-default.png",
                "content/segments/segment-0/cursor.json",
                "project-config.json",
                "recording-meta.json",
            ]
        );
        let config = ProjectConfiguration::load(dir.join("project")).unwrap();
        let timeline = config.timeline.expect("timeline");
        let expected = display_video_duration(&display).unwrap();
        assert_eq!(timeline.segments.len(), 1);
        assert_eq!(timeline.segments[0].end, expected);
        assert_eq!(config.clips.len(), 1);
        assert!(config.clips[0].offsets_auto_calculated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_project_keeps_its_timeline() {
        let dir = std::env::temp_dir().join(format!("rf-prepare-saved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut saved = default_web_project_config();
        saved.timeline = serde_json::from_value(json!({
            "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 1.0, "end": 2.0 }],
            "zoomSegments": []
        }))
        .unwrap();
        let mut request = request(
            &dir.join("project"),
            &fixtures().join("test-no-audio.mp4"),
            "video/mp4",
            None,
        );
        request.sources.initial_project_config = Some(saved);
        prepare(request).unwrap();
        let config = ProjectConfiguration::load(dir.join("project")).unwrap();
        let segment = &config.timeline.unwrap().segments[0];
        assert_eq!((segment.start, segment.end), (1.0, 2.0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_browser_webm_is_measured_after_the_worker_rewrites_it() {
        let dir = std::env::temp_dir().join(format!("rf-prepare-webm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let display = fixtures().join("editor-clips/display-red.webm");
        let duration = recorded_display_duration(
            &dir.join("project"),
            display.to_str().unwrap(),
            "video/webm",
        );
        assert!(duration.is_some_and(|value| value > 0.0));
        assert!(!dir.join("display.finalized.webm").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
