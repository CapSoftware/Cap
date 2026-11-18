use cap_project::{CameraShape, CursorEvents, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};

#[tokio::test]
async fn camera_geometry_matches_a_project_with_the_current_clips_dimensions() {
    let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "camera-frame-geometry",
        "display": { "path": "display.mp4", "fps": 30 },
        "camera": { "path": "camera.mp4", "fps": 30 },
        "audio": null, "cursor": null
    }))
    .unwrap();
    let studio = metadata.studio_meta().unwrap().clone();
    let screen_size = XY::new(160, 90);
    let first_camera_size = XY::new(80, 60);
    let mut constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: Some(first_camera_size),
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await
    .unwrap();
    let cursor = CursorEvents::default();
    let mut project = ProjectConfiguration::default();
    project.cursor.hide = true;
    project.camera.shadow = 0.0;
    project.camera.size = 25.0;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);

    for (width, height) in [(81, 45), (45, 81), (80, 60)] {
        let camera_size = XY::new(width, height);
        let camera = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x * 3) as u8, (y * 3) as u8, 100, 255])
        });
        let frames = DecodedSegmentFrames {
            screen_size,
            screen_frame: Some(DecodedFrame::new(
                [20, 30, 40, 255].repeat(screen_size.x as usize * screen_size.y as usize),
                screen_size.x,
                screen_size.y,
            )),
            camera_frame: Some(DecodedFrame::new(camera.into_raw(), width, height)),
            segment_time: 3.0 + width as f32 / 1000.0,
            recording_time: 3.0 + width as f32 / 1000.0,
            segment_has_camera: true,
        };
        for mode in ["default", "cameraOnly", "splitScreen", "floating"] {
            project.timeline = Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [],
                    "zoomSegments": [{
                        "start": 0.0, "end": 6.0, "amount": 2.0,
                        "mode": {"manual": {"x": 0.5, "y": 0.5}}
                    }],
                    "sceneSegments": [{
                        "start": 2.0, "end": 5.0, "mode": mode,
                        "transitionIn": 0.3, "transitionOut": 0.3
                    }]
                }))
                .unwrap(),
            );
            for shape in [CameraShape::Source, CameraShape::Square] {
                project.camera.shape = shape;
                for number in [56, 90, 145] {
                    let zoom = ZoomTransformTimeline::from_project(
                        &project,
                        &cursor,
                        6.0,
                        cap_rendering::ZoomLayoutInputs::screen_only(screen_size),
                    );
                    let shared = std::sync::Arc::new(project.clone());
                    constants.options.camera_size = Some(first_camera_size);
                    let actual = ProjectUniforms::new(
                        &constants,
                        &shared,
                        number,
                        30,
                        screen_size,
                        &cursor,
                        &frames,
                        6.0,
                        &zoom,
                    );
                    constants.options.camera_size = Some(camera_size);
                    let expected = ProjectUniforms::new(
                        &constants,
                        &shared,
                        number,
                        30,
                        screen_size,
                        &cursor,
                        &frames,
                        6.0,
                        &zoom,
                    );
                    let mut renderer = FrameRenderer::new(&constants);
                    let actual = renderer
                        .render_immediate(frames.clone(), actual, &cursor, true, &mut layers)
                        .await
                        .unwrap();
                    let mut fresh = RendererLayers::new(&constants.device, &constants.queue);
                    let expected = renderer
                        .render_immediate(frames.clone(), expected, &cursor, true, &mut fresh)
                        .await
                        .unwrap();
                    let error = actual
                        .data
                        .chunks_exact(actual.padded_bytes_per_row as usize)
                        .zip(
                            expected
                                .data
                                .chunks_exact(expected.padded_bytes_per_row as usize),
                        )
                        .flat_map(|(a, b)| {
                            a[..actual.width as usize * 4]
                                .iter()
                                .zip(&b[..expected.width as usize * 4])
                        })
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap();
                    assert_eq!(
                        error, 0,
                        "camera {width}x{height}, mode {mode}, shape {shape:?}, frame {number}"
                    );
                }
            }
        }
    }
}
