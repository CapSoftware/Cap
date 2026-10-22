use std::{
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::Instant,
};

use anyhow::{Context, Result, anyhow};
use cap_project::{
    BackgroundSource, CursorClickEvent, CursorEvents, CursorMeta, CursorMoveEvent, Cursors,
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline, decoder::DecodedFrame,
};

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const FPS: u32 = 30;

fn counters() -> (u64, u64) {
    (
        wgpu_hal::PROBE_BIND_GROUPS.load(Ordering::Relaxed),
        wgpu_hal::PROBE_BUFFERS.load(Ordering::Relaxed),
    )
}

fn augment(project: &Path, effects: bool) -> Result<()> {
    let assets = project.join("assets");
    std::fs::create_dir_all(&assets)?;
    let wallpaper = assets.join("cap-wallpaper.jpg");
    image::RgbImage::from_fn(2560, 1440, |x, y| {
        let fx = x as f32 / 2560.0;
        let fy = y as f32 / 1440.0;
        image::Rgb([
            (40.0 + 180.0 * fx) as u8,
            (60.0 + 120.0 * fy) as u8,
            (200.0 - 120.0 * fx * fy) as u8,
        ])
    })
    .save(&wallpaper)?;

    let cursors_dir = project.join("content/cursors");
    std::fs::create_dir_all(&cursors_dir)?;
    for (index, color) in [[20u8, 20, 20], [230, 60, 30]].into_iter().enumerate() {
        image::RgbaImage::from_fn(48, 64, |x, y| {
            let inside = x <= y * 3 / 4 && y < 56;
            let edge = inside && (x + 2 > y * 3 / 4 || y + 3 > 56 || x < 2);
            match (inside, edge) {
                (true, true) => image::Rgba([255, 255, 255, 255]),
                (true, false) => image::Rgba([color[0], color[1], color[2], 255]),
                _ => image::Rgba([0, 0, 0, 0]),
            }
        })
        .save(cursors_dir.join(format!("cursor_{index}.png")))?;
    }

    let mut meta = RecordingMeta::load_for_project(project).map_err(|e| anyhow!("{e}"))?;
    let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
        return Err(anyhow!("not a studio recording"));
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        return Err(anyhow!("not a multi-segment recording"));
    };
    inner.cursors = Cursors::Correct(
        (0..2)
            .map(|index| {
                (
                    index.to_string(),
                    CursorMeta {
                        image_path: format!("content/cursors/cursor_{index}.png").into(),
                        hotspot: XY::new(0.05, 0.03),
                        shape: None,
                    },
                )
            })
            .collect(),
    );
    let cursor_path = "content/segments/segment-0/cursor.json";
    inner.segments[0].cursor = Some(cursor_path.into());
    meta.save_for_project().map_err(|e| anyhow!("{e:?}"))?;

    let duration_ms = 10_000.0;
    let mut moves = Vec::new();
    let mut time_ms = 0.0;
    while time_ms < duration_ms {
        let t = time_ms / 1000.0;
        moves.push(CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: if (t / 1.5) as u32 % 2 == 0 { "0" } else { "1" }.to_string(),
            time_ms,
            x: 0.5 + 0.35 * (t * 0.9).sin(),
            y: 0.5 + 0.3 * (t * 1.3).cos(),
        });
        time_ms += 1000.0 / 60.0;
    }
    let clicks = (0..14)
        .flat_map(|index| {
            let time_ms = 300.0 + index as f64 * 700.0;
            [(time_ms, true), (time_ms + 90.0, false)]
        })
        .map(|(time_ms, down)| CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 0,
            cursor_id: "0".to_string(),
            time_ms,
            down,
        })
        .collect();
    std::fs::write(
        project.join(cursor_path),
        serde_json::to_vec(&CursorEvents { clicks, moves })?,
    )?;

    let mut config = ProjectConfiguration::load(project)?;
    config.background.source = BackgroundSource::Wallpaper {
        path: Some(wallpaper.to_string_lossy().into_owned()),
    };
    config.background.padding = 8.0;
    config.cursor.hide = false;
    if effects {
        config.color_correction.screen.exposure = 0.25;
        config.color_correction.screen.contrast = 0.2;
        let mut timeline = serde_json::to_value(config.timeline.take().context("timeline")?)?;
        let object = timeline.as_object_mut().context("timeline object")?;
        object.insert(
            "maskSegments".into(),
            serde_json::json!([
                {
                    "start": 0.0, "end": 10.0, "maskType": "sensitive",
                    "center": { "x": 0.3, "y": 0.4 }, "size": { "x": 0.25, "y": 0.2 },
                    "feather": 0.1, "pixelation": 1024.0
                },
                {
                    "start": 0.0, "end": 10.0, "maskType": "sensitive",
                    "center": { "x": 0.7, "y": 0.6 }, "size": { "x": 0.2, "y": 0.2 },
                    "pixelation": 18.0
                }
            ]),
        );
        object.insert(
            "camera3dSegments".into(),
            serde_json::json!([{
                "start": 0.0, "end": 10.0,
                "properties": { "tiltX": -12.0, "tiltY": 10.0, "zoom": 2.1 },
                "blur": { "mode": "radial", "strength": 10.0, "falloff": 0.5 }
            }]),
        );
        config.timeline = Some(serde_json::from_value(timeline)?);
    }
    config.write(project)?;
    Ok(())
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
}

async fn bench(project: &Path, frames: u32, hashes: Option<PathBuf>, label: &str) -> Result<()> {
    let recording_meta = RecordingMeta::load_for_project(project).map_err(|e| anyhow!("{e}"))?;
    let meta = recording_meta.studio_meta().context("studio")?.clone();
    let StudioRecordingMeta::MultipleSegments { inner } = &meta else {
        return Err(anyhow!("not a multi-segment recording"));
    };
    let cursor_path = inner.segments[0].cursor.as_ref().context("cursor")?;
    let cursor =
        CursorEvents::load_from_file(&recording_meta.path(cursor_path)).map_err(|e| anyhow!(e))?;
    let project_config = Arc::new(ProjectConfiguration::load(project)?);
    let screen_size = XY::new(WIDTH, HEIGHT);
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: None,
            preserve_screen_alpha: false,
        },
        recording_meta,
        meta,
    )
    .await?;
    let duration = frames as f64 / FPS as f64;
    let mut zoom =
        ZoomTransformTimeline::from_project(&project_config, &cursor, duration, screen_size);
    zoom.ensure_precomputed_until(duration as f32);

    let pixels: Vec<u8> = (0..WIDTH * HEIGHT)
        .flat_map(|index| {
            let x = index % WIDTH;
            let y = index / WIDTH;
            [(x / 8) as u8, (y / 5) as u8, ((x + y) / 12) as u8, 255]
        })
        .collect();

    let mut renderer = FrameRenderer::new(&constants);
    let mut layers =
        RendererLayers::new_with_options(&constants.device, &constants.queue, false);
    let mut prepare = Vec::new();
    let mut layer_render = Vec::new();
    let mut background = Vec::new();
    let mut cursor_prepare = Vec::new();
    let mut wall = Vec::new();
    let mut hash_lines = Vec::new();
    let warmup = 10;
    let mut counted = (0u64, 0u64);

    for frame_number in 0..frames + warmup {
        let time = (frame_number % frames) as f32 / FPS as f32;
        let segment = DecodedSegmentFrames {
            screen_size,
            screen_frame: Some(DecodedFrame::new(pixels.clone(), WIDTH, HEIGHT)),
            camera_frame: None,
            segment_time: time,
            recording_time: time,
            segment_has_camera: false,
        };
        let uniforms = ProjectUniforms::new(
            &constants,
            &project_config,
            frame_number % frames,
            FPS,
            screen_size,
            &cursor,
            &segment,
            duration,
            &zoom,
        );
        let before = counters();
        let start = Instant::now();
        let (output, timings) = renderer
            .render_immediate_with_timings(segment, uniforms, &cursor, true, &mut layers)
            .await?;
        let elapsed = start.elapsed();
        let after = counters();
        if frame_number < warmup {
            continue;
        }
        counted.0 += after.0 - before.0;
        counted.1 += after.1 - before.1;
        prepare.push(timings.prepare_duration.as_secs_f64() * 1e6);
        layer_render.push(timings.layer_render_duration.as_secs_f64() * 1e6);
        background.push(timings.background_prepare_duration.as_secs_f64() * 1e6);
        cursor_prepare.push(timings.cursor_prepare_duration.as_secs_f64() * 1e6);
        wall.push(elapsed.as_secs_f64() * 1e6);
        if hashes.is_some() {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            for row in output.data.chunks_exact(output.padded_bytes_per_row as usize) {
                row[..output.width as usize * 4].hash(&mut hasher);
            }
            hash_lines.push(format!("{} {:016x}", frame_number - warmup, hasher.finish()));
        }
    }

    let summary = |samples: &mut Vec<f64>| {
        samples.sort_by(f64::total_cmp);
        serde_json::json!({
            "mean": samples.iter().sum::<f64>() / samples.len() as f64,
            "p50": percentile(samples, 0.5),
            "p95": percentile(samples, 0.95),
        })
    };
    let frames_f = frames as f64;
    println!(
        "{}",
        serde_json::json!({
            "label": label,
            "frames": frames,
            "prepare_us": summary(&mut prepare),
            "layer_render_us": summary(&mut layer_render),
            "background_prepare_us": summary(&mut background),
            "cursor_prepare_us": summary(&mut cursor_prepare),
            "frame_wall_us": summary(&mut wall),
            "bind_groups_per_frame": counted.0 as f64 / frames_f,
            "buffers_per_frame": counted.1 as f64 / frames_f,
        })
    );
    if let Some(path) = hashes {
        std::fs::write(path, hash_lines.join("\n") + "\n")?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("augment") => augment(Path::new(&args[2]), args.get(3).is_some_and(|a| a == "effects")),
        Some("bench") => {
            let frames = args[3].parse()?;
            bench(
                Path::new(&args[2]),
                frames,
                args.get(4).filter(|a| !a.is_empty()).map(PathBuf::from),
                args.get(5).map(String::as_str).unwrap_or(""),
            )
            .await
        }
        _ => Err(anyhow!("usage: augment <project> [effects] | bench <project> <frames> [hashes] [label]")),
    }
}
