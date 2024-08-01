use ffmpeg_sidecar::paths::sidecar_dir;
use std::path::Path;
use std::process::Command;

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

#[cfg(unix)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}

#[cfg(windows)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use winapi::um::namedpipeapi::CreateNamedPipeW; // Corrected import
    use winapi::um::winbase::{PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_WAIT};

    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            path_wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            null_mut(),
        )
    };

    if handle == winapi::um::handleapi::INVALID_HANDLE_VALUE {
        return Err("Failed to create named pipe".into());
    }

    Ok(())
}

pub fn log_debug_error(error: impl std::fmt::Display) {
    tracing::debug!("Error: {error}")
}
