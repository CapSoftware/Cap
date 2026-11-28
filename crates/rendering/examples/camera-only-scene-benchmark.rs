use anyhow::{Context, Result, ensure};
use cap_project::{BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};
use clap::{Parser, ValueEnum};
use std::time::Instant;

const WARMUP_FRAMES: u32 = 10;

#[derive(Clone, Copy, ValueEnum)]
enum CameraFormat {
    Rgba,
    Nv12,
}

#[derive(Parser)]
#[command(about = "Time frames of a steady camera-only scene")]
struct Args {
    #[arg(long, default_value_t = 120)]
    frames: u32,
    #[arg(long, default_value_t = 1920)]
    output_width: u32,
    #[arg(long, default_value_t = 1080)]
    output_height: u32,
    #[arg(long, default_value_t = 1920)]
    camera_width: u32,
    #[arg(long, default_value_t = 1080)]
    camera_height: u32,
    #[arg(long, value_enum, default_value_t = CameraFormat::Nv12)]
    format: CameraFormat,
}

fn camera_frame(args: &Args, shade: u8) -> DecodedFrame {
    let (width, height) = (args.camera_width, args.camera_height);
    match args.format {
        CameraFormat::Rgba => DecodedFrame::new(
            [shade, 255 - shade, 64, 255].repeat(width as usize * height as usize),
            width,
            height,
        ),
        CameraFormat::Nv12 => {
            let mut data = vec![shade; width as usize * height as usize];
            data.extend(std::iter::repeat_n(
                128 + shade / 2,
                width as usize * height as usize / 2,
            ));
            DecodedFrame::new_nv12(data, width, height, width, width)
        }
    }
}

fn fnv1a(bytes: impl Iterator<Item = u8>) -> u64 {
    bytes.fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.frames > WARMUP_FRAMES,
        "--frames must be greater than the {WARMUP_FRAMES} warm-up frames"
    );
    ensure!(
        matches!(args.format, CameraFormat::Rgba)
            || (args.camera_width.is_multiple_of(2) && args.camera_height.is_multiple_of(2)),
        "NV12 camera dimensions must be even"
    );
    let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "camera only scene benchmark",
        "display": { "path": "unused.mp4", "fps": 60 },
        "camera": { "path": "unused-camera.mp4", "fps": 60 },
        "audio": null, "cursor": null
    }))?;
    let studio = metadata.studio_meta().context("Studio metadata")?.clone();
    let screen_size = XY::new(args.output_width, args.output_height);
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size,
            camera_size: Some(XY::new(args.camera_width, args.camera_height)),
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await?;

    let duration = f64::from(args.frames) / 60.0 + 2.0;
    let mut project = ProjectConfiguration::default();
    project.background.source = BackgroundSource::Color {
        value: [0, 255, 0],
        alpha: 255,
    };
    project.timeline = Some(serde_json::from_value(serde_json::json!({
        "segments": [], "zoomSegments": [],
        "sceneSegments": [{
            "start": 0.0, "end": duration, "mode": "cameraOnly",
            "transitionIn": 0.0, "transitionOut": 0.0
        }]
    }))?);
    let cursor = CursorEvents::default();
    let zoom = ZoomTransformTimeline::from_project(&project, &cursor, duration, screen_size);
    let project = std::sync::Arc::new(project);

    let screen = DecodedFrame::new(
        [17, 43, 89, 255].repeat(screen_size.x as usize * screen_size.y as usize),
        screen_size.x,
        screen_size.y,
    );
    let cameras = [camera_frame(&args, 40), camera_frame(&args, 200)];

    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );
    layers.prepare_for_video_dimensions(
        &constants.device,
        screen_size.x,
        screen_size.y,
        Some(args.camera_width),
        Some(args.camera_height),
    );
    let mut renderer = FrameRenderer::new(&constants);
    let mut frame_ms = Vec::with_capacity(args.frames as usize);
    let mut output_hash = 0u64;
    for index in 0..args.frames {
        let frame_number = 60 + index;
        let frames = DecodedSegmentFrames {
            screen_size,
            screen_frame: Some(screen.clone()),
            camera_frame: Some(cameras[index as usize % cameras.len()].clone()),
            segment_time: frame_number as f32 / 60.0,
            recording_time: frame_number as f32 / 60.0,
            segment_has_camera: true,
        };
        let uniforms = ProjectUniforms::new(
            &constants,
            &project,
            frame_number,
            60,
            screen_size,
            &cursor,
            &frames,
            duration,
            &zoom,
        );
        let started = Instant::now();
        let output = renderer
            .render_immediate(frames, uniforms, &cursor, true, &mut layers)
            .await?;
        frame_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        if index + 2 >= args.frames {
            let row_bytes = output.width as usize * 4;
            output_hash ^= fnv1a(
                output
                    .data
                    .chunks_exact(output.padded_bytes_per_row as usize)
                    .flat_map(|row| row[..row_bytes].iter().copied()),
            );
        }
    }

    let steady = &mut frame_ms[WARMUP_FRAMES as usize..];
    steady.sort_by(f64::total_cmp);
    println!(
        "camera_only_scene adapter={} output={}x{} camera={}x{} format={} frames={} median_ms={:.3} p90_ms={:.3} output_hash={output_hash:016x}",
        constants.adapter_name(),
        screen_size.x,
        screen_size.y,
        args.camera_width,
        args.camera_height,
        match args.format {
            CameraFormat::Rgba => "rgba",
            CameraFormat::Nv12 => "nv12",
        },
        args.frames,
        steady[steady.len() / 2],
        steady[steady.len() * 9 / 10],
    );
    Ok(())
}
