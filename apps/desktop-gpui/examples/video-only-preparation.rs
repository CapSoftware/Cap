use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::Instant,
};

use cap_export::{
    ExporterBase, gif::GifExportSettings, make_cursor_only_project, mov::MovExportSettings,
};
use cap_project::{ProjectConfiguration, XY};

#[derive(Clone, Copy, Debug)]
enum Mode {
    Baseline,
    VideoOnly,
}

#[derive(Clone, Copy, Debug)]
enum Format {
    Gif,
    CursorMov,
}

#[derive(Debug)]
struct Args {
    project: PathBuf,
    output: PathBuf,
    mode: Mode,
    format: Format,
    width: u32,
    height: u32,
    fps: u32,
    build_only: bool,
    force_ffmpeg: bool,
}

impl Args {
    fn parse() -> Result<Self, Box<dyn std::error::Error>> {
        let mut arguments = std::env::args().skip(1);
        let mut values = HashMap::new();
        let mut build_only = false;
        let mut force_ffmpeg = false;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--build-only" if !build_only => build_only = true,
                "--force-ffmpeg" if !force_ffmpeg => force_ffmpeg = true,
                "--project" | "--output" | "--mode" | "--format" | "--width" | "--height"
                | "--fps" => {
                    let value = arguments
                        .next()
                        .ok_or_else(|| format!("Missing value for {argument}"))?;
                    if values.insert(argument.clone(), value).is_some() {
                        return Err(format!("Duplicate argument: {argument}").into());
                    }
                }
                "--help" | "-h" => {
                    println!(
                        "Required: --project PATH --output PATH --mode baseline|video-only --format gif|cursor-mov\nOptional: --width 640 --height 360 --fps 15 --build-only --force-ffmpeg"
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("Unknown or duplicate argument: {argument}").into()),
            }
        }
        let project = PathBuf::from(values.remove("--project").ok_or("--project is required")?);
        let output = PathBuf::from(values.remove("--output").ok_or("--output is required")?);
        let mode = match values
            .remove("--mode")
            .ok_or("--mode is required")?
            .as_str()
        {
            "baseline" => Mode::Baseline,
            "video-only" => Mode::VideoOnly,
            _ => return Err("--mode must be baseline or video-only".into()),
        };
        let format = match values
            .remove("--format")
            .ok_or("--format is required")?
            .as_str()
        {
            "gif" => Format::Gif,
            "cursor-mov" => Format::CursorMov,
            _ => return Err("--format must be gif or cursor-mov".into()),
        };
        let width = values
            .remove("--width")
            .map(|value| value.parse::<u32>())
            .transpose()?
            .unwrap_or(640);
        let height = values
            .remove("--height")
            .map(|value| value.parse::<u32>())
            .transpose()?
            .unwrap_or(360);
        let fps = values
            .remove("--fps")
            .map(|value| value.parse::<u32>())
            .transpose()?
            .unwrap_or(15);
        if width == 0 || height == 0 || fps == 0 {
            return Err("Width, height, and FPS must be positive".into());
        }
        Ok(Self {
            project,
            output,
            mode,
            format,
            width,
            height,
            fps,
            build_only,
            force_ffmpeg,
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
    let extension = match args.format {
        Format::Gif => "gif",
        Format::CursorMov => "mov",
    };
    if args.output.extension().and_then(|value| value.to_str()) != Some(extension) {
        return Err(format!("Output must end with .{extension}").into());
    }
    if args.output.exists() {
        return Err("Refusing to overwrite an existing output".into());
    }
    let mut config = ProjectConfiguration::load(&args.project)?;
    if matches!(args.format, Format::CursorMov) {
        config = make_cursor_only_project(config);
    }
    let started = Instant::now();
    let builder = ExporterBase::builder(args.project.clone())
        .with_config(config)
        .with_output_path(args.output.clone())
        .with_force_ffmpeg_decoder(args.force_ffmpeg);
    let base = match args.mode {
        Mode::Baseline => builder.build().await?,
        Mode::VideoOnly => builder.build_video_only().await?,
    };
    let build_secs = started.elapsed().as_secs_f64();
    let expected_frames = base.total_frames(args.fps);
    if args.build_only {
        println!(
            "{}",
            serde_json::json!({
                "scope": "export_builder_only", "mode": format!("{:?}", args.mode),
                "format": format!("{:?}", args.format), "build_secs": build_secs,
                "expected_frames": expected_frames, "project": args.project,
            })
        );
        drop(base);
        return Ok(());
    }
    let frames = Arc::new(AtomicU32::new(0));
    let first_progress_us = Arc::new(AtomicU64::new(u64::MAX));
    let count = frames.clone();
    let first = first_progress_us.clone();
    let on_progress = move |_frame: u32| {
        count.fetch_add(1, Ordering::Relaxed);
        let _ = first.compare_exchange(
            u64::MAX,
            started.elapsed().as_micros() as u64,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
        true
    };
    let resolution_base = XY::new(args.width, args.height);
    let output = match args.format {
        Format::Gif => {
            GifExportSettings {
                fps: args.fps,
                resolution_base,
                quality: None,
            }
            .export(base, on_progress)
            .await?
        }
        Format::CursorMov => {
            MovExportSettings {
                fps: args.fps,
                resolution_base,
                cursor_only: true,
            }
            .export(base, on_progress)
            .await?
        }
    };
    println!(
        "{}",
        serde_json::json!({
            "scope": "gpui_equivalent_export", "mode": format!("{:?}", args.mode),
            "format": format!("{:?}", args.format), "build_secs": build_secs,
            "total_secs": started.elapsed().as_secs_f64(),
            "first_progress_us": first_progress_us.load(Ordering::Relaxed),
            "progress_frames": frames.load(Ordering::Relaxed),
            "expected_frames": expected_frames, "output": output,
            "output_bytes": std::fs::metadata(&output)?.len(),
        })
    );
    Ok(())
}
