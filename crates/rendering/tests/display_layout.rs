use cap_project::{
    AspectRatio, BackgroundSource, Crop, CursorEvents, FrameConfiguration, FrameStyle,
    ProjectConfiguration, RecordingMeta, XY,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};

#[test]
fn portrait_vertical_without_padding_fills_the_output() {
    let options = RenderOptions {
        screen_size: XY::new(1080, 1920),
        camera_size: None,
        preserve_screen_alpha: false,
    };
    let project = ProjectConfiguration {
        aspect_ratio: Some(AspectRatio::Vertical),
        ..ProjectConfiguration::default()
    };
    let resolution = XY::new(1080, 1920);

    assert_eq!(
        ProjectUniforms::get_output_size(&options, &project, resolution),
        (1080, 1920)
    );
    assert_eq!(
        ProjectUniforms::display_offset(&options, &project, resolution).coord,
        XY::new(0.0, 0.0)
    );
    assert_eq!(
        ProjectUniforms::display_size(&options, &project, resolution).coord,
        XY::new(1080.0, 1920.0)
    );
}

#[tokio::test]
async fn imported_portrait_fills_a_vertical_output() {
    let instance = cap_rendering::create_wgpu_instance_sync();
    if instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .is_err()
    {
        eprintln!("no GPU adapter available, skipping portrait layout regression");
        return;
    }
    let options = RenderOptions {
        screen_size: XY::new(1920, 1080),
        camera_size: None,
        preserve_screen_alpha: false,
    };
    let recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "portrait-import",
        "display": { "path": "display.mp4", "fps": 30 },
        "camera": null,
        "audio": null,
        "cursor": null
    }))
    .unwrap();
    let meta = recording_meta.studio_meta().unwrap().clone();
    let mut constants = RenderVideoConstants::new_with_options(options, recording_meta, meta)
        .await
        .unwrap();
    let mut project = ProjectConfiguration {
        aspect_ratio: Some(AspectRatio::Vertical),
        ..ProjectConfiguration::default()
    };
    project.background.shadow = 0.0;
    project.background.source = BackgroundSource::Color {
        value: [0, 0, 0],
        alpha: 255,
    };
    project.cursor.hide = true;
    let cursor = CursorEvents::default();
    let source_size = XY::new(1080, 1920);
    let frames = DecodedSegmentFrames {
        screen_size: options.screen_size,
        screen_frame: Some(DecodedFrame::new(
            [255, 0, 0, 255].repeat((source_size.x * source_size.y) as usize),
            source_size.x,
            source_size.y,
        )),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };
    for decoded in [true, false] {
        let mut frames = frames.clone();
        if !decoded {
            frames.screen_frame = None;
            frames.screen_size = source_size;
        }
        let uniforms = uniforms_for(&constants, &project, &frames, source_size);
        assert_eq!(uniforms.frame_layout().output_size, [1080, 1920]);
        assert_bounds(uniforms.frame_layout().display, [0.0, 0.0, 1080.0, 1920.0]);
    }

    constants.options.screen_size = source_size;
    project.aspect_ratio = Some(AspectRatio::Wide);
    let mut landscape = frames.clone();
    landscape.screen_frame = Some(DecodedFrame::new(Vec::new(), 1920, 1080));
    let imported = uniforms_for(&constants, &project, &landscape, options.screen_size);
    assert_eq!(imported.frame_layout().output_size, [1920, 1080]);
    assert_bounds(imported.frame_layout().display, [0.0, 0.0, 1920.0, 1080.0]);
    constants.options = options;
    project.aspect_ratio = Some(AspectRatio::Vertical);

    for style in [FrameStyle::Browser, FrameStyle::MacOS] {
        project.background.frame = Some(FrameConfiguration {
            style,
            ..Default::default()
        });
        let imported = uniforms_for(&constants, &project, &frames, source_size);
        constants.options.screen_size = source_size;
        let native = uniforms_for(&constants, &project, &frames, source_size);
        constants.options = options;
        assert_bounds(
            imported.frame_layout().display,
            native.frame_layout().display,
        );
    }

    project.background.frame = None;
    project.background.crop = Some(Crop {
        position: XY::new(480, 0),
        size: XY::new(960, 1080),
    });
    let cropped = uniforms_for(&constants, &project, &frames, source_size);
    assert_bounds(cropped.frame_layout().display, [270.0, 0.0, 810.0, 1920.0]);

    project.background.crop = None;
    let uniforms = uniforms_for(&constants, &project, &frames, XY::new(180, 320));
    let mut renderer = FrameRenderer::new(&constants);
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let rendered = renderer
        .render_immediate(frames, uniforms, &cursor, true, &mut layers)
        .await
        .unwrap();
    assert_eq!((rendered.width, rendered.height), (180, 320));
    for (x, y) in [(90, 5), (5, 160), (174, 160), (90, 314)] {
        let offset = y * rendered.padded_bytes_per_row as usize + x * 4;
        let pixel = &rendered.data[offset..offset + 4];
        assert!(
            pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10,
            "{x},{y}: {pixel:?}"
        );
    }
}

fn assert_bounds(actual: [f32; 4], expected: [f32; 4]) {
    for (actual_value, expected_value) in actual.iter().zip(expected) {
        assert!(
            (actual_value - expected_value).abs() < 2.0,
            "display {actual:?}, expected {expected:?}",
        );
    }
}

fn uniforms_for(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    frames: &DecodedSegmentFrames,
    resolution: XY<u32>,
) -> ProjectUniforms {
    let cursor = CursorEvents::default();
    let zoom = ZoomTransformTimeline::from_project(project, &cursor, 1.0, &constants.options);
    let shared = std::sync::Arc::new(project.clone());
    ProjectUniforms::new(
        constants, &shared, 0, 30, resolution, &cursor, frames, 1.0, &zoom,
    )
}
