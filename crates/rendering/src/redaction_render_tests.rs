use super::*;
use cap_project::{
    AutoRedactConfiguration, BackgroundSource, RedactCategory, RedactStyle,
    redaction::{REDACTIONS_VERSION, RedactionKey, RedactionRegion, Redactions},
};

struct Fixture {
    constants: RenderVideoConstants,
    screen: XY<u32>,
}

async fn fixture(screen: XY<u32>) -> Fixture {
    let instance = create_wgpu_instance_sync();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            force_fallback_adapter: force_software_wgpu_adapter(),
            ..Default::default()
        })
        .await
        .expect("graphics adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .expect("graphics device");
    let recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "redact-test",
        "display": { "path": "display.mp4", "fps": 60 },
        "camera": null, "audio": null, "cursor": null
    }))
    .expect("metadata");
    Fixture {
        constants: RenderVideoConstants {
            adapter_name: adapter.get_info().name,
            _instance: instance,
            _adapter: adapter,
            device,
            queue,
            options: RenderOptions {
                screen_size: screen,
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
            audio_levels: Default::default(),
            camera_picture: Default::default(),
            redactions: Default::default(),
        },
        screen,
    }
}

fn project(redact: AutoRedactConfiguration) -> Arc<ProjectConfiguration> {
    let mut project = ProjectConfiguration::default();
    project.background.source = BackgroundSource::Color {
        value: [0, 0, 0],
        alpha: 255,
    };
    project.background.padding = 0.0;
    project.background.rounding = 0.0;
    project.background.shadow = 0.0;
    project.timeline = Some(
        serde_json::from_value(serde_json::json!({ "segments": [], "zoomSegments": [] }))
            .expect("timeline"),
    );
    project.auto_redact = redact;
    Arc::new(project)
}

fn region(id: &str, x: f32, y: f32, w: f32, h: f32) -> RedactionRegion {
    RedactionRegion {
        id: id.into(),
        segment: 0,
        category: RedactCategory::Email,
        start: 0.0,
        end: 5.0,
        keys: vec![RedactionKey { t: 0.0, x, y, w, h }],
    }
}

fn pattern(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let v = ((x * 37 + y * 11) % 200 + 30) as u8;
            let ink = if (x / 3 + y / 5) % 2 == 0 { 20 } else { v };
            data.extend_from_slice(&[ink, v, 255 - v, 255]);
        }
    }
    data
}

async fn render(
    fixture: &Fixture,
    layers: &mut RendererLayers,
    project: &Arc<ProjectConfiguration>,
    frame: &DecodedFrame,
    time: f32,
) -> Vec<u8> {
    let cursor = CursorEvents::default();
    let zoom = ZoomTransformTimeline::from_project(project, &cursor, 10.0, fixture.screen);
    let frames = DecodedSegmentFrames {
        screen_size: fixture.screen,
        screen_frame: Some(frame.clone()),
        camera_frame: None,
        segment_time: time,
        recording_time: time,
        segment_has_camera: false,
        display_placeholder: false,
    };
    let uniforms = ProjectUniforms::new(
        &fixture.constants,
        project,
        60,
        60,
        fixture.screen,
        &cursor,
        &frames,
        10.0,
        &zoom,
    )
    .with_quality(RenderQuality::Export)
    .with_redaction(&fixture.constants, 0, time);
    let mut renderer = FrameRenderer::new(&fixture.constants);
    let rendered = renderer
        .render_immediate(frames, uniforms, &cursor, true, layers)
        .await
        .expect("frame");
    let mut out = Vec::with_capacity((rendered.width * rendered.height * 4) as usize);
    for y in 0..rendered.height {
        let start = (y * rendered.padded_bytes_per_row) as usize;
        out.extend_from_slice(&rendered.data[start..start + (rendered.width * 4) as usize]);
    }
    out
}

fn on(style: RedactStyle) -> AutoRedactConfiguration {
    AutoRedactConfiguration {
        enabled: true,
        style,
        ..Default::default()
    }
}

fn redactions(regions: Vec<RedactionRegion>) -> Arc<Redactions> {
    Arc::new(Redactions {
        version: REDACTIONS_VERSION,
        model: "test".into(),
        scanner: 0,
        segments: Vec::new(),
        regions,
    })
}

fn px(data: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

#[tokio::test]
async fn off_renders_the_same_bytes_with_or_without_detections() {
    let size = XY::new(320, 180);
    let fixture = fixture(size).await;
    let frame = DecodedFrame::new(pattern(size.x, size.y), size.x, size.y);
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let off = project(AutoRedactConfiguration::default());
    let before = render(&fixture, &mut layers, &off, &frame, 1.0).await;
    fixture
        .constants
        .redactions
        .set(Some(redactions(vec![region("a", 0.1, 0.1, 0.4, 0.2)])));
    let mut fresh = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let after = render(&fixture, &mut fresh, &off, &frame, 1.0).await;
    assert!(before == after, "a disabled redaction changed the frame");
}

#[tokio::test]
async fn pixelation_covers_the_region_and_nothing_else() {
    let size = XY::new(320, 180);
    let fixture = fixture(size).await;
    let frame = DecodedFrame::new(pattern(size.x, size.y), size.x, size.y);
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let plain = render(
        &fixture,
        &mut layers,
        &project(AutoRedactConfiguration::default()),
        &frame,
        1.0,
    )
    .await;
    fixture
        .constants
        .redactions
        .set(Some(redactions(vec![region("a", 0.25, 0.25, 0.5, 0.2)])));
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let hidden = render(
        &fixture,
        &mut layers,
        &project(on(RedactStyle::Pixelate)),
        &frame,
        1.0,
    )
    .await;
    let (x0, y0, x1, y1) = (79, 41, 241, 85);
    let block = crate::redaction::block_size((y1 - y0) as f32, 0.5, RedactStyle::Pixelate);
    let mut changed_outside = 0;
    let mut changed_inside = 0;
    for y in 0..size.y {
        for x in 0..size.x {
            let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
            let differs = px(&plain, size.x, x, y) != px(&hidden, size.x, x, y);
            if inside {
                changed_inside += usize::from(differs);
            } else {
                changed_outside += usize::from(differs);
            }
        }
    }
    assert_eq!(changed_outside, 0, "pixels outside the region changed");
    assert!(
        changed_inside > ((x1 - x0) * (y1 - y0)) as usize * 8 / 10,
        "only {changed_inside} pixels inside changed"
    );
    let mut distinct = std::collections::HashSet::new();
    for y in (y0..y1).step_by(block as usize) {
        for x in (x0..x1).step_by(block as usize) {
            let a = px(&hidden, size.x, x, y);
            for dy in 0..block.min(y1 - y) {
                for dx in 0..block.min(x1 - x) {
                    assert_eq!(
                        px(&hidden, size.x, x + dx, y + dy),
                        a,
                        "block at {x},{y} is not flat"
                    );
                }
            }
            distinct.insert(a);
        }
    }
    assert!(distinct.len() > 1, "every block came out the same");
}

#[tokio::test]
async fn a_reused_frame_follows_changed_regions() {
    let size = XY::new(320, 180);
    let fixture = fixture(size).await;
    let frame = DecodedFrame::new(pattern(size.x, size.y), size.x, size.y);
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let plain = render(
        &fixture,
        &mut layers,
        &project(AutoRedactConfiguration::default()),
        &frame,
        1.0,
    )
    .await;
    fixture.constants.redactions.set(Some(redactions(vec![
        region("a", 0.05, 0.05, 0.3, 0.15),
        region("b", 0.5, 0.6, 0.3, 0.15),
    ])));
    let enabled = project(on(RedactStyle::Pixelate));
    let both = render(&fixture, &mut layers, &enabled, &frame, 1.0).await;
    assert_ne!(px(&both, size.x, 40, 15), px(&plain, size.x, 40, 15));
    let mut keep_a = on(RedactStyle::Pixelate);
    keep_a.excluded.push("a".into());
    let only_b = render(&fixture, &mut layers, &project(keep_a), &frame, 1.0).await;
    for y in 9..36 {
        for x in 16..112 {
            assert_eq!(
                px(&only_b, size.x, x, y),
                px(&plain, size.x, x, y),
                "region a stayed hidden at {x},{y} after it was kept"
            );
        }
    }
    assert_ne!(px(&only_b, size.x, 200, 120), px(&plain, size.x, 200, 120));
    let off = render(
        &fixture,
        &mut layers,
        &project(AutoRedactConfiguration::default()),
        &frame,
        1.0,
    )
    .await;
    assert!(
        off == plain,
        "turning auto redact off left marks on a reused frame"
    );
}

#[tokio::test]
async fn blur_hides_the_region_too() {
    let size = XY::new(320, 180);
    let fixture = fixture(size).await;
    let frame = DecodedFrame::new(pattern(size.x, size.y), size.x, size.y);
    fixture
        .constants
        .redactions
        .set(Some(redactions(vec![region("a", 0.25, 0.25, 0.5, 0.2)])));
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let blurred = render(
        &fixture,
        &mut layers,
        &project(on(RedactStyle::Blur)),
        &frame,
        1.0,
    )
    .await;
    let source = pattern(size.x, size.y);
    let mut original_contrast = 0u64;
    let mut blurred_contrast = 0u64;
    for y in 46..80 {
        for x in 81..239 {
            let a = u64::from(px(&source, size.x, x, y)[0]);
            let b = u64::from(px(&source, size.x, x - 1, y)[0]);
            original_contrast += a.abs_diff(b);
            let a = u64::from(px(&blurred, size.x, x, y)[0]);
            let b = u64::from(px(&blurred, size.x, x - 1, y)[0]);
            blurred_contrast += a.abs_diff(b);
        }
    }
    assert!(
        blurred_contrast * 10 < original_contrast,
        "blur kept too much detail: {blurred_contrast} vs {original_contrast}"
    );
}

/// GPU cost of the pass at 4K with a realistic number of regions. Run with
/// `cargo test -p cap-rendering --release --lib redaction_gpu_cost -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "benchmark"]
async fn redaction_gpu_cost() {
    let size = XY::new(3840, 2160);
    let fixture = fixture(size).await;
    let device = &fixture.constants.device;
    let queue = &fixture.constants.queue;
    let texture = crate::composite_frame::CompositeVideoFramePipeline::create_frame_texture(
        device, size.x, size.y,
    );
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &pattern(size.x, size.y),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(size.x * 4),
            rows_per_image: Some(size.y),
        },
        wgpu::Extent3d {
            width: size.x,
            height: size.y,
            depth_or_array_layers: 1,
        },
    );
    let mut redactor = crate::redaction::Redactor::new(device);
    for count in [1usize, 10, 40] {
        let frame = crate::redaction::RedactionFrame {
            rects: (0..count)
                .map(|i| crate::redaction::RedactionRect {
                    x: 0.05 + (i % 4) as f32 * 0.22,
                    y: 0.04 + (i / 4) as f32 * 0.09,
                    w: 0.18,
                    h: 0.022,
                    highlighted: false,
                })
                .collect(),
            style: RedactStyle::Pixelate,
            amount: 0.5,
        };
        let mut samples = Vec::new();
        for round in 0..60 {
            let mut encoder = device.create_command_encoder(&Default::default());
            redactor.encode(device, queue, &mut encoder, &texture, &frame);
            let started = std::time::Instant::now();
            queue.submit([encoder.finish()]);
            device.poll(wgpu::PollType::Wait).expect("poll");
            if round >= 10 {
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "4K redaction, {count} regions: p50 {:.3} ms, p95 {:.3} ms (submit + wait)",
            samples[samples.len() / 2],
            samples[samples.len() * 95 / 100]
        );
    }
    let mut samples = Vec::new();
    for round in 0..60 {
        let encoder = device.create_command_encoder(&Default::default());
        let started = std::time::Instant::now();
        queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::Wait).expect("poll");
        if round >= 10 {
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    samples.sort_by(f64::total_cmp);
    eprintln!(
        "empty submit baseline: p50 {:.3} ms, p95 {:.3} ms",
        samples[samples.len() / 2],
        samples[samples.len() * 95 / 100]
    );
}
