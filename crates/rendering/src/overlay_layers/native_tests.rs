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
