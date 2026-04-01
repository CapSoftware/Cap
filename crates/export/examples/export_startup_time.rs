use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;
use std::{env, path::PathBuf, time::Instant};

#[tokio::main]
async fn main() -> Result<(), String> {
    let project_path = env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| "usage: export_startup_time <path-to-project.cap>".to_string())?;

    let settings = Mp4ExportSettings {
        fps: 60,
        resolution_base: XY { x: 3840, y: 2160 },
        compression: ExportCompression::Maximum,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    };

    let temp_out = tempfile::Builder::new()
        .suffix(".mp4")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let temp_path = temp_out.path().to_path_buf();

    let build_start = Instant::now();
    let base = ExporterBase::builder(project_path.clone())
        .with_output_path(temp_path)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let build_ms = build_start.elapsed().as_millis() as u64;

    let total_frames = base.total_frames(settings.fps);

    let pipeline_start = Instant::now();
    let bench = settings
        .benchmark_first_frame_with_breakdown(base)
        .await
        .map_err(|e| e.to_string())?;
    let benchmark_total_ms = pipeline_start.elapsed().as_millis() as u64;

    let line = serde_json::json!({
        "project": project_path.to_string_lossy(),
        "build_ms": build_ms,
        "ms_to_first_frame_queued_since_export_pipeline_start": bench.ms_to_first_frame_queued_since_export_pipeline_start,
        "nv12_render_startup_breakdown_ms": bench.nv12_render_startup_breakdown_ms,
        "benchmark_wall_ms_including_encoder_finish": benchmark_total_ms,
        "total_frames_at_60fps": total_frames,
        "note": "ms_to_first_frame_queued is from NV12 pipeline start until first queue_video_frame_reusable succeeds (editor export path)",
    });
    println!("{line}");

    Ok(())
}
