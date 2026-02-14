use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment, XY,
};
use cap_rendering::{
    FrameRenderer, ProjectRecordingsMeta, ProjectUniforms, RenderVideoConstants, RendererLayers,
    ZoomFocusInterpolator, decoder::spawn_decoder,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

fn percentile(data: &[f64], p: f64) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = data.iter().copied().filter(|x| !x.is_nan()).collect();
    if sorted.is_empty() {
        return 0.0;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn print_stats(label: &str, times_ms: &[f64]) {
    if times_ms.is_empty() {
        println!("  {label}: no data");
        return;
    }
    let avg = times_ms.iter().sum::<f64>() / times_ms.len() as f64;
    let min = times_ms.iter().copied().fold(f64::INFINITY, f64::min);
    let max = times_ms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let p50 = percentile(times_ms, 50.0);
    let p95 = percentile(times_ms, 95.0);
    let p99 = percentile(times_ms, 99.0);

    println!("  {label}:");
    println!("    avg={avg:.2}ms  min={min:.2}ms  max={max:.2}ms");
    println!("    p50={p50:.2}ms  p95={p95:.2}ms  p99={p99:.2}ms");
}

#[derive(Default)]
struct PipelineTimings {
    decode_ms: Vec<f64>,
    render_ms: Vec<f64>,
    total_ms: Vec<f64>,
    decode_failures: usize,
    render_failures: usize,
    frames_rendered: usize,
}

impl PipelineTimings {
    fn print_report(&self, label: &str) {
        println!("\n{}", "=".repeat(60));
        println!("  {label}");
        println!("{}", "=".repeat(60));

        println!("  Frames rendered: {}", self.frames_rendered);
        if self.decode_failures > 0 {
            println!("  Decode failures: {}", self.decode_failures);
        }
        if self.render_failures > 0 {
            println!("  Render failures: {}", self.render_failures);
        }

        if !self.total_ms.is_empty() {
            let total_time: f64 = self.total_ms.iter().sum();
            let effective_fps = self.frames_rendered as f64 / (total_time / 1000.0);
            println!("  Effective FPS: {effective_fps:.1}");
            println!("  Total time: {total_time:.0}ms for {} frames", self.frames_rendered);
        }

        println!();
        print_stats("Decode", &self.decode_ms);
        print_stats("GPU Render+Readback", &self.render_ms);
        print_stats("Total (decode+render)", &self.total_ms);
    }
}

async fn load_recording(
    recording_path: &Path,
) -> Result<
    (
        RecordingMeta,
        Box<StudioRecordingMeta>,
        ProjectConfiguration,
        Arc<ProjectRecordingsMeta>,
    ),
    String,
> {
    let recording_meta = RecordingMeta::load_for_project(recording_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;

    let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
        return Err("Not a studio recording".to_string());
    };
    let meta = meta.clone();

    let mut project = recording_meta.project_config();

    if project.timeline.is_none() {
        let timeline_segments = match meta.as_ref() {
            StudioRecordingMeta::SingleSegment { segment } => {
                let display_path = recording_meta.path(&segment.display.path);
                let duration =
                    match cap_rendering::Video::new(&display_path, 0.0) {
                        Ok(v) => v.duration,
                        Err(_) => 5.0,
                    };
                vec![TimelineSegment {
                    recording_clip: 0,
                    start: 0.0,
                    end: duration,
                    timescale: 1.0,
                }]
            }
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .enumerate()
                .filter_map(|(i, segment)| {
                    let display_path = recording_meta.path(&segment.display.path);
                    let duration = match cap_rendering::Video::new(&display_path, 0.0) {
                        Ok(v) => v.duration,
                        Err(_) => 5.0,
                    };
                    if duration <= 0.0 {
                        return None;
                    }
                    Some(TimelineSegment {
                        recording_clip: i as u32,
                        start: 0.0,
                        end: duration,
                        timescale: 1.0,
                    })
                })
                .collect(),
        };

        if !timeline_segments.is_empty() {
            project.timeline = Some(TimelineConfiguration {
                segments: timeline_segments,
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
            });
        }
    }

    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, meta.as_ref())
            .map_err(|e| format!("Failed to create recordings meta: {e}"))?,
    );

    Ok((recording_meta, meta, project, recordings))
}

async fn run_decode_only_benchmark(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    fps: u32,
    frame_count: usize,
) -> PipelineTimings {
    let mut timings = PipelineTimings::default();

    let display_path = match meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            recording_meta.path(&segment.display.path)
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            recording_meta.path(&inner.segments[0].display.path)
        }
    };

    let display_fps = match meta {
        StudioRecordingMeta::SingleSegment { segment } => segment.display.fps,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments[0].display.fps,
    };

    let decoder = match spawn_decoder("benchmark-screen", display_path, display_fps, 0.0, false).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to create decoder: {e}");
            return timings;
        }
    };

    println!("  Decoder type: {}", decoder.decoder_type());
    println!(
        "  Hardware accelerated: {}",
        decoder.is_hardware_accelerated()
    );
    let (w, h) = decoder.video_dimensions();
    println!("  Video dimensions: {w}x{h}");

    let duration = project
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(10.0);
    let max_frames = ((duration * fps as f64).ceil() as usize).min(frame_count);

    println!("  Decoding {max_frames} frames at {fps}fps...");

    for i in 0..max_frames {
        let time = i as f32 / fps as f32;
        let start = Instant::now();
        match decoder.get_frame(time).await {
            Some(_frame) => {
                let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
                timings.decode_ms.push(elapsed_ms);
                timings.total_ms.push(elapsed_ms);
                timings.frames_rendered += 1;
            }
            None => {
                timings.decode_failures += 1;
            }
        }
    }

    timings
}

async fn run_full_pipeline_benchmark(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    recordings: &ProjectRecordingsMeta,
    fps: u32,
    frame_count: usize,
    resolution_base: XY<u32>,
) -> PipelineTimings {
    let mut timings = PipelineTimings::default();

    let render_constants = match RenderVideoConstants::new(
        &recordings.segments,
        recording_meta.clone(),
        (*meta).clone(),
    )
    .await
    {
        Ok(rc) => Arc::new(rc),
        Err(e) => {
            eprintln!("Failed to create render constants: {e}");
            return timings;
        }
    };

    println!(
        "  GPU adapter: {} (software={})",
        render_constants._adapter.get_info().name,
        render_constants.is_software_adapter
    );

    let segments =
        match cap_editor::create_segments(recording_meta, meta, false).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to create segments: {e}");
                return timings;
            }
        };

    if segments.is_empty() {
        eprintln!("No segments found");
        return timings;
    }

    let mut frame_renderer = FrameRenderer::new(&render_constants);
    let mut layers = RendererLayers::new_with_options(
        &render_constants.device,
        &render_constants.queue,
        render_constants.is_software_adapter,
    );

    let first_segment = &segments[0];
    let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
    let camera_dims = first_segment.decoders.camera_video_dimensions();
    layers.prepare_for_video_dimensions(
        &render_constants.device,
        screen_w,
        screen_h,
        camera_dims.map(|(w, _)| w),
        camera_dims.map(|(_, h)| h),
    );

    let duration = project
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(10.0);
    let max_frames = ((duration * fps as f64).ceil() as usize).min(frame_count);

    println!("  Rendering {max_frames} frames at {fps}fps, resolution base: {}x{}...", resolution_base.x, resolution_base.y);

    let cursor_smoothing =
        (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

    for i in 0..max_frames {
        let frame_time = i as f64 / fps as f64;

        let Some((segment_time, segment)) = project.get_segment_time(frame_time) else {
            break;
        };

        let segment_media = match segments.get(segment.recording_clip as usize) {
            Some(sm) => sm,
            None => {
                timings.decode_failures += 1;
                continue;
            }
        };

        let clip_offsets = project
            .clips
            .iter()
            .find(|v| v.index == segment.recording_clip)
            .map(|v| v.offsets)
            .unwrap_or_default();

        let decode_start = Instant::now();
        let segment_frames_opt = if i == 0 {
            segment_media
                .decoders
                .get_frames_initial(
                    segment_time as f32,
                    !project.camera.hide,
                    clip_offsets,
                )
                .await
        } else {
            segment_media
                .decoders
                .get_frames(segment_time as f32, !project.camera.hide, clip_offsets)
                .await
        };
        let decode_elapsed_ms = decode_start.elapsed().as_secs_f64() * 1000.0;

        let Some(segment_frames) = segment_frames_opt else {
            timings.decode_failures += 1;
            continue;
        };

        timings.decode_ms.push(decode_elapsed_ms);

        let zoom_focus_interpolator = ZoomFocusInterpolator::new(
            &segment_media.cursor,
            cursor_smoothing,
            project.screen_movement_spring,
            duration,
        );

        let uniforms = ProjectUniforms::new(
            &render_constants,
            project,
            i as u32,
            fps,
            resolution_base,
            &segment_media.cursor,
            &segment_frames,
            duration,
            &zoom_focus_interpolator,
        );

        let render_start = Instant::now();
        match frame_renderer
            .render(
                segment_frames,
                uniforms,
                &segment_media.cursor,
                &mut layers,
            )
            .await
        {
            Ok(_frame) => {
                let render_elapsed_ms = render_start.elapsed().as_secs_f64() * 1000.0;
                timings.render_ms.push(render_elapsed_ms);
                timings.total_ms.push(decode_elapsed_ms + render_elapsed_ms);
                timings.frames_rendered += 1;
            }
            Err(e) => {
                timings.render_failures += 1;
                if timings.render_failures <= 3 {
                    eprintln!("  Render failed at frame {i}: {e}");
                }
            }
        }

        if (i + 1) % 100 == 0 {
            println!("    Progress: {}/{max_frames} frames", i + 1);
        }
    }

    timings
}

async fn run_scrubbing_benchmark(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    recordings: &ProjectRecordingsMeta,
    fps: u32,
    resolution_base: XY<u32>,
) -> PipelineTimings {
    let mut timings = PipelineTimings::default();

    let render_constants = match RenderVideoConstants::new(
        &recordings.segments,
        recording_meta.clone(),
        (*meta).clone(),
    )
    .await
    {
        Ok(rc) => Arc::new(rc),
        Err(e) => {
            eprintln!("Failed to create render constants: {e}");
            return timings;
        }
    };

    let segments =
        match cap_editor::create_segments(recording_meta, meta, false).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to create segments: {e}");
                return timings;
            }
        };

    if segments.is_empty() {
        eprintln!("No segments found");
        return timings;
    }

    let mut frame_renderer = FrameRenderer::new(&render_constants);
    let mut layers = RendererLayers::new_with_options(
        &render_constants.device,
        &render_constants.queue,
        render_constants.is_software_adapter,
    );

    let first_segment = &segments[0];
    let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
    let camera_dims = first_segment.decoders.camera_video_dimensions();
    layers.prepare_for_video_dimensions(
        &render_constants.device,
        screen_w,
        screen_h,
        camera_dims.map(|(w, _)| w),
        camera_dims.map(|(_, h)| h),
    );

    let duration = project
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(10.0);

    let cursor_smoothing =
        (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

    let scrub_positions: Vec<f64> = {
        let golden_ratio = 1.618_034;
        let mut positions = Vec::with_capacity(50);
        let mut pos = 0.0;
        for _ in 0..50 {
            pos = (pos + golden_ratio * duration) % duration;
            positions.push(pos);
        }
        positions
    };

    println!("  Scrubbing to {} random positions...", scrub_positions.len());

    for (i, &scrub_time) in scrub_positions.iter().enumerate() {
        let Some((segment_time, segment)) = project.get_segment_time(scrub_time) else {
            continue;
        };

        let segment_media = match segments.get(segment.recording_clip as usize) {
            Some(sm) => sm,
            None => continue,
        };

        let clip_offsets = project
            .clips
            .iter()
            .find(|v| v.index == segment.recording_clip)
            .map(|v| v.offsets)
            .unwrap_or_default();

        let decode_start = Instant::now();
        let segment_frames_opt = segment_media
            .decoders
            .get_frames_initial(segment_time as f32, !project.camera.hide, clip_offsets)
            .await;
        let decode_elapsed_ms = decode_start.elapsed().as_secs_f64() * 1000.0;

        let Some(segment_frames) = segment_frames_opt else {
            timings.decode_failures += 1;
            continue;
        };

        timings.decode_ms.push(decode_elapsed_ms);

        let frame_number = (scrub_time * fps as f64).round() as u32;

        let zoom_focus_interpolator = ZoomFocusInterpolator::new(
            &segment_media.cursor,
            cursor_smoothing,
            project.screen_movement_spring,
            duration,
        );

        let uniforms = ProjectUniforms::new(
            &render_constants,
            project,
            frame_number,
            fps,
            resolution_base,
            &segment_media.cursor,
            &segment_frames,
            duration,
            &zoom_focus_interpolator,
        );

        let render_start = Instant::now();
        match frame_renderer
            .render(
                segment_frames,
                uniforms,
                &segment_media.cursor,
                &mut layers,
            )
            .await
        {
            Ok(_frame) => {
                let render_elapsed_ms = render_start.elapsed().as_secs_f64() * 1000.0;
                timings.render_ms.push(render_elapsed_ms);
                timings.total_ms.push(decode_elapsed_ms + render_elapsed_ms);
                timings.frames_rendered += 1;
            }
            Err(e) => {
                timings.render_failures += 1;
                if timings.render_failures <= 3 {
                    eprintln!("  Render failed at scrub {i}: {e}");
                }
            }
        }
    }

    timings
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::WARN.into()),
        )
        .init();

    ffmpeg::init().expect("Failed to initialize FFmpeg");

    let args: Vec<String> = std::env::args().collect();

    let recording_path = args
        .iter()
        .position(|a| a == "--recording-path")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .expect("Usage: playback-pipeline-benchmark --recording-path <path> [--fps <fps>] [--frames <count>]");

    let fps = args
        .iter()
        .position(|a| a == "--fps")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    let frame_count = args
        .iter()
        .position(|a| a == "--frames")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    println!("{}", "=".repeat(60));
    println!("  CAP PLAYBACK PIPELINE BENCHMARK");
    println!("{}", "=".repeat(60));
    println!();
    println!("Recording: {}", recording_path.display());
    println!("Target FPS: {fps}");
    println!("Max frames: {frame_count}");
    println!();

    let (recording_meta, meta, project, recordings) = match load_recording(&recording_path).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to load recording: {e}");
            std::process::exit(1);
        }
    };

    let duration = project
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(0.0);
    println!("Recording duration: {duration:.2}s");

    let resolutions = [
        (XY::new(1920, 1080), "Full (1920x1080)"),
        (XY::new(1248, 702), "Half (1248x702)"),
        (XY::new(480, 270), "Quarter (480x270)"),
    ];

    println!("\n--- DECODE-ONLY BENCHMARK ---");
    let decode_timings = run_decode_only_benchmark(
        &recording_meta,
        meta.as_ref(),
        &project,
        fps,
        frame_count,
    )
    .await;
    decode_timings.print_report("DECODE-ONLY");

    for (resolution_base, label) in &resolutions {
        println!("\n--- FULL PIPELINE: {label} ---");
        let pipeline_timings = run_full_pipeline_benchmark(
            &recording_meta,
            meta.as_ref(),
            &project,
            &recordings,
            fps,
            frame_count,
            *resolution_base,
        )
        .await;
        pipeline_timings.print_report(&format!("FULL PIPELINE - {label}"));
    }

    println!("\n--- SCRUBBING BENCHMARK (Half resolution) ---");
    let scrub_timings = run_scrubbing_benchmark(
        &recording_meta,
        meta.as_ref(),
        &project,
        &recordings,
        fps,
        XY::new(1248, 702),
    )
    .await;
    scrub_timings.print_report("SCRUBBING (Half resolution)");

    println!("\n{}", "=".repeat(60));
    println!("  BENCHMARK COMPLETE");
    println!("{}", "=".repeat(60));

    let target_frame_time_ms = 1000.0 / fps as f64;
    println!("\nTarget frame time at {fps}fps: {target_frame_time_ms:.2}ms");

    if !decode_timings.decode_ms.is_empty() {
        let decode_p95 = percentile(&decode_timings.decode_ms, 95.0);
        let decode_budget_pct = decode_p95 / target_frame_time_ms * 100.0;
        println!(
            "Decode p95 ({decode_p95:.2}ms) uses {decode_budget_pct:.0}% of frame budget"
        );
    }

    for (_resolution_base, label) in &resolutions {
        println!("\n{label}:");
        println!("  Frame budget: {target_frame_time_ms:.2}ms");
    }
}
