use super::*;

fn background_path(source: &BackgroundSource) -> &str {
    match source {
        BackgroundSource::Wallpaper { path: Some(path) }
        | BackgroundSource::Image { path: Some(path) } => path,
        _ => panic!("expected an image background"),
    }
}

#[test]
fn moving_a_project_keeps_its_desktop_backgrounds() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original.cap");
    let moved = root.path().join("moved.cap");
    let assets = original.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let base = "current-desktop-background-1.jpg";
    let style = "current-desktop-background-2.jpg";
    std::fs::write(assets.join(base), b"base").unwrap();
    std::fs::write(assets.join(style), b"style").unwrap();
    let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
        "background": {"source": {"type": "wallpaper", "path": assets.join(base)}},
        "timeline": {"segments": [], "zoomSegments": [], "styleSegments": [{
            "start": 1.0, "end": 3.0,
            "overrides": {"background": {"source": {"type": "image", "path": assets.join(style)}}}
        }]}
    }))
    .unwrap();
    config.write(&original).unwrap();
    std::fs::rename(&original, &moved).unwrap();

    let loaded = ProjectConfiguration::load(&moved).unwrap();

    assert_eq!(
        Path::new(background_path(&loaded.background.source)),
        moved.join("assets").join(base)
    );
    assert_eq!(
        Path::new(background_path(&loaded.style_at(2.0).background.source)),
        moved.join("assets").join(style)
    );
    loaded.write(&moved).unwrap();
    let reopened = ProjectConfiguration::load(&moved).unwrap();
    assert_eq!(
        background_path(&loaded.background.source),
        background_path(&reopened.background.source)
    );
}

#[test]
fn background_assets_resolve_from_copied_relative_and_foreign_project_paths() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("copied.cap");
    let assets = project.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let name = "current-desktop-background-1.jpg";
    let local = assets.join(name);
    std::fs::write(&local, b"local").unwrap();
    let original = root.path().join("original.cap").join("assets").join(name);
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, b"original").unwrap();

    for path in [
        original.to_string_lossy().into_owned(),
        format!("assets/{name}"),
        format!("C:\\Recordings\\original.cap\\assets\\{name}"),
        format!("C:\\Recordings\\original.CAP\\assets\\{name}"),
    ] {
        let mut config = ProjectConfiguration::default();
        config.background.source = BackgroundSource::Wallpaper { path: Some(path) };
        config.write(&project).unwrap();

        let loaded = ProjectConfiguration::load(&project).unwrap();

        assert_eq!(Path::new(background_path(&loaded.background.source)), local);
    }
}

#[test]
fn unrelated_or_missing_background_images_keep_their_saved_path() {
    let project = tempfile::tempdir().unwrap();
    let assets = project.path().join("assets");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("background.jpg"), b"local").unwrap();
    std::fs::create_dir(assets.join("background-directory.jpg")).unwrap();
    let external = project.path().join("external/assets/background.jpg");
    std::fs::create_dir_all(external.parent().unwrap()).unwrap();
    std::fs::write(&external, b"external").unwrap();

    for path in [
        external.to_string_lossy().into_owned(),
        "/external/background.jpg".to_string(),
        "/old.cap/assets/missing.jpg".to_string(),
        "/old.cap/assets/background-directory.jpg".to_string(),
    ] {
        let mut config = ProjectConfiguration::default();
        config.background.source = BackgroundSource::Image {
            path: Some(path.clone()),
        };
        config.write(project.path()).unwrap();

        let loaded = ProjectConfiguration::load(project.path()).unwrap();

        assert_eq!(background_path(&loaded.background.source), path);
    }
}
