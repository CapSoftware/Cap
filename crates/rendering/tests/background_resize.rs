use cap_project::{
    AspectRatio, BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline,
};

#[tokio::test]
async fn image_background_resize_matches_fresh_layers() {
    let recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "background-resize",
        "display": { "path": "display.mp4", "fps": 30 },
        "camera": null,
        "audio": null,
        "cursor": null
    }))
    .unwrap();
    let meta = recording_meta.studio_meta().unwrap().clone();
    let screen_size = XY::new(128, 72);
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: None,
            preserve_screen_alpha: false,
        },
        recording_meta,
        meta,
    )
    .await
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let cursor = CursorEvents::default();
    let frames = DecodedSegmentFrames {
        screen_size,
        screen_frame: None,
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };

    for (width, height) in [(96, 64), (64, 96)] {
        let path = directory.path().join(format!("{width}x{height}.png"));
        image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x * 2) as u8, (y * 2) as u8, 64, 255])
        })
        .save(&path)
        .unwrap();
        for blur in [0.0, 25.0] {
            let mut project = ProjectConfiguration::default();
            project.background.source = BackgroundSource::Image {
                path: Some(path.to_string_lossy().into_owned()),
            };
            project.background.blur = blur;
            project.cursor.hide = true;
            let mut renderer = FrameRenderer::new(&constants);
            let mut layers = RendererLayers::new_for_preparing_preview(
                &constants.device,
                &constants.queue,
                constants.is_software_adapter,
                &project,
            )
            .unwrap();

            for aspect in [
                AspectRatio::Wide,
                AspectRatio::Wide,
                AspectRatio::Square,
                AspectRatio::Vertical,
                AspectRatio::Wide,
            ] {
                project.aspect_ratio = Some(aspect);
                let zoom = ZoomTransformTimeline::from_project(
                    &project,
                    &cursor,
                    1.0,
                    cap_rendering::ZoomLayoutInputs::screen_only(screen_size),
                );
                let uniforms = ProjectUniforms::new(
                    &constants,
                    &std::sync::Arc::new(project.clone()),
                    0,
                    30,
                    XY::new(128, 128),
                    &cursor,
                    &frames,
                    1.0,
                    &zoom,
                );
                let actual = renderer
                    .render_immediate(
                        frames.clone(),
                        uniforms.clone(),
                        &cursor,
                        false,
                        &mut layers,
                    )
                    .await
                    .unwrap();
                let mut fresh_layers = RendererLayers::new_for_preparing_preview(
                    &constants.device,
                    &constants.queue,
                    constants.is_software_adapter,
                    &project,
                )
                .unwrap();
                let expected = renderer
                    .render_immediate(frames.clone(), uniforms, &cursor, false, &mut fresh_layers)
                    .await
                    .unwrap();

                let center = (expected.height / 2 * expected.padded_bytes_per_row
                    + expected.width / 2 * 4) as usize;
                assert!(expected.data[center] > expected.data[0]);
                assert!(expected.data[center + 1] > expected.data[1]);

                for y in 0..actual.height as usize {
                    let start = y * actual.padded_bytes_per_row as usize;
                    let end = start + actual.width as usize * 4;
                    let error = actual.data[start..end]
                        .iter()
                        .zip(&expected.data[start..end])
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap();
                    assert_eq!(
                        error, 0,
                        "{width}x{height} image, {:?}, blur {blur}, row {y}",
                        project.aspect_ratio,
                    );
                }
            }
        }
    }
}
