use cap_project::{CameraShape, CursorEvents, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, RenderingError, ZoomTransformTimeline,
};

const QUADRANTS: [[u8; 3]; 4] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];

/// Which quadrant of the source image (0 top-left, 1 top-right, 2 bottom-left,
/// 3 bottom-right) the output point `(u, v)` shows: mirror in the oriented
/// frame first, then the shader's `rotated_frame_uv` quarter turns.
fn expected_quadrant(u: f32, v: f32, rotation: u16, mirror: bool) -> usize {
    let u = if mirror { 1.0 - u } else { u };
    let (tu, tv) = match rotation {
        90 => (v, 1.0 - u),
        180 => (1.0 - u, 1.0 - v),
        270 => (1.0 - v, u),
        _ => (u, v),
    };
    usize::from(tu >= 0.5) + 2 * usize::from(tv >= 0.5)
}

fn nearest_quadrant(pixel: &[u8]) -> usize {
    QUADRANTS
        .iter()
        .enumerate()
        .min_by_key(|(_, color)| {
            color
                .iter()
                .zip(pixel)
                .map(|(a, b)| u32::from(a.abs_diff(*b)))
                .sum::<u32>()
        })
        .unwrap()
        .0
}

/// A non-square camera with a different colour in each quadrant, rendered
/// camera-only at every quarter turn with and without mirroring: each output
/// corner must show the quadrant the rotation maps there.
#[tokio::test]
async fn rotated_and_mirrored_cameras_land_each_quadrant_in_the_right_corner() {
    let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "camera-rotation-pixels",
        "display": { "path": "display.mp4", "fps": 30 },
        "camera": { "path": "camera.mp4", "fps": 30 },
        "audio": null, "cursor": null
    }))
    .unwrap();
    let studio = metadata.studio_meta().unwrap().clone();
    let screen_size = XY::new(160, 90);
    let camera_size = XY::new(80, 60);
    let constants = match RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: Some(camera_size),
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await
    {
        Ok(constants) => constants,
        Err(RenderingError::NoAdapter) => {
            eprintln!("no GPU adapter available, skipping camera rotation pixels");
            return;
        }
        Err(error) => panic!("render setup failed: {error}"),
    };
    let cursor = CursorEvents::default();
    let camera = image::RgbaImage::from_fn(camera_size.x, camera_size.y, |x, y| {
        let quadrant =
            usize::from(x >= camera_size.x / 2) + 2 * usize::from(y >= camera_size.y / 2);
        let [r, g, b] = QUADRANTS[quadrant];
        image::Rgba([r, g, b, 255])
    });
    let frames = DecodedSegmentFrames {
        screen_size,
        screen_frame: Some(DecodedFrame::new(
            [20, 30, 40, 255].repeat(screen_size.x as usize * screen_size.y as usize),
            screen_size.x,
            screen_size.y,
        )),
        camera_frame: Some(DecodedFrame::new(
            camera.into_raw(),
            camera_size.x,
            camera_size.y,
        )),
        segment_time: 3.0,
        recording_time: 3.0,
        segment_has_camera: true,
    };
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let mut renderer = FrameRenderer::new(&constants);

    for rotation in [0u16, 90, 180, 270] {
        for mirror in [false, true] {
            let mut project = ProjectConfiguration::default();
            project.cursor.hide = true;
            project.camera.shadow = 0.0;
            project.camera.rounding = 0.0;
            project.camera.shape = CameraShape::Source;
            project.camera.rotation = rotation;
            project.camera.mirror = mirror;
            project.timeline = Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [],
                    "zoomSegments": [],
                    "sceneSegments": [{
                        "start": 0.0, "end": 6.0, "mode": "cameraOnly",
                        "transitionIn": 0.0, "transitionOut": 0.0
                    }]
                }))
                .unwrap(),
            );
            let zoom = ZoomTransformTimeline::from_project(&project, &cursor, 6.0, screen_size);
            let shared = std::sync::Arc::new(project);
            let uniforms = ProjectUniforms::new(
                &constants,
                &shared,
                90,
                30,
                screen_size,
                &cursor,
                &frames,
                6.0,
                &zoom,
            );
            let output = renderer
                .render_immediate(frames.clone(), uniforms, &cursor, true, &mut layers)
                .await
                .unwrap();
            let (width, height) = (output.width as f32, output.height as f32);
            for (u, v) in [(0.2, 0.2), (0.8, 0.2), (0.2, 0.8), (0.8, 0.8)] {
                let x = (u * width) as usize;
                let y = (v * height) as usize;
                let offset = y * output.padded_bytes_per_row as usize + x * 4;
                let pixel = &output.data[offset..offset + 3];
                assert_eq!(
                    nearest_quadrant(pixel),
                    expected_quadrant(u, v, rotation, mirror),
                    "rotation {rotation}, mirror {mirror}, point ({u}, {v}), pixel {pixel:?}"
                );
            }
        }
    }
}
