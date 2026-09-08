use anyhow::{Context, Result, ensure};
use cap_project::{
    AspectRatio, BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, SingleSegment, StudioRecordingMeta, VideoMeta, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline, decoder::DecodedFrame,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Instant};

#[derive(Parser)]
struct Args {
    #[arg(long, default_value_t = 1920)]
    width: u32,
    #[arg(long, default_value_t = 1080)]
    height: u32,
    #[arg(long, default_value_t = 180)]
    frames: u32,
    #[arg(long, default_value_t = 20)]
    warmup: u32,
    #[arg(long, default_value_t = 3)]
    repetitions: u32,
    #[arg(long)]
    backgrounds: Option<PathBuf>,
    #[arg(long)]
    snapshots: Option<PathBuf>,
    #[arg(long, value_delimiter = ',', default_value = "0,1800")]
    snapshot_frames: Vec<u32>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    source: BackgroundSource,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    PlaybackRgba,
    #[cfg(target_os = "macos")]
    PlaybackBgraSurface,
    ExportNv12,
}

#[derive(Serialize)]
struct Measurement<'a> {
    background: &'a str,
    mode: Mode,
    repetition: u32,
    width: u32,
    height: u32,
    received: usize,
    mean_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

fn percentile(samples: &[f64], fraction: f64) -> f64 {
    samples[((samples.len() - 1) as f64 * fraction).round() as usize]
}

fn default_cases() -> Vec<Case> {
    vec![
        Case {
            name: "solid".into(),
            source: BackgroundSource::Color {
                value: [33, 40, 66],
                alpha: 255,
            },
        },
        Case {
            name: "static-gradient".into(),
            source: BackgroundSource::Gradient {
                from: [31, 54, 190],
                to: [237, 116, 194],
                angle: 45,
                noise_intensity: None,
                noise_scale: None,
                animated: None,
                animation_speed: None,
            },
        },
    ]
}

fn segment(source: &DecodedFrame, frame: u32) -> DecodedSegmentFrames {
    DecodedSegmentFrames {
        screen_size: XY::new(source.width(), source.height()),
        screen_frame: Some(source.clone()),
        camera_frame: None,
        segment_time: frame as f32 / 60.0,
        recording_time: frame as f32 / 60.0,
        segment_has_camera: false,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(args.frames > 0 && args.repetitions > 0);
    ensure!(args.width > 0 && args.height > 0);
    let mut cases = default_cases();
    if let Some(path) = &args.backgrounds {
        cases.extend(serde_json::from_slice::<Vec<Case>>(&std::fs::read(path)?)?);
    }
    let meta = StudioRecordingMeta::SingleSegment {
        segment: SingleSegment {
            display: VideoMeta {
                path: "synthetic.png".into(),
                fps: 60,
                start_time: Some(0.0),
                device_id: None,
            },
            camera: None,
            audio: None,
            cursor: None,
        },
    };
    let recording_meta = RecordingMeta {
        platform: None,
        project_path: PathBuf::new(),
        pretty_name: "Background benchmark".into(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(meta.clone())),
        upload: None,
    };
    let screen_size = XY::new(1280, 720);
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
    eprintln!(
        "adapter={} software={} dimensions={}x{} frames={} warmup={} repetitions={}",
        constants.adapter_name(),
        constants.is_software_adapter,
        args.width,
        args.height,
        args.frames,
        args.warmup,
        args.repetitions,
    );
    let mut pixels = vec![0; (screen_size.x * screen_size.y * 4) as usize];
    for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        pixel.copy_from_slice(&[
            30 + (i % screen_size.x as usize / 16) as u8,
            40 + (i / screen_size.x as usize / 8) as u8,
            80,
            255,
        ]);
    }
    let source = DecodedFrame::new_with_arc(Arc::new(pixels), screen_size.x, screen_size.y);
    let cursor = CursorEvents::default();
    let modes = [
        Mode::PlaybackRgba,
        #[cfg(target_os = "macos")]
        Mode::PlaybackBgraSurface,
        Mode::ExportNv12,
    ];
    for repetition in 0..args.repetitions {
        for offset in 0..cases.len() {
            let case = &cases[(offset + repetition as usize) % cases.len()];
            let mut project = ProjectConfiguration {
                aspect_ratio: Some(AspectRatio::Wide),
                ..Default::default()
            };
            project.background.source = case.source.clone();
            project.background.padding = 20.0;
            let duration = (args.frames + args.warmup) as f64 / 60.0;
            let mut zoom =
                ZoomTransformTimeline::from_project(&project, &cursor, duration, screen_size);
            zoom.ensure_precomputed_until(duration as f32);
            for mode in modes {
                let mut renderer = FrameRenderer::new(&constants);
                #[cfg(target_os = "macos")]
                renderer.enable_nv12_surface_output();
                let mut layers = RendererLayers::new_with_options(
                    &constants.device,
                    &constants.queue,
                    constants.is_software_adapter,
                );
                let mut samples = Vec::new();
                for frame_number in 0..args.frames + args.warmup {
                    let frame = segment(&source, frame_number);
                    let uniforms = ProjectUniforms::new(
                        &constants,
                        &project,
                        frame_number,
                        60,
                        XY::new(args.width, args.height),
                        &cursor,
                        &frame,
                        duration,
                        &zoom,
                    );
                    let start = Instant::now();
                    let received_number = match mode {
                        Mode::PlaybackRgba => {
                            let output = renderer
                                .render_immediate(frame, uniforms, &cursor, true, &mut layers)
                                .await?;
                            std::hint::black_box(&output.data);
                            output.frame_number
                        }
                        #[cfg(target_os = "macos")]
                        Mode::PlaybackBgraSurface => {
                            let output = renderer
                                .render_immediate_bgra_surface(
                                    frame,
                                    uniforms,
                                    &cursor,
                                    true,
                                    &mut layers,
                                )
                                .await?;
                            std::hint::black_box(&output.pixel_buffer);
                            output.frame_number
                        }
                        Mode::ExportNv12 => {
                            let output = renderer
                                .render_immediate_nv12(frame, uniforms, &cursor, true, &mut layers)
                                .await?;
                            std::hint::black_box(&output.data);
                            output.frame_number
                        }
                    };
                    constants.device.poll(wgpu::PollType::Wait)?;
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    ensure!(received_number == frame_number, "Unexpected frame ordering");
                    if frame_number >= args.warmup {
                        samples.push(elapsed);
                    }
                }
                samples.sort_by(f64::total_cmp);
                let measurement = Measurement {
                    background: &case.name,
                    mode,
                    repetition,
                    width: args.width,
                    height: args.height,
                    received: samples.len(),
                    mean_ms: samples.iter().sum::<f64>() / samples.len() as f64,
                    p50_ms: percentile(&samples, 0.5),
                    p95_ms: percentile(&samples, 0.95),
                    max_ms: samples.last().copied().unwrap_or_default(),
                };
                println!("{}", serde_json::to_string(&measurement)?);
            }
            if let Some(directory) = &args.snapshots
                && repetition == 0
            {
                std::fs::create_dir_all(directory)?;
                let mut renderer = FrameRenderer::new(&constants);
                let mut layers = RendererLayers::new(&constants.device, &constants.queue);
                for &frame_number in &args.snapshot_frames {
                    let frame = segment(&source, frame_number);
                    let uniforms = ProjectUniforms::new(
                        &constants,
                        &project,
                        frame_number,
                        60,
                        XY::new(args.width, args.height),
                        &cursor,
                        &frame,
                        duration,
                        &zoom,
                    );
                    let output = renderer
                        .render_immediate(frame, uniforms, &cursor, true, &mut layers)
                        .await?;
                    let pixels = output
                        .data
                        .chunks_exact(output.padded_bytes_per_row as usize)
                        .flat_map(|row| row[..output.width as usize * 4].iter().copied())
                        .collect::<Vec<_>>();
                    image::RgbaImage::from_raw(output.width, output.height, pixels)
                        .context("Invalid frame dimensions")?
                        .save(directory.join(format!("{}-{frame_number}.png", case.name)))?;
                }
            }
        }
    }
    Ok(())
}
