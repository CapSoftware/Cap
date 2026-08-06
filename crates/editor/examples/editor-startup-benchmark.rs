use std::{
    path::PathBuf,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use cap_editor::{
    EditorFrameOutput, EditorInstance, FrameLayout, Renderer, create_segments,
    finish_renderer_layers_creation, start_renderer_layers_creation,
};
use cap_project::{ProjectConfiguration, RecordingMeta, RecordingMetaInner};
use cap_rendering::{ProjectRecordingsMeta, RenderVideoConstants};

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|idx| args.get(idx + 1))
        .map(String::as_str)
}

fn percentile(data: &[f64], p: f64) -> f64 {
    let mut sorted: Vec<f64> = data.iter().copied().filter(|v| v.is_finite()).collect();
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

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn push_stage(stages: &mut Vec<(&'static str, f64)>, name: &'static str, start: &mut Instant) {
    stages.push((name, start.elapsed().as_secs_f64() * 1000.0));
    *start = Instant::now();
}

async fn profile_startup_stages(
    recording_path: PathBuf,
) -> Result<Vec<(&'static str, f64)>, String> {
    let mut stages = Vec::new();
    let total_start = Instant::now();
    let mut stage_start = Instant::now();

    let recording_meta = RecordingMeta::load_for_project(&recording_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;
    let RecordingMetaInner::Studio(meta) = &recording_meta.inner else {
        return Err("Cannot edit non-studio recordings".to_string());
    };
    push_stage(&mut stages, "load recording metadata", &mut stage_start);

    let project = recording_meta.project_config();
    push_stage(&mut stages, "load project config", &mut stage_start);

    let recordings = Arc::new(ProjectRecordingsMeta::new(
        &recording_meta.project_path,
        meta.as_ref(),
    )?);
    push_stage(&mut stages, "recordings metadata", &mut stage_start);

    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            (**meta).clone(),
        )
        .await
        .map_err(|e| format!("Failed to create render constants: {e}"))?,
    );
    push_stage(&mut stages, "render constants", &mut stage_start);

    let layers_rx = start_renderer_layers_creation(&render_constants, &project);
    push_stage(&mut stages, "start layer warmup", &mut stage_start);

    let _segments = create_segments(&recording_meta, meta.as_ref(), false).await?;
    push_stage(&mut stages, "create segments", &mut stage_start);

    let layers_rx = finish_renderer_layers_creation(layers_rx).await;
    push_stage(&mut stages, "finish layer warmup", &mut stage_start);

    let renderer = Renderer::spawn(
        render_constants,
        Box::new(|_: EditorFrameOutput, _: FrameLayout| {}),
        layers_rx,
    )?;
    push_stage(&mut stages, "spawn renderer", &mut stage_start);
    stages.push((
        "total startup-equivalent",
        total_start.elapsed().as_secs_f64() * 1000.0,
    ));

    renderer.stop().await;

    Ok(stages)
}

async fn run_stage_profile(recording_path: PathBuf, runs: usize) {
    let mut stage_values: Vec<(&'static str, Vec<f64>)> = Vec::new();

    for _ in 0..runs {
        let stages = profile_startup_stages(recording_path.clone())
            .await
            .expect("Failed to profile startup stages");

        for (stage_idx, (name, value)) in stages.into_iter().enumerate() {
            if stage_values.len() <= stage_idx {
                stage_values.push((name, Vec::with_capacity(runs)));
            }
            stage_values[stage_idx].1.push(value);
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    println!();
    println!("{}", "=".repeat(64));
    println!("  STARTUP STAGES");
    println!("{}", "=".repeat(64));

    for (name, values) in stage_values {
        let avg = values.iter().sum::<f64>() / values.len() as f64;
        let max = values.iter().copied().fold(0.0, f64::max);
        println!(
            "{name:<28} avg={avg:>6.1}ms p50={:>6.1}ms p95={:>6.1}ms max={max:>6.1}ms",
            percentile(&values, 50.0),
            percentile(&values, 95.0)
        );
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
        .expect("Usage: editor-startup-benchmark --recording-path <path> [--runs <count>]");
    let runs = arg_value(&args, "--runs")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(3)
        .max(1);
    let fps = arg_value(&args, "--fps")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(60);
    let preview_frame = arg_value(&args, "--preview-frame")
        .and_then(|s| s.parse::<u32>().ok())
        .or_else(|| {
            arg_value(&args, "--preview-time")
                .and_then(|s| s.parse::<f64>().ok())
                .map(|seconds| (seconds * fps as f64).round() as u32)
        })
        .unwrap_or(0);
    let profile_stages = has_flag(&args, "--profile-stages");
    let resolution_base = cap_project::XY::new(1248, 702);

    println!("{}", "=".repeat(64));
    println!("  CAP EDITOR STARTUP BENCHMARK");
    println!("{}", "=".repeat(64));
    println!("Recording: {}", recording_path.display());
    println!("Runs: {runs}");
    println!("Preview frame: {preview_frame}");
    println!("Profile stages: {profile_stages}");

    let mut values_ms = Vec::with_capacity(runs);
    let mut preview_values_ms = Vec::with_capacity(runs);

    for run in 0..runs {
        let before_config = ProjectConfiguration::load(&recording_path).unwrap_or_default();
        let before_has_timeline = before_config.timeline.is_some();
        let before_clip_count = before_config.clips.len();
        let before_meta_loaded = RecordingMeta::load_for_project(&recording_path).is_ok();

        let (frame_tx, frame_rx) = mpsc::channel::<()>();
        let start = Instant::now();
        let editor = EditorInstance::new(
            recording_path.clone(),
            |_| {},
            Box::new(move |_: EditorFrameOutput, _: FrameLayout| {
                let _ = frame_tx.send(());
            }),
            None,
        )
        .await
        .expect("Failed to create editor instance");
        let elapsed = start.elapsed();
        values_ms.push(elapsed.as_secs_f64() * 1000.0);

        let preview_start = Instant::now();
        editor
            .preview_tx
            .send(Some((preview_frame, fps, resolution_base)))
            .expect("Failed to request preview frame");
        let preview_elapsed = if frame_rx.recv_timeout(Duration::from_secs(10)).is_ok() {
            preview_start.elapsed().as_secs_f64() * 1000.0
        } else {
            f64::INFINITY
        };
        preview_values_ms.push(preview_elapsed);

        editor.dispose().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let after_config = ProjectConfiguration::load(&recording_path).unwrap_or_default();
        println!(
            "Run {}: {:.1}ms preview={:.1}ms meta_loaded={} timeline {}->{} clips {}->{}",
            run + 1,
            elapsed.as_secs_f64() * 1000.0,
            preview_elapsed,
            before_meta_loaded,
            before_has_timeline,
            after_config.timeline.is_some(),
            before_clip_count,
            after_config.clips.len()
        );
    }

    let avg = values_ms.iter().sum::<f64>() / values_ms.len() as f64;
    let max = values_ms.iter().copied().fold(0.0, f64::max);

    println!();
    println!("{}", "=".repeat(64));
    println!("  RESULTS");
    println!("{}", "=".repeat(64));
    println!(
        "Startup: avg={avg:.1}ms p50={:.1}ms p95={:.1}ms max={max:.1}ms samples={}",
        percentile(&values_ms, 50.0),
        percentile(&values_ms, 95.0),
        values_ms.len()
    );
    let preview_avg = preview_values_ms.iter().sum::<f64>() / preview_values_ms.len() as f64;
    let preview_max = preview_values_ms.iter().copied().fold(0.0, f64::max);
    println!(
        "First preview: avg={preview_avg:.1}ms p50={:.1}ms p95={:.1}ms max={preview_max:.1}ms samples={}",
        percentile(&preview_values_ms, 50.0),
        percentile(&preview_values_ms, 95.0),
        preview_values_ms.len()
    );

    if profile_stages {
        run_stage_profile(recording_path, runs).await;
    }
}
