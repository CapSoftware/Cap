use capture::{Capturer, Display};
use ffmpeg_sidecar::paths::sidecar_dir;
use std::io::ErrorKind::WouldBlock;
use std::panic;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

#[tauri::command]
#[specta::specta]
pub fn has_screen_capture_access() -> bool {
    let display = match Display::primary() {
        Ok(display) => display,
        Err(_) => return false,
    };

    let width = display.width();
    let height = display.height();
    let one_second = Duration::new(1, 0);
    let one_frame = one_second / 60;

    println!("width: {}", width);
    println!("height: {}", height);

    let result = panic::catch_unwind(|| {
        let mut capturer = match Capturer::new(display, width, height) {
            Ok(capturer) => {
                println!("Capturer created");
                capturer
            }
            Err(e) => {
                println!("Capturer not created: {}", e);
                return false;
            }
        };

        println!("Capturer created");

        let start = Instant::now();

        loop {
            if start.elapsed() > Duration::from_secs(2) {
                println!("Loop exited");
                return false;
            }

            match capturer.frame() {
                Ok(_frame) => {
                    println!("Frame captured");
                    return true;
                }
                Err(error) => {
                    if error.kind() == WouldBlock {
                        thread::sleep(one_frame);
                        continue;
                    } else {
                        println!("Error: {}", error);
                        return false;
                    }
                }
            };
        }
    });

    println!("Result: {:?}", result);

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

    if Path::new(&path).exists() {
        path.to_str()
            .map(|s| s.to_owned())
            .ok_or_else(|| "Failed to convert FFmpeg binary path to string".to_string())
    } else {
        Ok("ffmpeg".to_string())
    }
}

pub fn create_named_pipe(path: &str) -> Result<(), nix::Error> {
    use nix::sys::stat;
    use nix::unistd;
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}
