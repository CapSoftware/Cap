use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_editor::EditorInstance;
use cap_export::{
    ExporterBase, estimates::estimate_export, make_cursor_only_project, settings::ExportSettings,
};
use clap::Parser;

#[derive(Parser)]
struct Args {
    project: PathBuf,
    settings: String,
    #[arg(long)]
    cancel_after_ms: Option<u64>,
    #[arg(long, conflicts_with = "cancel_after_ms")]
    cancel_after_first_sample: bool,
    #[arg(long)]
    estimate_only: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    let settings: ExportSettings = serde_json::from_str(&args.settings)?;
    let editor =
        EditorInstance::new(args.project.clone(), |_| {}, Box::new(|_, _| {}), None).await?;
    for segment in editor.segment_medias.iter() {
        segment.audio.get().await?;
        segment.system_audio.get().await?;
    }
    let project = editor.project_config.1.borrow().clone();
    let (resolution_base, compression_bpp) = match settings {
        ExportSettings::Mp4(settings) => (settings.resolution_base, settings.effective_bpp()),
        ExportSettings::Gif(settings) => (settings.resolution_base, 0.3),
        ExportSettings::Mov(settings) => (settings.resolution_base, 0.3),
    };
    let preview = cap_export::preview::render_preview_with_editor(
        &editor,
        project.clone(),
        0.0,
        cap_export::preview::ExportPreviewSettings {
            fps: settings.fps(),
            resolution_base,
            compression_bpp,
            cursor_only: settings.cursor_only(),
        },
    )
    .await?;
    let old_time_seconds = preview.frame_render_time_ms * f64::from(preview.total_frames)
        / 1000.0
        / if matches!(settings, ExportSettings::Gif(_)) {
            4.0
        } else {
            10.0
        };
    let started = Instant::now();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancellation = args.cancel_after_ms.map(|milliseconds| {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(milliseconds)).await;
            cancel.store(true, Ordering::Release);
        })
    });
    let mut updates = Vec::new();
    let estimate = estimate_export(
        editor.clone(),
        project.clone(),
        settings,
        cancel.clone(),
        |estimate| {
            updates.push(serde_json::json!({
                "seconds": started.elapsed().as_secs_f64(),
                "estimate": estimate,
            }));
            if args.cancel_after_first_sample {
                cancel.store(true, Ordering::Release);
            }
        },
    )
    .await;
    let sample_seconds = started.elapsed().as_secs_f64();
    if let Some(cancellation) = cancellation {
        cancellation.await?;
    }
    if args.cancel_after_ms.is_some() || args.cancel_after_first_sample {
        assert!(estimate.is_err());
        assert!(!editor.export_preview_active.load(Ordering::Acquire));
        if args.cancel_after_first_sample {
            assert_eq!(updates.len(), 1);
        }
        editor.dispose().await;
        println!(
            "{}",
            serde_json::json!({
                "cancelled": true,
                "sampling_seconds": sample_seconds,
                "updates": updates,
            })
        );
        return Ok(());
    }
    let estimate = estimate?;
    let cached_started = Instant::now();
    let cached = estimate_export(editor.clone(), project.clone(), settings, cancel, |_| {
        panic!("A cached estimate should not sample again");
    })
    .await?;
    let cached_seconds = cached_started.elapsed().as_secs_f64();
    assert_eq!(
        serde_json::to_value(&estimate)?,
        serde_json::to_value(cached)?
    );
    editor.dispose().await;
    if args.estimate_only {
        println!(
            "{}",
            serde_json::json!({
                "estimate": estimate,
                "updates": updates,
                "sampling_seconds": sample_seconds,
                "cached_seconds": cached_seconds,
            })
        );
        return Ok(());
    }
    let output = tempfile::tempdir()?;
    let config = if settings.cursor_only() {
        make_cursor_only_project(project)
    } else {
        project
    };
    let started = Instant::now();
    let base = ExporterBase::builder(args.project)
        .with_config(config)
        .with_output_path(output.path().join("actual.mp4"))
        .with_force_ffmpeg_decoder(settings.force_ffmpeg_decoder())
        .build()
        .await?;
    let path = match settings {
        ExportSettings::Mp4(settings) => settings.export(base, |_| true).await?,
        ExportSettings::Gif(settings) => settings.export(base, |_| true).await?,
        ExportSettings::Mov(settings) => settings.export(base, |_| true).await?,
    };
    let actual_seconds = started.elapsed().as_secs_f64();
    let actual_mb = std::fs::metadata(path)?.len() as f64 / (1024.0 * 1024.0);
    println!(
        "{}",
        serde_json::json!({
            "estimate": estimate,
        "previous_estimated_seconds": old_time_seconds,
        "previous_estimated_size_mb": preview.estimated_size_mb,
            "sampling_seconds": sample_seconds,
            "updates": updates,
            "cached_seconds": cached_seconds,
            "actual_seconds": actual_seconds,
            "actual_size_mb": actual_mb,
            "time_error_percent": (estimate.estimated_time_seconds / actual_seconds - 1.0) * 100.0,
            "size_error_percent": (estimate.estimated_size_mb / actual_mb - 1.0) * 100.0,
        })
    );
    Ok(())
}
