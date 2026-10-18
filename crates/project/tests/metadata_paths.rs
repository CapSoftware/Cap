use cap_project::{RecordingMeta, StudioRecordingMeta};
use relative_path::RelativePathBuf;
use serde_json::json;

fn load_project(metadata: serde_json::Value, paths: &[&str]) -> (tempfile::TempDir, RecordingMeta) {
    let project = tempfile::tempdir().unwrap();
    for path in paths {
        let path = project.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"recorded data").unwrap();
    }
    std::fs::write(
        project.path().join("recording-meta.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    let meta = RecordingMeta::load_for_project(project.path()).unwrap();
    (project, meta)
}

fn assert_path(meta: &RecordingMeta, path: &RelativePathBuf, expected: &str) {
    assert_eq!(path.as_str(), expected);
    assert_eq!(std::fs::read(meta.path(path)).unwrap(), b"recorded data");
}

#[test]
fn single_segment_paths_resolve_with_either_separator() {
    let paths = [
        "content/display.mp4",
        "content/camera.mp4",
        "content/audio-input.mp3",
        "content/cursor.json",
    ];
    for separator in ["/", "\\"] {
        let input = paths.map(|path| path.replace('/', separator));
        let (_project, meta) = load_project(
            json!({
                "pretty_name": "Legacy recording",
                "display": {"path": input[0]},
                "camera": {"path": input[1]},
                "audio": {"path": input[2]},
                "cursor": input[3],
                "segments": [{"start": 0.0, "end": 1.0}]
            }),
            &paths,
        );
        let StudioRecordingMeta::SingleSegment { segment } = meta.studio_meta().unwrap() else {
            panic!("expected single segment");
        };
        assert_path(&meta, &segment.display.path, paths[0]);
        assert_path(&meta, &segment.camera.as_ref().unwrap().path, paths[1]);
        assert_path(&meta, &segment.audio.as_ref().unwrap().path, paths[2]);
        assert_path(&meta, segment.cursor.as_ref().unwrap(), paths[3]);
    }
}

#[test]
fn multiple_segment_paths_resolve_with_either_separator() {
    let paths = [
        "content/segments/segment-0/display.mp4",
        "content/segments/segment-0/camera.mp4",
        "content/segments/segment-0/mic.ogg",
        "content/segments/segment-0/system-audio.ogg",
        "content/segments/segment-0/cursor.json",
        "content/segments/segment-0/keyboard.bin",
        "content/cursors/cursor_0.png",
    ];
    for separator in ["/", "\\"] {
        let input = paths.map(|path| path.replace('/', separator));
        let (_project, meta) = load_project(
            json!({
                "pretty_name": "Studio recording",
                "segments": [{
                    "display": {"path": input[0]},
                    "camera": {"path": input[1]},
                    "mic": {"path": input[2]},
                    "system_audio": {"path": input[3]},
                    "cursor": input[4],
                    "keyboard": input[5]
                }],
                "cursors": {"0": {"imagePath": input[6], "hotspot": {"x": 0.0, "y": 0.0}}}
            }),
            &paths,
        );
        let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
            panic!("expected multiple segments");
        };
        let segment = &inner.segments[0];
        assert_path(&meta, &segment.display.path, paths[0]);
        assert_path(&meta, &segment.camera.as_ref().unwrap().path, paths[1]);
        assert_path(&meta, &segment.mic.as_ref().unwrap().path, paths[2]);
        assert_path(
            &meta,
            &segment.system_audio.as_ref().unwrap().path,
            paths[3],
        );
        assert_path(&meta, segment.cursor.as_ref().unwrap(), paths[4]);
        assert_path(&meta, segment.keyboard.as_ref().unwrap(), paths[5]);
        assert_eq!(
            std::fs::read(inner.get_cursor_image(&meta, "0").unwrap().path).unwrap(),
            b"recorded data"
        );
    }
}

#[test]
fn relocated_keyboard_paths_resolve_alongside_media() {
    let paths = [
        "content/segments/segment-0/display.mp4",
        "content/segments/segment-0/keyboard.bin",
    ];
    let (_project, meta) = load_project(
        json!({
            "pretty_name": "Moved recording",
            "segments": [{
                "display": {"path": r"C:\Old\Demo.cap\content\segments\segment-0\display.mp4"},
                "keyboard": r"C:\Old\Demo.cap\content\segments\segment-0\keyboard.bin"
            }]
        }),
        &paths,
    );
    let StudioRecordingMeta::MultipleSegments { inner } = meta.studio_meta().unwrap() else {
        panic!("expected multiple segments");
    };
    assert_path(&meta, &inner.segments[0].display.path, paths[0]);
    assert_path(
        &meta,
        inner.segments[0].keyboard.as_ref().unwrap(),
        paths[1],
    );
}
