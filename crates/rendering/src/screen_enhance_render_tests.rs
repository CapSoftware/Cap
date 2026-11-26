use super::*;
use cap_project::{BackgroundSource, ScreenEnhancement};

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
        "pretty_name": "enhance-test",
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
            camera_picture: Default::default(),
            background_textures: Arc::new(BackgroundTextureCache::default()),
            is_software_adapter: false,
            audio_levels: Default::default(),
        },
        screen,
    }
}

fn project(enhancement: ScreenEnhancement) -> Arc<ProjectConfiguration> {
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
    project.screen_enhancement = enhancement;
    Arc::new(project)
}

async fn render(
    fixture: &Fixture,
    project: &Arc<ProjectConfiguration>,
    pixels: &[u8],
    scale: f32,
    quality: RenderQuality,
) -> RenderedFrame {
    let cursor = CursorEvents::default();
    let zoom = ZoomTransformTimeline::from_project(project, &cursor, 10.0, fixture.screen);
    let frames = DecodedSegmentFrames {
        screen_size: fixture.screen,
        screen_frame: Some(DecodedFrame::new(
            pixels.to_vec(),
            fixture.screen.x,
            fixture.screen.y,
        )),
        camera_frame: None,
        segment_time: 1.0,
        recording_time: 1.0,
        segment_has_camera: false,
    };
    let resolution = XY::new(
        (fixture.screen.x as f32 * scale).round() as u32,
        (fixture.screen.y as f32 * scale).round() as u32,
    );
    let uniforms = ProjectUniforms::new(
        &fixture.constants,
        project,
        60,
        60,
        resolution,
        &cursor,
        &frames,
        10.0,
        &zoom,
    )
    .with_quality(quality);
    let mut layers = RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
    let mut renderer = FrameRenderer::new(&fixture.constants);
    renderer
        .render_immediate(frames, uniforms, &cursor, true, &mut layers)
        .await
        .expect("frame")
}

fn rgba(frame: &RenderedFrame) -> Vec<u8> {
    let mut out = Vec::with_capacity((frame.width * frame.height * 4) as usize);
    for y in 0..frame.height {
        let start = (y * frame.padded_bytes_per_row) as usize;
        out.extend_from_slice(&frame.data[start..start + (frame.width * 4) as usize]);
    }
    out
}

fn luma_at(frame: &RenderedFrame, x: u32, y: u32) -> u8 {
    let offset = (y * frame.padded_bytes_per_row + x * 4) as usize;
    frame.data[offset + 1]
}

fn edge_pattern(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let dark = (x / 7 + y / 9) % 2 == 0;
            let value = if dark { 64 } else { 192 };
            data.extend_from_slice(&[value, value, value, 255]);
        }
    }
    data
}

fn staircase(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let value = if y < height / 4 {
                if x % 40 < 20 { 30 } else { 220 }
            } else {
                100 + (x / 24) as u8
            };
            data.extend_from_slice(&[value, value, value, 255]);
        }
    }
    data
}

#[tokio::test]
async fn enhancement_off_exports_exactly_like_main() {
    let fixture = fixture(XY::new(96, 64)).await;
    let pixels = edge_pattern(96, 64);
    let off = project(ScreenEnhancement::default());
    for scale in [0.5, 0.75, 1.0, 2.0] {
        let playback = render(&fixture, &off, &pixels, scale, RenderQuality::Playback).await;
        let export = render(&fixture, &off, &pixels, scale, RenderQuality::Export).await;
        assert_eq!(rgba(&playback), rgba(&export), "scale {scale}");
    }
}

#[tokio::test]
async fn playback_never_enhances() {
    let fixture = fixture(XY::new(96, 64)).await;
    let pixels = edge_pattern(96, 64);
    let off = project(ScreenEnhancement::default());
    let on = project(ScreenEnhancement::on());
    for scale in [0.5, 0.75, 1.0, 2.0] {
        let plain = render(&fixture, &off, &pixels, scale, RenderQuality::Export).await;
        let playing = render(&fixture, &on, &pixels, scale, RenderQuality::Playback).await;
        assert_eq!(rgba(&plain), rgba(&playing), "scale {scale}");
    }
}

#[tokio::test]
async fn software_adapters_export_without_enhancement() {
    let mut fixture = fixture(XY::new(96, 64)).await;
    fixture.constants.is_software_adapter = true;
    let pixels = edge_pattern(96, 64);
    let off = project(ScreenEnhancement::default());
    let on = project(ScreenEnhancement::on());
    for scale in [0.5, 0.75, 1.0, 2.0] {
        let plain = render(&fixture, &off, &pixels, scale, RenderQuality::Export).await;
        let enhanced = render(&fixture, &on, &pixels, scale, RenderQuality::Export).await;
        assert_eq!(rgba(&plain), rgba(&enhanced), "scale {scale}");
    }
}

#[tokio::test]
async fn paused_preview_matches_export() {
    let fixture = fixture(XY::new(96, 64)).await;
    let pixels = edge_pattern(96, 64);
    let on = project(ScreenEnhancement::on());
    let paused = render(&fixture, &on, &pixels, 2.0, RenderQuality::PausedPreview).await;
    let export = render(&fixture, &on, &pixels, 2.0, RenderQuality::Export).await;
    assert_eq!(rgba(&paused), rgba(&export));
}

#[tokio::test]
async fn export_upscale_sharpens_edges_without_ringing() {
    let fixture = fixture(XY::new(96, 64)).await;
    let pixels = edge_pattern(96, 64);
    let plain = render(
        &fixture,
        &project(ScreenEnhancement::default()),
        &pixels,
        2.0,
        RenderQuality::Export,
    )
    .await;
    let enhanced = render(
        &fixture,
        &project(ScreenEnhancement::on()),
        &pixels,
        2.0,
        RenderQuality::Export,
    )
    .await;
    assert_ne!(rgba(&plain), rgba(&enhanced));

    let soft = |frame: &RenderedFrame| {
        let mut count = 0;
        for y in 0..frame.height {
            for x in 0..frame.width {
                let value = luma_at(frame, x, y);
                if (72..=184).contains(&value) {
                    count += 1;
                }
            }
        }
        count
    };
    assert!(
        soft(&enhanced) < soft(&plain),
        "enhanced {} vs plain {} transition pixels",
        soft(&enhanced),
        soft(&plain)
    );
    // The outermost pixels are the card's anti-aliased edge, darker than the
    // pattern in the plain render too.
    for y in 2..enhanced.height - 2 {
        for x in 2..enhanced.width - 2 {
            let value = luma_at(&enhanced, x, y);
            assert!((63..=193).contains(&value), "ringing at {x},{y}: {value}");
        }
    }
}

#[tokio::test]
async fn export_shrink_keeps_edges_sharper() {
    let fixture = fixture(XY::new(192, 128)).await;
    let pixels = edge_pattern(192, 128);
    let plain = render(
        &fixture,
        &project(ScreenEnhancement::default()),
        &pixels,
        0.5,
        RenderQuality::Export,
    )
    .await;
    let enhanced = render(
        &fixture,
        &project(ScreenEnhancement::on()),
        &pixels,
        0.5,
        RenderQuality::Export,
    )
    .await;
    assert_ne!(rgba(&plain), rgba(&enhanced));

    // Edge contrast: summed luma steps between horizontal neighbours.
    let contrast = |frame: &RenderedFrame| {
        let mut sum = 0u64;
        for y in 2..frame.height - 2 {
            for x in 2..frame.width - 3 {
                sum += luma_at(frame, x, y).abs_diff(luma_at(frame, x + 1, y)) as u64;
            }
        }
        sum
    };
    assert!(
        contrast(&enhanced) > contrast(&plain),
        "enhanced {} vs plain {} edge contrast",
        contrast(&enhanced),
        contrast(&plain)
    );
}

#[tokio::test]
async fn large_shrinks_render_like_main() {
    let fixture = fixture(XY::new(192, 128)).await;
    let pixels = edge_pattern(192, 128);
    let off = project(ScreenEnhancement::default());
    let on = project(ScreenEnhancement::on());
    let plain = render(&fixture, &off, &pixels, 0.25, RenderQuality::Export).await;
    let enhanced = render(&fixture, &on, &pixels, 0.25, RenderQuality::Export).await;
    assert_eq!(rgba(&plain), rgba(&enhanced));
}

#[tokio::test]
async fn export_deband_smooths_steps_and_keeps_edges() {
    let fixture = fixture(XY::new(240, 96)).await;
    let pixels = staircase(240, 96);
    let plain = render(
        &fixture,
        &project(ScreenEnhancement::default()),
        &pixels,
        1.0,
        RenderQuality::Export,
    )
    .await;
    let enhanced = render(
        &fixture,
        &project(ScreenEnhancement::on()),
        &pixels,
        1.0,
        RenderQuality::Export,
    )
    .await;

    let ramp_error = |frame: &RenderedFrame| {
        let rows = 40..frame.height - 8;
        let columns = 30..frame.width - 30;
        let mut error = 0.0;
        for x in columns.clone() {
            let mean = rows
                .clone()
                .map(|y| f64::from(luma_at(frame, x, y)))
                .sum::<f64>()
                / rows.len() as f64;
            let ideal = 100.0 + (x as f64 - 11.5) / 24.0;
            error += (mean - ideal).abs();
        }
        error / columns.len() as f64
    };
    let plain_error = ramp_error(&plain);
    let enhanced_error = ramp_error(&enhanced);
    assert!(
        enhanced_error < plain_error * 0.85,
        "ramp error {enhanced_error:.3} vs {plain_error:.3}"
    );

    for y in 2..20 {
        for x in 0..enhanced.width {
            let before = luma_at(&plain, x, y);
            let after = luma_at(&enhanced, x, y);
            assert!(
                before.abs_diff(after) <= 1,
                "edge changed at {x},{y}: {before} -> {after}"
            );
        }
    }
}

/// Renders fixture PNGs through the real renderer for the fidelity report:
/// `CAP_ENHANCE_FIXTURES` holds `src_<name>.png` files (the 1x screen) and
/// receives `out_<name>_<quality>.png` for Playback (what main draws) and
/// Export (enhanced). The scale comes from the name's `@<scale>` suffix.
#[tokio::test]
#[ignore]
async fn render_enhancement_fixtures() {
    let Ok(directory) = std::env::var("CAP_ENHANCE_FIXTURES") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let mut sources: Vec<_> = std::fs::read_dir(&directory)
        .expect("fixture directory")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("src_") && name.ends_with(".png"))
        })
        .collect();
    sources.sort();
    for path in sources {
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("name")
            .trim_start_matches("src_")
            .to_string();
        let scale: f32 = name
            .rsplit('@')
            .next()
            .and_then(|scale| scale.parse().ok())
            .expect("scale suffix");
        let image = image::open(&path).expect("fixture image").to_rgba8();
        let fixture = fixture(XY::new(image.width(), image.height())).await;
        for (label, enhancement, quality) in [
            ("main", ScreenEnhancement::default(), RenderQuality::Export),
            ("enhanced", ScreenEnhancement::on(), RenderQuality::Export),
        ] {
            let started = Instant::now();
            let frame = render(
                &fixture,
                &project(enhancement),
                image.as_raw(),
                scale,
                quality,
            )
            .await;
            let elapsed = started.elapsed();
            image::RgbaImage::from_raw(frame.width, frame.height, rgba(&frame))
                .expect("output image")
                .save(directory.join(format!("out_{name}_{label}.png")))
                .expect("save output");
            println!(
                "{name} {label} {}x{} {:.1} ms",
                frame.width,
                frame.height,
                elapsed.as_secs_f64() * 1000.0
            );
        }
    }
}

/// Per-frame GPU cost of enhancement on a 1080p screen: the same frame
/// rendered repeatedly with reused layers, off against on, at 1x (deband
/// only) and 2x (deband and upscale).
#[tokio::test]
#[ignore]
async fn bench_enhancement_frame_time() {
    let screen = XY::new(1920, 1080);
    let fixture = fixture(screen).await;
    let pixels = edge_pattern(screen.x, screen.y);
    let cursor = CursorEvents::default();
    for scale in [1.0f32, 2.0] {
        for (label, enhancement) in [
            ("off", ScreenEnhancement::default()),
            ("on", ScreenEnhancement::on()),
        ] {
            let project = project(enhancement);
            let zoom = ZoomTransformTimeline::from_project(&project, &cursor, 10.0, screen);
            let mut layers =
                RendererLayers::new(&fixture.constants.device, &fixture.constants.queue);
            let mut renderer = FrameRenderer::new(&fixture.constants);
            let mut times = Vec::new();
            for index in 0..40u32 {
                let frames = DecodedSegmentFrames {
                    screen_size: screen,
                    screen_frame: Some(DecodedFrame::new(pixels.clone(), screen.x, screen.y)),
                    camera_frame: None,
                    segment_time: 1.0 + index as f32 / 60.0,
                    recording_time: 1.0 + index as f32 / 60.0,
                    segment_has_camera: false,
                };
                let resolution = XY::new(
                    (screen.x as f32 * scale) as u32,
                    (screen.y as f32 * scale) as u32,
                );
                let uniforms = ProjectUniforms::new(
                    &fixture.constants,
                    &project,
                    60 + index,
                    60,
                    resolution,
                    &cursor,
                    &frames,
                    10.0,
                    &zoom,
                )
                .with_quality(RenderQuality::Export);
                let started = Instant::now();
                renderer
                    .render_immediate(frames, uniforms, &cursor, true, &mut layers)
                    .await
                    .expect("frame");
                if index >= 8 {
                    times.push(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "scale {scale} {label}: median {:.2} ms p90 {:.2} ms ({})",
                times[times.len() / 2],
                times[times.len() * 9 / 10],
                fixture.constants.adapter_name
            );
        }
    }
}
