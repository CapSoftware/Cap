use std::{path::PathBuf, time::Instant};

use cap_rendering::{Video, decoder::spawn_decoder};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let mut arguments = std::env::args_os().skip(1);
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass a video path and optional audio path"))?;
    let audio_path = arguments.next().map(PathBuf::from);
    let force_ffmpeg = std::env::var_os("CAP_BENCH_FORCE_FFMPEG").is_some();
    let started = Instant::now();
    let video = Video::new(&path, 0.0).map_err(anyhow::Error::msg)?;
    let probe_ms = started.elapsed().as_secs_f64() * 1000.0;
    let decoder = spawn_decoder(
        "readiness-benchmark",
        path.clone(),
        video.fps,
        0.0,
        force_ffmpeg,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    let initialized_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut frames = Vec::new();
    for time in [0.0, video.duration * 0.5, video.duration - 1.0, 1.0] {
        let requested = Instant::now();
        let frame = decoder
            .get_frame_initial(time.max(0.0) as f32)
            .await
            .ok_or_else(|| anyhow::anyhow!("No frame at {time}"))?;
        frames.push(serde_json::json!({
            "timeSeconds": time,
            "elapsedMs": requested.elapsed().as_secs_f64() * 1000.0,
            "sinceOpenMs": started.elapsed().as_secs_f64() * 1000.0,
            "width": frame.width(),
            "height": frame.height(),
        }));
    }
    let audio_ms = if let Some(audio_path) = audio_path {
        let started = Instant::now();
        cap_editor::AudioLoader::spawn(audio_path, "readiness-benchmark".into())
            .get()
            .await
            .map_err(anyhow::Error::msg)?
            .ok_or_else(|| anyhow::anyhow!("No decoded audio"))?;
        Some(started.elapsed().as_secs_f64() * 1000.0)
    } else {
        None
    };
    println!(
        "{}",
        serde_json::json!({
            "path": path,
            "durationSeconds": video.duration,
            "probeMs": probe_ms,
            "initializedMs": initialized_ms,
            "decoder": decoder.decoder_type().to_string(),
            "fallbackReason": decoder.fallback_reason(),
            "frames": frames,
            "audioReadyMs": audio_ms,
        })
    );
    Ok(())
}
