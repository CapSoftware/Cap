use cap_project::{
    AspectRatio, BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline,
};
use std::sync::Arc;

#[tokio::test]
async fn gradient_angles_and_stops_follow_the_canvas_when_resizing() {
    let recording: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "background-gradient",
        "display": { "path": "display.mp4", "fps": 30 },
        "camera": null, "audio": null, "cursor": null
    }))
    .unwrap();
    let meta = recording.studio_meta().unwrap().clone();
    let screen_size = XY::new(160, 90);
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: None,
            preserve_screen_alpha: false,
        },
        recording,
        meta,
    )
    .await
    .unwrap();
    let cursor = CursorEvents::default();
    let frames = DecodedSegmentFrames {
        screen_size,
        screen_frame: None,
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };
    let mut project = ProjectConfiguration::default();
    project.cursor.hide = true;
    let mut renderer = FrameRenderer::new(&constants);
    let mut layers = RendererLayers::new_for_preparing_preview(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
        &project,
    )
    .unwrap();

    for angle in [45, 30, 135, 225, 315, 0, 90, 180, 270, 360] {
        project.background.source = BackgroundSource::Gradient {
            from: [255, 0, 0],
            to: [0, 0, 255],
            angle,
            noise_intensity: None,
            noise_scale: None,
            animated: None,
            animation_speed: None,
        };
        for aspect in [
            AspectRatio::Wide,
            AspectRatio::Square,
            AspectRatio::Vertical,
            AspectRatio::Wide,
        ] {
            project.aspect_ratio = Some(aspect);
            let shared = Arc::new(project.clone());
            let zoom = ZoomTransformTimeline::from_project(&shared, &cursor, 1.0, screen_size);
            for resolution in [160, 320] {
                let uniforms = ProjectUniforms::new(
                    &constants,
                    &shared,
                    0,
                    30,
                    XY::new(resolution, resolution),
                    &cursor,
                    &frames,
                    1.0,
                    &zoom,
                );
                let rendered = renderer
                    .render_immediate(frames.clone(), uniforms, &cursor, false, &mut layers)
                    .await
                    .unwrap();
                let (width, height) = (rendered.width as f64, rendered.height as f64);
                let (sin, cos) = f64::from(angle).to_radians().sin_cos();
                let length = width * sin.abs() + height * cos.abs();
                for y in [
                    0,
                    rendered.height / 4,
                    rendered.height / 2,
                    rendered.height - 1,
                ] {
                    for x in [
                        0,
                        rendered.width / 4,
                        rendered.width / 2,
                        rendered.width - 1,
                    ] {
                        let position = 0.5
                            + ((f64::from(x) + 0.5 - width / 2.0) * sin
                                - (f64::from(y) + 0.5 - height / 2.0) * cos)
                                / length;
                        let expected = [
                            (255.0 * (1.0 - position)).round() as u8,
                            0,
                            (255.0 * position).round() as u8,
                            255,
                        ];
                        let offset = (y * rendered.padded_bytes_per_row + x * 4) as usize;
                        let actual = &rendered.data[offset..offset + 4];
                        assert!(
                            actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 1),
                            "angle {angle}, {width}x{height}, pixel ({x}, {y}): {actual:?}, expected {expected:?}",
                        );
                    }
                }
            }
        }
    }
}
