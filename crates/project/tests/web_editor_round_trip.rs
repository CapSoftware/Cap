// The fixture is the old web editor's output (every timeline track it writes,
// waveform overlays, a hidden display and a waveform in the overlay order),
// serialized by the `cap-project` that editor shipped with.

use cap_project::{
    OverlayTrack, OverlayTrackKind, ProjectConfiguration, WaveformSource, WaveformStyle,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/web-editor-project-config.json");

fn leaves(value: &Value, path: String, out: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                leaves(child, format!("{path}/{key}"), out);
            }
        }
        Value::Array(items) if !items.is_empty() => {
            for (index, child) in items.iter().enumerate() {
                leaves(child, format!("{path}/{index}"), out);
            }
        }
        _ => out.push((path, value.clone())),
    }
}

fn same(left: &Value, right: &Value) -> bool {
    match (left.as_f64(), right.as_f64()) {
        (Some(left), Some(right)) => (left - right).abs() <= 1e-6 * left.abs().max(1.0),
        _ => left == right,
    }
}

#[test]
fn web_editor_project_round_trips_without_losing_fields() {
    let saved: Value = serde_json::from_str(FIXTURE).unwrap();
    let config: ProjectConfiguration = serde_json::from_str(FIXTURE).unwrap();
    let written = serde_json::to_value(&config).unwrap();

    let mut saved_leaves = Vec::new();
    leaves(&saved, String::new(), &mut saved_leaves);
    let lost: Vec<_> = saved_leaves
        .iter()
        .filter(|(path, value)| {
            written
                .pointer(path)
                .is_none_or(|written| !same(value, written))
        })
        .map(|(path, value)| format!("{path} = {value} -> {:?}", written.pointer(path)))
        .collect();
    assert!(
        lost.is_empty(),
        "changed on round trip:\n{}",
        lost.join("\n")
    );

    let again: ProjectConfiguration = serde_json::from_value(written.clone()).unwrap();
    assert_eq!(serde_json::to_value(&again).unwrap(), written);
}

#[test]
fn web_editor_fields_reach_the_renderer_model() {
    let config: ProjectConfiguration = serde_json::from_str(FIXTURE).unwrap();
    assert!(config.hide_display);
    let timeline = config.timeline.as_ref().unwrap();
    let waveform = &timeline.waveform_segments[0];
    assert_eq!(waveform.style, WaveformStyle::Bars);
    assert_eq!(waveform.source, WaveformSource::Mic);
    assert_eq!(waveform.bar_count, 48);
    assert_eq!(waveform.track, 2);
    assert_eq!(timeline.audio_segments[0].volume_db, -12.0);
    assert_eq!(timeline.transitions.len(), 1);
    assert_eq!(
        config.overlay_tracks().first(),
        Some(&OverlayTrack {
            kind: OverlayTrackKind::Waveform,
            track: 2,
        })
    );
}

#[test]
fn projects_without_web_editor_fields_serialize_as_before() {
    let config = ProjectConfiguration::default();
    let json = serde_json::to_value(&config).unwrap();
    assert!(json.get("hideDisplay").is_none());
    let timeline: cap_project::TimelineConfiguration = serde_json::from_value(serde_json::json!({
        "segments": [{ "timescale": 1.0, "start": 0.0, "end": 4.0 }],
        "zoomSegments": []
    }))
    .unwrap();
    assert!(timeline.waveform_segments.is_empty());
    let json = serde_json::to_value(&timeline).unwrap();
    assert!(json.get("waveformSegments").is_none());
}
