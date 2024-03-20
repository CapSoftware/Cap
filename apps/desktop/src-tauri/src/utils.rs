use std::process::{Command};
use ffmpeg_sidecar::{
    paths::sidecar_dir,
};
use capture::{Capturer, Display};
use std::time::{Duration, Instant};
use std::panic;

#[tauri::command]
pub fn has_screen_capture_access() -> bool {
    let display = match Display::primary() {
        Ok(display) => display,
        Err(_) => return false,
    };

    let width = display.width();
    let height = display.height();

    let result = panic::catch_unwind(|| {
        let mut capturer = match Capturer::new(display, width, height) {
            Ok(capturer) => capturer,
            Err(_) => return false,
        };

        let start = Instant::now();

        loop {
            if start.elapsed() > Duration::from_secs(2) {
                return false;
            }

            match capturer.frame() {
                Ok(_frame) => {
                    return true;
                },
                Err(_) => {
                    continue;
                }
            };
        }
    });

    match result {
        Ok(val) => val,
        Err(_) => false,
    }
}

pub fn run_command(command: &str, args: Vec<&str>) -> Result<(String, String), String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8(output.stdout).unwrap_or_else(|_| "".to_string());
    let stderr = String::from_utf8(output.stderr).unwrap_or_else(|_| "".to_string());

    println!("Command output: {}", stdout);
    println!("Command error: {}", stderr);

    Ok((stdout, stderr))
}

pub fn ffmpeg_path_as_str() -> Result<String, String> {
    let binary_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    
    let path = sidecar_dir().map_err(|e| e.to_string())?.join(binary_name);
    path.to_str()
        .map(|s| s.to_owned()) // Converts the &str to a String
        .ok_or_else(|| "Failed to convert FFmpeg binary path to string".to_string())
}