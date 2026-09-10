use crate::{
    CursorEvents, DecodedFrame, DecodedSegmentFrames, FrameLayout, FrameRenderer,
    ProjectConfiguration, ProjectUniforms, RecordingMeta, RenderOptions, RenderVideoConstants,
    RenderedFrame, RendererLayers, RenderingError, XY, ZoomTransformTimeline,
    frame_pipeline::{RenderSession, finish_encoder_timed, flush_pending_readback},
};
use std::path::Path;

const WIDTH: u32 = 160;
const HEIGHT: u32 = 120;

async fn constants(path: &Path) -> RenderVideoConstants {
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
            camera_size: None,
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
    let cursor = CursorEvents::default();
    let zoom =
        ZoomTransformTimeline::from_project(project, &cursor, 3.0, constants.options.screen_size);
    ProjectUniforms::new(
        constants,
        project,
        frame,
        30,
        XY::new(320, 240),
        &cursor,
        &frames(),
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
    let uniforms = uniforms(constants, project, frame);
    let layout = uniforms.frame_layout();
    let output = FrameRenderer::new(constants)
        .render_immediate(frames(), uniforms, &CursorEvents::default(), true, layers)
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
    late_text.project = project;
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
