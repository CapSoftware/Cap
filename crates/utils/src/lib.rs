#[cfg(windows)]
use tokio::net::windows::named_pipe;

#[cfg(unix)]
pub fn create_named_pipe(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    std::fs::remove_file(path).ok();
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}

#[cfg(windows)]
pub fn get_last_win32_error_formatted() -> String {
    format_error_message(unsafe { windows::Win32::Foundation::GetLastError().0 })
}

#[cfg(windows)]
pub fn format_error_message(error_code: u32) -> String {
    use windows::{
        core::PWSTR,
        Win32::System::Diagnostics::Debug::{FormatMessageW, FORMAT_MESSAGE_FROM_SYSTEM},
    };

    let mut buffer = vec![0u16; 1024];
    match unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_SYSTEM,
            None,
            error_code,
            0,
            PWSTR(buffer.as_mut_ptr()),
            buffer.len() as u32,
            None,
        )
    } {
        0 => format!("Unknown error: {}", error_code),
        len => String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string(),
    }
}

// Windows named pipes must be in the format "\\.\pipe\name"
#[cfg(windows)]
fn named_pipe_to_path(name: &str) -> std::ffi::OsString {
    format!(r"\\.\pipe\{}", name).into()
}
