use cap_project::ProjectConfiguration;
use serde_json::json;

#[test]
fn loading_sorts_scenes_without_changing_clip_edits() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 1, "start": 20.0, "end": 22.0, "timescale": 0.25, "name": "Opening", "volume": 0.5 },
                    { "recordingSegment": 0, "start": 10.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 0, "start": 0.0, "end": 32.0, "timescale": 8.0 }
                ],
                "zoomSegments": [],
                "sceneSegments": [
                    { "start": 8.0, "end": 10.0, "mode": "cameraOnly" },
                    { "start": 1.0, "end": 3.0, "mode": "cameraOnly" },
                    { "start": 5.0, "end": 7.0, "mode": "hideCamera" }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let loaded = ProjectConfiguration::load(project.path()).unwrap();
    loaded.write(project.path()).unwrap();
    let reloaded = ProjectConfiguration::load(project.path()).unwrap();
    for config in [&loaded, &reloaded] {
        let timeline = config.timeline.as_ref().unwrap();
        assert_eq!(
            timeline
                .scene_segments
                .iter()
                .map(|scene| scene.start)
                .collect::<Vec<_>>(),
            [1.0, 5.0, 8.0]
        );
        assert_eq!(timeline.duration(), 12.0);
        let (source_time, clip) = timeline.get_segment_time(0.0).unwrap();
        assert_eq!((source_time, clip.recording_clip), (20.0, 1));
        assert_eq!(clip.name.as_deref(), Some("Opening"));
        assert_eq!(clip.volume(), 0.5);
        let (source_time, clip) = timeline.get_segment_time(9.0).unwrap();
        assert_eq!((source_time, clip.recording_clip), (8.0, 0));
        assert_eq!(timeline.segments.len(), 3);
        assert_eq!(timeline.segments[1].duration(), 0.0);
    }
}

/// Every value in `saved` is kept as is in `loaded`; returns the keys `loaded`
/// has that `saved` does not.
fn added_keys(saved: &serde_json::Value, loaded: &serde_json::Value, path: &str) -> Vec<String> {
    match (saved, loaded) {
        (serde_json::Value::Object(saved), serde_json::Value::Object(loaded)) => {
            let mut added = Vec::new();
            for (key, value) in saved {
                let child = format!("{path}.{key}");
                let next = loaded
                    .get(key)
                    .unwrap_or_else(|| panic!("{child} was dropped"));
                added.extend(added_keys(value, next, &child));
            }
            added.extend(
                loaded
                    .keys()
                    .filter(|key| !saved.contains_key(*key))
                    .map(|key| format!("{path}.{key}")),
            );
            added
        }
        (serde_json::Value::Array(saved), serde_json::Value::Array(loaded)) => {
            assert_eq!(saved.len(), loaded.len(), "{path} changed length");
            saved
                .iter()
                .zip(loaded)
                .enumerate()
                .flat_map(|(index, (saved, loaded))| {
                    added_keys(saved, loaded, &format!("{path}[{index}]"))
                })
                .collect()
        }
        // serde_json's default float parsing can land one ulp off the text.
        (serde_json::Value::Number(saved), serde_json::Value::Number(loaded)) => {
            let (saved, loaded) = (saved.as_f64().unwrap(), loaded.as_f64().unwrap());
            assert!(
                (saved - loaded).abs() <= saved.abs() * 1e-12,
                "{path} changed: {saved} -> {loaded}"
            );
            Vec::new()
        }
        _ => {
            assert_eq!(saved, loaded, "{path} changed");
            Vec::new()
        }
    }
}

#[test]
fn a_project_saved_before_keycaps_and_input_sounds_loads_and_saves_unchanged() {
    let saved: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/saved-before-keycaps.project-config.json"
    ))
    .unwrap();
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("project-config.json"),
        serde_json::to_vec_pretty(&saved).unwrap(),
    )
    .unwrap();

    let loaded = ProjectConfiguration::load(project.path()).unwrap();
    let value = serde_json::to_value(&loaded).unwrap();
    let mut added = added_keys(&saved, &value, "");
    added.sort();
    assert_eq!(
        added,
        [
            ".background.source.config.ditherSize",
            ".background.source.config.style",
            ".cursor.clickSoundType",
            ".cursor.clickSoundVolume",
            ".cursor.clickSounds",
            ".keyboard.settings.keySoundType",
            ".keyboard.settings.keySoundVolume",
            ".keyboard.settings.keySounds",
            ".keyboard.settings.showTyping",
            ".keyboard.settings.style",
            ".keyboard.settings.theme",
            ".keyboard.settings.typingSplit",
        ]
    );
    assert_eq!(value["background"]["source"]["config"]["style"], "smooth");
    assert_eq!(value["keyboard"]["settings"]["style"], "auto");
    assert_eq!(value["keyboard"]["settings"]["showTyping"], true);
    assert_eq!(value["keyboard"]["settings"]["keySounds"], false);
    assert_eq!(value["cursor"]["clickSounds"], false);

    loaded.write(project.path()).unwrap();
    let reloaded = ProjectConfiguration::load(project.path()).unwrap();
    assert_eq!(serde_json::to_value(&reloaded).unwrap(), value);
}
