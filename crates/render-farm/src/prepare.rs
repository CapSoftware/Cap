use crate::web_project::{WebProjectSources, load_web_input_events, write_web_project};
use anyhow::{Context, Result, anyhow, bail};
use cap_editor::{default_screen_recording_project_config, initial_clip_configuration};
use cap_project::{RecordingMeta, StudioRecordingMeta, TimelineConfiguration};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
pub struct PrepareRequest {
    project: PathBuf,
    sources: WebProjectSources,
    #[serde(default)]
    input_events: Option<PathBuf>,
    display_source: String,
    display_content_type: String,
    #[serde(default)]
    session_defaults: bool,
}

fn written_files(root: &Path, dir: &Path, files: &mut Vec<Value>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            written_files(root, &path, files)?;
        } else if kind.is_file() {
            // Manifest paths are keys: always `/`, whatever the OS uses.
            let relative = path
                .strip_prefix(root)?
                .components()
                .map(|part| {
                    part.as_os_str()
                        .to_str()
                        .context("project file name is not UTF-8")
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            files.push(json!({ "path": relative, "size": entry.metadata()?.len() }));
        }
    }
    Ok(())
}

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
        .context("input events")?;
    write_web_project(&request.project, request.sources, input.as_ref()).context("prepare")?;
    // A saved project is rendered as saved: the web app re-applies it to the
    // worker session, overwriting what opening the session filled in.
    if request.session_defaults {
        fill_session_defaults(
            &request.project,
            &request.display_source,
            &request.display_content_type,
        )?;
    }
    let mut files = Vec::new();
    written_files(&request.project, &request.project, &mut files)?;
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({ "files": files }))
}

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
        && let Some(timeline) = initial_timeline(
            studio_meta,
            recorded_display_duration(project, display_source, display_content_type),
        )?
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

fn initial_timeline(
    meta: &StudioRecordingMeta,
    display_duration: Option<f64>,
) -> Result<Option<TimelineConfiguration>> {
    let segments = match meta {
        StudioRecordingMeta::SingleSegment { .. } => 1,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
    };
    let Some(duration) = display_duration.filter(|value| value.is_finite() && *value > 0.0) else {
        return Ok(None);
    };
    if segments != 1 {
        bail!("a browser recording has one segment, not {segments}");
    }
    Ok(Some(serde_json::from_value(json!({
        "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": duration }],
        "zoomSegments": [],
    }))?))
}

fn display_video_duration(source: &Path) -> Option<f64> {
    if let Ok(video) = cap_rendering::Video::new(source, 0.0)
        && video.duration.is_finite()
        && video.duration > 0.0
    {
        return Some(video.duration);
    }
    let input = ffmpeg::format::input(&source).ok()?;
    let duration = input.duration();
    (duration > 0).then(|| duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE))
}

// A browser WebM has no duration in its header; the editor worker rewrites
// it (stream copy) before staging, so this reads the same rewritten file.
fn recorded_display_duration(project: &Path, source: &str, content_type: &str) -> Option<f64> {
    if content_type != "video/webm" {
        return display_video_duration(Path::new(source));
    }
    let finalized = project.parent()?.join("display.finalized.webm");
    let duration = rewrite_webm(source, &finalized)
        .inspect_err(|error| tracing::warn!("WebM rewrite failed: {error:#}"))
        .ok()
        .and_then(|()| display_video_duration(&finalized));
    let _ = fs::remove_file(&finalized);
    duration
}

fn rewrite_webm(source: &str, output: &Path) -> Result<()> {
    let mut input = ffmpeg::format::input(&source).context("open WebM")?;
    let mut muxer = ffmpeg::format::output_as(output, "webm").context("create WebM")?;
    let mut streams = Vec::new();
    for stream in input.streams() {
        let mut copy = muxer.add_stream(ffmpeg::encoder::find(ffmpeg::codec::Id::None))?;
        copy.set_parameters(stream.parameters());
        // SAFETY: the codec tag of a copied stream must be reset so the muxer
        // picks the tag for its own container, as ffmpeg's stream copy does.
        unsafe {
            (*copy.parameters().as_mut_ptr()).codec_tag = 0;
        }
        streams.push((stream.index(), stream.time_base()));
    }
    muxer.write_header().context("write WebM header")?;
    let output_bases: Vec<_> = muxer.streams().map(|stream| stream.time_base()).collect();
    for (stream, mut packet) in input.packets() {
        let Some(position) = streams
            .iter()
            .position(|(index, _)| *index == stream.index())
        else {
            continue;
        };
        packet.rescale_ts(streams[position].1, output_bases[position]);
        packet.set_position(-1);
        packet.set_stream(position);
        packet
            .write_interleaved(&mut muxer)
            .context("write WebM packet")?;
    }
    muxer.write_trailer().context("write WebM trailer")?;
    Ok(())
}

// Round-tripped so `f32` fields keep the editor's short form (0.7 rather
// than 0.699999988079071).
pub fn default_config() -> Result<Value> {
    Ok(serde_json::from_str(&serde_json::to_string(
        &default_screen_recording_project_config(),
    )?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::ProjectConfiguration;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
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
            "session_defaults": true,
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
        let display = fixtures().join("small.mp4");
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
        let meta = RecordingMeta::load_for_project(&dir.join("project")).unwrap();
        let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
            panic!("not a multi-segment studio recording");
        };
        assert!(matches!(
            inner.status,
            Some(cap_project::StudioRecordingStatus::Complete)
        ));
        let segment = &inner.segments[0];
        assert_eq!(segment.display.fps, 30);
        assert_eq!(segment.mic.as_ref().unwrap().start_time, Some(0.002));
        assert!(segment.camera.is_none());
        assert_eq!(
            segment.cursor.as_ref().map(|path| path.as_str()),
            Some("content/segments/segment-0/cursor.json")
        );
        assert!(!inner.cursors.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_project_is_rendered_as_saved() {
        let dir = std::env::temp_dir().join(format!("rf-prepare-saved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut saved = default_screen_recording_project_config();
        saved.timeline = serde_json::from_value(json!({
            "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 1.0, "end": 2.0 }],
            "zoomSegments": []
        }))
        .unwrap();
        let mut request = request(
            &dir.join("project"),
            &fixtures().join("small.mp4"),
            "video/mp4",
            None,
        );
        request.sources.initial_project_config = Some(saved);
        request.session_defaults = false;
        prepare(request).unwrap();
        let config = ProjectConfiguration::load(dir.join("project")).unwrap();
        let segment = &config.timeline.unwrap().segments[0];
        assert_eq!((segment.start, segment.end), (1.0, 2.0));
        assert!(config.clips.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_browser_webm_is_measured_after_the_worker_rewrites_it() {
        let dir = std::env::temp_dir().join(format!("rf-prepare-webm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let display = fixtures().join("display-red.webm");
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
