use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use cap_desktop_lib::frame_ws::{WSFrame, WSFrameFormat, create_watch_frame_ws};
use cap_editor::{
    EditorFrameOutput, Playback, PlaybackRenderOutputFormat, PlaybackSkipReason, PlaybackTelemetry,
    PlaybackTelemetryEvent, Renderer, finish_renderer_layers_creation,
    start_renderer_layers_creation,
};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    TimelineConfiguration, TimelineSegment, XY,
};
use cap_rendering::{GpuOutputFormat, ProjectRecordingsMeta, RenderVideoConstants, Video};
use tokio::sync::{mpsc, watch};

#[derive(Default)]
struct Summary {
    warmup_ms: f64,
    submitted_frames: u64,
    rendered_frames: u64,
    callback_frames: u64,
    dropped_by_renderer: u64,
    skipped_frames: u64,
    send_failures: u64,
    bytes_from_callback: u64,
    output_formats: HashMap<PlaybackRenderOutputFormat, u64>,
    skip_reasons: HashMap<PlaybackSkipReason, u64>,
}

impl Summary {
    fn record_event(&mut self, event: PlaybackTelemetryEvent) {
        match event {
            PlaybackTelemetryEvent::WarmupComplete { elapsed, .. } => {
                self.warmup_ms = elapsed.as_secs_f64() * 1000.0;
            }
            PlaybackTelemetryEvent::FrameSubmitted { .. } => {
                self.submitted_frames += 1;
            }
            PlaybackTelemetryEvent::FrameSkipped {
                skipped, reason, ..
            } => {
                self.skipped_frames += u64::from(skipped);
                *self.skip_reasons.entry(reason).or_insert(0) += u64::from(skipped);
            }
            PlaybackTelemetryEvent::RendererFrame { output_format, .. } => {
                self.rendered_frames += 1;
                *self.output_formats.entry(output_format).or_insert(0) += 1;
            }
            PlaybackTelemetryEvent::RendererPrepared { .. } => {}
            PlaybackTelemetryEvent::RendererDropped { .. } => {
                self.dropped_by_renderer += 1;
            }
            PlaybackTelemetryEvent::RendererSendFailed { .. } => {
                self.send_failures += 1;
            }
            PlaybackTelemetryEvent::AudioSegmentsResolved { .. }
            | PlaybackTelemetryEvent::AudioPipelineReady { .. }
            | PlaybackTelemetryEvent::ClockStarted { .. } => {}
        }
    }

    fn record_callback_frame(&mut self, bytes: usize) {
        self.callback_frames += 1;
        self.bytes_from_callback = self.bytes_from_callback.saturating_add(bytes as u64);
    }
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
                transitions: Vec::new(),
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

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    ffmpeg::init().expect("Failed to initialize FFmpeg");

    let args: Vec<String> = std::env::args().collect();
    let recording_path = arg_value(&args, "--recording-path")
        .map(PathBuf::from)
        .expect("Usage: desktop-display-transport-benchmark --recording-path <path> [--fps <fps>] [--frames <count>] [--resolution full|half|quarter|<width>x<height>] [--startup-delay-ms <ms>]");
    let fps = arg_value(&args, "--fps")
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let target_frames = arg_value(&args, "--frames")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300u64);
    let startup_delay_ms = arg_value(&args, "--startup-delay-ms")
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000u64);
    let resolution_base = parse_resolution(&args);

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

    let (frame_watch_tx, frame_watch_rx) = watch::channel(None);
    let (ws_port, ws_shutdown_token) =
        create_watch_frame_ws(frame_watch_rx, Default::default()).await;

    println!("DISPLAY_WS_URL=ws://127.0.0.1:{ws_port}");
    println!(
        "DISPLAY_BENCHMARK_READY fps={fps} frames={target_frames} resolution={}x{} startup_delay_ms={startup_delay_ms}",
        resolution_base.x, resolution_base.y
    );

    tokio::time::sleep(Duration::from_millis(startup_delay_ms)).await;

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

    let frame_cb = Box::new(move |output: EditorFrameOutput| {
        let ws_frame = match output {
            EditorFrameOutput::Nv12(frame) => {
                let ws_format = match frame.format {
                    GpuOutputFormat::Nv12 => WSFrameFormat::Nv12 { full_range: false },
                    GpuOutputFormat::Rgba => WSFrameFormat::Rgba,
                };
                let metadata_bytes = match frame.format {
                    GpuOutputFormat::Nv12 => 28,
                    GpuOutputFormat::Rgba => 24,
                };
                let data = frame.data.into_vec();
                let bytes = data.len() + metadata_bytes;
                let ws_frame = WSFrame {
                    data: Arc::new(data),
                    width: frame.width,
                    height: frame.height,
                    stride: frame.y_stride,
                    frame_number: frame.frame_number,
                    target_time_ns: frame.target_time_ns,
                    format: ws_format,
                    created_at: Instant::now(),
                };
                let _ = frame_tx.send(bytes);
                ws_frame
            }
            EditorFrameOutput::Rgba(frame) => {
                let bytes = frame.data.len() + 24;
                let ws_frame = WSFrame {
                    data: frame.data,
                    width: frame.width,
                    height: frame.height,
                    stride: frame.padded_bytes_per_row,
                    frame_number: frame.frame_number,
                    target_time_ns: frame.target_time_ns,
                    format: WSFrameFormat::Rgba,
                    created_at: Instant::now(),
                };
                let _ = frame_tx.send(bytes);
                ws_frame
            }
        };
        frame_watch_tx.send(Some(Arc::new(ws_frame))).ok();
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

    let (_project_tx, project_rx) = watch::channel(project);
    let audio_output = Arc::new(cap_editor::AudioOutput::new());
    let playback = Playback {
        renderer: renderer.clone(),
        render_constants,
        start_frame_number: 0,
        project: project_rx,
        segment_medias,
        music: cap_editor::MusicTracks::new(),
        audio_output,
        telemetry: Some(telemetry),
    };

    let playback_handle = match playback.start(fps, resolution_base).await {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("Failed to start playback: {e:?}");
            std::process::exit(1);
        }
    };

    let start = Instant::now();
    let timeout = Duration::from_secs_f64(target_frames as f64 / fps as f64 + 15.0);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    let mut summary = Summary::default();

    loop {
        if summary.submitted_frames >= target_frames {
            break;
        }

        tokio::select! {
            event = telemetry_rx.recv() => {
                if let Some(event) = event {
                    summary.record_event(event);
                } else {
                    break;
                }
            }
            bytes = frame_rx.recv() => {
                if let Some(bytes) = bytes {
                    summary.record_callback_frame(bytes);
                }
            }
            _ = &mut deadline => {
                break;
            }
        }
    }

    let measured_elapsed = start.elapsed().as_secs_f64();

    playback_handle.stop();
    tokio::time::sleep(Duration::from_millis(250)).await;

    while let Ok(event) = telemetry_rx.try_recv() {
        summary.record_event(event);
    }
    while let Ok(bytes) = frame_rx.try_recv() {
        summary.record_callback_frame(bytes);
    }

    renderer.stop().await;
    ws_shutdown_token.cancel();

    let rendered_fps = summary.rendered_frames as f64 / measured_elapsed.max(0.001);
    let mb_sent = summary.bytes_from_callback as f64 / 1_000_000.0;
    let mb_per_sec = mb_sent / measured_elapsed.max(0.001);

    println!(
        "DISPLAY_BENCHMARK_RESULT submitted={} rendered={} callback={} renderer_dropped={} skipped={} send_failures={} rendered_fps={rendered_fps:.1} payload_mb={mb_sent:.1} payload_mb_per_sec={mb_per_sec:.1} warmup_ms={:.1}",
        summary.submitted_frames,
        summary.rendered_frames,
        summary.callback_frames,
        summary.dropped_by_renderer,
        summary.skipped_frames,
        summary.send_failures,
        summary.warmup_ms
    );

    if !summary.skip_reasons.is_empty() {
        println!("DISPLAY_BENCHMARK_SKIP_REASONS={:?}", summary.skip_reasons);
    }
    if !summary.output_formats.is_empty() {
        println!(
            "DISPLAY_BENCHMARK_OUTPUT_FORMATS={:?}",
            summary.output_formats
        );
    }
}
