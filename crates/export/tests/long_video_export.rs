use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::XY;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use tempfile::TempDir;

const TEST_VIDEO_DURATION_SECS: u32 = 35 * 60;
const TEST_VIDEO_WIDTH: u32 = 320;
const TEST_VIDEO_HEIGHT: u32 = 240;
const TEST_VIDEO_FPS: u32 = 15;

fn check_ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn generate_test_video(output_path: &Path, duration_secs: u32) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!(
                "testsrc=duration={duration_secs}:size={TEST_VIDEO_WIDTH}x{TEST_VIDEO_HEIGHT}:rate={TEST_VIDEO_FPS}"
            ),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "35",
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

fn create_cap_project(project_dir: &Path, duration_secs: u32) -> Result<(), String> {
    let content_dir = project_dir.join("content");
    fs::create_dir_all(&content_dir).map_err(|e| format!("Failed to create content dir: {e}"))?;

    let recording_meta = serde_json::json!({
        "pretty_name": "Long Video Test",
        "sharing": null,
        "display": {
            "path": "content/display.mp4",
            "fps": TEST_VIDEO_FPS
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
        "audio": { "mute": false },
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

async fn run_export(project_path: PathBuf, fps: u32) -> Result<(PathBuf, Duration, u32), String> {
    let exporter_base = ExporterBase::builder(project_path.clone())
        .build()
        .await
        .map_err(|err| format!("Exporter build error: {err}"))?;

    let settings = Mp4ExportSettings {
        fps,
        resolution_base: XY::new(TEST_VIDEO_WIDTH, TEST_VIDEO_HEIGHT),
        compression: ExportCompression::Potato,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
    };

    let total_frames = exporter_base.total_frames(fps);
    println!("Starting export of {total_frames} frames at {fps} fps");

    let start = Instant::now();
    let last_frame = Arc::new(AtomicU32::new(0));
    let frame_counter = Arc::clone(&last_frame);
    let last_report = Arc::new(std::sync::Mutex::new(Instant::now()));
    let last_report_clone = Arc::clone(&last_report);

    let output_path = settings
        .export(exporter_base, move |frame| {
            frame_counter.store(frame, Ordering::Relaxed);
            let mut last = last_report_clone.lock().unwrap();
            if last.elapsed() > Duration::from_secs(10) {
                println!(
                    "Progress: {}/{} frames ({:.1}%)",
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
    let frames = last_frame.load(Ordering::Relaxed);

    if frames == 0 {
        return Err("No frames were rendered during export".into());
    }

    Ok((output_path, elapsed, frames))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn test_export_35_minute_video() -> Result<(), Box<dyn std::error::Error>> {
    if !check_ffmpeg_available() {
        println!("Skipping test: ffmpeg not available");
        return Ok(());
    }

    let temp_dir = TempDir::new()?;
    let project_dir = temp_dir.path().to_path_buf();

    let duration_secs = TEST_VIDEO_DURATION_SECS;
    println!("Creating Cap project structure in {project_dir:?}");
    create_cap_project(&project_dir, duration_secs)?;

    let video_path = project_dir.join("content/display.mp4");
    println!(
        "Generating {} minute test video (this may take a while)...",
        duration_secs / 60
    );
    let gen_start = Instant::now();
    generate_test_video(&video_path, duration_secs)?;
    println!("Video generated in {:?}", gen_start.elapsed());

    let file_size = fs::metadata(&video_path)?.len();
    println!(
        "Video file size: {:.2} MB",
        file_size as f64 / 1024.0 / 1024.0
    );

    println!("Starting export test...");
    let (output_path, elapsed, frames) = run_export(project_dir.clone(), 30).await?;

    let fps = frames as f64 / elapsed.as_secs_f64();
    println!(
        "Export completed in {:.2?} ({} frames, {:.2} fps). Output: {}",
        elapsed,
        frames,
        fps,
        output_path.display()
    );

    let expected_frames = duration_secs * 30;
    let tolerance = expected_frames / 100;
    assert!(
        frames >= expected_frames - tolerance,
        "Expected at least {} frames but got {}",
        expected_frames - tolerance,
        frames
    );

    assert!(
        output_path.exists(),
        "Output file does not exist: {}",
        output_path.display()
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn test_export_10_minute_video() -> Result<(), Box<dyn std::error::Error>> {
    if !check_ffmpeg_available() {
        println!("Skipping test: ffmpeg not available");
        return Ok(());
    }

    let duration_secs: u32 = 10 * 60;
    let temp_dir = TempDir::new()?;
    let project_dir = temp_dir.path().to_path_buf();

    println!("Creating Cap project structure in {project_dir:?}");
    create_cap_project(&project_dir, duration_secs)?;

    let video_path = project_dir.join("content/display.mp4");
    println!("Generating 10 minute test video...");
    let gen_start = Instant::now();
    generate_test_video(&video_path, duration_secs)?;
    println!("Video generated in {:?}", gen_start.elapsed());

    println!("Starting export test...");
    let (output_path, elapsed, frames) = run_export(project_dir.clone(), 30).await?;

    let fps = frames as f64 / elapsed.as_secs_f64();
    println!(
        "Export completed in {:.2?} ({} frames, {:.2} fps). Output: {}",
        elapsed,
        frames,
        fps,
        output_path.display()
    );

    let expected_frames = duration_secs * 30;
    let tolerance = expected_frames / 100;
    assert!(
        frames >= expected_frames - tolerance,
        "Expected at least {} frames but got {}",
        expected_frames - tolerance,
        frames
    );

    assert!(
        output_path.exists(),
        "Output file does not exist: {}",
        output_path.display()
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn test_export_55_minute_video() -> Result<(), Box<dyn std::error::Error>> {
    if !check_ffmpeg_available() {
        println!("Skipping test: ffmpeg not available");
        return Ok(());
    }

    let duration_secs: u32 = 55 * 60;
    let temp_dir = TempDir::new()?;
    let project_dir = temp_dir.path().to_path_buf();

    println!("Creating Cap project structure in {project_dir:?}");
    create_cap_project(&project_dir, duration_secs)?;

    let video_path = project_dir.join("content/display.mp4");
    println!("Generating 55 minute test video (this will take a while)...");
    let gen_start = Instant::now();
    generate_test_video(&video_path, duration_secs)?;
    println!("Video generated in {:?}", gen_start.elapsed());

    let file_size = fs::metadata(&video_path)?.len();
    println!(
        "Video file size: {:.2} MB",
        file_size as f64 / 1024.0 / 1024.0
    );

    println!("Starting export test (this matches the customer's use case)...");
    let (output_path, elapsed, frames) = run_export(project_dir.clone(), 30).await?;

    let fps = frames as f64 / elapsed.as_secs_f64();
    println!(
        "Export completed in {:.2?} ({} frames, {:.2} fps). Output: {}",
        elapsed,
        frames,
        fps,
        output_path.display()
    );

    let expected_frames = duration_secs * 30;
    let tolerance = expected_frames / 100;
    assert!(
        frames >= expected_frames - tolerance,
        "Expected at least {} frames but got {}",
        expected_frames - tolerance,
        frames
    );

    assert!(
        output_path.exists(),
        "Output file does not exist: {}",
        output_path.display()
    );

    Ok(())
}
