use anyhow::{Context, Result, ensure};
use cap_project::{BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};
use clap::Parser;
use std::{path::PathBuf, time::Instant};

#[derive(Parser)]
struct Args {
    #[arg(long, default_value_t = 5)]
    repetitions: u32,
    #[arg(long)]
    snapshots: Option<PathBuf>,
    #[arg(long)]
    screen_only: bool,
    #[arg(long, default_value_t = 1920)]
    camera_width: u32,
    #[arg(long, default_value_t = 1080)]
    camera_height: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(args.repetitions > 0);
    ensure!(args.camera_width > 0 && args.camera_height > 0);
    let camera_size = (!args.screen_only).then_some(XY::new(args.camera_width, args.camera_height));
    let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "camera texture benchmark",
        "display": { "path": "unused.mp4", "fps": 60 },
        "camera": if args.screen_only { serde_json::Value::Null } else { serde_json::json!({ "path": "unused-camera.mp4", "fps": 60 }) },
        "audio": null, "cursor": null
    }))?;
    let studio = metadata.studio_meta().context("Studio metadata")?.clone();
    let size = XY::new(320, 180);
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: size,
            camera_size,
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await?;
    let max_dimension = constants.device.limits().max_texture_dimension_2d;
    ensure!(
        args.camera_width <= max_dimension && args.camera_height <= max_dimension,
        "Camera dimensions exceed the device texture limit of {max_dimension}"
    );
    println!(
        "{}",
        serde_json::json!({
            "adapter": constants.adapter_name(),
            "software": constants.is_software_adapter,
            "repetitions": args.repetitions,
            "warmupRepetitions": 1,
            "outputSize": [size.x, size.y],
            "cameraSize": camera_size.map(|size| [size.x, size.y]),
            "screenOnly": args.screen_only,
        })
    );
    let screen = DecodedFrame::new([17, 43, 89, 255].repeat(320 * 180), 320, 180);
    let cameras = [[255, 0, 0, 255], [0, 0, 255, 255]].map(|color| {
        camera_size.map(|size| {
            DecodedFrame::new(
                color.repeat(size.x as usize * size.y as usize),
                size.x,
                size.y,
            )
        })
    });
    let cursor = CursorEvents::default();
    for repetition in 0..=args.repetitions {
        for camera_only in [false, true] {
            if args.screen_only && camera_only {
                continue;
            }
            for ordinary_prepare in [false, true] {
                constants.device.poll(wgpu::PollType::Wait)?;
                let memory_before = constants
                    .device
                    .get_internal_counters()
                    .hal
                    .texture_memory
                    .read();
                let startup_started = Instant::now();
                let mut layers = RendererLayers::new_with_options(
                    &constants.device,
                    &constants.queue,
                    constants.is_software_adapter,
                );
                constants.device.poll(wgpu::PollType::Wait)?;
                let constructor_ms = startup_started.elapsed().as_secs_f64() * 1000.0;
                let memory_after = constants
                    .device
                    .get_internal_counters()
                    .hal
                    .texture_memory
                    .read();
                ensure!(
                    memory_after > memory_before,
                    "Enable WGPU native counters with --features wgpu/counters"
                );
                let setup_started = Instant::now();
                layers.prepare_for_video_dimensions(
                    &constants.device,
                    constants.options.screen_size.x,
                    constants.options.screen_size.y,
                    constants.options.camera_size.map(|size| size.x),
                    constants.options.camera_size.map(|size| size.y),
                );
                constants.device.poll(wgpu::PollType::Wait)?;
                let setup_ms = setup_started.elapsed().as_secs_f64() * 1000.0;
                let startup_ms = startup_started.elapsed().as_secs_f64() * 1000.0;
                let memory_after_setup = constants
                    .device
                    .get_internal_counters()
                    .hal
                    .texture_memory
                    .read();
                let mut project = ProjectConfiguration::default();
                project.background.source = BackgroundSource::Color {
                    value: [0, 255, 0],
                    alpha: 255,
                };
                project.background.shadow = 0.0;
                project.camera.shadow = 0.0;
                if camera_only {
                    project.timeline = Some(serde_json::from_value(serde_json::json!({
                        "segments": [], "zoomSegments": [],
                        "sceneSegments": [{
                            "start": 2.0, "end": 5.0, "mode": "cameraOnly",
                            "transitionIn": 0.0, "transitionOut": 0.0
                        }]
                    }))?);
                }
                let zoom = ZoomTransformTimeline::from_project(&project, &cursor, 6.0, size);
                let project = std::sync::Arc::new(project);
                let mut renderer = FrameRenderer::new(&constants);
                let mut frame_ms = Vec::new();
                let mut frame_memory = Vec::new();
                for (index, camera) in cameras.iter().enumerate() {
                    let frame_number = 180 + index as u32;
                    let frames = DecodedSegmentFrames {
                        screen_size: size,
                        screen_frame: Some(screen.clone()),
                        camera_frame: camera.clone(),
                        segment_time: frame_number as f32 / 60.0,
                        recording_time: frame_number as f32 / 60.0,
                        segment_has_camera: !args.screen_only,
                    };
                    let uniforms = ProjectUniforms::new(
                        &constants,
                        &project,
                        frame_number,
                        60,
                        size,
                        &cursor,
                        &frames,
                        6.0,
                        &zoom,
                    );
                    let started = Instant::now();
                    if ordinary_prepare {
                        layers
                            .prepare(&constants, &uniforms, &frames, &cursor, true)
                            .await?;
                    }
                    let output = renderer
                        .render_immediate(frames, uniforms, &cursor, true, &mut layers)
                        .await?;
                    frame_ms.push(started.elapsed().as_secs_f64() * 1000.0);
                    frame_memory.push(
                        constants
                            .device
                            .get_internal_counters()
                            .hal
                            .texture_memory
                            .read()
                            - memory_before,
                    );
                    let pixels: Vec<_> = output
                        .data
                        .chunks_exact(output.padded_bytes_per_row as usize)
                        .flat_map(|row| row[..output.width as usize * 4].iter().copied())
                        .collect();
                    let expected = if args.screen_only {
                        [17, 43, 89, 255]
                    } else if index == 0 {
                        [255, 0, 0, 255]
                    } else {
                        [0, 0, 255, 255]
                    };
                    ensure!(
                        pixels.chunks_exact(4).filter(|p| *p == expected).count() > 100,
                        "The source must visibly draw both distinct frames"
                    );
                    if let Some(directory) = &args.snapshots
                        && repetition == 1
                    {
                        std::fs::create_dir_all(directory)?;
                        let name = format!(
                            "{}-{}-{index}",
                            if camera_only {
                                "camera-only"
                            } else {
                                "overlay"
                            },
                            if ordinary_prepare {
                                "ordinary"
                            } else {
                                "encoder"
                            },
                        );
                        std::fs::write(directory.join(format!("{name}.rgba")), &pixels)?;
                        image::RgbaImage::from_raw(output.width, output.height, pixels)
                            .context("Invalid output dimensions")?
                            .save(directory.join(format!("{name}.png")))?;
                    }
                }
                println!(
                    "{}",
                    serde_json::json!({
                        "repetition": repetition,
                        "warmup": repetition == 0,
                        "cameraOnly": camera_only,
                        "ordinaryPrepare": ordinary_prepare,
                        "screenOnly": args.screen_only,
                        "constructorMs": constructor_ms,
                        "constructorTextureBytes": memory_after - memory_before,
                        "setupMs": setup_ms,
                        "setupTextureBytes": memory_after_setup - memory_after,
                        "startupMs": startup_ms,
                        "startupTextureBytes": memory_after_setup - memory_before,
                        "firstTwoFrameMs": frame_ms,
                        "firstTwoFrameTextureBytes": frame_memory,
                    })
                );
                drop(renderer);
                drop(layers);
                constants.device.poll(wgpu::PollType::Wait)?;
            }
        }
    }
    Ok(())
}
