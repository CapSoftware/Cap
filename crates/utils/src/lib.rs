#[cfg(windows)]
pub mod win;

#[cfg(unix)]
pub fn create_named_pipe(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    std::fs::remove_file(path).ok();
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}
