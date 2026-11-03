//! File and project chaos for the editor, playback, seek, render and export
//! engines: a small generated Studio project, copied per probe, with one
//! hostile change to its media, metadata, configuration or cursor data.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::Context;
use cap_project::{RecordingMeta, XY};
use cap_verify::{
    audio_code::AudioSource,
    fixture::{self, AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec},
};
use serde_json::{Value, json};

use super::harness::{Ctx, Probe, Verdict};

pub const SECONDS: f64 = 2.0;
pub const SEGMENT: &str = "content/segments/segment-0";

pub fn spec() -> FixtureSpec {
    let audio = |source, channels| AudioTrackSpec {
        source,
        sample_rate: 48_000,
        channels,
        duration: SECONDS,
        start_time: 0.0,
    };
    FixtureSpec {
        name: "chaos-base".into(),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(160, 90, 30, Timing::Constant { duration: SECONDS }),
            camera: Some(VideoTrackSpec::new(
                96,
                72,
                30,
                Timing::Constant { duration: SECONDS },
            )),
            mic: Some(audio(AudioSource::Mic, 1)),
            system_audio: Some(audio(AudioSource::System, 2)),
        }],
    }
}

/// The cached base fixture (generated on first use).
pub fn base() -> anyhow::Result<PathBuf> {
    fixture::ensure_fixture(&spec(), fixture::write_fixture)
}

pub fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn cursor_json() -> Value {
    let moves: Vec<Value> = (0..60)
        .map(|i| {
            json!({
                "active_modifiers": [],
                "cursor_id": "0",
                "time_ms": f64::from(i) * 33.0,
                "x": 0.2 + f64::from(i) * 0.01,
                "y": 0.3 + f64::from(i % 7) * 0.05,
            })
        })
        .collect();
    let clicks: Vec<Value> = (0..4)
        .map(|i| {
            json!({
                "active_modifiers": [],
                "cursor_num": 0,
                "cursor_id": "0",
                "time_ms": 300.0 + f64::from(i) * 400.0,
                "down": i % 2 == 0,
            })
        })
        .collect();
    json!({ "clicks": clicks, "moves": moves })
}

/// A configuration that exercises every timeline track the renderer reads.
pub fn rich_config(base: &Value) -> Value {
    let mut config = base.clone();
    config["timeline"] = json!({
        "segments": [
            { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 0.9 },
            { "recordingSegment": 0, "timescale": 2.0, "start": 0.9, "end": 1.9 },
            { "recordingSegment": 0, "timescale": 0.5, "start": 1.2, "end": 1.6 }
        ],
        "transitions": [{ "segmentIndex": 1, "type": "cross-fade", "duration": 0.2 }],
        "zoomSegments": [
            { "start": 0.1, "end": 0.8, "amount": 1.8, "mode": "auto" },
            { "start": 1.0, "end": 1.4, "amount": 2.5, "mode": { "manual": { "x": 0.3, "y": 0.6 } } }
        ],
        "sceneSegments": [{ "start": 0.5, "end": 1.0, "mode": "splitScreen" }],
        "maskSegments": [{
            "start": 0.2, "end": 1.2, "track": 0, "maskType": "sensitive",
            "center": { "x": 0.5, "y": 0.5 }, "size": { "x": 0.2, "y": 0.2 }
        }],
        "textSegments": [{ "start": 0.3, "end": 1.5, "track": 0, "content": "Chaos" }],
        "captionSegments": [{ "id": "c0", "start": 0.1, "end": 1.0, "text": "hello chaos" }],
        "keyboardSegments": [{
            "id": "k0", "start": 0.2, "end": 1.0, "displayText": "ab",
            "keys": [{ "key": "a", "timeOffset": 100.0 }, { "key": "b", "timeOffset": 400.0 }]
        }],
        "camera3dSegments": [{ "start": 0.4, "end": 0.9 }],
        "styleSegments": [{ "start": 0.6, "end": 1.1, "overrides": { "background": { "padding": 10.0 } } }]
    });
    config["captions"] = json!({
        "segments": [{ "id": "s0", "start": 0.1, "end": 1.0, "text": "hello chaos" }],
        "settings": { "enabled": true }
    });
    config["keyboard"] = json!({ "settings": { "enabled": true } });
    config["annotations"] = json!([{
        "id": "a0", "type": "rectangle", "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2,
        "strokeColor": "#ff0000", "strokeWidth": 2.0, "fillColor": "#00000000",
        "opacity": 1.0, "rotation": 0.0, "text": null
    }]);
    config
}

/// A copy of the base fixture with a cursor track and a rich configuration.
pub fn prepare(ctx: &Ctx) -> anyhow::Result<PathBuf> {
    let dir = ctx.path("project.cap");
    copy_dir(&base()?, &dir)?;
    let _ = std::fs::remove_file(dir.join("verify-truth.json"));
    std::fs::write(
        dir.join(SEGMENT).join("cursor.json"),
        serde_json::to_vec(&cursor_json())?,
    )?;
    let mut meta: Value = serde_json::from_slice(&std::fs::read(dir.join("recording-meta.json"))?)?;
    meta["segments"][0]["cursor"] = json!(format!("{SEGMENT}/cursor.json"));
    std::fs::write(
        dir.join("recording-meta.json"),
        serde_json::to_vec_pretty(&meta)?,
    )?;
    let config: Value = serde_json::from_slice(&std::fs::read(dir.join("project-config.json"))?)?;
    std::fs::write(
        dir.join("project-config.json"),
        serde_json::to_vec_pretty(&rich_config(&config))?,
    )?;
    Ok(dir)
}

pub fn edit_json(path: &Path, edit: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    edit(&mut value);
    std::fs::write(path, serde_json::to_vec_pretty(&value)?)?;
    Ok(())
}

pub type Mutation = Arc<dyn Fn(&Path) -> anyhow::Result<()> + Send + Sync>;

fn m(f: impl Fn(&Path) -> anyhow::Result<()> + Send + Sync + 'static) -> Mutation {
    Arc::new(f)
}

fn seg(file: &str) -> String {
    format!("{SEGMENT}/{file}")
}

fn zero(rel: String) -> Mutation {
    m(move |dir| Ok(std::fs::write(dir.join(&rel), b"")?))
}

fn truncate(rel: String, keep: f64) -> Mutation {
    m(move |dir| {
        let path = dir.join(&rel);
        let bytes = std::fs::read(&path)?;
        let n = (bytes.len() as f64 * keep) as usize;
        Ok(std::fs::write(&path, &bytes[..n.min(bytes.len())])?)
    })
}

fn truncate_to(rel: String, n: usize) -> Mutation {
    m(move |dir| {
        let path = dir.join(&rel);
        let bytes = std::fs::read(&path)?;
        Ok(std::fs::write(&path, &bytes[..n.min(bytes.len())])?)
    })
}

/// Overwrites `count` bytes from the middle third on with a pattern.
fn smash(rel: String, count: usize) -> Mutation {
    m(move |dir| {
        let path = dir.join(&rel);
        let mut bytes = std::fs::read(&path)?;
        let start = bytes.len() / 3;
        for (i, b) in bytes.iter_mut().skip(start).take(count).enumerate() {
            *b = (i as u8).wrapping_mul(97) ^ 0x5a;
        }
        Ok(std::fs::write(&path, bytes)?)
    })
}

/// Flips one byte in every `every` bytes past the first 64.
fn flip(rel: String, every: usize) -> Mutation {
    m(move |dir| {
        let path = dir.join(&rel);
        let mut bytes = std::fs::read(&path)?;
        for i in (64..bytes.len()).step_by(every) {
            bytes[i] ^= 0xff;
        }
        Ok(std::fs::write(&path, bytes)?)
    })
}

fn garbage(rel: String, n: usize) -> Mutation {
    m(move |dir| {
        let bytes: Vec<u8> = (0..n).map(|i| (i * 131 % 251) as u8).collect();
        Ok(std::fs::write(dir.join(&rel), bytes)?)
    })
}

fn remove(rel: String) -> Mutation {
    m(move |dir| Ok(std::fs::remove_file(dir.join(&rel))?))
}

fn replace_with_dir(rel: String) -> Mutation {
    m(move |dir| {
        let path = dir.join(&rel);
        std::fs::remove_file(&path)?;
        Ok(std::fs::create_dir_all(&path)?)
    })
}

fn swap(a: String, b: String) -> Mutation {
    m(move |dir| {
        let tmp = dir.join("swap.tmp");
        std::fs::rename(dir.join(&a), &tmp)?;
        std::fs::rename(dir.join(&b), dir.join(&a))?;
        Ok(std::fs::rename(&tmp, dir.join(&b))?)
    })
}

fn meta(edit: impl Fn(&mut Value) + Send + Sync + 'static) -> Mutation {
    m(move |dir| edit_json(&dir.join("recording-meta.json"), &edit))
}

fn config(edit: impl Fn(&mut Value) + Send + Sync + 'static) -> Mutation {
    m(move |dir| edit_json(&dir.join("project-config.json"), &edit))
}

fn cursor(value: Value) -> Mutation {
    m(move |dir| {
        Ok(std::fs::write(
            dir.join(seg("cursor.json")),
            serde_json::to_vec(&value)?,
        )?)
    })
}

fn timeline_segments(segments: Value) -> Mutation {
    config(move |c| c["timeline"]["segments"] = segments.clone())
}

fn first_segment(field: &'static str, value: Value) -> Mutation {
    config(move |c| c["timeline"]["segments"][0][field] = value.clone())
}

/// (name, mutation, whether a usable project remains, FULL only)
pub fn mutations() -> Vec<(&'static str, Mutation, bool, bool)> {
    let mut out: Vec<(&'static str, Mutation, bool, bool)> = vec![
        ("control", m(|_| Ok(())), true, false),
        ("display-zero-bytes", zero(seg("display.mp4")), false, false),
        (
            "display-truncated-half",
            truncate(seg("display.mp4"), 0.5),
            false,
            false,
        ),
        (
            "display-truncated-1k",
            truncate_to(seg("display.mp4"), 1024),
            false,
            false,
        ),
        (
            "display-smashed",
            smash(seg("display.mp4"), 4096),
            false,
            false,
        ),
        (
            "display-bitflips",
            flip(seg("display.mp4"), 97),
            false,
            false,
        ),
        (
            "display-garbage",
            garbage(seg("display.mp4"), 50_000),
            false,
            false,
        ),
        ("display-missing", remove(seg("display.mp4")), false, false),
        (
            "display-is-directory",
            replace_with_dir(seg("display.mp4")),
            false,
            false,
        ),
        (
            "display-is-audio",
            swap(seg("display.mp4"), seg("audio-input.ogg")),
            false,
            false,
        ),
        ("camera-zero-bytes", zero(seg("camera.mp4")), true, false),
        (
            "camera-truncated-half",
            truncate(seg("camera.mp4"), 0.5),
            true,
            false,
        ),
        (
            "camera-smashed",
            smash(seg("camera.mp4"), 4096),
            true,
            false,
        ),
        ("camera-missing", remove(seg("camera.mp4")), true, false),
        ("mic-zero-bytes", zero(seg("audio-input.ogg")), true, false),
        (
            "mic-truncated-half",
            truncate(seg("audio-input.ogg"), 0.5),
            true,
            false,
        ),
        (
            "mic-smashed",
            smash(seg("audio-input.ogg"), 2048),
            true,
            false,
        ),
        (
            "mic-garbage",
            garbage(seg("audio-input.ogg"), 9_000),
            true,
            false,
        ),
        ("mic-missing", remove(seg("audio-input.ogg")), true, false),
        (
            "system-audio-zero-bytes",
            zero(seg("system_audio.ogg")),
            true,
            false,
        ),
        (
            "system-audio-truncated",
            truncate_to(seg("system_audio.ogg"), 300),
            true,
            false,
        ),
        ("cursor-zero-bytes", zero(seg("cursor.json")), true, false),
        (
            "cursor-garbage",
            garbage(seg("cursor.json"), 3000),
            true,
            false,
        ),
        (
            "cursor-wrong-types",
            cursor(json!({ "clicks": "x", "moves": [1, 2, 3] })),
            true,
            false,
        ),
        (
            "cursor-hostile-values",
            cursor(json!({
                "clicks": [
                    { "active_modifiers": [], "cursor_num": 255, "cursor_id": "", "time_ms": -1e300, "down": true },
                    { "active_modifiers": [], "cursor_num": 0, "cursor_id": "99999999999", "time_ms": 1e300, "down": false }
                ],
                "moves": [
                    { "active_modifiers": ["\u{0}"], "cursor_id": "0", "time_ms": 500.0, "x": 1e300, "y": -1e300 },
                    { "active_modifiers": [], "cursor_id": "0", "time_ms": 100.0, "x": -5.0, "y": 7.0 },
                    { "active_modifiers": [], "cursor_id": "x", "time_ms": 100.0, "x": 0.5, "y": 0.5 },
                    { "active_modifiers": [], "cursor_id": "0", "time_ms": -1e300, "x": 0.5, "y": 0.5 }
                ]
            })),
            true,
            false,
        ),
        (
            "cursor-unsorted-duplicates",
            cursor(json!({
                "clicks": [],
                "moves": (0..200).map(|i| json!({
                    "active_modifiers": [], "cursor_id": format!("{}", i % 3),
                    "time_ms": f64::from((i * 7919) % 2000), "x": 0.5, "y": 0.5
                })).collect::<Vec<_>>()
            })),
            true,
            false,
        ),
        (
            "cursor-200k-moves",
            cursor(json!({
                "clicks": [],
                "moves": (0..200_000).map(|i| json!({
                    "active_modifiers": [], "cursor_id": "0",
                    "time_ms": f64::from(i) * 0.002, "x": 0.5, "y": 0.5
                })).collect::<Vec<_>>()
            })),
            true,
            true,
        ),
        (
            "meta-zero-bytes",
            zero("recording-meta.json".into()),
            false,
            false,
        ),
        (
            "meta-garbage",
            garbage("recording-meta.json".into(), 400),
            false,
            false,
        ),
        (
            "meta-missing",
            remove("recording-meta.json".into()),
            false,
            false,
        ),
        (
            "meta-wrong-types",
            meta(|v| v["segments"] = json!("segments")),
            false,
            false,
        ),
        (
            "meta-no-segments",
            meta(|v| v["segments"] = json!([])),
            false,
            false,
        ),
        (
            "meta-fps-0",
            meta(|v| v["segments"][0]["display"]["fps"] = json!(0)),
            true,
            false,
        ),
        (
            "meta-fps-huge",
            meta(|v| v["segments"][0]["display"]["fps"] = json!(u32::MAX)),
            true,
            false,
        ),
        (
            "meta-camera-fps-0",
            meta(|v| v["segments"][0]["camera"]["fps"] = json!(0)),
            true,
            false,
        ),
        (
            "meta-start-time-hostile",
            meta(|v| {
                v["segments"][0]["display"]["start_time"] = json!(-1e300);
                v["segments"][0]["camera"]["start_time"] = json!(1e300);
                v["segments"][0]["mic"]["start_time"] = json!(-3600.0);
                v["segments"][0]["system_audio"]["start_time"] = json!(1e-300);
            }),
            true,
            false,
        ),
        (
            "meta-path-escapes",
            meta(|v| v["segments"][0]["display"]["path"] = json!("../../../../../../etc/hosts")),
            false,
            false,
        ),
        (
            "meta-path-absolute",
            meta(|v| v["segments"][0]["camera"]["path"] = json!("/dev/zero")),
            true,
            false,
        ),
        (
            "meta-path-unicode",
            meta(|v| v["segments"][0]["mic"]["path"] = json!("content/\u{1F4A5}/\u{202E}mic.ogg")),
            true,
            false,
        ),
        (
            "meta-camera-is-display",
            meta(|v| v["segments"][0]["camera"]["path"] = json!(seg("display.mp4"))),
            true,
            false,
        ),
        (
            "meta-segments-duplicated",
            meta(|v| {
                let s = v["segments"][0].clone();
                v["segments"] = json!([s.clone(), s.clone(), s]);
            }),
            true,
            false,
        ),
        (
            "meta-single-segment-legacy",
            meta(|v| {
                let s = v["segments"][0].clone();
                *v = json!({
                    "platform": "MacOS",
                    "pretty_name": "chaos",
                    "sharing": null,
                    "display": s["display"],
                    "camera": s["camera"],
                    "audio": s["mic"],
                    "cursor": s["cursor"],
                });
            }),
            true,
            false,
        ),
        (
            "meta-single-segment-damaged-camera",
            meta(|v| {
                let s = v["segments"][0].clone();
                *v = json!({
                    "platform": "MacOS",
                    "pretty_name": "chaos",
                    "sharing": null,
                    "display": s["display"],
                    "camera": { "path": "content/segments/segment-0/missing-camera.mp4", "fps": 30 },
                    "audio": s["mic"],
                });
            }),
            true,
            false,
        ),
        (
            "meta-instant",
            meta(|v| {
                *v = json!({
                    "platform": "MacOS", "pretty_name": "chaos", "sharing": null,
                    "fps": 0, "sample_rate": 0
                });
            }),
            false,
            false,
        ),
        (
            "meta-status-failed",
            meta(|v| v["status"] = json!({ "status": "Failed", "error": "\u{0}" })),
            false,
            false,
        ),
        (
            "config-zero-bytes",
            zero("project-config.json".into()),
            true,
            false,
        ),
        (
            "config-garbage",
            garbage("project-config.json".into(), 700),
            true,
            false,
        ),
        (
            "config-missing",
            remove("project-config.json".into()),
            true,
            false,
        ),
        (
            "config-wrong-types",
            config(|c| c["timeline"] = json!([1, "two"])),
            true,
            false,
        ),
        ("timeline-empty", timeline_segments(json!([])), false, false),
        (
            "timeline-null",
            config(|c| c["timeline"] = Value::Null),
            true,
            false,
        ),
        (
            "timeline-clip-out-of-range",
            first_segment("recordingSegment", json!(99)),
            true,
            false,
        ),
        (
            "timeline-clip-huge",
            first_segment("recordingSegment", json!(u32::MAX)),
            true,
            false,
        ),
        (
            "timescale-0",
            first_segment("timescale", json!(0.0)),
            true,
            false,
        ),
        (
            "timescale-negative",
            first_segment("timescale", json!(-1.0)),
            true,
            false,
        ),
        (
            "timescale-huge",
            first_segment("timescale", json!(1e300)),
            true,
            false,
        ),
        (
            "timescale-tiny",
            first_segment("timescale", json!(1e-300)),
            true,
            false,
        ),
        (
            "segment-reversed",
            timeline_segments(
                json!([{ "recordingSegment": 0, "timescale": 1.0, "start": 1.5, "end": 0.5 }]),
            ),
            false,
            false,
        ),
        (
            "segment-zero-length",
            timeline_segments(json!([
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.5, "end": 0.5 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 1.0 }
            ])),
            true,
            false,
        ),
        (
            "segment-all-zero-length",
            timeline_segments(
                json!([{ "recordingSegment": 0, "timescale": 1.0, "start": 1.0, "end": 1.0 }]),
            ),
            false,
            false,
        ),
        (
            "segment-past-media",
            timeline_segments(
                json!([{ "recordingSegment": 0, "timescale": 1.0, "start": 1.0, "end": 9.0 }]),
            ),
            true,
            false,
        ),
        (
            "segment-negative-start",
            timeline_segments(
                json!([{ "recordingSegment": 0, "timescale": 1.0, "start": -5.0, "end": 1.0 }]),
            ),
            true,
            false,
        ),
        (
            "segment-huge-end",
            timeline_segments(
                json!([{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 1e300 }]),
            ),
            true,
            true,
        ),
        (
            "segments-overlapping",
            timeline_segments(json!([
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 1.5 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.5, "end": 1.0 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.2, "end": 1.9 }
            ])),
            true,
            false,
        ),
        (
            "transition-out-of-range",
            config(|c| {
                c["timeline"]["transitions"] =
                    json!([{ "segmentIndex": 99, "type": "cross-fade", "duration": 5.0 }])
            }),
            true,
            false,
        ),
        (
            "transition-hostile",
            config(|c| {
                c["timeline"]["transitions"] = json!([
                    { "segmentIndex": 0, "type": "fade-through-black", "duration": -1.0 },
                    { "segmentIndex": 1, "type": "cross-fade", "duration": 1e300 },
                    { "segmentIndex": 1, "type": "cross-fade", "duration": 0.0 }
                ])
            }),
            true,
            false,
        ),
        (
            "zoom-hostile",
            config(|c| {
                c["timeline"]["zoomSegments"] = json!([
                    { "start": 0.0, "end": 1.0, "amount": 0.0, "mode": "auto" },
                    { "start": 1.0, "end": 0.2, "amount": -3.0, "mode": "auto" },
                    { "start": 0.3, "end": 0.3, "amount": 1e300, "mode": { "manual": { "x": 1e300, "y": -1e300 } } },
                    { "start": -1e300, "end": 1e300, "amount": 1e-300, "mode": "auto", "glideSpeed": -1.0, "edgeSnapRatio": 1e300 }
                ])
            }),
            true,
            false,
        ),
        (
            "scene-hostile",
            config(|c| {
                c["timeline"]["sceneSegments"] = json!([
                    { "start": 1.0, "end": 0.0, "mode": "cameraOnly", "transitionIn": -1.0, "transitionOut": 1e300 },
                    { "start": 0.0, "end": 1e300, "mode": "hideCamera" }
                ])
            }),
            true,
            false,
        ),
        (
            "mask-hostile",
            config(|c| {
                c["timeline"]["maskSegments"] = json!([{
                    "start": 0.0, "end": 2.0, "track": u32::MAX, "maskType": "sensitive",
                    "center": { "x": 1e300, "y": -1e300 }, "size": { "x": 0.0, "y": -1.0 },
                    "feather": 1e300, "opacity": -5.0, "pixelation": 0.0, "darkness": 1e300,
                    "fadeDuration": -1.0
                }, {
                    "start": 0.0, "end": 2.0, "maskType": "highlight",
                    "center": { "x": 0.5, "y": 0.5 }, "size": { "x": 1e300, "y": 1e300 },
                    "pixelation": 1e300
                }])
            }),
            true,
            false,
        ),
        (
            "text-hostile",
            config(|c| {
                c["timeline"]["textSegments"] = json!([
                    { "start": 0.0, "end": 2.0, "content": "\u{0}\u{202E}\u{1F4A5}".repeat(200), "fontSize": 1e30, "fontWeight": -1.0, "size": { "x": 0.0, "y": 0.0 } },
                    { "start": 0.0, "end": 2.0, "content": "", "fontSize": 0.0, "fontFamily": "\u{0}", "color": "not-a-colour" },
                    { "start": 0.0, "end": 2.0, "content": "x", "center": { "x": 1e300, "y": -1e300 }, "size": { "x": 1e300, "y": 1e300 }, "track": u32::MAX }
                ])
            }),
            true,
            false,
        ),
        (
            "captions-hostile",
            config(|c| {
                c["captions"] = json!({
                    "segments": [
                        { "id": "", "start": -1.0, "end": 1e30, "text": "\u{1F4A5}".repeat(5000) },
                        { "id": "b", "start": 1.0, "end": 0.0, "text": "", "words": [{ "text": "w", "start": 5.0, "end": -5.0 }] }
                    ],
                    "settings": { "enabled": true, "size": 0, "fontSize": 4294967295u64, "font": "\u{0}" }
                });
                c["timeline"]["captionSegments"] = json!([
                    { "id": "x", "start": 1e30, "end": -1e30, "text": "\u{202E}" }
                ]);
            }),
            true,
            false,
        ),
        (
            "keyboard-hostile",
            config(|c| {
                c["timeline"]["keyboardSegments"] = json!([{
                    "id": "k", "start": 1.0, "end": 0.0, "displayText": "\u{1F4A5}".repeat(3000),
                    "keys": [{ "key": "", "timeOffset": -1e300 }, { "key": "z", "timeOffset": 1e300 }]
                }])
            }),
            true,
            false,
        ),
        (
            "clips-hostile",
            config(|c| {
                c["clips"] = json!([
                    { "index": 99, "offsets": { "camera": 1e300, "mic": -1e300, "system_audio": 0.0 } },
                    { "index": 0, "offsets": { "camera": -1e300, "mic": 1e300, "system_audio": -1e300 } },
                    { "index": 0, "offsets": {} }
                ])
            }),
            true,
            false,
        ),
        (
            "background-hostile",
            config(|c| {
                let b = &mut c["background"];
                b["padding"] = json!(1e300);
                b["rounding"] = json!(-1e300);
                b["blur"] = json!(1e300);
                b["inset"] = json!(4294967295u64);
                b["shadow"] = json!(-1.0);
                b["crop"] = json!({ "position": { "x": 4294967295u64, "y": 0 }, "size": { "x": 0, "y": 0 } });
            }),
            true,
            false,
        ),
        (
            "camera-hostile",
            config(|c| {
                let cam = &mut c["camera"];
                cam["size"] = json!(0.0);
                cam["zoomSize"] = json!(1e300);
                cam["rounding"] = json!(-1e300);
                cam["scaleDuringZoom"] = json!(-1.0);
                cam["manualPosition"] = json!({ "x": 1e300, "y": -1e300 });
            }),
            true,
            false,
        ),
        (
            "cursor-config-hostile",
            config(|c| {
                let cur = &mut c["cursor"];
                cur["size"] = json!(0);
                cur["tension"] = json!(-1e300);
                cur["mass"] = json!(0.0);
                cur["friction"] = json!(1e300);
                cur["motionBlur"] = json!(1e300);
                cur["hideWhenIdleDelay"] = json!(-1.0);
                cur["hideWhenIdle"] = json!(true);
                cur["rotationAmount"] = json!(1e300);
                cur["stopMovementInLastSeconds"] = json!(-1e300);
            }),
            true,
            false,
        ),
        (
            "motion-hostile",
            config(|c| {
                c["screenMotionBlur"] = json!(1e30);
                c["screenMovementSpring"] =
                    json!({ "stiffness": 0.0, "damping": -1e300, "mass": 0.0 });
            }),
            true,
            false,
        ),
        (
            "audio-config-hostile",
            config(|c| {
                c["audio"]["micVolumeDb"] = json!(1e30);
                c["audio"]["systemVolumeDb"] = json!(-1e30);
                c["timeline"]["segments"][0]["volume"] = json!(-1e300);
            }),
            true,
            false,
        ),
        (
            "annotations-hostile",
            config(|c| {
                c["annotations"] = json!([
                    { "id": "", "type": "draw", "x": 1e300, "y": -1e300, "width": -1.0, "height": 0.0,
                      "strokeColor": "", "strokeWidth": 1e300, "fillColor": "#zz", "opacity": -1.0,
                      "rotation": 1e300, "text": null, "points": [] },
                    { "id": "m", "type": "mask", "x": 0.0, "y": 0.0, "width": 1e300, "height": 1e300,
                      "strokeColor": "#000", "strokeWidth": 0.0, "fillColor": "#000", "opacity": 1.0,
                      "rotation": 0.0, "text": null, "maskType": "pixelate", "maskLevel": 0.0 }
                ])
            }),
            true,
            false,
        ),
        (
            "style-image-hostile",
            config(|c| {
                c["timeline"]["imageSegments"] = json!([
                    { "start": 0.0, "end": 2.0, "path": "/dev/zero", "size": { "x": 1e300, "y": 0.0 }, "opacity": -1.0, "rotation": 1e30 },
                    { "start": 0.0, "end": 2.0, "path": "../../../../etc/passwd" },
                    { "start": 0.0, "end": 2.0, "path": "recording-meta.json" }
                ]);
                c["timeline"]["styleSegments"] = json!([
                    { "start": 1.0, "end": 0.0, "overrides": { "background": { "padding": 1e300 } } }
                ]);
            }),
            true,
            false,
        ),
        (
            "camera3d-hostile",
            config(|c| {
                c["timeline"]["camera3dSegments"] = json!([{
                    "start": 0.0, "end": 2.0,
                    "properties": { "tiltX": 1e300, "tiltY": -1e300, "zoom": 0.0, "fov": 0.0, "panX": 1e300, "rotateX": 90.0 }
                }])
            }),
            true,
            false,
        ),
        (
            "aspect-and-unicode",
            config(|c| {
                c["aspectRatio"] = json!("square");
                c["timeline"]["segments"][0]["name"] = json!("\u{0}\u{202E}\u{1F4A5}".repeat(1000));
            }),
            true,
            false,
        ),
    ];
    let deep = m(|dir| {
        let mut text = String::new();
        for _ in 0..100_000 {
            text.push('[');
        }
        Ok(std::fs::write(dir.join("project-config.json"), text)?)
    });
    out.push(("config-deeply-nested", deep, true, false));
    out
}

/// The app's editor preflight (`editor_window::preflight`): heal, load the
/// meta, open every track, load the configuration and walk its timeline.
pub fn open(dir: &Path) -> anyhow::Result<Verdict> {
    let _ = cap_recording::track_heal::heal_stretched_tracks(dir);
    let meta = match RecordingMeta::load_for_project(dir) {
        Ok(meta) => meta,
        Err(e) => return Ok(Verdict::rejected(format!("meta: {e}"))),
    };
    let Some(studio) = meta.studio_meta() else {
        return Ok(Verdict::rejected("not a studio recording"));
    };
    let recordings = match cap_rendering::ProjectRecordingsMeta::new(&dir.to_path_buf(), studio) {
        Ok(r) => r,
        Err(e) => return Ok(Verdict::rejected(format!("recordings: {e}"))),
    };
    let config = meta.project_config();
    let duration = config
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or_else(|| recordings.duration());
    let mut mapped = 0;
    if let Some(timeline) = &config.timeline {
        for i in 0..=40 {
            let t = duration * f64::from(i) / 40.0;
            if timeline.get_frame_mapping(t).is_some() {
                mapped += 1;
            }
            let _ = config.get_segment_time(t);
        }
    }
    Ok(Verdict::Ok(format!(
        "duration {duration:.3}, {mapped} of 41 times mapped"
    )))
}

const PREVIEW_FRAMES: [u32; 6] = [0, 1, 29, 59, 10_000, u32::MAX];

// The scripted sequence below takes about 2.3 s. On a loaded macOS runner the
// first decode can miss its 2 s deadline (crates/rendering/src/decoder) and
// leave the sequence without a frame, so a usable project that has delivered
// nothing yet gets the same preview requests again until a frame lands or
// this deadline passes. A project that never delivers still fails, only later.
const FIRST_FRAME_DEADLINE: Duration = Duration::from_secs(25);
const FIRST_FRAME_RETRY: Duration = Duration::from_secs(1);

/// The editor: `EditorInstance` (decoders, renderer, offline audio), preview
/// frames at hostile positions, playback, seeks, stop and dispose.
pub async fn editor(dir: &Path, expect_frames: bool) -> anyhow::Result<Verdict> {
    let (delivered, frames) = tokio::sync::watch::channel(0usize);
    let (audio, _sink) = cap_editor::AudioOutput::new_offline();
    let instance = match cap_editor::EditorInstance::new_with_audio_output(
        dir.to_path_buf(),
        |_| {},
        Box::new(move |_, _| delivered.send_modify(|n| *n += 1)),
        None,
        Arc::new(audio),
    )
    .await
    {
        Ok(instance) => instance,
        Err(e) => return Ok(Verdict::rejected(format!("editor: {e}"))),
    };
    let resolution = XY::new(320, 180);
    for frame in PREVIEW_FRAMES {
        let _ = instance.preview_tx.send(Some((frame, 30, resolution)));
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let _ = instance.preview_tx.send(Some((10, 0, XY::new(0, 0))));
    tokio::time::sleep(Duration::from_millis(150)).await;
    instance.start_playback(30, resolution).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    for frame in [15, 0, 59, 100_000, 3] {
        instance.seek_playback(frame).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    if expect_frames && *frames.borrow() == 0 {
        await_first_frame(&instance, frames.clone(), resolution).await;
    }
    instance.dispose().await;
    let n = *frames.borrow();
    Ok(if n == 0 && expect_frames {
        Verdict::Wrong(format!(
            "the editor opened but delivered no frame within {} s",
            FIRST_FRAME_DEADLINE.as_secs()
        ))
    } else {
        Verdict::Ok(format!("{n} frames delivered"))
    })
}

async fn await_first_frame(
    instance: &cap_editor::EditorInstance,
    mut frames: tokio::sync::watch::Receiver<usize>,
    resolution: XY<u32>,
) {
    let mut playing = instance.playback_watch();
    let requests = async {
        for &frame in PREVIEW_FRAMES.iter().cycle() {
            if playing.wait_for(|active| !*active).await.is_err() {
                break;
            }
            let _ = instance.preview_tx.send(Some((frame, 30, resolution)));
            tokio::time::sleep(FIRST_FRAME_RETRY).await;
        }
        std::future::pending::<()>().await;
    };
    let _ = tokio::time::timeout(FIRST_FRAME_DEADLINE, async {
        tokio::select! {
            _ = frames.wait_for(|n| *n > 0) => {}
            () = requests => {}
        }
    })
    .await;
}

#[derive(Clone, Copy, Debug)]
pub enum Format {
    Mp4 { bpp: Option<f32> },
    Gif,
    Mov { cursor_only: bool },
}

pub async fn export(
    dir: &Path,
    out: &Path,
    format: Format,
    fps: u32,
    resolution: (u32, u32),
) -> anyhow::Result<Verdict> {
    let base = match cap_export::ExporterBase::builder(dir.to_path_buf())
        .with_output_path(out.to_path_buf())
        .build()
        .await
    {
        Ok(base) => base,
        Err(e) => return Ok(Verdict::rejected(format!("exporter: {e}"))),
    };
    let resolution_base = XY::new(resolution.0, resolution.1);
    let result = match format {
        Format::Mp4 { bpp } => {
            cap_export::mp4::Mp4ExportSettings {
                fps,
                resolution_base,
                compression: cap_export::mp4::ExportCompression::Potato,
                custom_bpp: bpp,
                force_ffmpeg_decoder: false,
                optimize_filesize: false,
            }
            .export(base, |_| true)
            .await
        }
        Format::Gif => {
            cap_export::gif::GifExportSettings {
                fps,
                resolution_base,
                quality: None,
            }
            .export(base, |_| true)
            .await
        }
        Format::Mov { cursor_only } => {
            cap_export::mov::MovExportSettings {
                fps,
                resolution_base,
                cursor_only,
            }
            .export(base, |_| true)
            .await
        }
    };
    match result {
        Ok(path) => Ok(judge_export(&path, format)),
        Err(e) => Ok(Verdict::rejected(format!("export: {e}"))),
    }
}

/// An export that reports success must have written playable media, however
/// damaged its input was: rejecting is fine, an empty file is not.
fn judge_export(path: &Path, format: Format) -> Verdict {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Verdict::Wrong(format!(
            "export reported success with an empty file {}",
            path.display()
        ));
    }
    match format {
        Format::Gif => Verdict::Ok(format!("{size} bytes")),
        _ => super::media_check::judge_output(path, true),
    }
}

fn file_probes(out: &mut Vec<Probe>) {
    for (name, mutation, usable, full) in mutations() {
        for engine in ["open", "editor", "export"] {
            let mutation = mutation.clone();
            let probe = Probe::new(
                format!("chaos/files/{name}/{engine}"),
                if engine == "open" { 45 } else { 90 },
                move |ctx: &Ctx| {
                    let dir = prepare(ctx).context("prepare project")?;
                    mutation(&dir).context("mutate project")?;
                    match engine {
                        "open" => open(&dir),
                        "editor" => ctx.block_on(editor(&dir, usable)),
                        _ => ctx.block_on(export(
                            &dir,
                            &ctx.path("out.mp4"),
                            Format::Mp4 { bpp: None },
                            10,
                            (320, 180),
                        )),
                    }
                },
            );
            let editor_full = engine == "editor" && !FAST_EDITOR.contains(&name);
            out.push(if full || editor_full {
                probe.full()
            } else {
                probe
            });
        }
    }
}

/// Mutations the editor runs in the FAST tier; FULL opens every mutation.
const FAST_EDITOR: &[&str] = &[
    "control",
    "display-zero-bytes",
    "display-smashed",
    "camera-missing",
    "mic-garbage",
    "cursor-hostile-values",
    "meta-fps-0",
    "meta-fps-huge",
    "meta-start-time-hostile",
    "meta-single-segment-damaged-camera",
    "timeline-empty",
    "timeline-clip-out-of-range",
    "timescale-0",
    "timescale-tiny",
    "segment-reversed",
    "zoom-hostile",
    "mask-hostile",
    "text-hostile",
    "captions-hostile",
    "background-hostile",
];

/// (name, format, fps, resolution, FULL only)
type ExportCase = (&'static str, Format, u32, (u32, u32), bool);

fn export_probes(out: &mut Vec<Probe>) {
    let cases: Vec<ExportCase> = vec![
        (
            "mp4/control",
            Format::Mp4 { bpp: None },
            10,
            (320, 180),
            false,
        ),
        (
            "mp4/resolution-0x0",
            Format::Mp4 { bpp: None },
            10,
            (0, 0),
            false,
        ),
        (
            "mp4/resolution-1x1",
            Format::Mp4 { bpp: None },
            10,
            (1, 1),
            false,
        ),
        (
            "mp4/resolution-3x3",
            Format::Mp4 { bpp: None },
            10,
            (3, 3),
            false,
        ),
        (
            "mp4/resolution-odd",
            Format::Mp4 { bpp: None },
            10,
            (641, 361),
            false,
        ),
        (
            "mp4/resolution-tall",
            Format::Mp4 { bpp: None },
            10,
            (2, 4000),
            false,
        ),
        (
            "mp4/resolution-16384",
            Format::Mp4 { bpp: None },
            1,
            (16384, 16384),
            true,
        ),
        (
            "mp4/resolution-max",
            Format::Mp4 { bpp: None },
            1,
            (u32::MAX, u32::MAX),
            false,
        ),
        ("mp4/fps-0", Format::Mp4 { bpp: None }, 0, (320, 180), false),
        ("mp4/fps-1", Format::Mp4 { bpp: None }, 1, (320, 180), false),
        (
            "mp4/fps-240",
            Format::Mp4 { bpp: None },
            240,
            (320, 180),
            false,
        ),
        (
            "mp4/fps-max",
            Format::Mp4 { bpp: None },
            u32::MAX,
            (320, 180),
            true,
        ),
        (
            "mp4/bpp-nan",
            Format::Mp4 {
                bpp: Some(f32::NAN),
            },
            10,
            (320, 180),
            false,
        ),
        (
            "mp4/bpp-negative",
            Format::Mp4 { bpp: Some(-1.0) },
            10,
            (320, 180),
            false,
        ),
        (
            "mp4/bpp-inf",
            Format::Mp4 {
                bpp: Some(f32::INFINITY),
            },
            10,
            (320, 180),
            false,
        ),
        (
            "mp4/bpp-zero",
            Format::Mp4 { bpp: Some(0.0) },
            10,
            (320, 180),
            false,
        ),
        ("gif/control", Format::Gif, 10, (320, 180), false),
        ("gif/resolution-0x0", Format::Gif, 10, (0, 0), false),
        ("gif/resolution-1x1", Format::Gif, 10, (1, 1), false),
        ("gif/fps-0", Format::Gif, 0, (320, 180), false),
        ("gif/fps-240", Format::Gif, 240, (160, 90), true),
        (
            "mov/control",
            Format::Mov { cursor_only: false },
            10,
            (320, 180),
            false,
        ),
        (
            "mov/cursor-only",
            Format::Mov { cursor_only: true },
            10,
            (320, 180),
            false,
        ),
        (
            "mov/resolution-0x0",
            Format::Mov { cursor_only: false },
            10,
            (0, 0),
            false,
        ),
        (
            "mov/fps-0",
            Format::Mov { cursor_only: true },
            0,
            (320, 180),
            false,
        ),
    ];
    for (name, format, fps, resolution, full) in cases {
        let probe = Probe::new(format!("chaos/export/{name}"), 120, move |ctx: &Ctx| {
            let dir = prepare(ctx)?;
            let ext = match format {
                Format::Gif => "gif",
                Format::Mov { .. } => "mov",
                Format::Mp4 { .. } => "mp4",
            };
            ctx.block_on(export(
                &dir,
                &ctx.path(&format!("out.{ext}")),
                format,
                fps,
                resolution,
            ))
        });
        out.push(if full { probe.full() } else { probe });
    }
}

type Poison = fn(&mut cap_project::ProjectConfiguration, f64);

/// Non-finite values the editor's own arithmetic can hand the renderer and
/// exporter in memory (JSON cannot carry NaN).
fn poisons() -> Vec<(&'static str, Poison)> {
    fn timeline(
        c: &mut cap_project::ProjectConfiguration,
    ) -> &mut cap_project::TimelineConfiguration {
        c.timeline.as_mut().expect("rich config has a timeline")
    }
    vec![
        ("timescale", |c, v| timeline(c).segments[0].timescale = v),
        ("segment-start", |c, v| timeline(c).segments[1].start = v),
        ("segment-end", |c, v| timeline(c).segments[0].end = v),
        ("zoom-amount", |c, v| {
            timeline(c).zoom_segments[0].amount = v
        }),
        ("zoom-start", |c, v| timeline(c).zoom_segments[1].start = v),
        ("transition-duration", |c, v| {
            timeline(c).transitions[0].duration = v
        }),
        ("scene-transition", |c, v| {
            timeline(c).scene_segments[0].transition_in = v
        }),
        ("mask-center", |c, v| {
            timeline(c).mask_segments[0].center.x = v
        }),
        ("text-font-size", |c, v| {
            timeline(c).text_segments[0].font_size = v as f32
        }),
        ("caption-start", |c, v| {
            timeline(c).caption_segments[0].start = v
        }),
        ("clip-offset", |c, v| c.clips[0].offsets.camera = v as f32),
        ("background-padding", |c, v| c.background.padding = v),
        ("background-rounding", |c, v| c.background.rounding = v),
        ("camera-size", |c, v| c.camera.size = v as f32),
        ("cursor-tension", |c, v| c.cursor.tension = v as f32),
        ("cursor-motion-blur", |c, v| c.cursor.motion_blur = v as f32),
        ("screen-motion-blur", |c, v| c.screen_motion_blur = v as f32),
    ]
}

fn poisoned_config(
    dir: &Path,
    poison: Poison,
    value: f64,
) -> anyhow::Result<cap_project::ProjectConfiguration> {
    let meta = RecordingMeta::load_for_project(dir).map_err(|e| anyhow::anyhow!("meta: {e}"))?;
    let mut config = meta.project_config();
    poison(&mut config, value);
    Ok(config)
}

async fn export_config(
    dir: &Path,
    out: &Path,
    config: cap_project::ProjectConfiguration,
) -> anyhow::Result<Verdict> {
    let base = match cap_export::ExporterBase::builder(dir.to_path_buf())
        .with_config(config)
        .with_output_path(out.to_path_buf())
        .build()
        .await
    {
        Ok(base) => base,
        Err(e) => return Ok(Verdict::rejected(format!("exporter: {e}"))),
    };
    match (cap_export::mp4::Mp4ExportSettings {
        fps: 10,
        resolution_base: XY::new(160, 90),
        compression: cap_export::mp4::ExportCompression::Potato,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    })
    .export(base, |_| true)
    .await
    {
        Ok(path) => Ok(judge_export(&path, Format::Mp4 { bpp: None })),
        Err(e) => Ok(Verdict::rejected(format!("export: {e}"))),
    }
}

/// The editor with a poisoned configuration pushed in memory, as the
/// editor UI does on every edit, then preview frames and playback.
async fn editor_config(
    dir: &Path,
    config: cap_project::ProjectConfiguration,
) -> anyhow::Result<Verdict> {
    let (audio, _sink) = cap_editor::AudioOutput::new_offline();
    let instance = match cap_editor::EditorInstance::new_with_audio_output(
        dir.to_path_buf(),
        |_| {},
        Box::new(|_, _| {}),
        None,
        Arc::new(audio),
    )
    .await
    {
        Ok(instance) => instance,
        Err(e) => return Ok(Verdict::rejected(format!("editor: {e}"))),
    };
    let _ = instance.project_config.0.send(config);
    for frame in [0, 7, 15, 30, 45] {
        let _ = instance
            .preview_tx
            .send(Some((frame, 30, XY::new(320, 180))));
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    instance.start_playback(30, XY::new(320, 180)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    instance.seek_playback(20).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    instance.dispose().await;
    Ok(Verdict::Ok("editor survived".into()))
}

fn poison_probes(out: &mut Vec<Probe>) {
    for (name, poison) in poisons() {
        for (value_name, value) in [
            ("nan", f64::NAN),
            ("inf", f64::INFINITY),
            ("neg-inf", f64::NEG_INFINITY),
        ] {
            let export = Probe::new(
                format!("chaos/export/poison/{name}/{value_name}"),
                90,
                move |ctx: &Ctx| {
                    let dir = prepare(ctx)?;
                    let config = poisoned_config(&dir, poison, value)?;
                    ctx.block_on(export_config(&dir, &ctx.path("out.mp4"), config))
                },
            );
            let fast = value_name == "nan"
                || matches!(
                    (name, value_name),
                    ("segment-end", "inf")
                        | ("segment-start", "neg-inf")
                        | ("clip-offset", "inf")
                        | ("background-padding", "inf")
                );
            out.push(if fast { export } else { export.full() });
            let probe = Probe::new(
                format!("chaos/editor/poison/{name}/{value_name}"),
                90,
                move |ctx: &Ctx| {
                    let dir = prepare(ctx)?;
                    let config = poisoned_config(&dir, poison, value)?;
                    ctx.block_on(editor_config(&dir, config))
                },
            );
            let fast = value_name == "nan"
                && matches!(
                    name,
                    "timescale" | "segment-end" | "zoom-amount" | "background-padding"
                );
            out.push(if fast { probe } else { probe.full() });
        }
    }
}

pub fn probes() -> Vec<Probe> {
    let mut out = Vec::new();
    file_probes(&mut out);
    export_probes(&mut out);
    poison_probes(&mut out);
    out
}
