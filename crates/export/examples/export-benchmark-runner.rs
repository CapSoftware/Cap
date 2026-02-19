use cap_export::{
    ExporterBase,
    gif::GifExportSettings,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;
use chrono::{Local, Utc};
use clap::{Parser, Subcommand};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

const SOURCE_VIDEO_WIDTH: u32 = 1920;
const SOURCE_VIDEO_HEIGHT: u32 = 1080;
const SOURCE_VIDEO_FPS: u32 = 30;

#[derive(Parser)]
#[command(name = "export-benchmark-runner")]
#[command(about = "Run export benchmarks across all preset combinations")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(
        long,
        global = true,
        help = "Write benchmark results to EXPORT-BENCHMARKS.md"
    )]
    benchmark_output: bool,

    #[arg(
        long,
        global = true,
        help = "Optional notes to include with this benchmark run"
    )]
    notes: Option<String>,

    #[arg(
        long,
        global = true,
        default_value = "30",
        help = "Duration of test video in seconds"
    )]
    duration: u32,

    #[arg(long, global = true, help = "Keep temporary files after benchmark")]
    keep_outputs: bool,

    #[arg(
        long,
        global = true,
        help = "Path to an existing Cap recording to use instead of generating synthetic video"
    )]
    recording_path: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Commands {
    Quick,
    Full,
    Mp4Only,
    GifOnly,
}

#[derive(Debug, Clone, Copy)]
enum ExportPreset {
    Mp4 {
        width: u32,
        height: u32,
        fps: u32,
        compression: ExportCompression,
    },
    Gif {
        width: u32,
        height: u32,
        fps: u32,
    },
}

impl ExportPreset {
    fn label(&self) -> String {
        match self {
            Self::Mp4 {
                width,
                height,
                fps,
                compression,
            } => {
                let res = resolution_label(*width, *height);
                let comp = compression_label(*compression);
                format!("MP4 {res}/{fps}fps/{comp}")
            }
            Self::Gif { width, height, fps } => {
                let res = resolution_label(*width, *height);
                format!("GIF {res}/{fps}fps")
            }
        }
    }

    fn resolution(&self) -> (u32, u32) {
        match self {
            Self::Mp4 { width, height, .. } | Self::Gif { width, height, .. } => (*width, *height),
        }
    }

    fn fps(&self) -> u32 {
        match self {
            Self::Mp4 { fps, .. } | Self::Gif { fps, .. } => *fps,
        }
    }
}

fn resolution_label(width: u32, height: u32) -> &'static str {
    match (width, height) {
        (1280, 720) => "720p",
        (1920, 1080) => "1080p",
        (3840, 2160) => "4K",
        _ => "custom",
    }
}

fn compression_label(c: ExportCompression) -> &'static str {
    match c {
        ExportCompression::Maximum => "Maximum",
        ExportCompression::Social => "Social",
        ExportCompression::Web => "Web",
        ExportCompression::Potato => "Potato",
    }
}

fn quick_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset::Mp4 {
            width: 1280,
            height: 720,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Social,
        },
    ]
}

fn full_mp4_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset::Mp4 {
            width: 1280,
            height: 720,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 1280,
            height: 720,
            fps: 30,
            compression: ExportCompression::Social,
        },
        ExportPreset::Mp4 {
            width: 1280,
            height: 720,
            fps: 30,
            compression: ExportCompression::Web,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Social,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Web,
        },
        ExportPreset::Mp4 {
            width: 1920,
            height: 1080,
            fps: 60,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 3840,
            height: 2160,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        ExportPreset::Mp4 {
            width: 3840,
            height: 2160,
            fps: 30,
            compression: ExportCompression::Social,
        },
    ]
}

fn gif_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset::Gif {
            width: 1280,
            height: 720,
            fps: 15,
        },
        ExportPreset::Gif {
            width: 1280,
            height: 720,
            fps: 30,
        },
    ]
}

fn full_presets() -> Vec<ExportPreset> {
    let mut presets = full_mp4_presets();
    presets.extend(gif_presets());
    presets
}

#[derive(Debug)]
struct ExportResult {
    preset: ExportPreset,
    wall_time: Duration,
    effective_fps: f64,
    output_file_size_mb: f64,
    estimated_size_mb: f64,
    estimation_error_pct: f64,
    estimated_time_seconds: f64,
    time_estimation_error_pct: f64,
    passed: bool,
    error: Option<String>,
}

fn estimate_mp4_size_mb(
    width: u32,
    height: u32,
    fps: u32,
    compression: ExportCompression,
    duration_seconds: f64,
) -> f64 {
    let total_pixels = (width * height) as f64;
    let bits_per_pixel = compression.bits_per_pixel() as f64;
    let fps_f64 = fps as f64;
    let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
    let video_bitrate = total_pixels * bits_per_pixel * effective_fps;
    let audio_bitrate = 192_000.0;
    let total_bitrate = video_bitrate + audio_bitrate;
    let encoder_efficiency = 0.5;
    (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0)
}

fn estimate_gif_size_mb(width: u32, height: u32, fps: u32, duration_seconds: f64) -> f64 {
    let total_pixels = (width * height) as f64;
    let total_frames = (duration_seconds * fps as f64).ceil();
    let bytes_per_frame = total_pixels * 0.5;
    let gif_efficiency = 0.07;
    (bytes_per_frame * gif_efficiency * total_frames) / (1024.0 * 1024.0)
}

fn estimate_time_seconds(preset: &ExportPreset, duration_seconds: f64) -> f64 {
    let (width, height) = preset.resolution();
    let fps = preset.fps();
    let fps_f64 = fps as f64;
    let total_frames = (duration_seconds * fps_f64).ceil();

    match preset {
        ExportPreset::Mp4 { .. } => {
            let effective_render_fps = match (width, height) {
                (w, _) if w >= 3840 => 175.0,
                _ => 290.0,
            };
            total_frames / effective_render_fps
        }
        ExportPreset::Gif { .. } => {
            let frames_per_sec = match (width, height) {
                (w, h) if w <= 1280 && h <= 720 => 10.0,
                (w, h) if w <= 1920 && h <= 1080 => 5.0,
                _ => 2.0,
            };
            total_frames / frames_per_sec
        }
    }
}

fn check_ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn generate_test_video(
    output_path: &Path,
    duration_secs: u32,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=duration={duration_secs}:size={width}x{height}:rate={fps}"),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "mp4",
            output_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

    if !status.status.success() {
        return Err(format!(
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&status.stderr)
        ));
    }

    Ok(())
}

fn create_cap_project(project_dir: &Path, duration_secs: u32, fps: u32) -> Result<(), String> {
    let content_dir = project_dir.join("content");
    fs::create_dir_all(&content_dir).map_err(|e| format!("Failed to create content dir: {e}"))?;

    let recording_meta = serde_json::json!({
        "pretty_name": "Export Benchmark Test",
        "sharing": null,
        "display": {
            "path": "content/display.mp4",
            "fps": fps
        },
        "camera": null,
        "audio": null,
        "cursor": null
    });

    let meta_path = project_dir.join("recording-meta.json");
    fs::write(
        &meta_path,
        serde_json::to_string_pretty(&recording_meta).unwrap(),
    )
    .map_err(|e| format!("Failed to write recording-meta.json: {e}"))?;

    let project_config = serde_json::json!({
        "aspectRatio": null,
        "background": {
            "source": { "type": "color", "value": [30, 30, 46] },
            "blur": 0.0,
            "padding": 0.0,
            "rounding": 0.0,
            "inset": 0,
            "shadow": 50.0
        },
        "camera": { "hide": true, "mirror": false, "position": {}, "rounding": 100.0, "shadow": 40.0, "size": 30.0 },
        "audio": { "mute": true },
        "cursor": { "hideWhenIdle": false, "size": 100, "type": "pointer", "tension": 170.0, "mass": 1.0, "friction": 18.0, "raw": false },
        "hotkeys": { "show": true },
        "timeline": {
            "segments": [{
                "recordingSegment": 0,
                "timescale": 1.0,
                "start": 0.0,
                "end": duration_secs as f64
            }],
            "zoomSegments": []
        }
    });

    let config_path = project_dir.join("project-config.json");
    fs::write(
        &config_path,
        serde_json::to_string_pretty(&project_config).unwrap(),
    )
    .map_err(|e| format!("Failed to write project-config.json: {e}"))?;

    Ok(())
}

async fn run_mp4_export(
    project_path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    compression: ExportCompression,
) -> Result<(PathBuf, Duration, u32), String> {
    let exporter_base = ExporterBase::builder(project_path.to_path_buf())
        .build()
        .await
        .map_err(|err| format!("Exporter build error: {err}"))?;

    let settings = Mp4ExportSettings {
        fps,
        resolution_base: XY::new(width, height),
        compression,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
    };

    let total_frames = exporter_base.total_frames(fps);

    let start = Instant::now();
    let frame_count = Arc::new(AtomicU32::new(0));
    let frame_counter = Arc::clone(&frame_count);
    let last_report = Arc::new(std::sync::Mutex::new(Instant::now()));
    let last_report_clone = Arc::clone(&last_report);

    let output_path = settings
        .export(exporter_base, move |frame| {
            frame_counter.fetch_add(1, Ordering::Relaxed);
            let mut last = last_report_clone.lock().unwrap();
            if last.elapsed() > Duration::from_secs(5) {
                println!(
                    "  Progress: {}/{} frames ({:.1}%)",
                    frame,
                    total_frames,
                    (frame as f64 / total_frames as f64) * 100.0
                );
                *last = Instant::now();
            }
            true
        })
        .await
        .map_err(|err| format!("Export error: {err}"))?;

    let elapsed = start.elapsed();
    let frames = frame_count.load(Ordering::Relaxed);

    if frames == 0 {
        return Err("No frames were rendered during export".into());
    }

    Ok((output_path, elapsed, frames))
}

async fn run_gif_export(
    project_path: &Path,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(PathBuf, Duration, u32), String> {
    let exporter_base = ExporterBase::builder(project_path.to_path_buf())
        .build()
        .await
        .map_err(|err| format!("Exporter build error: {err}"))?;

    let settings = GifExportSettings {
        fps,
        resolution_base: XY::new(width, height),
        quality: None,
    };

    let total_frames = exporter_base.total_frames(fps);

    let start = Instant::now();
    let frame_count = Arc::new(AtomicU32::new(0));
    let frame_counter = Arc::clone(&frame_count);
    let last_report = Arc::new(std::sync::Mutex::new(Instant::now()));
    let last_report_clone = Arc::clone(&last_report);

    let output_path = settings
        .export(exporter_base, move |frame| {
            frame_counter.fetch_add(1, Ordering::Relaxed);
            let mut last = last_report_clone.lock().unwrap();
            if last.elapsed() > Duration::from_secs(5) {
                println!(
                    "  Progress: {}/{} frames ({:.1}%)",
                    frame,
                    total_frames,
                    (frame as f64 / total_frames as f64) * 100.0
                );
                *last = Instant::now();
            }
            true
        })
        .await
        .map_err(|err| format!("Export error: {err}"))?;

    let elapsed = start.elapsed();
    let frames = frame_count.load(Ordering::Relaxed);

    if frames == 0 {
        return Err("No frames were rendered during export".into());
    }

    Ok((output_path, elapsed, frames))
}

async fn run_preset(
    project_path: &Path,
    preset: ExportPreset,
    duration_seconds: f64,
) -> ExportResult {
    let (width, height) = preset.resolution();
    let fps = preset.fps();

    println!("\n--- {} ---", preset.label());
    println!(
        "  Resolution: {}x{}, FPS: {}, Duration: {:.1}s",
        width, height, fps, duration_seconds
    );

    let estimated_size_mb = match preset {
        ExportPreset::Mp4 { compression, .. } => {
            estimate_mp4_size_mb(width, height, fps, compression, duration_seconds)
        }
        ExportPreset::Gif { .. } => estimate_gif_size_mb(width, height, fps, duration_seconds),
    };

    let estimated_time_seconds = estimate_time_seconds(&preset, duration_seconds);

    let export_result = match preset {
        ExportPreset::Mp4 { compression, .. } => {
            run_mp4_export(project_path, width, height, fps, compression).await
        }
        ExportPreset::Gif { .. } => run_gif_export(project_path, width, height, fps).await,
    };

    match export_result {
        Ok((output_path, wall_time, frames_rendered)) => {
            let effective_fps = frames_rendered as f64 / wall_time.as_secs_f64();
            let output_file_size_bytes = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
            let output_file_size_mb = output_file_size_bytes as f64 / (1024.0 * 1024.0);

            let estimation_error_pct = if output_file_size_mb > 0.0 {
                ((estimated_size_mb - output_file_size_mb) / output_file_size_mb) * 100.0
            } else {
                0.0
            };

            let actual_time = wall_time.as_secs_f64();
            let time_estimation_error_pct = if actual_time > 0.0 {
                ((estimated_time_seconds - actual_time) / actual_time) * 100.0
            } else {
                0.0
            };

            let min_fps = match preset {
                ExportPreset::Gif { .. } => 1.0,
                ExportPreset::Mp4 { .. } if width >= 3840 => 15.0,
                _ => 30.0,
            };
            let passed = effective_fps >= min_fps && output_file_size_bytes > 0;

            println!(
                "  Completed in {:.2}s ({} frames, {:.1} fps)",
                wall_time.as_secs_f64(),
                frames_rendered,
                effective_fps
            );
            println!("  Output size: {:.2} MB", output_file_size_mb);
            println!(
                "  Estimated size: {:.2} MB (error: {:+.1}%)",
                estimated_size_mb, estimation_error_pct
            );
            println!(
                "  Estimated time: {:.2}s (error: {:+.1}%)",
                estimated_time_seconds, time_estimation_error_pct
            );
            println!("  Status: {}", if passed { "PASS" } else { "FAIL" });

            let _ = fs::remove_file(&output_path);

            ExportResult {
                preset,
                wall_time,
                effective_fps,
                output_file_size_mb,
                estimated_size_mb,
                estimation_error_pct,
                estimated_time_seconds,
                time_estimation_error_pct,
                passed,
                error: None,
            }
        }
        Err(e) => {
            println!("  FAILED: {e}");
            ExportResult {
                preset,
                wall_time: Duration::ZERO,
                effective_fps: 0.0,
                output_file_size_mb: 0.0,
                estimated_size_mb,
                estimation_error_pct: 0.0,
                estimated_time_seconds,
                time_estimation_error_pct: 0.0,
                passed: false,
                error: Some(e),
            }
        }
    }
}

fn print_summary(results: &[ExportResult]) {
    let passed = results.iter().filter(|r| r.passed).count();
    let total = results.len();
    let failed = total - passed;

    println!("\n{}", "=".repeat(60));
    println!("EXPORT BENCHMARK SUMMARY");
    println!("{}", "=".repeat(60));
    println!("Passed: {passed}/{total}  Failed: {failed}/{total}\n");

    println!(
        "{:<30} {:>8} {:>8} {:>10} {:>10} {:>10} {:>8}",
        "Preset", "Time(s)", "FPS", "Size(MB)", "Est(MB)", "Err(%)", "Status"
    );
    println!("{}", "-".repeat(94));

    for r in results {
        let status = if r.passed { "PASS" } else { "FAIL" };
        let error_str = if r.error.is_some() {
            "ERR".to_string()
        } else {
            format!("{:+.1}", r.estimation_error_pct)
        };

        println!(
            "{:<30} {:>8.2} {:>8.1} {:>10.2} {:>10.2} {:>10} {:>8}",
            r.preset.label(),
            r.wall_time.as_secs_f64(),
            r.effective_fps,
            r.output_file_size_mb,
            r.estimated_size_mb,
            error_str,
            status,
        );
    }

    let successful: Vec<&ExportResult> = results.iter().filter(|r| r.error.is_none()).collect();
    if !successful.is_empty() {
        println!("\nEstimation Accuracy Summary:");

        let mp4_results: Vec<&&ExportResult> = successful
            .iter()
            .filter(|r| matches!(r.preset, ExportPreset::Mp4 { .. }))
            .collect();
        if !mp4_results.is_empty() {
            let avg_error: f64 = mp4_results
                .iter()
                .map(|r| r.estimation_error_pct)
                .sum::<f64>()
                / mp4_results.len() as f64;
            let avg_abs_error: f64 = mp4_results
                .iter()
                .map(|r| r.estimation_error_pct.abs())
                .sum::<f64>()
                / mp4_results.len() as f64;
            println!(
                "  MP4: avg error {:+.1}%, avg |error| {:.1}%",
                avg_error, avg_abs_error
            );
        }

        let gif_results: Vec<&&ExportResult> = successful
            .iter()
            .filter(|r| matches!(r.preset, ExportPreset::Gif { .. }))
            .collect();
        if !gif_results.is_empty() {
            let avg_error: f64 = gif_results
                .iter()
                .map(|r| r.estimation_error_pct)
                .sum::<f64>()
                / gif_results.len() as f64;
            let avg_abs_error: f64 = gif_results
                .iter()
                .map(|r| r.estimation_error_pct.abs())
                .sum::<f64>()
                / gif_results.len() as f64;
            println!(
                "  GIF: avg error {:+.1}%, avg |error| {:.1}%",
                avg_error, avg_abs_error
            );
        }
    }

    if failed > 0 {
        println!("\nFailed exports:");
        for r in results.iter().filter(|r| !r.passed) {
            let reason = r.error.as_deref().unwrap_or("Below minimum FPS target");
            println!("  - {}: {}", r.preset.label(), reason);
        }
    }
}

fn generate_benchmark_markdown(
    results: &[ExportResult],
    duration_secs: u32,
    notes: Option<&str>,
    command: &str,
) -> String {
    let mut md = String::new();

    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
    let local_timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    md.push_str(&format!("### Benchmark Run: {}\n\n", timestamp));
    md.push_str(&format!("*Local time: {}*\n\n", local_timestamp));

    let passed = results.iter().filter(|r| r.passed).count();
    let total = results.len();
    let overall_status = if passed == total {
        "ALL PASS"
    } else {
        "FAILURES"
    };

    md.push_str(&format!(
        "**Overall Result:** {} ({}/{})\n\n",
        overall_status, passed, total
    ));

    md.push_str(&format!(
        "**Test Video:** {}s at {}x{} {}fps\n\n",
        duration_secs, SOURCE_VIDEO_WIDTH, SOURCE_VIDEO_HEIGHT, SOURCE_VIDEO_FPS
    ));

    if let Some(notes_text) = notes {
        md.push_str(&format!("**Notes:** {}\n\n", notes_text));
    }

    md.push_str(&format!("**Command:** `{}`\n\n", command));

    md.push_str("<details>\n<summary>System Information</summary>\n\n");
    md.push_str(&format!("- **OS:** {}\n", std::env::consts::OS));
    md.push_str(&format!("- **Arch:** {}\n", std::env::consts::ARCH));
    md.push_str("\n</details>\n\n");

    md.push_str("#### Export Results\n\n");
    md.push_str("| Preset | Time(s) | FPS | Size(MB) | Estimated(MB) | Size Err(%) | Time Est(s) | Time Err(%) | Status |\n");
    md.push_str("|--------|---------|-----|----------|---------------|-------------|-------------|-------------|--------|\n");

    for r in results {
        let status = if r.passed { "PASS" } else { "FAIL" };
        if r.error.is_some() {
            md.push_str(&format!(
                "| {} | - | - | - | {:.2} | - | {:.2} | - | {} |\n",
                r.preset.label(),
                r.estimated_size_mb,
                r.estimated_time_seconds,
                status,
            ));
        } else {
            md.push_str(&format!(
                "| {} | {:.2} | {:.1} | {:.2} | {:.2} | {:+.1} | {:.2} | {:+.1} | {} |\n",
                r.preset.label(),
                r.wall_time.as_secs_f64(),
                r.effective_fps,
                r.output_file_size_mb,
                r.estimated_size_mb,
                r.estimation_error_pct,
                r.estimated_time_seconds,
                r.time_estimation_error_pct,
                status,
            ));
        }
    }

    let successful: Vec<&ExportResult> = results.iter().filter(|r| r.error.is_none()).collect();
    if !successful.is_empty() {
        md.push_str("\n#### Estimation Accuracy\n\n");

        let mp4_results: Vec<&&ExportResult> = successful
            .iter()
            .filter(|r| matches!(r.preset, ExportPreset::Mp4 { .. }))
            .collect();
        if !mp4_results.is_empty() {
            let avg_size_error: f64 = mp4_results
                .iter()
                .map(|r| r.estimation_error_pct)
                .sum::<f64>()
                / mp4_results.len() as f64;
            let avg_abs_size_error: f64 = mp4_results
                .iter()
                .map(|r| r.estimation_error_pct.abs())
                .sum::<f64>()
                / mp4_results.len() as f64;
            let avg_time_error: f64 = mp4_results
                .iter()
                .map(|r| r.time_estimation_error_pct)
                .sum::<f64>()
                / mp4_results.len() as f64;
            let avg_abs_time_error: f64 = mp4_results
                .iter()
                .map(|r| r.time_estimation_error_pct.abs())
                .sum::<f64>()
                / mp4_results.len() as f64;

            md.push_str(&format!(
                "- **MP4 Size**: avg error {:+.1}%, avg |error| {:.1}%\n",
                avg_size_error, avg_abs_size_error
            ));
            md.push_str(&format!(
                "- **MP4 Time**: avg error {:+.1}%, avg |error| {:.1}%\n",
                avg_time_error, avg_abs_time_error
            ));
        }

        let gif_results: Vec<&&ExportResult> = successful
            .iter()
            .filter(|r| matches!(r.preset, ExportPreset::Gif { .. }))
            .collect();
        if !gif_results.is_empty() {
            let avg_size_error: f64 = gif_results
                .iter()
                .map(|r| r.estimation_error_pct)
                .sum::<f64>()
                / gif_results.len() as f64;
            let avg_abs_size_error: f64 = gif_results
                .iter()
                .map(|r| r.estimation_error_pct.abs())
                .sum::<f64>()
                / gif_results.len() as f64;

            md.push_str(&format!(
                "- **GIF Size**: avg error {:+.1}%, avg |error| {:.1}%\n",
                avg_size_error, avg_abs_size_error
            ));
        }

        md.push_str("\n#### Calibration Data\n\n");
        md.push_str("Use these actual-vs-estimated ratios to tune the estimation algorithm:\n\n");
        md.push_str("| Preset | Actual(MB) | Estimated(MB) | Ratio (actual/est) | Suggested BPP Multiplier |\n");
        md.push_str("|--------|------------|---------------|--------------------|--------------------------|\n");

        for r in &successful {
            let ratio = if r.estimated_size_mb > 0.0 {
                r.output_file_size_mb / r.estimated_size_mb
            } else {
                0.0
            };
            let suggested = match r.preset {
                ExportPreset::Mp4 { compression, .. } => {
                    let current_bpp = compression.bits_per_pixel();
                    format!(
                        "{:.4} (current: {:.2})",
                        current_bpp as f64 * ratio,
                        current_bpp
                    )
                }
                ExportPreset::Gif { .. } => {
                    let current_bytes_per_pixel = 0.5;
                    format!(
                        "{:.4} bytes/px (current: {:.2})",
                        current_bytes_per_pixel * ratio,
                        current_bytes_per_pixel
                    )
                }
            };
            md.push_str(&format!(
                "| {} | {:.2} | {:.2} | {:.4} | {} |\n",
                r.preset.label(),
                r.output_file_size_mb,
                r.estimated_size_mb,
                ratio,
                suggested,
            ));
        }
    }

    if results.iter().any(|r| !r.passed) {
        md.push_str("\n**Failed Exports:**\n");
        for r in results.iter().filter(|r| !r.passed) {
            let reason = r.error.as_deref().unwrap_or("Below minimum FPS target");
            md.push_str(&format!("- {}: {}\n", r.preset.label(), reason));
        }
    }

    md.push_str("\n---\n\n");

    md
}

fn write_benchmark_to_file(benchmark_md: &str) -> Result<(), String> {
    let benchmark_file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("EXPORT-BENCHMARKS.md");

    if !benchmark_file.exists() {
        return Err(format!(
            "EXPORT-BENCHMARKS.md not found at {:?}. Please ensure the file exists.",
            benchmark_file
        ));
    }

    let content =
        fs::read_to_string(&benchmark_file).map_err(|e| format!("Failed to read file: {e}"))?;

    let marker_start = "<!-- EXPORT_BENCHMARK_RESULTS_START -->";
    let marker_end = "<!-- EXPORT_BENCHMARK_RESULTS_END -->";

    let Some(start_idx) = content.find(marker_start) else {
        return Err("Could not find EXPORT_BENCHMARK_RESULTS_START marker".to_string());
    };

    let Some(end_idx) = content.find(marker_end) else {
        return Err("Could not find EXPORT_BENCHMARK_RESULTS_END marker".to_string());
    };

    let insert_pos = start_idx + marker_start.len();

    let mut new_content = String::new();
    new_content.push_str(&content[..insert_pos]);
    new_content.push_str("\n\n");
    new_content.push_str(benchmark_md);
    new_content.push_str(&content[end_idx..]);

    let mut file =
        fs::File::create(&benchmark_file).map_err(|e| format!("Failed to write: {e}"))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| format!("Failed to write: {e}"))?;

    println!(
        "\nBenchmark results written to: {}",
        benchmark_file.display()
    );

    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();

    if !check_ffmpeg_available() {
        eprintln!(
            "ERROR: ffmpeg is not available. Please install ffmpeg to run export benchmarks."
        );
        std::process::exit(1);
    }

    let presets = match &cli.command {
        Some(Commands::Quick) | None => quick_presets(),
        Some(Commands::Full) => full_presets(),
        Some(Commands::Mp4Only) => full_mp4_presets(),
        Some(Commands::GifOnly) => gif_presets(),
    };

    let command_name = match &cli.command {
        Some(Commands::Quick) | None => "quick",
        Some(Commands::Full) => "full",
        Some(Commands::Mp4Only) => "mp4-only",
        Some(Commands::GifOnly) => "gif-only",
    };

    println!("Export Benchmark Runner");
    println!("======================");
    println!("Mode: {}", command_name);
    println!("Presets to test: {}", presets.len());

    let (project_dir, duration_seconds, _temp_dir) =
        if let Some(ref recording_path) = cli.recording_path {
            if !recording_path.join("recording-meta.json").exists()
                || !recording_path.join("project-config.json").exists()
            {
                eprintln!(
                    "ERROR: {:?} is not a valid Cap recording (missing meta files)",
                    recording_path
                );
                std::process::exit(1);
            }

            println!("Using existing recording: {}", recording_path.display());

            let meta_content =
                fs::read_to_string(recording_path.join("recording-meta.json")).unwrap_or_default();
            let config_content =
                fs::read_to_string(recording_path.join("project-config.json")).unwrap_or_default();

            let duration = serde_json::from_str::<serde_json::Value>(&config_content)
                .ok()
                .and_then(|v| v.get("timeline")?.get("segments")?.as_array().cloned())
                .map(|segments| {
                    segments
                        .iter()
                        .filter_map(|s| {
                            let start = s.get("start")?.as_f64()?;
                            let end = s.get("end")?.as_f64()?;
                            Some(end - start)
                        })
                        .sum::<f64>()
                })
                .unwrap_or_else(|| {
                    serde_json::from_str::<serde_json::Value>(&meta_content)
                        .ok()
                        .and_then(|v| v.get("display")?.get("fps")?.as_f64())
                        .unwrap_or(30.0)
                        * cli.duration as f64
                        / 30.0
                });

            println!("Recording duration: {:.1}s", duration);
            (recording_path.clone(), duration, None)
        } else {
            let duration_secs = cli.duration;
            println!(
                "Test video: {}s at {}x{} {}fps",
                duration_secs, SOURCE_VIDEO_WIDTH, SOURCE_VIDEO_HEIGHT, SOURCE_VIDEO_FPS
            );
            println!();

            let temp_dir = tempfile::TempDir::new().expect("Failed to create temp directory");
            let project_dir = temp_dir.path().to_path_buf();

            println!("Setting up test project in {:?}", project_dir);

            create_cap_project(&project_dir, duration_secs, SOURCE_VIDEO_FPS)
                .expect("Failed to create cap project");

            let video_path = project_dir.join("content/display.mp4");
            println!(
                "Generating {}s test video at {}x{}...",
                duration_secs, SOURCE_VIDEO_WIDTH, SOURCE_VIDEO_HEIGHT
            );
            let gen_start = Instant::now();
            generate_test_video(
                &video_path,
                duration_secs,
                SOURCE_VIDEO_WIDTH,
                SOURCE_VIDEO_HEIGHT,
                SOURCE_VIDEO_FPS,
            )
            .expect("Failed to generate test video");
            println!(
                "Video generated in {:.2}s",
                gen_start.elapsed().as_secs_f64()
            );

            let source_size = fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0);
            println!(
                "Source video size: {:.2} MB",
                source_size as f64 / 1024.0 / 1024.0
            );

            (project_dir, duration_secs as f64, Some(temp_dir))
        };

    let mut results = Vec::new();
    let total_presets = presets.len();

    for (i, preset) in presets.iter().enumerate() {
        println!(
            "\n[{}/{}] Running: {}",
            i + 1,
            total_presets,
            preset.label()
        );
        let result = run_preset(&project_dir, *preset, duration_seconds).await;
        results.push(result);
    }

    print_summary(&results);

    if cli.benchmark_output {
        let duration_secs = duration_seconds.ceil() as u32;
        let recording_flag = cli
            .recording_path
            .as_ref()
            .map(|p| format!(" --recording-path {}", p.display()))
            .unwrap_or_default();

        let command = format!(
            "cargo run -p cap-export --example export-benchmark-runner -- {command_name} --duration {duration_secs}{recording_flag} --benchmark-output"
        );

        let benchmark_md =
            generate_benchmark_markdown(&results, duration_secs, cli.notes.as_deref(), &command);

        if let Err(e) = write_benchmark_to_file(&benchmark_md) {
            eprintln!("Failed to write benchmark results: {e}");
        }
    }

    if cli.keep_outputs
        && let Some(td) = _temp_dir
    {
        let persist_path = td.into_path();
        println!("\nTest files kept at: {}", persist_path.display());
    }
}
