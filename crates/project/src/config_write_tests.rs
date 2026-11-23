use crate::ProjectConfiguration;
use std::io::Read;

#[test]
fn replacing_config_keeps_the_previous_file_intact() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    let mut config = ProjectConfiguration::default();
    config.write(project.path()).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut previous = std::fs::File::open(&path).unwrap();
    config.background.padding = 23.0;

    config.write(project.path()).unwrap();

    let mut retained = Vec::new();
    previous.read_to_end(&mut retained).unwrap();
    assert_eq!(retained, original);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        serde_json::to_vec_pretty(&config).unwrap()
    );
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}

#[test]
fn failed_replacement_keeps_the_destination_and_cleans_up() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("retained"), b"original").unwrap();

    assert!(
        ProjectConfiguration::default()
            .write(project.path())
            .is_err()
    );

    assert_eq!(std::fs::read(path.join("retained")).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn failed_write_keeps_the_previous_config_and_cleans_up() {
    const CHILD_PROJECT: &str = "CAP_PROJECT_LIMITED_WRITE_TEST";
    if let Some(project) = std::env::var_os(CHILD_PROJECT) {
        let config = ProjectConfiguration::default();
        assert!(serde_json::to_vec_pretty(&config).unwrap().len() > 1024);
        assert!(config.write(project).is_err());
        return;
    }

    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    let mut config = ProjectConfiguration::default();
    config.background.padding = 23.0;
    config.write(project.path()).unwrap();
    let original = std::fs::read(&path).unwrap();

    let output = std::process::Command::new("sh")
        .args([
            "-c",
            "trap '' XFSZ; ulimit -f 1; exec \"$@\"",
            "config-write-test",
        ])
        .arg(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "config_write_tests::failed_write_keeps_the_previous_config_and_cleans_up",
        ])
        .env(CHILD_PROJECT, project.path())
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "{output:?}"
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}

#[test]
fn shapes_survive_write_and_load() {
    use crate::{OverlayTrack, OverlayTrackKind, ShapeKind, ShapeSegment, XY};

    let project = tempfile::tempdir().unwrap();
    let mut config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
        "timeline": {"segments": [], "zoomSegments": []}
    }))
    .unwrap();
    let shape = ShapeSegment::new(ShapeKind::Badge, 1.0, 3.0, XY::new(0.25, 0.75), 16.0 / 9.0);
    config
        .timeline
        .as_mut()
        .unwrap()
        .shape_segments
        .push(shape.clone());
    let order = vec![
        OverlayTrack {
            kind: OverlayTrackKind::Shape,
            track: 0,
        },
        OverlayTrack {
            kind: OverlayTrackKind::Text,
            track: 0,
        },
    ];
    config.set_overlay_order(order.clone());
    config.write(project.path()).unwrap();

    let loaded = ProjectConfiguration::load(project.path()).unwrap();
    let restored = &loaded.timeline.as_ref().unwrap().shape_segments;
    assert_eq!(restored.len(), 1);
    let close = |a: XY<f64>, b: XY<f64>| (a.x - b.x).abs() < 1e-12 && (a.y - b.y).abs() < 1e-12;
    assert!(close(restored[0].from, shape.from) && close(restored[0].to, shape.to));
    assert_eq!(
        ShapeSegment {
            from: shape.from,
            to: shape.to,
            ..restored[0].clone()
        },
        shape
    );
    assert_eq!(loaded.overlay_order(), order);
}

#[test]
fn projects_saved_before_shapes_load_unchanged() {
    let project = tempfile::tempdir().unwrap();
    let json = serde_json::json!({
        "timeline": {
            "segments": [],
            "zoomSegments": [],
            "textSegments": [{"start": 0.0, "end": 1.0, "content": "Hi"}]
        },
        "overlayOrder": [{"kind": "text", "track": 0}],
        "textSizeVersion": 1,
        "textAnimVersion": 1,
        "screenMotionBlur": 0.0
    });
    std::fs::write(
        project.path().join("project-config.json"),
        serde_json::to_vec_pretty(&json).unwrap(),
    )
    .unwrap();
    let loaded = ProjectConfiguration::load(project.path()).unwrap();
    let timeline = loaded.timeline.as_ref().unwrap();
    assert!(timeline.shape_segments.is_empty());
    assert_eq!(timeline.text_segments.len(), 1);
    assert_eq!(loaded.overlay_order().len(), 1);
    assert!(loaded.overlay_order_with_shapes.is_empty());
}
