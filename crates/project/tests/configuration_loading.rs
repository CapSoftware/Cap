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
