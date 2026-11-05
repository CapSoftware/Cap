use crate::{
    CursorEvents, DecodedFrame, DecodedSegmentFrames, FrameLayout, FrameRenderer, LayerPasses,
    ProjectConfiguration, ProjectUniforms, RecordingMeta, RenderOptions, RenderVideoConstants,
    RenderedFrame, RendererLayers, RenderingError, XY, ZoomTransformTimeline,
    frame_pipeline::{RenderSession, finish_encoder_timed, flush_pending_readback},
};
use std::path::Path;

const WIDTH: u32 = 160;
const HEIGHT: u32 = 120;

async fn constants(path: &Path) -> RenderVideoConstants {
    constants_with_camera(path, None).await
}

async fn constants_with_camera(path: &Path, camera_size: Option<XY<u32>>) -> RenderVideoConstants {
    let mut metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "overlay boundary",
        "display": {"path": "unused.mp4", "fps": 30},
        "camera": null, "audio": null, "cursor": null
    }))
    .unwrap();
    metadata.project_path = path.to_path_buf();
    let studio = metadata.studio_meta().unwrap().clone();
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: XY::new(WIDTH, HEIGHT),
            camera_size,
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await
    .expect("Native overlay tests require a real WGPU adapter and device");
    let info = constants._adapter.get_info();
    assert_ne!(info.backend, wgpu::Backend::Noop);
    eprintln!(
        "{}",
        serde_json::json!({
            "test": "overlay_native_boundary",
            "adapter": info.name,
            "backend": format!("{:?}", info.backend),
            "deviceType": format!("{:?}", info.device_type),
            "software": constants.is_software_adapter
        })
    );
    constants
}

fn project() -> ProjectConfiguration {
    ProjectConfiguration {
        background: cap_project::BackgroundConfiguration {
            shadow: 0.0,
            advanced_shadow: None,
            ..Default::default()
        },
        timeline: Some(
            serde_json::from_value(serde_json::json!({
                "segments": [{"recordingSegment": 0, "start": 0.0, "end": 3.0, "timescale": 1.0}],
                "zoomSegments": []
            }))
            .unwrap(),
        ),
        screen_motion_blur: 0.0,
        ..Default::default()
    }
}

fn frames() -> DecodedSegmentFrames {
    DecodedSegmentFrames {
        screen_size: XY::new(WIDTH, HEIGHT),
        screen_frame: Some(DecodedFrame::new(
            [17, 43, 89, 255].repeat(WIDTH as usize * HEIGHT as usize),
            WIDTH,
            HEIGHT,
        )),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    }
}

fn uniforms(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    frame: u32,
) -> ProjectUniforms {
    uniforms_for(constants, project, frame, XY::new(320, 240), &frames())
}

fn uniforms_for(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    frame: u32,
    resolution: XY<u32>,
    segment_frames: &DecodedSegmentFrames,
) -> ProjectUniforms {
    let cursor = CursorEvents::default();
    let zoom =
        ZoomTransformTimeline::from_project(project, &cursor, 3.0, constants.options.screen_size);
    ProjectUniforms::new(
        constants,
        &std::sync::Arc::new(project.clone()),
        frame,
        30,
        resolution,
        &cursor,
        segment_frames,
        3.0,
        &zoom,
    )
}

fn pixels(frame: &RenderedFrame) -> Vec<u8> {
    frame
        .data
        .chunks_exact(frame.padded_bytes_per_row as usize)
        .take(frame.height as usize)
        .flat_map(|row| row[..frame.width as usize * 4].iter().copied())
        .collect()
}

async fn render(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    layers: &mut RendererLayers,
    frame: u32,
) -> (RenderedFrame, FrameLayout) {
    render_for(
        constants,
        project,
        layers,
        frame,
        XY::new(320, 240),
        frames(),
    )
    .await
}

async fn render_for(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    layers: &mut RendererLayers,
    frame: u32,
    resolution: XY<u32>,
    segment_frames: DecodedSegmentFrames,
) -> (RenderedFrame, FrameLayout) {
    let uniforms = uniforms_for(constants, project, frame, resolution, &segment_frames);
    let layout = uniforms.frame_layout();
    let output = FrameRenderer::new(constants)
        .render_immediate(
            segment_frames,
            uniforms,
            &CursorEvents::default(),
            true,
            layers,
        )
        .await
        .expect("Native overlay frame must render");
    (output, layout)
}

fn with_overlay(kind: &str, path: &str) -> ProjectConfiguration {
    let mut project = project();
    let timeline = project.timeline.as_mut().unwrap();
    match kind {
        "image" => timeline.image_segments.push(cap_project::ImageSegment {
            start: 0.0,
            end: 3.0,
            path: path.into(),
            size: cap_project::XY::new(0.6, 0.6),
            ..Default::default()
        }),
        "text" => timeline.text_segments.push(
            serde_json::from_value(serde_json::json!({
                "start": 0.0, "end": 3.0, "content": "Visible text",
                "fontSize": 96.0, "fadeDuration": 0.0
            }))
            .unwrap(),
        ),
        "captions" => {
            project.captions = Some(cap_project::CaptionsData {
                settings: cap_project::CaptionSettings {
                    enabled: true,
                    ..Default::default()
                },
                ..Default::default()
            });
            timeline.caption_segments.push(
                serde_json::from_value(serde_json::json!({
                    "id": "caption", "start": 0.0, "end": 3.0, "text": "Visible caption"
                }))
                .unwrap(),
            );
        }
        "keyboard" => {
            project.keyboard = Some(cap_project::KeyboardData {
                settings: cap_project::KeyboardSettings {
                    enabled: true,
                    ..Default::default()
                },
            });
            timeline.keyboard_segments.push(
                serde_json::from_value(serde_json::json!({
                    "id": "keys", "start": 0.0, "end": 3.0, "displayText": "Command A"
                }))
                .unwrap(),
            );
        }
        _ => panic!("Unknown test overlay"),
    }
    project
}

#[tokio::test]
async fn ordinary_bundle_renders_each_overlay_and_preserves_empty_frame_zero() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 16, 32, 255]))
        .save(directory.path().join("overlay.png"))
        .unwrap();
    std::fs::write(directory.path().join("corrupt.png"), b"invalid image").unwrap();
    let mut full = RendererLayers::new(&constants.device, &constants.queue);
    assert!(full.overlays.is_some());
    let mut configured = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );
    assert!(configured.overlays.is_some());
    let mut restricted = RendererLayers::new_for_preparing_preview(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
        &project(),
    )
    .unwrap();
    assert!(restricted.overlays.is_none());
    let expected = render(&constants, &project(), &mut full, 0).await;
    let actual = render(&constants, &project(), &mut restricted, 0).await;
    assert_eq!(actual.1, expected.1);
    assert_eq!(actual.0.frame_number, 0);
    assert_eq!(expected.0.frame_number, 0);
    assert!(actual.0.width > 0 && actual.0.height > 0);
    assert_eq!(
        pixels(&actual.0).len(),
        actual.0.width as usize * actual.0.height as usize * 4
    );
    assert_eq!(pixels(&actual.0), pixels(&expected.0));
    let baseline = render(&constants, &project(), &mut configured, 30).await;
    for kind in ["image", "text", "captions", "keyboard"] {
        let project = with_overlay(kind, "overlay.png");
        let actual = render(&constants, &project, &mut configured, 30).await;
        let overlays = configured.overlays.as_ref().unwrap();
        let present = match kind {
            "image" => overlays.images.has_content(),
            "text" => !uniforms(&constants, &project, 30).texts.is_empty(),
            "captions" => overlays.captions.has_content(),
            "keyboard" => overlays.keyboard.has_content(),
            _ => unreachable!(),
        };
        assert!(present, "Ordinary {kind} did not prepare content");
        assert_ne!(
            pixels(&actual.0),
            pixels(&baseline.0),
            "Ordinary {kind} was omitted"
        );
        assert!(matches!(
            RendererLayers::new_for_preparing_preview(
                &constants.device,
                &constants.queue,
                constants.is_software_adapter,
                &project,
            ),
            Err(RenderingError::PreparingOverlayContent)
        ));
    }
    let corrupt = render(
        &constants,
        &with_overlay("image", "corrupt.png"),
        &mut configured,
        30,
    )
    .await;
    assert!(!configured.overlays.as_ref().unwrap().images.has_content());
    assert_eq!(pixels(&corrupt.0), pixels(&baseline.0));
}

async fn read_session(
    constants: &RenderVideoConstants,
    session: &mut RenderSession,
    uniforms: &ProjectUniforms,
    encoder: wgpu::CommandEncoder,
) -> Vec<u8> {
    let (previous, _) = finish_encoder_timed(
        session,
        &constants.device,
        &constants.queue,
        uniforms,
        encoder,
    )
    .await
    .unwrap();
    assert!(previous.is_none());
    pixels(
        &flush_pending_readback(session, &constants.device)
            .await
            .unwrap()
            .unwrap(),
    )
}

#[tokio::test]
async fn restricted_late_uniforms_fail_before_prepare_or_direct_render_work() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let project = project();
    let mut layers = RendererLayers::new_for_preparing_preview(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
        &project,
    )
    .unwrap();
    let clean = uniforms(&constants, &project, 30);
    let late_project = uniforms(&constants, &with_overlay("image", "must-not-open.png"), 30);
    let mut late_text = uniforms(&constants, &with_overlay("text", ""), 30);
    assert!(!late_text.texts.is_empty());
    late_text.project = std::sync::Arc::new(project);
    let mut session =
        RenderSession::new(&constants.device, clean.output_size.0, clean.output_size.1);
    let mut encoder = constants.device.create_command_encoder(&Default::default());
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Overlay guard sentinel"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: session.current_texture_view(),
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.25,
                        g: 0.5,
                        b: 0.75,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
    }
    let expected = read_session(&constants, &mut session, &clean, encoder).await;
    for late in [late_project, late_text] {
        for render_display in [false, true] {
            layers.camera_blur_unavailable = true;
            assert!(matches!(
                layers
                    .prepare(
                        &constants,
                        &late,
                        &frames(),
                        &CursorEvents::default(),
                        render_display
                    )
                    .await,
                Err(RenderingError::PreparingOverlayContent)
            ));
            assert!(layers.camera_blur_unavailable);
            let mut encoder = constants.device.create_command_encoder(&Default::default());
            assert!(matches!(
                layers
                    .prepare_with_encoder_timed(
                        &constants,
                        &late,
                        &frames(),
                        &CursorEvents::default(),
                        &mut encoder,
                        render_display
                    )
                    .await,
                Err(RenderingError::PreparingOverlayContent)
            ));
            assert!(layers.camera_blur_unavailable);
            assert!(matches!(
                layers.render(
                    &constants.device,
                    &constants.queue,
                    &mut encoder,
                    &mut session,
                    &late,
                    render_display
                ),
                Err(RenderingError::PreparingOverlayContent)
            ));
            let actual = read_session(&constants, &mut session, &clean, encoder).await;
            assert_eq!(
                actual, expected,
                "Rejected uniforms changed the target texture"
            );
        }
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn cached_background_blur_matches_a_fresh_blur_and_follows_edits() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    // A linear gradient is nearly a fixed point of a symmetric blur, so two
    // strengths can round to identical pixels. A checkerboard cannot.
    let blurred = |blur: f64, from: [u8; 3]| {
        let path = directory
            .path()
            .join(format!("checker-{}-{}-{}.png", from[0], from[1], from[2]));
        if !path.exists() {
            image::RgbaImage::from_fn(64, 48, |x, y| {
                let [r, g, b] = if (x / 2 + y / 2) % 2 == 0 {
                    from
                } else {
                    [16, 32, 200]
                };
                image::Rgba([r, g, b, 255])
            })
            .save(&path)
            .unwrap();
        }
        let mut project = project();
        project.background.source = cap_project::BackgroundSource::Image {
            path: Some(path.to_string_lossy().into_owned()),
        };
        project.background.blur = blur;
        project
    };
    let fresh_layers = || {
        RendererLayers::new_with_options(
            &constants.device,
            &constants.queue,
            constants.is_software_adapter,
        )
    };
    let mut cached = fresh_layers();

    let heavy = blurred(40.0, [255, 96, 32]);
    render(&constants, &heavy, &mut cached, 0).await;
    let reused = pixels(&render(&constants, &heavy, &mut cached, 1).await.0);
    let expected = pixels(&render(&constants, &heavy, &mut fresh_layers(), 1).await.0);
    assert_eq!(reused, expected);

    let light = blurred(10.0, [255, 96, 32]);
    let after_blur_edit = pixels(&render(&constants, &light, &mut cached, 2).await.0);
    assert_ne!(after_blur_edit, reused);
    assert_eq!(
        after_blur_edit,
        pixels(&render(&constants, &light, &mut fresh_layers(), 2).await.0)
    );

    let recolored = blurred(10.0, [32, 200, 96]);
    let after_background_edit = pixels(&render(&constants, &recolored, &mut cached, 3).await.0);
    assert_ne!(after_background_edit, after_blur_edit);
    assert_eq!(
        after_background_edit,
        pixels(
            &render(&constants, &recolored, &mut fresh_layers(), 3)
                .await
                .0
        )
    );

    let smaller = XY::new(200, 150);
    let resized = pixels(
        &render_for(&constants, &recolored, &mut cached, 4, smaller, frames())
            .await
            .0,
    );
    assert_ne!(resized.len(), after_background_edit.len());
    assert_eq!(
        resized,
        pixels(
            &render_for(
                &constants,
                &recolored,
                &mut fresh_layers(),
                4,
                smaller,
                frames()
            )
            .await
            .0
        )
    );
    let restored = pixels(&render(&constants, &recolored, &mut cached, 5).await.0);
    assert_eq!(
        restored,
        pixels(
            &render(&constants, &recolored, &mut fresh_layers(), 5)
                .await
                .0
        )
    );

    assert!(cached.background_blur.has_cached_result());
    let unblurred = blurred(0.0, [32, 200, 96]);
    let after_blur_off = pixels(&render(&constants, &unblurred, &mut cached, 6).await.0);
    assert_eq!(
        after_blur_off,
        pixels(
            &render(&constants, &unblurred, &mut fresh_layers(), 6)
                .await
                .0
        )
    );
    assert!(!cached.background_blur.has_cached_result());
}

fn every_overlay() -> ProjectConfiguration {
    let mut project = with_overlay("image", "overlay.png");
    for kind in ["text", "captions", "keyboard"] {
        let overlay = with_overlay(kind, "");
        let segments = overlay.timeline.unwrap();
        let timeline = project.timeline.as_mut().unwrap();
        timeline.text_segments.extend(segments.text_segments);
        timeline.caption_segments.extend(segments.caption_segments);
        timeline
            .keyboard_segments
            .extend(segments.keyboard_segments);
        project.captions = project.captions.or(overlay.captions);
        project.keyboard = project.keyboard.or(overlay.keyboard);
    }
    let mut badge = cap_project::ShapeSegment::new(
        cap_project::ShapeKind::Badge,
        0.0,
        3.0,
        XY::new(0.8, 0.25),
        4.0 / 3.0,
    );
    badge.animation_in = cap_project::ShapeAnimation::None;
    let mut arrow = cap_project::ShapeSegment::new(
        cap_project::ShapeKind::Arrow,
        0.0,
        3.0,
        XY::new(0.4, 0.6),
        4.0 / 3.0,
    );
    arrow.animation_in = cap_project::ShapeAnimation::None;
    project.timeline.as_mut().unwrap().shape_segments = vec![badge, arrow];
    project
}

type LayerDraw<'a> = &'a dyn Fn(&mut wgpu::RenderPass<'_>);

async fn draw_in_one_pass(
    constants: &RenderVideoConstants,
    uniforms: &ProjectUniforms,
    draws: &[LayerDraw<'_>],
) -> Vec<u8> {
    let mut session = RenderSession::new(
        &constants.device,
        uniforms.output_size.0,
        uniforms.output_size.1,
    );
    let mut encoder = constants.device.create_command_encoder(&Default::default());
    {
        let mut passes = LayerPasses {
            encoder: &mut encoder,
            open: None,
            split: false,
        };
        passes.pass(
            session.current_texture_view(),
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        );
        for draw in draws {
            draw(passes.pass(session.current_texture_view(), wgpu::LoadOp::Load));
        }
    }
    read_session(constants, &mut session, uniforms, encoder).await
}

#[tokio::test]
async fn scissored_overlays_leave_the_full_target_to_the_next_layer_in_their_pass() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 16, 32, 255]))
        .save(directory.path().join("overlay.png"))
        .unwrap();
    let project = every_overlay();
    let uniforms = uniforms(&constants, &project, 30);
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    layers
        .prepare(
            &constants,
            &uniforms,
            &frames(),
            &CursorEvents::default(),
            true,
        )
        .await
        .unwrap();
    let overlays = layers.overlays.as_ref().unwrap();
    assert!(overlays.images.has_content());
    assert!(overlays.keyboard.has_content());
    assert!(overlays.captions.has_content());

    let image = |pass: &mut wgpu::RenderPass<'_>| overlays.images.render(pass);
    let keyboard = |pass: &mut wgpu::RenderPass<'_>| overlays.keyboard.render(pass);
    let captions = |pass: &mut wgpu::RenderPass<'_>| overlays.captions.render(pass);
    let base = draw_in_one_pass(&constants, &uniforms, &[]).await;
    let image_only = draw_in_one_pass(&constants, &uniforms, &[&image]).await;
    let scissored: [(&str, LayerDraw<'_>); 2] = [("keyboard", &keyboard), ("captions", &captions)];
    for (name, scissored) in scissored {
        let alone = draw_in_one_pass(&constants, &uniforms, &[scissored]).await;
        let shared = draw_in_one_pass(&constants, &uniforms, &[scissored, &image]).await;
        let mut image_pixels_outside = 0;
        for (((base, alone), image_only), shared) in base
            .chunks_exact(4)
            .zip(alone.chunks_exact(4))
            .zip(image_only.chunks_exact(4))
            .zip(shared.chunks_exact(4))
        {
            if alone == base {
                assert_eq!(
                    shared, image_only,
                    "{name} left its scissor on the pass it shares with the next layer"
                );
                image_pixels_outside += usize::from(image_only != base);
            }
        }
        assert!(
            image_pixels_outside > 0,
            "the image overlay must draw outside the {name} rect"
        );
    }
}

async fn render_layer_passes(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    split: bool,
    segment_frames: DecodedSegmentFrames,
) -> Vec<u8> {
    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );
    layers.split_layer_passes = split;
    pixels(
        &render_for(
            constants,
            project,
            &mut layers,
            30,
            XY::new(320, 240),
            segment_frames,
        )
        .await
        .0,
    )
}

fn blurred_background(project: &mut ProjectConfiguration) {
    project.background.source = serde_json::from_value(serde_json::json!({
        "type": "gradient", "from": [255, 96, 32], "to": [16, 32, 200], "angle": 90
    }))
    .unwrap();
    project.background.blur = 30.0;
    project.background.padding = 12.0;
}

fn masks(project: &mut ProjectConfiguration) {
    project.timeline.as_mut().unwrap().mask_segments = serde_json::from_value(serde_json::json!([
        {
            "start": 0.0, "end": 3.0, "maskType": "sensitive", "fadeDuration": 0.0,
            "center": {"x": 0.3, "y": 0.35}, "size": {"x": 0.3, "y": 0.3}, "pixelation": 12.0
        },
        {
            "start": 0.0, "end": 3.0, "maskType": "highlight", "fadeDuration": 0.0,
            "center": {"x": 0.7, "y": 0.6}, "size": {"x": 0.25, "y": 0.25}, "darkness": 0.6
        }
    ]))
    .unwrap();
}

fn camera3d(project: &mut ProjectConfiguration, bokeh: bool) {
    project.timeline.as_mut().unwrap().camera3d_segments =
        serde_json::from_value(serde_json::json!([{
            "start": 0.0, "end": 3.0, "transitionIn": 0.0, "transitionOut": 0.0,
            "properties": {"tiltX": 14.0, "tiltY": -10.0, "rotateY": 8.0},
            "blur": {"mode": "radial", "strength": 10.0, "bokeh": bokeh}
        }]))
        .unwrap();
}

fn color_grade(project: &mut ProjectConfiguration) {
    project.color_correction.screen = serde_json::from_value(serde_json::json!({
        "preset": "custom", "intensity": 1.0, "saturation": -0.6, "contrast": 0.4, "vignette": 0.5
    }))
    .unwrap();
}

fn device_frame(project: &mut ProjectConfiguration) {
    project.background.padding = 12.0;
    project.background.frame = Some(cap_project::FrameConfiguration {
        style: cap_project::FrameStyle::MacOS,
        ..Default::default()
    });
    project.background.notch = Some(cap_project::NotchConfiguration {
        enabled: true,
        ..Default::default()
    });
}

// The notch tests' escape hatch: windows-2022 WARP stopped compositing these passes correctly.
fn adapter_cannot_composite(constants: &RenderVideoConstants) -> bool {
    let name = constants._adapter.get_info().name;
    name.contains("Basic Render Driver") || name.to_lowercase().contains("warp")
}

#[tokio::test]
async fn layers_sharing_a_pass_render_like_one_pass_per_layer() {
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    image::RgbaImage::from_pixel(16, 16, image::Rgba([255, 16, 32, 255]))
        .save(directory.path().join("overlay.png"))
        .unwrap();
    type ProjectEdit = fn(&mut ProjectConfiguration);
    let edits: [(&str, ProjectEdit); 6] = [
        ("blurred background", blurred_background),
        ("masks", masks),
        ("camera3d warp with gaussian focus blur", |project| {
            camera3d(project, false)
        }),
        ("camera3d warp with bokeh focus blur", |project| {
            camera3d(project, true)
        }),
        ("color grade", color_grade),
        ("device frame and notch", device_frame),
    ];
    let mut cases = vec![("every overlay", every_overlay())];
    let mut everything = every_overlay();
    for (name, edit) in edits {
        let mut project = project();
        edit(&mut project);
        cases.push((name, project));
        edit(&mut everything);
    }
    cases.push(("everything at once", everything));

    let plain = render_layer_passes(&constants, &project(), false, frames()).await;
    for (name, project) in &cases {
        let shared = render_layer_passes(&constants, project, false, frames()).await;
        let split = render_layer_passes(&constants, project, true, frames()).await;
        if *name == "device frame and notch"
            && shared == plain
            && adapter_cannot_composite(&constants)
        {
            eprintln!("software adapter cannot composite {name}, skipping its frame-change check");
        } else {
            assert_ne!(shared, plain, "{name} did not change the frame");
        }
        assert_eq!(
            shared, split,
            "{name} renders differently when its layers share a pass"
        );
    }

    let camera_constants = constants_with_camera(directory.path(), Some(XY::new(64, 48))).await;
    let camera_frames = || DecodedSegmentFrames {
        camera_frame: Some(DecodedFrame::new(
            [200, 180, 40, 255].repeat(64 * 48),
            64,
            48,
        )),
        segment_has_camera: true,
        ..frames()
    };
    let mut camera_only_transition = project();
    camera_only_transition
        .timeline
        .as_mut()
        .unwrap()
        .scene_segments = serde_json::from_value(serde_json::json!([
        {"start": 0.9, "end": 3.0, "mode": "cameraOnly"}
    ]))
    .unwrap();
    let without_camera = render_layer_passes(&camera_constants, &project(), false, frames()).await;
    for (name, project) in [
        ("camera overlay", project()),
        ("camera-only scene transition", camera_only_transition),
    ] {
        let shared = render_layer_passes(&camera_constants, &project, false, camera_frames()).await;
        let split = render_layer_passes(&camera_constants, &project, true, camera_frames()).await;
        if shared == without_camera && adapter_cannot_composite(&camera_constants) {
            eprintln!("software adapter cannot composite {name}, skipping its camera check");
        } else {
            assert_ne!(shared, without_camera, "{name} did not draw the camera");
        }
        assert_eq!(
            shared, split,
            "{name} renders differently when its layers share a pass"
        );
    }
}

fn red_shape(
    kind: cap_project::ShapeKind,
    from: (f64, f64),
    to: (f64, f64),
) -> cap_project::ShapeSegment {
    cap_project::ShapeSegment {
        start: 0.0,
        end: 3.0,
        kind,
        from: XY::new(from.0, from.1),
        to: XY::new(to.0, to.1),
        stroke_color: "#FF0000".into(),
        stroke_width: 40.0,
        fill: false,
        fill_color: "#0000FF".into(),
        fill_opacity: 1.0,
        shadow: 0.0,
        animation_in: cap_project::ShapeAnimation::None,
        animation_out: cap_project::ShapeAnimation::None,
        ..Default::default()
    }
}

fn with_shapes(shapes: Vec<cap_project::ShapeSegment>) -> ProjectConfiguration {
    let mut project = project();
    project.timeline.as_mut().unwrap().shape_segments = shapes;
    project
}

struct Frame {
    pixels: Vec<u8>,
    width: usize,
    height: usize,
}

impl Frame {
    fn at(&self, x: f64, y: f64) -> [u8; 4] {
        let x = ((x * self.width as f64) as usize).min(self.width - 1);
        let y = ((y * self.height as f64) as usize).min(self.height - 1);
        let index = (y * self.width + x) * 4;
        self.pixels[index..index + 4].try_into().unwrap()
    }
}

async fn render_frame(
    constants: &RenderVideoConstants,
    layers: &mut RendererLayers,
    project: &ProjectConfiguration,
    resolution: XY<u32>,
) -> Frame {
    let (frame, _) = render_for(constants, project, layers, 30, resolution, frames()).await;
    Frame {
        pixels: pixels(&frame),
        width: frame.width as usize,
        height: frame.height as usize,
    }
}

fn close(actual: [u8; 4], expected: [u8; 3], tolerance: u8) -> bool {
    actual[..3]
        .iter()
        .zip(expected)
        .all(|(a, e)| a.abs_diff(e) <= tolerance)
}

#[tokio::test]
async fn every_shape_kind_draws_its_outline_and_leaves_the_rest() {
    use cap_project::ShapeKind;
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let resolution = XY::new(640, 480);
    let base = render_frame(&constants, &mut layers, &project(), resolution).await;
    let red = [255, 0, 0];
    let blue = [0, 0, 255];

    let rect = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![red_shape(
            ShapeKind::Rectangle,
            (0.25, 0.25),
            (0.75, 0.75),
        )]),
        resolution,
    )
    .await;
    assert!(
        close(rect.at(0.25, 0.5), red, 2),
        "{:?}",
        rect.at(0.25, 0.5)
    );
    assert!(close(rect.at(0.5, 0.25), red, 2));
    assert_eq!(rect.at(0.5, 0.5), base.at(0.5, 0.5));
    assert_eq!(rect.at(0.1, 0.1), base.at(0.1, 0.1));
    assert_eq!(rect.at(0.9, 0.5), base.at(0.9, 0.5));

    let mut filled = red_shape(ShapeKind::Rectangle, (0.25, 0.25), (0.75, 0.75));
    filled.fill = true;
    let filled = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![filled]),
        resolution,
    )
    .await;
    assert!(close(filled.at(0.5, 0.5), blue, 2));
    assert!(close(filled.at(0.25, 0.5), red, 2));

    let ellipse = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![red_shape(
            ShapeKind::Ellipse,
            (0.25, 0.25),
            (0.75, 0.75),
        )]),
        resolution,
    )
    .await;
    assert!(close(ellipse.at(0.25, 0.5), red, 2));
    assert!(close(ellipse.at(0.5, 0.75), red, 2));
    assert_eq!(ellipse.at(0.28, 0.28), base.at(0.28, 0.28));
    assert_eq!(ellipse.at(0.5, 0.5), base.at(0.5, 0.5));

    let arrow = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![red_shape(ShapeKind::Arrow, (0.2, 0.5), (0.8, 0.5))]),
        resolution,
    )
    .await;
    assert!(close(arrow.at(0.5, 0.5), red, 2));
    assert!(
        close(arrow.at(0.78, 0.5), red, 2),
        "the head reaches the tip"
    );
    assert!(
        close(arrow.at(0.72, 0.47), red, 2),
        "the head is wider than the shaft"
    );
    assert_eq!(arrow.at(0.5, 0.47), base.at(0.5, 0.47));
    assert_eq!(arrow.at(0.85, 0.5), base.at(0.85, 0.5));

    let line = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![red_shape(ShapeKind::Line, (0.2, 0.5), (0.8, 0.5))]),
        resolution,
    )
    .await;
    assert!(close(line.at(0.5, 0.5), red, 2));
    assert_eq!(line.at(0.72, 0.47), base.at(0.72, 0.47));

    let mut highlight = red_shape(ShapeKind::Highlight, (0.25, 0.25), (0.75, 0.75));
    highlight.fill = true;
    highlight.fill_color = "#FFFF00".into();
    highlight.fill_opacity = 0.5;
    highlight.stroke_width = 0.0;
    let highlight = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![highlight]),
        resolution,
    )
    .await;
    let under = base.at(0.5, 0.5);
    let tinted = highlight.at(0.5, 0.5);
    let expected = [
        (f32::from(under[0]) * 0.5 + 127.5).round() as u8,
        (f32::from(under[1]) * 0.5 + 127.5).round() as u8,
        (f32::from(under[2]) * 0.5).round() as u8,
    ];
    assert!(close(tinted, expected, 2), "{tinted:?} vs {expected:?}");

    let mut badge = red_shape(ShapeKind::Badge, (0.4, 0.3), (0.6, 0.7));
    badge.fill = true;
    badge.fill_color = "#0000FF".into();
    badge.stroke_width = 0.0;
    badge.number = 8;
    let badge_frame = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![badge]),
        resolution,
    )
    .await;
    assert!(close(badge_frame.at(0.5 - 0.1 * 0.75 * 0.75, 0.5), blue, 2));
    assert_eq!(badge_frame.at(0.39, 0.5), base.at(0.39, 0.5));
    let mut light = 0;
    let (mut sum_y, mut count) = (0.0, 0.0);
    let radius = badge_frame.width.min(badge_frame.height) as f64 * 0.2 * 0.6;
    let (center_x, center_y) = (
        badge_frame.width as f64 * 0.5,
        badge_frame.height as f64 * 0.5,
    );
    for y in 0..badge_frame.height {
        for x in 0..badge_frame.width {
            if (x as f64 + 0.5 - center_x).hypot(y as f64 + 0.5 - center_y) > radius {
                continue;
            }
            let pixel = badge_frame.at(
                (x as f64 + 0.5) / badge_frame.width as f64,
                (y as f64 + 0.5) / badge_frame.height as f64,
            );
            if pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200 {
                light += 1;
                sum_y += y as f64;
                count += 1.0;
            }
        }
    }
    assert!(light > 20, "the badge number must draw");
    let centroid = sum_y / count / badge_frame.height as f64;
    eprintln!("badge digit vertical centroid {centroid:.4}");
    // The default sans-serif differs per platform (Helvetica, DejaVu Sans,
    // Arial) and so do its ascent and descent, which moves the ink by about
    // 1% of this frame's height off Apple's exact centre.
    assert!((centroid - 0.5).abs() < 0.015, "digit centroid {centroid}");
    assert!(layers.overlays.as_ref().unwrap().shapes.labels_created());

    let mut shadowed = red_shape(ShapeKind::Rectangle, (0.25, 0.25), (0.75, 0.75));
    shadowed.shadow = 1.0;
    let shadowed = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![shadowed]),
        resolution,
    )
    .await;
    let below = shadowed.at(0.5, 0.775);
    let plain = base.at(0.5, 0.775);
    assert!(
        below[..3].iter().zip(&plain[..3]).all(|(s, p)| s <= p) && below != plain,
        "the shadow darkens below the shape: {below:?} vs {plain:?}"
    );
}

#[tokio::test]
async fn shape_opacity_fades_the_composited_stroke_fill_and_shadow() {
    use cap_project::ShapeKind;

    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let resolution = XY::new(320, 240);
    let base = render_frame(&constants, &mut layers, &project(), resolution).await;
    let mut failures = Vec::new();
    for kind in [
        ShapeKind::Rectangle,
        ShapeKind::Ellipse,
        ShapeKind::Highlight,
        ShapeKind::Arrow,
        ShapeKind::Line,
    ] {
        for fill_opacity in [0.0, 0.4, 1.0] {
            for shadow in [0.0, 1.0] {
                let mut shape = red_shape(kind, (0.25, 0.25), (0.75, 0.75));
                shape.fill = true;
                shape.fill_opacity = fill_opacity;
                shape.shadow = shadow;
                let opaque = render_frame(
                    &constants,
                    &mut layers,
                    &with_shapes(vec![shape.clone()]),
                    resolution,
                )
                .await;
                assert_ne!(opaque.pixels, base.pixels);
                for opacity in [0.25, 0.5, 0.75] {
                    shape.opacity = opacity;
                    let faded = render_frame(
                        &constants,
                        &mut layers,
                        &with_shapes(vec![shape.clone()]),
                        resolution,
                    )
                    .await;
                    let worst = faded
                        .pixels
                        .iter()
                        .zip(&opaque.pixels)
                        .zip(&base.pixels)
                        .map(|((&actual, &opaque), &base)| {
                            let expected = (f32::from(opaque) * opacity
                                + f32::from(base) * (1.0 - opacity))
                                .round() as u8;
                            actual.abs_diff(expected)
                        })
                        .max()
                        .unwrap();
                    if worst > 2 {
                        failures.push(format!("{kind:?} fill {fill_opacity} shadow {shadow} opacity {opacity}: worst channel error {worst}/255"));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn a_circle_centred_on_a_pixel_leaves_its_centre_clear() {
    use cap_project::ShapeKind;
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let resolution = XY::new(640, 480);
    let base = render_frame(&constants, &mut layers, &project(), resolution).await;
    let (width, height) = (base.width as f64, base.height as f64);
    let (cx, cy, radius) = (
        (base.width / 2) as f64 + 0.5,
        (base.height / 2) as f64 + 0.5,
        100.0,
    );
    let circle = red_shape(
        ShapeKind::Ellipse,
        ((cx - radius) / width, (cy - radius) / height),
        ((cx + radius) / width, (cy + radius) / height),
    );
    let frame = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![circle]),
        resolution,
    )
    .await;
    assert!(close(
        frame.at((cx - radius) / width, cy / height),
        [255, 0, 0],
        2
    ));
    assert_eq!(
        frame.at(cx / width, cy / height),
        base.at(cx / width, cy / height)
    );
}

#[tokio::test]
async fn shapes_match_across_output_resolutions() {
    use cap_project::ShapeKind;
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let mut filled = red_shape(ShapeKind::Ellipse, (0.55, 0.2), (0.85, 0.6));
    filled.fill = true;
    filled.fill_opacity = 0.6;
    filled.shadow = 0.6;
    let project = with_shapes(vec![
        red_shape(ShapeKind::Arrow, (0.1, 0.8), (0.5, 0.3)),
        red_shape(ShapeKind::Rectangle, (0.1, 0.1), (0.4, 0.45)),
        filled,
    ]);
    let small = render_frame(&constants, &mut layers, &project, XY::new(640, 480)).await;
    let large = render_frame(&constants, &mut layers, &project, XY::new(1280, 960)).await;
    assert_eq!(large.width, small.width * 2);
    assert_eq!(large.height, small.height * 2);
    let mut total = 0u64;
    let mut worst = 0u8;
    let mut differing = 0usize;
    for y in 0..small.height {
        for x in 0..small.width {
            for channel in 0..3 {
                let sum: u32 = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .iter()
                    .map(|(dx, dy)| {
                        let index = ((y * 2 + dy) * large.width + x * 2 + dx) * 4 + channel;
                        u32::from(large.pixels[index])
                    })
                    .sum();
                let downsampled = ((sum + 2) / 4) as u8;
                let diff = downsampled.abs_diff(small.pixels[(y * small.width + x) * 4 + channel]);
                total += u64::from(diff);
                worst = worst.max(diff);
                differing += usize::from(diff > 24);
            }
        }
    }
    let mean = total as f64 / (small.width * small.height * 3) as f64;
    eprintln!("shape resolution parity: mean {mean:.3}, worst {worst}, over 24: {differing}");
    assert!(mean < 1.0, "mean difference {mean}");
    assert!(
        differing < small.width * small.height / 200,
        "{differing} channels differ by more than 24"
    );
}

#[tokio::test]
async fn shape_tracks_follow_the_saved_overlay_order() {
    use cap_project::{OverlayTrack, OverlayTrackKind, ShapeKind};
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let resolution = XY::new(640, 480);
    let mut top = red_shape(ShapeKind::Rectangle, (0.3, 0.3), (0.7, 0.7));
    top.fill = true;
    top.fill_color = "#00FF00".into();
    top.stroke_width = 0.0;
    top.track = 1;
    let mut bottom = red_shape(ShapeKind::Rectangle, (0.3, 0.3), (0.7, 0.7));
    bottom.fill = true;
    bottom.stroke_width = 0.0;
    let mut project = with_shapes(vec![top, bottom]);
    let shape = |track| OverlayTrack {
        kind: OverlayTrackKind::Shape,
        track,
    };
    project.set_overlay_order(vec![shape(1), shape(0)]);
    let green_on_top = render_frame(&constants, &mut layers, &project, resolution).await;
    assert!(close(green_on_top.at(0.5, 0.5), [0, 255, 0], 2));
    project.set_overlay_order(vec![shape(0), shape(1)]);
    let blue_on_top = render_frame(&constants, &mut layers, &project, resolution).await;
    assert!(close(blue_on_top.at(0.5, 0.5), [0, 0, 255], 2));

    let plain = render_frame(
        &constants,
        &mut layers,
        &with_shapes(vec![red_shape(
            ShapeKind::Rectangle,
            (0.25, 0.25),
            (0.75, 0.75),
        )]),
        resolution,
    )
    .await;
    let mut mixed = with_shapes(vec![red_shape(
        ShapeKind::Rectangle,
        (0.25, 0.25),
        (0.75, 0.75),
    )]);
    mixed.set_overlay_order(vec![shape(0)]);
    let mixed = render_frame(&constants, &mut layers, &mixed, resolution).await;
    assert_eq!(plain.pixels, mixed.pixels);
}

#[tokio::test]
async fn the_instance_buffer_grows_once_for_a_hundred_shapes() {
    use cap_project::ShapeKind;
    let directory = tempfile::tempdir().unwrap();
    let constants = constants(directory.path()).await;
    let mut layers = RendererLayers::new(&constants.device, &constants.queue);
    let shapes = (0..100)
        .map(|index| {
            let x = 0.05 + (index % 10) as f64 * 0.09;
            let y = 0.05 + (index / 10) as f64 * 0.09;
            let kind = ShapeKind::ALL[index % ShapeKind::ALL.len()];
            let mut shape = red_shape(kind, (x, y), (x + 0.07, y + 0.07));
            shape.stroke_width = 6.0;
            shape.track = (index % 3) as u32;
            shape
        })
        .collect::<Vec<_>>();
    let crowded = with_shapes(shapes);
    let resolution = XY::new(640, 480);
    let first = render_frame(&constants, &mut layers, &crowded, resolution).await;
    let capacity = layers.overlays.as_ref().unwrap().shapes.instance_capacity();
    assert_eq!(capacity, 128);
    let second = render_frame(&constants, &mut layers, &crowded, resolution).await;
    assert_eq!(
        layers.overlays.as_ref().unwrap().shapes.instance_capacity(),
        capacity
    );
    assert_eq!(first.pixels, second.pixels);
    let base = render_frame(&constants, &mut layers, &project(), resolution).await;
    assert!(!layers.overlays.as_ref().unwrap().shapes.has_content());
    assert_ne!(first.pixels, base.pixels);
}
