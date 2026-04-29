use anyhow::{Context, Result, bail};
use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::{ProjectConfiguration, RecordingMeta, RecordingMetaInner, XY};
use cap_rendering::{
    FrameRenderer, ProjectRecordingsMeta, ProjectUniforms, RenderVideoConstants, RendererLayers,
    ZoomFocusInterpolator, spring_mass_damper::SpringMassDamperSimulationConfig,
};
use chrono::Utc;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use tempfile::TempDir;

use crate::discovery::DiscoveredHardware;
use crate::results::{
    FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta, ResultsSummary, TestCaseConfig,
    TestResult, TestResults,
};

const PLAYBACK_FPS: u32 = 30;
const PLAYBACK_RESOLUTION: XY<u32> = XY::new(1920, 1080);
const MAX_PLAYBACK_FAILURE_RATE: f64 = 5.0;
const MAX_OPEN_TIME_SECS: f64 = 30.0;
const MAX_EXPORT_START_SECS: f64 = 60.0;
const MAX_EXPORT_SAMPLE_FRAMES: u32 = 120;
const MAX_EXPORT_WALL_TIME_SECS: u64 = 180;

pub async fn run_suite(
    hardware: &DiscoveredHardware,
    recording_path: &Path,
    duration: u64,
) -> Result<TestResults> {
    ffmpeg::init().ok();

    let start = Instant::now();
    let mut results = Vec::new();
    let sample_duration_secs = duration.max(1);

    if let Some(skipped_results) = probe_windows_ci_software_adapter(recording_path).await {
        let summary = ResultsSummary::from_results(&skipped_results, start.elapsed());

        return Ok(TestResults {
            meta: ResultsMeta {
                timestamp: Utc::now(),
                config_name: "Performance Suite".to_string(),
                config_path: Some(recording_path.display().to_string()),
                platform: hardware.system_info.platform.clone(),
                system: hardware.system_info.clone(),
                cap_version: None,
            },
            hardware: Some(hardware.clone()),
            results: skipped_results,
            summary,
        });
    }

    results.push(run_open_test(recording_path).await);
    results.push(run_playback_test(recording_path, sample_duration_secs).await);
    results.push(run_export_test(recording_path).await);

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Performance Suite".to_string(),
            config_path: Some(recording_path.display().to_string()),
            platform: hardware.system_info.platform.clone(),
            system: hardware.system_info.clone(),
            cap_version: None,
        },
        hardware: Some(hardware.clone()),
        results,
        summary,
    })
}

#[cfg(target_os = "windows")]
async fn probe_windows_ci_software_adapter(recording_path: &Path) -> Option<Vec<TestResult>> {
    if !std::env::var("GITHUB_ACTIONS")
        .map(|value| value == "true")
        .unwrap_or(false)
    {
        return None;
    }

    let (is_software, adapter_name) = cap_rendering::probe_software_adapter().await?;

    if !is_software {
        return None;
    }

    let reason = format!(
        "Windows GitHub Actions exposed software rendering via {adapter_name}; performance gate skipped because the runner cannot provide representative GPU metrics"
    );
    let notes = vec![format!("adapter={adapter_name}")];

    Some(vec![
        skipped_result(
            "performance-open",
            "Fixture Open",
            fixture_config(recording_path),
            &reason,
            &notes,
        ),
        skipped_result(
            "performance-playback",
            "Editor Playback",
            fixture_config(recording_path),
            &reason,
            &notes,
        ),
        skipped_result(
            "performance-export",
            "Export Startup And Throughput",
            fixture_config(recording_path),
            &reason,
            &notes,
        ),
    ])
}

#[cfg(not(target_os = "windows"))]
async fn probe_windows_ci_software_adapter(_recording_path: &Path) -> Option<Vec<TestResult>> {
    None
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn skipped_result(
    test_id: &str,
    name: &str,
    config: TestCaseConfig,
    reason: &str,
    notes: &[String],
) -> TestResult {
    let mut result = TestResult::new(test_id.to_string(), name.to_string(), config);
    result.set_skipped(reason);
    result.notes.extend(notes.iter().cloned());
    result
}

struct FixtureContext {
    project: ProjectConfiguration,
    render_constants: Arc<RenderVideoConstants>,
    segments: Vec<cap_editor::SegmentMedia>,
}

#[derive(Default)]
struct PlaybackMetrics {
    requested_frames: u64,
    rendered_frames: u64,
    decode_failures: u64,
    render_failures: u64,
    decode_times_ms: Vec<f64>,
    render_times_ms: Vec<f64>,
    total_times_ms: Vec<f64>,
    setup_secs: f64,
    elapsed_secs: f64,
    adapter_name: String,
    software_adapter: bool,
}

struct ExportMetrics {
    elapsed: Duration,
    first_progress_secs: Option<f64>,
    output_path: PathBuf,
    total_frames: u32,
    rendered_frames: u32,
    effective_fps: f64,
}

async fn run_open_test(recording_path: &Path) -> TestResult {
    let config = fixture_config(recording_path);
    let mut result = TestResult::new(
        "performance-open".to_string(),
        "Fixture Open".to_string(),
        config,
    );

    let start = Instant::now();

    match load_fixture(recording_path).await {
        Ok(context) => {
            let setup_secs = start.elapsed().as_secs_f64();
            let mut iteration = IterationResult {
                iteration: 0,
                duration_secs: setup_secs,
                frames: FrameMetrics {
                    received: 1,
                    encoded: 1,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: 1.0 / setup_secs.max(0.001),
                    target_fps: 1,
                },
                latency_ms: repeated_latency(setup_secs * 1000.0),
                encoding_ms: None,
                av_sync_ms: None,
                errors: Vec::new(),
            };

            let mut notes = vec![
                format!("adapter={}", context.render_constants.adapter_name()),
                format!(
                    "software_adapter={}",
                    context.render_constants.is_software_adapter
                ),
                format!("segments={}", context.segments.len()),
            ];

            if let Err(error) = render_single_frame(&context).await {
                iteration.errors.push(error.to_string());
                result.set_failed(&format!(
                    "Fixture opened but first frame render failed: {error}"
                ));
            } else if setup_secs > MAX_OPEN_TIME_SECS {
                result.set_failed(&format!(
                    "Fixture open exceeded {:.1}s ({setup_secs:.2}s)",
                    MAX_OPEN_TIME_SECS
                ));
            }

            result.notes.append(&mut notes);
            result.add_iteration(iteration);
        }
        Err(error) => {
            result.set_error(&format!("Failed to open fixture: {error:#}"));
        }
    }

    result
}

async fn run_playback_test(recording_path: &Path, sample_duration_secs: u64) -> TestResult {
    let config = fixture_config(recording_path);
    let mut result = TestResult::new(
        "performance-playback".to_string(),
        "Editor Playback".to_string(),
        config,
    );

    match benchmark_playback(recording_path, sample_duration_secs).await {
        Ok(metrics) => {
            let requested_frames = metrics.requested_frames.max(1);
            let dropped = metrics.decode_failures + metrics.render_failures;
            let drop_rate_percent = dropped as f64 / requested_frames as f64 * 100.0;
            let iteration = IterationResult {
                iteration: 0,
                duration_secs: metrics.elapsed_secs,
                frames: FrameMetrics {
                    received: requested_frames,
                    encoded: metrics.rendered_frames,
                    dropped,
                    drop_rate_percent,
                    effective_fps: metrics.rendered_frames as f64 / metrics.elapsed_secs.max(0.001),
                    target_fps: PLAYBACK_FPS,
                },
                latency_ms: LatencyMetrics {
                    avg: average(&metrics.total_times_ms),
                    min: metrics.total_times_ms.first().copied().unwrap_or_default(),
                    p50: percentile(&metrics.total_times_ms, 50.0),
                    p95: percentile(&metrics.total_times_ms, 95.0),
                    p99: percentile(&metrics.total_times_ms, 99.0),
                    max: metrics.total_times_ms.last().copied().unwrap_or_default(),
                },
                encoding_ms: Some(LatencyMetrics {
                    avg: average(&metrics.render_times_ms),
                    min: metrics.render_times_ms.first().copied().unwrap_or_default(),
                    p50: percentile(&metrics.render_times_ms, 50.0),
                    p95: percentile(&metrics.render_times_ms, 95.0),
                    p99: percentile(&metrics.render_times_ms, 99.0),
                    max: metrics.render_times_ms.last().copied().unwrap_or_default(),
                }),
                av_sync_ms: None,
                errors: Vec::new(),
            };

            result
                .notes
                .push(format!("adapter={}", metrics.adapter_name));
            result
                .notes
                .push(format!("software_adapter={}", metrics.software_adapter));
            result
                .notes
                .push(format!("fixture_setup_secs={:.2}", metrics.setup_secs));

            let max_p95 = if metrics.software_adapter {
                250.0
            } else {
                120.0
            };

            if metrics.rendered_frames == 0 {
                result.set_failed("Playback never rendered a frame");
            } else if drop_rate_percent > MAX_PLAYBACK_FAILURE_RATE {
                result.set_failed(&format!(
                    "Playback failure rate too high: {drop_rate_percent:.2}%"
                ));
            } else if iteration.latency_ms.p95 > max_p95 {
                result.set_failed(&format!(
                    "Playback p95 latency too high: {:.2}ms > {:.2}ms",
                    iteration.latency_ms.p95, max_p95
                ));
            }

            result.add_iteration(iteration);
        }
        Err(error) => {
            result.set_error(&format!("Playback benchmark failed: {error:#}"));
        }
    }

    result
}

async fn run_export_test(recording_path: &Path) -> TestResult {
    let config = fixture_config(recording_path);
    let mut result = TestResult::new(
        "performance-export".to_string(),
        "Export Startup And Throughput".to_string(),
        config,
    );

    match benchmark_export(recording_path).await {
        Ok(metrics) => {
            let rendered_frames = metrics.rendered_frames.max(1);
            let per_frame_ms = metrics.elapsed.as_secs_f64() * 1000.0 / rendered_frames as f64;
            let first_progress_ms = metrics.first_progress_secs.unwrap_or_default() * 1000.0;
            let iteration = IterationResult {
                iteration: 0,
                duration_secs: metrics.elapsed.as_secs_f64(),
                frames: FrameMetrics {
                    received: metrics.total_frames as u64,
                    encoded: metrics.rendered_frames as u64,
                    dropped: metrics.total_frames.saturating_sub(metrics.rendered_frames) as u64,
                    drop_rate_percent: if metrics.total_frames > 0 {
                        metrics.total_frames.saturating_sub(metrics.rendered_frames) as f64
                            / metrics.total_frames as f64
                            * 100.0
                    } else {
                        0.0
                    },
                    effective_fps: metrics.effective_fps,
                    target_fps: PLAYBACK_FPS,
                },
                latency_ms: repeated_latency(first_progress_ms),
                encoding_ms: Some(repeated_latency(per_frame_ms)),
                av_sync_ms: None,
                errors: Vec::new(),
            };

            result
                .notes
                .push(format!("output={}", metrics.output_path.display()));
            result
                .notes
                .push(format!("total_frames={}", metrics.total_frames));
            result
                .notes
                .push(format!("rendered_frames={}", metrics.rendered_frames));

            let min_export_fps = 3.0;

            if metrics.first_progress_secs.is_none() {
                result.set_failed("Export never reported frame progress");
            } else if metrics.first_progress_secs.unwrap_or_default() > MAX_EXPORT_START_SECS {
                result.set_failed(&format!(
                    "Export did not start within {:.1}s",
                    MAX_EXPORT_START_SECS
                ));
            } else if metrics.effective_fps < min_export_fps {
                result.set_failed(&format!(
                    "Export throughput too low: {:.2} fps < {:.2} fps",
                    metrics.effective_fps, min_export_fps
                ));
            }

            result.add_iteration(iteration);
        }
        Err(error) => {
            result.set_error(&format!("Export benchmark failed: {error:#}"));
        }
    }

    result
}

async fn benchmark_playback(
    recording_path: &Path,
    sample_duration_secs: u64,
) -> Result<PlaybackMetrics> {
    let setup_start = Instant::now();
    let context = load_fixture(recording_path).await?;
    let setup_secs = setup_start.elapsed().as_secs_f64();
    let duration = context
        .project
        .timeline
        .as_ref()
        .map(|timeline| timeline.duration())
        .unwrap_or_default();
    let requested_frames =
        ((duration.min(sample_duration_secs as f64)) * PLAYBACK_FPS as f64).ceil() as u64;

    if requested_frames == 0 {
        bail!("Fixture timeline contains no playable frames");
    }

    let mut frame_renderer = FrameRenderer::new(&context.render_constants);
    let mut layers = create_layers(&context)?;
    let cursor_smoothing =
        (!context.project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: context.project.cursor.tension,
            mass: context.project.cursor.mass,
            friction: context.project.cursor.friction,
        });

    let mut metrics = PlaybackMetrics {
        requested_frames,
        setup_secs,
        adapter_name: context.render_constants.adapter_name().to_string(),
        software_adapter: context.render_constants.is_software_adapter,
        ..Default::default()
    };

    let playback_start = Instant::now();

    for frame_number in 0..requested_frames {
        let frame_time = frame_number as f64 / PLAYBACK_FPS as f64;
        let Some((segment_time, segment)) = context.project.get_segment_time(frame_time) else {
            break;
        };

        let Some(segment_media) = context.segments.get(segment.recording_clip as usize) else {
            metrics.decode_failures += 1;
            continue;
        };

        let clip_offsets = context
            .project
            .clips
            .iter()
            .find(|clip| clip.index == segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();

        let decode_start = Instant::now();
        let frames = if frame_number == 0 {
            segment_media
                .decoders
                .get_frames_initial(
                    segment_time as f32,
                    !context.project.camera.hide,
                    true,
                    clip_offsets,
                )
                .await
        } else {
            segment_media
                .decoders
                .get_frames(
                    segment_time as f32,
                    !context.project.camera.hide,
                    true,
                    clip_offsets,
                )
                .await
        };
        let decode_ms = decode_start.elapsed().as_secs_f64() * 1000.0;

        let Some(segment_frames) = frames else {
            metrics.decode_failures += 1;
            continue;
        };

        let zoom_focus_interpolator = ZoomFocusInterpolator::new(
            &segment_media.cursor,
            cursor_smoothing,
            context.project.cursor.click_spring_config(),
            context.project.screen_movement_spring,
            duration,
            context
                .project
                .timeline
                .as_ref()
                .map(|t| t.zoom_segments.as_slice())
                .unwrap_or(&[]),
        );

        let uniforms = ProjectUniforms::new(
            &context.render_constants,
            &context.project,
            frame_number as u32,
            PLAYBACK_FPS,
            PLAYBACK_RESOLUTION,
            &segment_media.cursor,
            &segment_frames,
            duration,
            &zoom_focus_interpolator,
        );

        let render_start = Instant::now();
        match frame_renderer
            .render_immediate(
                segment_frames,
                uniforms,
                &segment_media.cursor,
                true,
                &mut layers,
            )
            .await
        {
            Ok(_) => {
                let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
                metrics.decode_times_ms.push(decode_ms);
                metrics.render_times_ms.push(render_ms);
                metrics.total_times_ms.push(decode_ms + render_ms);
                metrics.rendered_frames += 1;
            }
            Err(_) => {
                metrics.render_failures += 1;
            }
        }
    }

    metrics.decode_times_ms.sort_by(f64::total_cmp);
    metrics.render_times_ms.sort_by(f64::total_cmp);
    metrics.total_times_ms.sort_by(f64::total_cmp);
    metrics.elapsed_secs = playback_start.elapsed().as_secs_f64();

    Ok(metrics)
}

async fn benchmark_export(recording_path: &Path) -> Result<ExportMetrics> {
    let output_dir = TempDir::new().context("failed to create export tempdir")?;
    let planned_output_path = output_dir.path().join("performance-export.mp4");
    let exporter_base = ExporterBase::builder(recording_path.to_path_buf())
        .with_output_path(planned_output_path.clone())
        .build()
        .await
        .map_err(|error| anyhow::anyhow!("failed to build exporter base: {error}"))?;

    let settings = Mp4ExportSettings {
        fps: PLAYBACK_FPS,
        resolution_base: PLAYBACK_RESOLUTION,
        compression: ExportCompression::Social,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    };

    let total_frames = exporter_base.total_frames(settings.fps);
    let sample_frames = total_frames.clamp(1, MAX_EXPORT_SAMPLE_FRAMES);
    let started_at = Instant::now();
    let last_frame = Arc::new(AtomicU32::new(0));
    let first_progress = Arc::new(Mutex::new(None));
    let progress_started_at = started_at;
    let progress_frame = Arc::clone(&last_frame);
    let progress_first = Arc::clone(&first_progress);
    let stop_after_frame = sample_frames;

    let export_result = tokio::time::timeout(
        Duration::from_secs(MAX_EXPORT_WALL_TIME_SECS),
        settings.export(exporter_base, move |frame| {
            progress_frame.store(frame, Ordering::Relaxed);
            let mut first = progress_first.lock().unwrap_or_else(|err| err.into_inner());
            if first.is_none() {
                *first = Some(progress_started_at.elapsed().as_secs_f64());
            }
            frame.saturating_add(1) < stop_after_frame
        }),
    )
    .await
    .context("export timed out")?;

    let elapsed = started_at.elapsed();
    let rendered_frames = last_frame
        .load(Ordering::Relaxed)
        .saturating_add(1)
        .min(sample_frames);
    let first_progress_secs = *first_progress.lock().unwrap_or_else(|err| err.into_inner());
    let sampled_enough = rendered_frames >= sample_frames && first_progress_secs.is_some();

    let output_path = match export_result {
        Ok(path) => path,
        Err(_error) if sampled_enough => planned_output_path.clone(),
        Err(error) => return Err(anyhow::Error::msg(error)),
    };

    if !sampled_enough && !output_path.exists() {
        bail!(
            "Export completed but output is missing at {}",
            output_path.display()
        );
    }

    Ok(ExportMetrics {
        elapsed,
        first_progress_secs,
        output_path,
        total_frames: sample_frames,
        rendered_frames,
        effective_fps: rendered_frames as f64 / elapsed.as_secs_f64().max(0.001),
    })
}

async fn load_fixture(recording_path: &Path) -> Result<FixtureContext> {
    let recording_meta = RecordingMeta::load_for_project(recording_path).map_err(|error| {
        anyhow::anyhow!(
            "failed to load recording meta from {}: {error}",
            recording_path.display()
        )
    })?;

    let RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        bail!("Fixture is not a studio recording");
    };

    let studio_meta = studio_meta.as_ref().clone();
    let project = recording_meta.project_config();
    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, &studio_meta)
            .map_err(anyhow::Error::msg)?,
    );
    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            studio_meta.clone(),
        )
        .await
        .map_err(anyhow::Error::msg)?,
    );
    let segments = cap_editor::create_segments(&recording_meta, &studio_meta, false)
        .await
        .map_err(anyhow::Error::msg)?;

    if segments.is_empty() {
        bail!("Fixture did not produce any editor segments");
    }

    Ok(FixtureContext {
        project,
        render_constants,
        segments,
    })
}

async fn render_single_frame(context: &FixtureContext) -> Result<()> {
    let mut frame_renderer = FrameRenderer::new(&context.render_constants);
    let mut layers = create_layers(context)?;
    let duration = context
        .project
        .timeline
        .as_ref()
        .map(|timeline| timeline.duration())
        .unwrap_or_default();
    let Some(segment_media) = context.segments.first() else {
        bail!("No segment media available");
    };
    let clip_offsets = context
        .project
        .clips
        .iter()
        .find(|clip| clip.index == 0)
        .map(|clip| clip.offsets)
        .unwrap_or_default();
    let frames = segment_media
        .decoders
        .get_frames_initial(0.0, !context.project.camera.hide, true, clip_offsets)
        .await
        .ok_or_else(|| anyhow::anyhow!("Initial frame decode returned no frame"))?;
    let cursor_smoothing =
        (!context.project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: context.project.cursor.tension,
            mass: context.project.cursor.mass,
            friction: context.project.cursor.friction,
        });
    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
        &segment_media.cursor,
        cursor_smoothing,
        context.project.cursor.click_spring_config(),
        context.project.screen_movement_spring,
        duration,
        context
            .project
            .timeline
            .as_ref()
            .map(|t| t.zoom_segments.as_slice())
            .unwrap_or(&[]),
    );
    let uniforms = ProjectUniforms::new(
        &context.render_constants,
        &context.project,
        0,
        PLAYBACK_FPS,
        PLAYBACK_RESOLUTION,
        &segment_media.cursor,
        &frames,
        duration,
        &zoom_focus_interpolator,
    );

    frame_renderer
        .render_immediate(frames, uniforms, &segment_media.cursor, true, &mut layers)
        .await
        .map(|_| ())
        .map_err(anyhow::Error::msg)
}

fn create_layers(context: &FixtureContext) -> Result<RendererLayers> {
    let mut layers = RendererLayers::new_with_options(
        &context.render_constants.device,
        &context.render_constants.queue,
        context.render_constants.is_software_adapter,
    );
    let first_segment = context
        .segments
        .first()
        .ok_or_else(|| anyhow::anyhow!("No segments available"))?;
    let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
    let camera_dims = first_segment.decoders.camera_video_dimensions();
    layers.prepare_for_video_dimensions(
        &context.render_constants.device,
        screen_w,
        screen_h,
        camera_dims.map(|(width, _)| width),
        camera_dims.map(|(_, height)| height),
    );
    Ok(layers)
}

fn fixture_config(recording_path: &Path) -> TestCaseConfig {
    TestCaseConfig {
        display: Some(crate::results::DisplayTestConfig {
            width: PLAYBACK_RESOLUTION.x,
            height: PLAYBACK_RESOLUTION.y,
            fps: PLAYBACK_FPS,
            display_id: Some(recording_path.display().to_string()),
        }),
        camera: None,
        audio: None,
        duration_secs: 0,
    }
}

fn repeated_latency(value: f64) -> LatencyMetrics {
    LatencyMetrics {
        avg: value,
        min: value,
        p50: value,
        p95: value,
        p99: value,
        max: value,
    }
}

fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let idx = ((p / 100.0) * (values.len() - 1) as f64).round() as usize;
    values[idx.min(values.len() - 1)]
}
