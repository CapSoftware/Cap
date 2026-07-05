use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use cap_editor::{
    EditorFrameOutput, FrameLayout, Playback, PlaybackFrameSource, PlaybackRenderOutputFormat,
    PlaybackSkipReason, PlaybackTelemetry, PlaybackTelemetryEvent, Renderer,
    finish_renderer_layers_creation, start_renderer_layers_creation,
};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment, XY,
};
use cap_rendering::{FrameRenderStageTimings, ProjectRecordingsMeta, RenderVideoConstants, Video};
use tokio::sync::{mpsc, watch};

fn percentile(data: &[f64], p: f64) -> f64 {
    let mut sorted: Vec<f64> = data.iter().copied().filter(|x| x.is_finite()).collect();
    if sorted.is_empty() {
        return 0.0;
    }

    sorted.sort_by(|a, b| {
        a.partial_cmp(b)
            .expect("finite values should be comparable")
    });
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[derive(Default)]
struct DurationStats {
    values_ms: Vec<f64>,
}

impl DurationStats {
    fn push(&mut self, duration: Duration) {
        self.values_ms.push(duration.as_secs_f64() * 1000.0);
    }

    fn avg(&self) -> f64 {
        if self.values_ms.is_empty() {
            0.0
        } else {
            self.values_ms.iter().sum::<f64>() / self.values_ms.len() as f64
        }
    }

    fn p95(&self) -> f64 {
        percentile(&self.values_ms, 95.0)
    }

    fn max(&self) -> f64 {
        self.values_ms.iter().copied().fold(0.0, f64::max)
    }

    fn print(&self, label: &str) {
        println!(
            "  {label:<24} avg={:>7.2}ms p95={:>7.2}ms max={:>7.2}ms samples={}",
            self.avg(),
            self.p95(),
            self.max(),
            self.values_ms.len()
        );
    }

    fn print_values(label: &str, values_ms: &[f64]) {
        let stats = Self {
            values_ms: values_ms.to_vec(),
        };
        stats.print(label);
    }
}

#[derive(Default)]
struct BenchmarkSummary {
    warmup_ms: f64,
    warmup_buffered_frames: usize,
    warmup_target_frames: usize,
    audio_resolved_ms: Option<f64>,
    audio_pipeline_ms: Option<f64>,
    audio_pipeline_has_audio: bool,
    clock_started_ms: Option<f64>,
    first_submit_ms: Option<f64>,
    first_renderer_frame_ms: Option<f64>,
    submitted_frames: u64,
    rendered_frames: u64,
    callback_frames: u64,
    dropped_by_renderer: u64,
    send_failures: u64,
    skipped_frames: u64,
    bytes_from_callback: u64,
    sources: HashMap<PlaybackFrameSource, u64>,
    skip_reasons: HashMap<PlaybackSkipReason, u64>,
    output_formats: HashMap<PlaybackRenderOutputFormat, u64>,
    schedule_overshoot: DurationStats,
    frame_acquire: DurationStats,
    uniforms: DurationStats,
    submit: DurationStats,
    renderer_prepare: DurationStats,
    queue_wait: DurationStats,
    drain: DurationStats,
    flush: DurationStats,
    render: DurationStats,
    render_prepare: DurationStats,
    prepare_background: DurationStats,
    prepare_background_blur: DurationStats,
    prepare_display: DurationStats,
    prepare_cursor: DurationStats,
    prepare_camera: DurationStats,
    prepare_camera_only: DurationStats,
    prepare_camera_blur: DurationStats,
    prepare_text: DurationStats,
    prepare_captions: DurationStats,
    prepare_keyboard: DurationStats,
    render_layers: DurationStats,
    render_finish: DurationStats,
    render_finish_wait_previous: DurationStats,
    render_finish_resize: DurationStats,
    render_finish_submit: DurationStats,
    render_immediate_flush: DurationStats,
    callback: DurationStats,
    render_samples: Vec<RenderSample>,
}

#[derive(Clone)]
struct RenderSample {
    frame_number: u32,
    input_frame_number: u32,
    duration_ms: f64,
    stage_timings: FrameRenderStageTimings,
}

impl BenchmarkSummary {
    fn record_event(&mut self, event: PlaybackTelemetryEvent) {
        self.record_event_at(event, None);
    }

    fn record_event_at(&mut self, event: PlaybackTelemetryEvent, press_elapsed_ms: Option<f64>) {
        match event {
            PlaybackTelemetryEvent::AudioSegmentsResolved { elapsed } => {
                self.audio_resolved_ms = Some(elapsed.as_secs_f64() * 1000.0);
            }
            PlaybackTelemetryEvent::AudioPipelineReady { elapsed, has_audio } => {
                self.audio_pipeline_ms = Some(elapsed.as_secs_f64() * 1000.0);
                self.audio_pipeline_has_audio = has_audio;
            }
            PlaybackTelemetryEvent::ClockStarted { elapsed } => {
                self.clock_started_ms = Some(elapsed.as_secs_f64() * 1000.0);
            }
            PlaybackTelemetryEvent::WarmupComplete {
                elapsed,
                buffered_frames,
                target_frames,
                start_frame_number: _,
            } => {
                self.warmup_ms = elapsed.as_secs_f64() * 1000.0;
                self.warmup_buffered_frames = buffered_frames;
                self.warmup_target_frames = target_frames;
            }
            PlaybackTelemetryEvent::FrameSubmitted {
                frame_number: _,
                source,
                schedule_overshoot,
                frame_acquire_duration,
                uniforms_duration,
                submit_duration,
                prefetch_buffer_len: _,
                total_frames_skipped: _,
            } => {
                self.submitted_frames += 1;
                if self.first_submit_ms.is_none() {
                    self.first_submit_ms = press_elapsed_ms;
                }
                *self.sources.entry(source).or_insert(0) += 1;
                self.schedule_overshoot.push(schedule_overshoot);
                self.frame_acquire.push(frame_acquire_duration);
                self.uniforms.push(uniforms_duration);
                self.submit.push(submit_duration);
            }
            PlaybackTelemetryEvent::FrameSkipped {
                frame_number: _,
                skipped,
                reason,
                prefetch_buffer_len: _,
            } => {
                self.skipped_frames += u64::from(skipped);
                *self.skip_reasons.entry(reason).or_insert(0) += u64::from(skipped);
            }
            PlaybackTelemetryEvent::RendererFrame {
                frame_number,
                input_frame_number,
                queue_wait,
                drain_duration,
                flush_duration,
                render_duration,
                render_stage_timings,
                callback_duration,
                drained_count: _,
                output_format,
            } => {
                let render_stage_timings = *render_stage_timings;
                self.rendered_frames += 1;
                if self.first_renderer_frame_ms.is_none() {
                    self.first_renderer_frame_ms = press_elapsed_ms;
                }
                *self.output_formats.entry(output_format).or_insert(0) += 1;
                self.queue_wait.push(queue_wait);
                self.drain.push(drain_duration);
                self.flush.push(flush_duration);
                self.render.push(render_duration);
                self.render_prepare
                    .push(render_stage_timings.prepare_duration);
                self.prepare_background
                    .push(render_stage_timings.background_prepare_duration);
                self.prepare_background_blur
                    .push(render_stage_timings.background_blur_prepare_duration);
                self.prepare_display
                    .push(render_stage_timings.display_prepare_duration);
                self.prepare_cursor
                    .push(render_stage_timings.cursor_prepare_duration);
                self.prepare_camera
                    .push(render_stage_timings.camera_prepare_duration);
                self.prepare_camera_only
                    .push(render_stage_timings.camera_only_prepare_duration);
                self.prepare_camera_blur
                    .push(render_stage_timings.camera_blur_prepare_duration);
                self.prepare_text
                    .push(render_stage_timings.text_prepare_duration);
                self.prepare_captions
                    .push(render_stage_timings.captions_prepare_duration);
                self.prepare_keyboard
                    .push(render_stage_timings.keyboard_prepare_duration);
                self.render_layers
                    .push(render_stage_timings.layer_render_duration);
                self.render_finish
                    .push(render_stage_timings.finish_duration);
                self.render_finish_wait_previous
                    .push(render_stage_timings.finish_wait_previous_duration);
                self.render_finish_resize
                    .push(render_stage_timings.finish_resize_duration);
                self.render_finish_submit
                    .push(render_stage_timings.finish_submit_readback_duration);
                self.render_immediate_flush
                    .push(render_stage_timings.immediate_flush_duration);
                self.callback.push(callback_duration);
                self.render_samples.push(RenderSample {
                    frame_number,
                    input_frame_number,
                    duration_ms: render_duration.as_secs_f64() * 1000.0,
                    stage_timings: render_stage_timings,
                });
            }
            PlaybackTelemetryEvent::RendererPrepared {
                output_width: _,
                output_height: _,
                duration,
            } => {
                self.renderer_prepare.push(duration);
            }
            PlaybackTelemetryEvent::RendererDropped {
                frame_number: _,
                replacement_frame_number: _,
            } => {
                self.dropped_by_renderer += 1;
            }
            PlaybackTelemetryEvent::RendererSendFailed { frame_number: _ } => {
                self.send_failures += 1;
            }
        }
    }

    fn record_callback_frame(&mut self, bytes: usize) {
        self.callback_frames += 1;
        self.bytes_from_callback = self.bytes_from_callback.saturating_add(bytes as u64);
    }

    fn top_stage(&self) -> (&'static str, f64) {
        let stages = [
            ("renderer render", self.render.p95()),
            ("renderer finish", self.render_finish.p95()),
            (
                "renderer finish wait previous",
                self.render_finish_wait_previous.p95(),
            ),
            ("renderer prepare layers", self.render_prepare.p95()),
            ("renderer prepare display", self.prepare_display.p95()),
            ("renderer prepare cursor", self.prepare_cursor.p95()),
            ("renderer prepare camera", self.prepare_camera.p95()),
            ("renderer queue wait", self.queue_wait.p95()),
            ("renderer prepare", self.renderer_prepare.p95()),
            ("frame acquire", self.frame_acquire.p95()),
            ("uniforms", self.uniforms.p95()),
            ("callback packing", self.callback.p95()),
            ("renderer flush", self.flush.p95()),
            ("submit", self.submit.p95()),
        ];

        stages
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(("none", 0.0))
    }
}

fn top_render_samples(samples: &[RenderSample], limit: usize) -> Vec<RenderSample> {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| {
        b.duration_ms
            .partial_cmp(&a.duration_ms)
            .expect("finite values should be comparable")
    });
    sorted.truncate(limit);
    sorted
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
                let duration = match Video::new(&display_path, 0.0) {
                    Ok(video) => video.duration,
                    Err(_) => 5.0,
                };
                vec![TimelineSegment {
                    recording_clip: 0,
                    start: 0.0,
                    end: duration,
                    timescale: 1.0,
                    name: None,
                }]
            }
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .enumerate()
                .filter_map(|(i, segment)| {
                    let display_path = recording_meta.path(&segment.display.path);
                    let duration = match Video::new(&display_path, 0.0) {
                        Ok(video) => video.duration,
                        Err(_) => 5.0,
                    };
                    (duration > 0.0).then_some(TimelineSegment {
                        recording_clip: i as u32,
                        start: 0.0,
                        end: duration,
                        timescale: 1.0,
                        name: None,
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
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            });
        }
    }

    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, meta.as_ref())
            .map_err(|e| format!("Failed to create recordings meta: {e}"))?,
    );

    Ok((recording_meta, meta, project, recordings))
}

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|idx| args.get(idx + 1))
        .map(String::as_str)
}

fn parse_resolution(args: &[String]) -> XY<u32> {
    let Some(value) = arg_value(args, "--resolution") else {
        return XY::new(1920, 1080);
    };

    match value {
        "full" => XY::new(1920, 1080),
        "half" => XY::new(1248, 702),
        "quarter" => XY::new(480, 270),
        custom => {
            let Some((width, height)) = custom.split_once('x') else {
                return XY::new(1920, 1080);
            };
            match (width.parse::<u32>(), height.parse::<u32>()) {
                (Ok(width), Ok(height)) if width > 0 && height > 0 => XY::new(width, height),
                _ => XY::new(1920, 1080),
            }
        }
    }
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

    let recording_path = arg_value(&args, "--recording-path")
        .map(PathBuf::from)
        .expect("Usage: editor-playback-benchmark --recording-path <path> [--fps <fps>] [--frames <count>] [--resolution full|half|quarter|<width>x<height>]");

    let fps = arg_value(&args, "--fps")
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let target_frames = arg_value(&args, "--frames")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300u64);
    let resolution_base = parse_resolution(&args);
    let start_frame_number = arg_value(&args, "--start-frame")
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            arg_value(&args, "--start-time")
                .and_then(|s| s.parse::<f64>().ok())
                .map(|seconds| (seconds * fps as f64).round() as u32)
        })
        .unwrap_or(0);

    println!("{}", "=".repeat(64));
    println!("  CAP EDITOR LIVE PLAYBACK BENCHMARK");
    println!("{}", "=".repeat(64));
    println!("Recording: {}", recording_path.display());
    println!("Target FPS: {fps}");
    println!("Target frames: {target_frames}");
    println!(
        "Resolution base: {}x{}",
        resolution_base.x, resolution_base.y
    );
    println!("Start frame: {start_frame_number}");

    let (recording_meta, meta, project, recordings) = match load_recording(&recording_path).await {
        Ok(recording) => recording,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let render_constants = match RenderVideoConstants::new(
        &recordings.segments,
        recording_meta.clone(),
        (*meta).clone(),
    )
    .await
    {
        Ok(constants) => Arc::new(constants),
        Err(e) => {
            eprintln!("Failed to create render constants: {e}");
            std::process::exit(1);
        }
    };

    println!(
        "GPU adapter: {} (software={})",
        render_constants.adapter_name(),
        render_constants.is_software_adapter
    );

    let layers_rx = start_renderer_layers_creation(&render_constants, &project);

    let segment_medias =
        match cap_editor::create_segments(&recording_meta, meta.as_ref(), false).await {
            Ok(segments) => Arc::new(segments),
            Err(e) => {
                eprintln!("Failed to create segments: {e}");
                std::process::exit(1);
            }
        };
    let layers_rx = finish_renderer_layers_creation(layers_rx).await;

    let (telemetry, mut telemetry_rx) = PlaybackTelemetry::channel();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<usize>();
    let frame_cb = Box::new(move |output: EditorFrameOutput, _: FrameLayout| {
        let bytes = match output {
            EditorFrameOutput::Nv12(frame) => {
                let metadata_bytes = match frame.format {
                    cap_rendering::GpuOutputFormat::Nv12 => 28,
                    cap_rendering::GpuOutputFormat::Rgba => 24,
                };
                let data = frame.data.into_vec();
                data.len() + metadata_bytes
            }
            EditorFrameOutput::Rgba(frame) => frame.data.len() + 24,
        };
        let _ = frame_tx.send(bytes);
    });

    let renderer = match Renderer::spawn_with_telemetry(
        render_constants.clone(),
        frame_cb,
        layers_rx,
        Some(telemetry.clone()),
    ) {
        Ok(renderer) => Arc::new(renderer),
        Err(e) => {
            eprintln!("Failed to start renderer: {e}");
            std::process::exit(1);
        }
    };

    // Sequential play presses: `--press-starts "0,45,0"` presses play at each
    // listed time (seconds), running a short burst of frames per press. This
    // mirrors play → scrub ahead → play. Without the flag there is a single
    // press at --start-frame/--start-time.
    let press_start_frames: Vec<u32> = arg_value(&args, "--press-starts")
        .map(|s| {
            s.split(',')
                .filter_map(|v| v.trim().parse::<f64>().ok())
                .map(|secs| (secs * fps as f64).round() as u32)
                .collect()
        })
        .unwrap_or_default();

    let presses: Vec<(u32, u64)> = if press_start_frames.is_empty() {
        vec![(start_frame_number, target_frames)]
    } else {
        press_start_frames
            .iter()
            .map(|frame| (*frame, target_frames.min(90)))
            .collect()
    };

    let (_project_tx, project_rx) = watch::channel(project);

    // One persistent output stream shared across presses, like the real app.
    let audio_output = Arc::new(cap_editor::AudioOutput::new());
    audio_output.prewarm();

    let mut summary = BenchmarkSummary::default();
    let mut measured_elapsed = 0.0f64;

    for (press_idx, (press_start_frame, press_frames)) in presses.iter().copied().enumerate() {
        let playback = Playback {
            renderer: renderer.clone(),
            render_constants: render_constants.clone(),
            start_frame_number: press_start_frame,
            project: project_rx.clone(),
            segment_medias: segment_medias.clone(),
            music: cap_editor::MusicTracks::new(),
            audio_output: audio_output.clone(),
            telemetry: Some(telemetry.clone()),
        };

        let press_instant = Instant::now();
        let playback_handle = match playback.start(fps, resolution_base).await {
            Ok(handle) => handle,
            Err(e) => {
                eprintln!("Failed to start playback: {e:?}");
                std::process::exit(1);
            }
        };
        let start_await_ms = press_instant.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        let timeout = Duration::from_secs_f64(press_frames as f64 / fps as f64 + 15.0);
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);

        let mut press_summary = BenchmarkSummary::default();

        loop {
            if press_summary.submitted_frames >= press_frames {
                break;
            }

            tokio::select! {
                event = telemetry_rx.recv() => {
                    if let Some(event) = event {
                        let press_elapsed_ms = press_instant.elapsed().as_secs_f64() * 1000.0;
                        press_summary.record_event_at(event, Some(press_elapsed_ms));
                    } else {
                        break;
                    }
                }
                bytes = frame_rx.recv() => {
                    if let Some(bytes) = bytes {
                        press_summary.record_callback_frame(bytes);
                    }
                }
                _ = &mut deadline => {
                    break;
                }
            }
        }

        let press_elapsed = start.elapsed().as_secs_f64();

        playback_handle.stop();
        tokio::time::sleep(Duration::from_millis(250)).await;

        while let Ok(event) = telemetry_rx.try_recv() {
            press_summary.record_event(event);
        }
        while let Ok(bytes) = frame_rx.try_recv() {
            press_summary.record_callback_frame(bytes);
        }

        let press_time_secs = press_start_frame as f64 / fps as f64;
        println!(
            "\nPlay-start latency (press {} at t={:.1}s, frame {}):",
            press_idx + 1,
            press_time_secs,
            press_start_frame
        );
        println!("  start() await:          {start_await_ms:>8.1}ms");
        if let Some(ms) = press_summary.audio_resolved_ms {
            println!("    audio decode wait:    {ms:>8.1}ms");
        }
        println!(
            "  warmup (frame prefetch):{:>8.1}ms",
            press_summary.warmup_ms
        );
        if let Some(ms) = press_summary.first_submit_ms {
            println!("  first frame submitted:  {ms:>8.1}ms");
        }
        if let Some(ms) = press_summary.first_renderer_frame_ms {
            println!("  first frame rendered:   {ms:>8.1}ms");
        }
        if let Some(ms) = press_summary.audio_pipeline_ms {
            println!(
                "  audio pipeline ready:   {ms:>8.1}ms (has_audio={})",
                press_summary.audio_pipeline_has_audio
            );
        }
        if let Some(ms) = press_summary.clock_started_ms {
            println!("  TOTAL press-to-clock:   {ms:>8.1}ms");
        } else {
            println!("  TOTAL press-to-clock:   (clock start not observed)");
        }

        summary = press_summary;
        measured_elapsed = press_elapsed;
    }

    renderer.stop().await;

    let effective_submitted_fps = summary.submitted_frames as f64 / measured_elapsed.max(0.001);
    let effective_rendered_fps = summary.rendered_frames as f64 / measured_elapsed.max(0.001);
    let mb_sent = summary.bytes_from_callback as f64 / 1_000_000.0;
    let mb_per_sec = mb_sent / measured_elapsed.max(0.001);
    let (top_stage, top_stage_p95) = summary.top_stage();
    let steady_render_values = if summary.render.values_ms.len() > 1 {
        &summary.render.values_ms[1..]
    } else {
        &summary.render.values_ms[..]
    };

    println!();
    println!("{}", "=".repeat(64));
    println!("  RESULTS");
    println!("{}", "=".repeat(64));
    println!(
        "Warmup: {:.1}ms (buffered {}/{})",
        summary.warmup_ms, summary.warmup_buffered_frames, summary.warmup_target_frames
    );
    println!(
        "Frames: submitted={} rendered={} callback={} renderer_dropped={} skipped={} send_failures={}",
        summary.submitted_frames,
        summary.rendered_frames,
        summary.callback_frames,
        summary.dropped_by_renderer,
        summary.skipped_frames,
        summary.send_failures
    );
    println!(
        "Effective FPS: submitted={effective_submitted_fps:.1} rendered={effective_rendered_fps:.1}"
    );
    println!("Callback payload: {mb_sent:.1}MB total, {mb_per_sec:.1}MB/s");
    println!("Top measured p95 stage: {top_stage} ({top_stage_p95:.2}ms)");

    println!("\nPlayback stages:");
    summary.schedule_overshoot.print("schedule overshoot");
    summary.frame_acquire.print("frame acquire");
    summary.uniforms.print("uniforms");
    summary.submit.print("submit");

    println!("\nRenderer stages:");
    summary.renderer_prepare.print("prepare");
    summary.queue_wait.print("queue wait");
    summary.drain.print("drain");
    summary.flush.print("flush");
    summary.render.print("render");
    summary.render_prepare.print("render prepare");
    summary.render_layers.print("render layers");
    summary.render_finish.print("render finish");
    summary
        .render_finish_wait_previous
        .print("finish wait previous");
    summary.render_finish_resize.print("finish resize");
    summary.render_finish_submit.print("finish submit");
    summary.render_immediate_flush.print("immediate flush");
    summary.callback.print("callback packing");
    DurationStats::print_values("render steady", steady_render_values);

    println!("\nRenderer prepare stages:");
    summary.prepare_background.print("background");
    summary.prepare_background_blur.print("background blur");
    summary.prepare_display.print("display");
    summary.prepare_cursor.print("cursor");
    summary.prepare_camera.print("camera");
    summary.prepare_camera_only.print("camera only");
    summary.prepare_camera_blur.print("camera blur");
    summary.prepare_text.print("text");
    summary.prepare_captions.print("captions");
    summary.prepare_keyboard.print("keyboard");

    if let Some(sample) = summary.render_samples.first() {
        println!(
            "\nFirst-frame setup/prewarm: warmup={:.1}ms first_renderer_frame=#{} first_render={:.2}ms immediate_flush={:.2}ms",
            summary.warmup_ms,
            sample.frame_number,
            sample.duration_ms,
            sample.stage_timings.immediate_flush_duration.as_secs_f64() * 1000.0
        );
    }
    let slowest = top_render_samples(&summary.render_samples, 5);
    if !slowest.is_empty() {
        println!("Slowest renderer frames:");
        for sample in slowest {
            let timings = sample.stage_timings;
            println!(
                "  rendered #{} input #{}: {:.2}ms prepare={:.2}ms display={:.2}ms cursor={:.2}ms camera={:.2}ms layers={:.2}ms finish={:.2}ms wait_previous={:.2}ms submit={:.2}ms flush={:.2}ms",
                sample.frame_number,
                sample.input_frame_number,
                sample.duration_ms,
                timings.prepare_duration.as_secs_f64() * 1000.0,
                timings.display_prepare_duration.as_secs_f64() * 1000.0,
                timings.cursor_prepare_duration.as_secs_f64() * 1000.0,
                timings.camera_prepare_duration.as_secs_f64() * 1000.0,
                timings.layer_render_duration.as_secs_f64() * 1000.0,
                timings.finish_duration.as_secs_f64() * 1000.0,
                timings.finish_wait_previous_duration.as_secs_f64() * 1000.0,
                timings.finish_submit_readback_duration.as_secs_f64() * 1000.0,
                timings.immediate_flush_duration.as_secs_f64() * 1000.0
            );
        }
    }

    if !summary.sources.is_empty() {
        println!("\nFrame sources:");
        let mut sources: Vec<_> = summary.sources.iter().collect();
        sources.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
        for (source, count) in sources {
            println!("  {source:?}: {count}");
        }
    }

    if !summary.skip_reasons.is_empty() {
        println!("\nSkip reasons:");
        let mut reasons: Vec<_> = summary.skip_reasons.iter().collect();
        reasons.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
        for (reason, count) in reasons {
            println!("  {reason:?}: {count}");
        }
    }

    if !summary.output_formats.is_empty() {
        println!("\nRenderer output formats:");
        let mut formats: Vec<_> = summary.output_formats.iter().collect();
        formats.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
        for (format, count) in formats {
            println!("  {format:?}: {count}");
        }
    }
}
