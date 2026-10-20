use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::{ProjectConfiguration, XY};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let project_path = args.next().map(PathBuf::from).ok_or_else(|| {
        anyhow::anyhow!("Usage: export-audio-memory-benchmark <copy.cap> <output.mp4> [--hold] [--prepare-only] [--studio-sound]")
    })?;
    let output_path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass an unused output path"))?;
    anyhow::ensure!(!output_path.exists(), "Output already exists");
    let mut config = ProjectConfiguration::load(&project_path).map_err(anyhow::Error::msg)?;
    let mut prepare_only = false;
    for arg in args {
        match arg.to_str() {
            Some("--hold") => {
                let timeline = config
                    .timeline
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("The project needs a timeline"))?;
                anyhow::ensure!(
                    timeline.duration() > 7.0,
                    "The timeline must exceed seven seconds"
                );
                timeline
                    .text_segments
                    .push(serde_json::from_value(serde_json::json!({
                        "start": 5.0, "end": 7.0, "content": "Next step", "layout": "fullscreen"
                    }))?);
            }
            Some("--prepare-only") => prepare_only = true,
            Some("--studio-sound") => config.audio.improve = true,
            _ => anyhow::bail!("Unknown argument: {arg:?}"),
        }
    }
    let settings = Mp4ExportSettings {
        fps: 60,
        resolution_base: XY::new(1920, 1080),
        compression: ExportCompression::Social,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    };
    let started = Instant::now();
    let base = ExporterBase::builder(project_path)
        .with_config(config)
        .with_output_path(output_path)
        .build_for_mp4(Arc::new(AtomicBool::new(false)))
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;
    let streaming = base.uses_streaming_audio();
    let total_frames = base.total_frames(settings.fps);
    if !prepare_only {
        settings
            .export_prepared(base, |_| true)
            .await
            .map_err(anyhow::Error::msg)?;
    }
    println!(
        "{}",
        serde_json::json!({
            "streaming_audio": streaming,
            "prepare_only": prepare_only,
            "build_ms": build_ms,
            "total_ms": started.elapsed().as_secs_f64() * 1000.0,
            "total_frames": total_frames,
        })
    );
    Ok(())
}
