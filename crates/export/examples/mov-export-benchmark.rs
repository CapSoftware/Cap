use cap_export::{ExporterBase, mov::MovExportSettings};
use cap_project::XY;
use clap::Parser;
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(about = "Time ProRes 4444 MOV exports of a synthetic recording")]
struct Cli {
    #[arg(long, default_value = "1920")]
    width: u32,
    #[arg(long, default_value = "1080")]
    height: u32,
    #[arg(long, default_value = "30")]
    fps: u32,
    #[arg(long, default_value = "10")]
    duration: u32,
    #[arg(long, default_value = "5", value_parser = clap::value_parser!(u16).range(1..))]
    runs: u16,
}

fn generate_test_video(path: &Path, cli: &Cli) {
    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!(
                "testsrc2=duration={}:size={}x{}:rate={}",
                cli.duration, cli.width, cli.height, cli.fps
            ),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            path.to_str().unwrap(),
        ])
        .output()
        .expect("ffmpeg must be on PATH");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn create_project(dir: &Path, cli: &Cli) {
    fs::create_dir_all(dir.join("content")).unwrap();
    let meta = serde_json::json!({
        "pretty_name": "MOV Export Benchmark",
        "sharing": null,
        "display": { "path": "content/display.mp4", "fps": cli.fps },
        "camera": null,
        "audio": null,
        "cursor": null
    });
    fs::write(dir.join("recording-meta.json"), meta.to_string()).unwrap();
    let config = serde_json::json!({
        "aspectRatio": null,
        "background": {
            "source": { "type": "color", "value": [30, 30, 46] },
            "blur": 0.0, "padding": 10.0, "rounding": 12.0, "inset": 0, "shadow": 50.0
        },
        "camera": { "hide": true, "mirror": false, "position": {}, "rounding": 100.0, "shadow": 40.0, "size": 30.0 },
        "audio": { "mute": true },
        "cursor": { "hideWhenIdle": false, "size": 100, "type": "pointer", "tension": 170.0, "mass": 1.0, "friction": 18.0, "raw": false },
        "hotkeys": { "show": true },
        "timeline": {
            "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": cli.duration as f64 }],
            "zoomSegments": []
        }
    });
    fs::write(dir.join("project-config.json"), config.to_string()).unwrap();
    generate_test_video(&dir.join("content/display.mp4"), cli);
}

async fn export_once(dir: &Path, cli: &Cli) -> (Duration, u32, u64) {
    let base = ExporterBase::builder(dir.to_path_buf())
        .build()
        .await
        .expect("exporter base");
    let settings = MovExportSettings {
        fps: cli.fps,
        resolution_base: XY::new(cli.width, cli.height),
        cursor_only: false,
    };
    let frames = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let counter = frames.clone();
    let start = Instant::now();
    let path = settings
        .export(base, move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            true
        })
        .await
        .expect("mov export");
    let elapsed = start.elapsed();
    let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if let Ok(keep) = std::env::var("MOV_BENCH_KEEP") {
        fs::copy(&path, &keep).unwrap_or_else(|err| panic!("keep {keep}: {err}"));
    }
    fs::remove_file(&path).ok();
    (
        elapsed,
        frames.load(std::sync::atomic::Ordering::Relaxed),
        bytes,
    )
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let temp = tempfile::TempDir::new().unwrap();
    create_project(temp.path(), &cli);

    let mut fps_samples = Vec::with_capacity(usize::from(cli.runs));
    for run in 0..cli.runs {
        let (elapsed, frames, bytes) = export_once(temp.path(), &cli).await;
        let fps = frames as f64 / elapsed.as_secs_f64();
        println!(
            "run={run} frames={frames} secs={:.3} fps={fps:.1} bytes={bytes}",
            elapsed.as_secs_f64()
        );
        fps_samples.push(fps);
    }
    fps_samples.sort_by(f64::total_cmp);
    println!(
        "mov_export {}x{}@{} duration={}s median_fps={:.1} min_fps={:.1} max_fps={:.1}",
        cli.width,
        cli.height,
        cli.fps,
        cli.duration,
        fps_samples[fps_samples.len() / 2],
        fps_samples[0],
        fps_samples[fps_samples.len() - 1]
    );
}
