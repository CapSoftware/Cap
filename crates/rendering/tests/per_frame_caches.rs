use std::sync::Arc;

use cap_project::{
    AspectRatio, BackgroundSource, CursorClickEvent, CursorEvents, CursorMoveEvent, CursorType,
    ProjectConfiguration, RecordingMeta, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline, decoder::DecodedFrame,
};

const FPS: u32 = 30;
const FRAMES: u32 = 8;
const SCREEN: XY<u32> = XY { x: 160, y: 90 };

fn cursor_events() -> CursorEvents {
    let moves = (0..FRAMES)
        .map(|frame| CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: if frame < FRAMES / 2 { "a" } else { "b" }.to_string(),
            time_ms: frame as f64 * 1000.0 / FPS as f64,
            x: 0.2 + frame as f64 * 0.05,
            y: 0.3 + (frame % 3) as f64 * 0.1,
        })
        .collect();
    let click = |time_ms, down| CursorClickEvent {
        active_modifiers: vec![],
        cursor_num: 0,
        cursor_id: "a".to_string(),
        time_ms,
        down,
    };
    CursorEvents {
        clicks: vec![click(90.0, true), click(150.0, false)],
        moves,
    }
}

fn screen_frame(time: f64) -> DecodedSegmentFrames {
    let pixels = (0..SCREEN.x * SCREEN.y)
        .flat_map(|index| {
            let x = index % SCREEN.x;
            let y = index / SCREEN.x;
            [(x * 3) as u8, (y * 5) as u8, ((x + y) * 2) as u8, 255]
        })
        .collect();
    DecodedSegmentFrames {
        screen_size: SCREEN,
        screen_frame: Some(DecodedFrame::new(pixels, SCREEN.x, SCREEN.y)),
        camera_frame: None,
        segment_time: time as f32,
        recording_time: time as f32,
        segment_has_camera: false,
    }
}

async fn constants(directory: &std::path::Path) -> RenderVideoConstants {
    for (name, color) in [("a.png", [255, 40, 40]), ("b.png", [40, 40, 255])] {
        image::RgbaImage::from_fn(24, 32, |x, y| {
            let alpha = if x + y < 40 { 255 } else { 0 };
            image::Rgba([color[0], color[1], color[2], alpha])
        })
        .save(directory.join(name))
        .unwrap();
    }
    let mut recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "per-frame-caches",
        "segments": [{ "display": { "path": "display.mp4", "fps": FPS } }],
        "cursors": {
            "a": { "imagePath": "a.png", "hotspot": { "x": 0.1, "y": 0.1 } },
            "b": { "imagePath": "b.png", "hotspot": { "x": 0.5, "y": 0.5 } }
        }
    }))
    .unwrap();
    recording_meta.project_path = directory.to_path_buf();
    let meta = recording_meta.studio_meta().unwrap().clone();
    RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: SCREEN,
            camera_size: None,
            preserve_screen_alpha: false,
        },
        recording_meta,
        meta,
    )
    .await
    .unwrap()
}

fn wallpaper(directory: &std::path::Path) -> BackgroundSource {
    let path = directory.join("wallpaper.png");
    image::RgbaImage::from_fn(96, 64, |x, y| {
        image::Rgba([(x * 2) as u8, (y * 3) as u8, 90, 255])
    })
    .save(&path)
    .unwrap();
    BackgroundSource::Wallpaper {
        path: Some(path.to_string_lossy().into_owned()),
    }
}

fn timeline(value: serde_json::Value) -> Option<cap_project::TimelineConfiguration> {
    let mut timeline = serde_json::json!({ "segments": [], "zoomSegments": [] });
    timeline
        .as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    Some(serde_json::from_value(timeline).unwrap())
}

fn scenarios(directory: &std::path::Path) -> Vec<(&'static str, ProjectConfiguration)> {
    let base = || {
        let mut project = ProjectConfiguration::default();
        project.background.source = wallpaper(directory);
        project.background.padding = 12.0;
        project
    };

    let mut graded = base();
    graded.color_correction.screen.exposure = 0.4;
    graded.color_correction.screen.saturation = -0.3;

    let mut circle = base();
    circle.cursor.set_cursor_type(CursorType::Circle);

    let mut masks = base();
    masks.timeline = timeline(serde_json::json!({
        "maskSegments": [
            {
                "start": 0.0, "end": 10.0, "maskType": "sensitive",
                "center": { "x": 0.3, "y": 0.4 }, "size": { "x": 0.3, "y": 0.3 },
                "feather": 0.1, "pixelation": 1024.0
            },
            {
                "start": 0.0, "end": 10.0, "maskType": "sensitive",
                "center": { "x": 0.6, "y": 0.5 }, "size": { "x": 0.25, "y": 0.2 },
                "pixelation": 18.0
            },
            {
                "start": 0.0, "end": 10.0, "maskType": "highlight",
                "center": { "x": 0.5, "y": 0.6 }, "size": { "x": 0.4, "y": 0.3 },
                "darkness": 0.5
            }
        ]
    }));

    let camera3d = |bokeh: bool| {
        let mut project = base();
        project.timeline = timeline(serde_json::json!({
            "camera3dSegments": [{
                "start": 0.0, "end": 10.0,
                "properties": { "tiltX": -18.0, "tiltY": 14.0, "zoom": 1.8 },
                "blur": { "mode": "radial", "strength": 12.0, "falloff": 0.5, "bokeh": bokeh }
            }]
        }));
        project
    };

    let mut animated = base();
    animated.background.source = BackgroundSource::AnimatedGradient {
        config: Default::default(),
    };
    animated.background.blur = 30.0;
    animated.color_correction.screen.contrast = 0.3;

    vec![
        ("graded", graded),
        ("circle", circle),
        ("masks", masks),
        ("camera3d-gaussian", camera3d(false)),
        ("camera3d-bokeh", camera3d(true)),
        ("animated-blur", animated),
    ]
}

fn first_difference(
    actual: &cap_rendering::RenderedFrame,
    expected: &cap_rendering::RenderedFrame,
) -> Option<usize> {
    if (actual.width, actual.height) != (expected.width, expected.height) {
        return Some(0);
    }
    (0..actual.height as usize).find(|y| {
        let start = y * actual.padded_bytes_per_row as usize;
        let end = start + actual.width as usize * 4;
        actual.data[start..end] != expected.data[start..end]
    })
}

async fn render_fresh(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    frames: DecodedSegmentFrames,
    uniforms: ProjectUniforms,
    cursor: &CursorEvents,
) -> cap_rendering::RenderedFrame {
    let mut renderer = FrameRenderer::new(constants);
    let mut layers = RendererLayers::new_for_preparing_preview(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
        project,
    )
    .unwrap();
    renderer
        .render_immediate(frames, uniforms, cursor, true, &mut layers)
        .await
        .unwrap()
}

/// Layers kept across frames cache bind groups, uniform buffers and the
/// resolved wallpaper path. Every frame must match layers built from scratch
/// for that frame, including across a session resize.
#[tokio::test]
async fn reused_layers_match_fresh_layers_every_frame() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let cursor = cursor_events();
    let duration = FRAMES as f64 / FPS as f64;

    for (name, mut project) in scenarios(directory.path()) {
        if name == "masks" && cfg!(windows) && constants.is_software_adapter {
            eprintln!("WARP renders the mask scene differently on identical runs, skipping it");
            continue;
        }
        let mut renderer = FrameRenderer::new(&constants);
        let mut layers = RendererLayers::new_for_preparing_preview(
            &constants.device,
            &constants.queue,
            constants.is_software_adapter,
            &project,
        )
        .unwrap();
        let mut shared = Arc::new(project.clone());

        for frame_number in 0..FRAMES {
            if frame_number == FRAMES - 3 {
                project.aspect_ratio = Some(AspectRatio::Square);
                shared = Arc::new(project.clone());
            }
            let time = frame_number as f64 / FPS as f64;
            let frames = screen_frame(time);
            let zoom = ZoomTransformTimeline::from_project(
                &project,
                &cursor,
                duration,
                cap_rendering::ZoomLayoutInputs::screen_only(SCREEN),
            );
            let uniforms = ProjectUniforms::new(
                &constants,
                &shared,
                frame_number,
                FPS,
                SCREEN,
                &cursor,
                &frames,
                duration,
                &zoom,
            );

            let actual = renderer
                .render_immediate(frames.clone(), uniforms.clone(), &cursor, true, &mut layers)
                .await
                .unwrap();

            let expected = render_fresh(&constants, &project, frames, uniforms, &cursor).await;

            if let Some(row) = first_difference(&actual, &expected) {
                panic!("{name} frame {frame_number}: row {row} differs");
            }
        }
    }
}
