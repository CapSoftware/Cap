use std::path::Path;

#[cfg(unix)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    std::fs::remove_file(path).ok();
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}

#[cfg(windows)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use winapi::um::winbase::{CreateNamedPipeA, PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};
    use winapi::um::handleapi::INVALID_HANDLE_VALUE;

    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let path_narrow: Vec<i8> = path_wide.iter().map(|&c| c as i8).collect();
    let handle = unsafe {
        CreateNamedPipeA(
            path_narrow.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err("Failed to create named pipe".into());
    }

    Ok(())
}