// Atomic Hardware-Accelerated Video Rendering Pipeline
use std::process::Command;

pub fn execute_hardware_export(
    screen_path: &str,
    webcam_path: &str,
    output_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("ffmpeg")
        .args([
            "-i", screen_path,
            "-i", webcam_path,
            "-filter_complex", "[1:v]scale=320:320,format=yuva420p[cam];[0:v][cam]overlay=W-w-20:H-h-20",
            "-c:v", "h264_videotoolbox",
            "-b:v", "6000k",
            output_path,
        ])
        .status()?;

    if !status.success() {
        return Err("FFmpeg export pipeline failed".into());
    }
    Ok(())
}
