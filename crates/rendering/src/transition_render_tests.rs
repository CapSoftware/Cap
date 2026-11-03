use super::*;
use cap_project::{BackgroundSource, ImageSegment};

const WIDTH: u32 = 160;
const HEIGHT: u32 = 90;
const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const YELLOW: [u8; 4] = [255, 255, 0, 255];

struct Fixture {
    constants: RenderVideoConstants,
    project: Arc<ProjectConfiguration>,
    directory: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).ok();
    }
}

async fn fixture(with_overlay: bool) -> Fixture {
    let instance = create_wgpu_instance_sync();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("graphics adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .expect("graphics device");
    let mut recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "transition-test",
        "display": { "path": "display.mp4", "fps": 60 },
        "camera": null, "audio": null, "cursor": null
    }))
    .expect("metadata");
    let directory = std::env::temp_dir().join(format!(
        "cap-transition-render-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(directory.join("content/images")).expect("image directory");
    image::RgbaImage::from_pixel(8, 8, image::Rgba(YELLOW))
        .save(directory.join("content/images/overlay.png"))
        .expect("image asset");
    recording_meta.project_path = directory.clone();
    let constants = RenderVideoConstants {
        adapter_name: adapter.get_info().name,
        _instance: instance,
        _adapter: adapter,
        device,
        queue,
        options: RenderOptions {
            screen_size: XY::new(WIDTH, HEIGHT),
            camera_size: None,
            preserve_screen_alpha: false,
        },
        meta: recording_meta
            .studio_meta()
            .expect("studio metadata")
            .clone(),
        recording_meta,
        frozen_recorded_cursors: None,
        project_styles: ProjectStyleCache::default(),
        background_textures: Arc::new(BackgroundTextureCache::default()),
        is_software_adapter: false,
    };

    let mut project = ProjectConfiguration::default();
    project.background.source = BackgroundSource::Color {
        value: [0, 0, 255],
        alpha: 255,
    };
    project.background.padding = 20.0;
    project.background.rounding = 0.0;
    project.background.shadow = 0.0;
    let mut timeline: cap_project::TimelineConfiguration =
        serde_json::from_value(serde_json::json!({ "segments": [], "zoomSegments": [] }))
            .expect("timeline");
    if with_overlay {
        timeline.image_segments.push(ImageSegment {
            start: 0.0,
            end: 10.0,
            path: "content/images/overlay.png".to_string(),
            center: XY::new(0.5, 0.5),
            size: XY::new(0.1, 0.1),
            ..Default::default()
        });
    }
    project.timeline = Some(timeline);

    Fixture {
        constants,
        project: Arc::new(project),
        directory,
    }
}

fn frames(color: [u8; 4], time: f32) -> DecodedSegmentFrames {
    DecodedSegmentFrames {
        screen_size: XY::new(WIDTH, HEIGHT),
        screen_frame: Some(DecodedFrame::new(
            color.repeat((WIDTH * HEIGHT) as usize),
            WIDTH,
            HEIGHT,
        )),
        camera_frame: None,
        segment_time: time,
        recording_time: time,
        segment_has_camera: false,
    }
}

struct Sides {
    outgoing: (DecodedSegmentFrames, ProjectUniforms),
    incoming: (DecodedSegmentFrames, ProjectUniforms),
}

fn sides(fixture: &Fixture, cursor: &CursorEvents) -> Sides {
    let zoom =
        ZoomTransformTimeline::from_project(&fixture.project, cursor, 10.0, XY::new(WIDTH, HEIGHT));
    let side = |color, time| {
        let frames = frames(color, time);
        let uniforms = ProjectUniforms::new(
            &fixture.constants,
            &fixture.project,
            60,
            60,
            XY::new(WIDTH, HEIGHT),
            cursor,
            &frames,
            10.0,
            &zoom,
        );
        (frames, uniforms)
    };
    Sides {
        outgoing: side(RED, 1.0),
        incoming: side(GREEN, 2.0),
    }
}

async fn render_plain(
    fixture: &Fixture,
    side: &(DecodedSegmentFrames, ProjectUniforms),
    cursor: &CursorEvents,
) -> RenderedFrame {
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let mut renderer = FrameRenderer::new(&fixture.constants);
    renderer
        .render_immediate(side.0.clone(), side.1.clone(), cursor, true, &mut layers)
        .await
        .expect("plain frame")
}

async fn render_transition(
    fixture: &Fixture,
    sides: &Sides,
    cursor: &CursorEvents,
    kind: ClipTransitionType,
    progress: f32,
) -> RenderedFrame {
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let mut renderer = FrameRenderer::new(&fixture.constants);
    let input = |side: &(DecodedSegmentFrames, ProjectUniforms)| TransitionRenderInput {
        segment_frames: side.0.clone(),
        uniforms: side.1.clone(),
        cursor,
        render_display: true,
    };
    renderer
        .render_transition_immediate(
            input(&sides.outgoing),
            input(&sides.incoming),
            kind,
            progress,
            &mut layers,
        )
        .await
        .expect("transition frame")
}

fn pixel(frame: &RenderedFrame, x: u32, y: u32) -> [u8; 4] {
    let offset = (y * frame.padded_bytes_per_row + x * 4) as usize;
    <[u8; 4]>::try_from(&frame.data[offset..offset + 4]).expect("pixel")
}

fn assert_close(actual: [u8; 4], expected: [u8; 4], tolerance: u8, context: &str) {
    for channel in 0..4 {
        assert!(
            actual[channel].abs_diff(expected[channel]) <= tolerance,
            "{context}: expected {expected:?}, got {actual:?}"
        );
    }
}

fn max_difference(a: &RenderedFrame, b: &RenderedFrame) -> u8 {
    let mut max = 0;
    for y in 0..a.height {
        for x in 0..a.width {
            let (pa, pb) = (pixel(a, x, y), pixel(b, x, y));
            for channel in 0..4 {
                max = max.max(pa[channel].abs_diff(pb[channel]));
            }
        }
    }
    max
}

#[tokio::test]
async fn every_transition_starts_on_the_outgoing_frame_and_ends_on_the_incoming_one() {
    let fixture = fixture(true).await;
    let cursor = CursorEvents::default();
    let sides = sides(&fixture, &cursor);
    let outgoing = render_plain(&fixture, &sides.outgoing, &cursor).await;
    let incoming = render_plain(&fixture, &sides.incoming, &cursor).await;
    for kind in ClipTransitionType::ALL {
        let start = render_transition(&fixture, &sides, &cursor, kind, 0.0).await;
        let end = render_transition(&fixture, &sides, &cursor, kind, 1.0).await;
        assert!(
            max_difference(&start, &outgoing) <= 1,
            "{kind:?} at its first frame"
        );
        assert!(
            max_difference(&end, &incoming) <= 1,
            "{kind:?} at its last frame"
        );
    }
}

#[tokio::test]
async fn legacy_transitions_mix_whole_frames_exactly_as_before() {
    let fixture = fixture(false).await;
    let cursor = CursorEvents::default();
    let sides = sides(&fixture, &cursor);
    let outgoing = render_plain(&fixture, &sides.outgoing, &cursor).await;
    let incoming = render_plain(&fixture, &sides.incoming, &cursor).await;
    let blend = |x: u32, y: u32, outgoing_weight: f32, incoming_weight: f32| {
        let (a, b) = (pixel(&outgoing, x, y), pixel(&incoming, x, y));
        std::array::from_fn(|channel| {
            let alpha_floor = if channel == 3 {
                1.0 - outgoing_weight - incoming_weight
            } else {
                0.0
            };
            ((a[channel] as f32 * outgoing_weight + b[channel] as f32 * incoming_weight) / 255.0
                + alpha_floor)
                .clamp(0.0, 1.0)
                * 255.0
        })
        .map(|value: f32| value.round() as u8)
    };
    for (x, y) in [(2, 2), (80, 45), (30, 20)] {
        let frame = render_transition(
            &fixture,
            &sides,
            &cursor,
            ClipTransitionType::CrossFade,
            0.37,
        )
        .await;
        assert_close(pixel(&frame, x, y), blend(x, y, 0.63, 0.37), 1, "crossfade");
        let frame = render_transition(
            &fixture,
            &sides,
            &cursor,
            ClipTransitionType::FadeThroughBlack,
            0.3,
        )
        .await;
        assert_close(
            pixel(&frame, x, y),
            blend(x, y, 0.4, 0.0),
            1,
            "dip to black",
        );
    }
    let middle = render_transition(
        &fixture,
        &sides,
        &cursor,
        ClipTransitionType::FadeThroughBlack,
        0.5,
    )
    .await;
    assert_close(
        pixel(&middle, 80, 45),
        [0, 0, 0, 255],
        1,
        "black at the middle",
    );
    let middle = render_transition(
        &fixture,
        &sides,
        &cursor,
        ClipTransitionType::FadeThroughWhite,
        0.5,
    )
    .await;
    assert_close(
        pixel(&middle, 80, 45),
        [255, 255, 255, 255],
        1,
        "white at the middle",
    );
    assert_close(
        pixel(&middle, 2, 2),
        [255, 255, 255, 255],
        1,
        "white everywhere",
    );
}

#[tokio::test]
async fn moving_transitions_move_the_clips_over_a_still_background() {
    let fixture = fixture(false).await;
    let cursor = CursorEvents::default();
    let sides = sides(&fixture, &cursor);
    let at = |kind| render_transition(&fixture, &sides, &cursor, kind, 0.5);

    let push = at(ClipTransitionType::PushLeft).await;
    assert_close(pixel(&push, 2, 2), BLUE, 1, "background stays put");
    assert_close(
        pixel(&push, 40, 45),
        RED,
        1,
        "outgoing halfway out to the left",
    );
    assert_close(
        pixel(&push, 120, 45),
        GREEN,
        1,
        "incoming halfway in from the right",
    );
    assert_close(
        pixel(&push, 80, 45),
        BLUE,
        1,
        "the padding gap between them",
    );

    let push = at(ClipTransitionType::PushRight).await;
    assert_close(
        pixel(&push, 40, 45),
        GREEN,
        1,
        "push right: incoming on the left",
    );
    assert_close(
        pixel(&push, 120, 45),
        RED,
        1,
        "push right: outgoing on the right",
    );

    let push = at(ClipTransitionType::PushUp).await;
    assert_close(pixel(&push, 80, 15), RED, 1, "push up: outgoing above");
    assert_close(pixel(&push, 80, 75), GREEN, 1, "push up: incoming below");

    let push = at(ClipTransitionType::PushDown).await;
    assert_close(pixel(&push, 80, 15), GREEN, 1, "push down: incoming above");
    assert_close(pixel(&push, 80, 75), RED, 1, "push down: outgoing below");

    let wipe = at(ClipTransitionType::WipeRight).await;
    assert_close(pixel(&wipe, 2, 2), BLUE, 1, "wipe keeps the background");
    assert_close(
        pixel(&wipe, 40, 45),
        GREEN,
        1,
        "wipe right: revealed on the left",
    );
    assert_close(
        pixel(&wipe, 120, 45),
        RED,
        1,
        "wipe right: not yet on the right",
    );

    let wipe = at(ClipTransitionType::WipeLeft).await;
    assert_close(
        pixel(&wipe, 40, 45),
        RED,
        1,
        "wipe left: not yet on the left",
    );
    assert_close(
        pixel(&wipe, 120, 45),
        GREEN,
        1,
        "wipe left: revealed on the right",
    );

    let wipe = at(ClipTransitionType::WipeDown).await;
    assert_close(
        pixel(&wipe, 80, 25),
        GREEN,
        1,
        "wipe down: revealed at the top",
    );
    assert_close(
        pixel(&wipe, 80, 65),
        RED,
        1,
        "wipe down: not yet at the bottom",
    );

    let wipe = at(ClipTransitionType::WipeUp).await;
    assert_close(pixel(&wipe, 80, 25), RED, 1, "wipe up: not yet at the top");
    assert_close(
        pixel(&wipe, 80, 65),
        GREEN,
        1,
        "wipe up: revealed at the bottom",
    );

    let zoom = at(ClipTransitionType::Zoom).await;
    assert_close(pixel(&zoom, 2, 2), BLUE, 1, "zoom keeps the background");
    assert_close(
        pixel(&zoom, 80, 45),
        [128, 128, 0, 255],
        2,
        "zoom crosses at the middle",
    );
}

#[tokio::test]
async fn overlays_stay_still_while_the_clips_move() {
    let fixture = fixture(true).await;
    let cursor = CursorEvents::default();
    let sides = sides(&fixture, &cursor);
    for kind in [
        ClipTransitionType::PushLeft,
        ClipTransitionType::WipeDown,
        ClipTransitionType::Zoom,
        ClipTransitionType::CrossFade,
    ] {
        let frame = render_transition(&fixture, &sides, &cursor, kind, 0.5).await;
        assert_close(pixel(&frame, 80, 45), YELLOW, 1, &format!("{kind:?}"));
    }
}

#[tokio::test]
async fn preview_and_export_render_the_same_transition_frame() {
    let fixture = fixture(true).await;
    let cursor = CursorEvents::default();
    let sides = sides(&fixture, &cursor);
    for kind in ClipTransitionType::ALL {
        let preview = render_transition(&fixture, &sides, &cursor, kind, 0.42).await;
        let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
        let mut renderer = FrameRenderer::new(&fixture.constants);
        let input = |side: &(DecodedSegmentFrames, ProjectUniforms)| TransitionRenderInput {
            segment_frames: side.0.clone(),
            uniforms: side.1.clone(),
            cursor: &cursor,
            render_display: true,
        };
        let export = match renderer
            .render_transition(
                input(&sides.outgoing),
                input(&sides.incoming),
                kind,
                0.42,
                &mut layers,
            )
            .await
            .expect("export transition")
        {
            Some(frame) => frame,
            None => renderer
                .flush_pipeline()
                .await
                .expect("queued export")
                .expect("export frame"),
        };
        assert_eq!(max_difference(&export, &preview), 0, "{kind:?}");
    }
}
