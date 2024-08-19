use ffmpeg_sidecar::paths::sidecar_dir;
use std::path::Path;

#[cfg(unix)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    std::fs::remove_file(&path).ok();
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
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
